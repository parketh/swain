import { appendFileSync } from "node:fs"
import { Box, type DOMElement, measureElement, Text, useApp, useInput, usePaste } from "ink"
import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { parseCommand } from "../commands"
import type { ProviderConfig } from "../config"
import type { Controller, PendingApproval, PendingQuestion } from "../controller"
import { detectFileToken, type FileMatch, replaceToken, searchFiles } from "../fs"
import { parseMouseEvents } from "../mouse"
import { theme } from "../theme"
import { CommandOverlay, filterCommands } from "./CommandOverlay"
import { ConnectDialog } from "./ConnectDialog"
import { FileSearch } from "./FileSearch"
import { HelpView } from "./HelpView"
import { ModelPicker } from "./ModelPicker"
import { PermissionPrompt } from "./PermissionPrompt"
import { nextWord, PromptInput, prevWord } from "./PromptInput"
import { QuestionPrompt, type QuestionPromptAnswer } from "./QuestionPrompt"
import { ResumePicker } from "./ResumePicker"
import { RouterDialog } from "./RouterDialog"
import { Spinner } from "./Spinner"
import { StatusLine } from "./StatusLine"
import { SubagentMonitor } from "./SubagentMonitor"
import { TaskList } from "./TaskList"
import { type DraftState, emptyDraft, foldEvent, Transcript } from "./Transcript"
import { useTerminalSize } from "./useTerminalSize"
import { VariantPicker } from "./VariantPicker"
import { WelcomeScreen } from "./WelcomeScreen"

type Dialog =
  | { readonly kind: "model" }
  | { readonly kind: "variants" }
  | { readonly kind: "connect"; readonly provider?: string }
  | { readonly kind: "resume" }
  | { readonly kind: "router" }

export interface AppProps {
  readonly controller: Controller
}

const isCommandToken = (value: string): boolean => value.startsWith("/") && !/\s/.test(value)

// A titled horizontal rule (e.g. "── History 3/100 ────") that replaces the
// prompt's top border while the user is scrolling through prompt history.
const HistoryRule = ({ label, width }: { readonly label: string; readonly width: number }) => {
  const fill = Math.max(0, width - label.length - 4)
  return (
    <Text color="gray">
      {"── "}
      <Text color={theme.muted}>{label}</Text>
      {` ${"─".repeat(fill)}`}
    </Text>
  )
}

// Opt-in raw key logging for diagnosing terminal escape sequences: set
// SWAIN_DEBUG_KEYS=1, reproduce, and inspect /tmp/swain-keys.log.
const debugKey = (input: string, key: Record<string, unknown>): void => {
  if (process.env.SWAIN_DEBUG_KEYS !== "1") return
  const flags = Object.entries(key)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(",")
  const bytes = [...input].map((c) => (c.codePointAt(0) ?? 0).toString(16).padStart(2, "0"))
  try {
    appendFileSync(
      "/tmp/swain-keys.log",
      `input=${JSON.stringify(input)} bytes=[${bytes.join(" ")}] flags=[${flags}]\n`,
    )
  } catch {}
}

export const App = ({ controller }: AppProps) => {
  const { exit } = useApp()
  const [, forceRender] = useReducer((n: number) => n + 1, 0)
  const [value, setValue] = useState("")
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef({ value: "", cursor: 0 })
  // Shell-style prompt history lives in the controller (global, cross-session).
  // Here we hold only a cursor into it (`=== length` means the live draft) and
  // the in-progress draft, stashed when scrolling back so forward restores it.
  const historyPos = useRef(controller.getHistory().length)
  const draftStash = useRef("")
  // Ctrl+C is a two-step exit: the first press clears the input and arms this
  // flag (with a timeout to disarm); a second press while armed exits.
  const ctrlCArmed = useRef(false)
  const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [draft, setDraft] = useState<DraftState>(emptyDraft)
  // Clears the streamed draft after a turn but keeps any errors: a failed turn
  // commits nothing to session.messages, so wiping them would silently swallow
  // the failure. The next submission clears them (see submit).
  const clearDraftKeepingErrors = (): void =>
    setDraft((prev) =>
      prev.errors.length > 0 ? { ...emptyDraft, errors: prev.errors } : emptyDraft,
    )
  // Rows the transcript is scrolled up from the live bottom (0 = following the
  // tail). Driven by the mouse wheel; clamped against measured content height.
  const [scrollBack, setScrollBack] = useState(0)
  const viewportRef = useRef<DOMElement | null>(null)
  const transcriptRef = useRef<DOMElement | null>(null)
  // Wrapper element + text of every rendered user prompt, keyed by node index.
  // Read post-layout to find which prompt has scrolled above the viewport top.
  const promptEls = useRef(new Map<number, { el: DOMElement; text: string }>())
  const registerPrompt = useCallback((index: number, el: DOMElement | null, text: string): void => {
    if (el !== null) promptEls.current.set(index, { el, text })
    else promptEls.current.delete(index)
  }, [])
  // The user prompt pinned at the viewport top while scrolled back — the turn
  // whose output currently fills the top of the screen (undefined at the tail).
  const [sticky, setSticky] = useState<string | undefined>(undefined)
  const [overlayIndex, setOverlayIndex] = useState(0)
  const [question, setQuestion] = useState<PendingQuestion | undefined>(undefined)
  const [approval, setApproval] = useState<PendingApproval | undefined>(undefined)
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [showHelp, setShowHelp] = useState(false)
  // First-run onboarding: after connecting a provider from an unconfigured
  // state, chain the model picker (and then the variant picker) automatically.
  const [setupFlow, setSetupFlow] = useState(false)
  const { rows, columns } = useTerminalSize()

  useEffect(
    () => () => {
      if (ctrlCTimer.current !== undefined) clearTimeout(ctrlCTimer.current)
    },
    [],
  )

  useEffect(() => {
    const unsubState = controller.subscribe(forceRender)
    const unsubEvents = controller.onEvent((event) => setDraft((prev) => foldEvent(prev, event)))
    const unsubQuestion = controller.onQuestion((request) => setQuestion(request))
    const unsubApproval = controller.onApproval((request) => setApproval(request))
    return () => {
      unsubState()
      unsubEvents()
      unsubQuestion()
      unsubApproval()
    }
  }, [controller])

  // While subagents run, tick once a second so their elapsed-time display stays
  // live even though no events are arriving.
  const runningAgents = controller.getSubagents().length
  useEffect(() => {
    if (runningAgents === 0) return
    const id = setInterval(forceRender, 1000)
    return () => clearInterval(id)
  }, [runningAgents])

  const state = controller.getState()
  // The task panel shows only the parent's own to-do items; delegated tasks
  // (owner set) belong to a subagent and appear in the subagent monitor instead.
  const allTasks = controller.getTasks()
  const tasks = allTasks.filter((t) => t.owner === undefined)
  const subagents = controller.getSubagents()
  // Show the task panel only while there is outstanding work; once everything is
  // completed/failed it collapses (tasks stay persisted for resume/history).
  const hasOutstandingTasks = tasks.some(
    (t) => t.status === "pending" || t.status === "in_progress",
  )
  const cwd = state.session.workingDirectory
  const commandMode = isCommandToken(value)
  const commandMatches = commandMode ? filterCommands(value.slice(1)) : []
  const fileToken = commandMode ? undefined : detectFileToken(value, cursor)
  const fileMatches: ReadonlyArray<FileMatch> =
    fileToken !== undefined ? searchFiles(cwd, fileToken.query) : []
  const overlayCount = commandMode ? commandMatches.length : fileMatches.length
  const highlight = overlayCount === 0 ? 0 : Math.min(overlayIndex, overlayCount - 1)

  // Editing reads/writes go through this ref, not the render-scope `value`/
  // `cursor`, so a burst of key events (e.g. a terminal delivering Shift+Enter
  // as two synchronous events) composes on the latest text instead of a stale
  // closure from the last render.
  const setInput = (text: string, pos: number): void => {
    const c = Math.max(0, Math.min(pos, text.length))
    inputRef.current = { value: text, cursor: c }
    setValue(text)
    setCursor(c)
    setOverlayIndex(0)
  }
  const moveCursor = (pos: number): void => {
    const { value: v } = inputRef.current
    const c = Math.max(0, Math.min(pos, v.length))
    inputRef.current = { value: v, cursor: c }
    setCursor(c)
  }
  const insert = (text: string): void => {
    // Strip carriage returns so a fused/echoed CR can never become an invisible
    // character in the value; newlines are inserted explicitly as "\n".
    const { value: v, cursor: c } = inputRef.current
    const clean = text.replace(/\r/g, "")
    setInput(v.slice(0, c) + clean + v.slice(c), c + clean.length)
  }
  const deleteWordBefore = (): void => {
    const { value: v, cursor: c } = inputRef.current
    const start = prevWord(v, c)
    setInput(v.slice(0, start) + v.slice(c), start)
  }

  const recallPrev = (): void => {
    const h = controller.getHistory()
    if (h.length === 0) return
    if (historyPos.current === h.length) draftStash.current = inputRef.current.value
    if (historyPos.current > 0) {
      historyPos.current -= 1
      const text = h[historyPos.current] ?? ""
      setInput(text, text.length)
    }
  }
  const recallNext = (): void => {
    const h = controller.getHistory()
    if (historyPos.current >= h.length) return
    historyPos.current += 1
    const text =
      historyPos.current === h.length ? draftStash.current : (h[historyPos.current] ?? "")
    setInput(text, text.length)
  }

  // Scroll the transcript by `rows` (positive = back toward older content),
  // clamped so it can't scroll past the top or below the live tail.
  const scrollBy = (rows: number): void => {
    const content = transcriptRef.current ? measureElement(transcriptRef.current).height : 0
    const viewport = viewportRef.current ? measureElement(viewportRef.current).height : 0
    const max = Math.max(0, content - viewport)
    setScrollBack((s) => Math.max(0, Math.min(max, s + rows)))
  }

  const disarmCtrlC = (): void => {
    if (!ctrlCArmed.current) return
    ctrlCArmed.current = false
    if (ctrlCTimer.current !== undefined) {
      clearTimeout(ctrlCTimer.current)
      ctrlCTimer.current = undefined
    }
    setNotice(undefined)
  }

  const acceptCommand = (): void => {
    const match = commandMatches[highlight]
    if (match !== undefined) setInput(`/${match.name} `, match.name.length + 2)
  }

  const runCommand = (): void => {
    const match = commandMatches[highlight]
    if (match === undefined) return
    setInput(`/${match.name}`, match.name.length + 1)
    void submit()
  }

  const acceptFile = (): void => {
    const match = fileMatches[highlight]
    if (fileToken !== undefined && match !== undefined) {
      const next = replaceToken(value, fileToken, match.path)
      setInput(next.text, next.cursor)
    }
  }

  const variantsFor = (
    provider: string,
    modelId: string,
  ): ReadonlyArray<{ id: string; label: string }> =>
    state.availableModels.find((m) => m.provider === provider && m.modelId === modelId)?.variants ??
    []

  const variantsForActive = (): ReadonlyArray<{ id: string; label: string }> =>
    variantsFor(state.activeModel.provider, state.activeModel.modelId)

  const submit = async (): Promise<void> => {
    const text = inputRef.current.value
    setInput("", 0)
    setNotice(undefined)
    setScrollBack(0)
    if (text.trim() === "") return
    const parsed = parseCommand(text)
    if (parsed.type === "prompt") controller.recordPrompt(text)
    historyPos.current = controller.getHistory().length
    draftStash.current = ""
    if (parsed.type === "prompt" && controller.getState().activeModel.provider === "none") {
      setNotice("Connect a provider to send a prompt.")
      return setDialog({ kind: "connect" })
    }
    if (parsed.type !== "command") {
      setDraft(emptyDraft)
      await controller.executeCommand(parsed)
      clearDraftKeepingErrors()
      return
    }
    const args = parsed.args.trim()
    switch (parsed.name) {
      case "help":
        return setShowHelp(true)
      case "usage": {
        const u = controller.getUsage()
        return setNotice(
          `${u.provider}/${u.modelId}${u.variant !== undefined ? `:${u.variant}` : ""} · ` +
            `${u.turns} turns · in ${u.inputTokens} · out ${u.outputTokens} · total ${u.totalTokens}`,
        )
      }
      case "model":
        return args === "" ? setDialog({ kind: "model" }) : void controller.executeCommand(parsed)
      case "variants": {
        if (args !== "") return void controller.executeCommand(parsed)
        if (variantsForActive().length === 0)
          return setNotice("No variants are available for the active model.")
        return setDialog({ kind: "variants" })
      }
      case "connect": {
        if (args !== "" && !state.connectableProviders.some((p) => p.id === args))
          return setNotice(`Unknown provider "${args}".`)
        return setDialog({ kind: "connect", provider: args === "" ? undefined : args })
      }
      case "router":
        // Dialog-only; `/router` ignores any arguments (no arg grammar).
        return setDialog({ kind: "router" })
      case "resume":
        if (args !== "") return void controller.resumeSession(args)
        void controller.ensureSummaries()
        return setDialog({ kind: "resume" })
      default:
        setDraft(emptyDraft)
        await controller.executeCommand(parsed)
        clearDraftKeepingErrors()
    }
  }

  const connect = async (provider: string, creds: ProviderConfig): Promise<void> => {
    const wasUnconfigured = controller.getState().activeModel.provider === "none"
    const result = await controller.connectProvider(provider, creds)
    if (!result.ok) {
      setDialog(undefined)
      return setNotice(`Failed to connect ${provider}: ${result.error}`)
    }
    setNotice(`Connected ${provider}.`)
    // Continue first-run setup straight into model (then variant) selection so
    // the user doesn't have to run /model and /variants by hand.
    if (wasUnconfigured) {
      setSetupFlow(true)
      return setDialog({ kind: "model" })
    }
    setDialog(undefined)
  }

  // Ctrl+C lives in its own always-active handler because the main input handler
  // is disabled while a picker dialog owns input (isActive below). That keeps
  // Ctrl+C working everywhere: interrupt a running turn, dismiss an open picker,
  // or step toward exit at the prompt.
  useInput((input, key) => {
    if (!(key.ctrl && input === "c")) return
    if (controller.getState().running) return controller.interrupt()
    // The help screen and dialogs are dismissable overlays: the main handler
    // already closes help on any key, so just let it; a dialog is closed here
    // (its own handler ignores Ctrl+C) instead of being swallowed.
    if (showHelp) return
    if (dialog !== undefined) {
      setSetupFlow(false)
      setDialog(undefined)
      return
    }
    if (ctrlCArmed.current) {
      if (ctrlCTimer.current !== undefined) clearTimeout(ctrlCTimer.current)
      exit()
      return
    }
    setInput("", 0)
    ctrlCArmed.current = true
    setNotice("Press Ctrl+C again to exit")
    ctrlCTimer.current = setTimeout(() => {
      ctrlCArmed.current = false
      ctrlCTimer.current = undefined
      setNotice(undefined)
    }, 2000)
  })

  useInput(
    (input, key) => {
      debugKey(input, key as unknown as Record<string, unknown>)
      // Mouse events: scroll the transcript on wheel and swallow the rest so no
      // sequence leaks into the prompt. Button bit 64 marks a wheel event; low
      // bit is direction.
      const mouse = parseMouseEvents(input)
      if (mouse.length > 0) {
        let delta = 0
        for (const m of mouse) {
          if (m.button & 64) delta += (m.button & 1) === 0 ? 1 : -1
        }
        if (delta !== 0) scrollBy(delta * 3)
        return
      }
      // Any key other than Ctrl+C cancels a pending exit.
      if (!(key.ctrl && input === "c")) disarmCtrlC()
      if (showHelp) {
        setShowHelp(false)
        return
      }
      // Ctrl+C is handled by the dedicated always-active handler above.
      if (key.ctrl && input === "c") return
      if (key.shift && key.tab) return controller.cyclePermissionMode()
      if (key.escape) {
        // While a turn is loading, Esc interrupts it but preserves the turn: the
        // partial assistant text is committed and an interrupt marker appended.
        // Otherwise it just clears the input.
        if (controller.getState().running) {
          void controller.cancelTurn(draft.assistant).then(() => setDraft(emptyDraft))
          return
        }
        return setInput("", 0)
      }

      // Read the latest text from the ref so multi-event bursts compose.
      const v = inputRef.current.value
      const cur = inputRef.current.cursor

      // Word navigation: Option/Alt + Left/Right. Terminals deliver this either
      // as an arrow with the meta modifier, or as ESC-b / ESC-f (meta + b/f).
      if (key.meta && (key.leftArrow || input === "b")) return moveCursor(prevWord(v, cur))
      if (key.meta && (key.rightArrow || input === "f")) return moveCursor(nextWord(v, cur))
      // Delete the word before the cursor: Option+Backspace (meta+backspace) or Ctrl+W.
      if ((key.meta && (key.backspace || key.delete)) || (key.ctrl && input === "w"))
        return deleteWordBefore()

      if (key.upArrow) {
        if (overlayCount > 0) return setOverlayIndex((i) => Math.max(0, i - 1))
        return recallPrev()
      }
      if (key.downArrow) {
        if (overlayCount > 0)
          return setOverlayIndex((i) => Math.min(Math.max(0, overlayCount - 1), i + 1))
        return recallNext()
      }

      if (key.leftArrow) return moveCursor(cur - 1)
      if (key.rightArrow) {
        if (commandMode && commandMatches.length > 0) return acceptCommand()
        return moveCursor(cur + 1)
      }

      if (key.tab) {
        if (commandMode) return acceptCommand()
        if (fileToken !== undefined) return acceptFile()
        return
      }

      if (key.return) {
        // Newline instead of submit for: Shift/Option+Enter (Option+Enter and
        // the ESC+CR that `terminal-setup` installs both decode as meta+return),
        // or a trailing backslash before the cursor (`\` + Enter continuation).
        if (key.shift || key.meta) return insert("\n")
        if (cur > 0 && v[cur - 1] === "\\")
          return setInput(`${v.slice(0, cur - 1)}\n${v.slice(cur)}`, cur)
        if (commandMode && commandMatches.length > 0) return runCommand()
        if (fileToken !== undefined && fileMatches.length > 0) return acceptFile()
        void submit()
        return
      }

      if (key.backspace || key.delete) {
        if (cur > 0) setInput(v.slice(0, cur - 1) + v.slice(cur), cur - 1)
        return
      }

      // Some terminals deliver Shift+Enter as a fused "\<CR>" chunk (bytes
      // 0x5c 0x0d) with no return flag; and pasted text carries embedded
      // newlines. Insert any CR/LF as a newline, dropping a backslash that
      // immediately precedes it.
      if (/[\r\n]/.test(input)) return insert(input.replace(/\\?(?:\r\n|\r|\n)/g, "\n"))

      if (input && !key.ctrl && !key.meta) insert(input)
    },
    { isActive: question === undefined && approval === undefined && dialog === undefined },
  )

  // Bracketed paste: ink enables `\x1b[?2004h` while this hook is active, so a
  // paste arrives as one string on its own channel instead of a key burst.
  // Enabling the mode also tells the host terminal the app handles paste
  // safely, suppressing multi-line paste confirmations (e.g. VS Code's "paste N
  // lines?" prompt). insert() strips CRs and keeps newlines.
  usePaste((text) => insert(text), {
    isActive: question === undefined && approval === undefined && dialog === undefined,
  })

  // Everything that renders as an overlay above the pinned prompt: help, a
  // permission/question prompt, a picker dialog, or the command/file suggestion
  // lists. Only one is shown at a time; the prompt input stays visible below.
  const overlay = showHelp ? (
    <Box flexDirection="column">
      <HelpView />
      <Text color={theme.muted}>press any key to return</Text>
    </Box>
  ) : approval !== undefined ? (
    <PermissionPrompt
      request={approval.request}
      onDecision={(decision) => {
        controller.resolveApproval(approval.id, decision)
        setApproval(undefined)
      }}
    />
  ) : question !== undefined ? (
    <QuestionPrompt
      questions={question.input.questions.map((q) => ({
        question: q.question,
        options: q.options.map((o) => ({ label: o.label, description: o.description })),
        ...(q.multiSelect !== undefined && { multiSelect: q.multiSelect }),
      }))}
      onSubmit={(answers: ReadonlyArray<QuestionPromptAnswer>) => {
        controller.answerQuestion(
          question.id,
          answers.map((a) => ({ question: a.question, selected: a.selected })),
        )
        setQuestion(undefined)
      }}
    />
  ) : dialog?.kind === "model" ? (
    <ModelPicker
      models={state.availableModels}
      active={state.activeModel}
      onSelect={(provider, modelId) => {
        void controller.selectModel(provider, modelId)
        // During onboarding, advance to the variant picker when the chosen
        // model offers variants; otherwise finish setup.
        if (setupFlow && variantsFor(provider, modelId).length > 0) {
          return setDialog({ kind: "variants" })
        }
        setSetupFlow(false)
        setDialog(undefined)
      }}
      onCancel={() => {
        setSetupFlow(false)
        setDialog(undefined)
      }}
      width={columns}
    />
  ) : dialog?.kind === "variants" ? (
    <VariantPicker
      variants={variantsForActive()}
      current={state.activeModel.variant}
      onSelect={(variant) => {
        void controller.setVariant(variant)
        setSetupFlow(false)
        setDialog(undefined)
      }}
      onCancel={() => {
        setSetupFlow(false)
        setDialog(undefined)
      }}
      width={columns}
    />
  ) : dialog?.kind === "resume" ? (
    <ResumePicker
      sessions={controller.listSessions()}
      onSelect={(sessionId) => {
        void controller.resumeSession(sessionId)
        setDialog(undefined)
      }}
      onCancel={() => setDialog(undefined)}
      width={columns}
    />
  ) : dialog?.kind === "connect" ? (
    <ConnectDialog
      providers={state.connectableProviders}
      {...(dialog.provider !== undefined && { initialProvider: dialog.provider })}
      onSubmit={connect}
      onCancel={() => setDialog(undefined)}
    />
  ) : dialog?.kind === "router" ? (
    <RouterDialog
      view={controller.getRouterView()}
      onToggleEnabled={() => void controller.setRouterEnabled(!controller.getRouterView().enabled)}
      onToggleModel={(provider, modelId) => void controller.toggleRouterModel(provider, modelId)}
      onToggleTarget={(targetId) => void controller.toggleRouterTarget(targetId)}
      onCancel={() => setDialog(undefined)}
      width={columns}
    />
  ) : commandMode ? (
    <CommandOverlay query={value.slice(1)} highlight={highlight} width={columns} />
  ) : fileToken !== undefined ? (
    <FileSearch matches={fileMatches} highlight={highlight} width={columns} />
  ) : null

  // A pristine session (no history, nothing streaming) shows the welcome
  // screen, centered in the scrollback region, instead of an empty transcript.
  const isNewSession =
    state.session.messages.length === 0 &&
    !state.running &&
    draft.assistant === "" &&
    draft.reasoning === "" &&
    draft.tools.length === 0 &&
    draft.errors.length === 0

  // Recompute the pinned prompt after layout: find the last user prompt whose
  // wrapper has scrolled strictly above the viewport top (its ❯ is off-screen),
  // so the header never duplicates a prompt still visible on screen. Runs post-
  // render (Yoga tops are only valid then) and re-measures on scroll/content
  // change; setState no-ops when unchanged, so it can't loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are re-measure triggers, not read values
  useEffect(() => {
    if (scrollBack <= 0 || isNewSession) {
      setSticky(undefined)
      return
    }
    const content = transcriptRef.current ? measureElement(transcriptRef.current).height : 0
    const viewport = viewportRef.current ? measureElement(viewportRef.current).height : 0
    const topOffset = content - viewport - scrollBack
    let text: string | undefined
    let bestTop = -1
    for (const { el, text: t } of promptEls.current.values()) {
      const top = el.yogaNode?.getComputedTop() ?? -1
      if (top >= 0 && top < topOffset && top >= bestTop) {
        bestTop = top
        text = t
      }
    }
    setSticky((prev) => (prev === text ? prev : text))
  }, [scrollBack, isNewSession, rows, columns, state.session.messages, draft])

  // While scrolling back through history, label the prompt with its position;
  // at the live draft (cursor at the end) there is no label.
  const historyTotal = controller.getHistory().length
  const historyLabel =
    historyPos.current < historyTotal
      ? `History ${historyPos.current + 1}/${historyTotal}`
      : undefined

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      {/* Scrollback region: fills all space above the prompt, clips the oldest
          content, and anchors the newest turn just above the prompt. */}
      <Box
        ref={viewportRef}
        flexGrow={1}
        flexShrink={1}
        flexDirection="column"
        justifyContent={isNewSession ? "center" : "flex-end"}
        alignItems={isNewSession ? "center" : "flex-start"}
        overflow="hidden"
        position="relative"
      >
        {isNewSession ? (
          <WelcomeScreen
            cwd={cwd}
            activeModel={state.activeModel}
            permissionMode={state.permissionMode}
          />
        ) : (
          // Absolutely anchored to the bottom (bottom={0} matches flex-end); a
          // negative bottom lifts the newest content off-screen to reveal older
          // turns clipped above. Height is intrinsic, so the wheel can scroll it.
          <Box
            ref={transcriptRef}
            position="absolute"
            left={0}
            right={0}
            bottom={-scrollBack}
            flexDirection="column"
          >
            <Transcript
              messages={state.session.messages}
              draft={draft}
              registerPrompt={registerPrompt}
            />
          </Box>
        )}
        {/* Pinned prompt: while scrolled back, the current turn's prompt sticks
            to the viewport top so the answer on screen keeps its question.
            Drawn after (above) the transcript so it covers the top row. */}
        {sticky !== undefined ? (
          <Box
            position="absolute"
            top={0}
            left={0}
            width={columns}
            backgroundColor={theme.promptBg}
          >
            <Box minWidth={2} flexShrink={0}>
              <Text color={theme.primary}>{">"}</Text>
            </Box>
            <Text color={theme.primary} wrap="truncate-end">
              {sticky.replace(/\s+/g, " ").trim()}
            </Text>
          </Box>
        ) : null}
      </Box>
      {/* Pinned bottom: the prompt + status stay in flow, while any overlay is
          absolutely positioned to float directly above them — drawn on top of
          the conversation instead of pushing it up. `marginTop` keeps one blank
          line between the conversation and the status/prompt cluster. */}
      <Box flexDirection="column" flexShrink={0} marginTop={1}>
        {overlay !== null ? (
          <Box
            position="absolute"
            bottom="100%"
            width={columns}
            flexDirection="column"
            // Opaque backdrop: without it, Ink leaves the overlay's empty cells
            // transparent and the transcript behind bleeds through.
            backgroundColor={theme.overlay}
          >
            {overlay}
          </Box>
        ) : null}
        {subagents.length > 0 ? (
          <Box marginBottom={1}>
            <SubagentMonitor agents={subagents} now={Date.now()} />
          </Box>
        ) : null}
        {hasOutstandingTasks ? (
          <Box marginBottom={1}>
            <TaskList tasks={tasks} allTasks={allTasks} />
          </Box>
        ) : null}
        {state.running ? <Spinner /> : null}
        {notice !== undefined ? <Text color={theme.muted}>{notice}</Text> : null}
        {historyLabel !== undefined ? <HistoryRule label={historyLabel} width={columns} /> : null}
        <Box
          borderStyle="single"
          borderTop={historyLabel === undefined}
          borderLeft={false}
          borderRight={false}
          borderColor="gray"
        >
          <PromptInput value={value} cursor={cursor} />
        </Box>
        <StatusLine
          activeModel={state.currentModel}
          permissionMode={state.permissionMode}
          usage={controller.getUsage()}
          routerStatus={state.routerStatus}
        />
      </Box>
    </Box>
  )
}
