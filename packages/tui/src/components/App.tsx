import { appendFileSync } from "node:fs"
import { Box, Text, useApp, useInput } from "ink"
import { useEffect, useReducer, useRef, useState } from "react"
import { parseCommand } from "../commands"
import type { ProviderConfig } from "../config"
import type { Controller, PendingApproval, PendingQuestion } from "../controller"
import { detectFileToken, type FileMatch, replaceToken, searchFiles } from "../fs"
import { CommandOverlay, filterCommands } from "./CommandOverlay"
import { ConnectDialog } from "./ConnectDialog"
import { FileSearch } from "./FileSearch"
import { HelpView } from "./HelpView"
import { ModelPicker } from "./ModelPicker"
import { PermissionPrompt } from "./PermissionPrompt"
import { nextWord, PromptInput, prevWord } from "./PromptInput"
import { QuestionPrompt, type QuestionPromptAnswer } from "./QuestionPrompt"
import { ResumePicker } from "./ResumePicker"
import { StatusLine } from "./StatusLine"
import { type DraftState, emptyDraft, foldEvent, Transcript } from "./Transcript"
import { useTerminalSize } from "./useTerminalSize"
import { VariantPicker } from "./VariantPicker"
import { WelcomeScreen } from "./WelcomeScreen"

type Dialog =
  | { readonly kind: "model" }
  | { readonly kind: "variants" }
  | { readonly kind: "connect"; readonly provider?: string }
  | { readonly kind: "resume" }

export interface AppProps {
  readonly controller: Controller
}

const isCommandToken = (value: string): boolean => value.startsWith("/") && !/\s/.test(value)

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
  // Ctrl+C is a two-step exit: the first press clears the input and arms this
  // flag (with a timeout to disarm); a second press while armed exits.
  const ctrlCArmed = useRef(false)
  const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [draft, setDraft] = useState<DraftState>(emptyDraft)
  const [overlayIndex, setOverlayIndex] = useState(0)
  const [question, setQuestion] = useState<PendingQuestion | undefined>(undefined)
  const [approval, setApproval] = useState<PendingApproval | undefined>(undefined)
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [showHelp, setShowHelp] = useState(false)
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

  const state = controller.getState()
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

  const variantsForActive = (): ReadonlyArray<{ id: string; label: string }> =>
    state.availableModels.find(
      (m) => m.provider === state.activeModel.provider && m.modelId === state.activeModel.modelId,
    )?.variants ?? []

  const submit = async (): Promise<void> => {
    const text = inputRef.current.value
    setInput("", 0)
    setNotice(undefined)
    if (text.trim() === "") return
    const parsed = parseCommand(text)
    if (parsed.type !== "command") {
      setDraft(emptyDraft)
      await controller.executeCommand(parsed)
      setDraft(emptyDraft)
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
      case "resume":
        return args === "" ? setDialog({ kind: "resume" }) : void controller.resumeSession(args)
      default:
        setDraft(emptyDraft)
        await controller.executeCommand(parsed)
        setDraft(emptyDraft)
    }
  }

  const connect = async (provider: string, creds: ProviderConfig): Promise<void> => {
    const result = await controller.connectProvider(provider, creds)
    setDialog(undefined)
    setNotice(
      result.ok ? `Connected ${provider}.` : `Failed to connect ${provider}: ${result.error}`,
    )
  }

  useInput(
    (input, key) => {
      debugKey(input, key as unknown as Record<string, unknown>)
      // Any key other than Ctrl+C cancels a pending exit.
      if (!(key.ctrl && input === "c")) disarmCtrlC()
      if (showHelp) {
        setShowHelp(false)
        return
      }
      if (key.ctrl && input === "c") {
        if (controller.getState().running) {
          controller.interrupt()
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
        return
      }
      if (key.shift && key.tab) return controller.cyclePermissionMode()
      if (key.escape) {
        // While a turn is loading, Esc cancels it and returns the prompt to the
        // editor for amendment; otherwise it just clears the input.
        if (controller.getState().running) {
          void controller.cancelTurn().then((restored) => {
            if (restored !== undefined) {
              setDraft(emptyDraft)
              setInput(restored, restored.length)
            }
          })
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

      if (key.upArrow) return setOverlayIndex((i) => Math.max(0, i - 1))
      if (key.downArrow)
        return setOverlayIndex((i) => Math.min(Math.max(0, overlayCount - 1), i + 1))

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

  // Everything that renders as an overlay above the pinned prompt: help, a
  // permission/question prompt, a picker dialog, or the command/file suggestion
  // lists. Only one is shown at a time; the prompt input stays visible below.
  const overlay = showHelp ? (
    <Box flexDirection="column">
      <HelpView />
      <Text dimColor>press any key to return</Text>
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
        setDialog(undefined)
      }}
      onCancel={() => setDialog(undefined)}
    />
  ) : dialog?.kind === "variants" ? (
    <VariantPicker
      variants={variantsForActive()}
      current={state.activeModel.variant}
      onSelect={(variant) => {
        void controller.setVariant(variant)
        setDialog(undefined)
      }}
      onCancel={() => setDialog(undefined)}
    />
  ) : dialog?.kind === "resume" ? (
    <ResumePicker
      sessions={controller.listSessions()}
      onSelect={(sessionId) => {
        void controller.resumeSession(sessionId)
        setDialog(undefined)
      }}
      onCancel={() => setDialog(undefined)}
    />
  ) : dialog?.kind === "connect" ? (
    <ConnectDialog
      providers={state.connectableProviders}
      {...(dialog.provider !== undefined && { initialProvider: dialog.provider })}
      onSubmit={connect}
      onCancel={() => setDialog(undefined)}
    />
  ) : commandMode ? (
    <CommandOverlay query={value.slice(1)} highlight={highlight} />
  ) : fileToken !== undefined ? (
    <FileSearch matches={fileMatches} highlight={highlight} />
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

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      {/* Scrollback region: fills all space above the prompt, clips the oldest
          content, and anchors the newest turn just above the prompt. */}
      <Box
        flexGrow={1}
        flexShrink={1}
        flexDirection="column"
        justifyContent={isNewSession ? "center" : "flex-end"}
        alignItems={isNewSession ? "center" : "flex-start"}
        overflow="hidden"
      >
        {isNewSession ? (
          <WelcomeScreen
            cwd={cwd}
            activeModel={state.activeModel}
            permissionMode={state.permissionMode}
          />
        ) : (
          <Transcript messages={state.session.messages} draft={draft} />
        )}
      </Box>
      {/* Pinned bottom: overlays render directly above the prompt. */}
      <Box flexDirection="column" flexShrink={0}>
        {overlay}
        {notice !== undefined ? <Text dimColor>{notice}</Text> : null}
        <Box borderStyle="single" borderLeft={false} borderRight={false} borderColor="gray">
          <PromptInput value={value} cursor={cursor} />
        </Box>
        <StatusLine
          activeModel={state.activeModel}
          permissionMode={state.permissionMode}
          usage={controller.getUsage()}
          running={state.running}
        />
      </Box>
    </Box>
  )
}
