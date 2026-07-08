import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentEvent, createSessionState } from "@swain/core"
import type { LLMEvent, Model } from "@swain/llms"
import { ContentId, ModelId, ProviderId, ToolCallId } from "@swain/llms"
import { LLMClient } from "@swain/llms/client"
import { Effect, Layer, Stream } from "effect"
import { render } from "ink-testing-library"
import { App } from "../src/app"
import { CommandOverlay, filterCommands } from "../src/components/CommandOverlay"
import { ListSelect } from "../src/components/ListSelect"
import { nextWord, PromptInput, prevWord, promptSegments } from "../src/components/PromptInput"
import { QuestionPrompt } from "../src/components/QuestionPrompt"
import { TaskList } from "../src/components/TaskList"
import { foldEvents, isHiddenTool } from "../src/components/Transcript"
import type { TuiConfig } from "../src/config"
import { sessionsDir } from "../src/config"
import { type Controller, makeController } from "../src/controller"

const flush = () => new Promise((resolve) => setTimeout(resolve, 25))
// The prompt renders the cursor/command color as raw inline ANSI (so each line
// is one Ink text atom); ink-testing-library keeps those codes in the frame.
const clean = (frame: string | undefined): string => (frame ?? "").replace(/\[[0-9;]*m/g, "")
const RIGHT = "[C"
const LEFT = "[D"
const SHIFT_TAB = "[Z"

const testModel: Model = {
  id: ModelId.make("claude-sonnet-5"),
  provider: ProviderId.make("anthropic"),
  streamTurn: () => Stream.empty,
}
const contentId = ContentId.make("c-1")
const config: TuiConfig = { providers: { anthropic: { apiKey: "sk-test" } } }

const scripted = (turns: ReadonlyArray<ReadonlyArray<LLMEvent>>) => {
  let index = 0
  return Layer.succeed(LLMClient.Service, {
    request: LLMClient.request,
    streamTurn: () => Stream.fromIterable(turns[Math.min(index++, turns.length - 1)] ?? []),
    generateTurn: () => Effect.succeed({ events: [...(turns[0] ?? [])] }),
  })
}

describe("pure helpers", () => {
  test("promptSegments colors a command prefix and plain args", () => {
    expect(promptSegments("/he")).toEqual([{ text: "/he", kind: "command" }])
    expect(promptSegments("/zzz")).toEqual([{ text: "/zzz", kind: "unknown" }])
    expect(promptSegments("/model x")).toEqual([
      { text: "/model", kind: "command" },
      { text: " x", kind: "text" },
    ])
  })

  test("filterCommands matches by name prefix", () => {
    expect(filterCommands("he").map((c) => c.name)).toContain("help")
  })

  test("prevWord/nextWord jump over whitespace-delimited words", () => {
    const text = "foo bar baz"
    expect(nextWord(text, 0)).toBe(3) // end of "foo"
    expect(nextWord(text, 4)).toBe(7) // end of "bar"
    expect(prevWord(text, 11)).toBe(8) // start of "baz"
    expect(prevWord(text, 7)).toBe(4) // start of "bar"
    expect(prevWord(text, 0)).toBe(0)
    expect(nextWord(text, 11)).toBe(11)
  })

  test("foldEvents accumulates streamed assistant text before finish", () => {
    const events: ReadonlyArray<AgentEvent> = [
      { type: "step-start", iteration: 0 },
      { type: "llm-event", event: { type: "text-delta", contentId, text: "he" } },
      { type: "llm-event", event: { type: "text-delta", contentId, text: "llo" } },
    ]
    expect(foldEvents(events).assistant).toBe("hello")
  })

  test("foldEvents streams tool output into the active row before it finalizes", () => {
    const id = ToolCallId.make("t-1")
    const mid = foldEvents([
      { type: "tool-execution-start", name: "Bash", toolCallId: id, input: {} },
      { type: "tool-execution-delta", name: "Bash", toolCallId: id, text: "line-1\n" },
    ])
    expect(mid.tools[0]?.output).toBe("line-1\n")
    expect(mid.tools[0]?.done).toBe(false)
    const done = foldEvents([
      { type: "tool-execution-start", name: "Bash", toolCallId: id, input: {} },
      { type: "tool-execution-delta", name: "Bash", toolCallId: id, text: "line-1\n" },
      { type: "tool-execution-end", name: "Bash", toolCallId: id, isError: false },
    ])
    expect(done.tools[0]?.done).toBe(true)
  })
})

describe("components", () => {
  test("CommandOverlay shows /help for a matching query", () => {
    const { lastFrame } = render(<CommandOverlay query="he" highlight={0} />)
    expect(lastFrame()).toContain("/help")
  })

  test("PromptInput renders the command token and a multi-line value", () => {
    expect(clean(render(<PromptInput value="/he" cursor={3} />).lastFrame())).toContain("/he")
    const multi = clean(render(<PromptInput value={"first\nsecond"} cursor={11} />).lastFrame())
    expect(multi).toContain("first")
    expect(multi).toContain("second")
    expect(multi.split("\n").length).toBeGreaterThan(1)
    // A blank interior line must keep its height (regression: empty lines used
    // to collapse, hiding second/subsequent Shift+Enter newlines).
    const gapped = clean(render(<PromptInput value={"a\n\nb"} cursor={3} />).lastFrame())
    expect(gapped.split("\n").length).toBe(3)
  })

  test("TaskList summarizes counts and lists prioritized tasks with agent type", () => {
    const base = { description: "d", blockedBy: [], createdAt: "t", updatedAt: "t" }
    const { lastFrame } = render(
      <TaskList
        tasks={[
          { ...base, id: "1", subject: "running one", status: "in_progress", agentType: "Explore" },
          { ...base, id: "2", subject: "todo one", status: "pending" },
          { ...base, id: "3", subject: "done one", status: "completed" },
        ]}
      />,
    )
    const frame = lastFrame() ?? ""
    expect(frame).toContain("1 running")
    expect(frame).toContain("1 pending")
    expect(frame).toContain("1 done")
    expect(frame).toContain("running one")
    expect(frame).toContain("[Explore]")
  })

  test("isHiddenTool hides task tools but not others", () => {
    expect(isHiddenTool("TaskCreate")).toBe(true)
    expect(isHiddenTool("TaskUpdate")).toBe(true)
    expect(isHiddenTool("Bash")).toBe(false)
    expect(isHiddenTool(undefined)).toBe(false)
  })

  test("ListSelect filters by query and selects the highlighted item on Enter", () => {
    let chosen: string | undefined
    const { stdin, lastFrame } = render(
      <ListSelect
        title="Pick"
        items={[
          { value: "apple", label: "apple" },
          { value: "banana", label: "banana" },
          { value: "cherry", label: "cherry" },
        ]}
        query="ba"
        onQueryChange={() => {}}
        onSelect={(value) => {
          chosen = value
        }}
        onCancel={() => {}}
      />,
    )
    expect(lastFrame()).toContain("banana")
    expect(lastFrame()).not.toContain("cherry")
    stdin.write("\r")
    expect(chosen).toBe("banana")
  })
})

describe("QuestionPrompt", () => {
  const twoQuestions = [
    {
      question: "First?",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    },
    {
      question: "Second?",
      options: [
        { label: "C", description: "c" },
        { label: "D", description: "d" },
      ],
    },
  ]

  test("moves between questions with Left/Right", async () => {
    const { stdin, lastFrame } = render(
      <QuestionPrompt questions={twoQuestions} onSubmit={() => {}} />,
    )
    expect(lastFrame()).toContain("First?")
    stdin.write(RIGHT)
    await flush()
    expect(lastFrame()).toContain("Second?")
    stdin.write(LEFT)
    await flush()
    expect(lastFrame()).toContain("First?")
  })

  test("selects a single-select answer on Enter", async () => {
    const { stdin, lastFrame } = render(
      <QuestionPrompt questions={twoQuestions} onSubmit={() => {}} />,
    )
    stdin.write("\r")
    await flush()
    expect(lastFrame()).toContain("x1")
  })

  test("toggles multi-select answers and submits only from the submit step", async () => {
    let submitted: ReadonlyArray<{ question: string; selected: ReadonlyArray<string> }> | undefined
    const questions = [
      {
        question: "Which?",
        multiSelect: true,
        options: [
          { label: "A", description: "a" },
          { label: "B", description: "b" },
        ],
      },
    ]
    const { stdin } = render(
      <QuestionPrompt
        questions={questions}
        onSubmit={(answers) => {
          submitted = answers
        }}
      />,
    )
    stdin.write("\r") // toggle A
    await flush()
    stdin.write(RIGHT) // move to submit step
    await flush()
    expect(submitted).toBeUndefined()
    stdin.write("\r") // submit
    await flush()
    expect(submitted).toEqual([{ question: "Which?", selected: ["A"] }])
  })
})

describe("App", () => {
  let dir: string
  let controller: Controller
  const built: Array<Controller> = []
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swain-app-"))
    mkdirSync(join(dir, "src"))
  })
  afterEach(() => {
    for (const c of built) c.dispose()
    built.length = 0
    rmSync(dir, { recursive: true, force: true })
  })

  const makeCtrl = (turns: ReadonlyArray<ReadonlyArray<LLMEvent>> = [[]]): Controller => {
    const session = createSessionState({
      workingDirectory: dir,
      model: testModel,
      permissionMode: "ask",
      currentDate: "2026-07-05",
    })
    controller = makeController({
      session,
      activeModel: { provider: "anthropic", modelId: "claude-sonnet-5" },
      config,
      configPath: join(dir, "config.json"),
      llmLayer: scripted(turns),
      persist: false,
    })
    built.push(controller)
    return controller
  }

  test("renders the task panel from the loaded task store", async () => {
    const session = createSessionState({
      workingDirectory: dir,
      model: testModel,
      permissionMode: "ask",
      currentDate: "2026-07-05",
    })
    const tdir = join(sessionsDir(join(dir, "config.json"), dir), session.sessionId)
    mkdirSync(tdir, { recursive: true })
    writeFileSync(
      join(tdir, "tasks.json"),
      JSON.stringify([
        {
          id: "t1",
          subject: "investigate the bug",
          description: "d",
          status: "in_progress",
          agentType: "Explore",
          blockedBy: [],
          createdAt: "2026-07-08T00:00:00.000Z",
          updatedAt: "2026-07-08T00:00:00.000Z",
        },
      ]),
    )
    const c = makeController({
      session,
      activeModel: { provider: "anthropic", modelId: "claude-sonnet-5" },
      config,
      configPath: join(dir, "config.json"),
      llmLayer: scripted([[]]),
      persist: false,
    })
    built.push(c)
    const { lastFrame } = render(<App controller={c} />)
    await flush()
    await flush()
    expect(clean(lastFrame() ?? "")).toContain("investigate the bug")
  })

  test("renders the status line and an empty prompt", () => {
    const { lastFrame } = render(<App controller={makeCtrl()} />)
    expect(lastFrame()).toContain("claude-sonnet-5")
    expect(lastFrame()).toContain("ask")
    expect(lastFrame()).toContain("type a prompt")
  })

  test("typing /he shows /help and highlights the command token", async () => {
    const { stdin, lastFrame } = render(<App controller={makeCtrl()} />)
    stdin.write("/he")
    await flush()
    expect(lastFrame()).toContain("/help")
    expect(lastFrame()).toContain("/he")
  })

  test("Tab accepts the highlighted command without leaving suggestions", async () => {
    const { stdin, lastFrame } = render(<App controller={makeCtrl()} />)
    stdin.write("/he")
    await flush()
    stdin.write("\t")
    await flush()
    // Command token replaced with `/help ` (trailing space trimmed in output),
    // and the suggestion list is gone.
    expect(lastFrame()).toContain("/help")
    expect(lastFrame()).not.toContain("Show commands")
  })

  test("Enter executes the highlighted command instead of inserting it", async () => {
    const { stdin, lastFrame } = render(<App controller={makeCtrl()} />)
    stdin.write("/he")
    await flush()
    stdin.write("\r")
    await flush()
    // /help executed: the help screen (unique "Keys" section) is shown rather
    // than the command being left in the input.
    expect(lastFrame()).toContain("cycle permission mode")
  })

  test("a recognized command with args keeps the token highlighted and hides suggestions", async () => {
    const { stdin, lastFrame } = render(<App controller={makeCtrl()} />)
    stdin.write("/model x")
    await flush()
    expect(clean(lastFrame())).toContain("/model x")
    expect(lastFrame()).not.toContain("/clear")
  })

  test("an unknown leading slash token renders with the unknown-command color", async () => {
    const { stdin, lastFrame } = render(<App controller={makeCtrl()} />)
    stdin.write("/zzz")
    await flush()
    expect(lastFrame()).toContain("/zzz")
  })

  test("typing @src invokes file search and renders results", async () => {
    const { stdin, lastFrame } = render(<App controller={makeCtrl()} />)
    stdin.write("@src")
    await flush()
    expect(lastFrame()).toContain("src")
  })

  test("Enter inserts the highlighted file path instead of submitting", async () => {
    const { stdin, lastFrame } = render(<App controller={makeCtrl()} />)
    stdin.write("@src")
    await flush()
    stdin.write("\r")
    await flush()
    // File accepted into the input; the prompt was not submitted (no empty
    // placeholder) and typing can continue.
    expect(clean(lastFrame())).toContain("@src")
    expect(lastFrame()).not.toContain("type a prompt")
  })

  test("Shift-Tab cycles the permission mode", async () => {
    const c = makeCtrl()
    const { stdin } = render(<App controller={c} />)
    expect(c.getState().permissionMode).toBe("ask")
    stdin.write(SHIFT_TAB)
    await flush()
    expect(c.getState().permissionMode).toBe("auto")
  })

  test("streamed model text lands in the transcript", async () => {
    const textTurn: ReadonlyArray<LLMEvent> = [
      { type: "text-start", contentId },
      { type: "text-delta", contentId, text: "hello world" },
      { type: "text-end", contentId },
      { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
    ]
    const { stdin, lastFrame } = render(<App controller={makeCtrl([textTurn])} />)
    stdin.write("hi")
    await flush()
    stdin.write("\r")
    await flush()
    await flush()
    expect(lastFrame()).toContain("hello world")
  })

  test("a fused Shift+Enter (\\<CR>) inserts a newline instead of submitting", async () => {
    const c = makeCtrl()
    const { stdin, lastFrame } = render(<App controller={c} />)
    stdin.write("a")
    await flush()
    stdin.write("\\\r") // fused backslash + CR, as the terminal delivers Shift+Enter
    await flush()
    stdin.write("b")
    await flush()
    expect(c.getState().session.messages).toHaveLength(0) // not submitted
    const frame = lastFrame() ?? ""
    expect(frame).toContain("a")
    expect(frame).toContain("b")
  })

  test("repeated fused Shift+Enter keeps adding lines", async () => {
    const c = makeCtrl()
    const { stdin, lastFrame } = render(<App controller={c} />)
    stdin.write("a")
    await flush()
    stdin.write("\\\r")
    await flush()
    stdin.write("b")
    await flush()
    stdin.write("\\\r") // second Shift+Enter must also insert a newline
    await flush()
    stdin.write("c")
    await flush()
    // Never submitted (a second Shift+Enter that submitted would push a user
    // message), and all three characters are still in the buffer.
    expect(c.getState().session.messages).toHaveLength(0)
    const frame = clean(lastFrame())
    for (const ch of ["a", "b", "c"]) expect(frame).toContain(ch)
  })

  test("Shift+Enter split across a synchronous burst still composes", async () => {
    // No flush between writes: the handler fires multiple times before React
    // re-renders, so this only passes if editing reads the latest text (ref),
    // not a stale closure.
    const c = makeCtrl()
    const { stdin, lastFrame } = render(<App controller={c} />)
    stdin.write("a")
    stdin.write("\\") // backslash and CR arriving as separate events in one tick
    stdin.write("\r")
    stdin.write("b")
    await flush()
    expect(c.getState().session.messages).toHaveLength(0)
    const frame = clean(lastFrame())
    expect(frame).toContain("a")
    expect(frame).toContain("b")
  })

  test("Option+Backspace deletes the word before the cursor", async () => {
    const c = makeCtrl()
    const { stdin, lastFrame } = render(<App controller={c} />)
    stdin.write("foo bar")
    await flush()
    stdin.write("") // ESC + DEL = Option+Backspace
    await flush()
    const frame = clean(lastFrame())
    expect(frame).toContain("foo")
    expect(frame).not.toContain("bar")
  })

  test("backslash + Enter inserts a newline (line continuation)", async () => {
    const c = makeCtrl()
    const { stdin } = render(<App controller={c} />)
    stdin.write("a\\")
    await flush()
    stdin.write("\r") // plain Enter after a trailing backslash → newline, not submit
    await flush()
    expect(c.getState().session.messages).toHaveLength(0)
  })

  test("Option/Meta+Enter (ESC+CR) inserts a newline", async () => {
    const c = makeCtrl()
    const { stdin } = render(<App controller={c} />)
    stdin.write("a")
    await flush()
    stdin.write("\x1b\r") // ESC+CR → decoded as meta+return
    await flush()
    expect(c.getState().session.messages).toHaveLength(0)
  })

  test("/model with no args opens the model picker", async () => {
    const { stdin, lastFrame } = render(<App controller={makeCtrl()} />)
    stdin.write("/model ")
    await flush()
    stdin.write("\r")
    await flush()
    expect(lastFrame()).toContain("Select a model")
    expect(lastFrame()).toContain("claude-sonnet-5")
  })

  test("/variants with no args opens the variant picker for the active model", async () => {
    const { stdin, lastFrame } = render(<App controller={makeCtrl()} />)
    stdin.write("/variants ")
    await flush()
    stdin.write("\r")
    await flush()
    expect(lastFrame()).toContain("Select a variant")
    expect(lastFrame()).toContain("default")
    expect(lastFrame()).toContain("extended thinking")
  })

  test("/connect opens a provider picker with every static provider", async () => {
    const { stdin, lastFrame } = render(<App controller={makeCtrl()} />)
    stdin.write("/connect ")
    await flush()
    stdin.write("\r")
    await flush()
    expect(lastFrame()).toContain("Connect a provider")
    expect(lastFrame()).toContain("Anthropic")
    expect(lastFrame()).toContain("OpenAI")
    expect(lastFrame()).toContain("DeepSeek")
  })

  test("Up/Down recall prior prompts and restore the in-progress draft", async () => {
    const c = makeCtrl([[], []])
    const { stdin, lastFrame } = render(<App controller={c} />)
    stdin.write("first prompt")
    await flush()
    stdin.write("\r")
    await flush()
    stdin.write("second prompt")
    await flush()
    stdin.write("\r")
    await flush()
    stdin.write("draft in progress")
    await flush()
    stdin.write("\x1b[A") // Up → most recent prompt
    await flush()
    // The draft was never submitted, so its disappearance proves the prompt box
    // (not just the transcript) now holds the recalled entry; the label is
    // rendered only over the prompt, so it is an unambiguous position signal.
    expect(clean(lastFrame())).not.toContain("draft in progress")
    expect(clean(lastFrame())).toContain("History 2/2")
    stdin.write("\x1b[A") // Up → older prompt
    await flush()
    expect(clean(lastFrame())).toContain("History 1/2")
    stdin.write("\x1b[B") // Down → back to more recent
    await flush()
    expect(clean(lastFrame())).toContain("History 2/2")
    stdin.write("\x1b[B") // Down → restore the stashed draft
    await flush()
    expect(clean(lastFrame())).toContain("draft in progress")
    expect(clean(lastFrame())).not.toContain("History")
  })

  test("mouse wheel scrolls the transcript instead of recalling history", async () => {
    const c = makeCtrl([[]])
    const { stdin, lastFrame } = render(<App controller={c} />)
    stdin.write("first prompt")
    await flush()
    stdin.write("\r")
    await flush()
    stdin.write("draft in progress")
    await flush()
    stdin.write("\x1b[<64;10;5M") // wheel up
    await flush()
    // The wheel must not recall the prior prompt (no History label, draft kept)
    // nor leak the escape sequence into the prompt box.
    expect(clean(lastFrame())).not.toContain("History")
    expect(clean(lastFrame())).toContain("draft in progress")
    expect(clean(lastFrame())).not.toContain("[<64")
  })

  test("submitting a prompt with no provider configured redirects to connect", async () => {
    const c = makeController({
      session: createSessionState({
        workingDirectory: dir,
        model: testModel,
        permissionMode: "ask",
        currentDate: "2026-07-05",
      }),
      activeModel: { provider: "none", modelId: "unconfigured" },
      config: { providers: {} },
      configPath: join(dir, "config.json"),
      llmLayer: scripted([[]]),
      persist: false,
    })
    built.push(c)
    const { stdin, lastFrame } = render(<App controller={c} />)
    stdin.write("hello")
    await flush()
    stdin.write("\r")
    await flush()
    expect(lastFrame()).toContain("Connect a provider")
    expect(c.getState().session.messages).toHaveLength(0)
  })

  test("connecting from an unconfigured state chains into model then variant setup", async () => {
    const c = makeController({
      session: createSessionState({
        workingDirectory: dir,
        model: testModel,
        permissionMode: "ask",
        currentDate: "2026-07-05",
      }),
      activeModel: { provider: "none", modelId: "unconfigured" },
      config: { providers: {} },
      configPath: join(dir, "config.json"),
      llmLayer: scripted([[]]),
      persist: false,
    })
    built.push(c)
    const { stdin, lastFrame } = render(<App controller={c} />)
    stdin.write("/connect anthropic")
    await flush()
    stdin.write("\r") // open the Anthropic credential form
    await flush()
    stdin.write("sk-test-key")
    await flush()
    stdin.write("\r") // save credentials → auto-advance to the model picker
    await flush()
    expect(clean(lastFrame())).toContain("Select a model")
    stdin.write("\x1b[B") // move to claude-sonnet-5, which offers a variant
    await flush()
    stdin.write("\r") // select it → auto-advance to the variant picker
    await flush()
    expect(clean(lastFrame())).toContain("Select a variant")
    expect(clean(lastFrame())).toContain("extended thinking")
  })

  test("Ctrl+C clears the input and arms exit instead of exiting on the first press", async () => {
    const { stdin, lastFrame } = render(<App controller={makeCtrl()} />)
    stdin.write("draft text")
    await flush()
    stdin.write("\x03") // Ctrl+C
    await flush()
    const frame = clean(lastFrame())
    expect(frame).not.toContain("draft text") // input cleared
    expect(frame).toContain("Press Ctrl+C again to exit")
  })

  test("Esc cancels a loading turn and restores the prompt for editing", async () => {
    const hanging = Layer.succeed(LLMClient.Service, {
      request: LLMClient.request,
      streamTurn: () => Stream.never,
      generateTurn: () => Effect.never,
    })
    const c = makeController({
      session: createSessionState({
        workingDirectory: dir,
        model: testModel,
        permissionMode: "ask",
        currentDate: "2026-07-05",
      }),
      activeModel: { provider: "anthropic", modelId: "claude-sonnet-5" },
      config,
      configPath: join(dir, "config.json"),
      llmLayer: hanging,
      persist: false,
    })
    built.push(c)
    const { stdin, lastFrame } = render(<App controller={c} />)
    stdin.write("hello there")
    await flush()
    stdin.write("\r") // submit
    await flush()
    expect(c.getState().running).toBe(true)
    expect(c.getState().session.messages).toHaveLength(1) // user prompt pushed
    stdin.write("\x1b") // Esc cancels the loading turn
    await flush()
    await flush()
    expect(c.getState().running).toBe(false)
    expect(c.getState().session.messages).toHaveLength(0) // turn retracted
    expect(clean(lastFrame())).toContain("hello there") // prompt restored to editor
  })
})
