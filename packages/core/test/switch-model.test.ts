import { describe, expect, test } from "bun:test"
import {
  ContentId,
  LLMClient,
  type LLMEvent,
  type Model,
  ModelId,
  ProviderId,
  type ToolCall,
  ToolCallId,
} from "@swain/llms"
import { Effect, Layer, Stream } from "effect"
import { type AgentEvent, runTurn, submitPrompt } from "../src/agent"
import {
  ModelResolveError,
  type ModelResolver,
  ModelResolverService,
  type ResolvedModel,
} from "../src/model-resolver"
import type { Permissions } from "../src/permission"
import { createSessionState, type SessionState } from "../src/state"
import { makeChildToolRegistry } from "../src/subagents/tools"
import { builtinTools, SwitchModel, ToolContext, toolRegistryLayer } from "../src/tools"

const makeModel = (id: string, provider: string): Model => ({
  id: ModelId.make(id),
  provider: ProviderId.make(provider),
  streamTurn: () => Stream.empty,
})

const anthropic = makeModel("claude-sonnet-5", "anthropic")
const deepseek = makeModel("deepseek-v4-pro", "deepseek")

const allow: Permissions = { check: () => Effect.succeed({ type: "allow" }) }

const session = (): SessionState =>
  createSessionState({
    workingDirectory: "/w",
    model: anthropic,
    modelRef: { provider: "anthropic", modelId: "claude-sonnet-5" },
    currentDate: "2026-07-10",
  })

const ctxLayer = (state: SessionState) =>
  Layer.succeed(ToolContext, {
    session: state,
    abortSignal: new AbortController().signal,
    permission: allow,
  })

// Resolves the deepseek target and returns typed errors for everything else.
const resolverLayer = (
  overrides: Partial<ModelResolver> = {},
): Layer.Layer<ModelResolverService> => {
  const impl: ModelResolver = {
    resolve: (targetId) => {
      if (targetId === "deepseek:deepseek-v4-pro:max") {
        const resolved: ResolvedModel = {
          model: deepseek,
          requestOptions: {
            providerOptions: { deepseek: { thinking: true, reasoningEffort: "max" } },
          },
          modelRef: { provider: "deepseek", modelId: "deepseek-v4-pro", variant: "max" },
        }
        return Effect.succeed(resolved)
      }
      return Effect.fail(
        new ModelResolveError({ reason: "unknown-target", targetId, message: `no ${targetId}` }),
      )
    },
    ...overrides,
  }
  return Layer.succeed(ModelResolverService, impl)
}

const toEvents = (call: ToolCall): ReadonlyArray<LLMEvent> => [
  { type: "tool-input-start", toolCallId: call.toolCallId, name: call.name },
  { type: "tool-input-end", toolCallId: call.toolCallId, name: call.name },
  { type: "tool-call", toolCallId: call.toolCallId, name: call.name, input: call.input },
]

const switchTurn = (
  model: string,
  reason: string,
  siblings: ReadonlyArray<ToolCall> = [],
): ReadonlyArray<LLMEvent> => [
  ...toEvents({
    type: "tool-call",
    toolCallId: ToolCallId.make("sw-1"),
    name: "SwitchModel",
    input: { model, reason },
  }),
  ...siblings.flatMap(toEvents),
  { type: "finish", reason: "tool-call", usage: { inputTokens: 1, outputTokens: 1 } },
]

const textTurn = (text: string): ReadonlyArray<LLMEvent> => {
  const c = ContentId.make("c")
  return [
    { type: "text-start", contentId: c },
    { type: "text-delta", contentId: c, text },
    { type: "text-end", contentId: c },
    { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
  ]
}

const scriptedLayer = (turns: ReadonlyArray<ReadonlyArray<LLMEvent>>) => {
  let i = 0
  return Layer.succeed(LLMClient.Service, {
    request: LLMClient.request,
    streamTurn: () => Stream.fromIterable(turns[Math.min(i++, turns.length - 1)] ?? []),
    generateTurn: () => Effect.succeed({ events: [] }),
  })
}

const drive = (
  state: SessionState,
  turns: ReadonlyArray<ReadonlyArray<LLMEvent>>,
  resolver: Layer.Layer<ModelResolverService> = resolverLayer(),
) =>
  Effect.runPromise(
    runTurn(state, { router: { targets: [] } }).pipe(
      Effect.provide(scriptedLayer(turns)),
      Effect.provide(ctxLayer(state)),
      Effect.provide(toolRegistryLayer(builtinTools)),
      Effect.provide(resolver),
    ),
  )

const hasBlock = (
  state: SessionState,
  role: string,
  pred: (b: Record<string, unknown>) => boolean,
) =>
  state.messages.some(
    (m) => m.role === role && m.content.some((b) => pred(b as Record<string, unknown>)),
  )

describe("SwitchModel tool", () => {
  test("is read-only and is a valid built-in", () => {
    expect(SwitchModel.name).toBe("SwitchModel")
    expect(SwitchModel.readOnly).toBe(true)
    expect(builtinTools.some((t) => t.name === "SwitchModel")).toBe(true)
  })

  test("child registries exclude SwitchModel", () => {
    const parent = new Map(builtinTools.map((t) => [t.name, t]))
    for (const type of ["Explore", "Plan", "GeneralPurpose"] as const) {
      expect(makeChildToolRegistry(type, parent, { isolated: true }).has("SwitchModel")).toBe(false)
    }
  })
})

describe("SwitchModel control flow", () => {
  test("a valid switch records a meta message and updates the current model/options", async () => {
    const state = session()
    submitPrompt(state, "hi")
    await drive(state, [switchTurn("deepseek:deepseek-v4-pro:max", "escalate"), textTurn("done")])
    expect(state.systemContext.modelRef).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      variant: "max",
    })
    expect(state.systemContext.model).toBe(deepseek)
    expect(state.systemContext.requestOptions.providerOptions).toEqual({
      deepseek: { thinking: true, reasoningEffort: "max" },
    })
    expect(state.systemContext.pastModels).toEqual([
      { provider: "anthropic", modelId: "claude-sonnet-5" },
    ])
    expect(hasBlock(state, "user", (b) => b.type === "model-switch")).toBe(true)
    // No orphan SwitchModel tool_use survives into history.
    expect(hasBlock(state, "assistant", (b) => b.name === "SwitchModel")).toBe(false)
    // The meta replaces the switching response, retaining its response duration
    // but never the whole-turn duration (that belongs to the final assistant).
    const meta = state.messages.find((m) => m.content.some((b) => b.type === "model-switch"))
    expect(meta?.responseDurationMs).toBeTypeOf("number")
    expect(meta?.turnDurationMs).toBeUndefined()
    const last = state.messages.at(-1)
    expect(last?.role).toBe("assistant")
    expect(last?.turnDurationMs).toBeGreaterThanOrEqual(0)
  })

  test("a valid switch emits a model-switch event with the new target", async () => {
    const state = session()
    submitPrompt(state, "hi")
    const events: Array<AgentEvent> = []
    await Effect.runPromise(
      runTurn(state, {
        router: { targets: [] },
        onEvent: (event) =>
          Effect.sync(() => {
            events.push(event)
          }),
      }).pipe(
        Effect.provide(
          scriptedLayer([switchTurn("deepseek:deepseek-v4-pro:max", "escalate"), textTurn("done")]),
        ),
        Effect.provide(ctxLayer(state)),
        Effect.provide(toolRegistryLayer(builtinTools)),
        Effect.provide(resolverLayer()),
      ),
    )
    expect(events.filter((e) => e.type === "model-switch")).toEqual([
      {
        type: "model-switch",
        to: { provider: "deepseek", modelId: "deepseek-v4-pro", variant: "max" },
      },
    ])
  })

  test("a same-target switch is a no-op success with no switch history", async () => {
    const state = session()
    submitPrompt(state, "hi")
    await drive(state, [switchTurn("anthropic:claude-sonnet-5", "stay"), textTurn("done")])
    expect(state.systemContext.pastModels).toEqual([])
    expect(hasBlock(state, "user", (b) => b.type === "model-switch")).toBe(false)
    expect(hasBlock(state, "user", (b) => b.type === "tool-result" && b.isError !== true)).toBe(
      true,
    )
  })

  test("an unavailable target leaves the session unchanged and returns a recoverable error", async () => {
    const state = session()
    submitPrompt(state, "hi")
    const failing = resolverLayer({
      resolve: (targetId) =>
        Effect.fail(new ModelResolveError({ reason: "unavailable", targetId, message: "gone" })),
    })
    await drive(
      state,
      [switchTurn("deepseek:deepseek-v4-pro:max", "escalate"), textTurn("done")],
      failing,
    )
    expect(state.systemContext.modelRef).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    })
    expect(hasBlock(state, "user", (b) => b.isError === true)).toBe(true)
  })

  test("a switch alongside siblings drops the siblings unexecuted", async () => {
    const state = session()
    submitPrompt(state, "hi")
    const read: ToolCall = {
      type: "tool-call",
      toolCallId: ToolCallId.make("read-1"),
      name: "Read",
      input: { path: "/etc/hosts" },
    }
    await drive(state, [
      switchTurn("deepseek:deepseek-v4-pro:max", "escalate", [read]),
      textTurn("done"),
    ])
    expect(hasBlock(state, "user", (b) => b.toolCallId === "read-1")).toBe(false)
  })

  test("plan permission mode does not deny a switch", async () => {
    const state = createSessionState({
      workingDirectory: "/w",
      model: anthropic,
      modelRef: { provider: "anthropic", modelId: "claude-sonnet-5" },
      permissionMode: "plan",
      currentDate: "2026-07-10",
    })
    submitPrompt(state, "hi")
    await drive(state, [switchTurn("deepseek:deepseek-v4-pro:max", "escalate"), textTurn("done")])
    expect(state.systemContext.modelRef.provider).toBe("deepseek")
  })

  test("at most one switch takes effect per user turn", async () => {
    const state = session()
    submitPrompt(state, "hi")
    // Two turns each requesting a switch; the second must not switch again.
    await drive(state, [
      switchTurn("deepseek:deepseek-v4-pro:max", "escalate"),
      switchTurn("deepseek:deepseek-v4-pro:max", "again"),
      textTurn("done"),
    ])
    // Only one transition recorded (one entry in pastModels).
    expect(state.systemContext.pastModels).toHaveLength(1)
    // The second switch attempt returns a recoverable error, not another switch.
    expect(hasBlock(state, "user", (b) => b.isError === true)).toBe(true)
  })
})
