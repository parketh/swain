import { Box, Text, useApp, useInput } from "ink"
import { useEffect, useReducer, useState } from "react"
import { parseCommand } from "../commands"
import type { Controller, PendingApproval, PendingQuestion } from "../controller"
import { detectFileToken, type FileMatch, replaceToken, searchFiles } from "../fs"
import { CommandOverlay, filterCommands } from "./CommandOverlay"
import { FileSearch } from "./FileSearch"
import { HelpView } from "./HelpView"
import { PermissionPrompt } from "./PermissionPrompt"
import { PromptInput } from "./PromptInput"
import { QuestionPrompt, type QuestionPromptAnswer } from "./QuestionPrompt"
import { StatusLine } from "./StatusLine"
import { type DraftState, emptyDraft, foldEvent, Transcript } from "./Transcript"

export interface AppProps {
  readonly controller: Controller
}

const isCommandToken = (value: string): boolean => value.startsWith("/") && !/\s/.test(value)

export const App = ({ controller }: AppProps) => {
  const { exit } = useApp()
  const [, forceRender] = useReducer((n: number) => n + 1, 0)
  const [value, setValue] = useState("")
  const [draft, setDraft] = useState<DraftState>(emptyDraft)
  const [overlayIndex, setOverlayIndex] = useState(0)
  const [question, setQuestion] = useState<PendingQuestion | undefined>(undefined)
  const [approval, setApproval] = useState<PendingApproval | undefined>(undefined)
  const [showHelp, setShowHelp] = useState(false)

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
  const fileToken = commandMode ? undefined : detectFileToken(value)
  const fileMatches: ReadonlyArray<FileMatch> =
    fileToken !== undefined ? searchFiles(cwd, fileToken.query) : []
  const overlayCount = commandMode ? commandMatches.length : fileMatches.length
  const highlight = overlayCount === 0 ? 0 : Math.min(overlayIndex, overlayCount - 1)

  const acceptCommand = (): void => {
    const match = commandMatches[highlight]
    if (match !== undefined) {
      setValue(`/${match.name} `)
      setOverlayIndex(0)
    }
  }

  const acceptFile = (): void => {
    const match = fileMatches[highlight]
    if (fileToken !== undefined && match !== undefined) {
      setValue(replaceToken(value, fileToken, match.path).text)
      setOverlayIndex(0)
    }
  }

  const submit = async (): Promise<void> => {
    const text = value
    setValue("")
    setOverlayIndex(0)
    if (text.trim() === "") return
    const parsed = parseCommand(text)
    if (parsed.type === "command" && parsed.name === "help") {
      setShowHelp(true)
      return
    }
    setShowHelp(false)
    setDraft(emptyDraft)
    await controller.executeCommand(parsed)
    setDraft(emptyDraft)
  }

  useInput(
    (input, key) => {
      if (showHelp) {
        setShowHelp(false)
        return
      }
      if (key.ctrl && input === "c") {
        if (controller.getState().running) controller.interrupt()
        else exit()
        return
      }
      if (key.shift && key.tab) return controller.cyclePermissionMode()
      if (key.escape) {
        setValue("")
        setOverlayIndex(0)
        return
      }
      if (key.upArrow) return setOverlayIndex((i) => Math.max(0, i - 1))
      if (key.downArrow)
        return setOverlayIndex((i) => Math.min(Math.max(0, overlayCount - 1), i + 1))
      if (key.tab || (key.rightArrow && commandMode)) {
        if (commandMode) return acceptCommand()
        if (fileToken !== undefined) return acceptFile()
        return
      }
      if (key.return) {
        if (commandMode && commandMatches.length > 0) return acceptCommand()
        void submit()
        return
      }
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1))
        setOverlayIndex(0)
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setValue((v) => v + input)
        setOverlayIndex(0)
      }
    },
    { isActive: question === undefined && approval === undefined },
  )

  if (showHelp) {
    return (
      <Box flexDirection="column">
        <HelpView />
        <Text dimColor>press any key to return</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Transcript messages={state.session.messages} draft={draft} />
      {approval !== undefined ? (
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
      ) : (
        <>
          <PromptInput value={value} />
          {commandMode ? <CommandOverlay query={value.slice(1)} highlight={highlight} /> : null}
          {fileToken !== undefined ? (
            <FileSearch matches={fileMatches} highlight={highlight} />
          ) : null}
        </>
      )}
      <StatusLine
        activeModel={state.activeModel}
        permissionMode={state.permissionMode}
        sessionId={state.session.sessionId}
        usage={controller.getUsage()}
        running={state.running}
      />
    </Box>
  )
}
