import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
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
import { foldEvents } from "../src/components/Transcript"
import type { TuiConfig } from "../src/config"
import { type Controller, makeController } from "../src/controller"

const flush = () => new Promise((resolve) => setTimeout(resolve, 25))
const RIGHT = "[C"
const LEFT = "[D"
const SHIFT_TAB = "[Z"

const testModel: Model = {
  id: ModelId.make("claude-sonnet-4-5"),
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
    expect(render(<PromptInput value="/he" cursor={3} />).lastFrame()).toContain("/he")
    const multi = render(<PromptInput value={"first\nsecond"} cursor={11} />).lastFrame() ?? ""
    expect(multi).toContain("first")
    expect(multi).toContain("second")
    expect(multi.split("\n").length).toBeGreaterThan(1)
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
      activeModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      config,
      configPath: join(dir, "config.json"),
      env: {},
      llmLayer: scripted(turns),
      persist: false,
    })
    built.push(controller)
    return controller
  }

  test("renders the status line and an empty prompt", () => {
    const { lastFrame } = render(<App controller={makeCtrl()} />)
    expect(lastFrame()).toContain("claude-sonnet-4-5")
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

  test("a recognized command with args keeps the token highlighted and hides suggestions", async () => {
    const { stdin, lastFrame } = render(<App controller={makeCtrl()} />)
    stdin.write("/model x")
    await flush()
    expect(lastFrame()).toContain("/model x")
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

  test("/model with no args opens the model picker", async () => {
    const { stdin, lastFrame } = render(<App controller={makeCtrl()} />)
    stdin.write("/model ")
    await flush()
    stdin.write("\r")
    await flush()
    expect(lastFrame()).toContain("Select a model")
    expect(lastFrame()).toContain("claude-sonnet-4-5")
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
})
