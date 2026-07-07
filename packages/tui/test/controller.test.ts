import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunContext } from "@effect/platform-bun"
import { type AgentEvent, createSessionState, type PermissionMode, saveSession } from "@swain/core"
import type { LLMEvent, LLMRequest, Model } from "@swain/llms"
import { ContentId, ModelId, ProviderId, ToolCallId } from "@swain/llms"
import { LLMClient } from "@swain/llms/client"
import { Effect, Layer, Stream } from "effect"
import { sessionsDir, type TuiConfig } from "../src/config"
import { type Controller, makeController } from "../src/controller"

const testModel: Model = {
  id: ModelId.make("claude-sonnet-5"),
  provider: ProviderId.make("anthropic"),
  streamTurn: () => Stream.empty,
}

const contentId = ContentId.make("c-1")

const textTurn = (text: string): ReadonlyArray<LLMEvent> => [
  { type: "text-start", contentId },
  { type: "text-delta", contentId, text },
  { type: "text-end", contentId },
  { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
]

const twoDeltaTurn: ReadonlyArray<LLMEvent> = [
  { type: "text-start", contentId },
  { type: "text-delta", contentId, text: "he" },
  { type: "text-delta", contentId, text: "llo" },
  { type: "text-end", contentId },
  { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
]

const toolCallTurn = (name: string, input: unknown): ReadonlyArray<LLMEvent> => {
  const id = ToolCallId.make("call-1")
  return [
    { type: "tool-input-start", toolCallId: id, name },
    { type: "tool-input-end", toolCallId: id, name },
    { type: "tool-call", toolCallId: id, name, input },
    { type: "finish", reason: "tool-call", usage: { inputTokens: 1, outputTokens: 1 } },
  ]
}

const scripted = (turns: ReadonlyArray<ReadonlyArray<LLMEvent>>) => {
  const requests: Array<LLMRequest> = []
  let index = 0
  const next = (): ReadonlyArray<LLMEvent> => turns[Math.min(index++, turns.length - 1)] ?? []
  const layer = Layer.succeed(LLMClient.Service, {
    request: LLMClient.request,
    streamTurn: (request: LLMRequest) => {
      requests.push(request)
      return Stream.fromIterable(next())
    },
    generateTurn: (request: LLMRequest) => {
      requests.push(request)
      return Effect.succeed({ events: [...next()] })
    },
  })
  return { layer, requests }
}

const config: TuiConfig = { providers: { anthropic: { apiKey: "sk-test" } } }

describe("controller", () => {
  let dir: string
  let controller: Controller
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swain-ctrl-"))
  })
  afterEach(() => {
    controller?.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const build = (
    llm: ReturnType<typeof scripted>,
    permissionMode: PermissionMode = "auto",
  ): Controller => {
    const session = createSessionState({
      workingDirectory: dir,
      model: testModel,
      permissionMode,
      currentDate: "2026-07-05",
    })
    controller = makeController({
      session,
      activeModel: { provider: "anthropic", modelId: "claude-sonnet-5" },
      config,
      configPath: join(dir, "config.json"),
      llmLayer: llm.layer,
      persist: false,
    })
    return controller
  }

  test("submitting a prompt appends a user message", async () => {
    const c = build(scripted([textTurn("ok")]))
    await c.submitPrompt("hello")
    const messages = c.getState().session.messages
    expect(messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "hello" }] })
  })

  test("forwards both text deltas to the event subscriber in order", async () => {
    const c = build(scripted([twoDeltaTurn]))
    const events: Array<AgentEvent> = []
    c.onEvent((event) => events.push(event))
    await c.submitPrompt("hi")
    const deltas = events
      .filter((e) => e.type === "llm-event" && e.event.type === "text-delta")
      .map((e) => (e.type === "llm-event" && e.event.type === "text-delta" ? e.event.text : ""))
    expect(deltas).toEqual(["he", "llo"])
  })

  test("forwards tool-execution-delta between start and end", async () => {
    const c = build(
      scripted([toolCallTurn("Bash", { command: "printf 'x\\ny\\n'" }), textTurn("done")]),
    )
    const events: Array<AgentEvent> = []
    c.onEvent((event) => events.push(event))
    await c.submitPrompt("run it")
    const start = events.findIndex((e) => e.type === "tool-execution-start")
    const delta = events.findIndex((e) => e.type === "tool-execution-delta")
    const end = events.findIndex((e) => e.type === "tool-execution-end")
    expect(start).toBeGreaterThanOrEqual(0)
    expect(delta).toBeGreaterThan(start)
    expect(delta).toBeLessThan(end)
  })

  test("/clear creates a new empty session", async () => {
    const c = build(scripted([textTurn("ok")]))
    await c.submitPrompt("hello")
    const before = c.getState().session.sessionId
    c.clearConversation()
    const after = c.getState().session
    expect(after.sessionId).not.toBe(before)
    expect(after.messages).toEqual([])
  })

  test("permission cycling follows ask -> auto -> plan -> ask", () => {
    const c = build(scripted([textTurn("ok")]), "ask")
    expect(c.getState().permissionMode).toBe("ask")
    c.cyclePermissionMode()
    expect(c.getState().permissionMode).toBe("auto")
    c.cyclePermissionMode()
    expect(c.getState().permissionMode).toBe("plan")
    c.cyclePermissionMode()
    expect(c.getState().permissionMode).toBe("ask")
  })

  test("selecting a variant updates the request options used by the next turn", async () => {
    const llm = scripted([textTurn("ok")])
    const c = build(llm)
    await c.setVariant("thinking")
    await c.submitPrompt("hi")
    expect(llm.requests.at(-1)?.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 8192 } },
    })
  })

  test("an Ask request is forwarded to the UI and resolves with the selected answers", async () => {
    const c = build(
      scripted([
        toolCallTurn("Ask", {
          questions: [
            {
              question: "Pick?",
              options: [
                { label: "A", description: "a" },
                { label: "B", description: "b" },
              ],
            },
          ],
        }),
        textTurn("done"),
      ]),
    )
    let seen: string | undefined
    c.onQuestion((request) => {
      seen = request.input.questions[0]?.question
      c.answerQuestion(request.id, [{ question: "Pick?", selected: ["A"] }])
    })
    await c.submitPrompt("hi")
    expect(seen).toBe("Pick?")
    const messages = c.getState().session.messages
    const toolResult = messages.find((m) => m.content.some((block) => block.type === "tool-result"))
    expect(toolResult).toBeDefined()
    expect(messages.at(-1)).toMatchObject({ role: "assistant" })
  })
})

describe("controller command actions", () => {
  let dir: string
  let controller: Controller
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swain-ctrl2-"))
  })
  afterEach(() => {
    controller?.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const build = (initialConfig: TuiConfig, persist = true): Controller => {
    const session = createSessionState({
      workingDirectory: dir,
      model: testModel,
      permissionMode: "auto",
      currentDate: "2026-07-05",
    })
    controller = makeController({
      session,
      activeModel: { provider: "anthropic", modelId: "claude-sonnet-5" },
      config: initialConfig,
      configPath: join(dir, "config.json"),
      llmLayer: scripted([textTurn("ok")]).layer,
      persist,
    })
    return controller
  }

  test("connecting a provider makes its models available and stores a redacted key", async () => {
    const c = build({ providers: {} })
    expect(c.getState().availableModels).toHaveLength(0)
    const result = await c.connectProvider("anthropic", { apiKey: "sk-secret-1234" })
    expect(result.ok).toBe(true)
    expect(c.getState().availableModels.some((m) => m.provider === "anthropic")).toBe(true)
    const provider = c.getState().connectableProviders.find((p) => p.id === "anthropic")
    expect(provider?.configured).toBe(true)
    expect(provider?.redactedKey).toBeDefined()
    expect(provider?.redactedKey).not.toBe("sk-secret-1234")
  })

  test("connecting writes the key to auth.json and keeps config.json secret-free", async () => {
    const c = build({ providers: {} })
    await c.connectProvider("anthropic", { apiKey: "sk-secret-1234" })
    const authFile = join(dir, "auth.json")
    const configFile = join(dir, "config.json")
    expect(existsSync(authFile)).toBe(true)
    expect(JSON.parse(readFileSync(authFile, "utf8")).anthropic.apiKey).toBe("sk-secret-1234")
    // config.json must never contain the credential.
    if (existsSync(configFile)) expect(readFileSync(configFile, "utf8")).not.toContain("sk-secret")
  })

  test("a failed config write reports an error and leaves the provider unconfigured", async () => {
    const c = build({ providers: {} })
    // Point the config at a path under a file so makeDirectory fails.
    const bad = makeController({
      session: createSessionState({
        workingDirectory: dir,
        model: testModel,
        currentDate: "2026-07-05",
      }),
      activeModel: { provider: "anthropic", modelId: "claude-sonnet-5" },
      config: { providers: {} },
      configPath: join(dir, "config.json", "nested.json"),
      llmLayer: scripted([textTurn("ok")]).layer,
      persist: true,
    })
    // Create the blocking file where a directory is expected.
    await c.connectProvider("anthropic", { apiKey: "sk-1" })
    const result = await bad.connectProvider("anthropic", { apiKey: "sk-2" })
    expect(result.ok).toBe(false)
    expect(bad.getState().connectableProviders.find((p) => p.id === "anthropic")?.configured).toBe(
      false,
    )
    bad.dispose()
  })

  test("selecting an invalid model emits an agent-error", async () => {
    const c = build({ providers: { anthropic: { apiKey: "sk-1" } } })
    const events: Array<AgentEvent> = []
    c.onEvent((event) => events.push(event))
    await c.selectModel("anthropic", "no-such-model")
    expect(events.some((e) => e.type === "agent-error")).toBe(true)
  })

  test("recordPrompt appends to history, dedupes, and persists beside config", async () => {
    const c = build({ providers: { anthropic: { apiKey: "sk-1" } } })
    c.recordPrompt("first")
    c.recordPrompt("first") // consecutive duplicate is ignored
    c.recordPrompt("second")
    expect(c.getHistory()).toEqual(["first", "second"])
    await new Promise((resolve) => setTimeout(resolve, 25))
    const historyFile = join(dir, "history.json")
    expect(existsSync(historyFile)).toBe(true)
    expect(JSON.parse(readFileSync(historyFile, "utf8"))).toEqual(["first", "second"])
  })

  test("seeded history is exposed and survives a new controller", () => {
    const c = makeController({
      session: createSessionState({
        workingDirectory: dir,
        model: testModel,
        currentDate: "2026-07-05",
      }),
      activeModel: { provider: "anthropic", modelId: "claude-sonnet-5" },
      config: { providers: {} },
      configPath: join(dir, "config.json"),
      history: ["earlier"],
      llmLayer: scripted([textTurn("ok")]).layer,
      persist: false,
    })
    expect(c.getHistory()).toEqual(["earlier"])
  })

  test("resume loads a saved session and rehydrates counters", async () => {
    const c = build({ providers: { anthropic: { apiKey: "sk-1" } } })
    // Persist a session to disk with counters.
    const original = createSessionState({
      sessionId: "s-resume",
      workingDirectory: dir,
      model: testModel,
      permissionMode: "auto",
      currentDate: "2026-07-05",
    })
    original.counters.turns = 3
    original.counters.inputTokens = 12
    original.counters.outputTokens = 8
    await Effect.runPromise(
      saveSession(original, sessionsDir(join(dir, "config.json"), dir)).pipe(
        Effect.provide(BunContext.layer),
      ),
    )
    const listed = c.listSessions()
    expect(listed.some((s) => s.sessionId === "s-resume")).toBe(true)
    await c.resumeSession("s-resume")
    expect(c.getState().session.sessionId).toBe("s-resume")
    expect(c.getUsage()).toMatchObject({ turns: 3, inputTokens: 12, outputTokens: 8 })
  })
})
