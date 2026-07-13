import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunContext } from "@effect/platform-bun"
import type { Model } from "@swain/llms"
import { Message, ModelId, ProviderId } from "@swain/llms"
import { Effect, Stream } from "effect"
import {
  createSessionState,
  loadSession,
  readPersistedModelRef,
  recordModelTransition,
  type SessionModelRef,
  saveSession,
} from "../src/state"

const makeModel = (id: string, provider: string): Model => ({
  id: ModelId.make(id),
  provider: ProviderId.make(provider),
  streamTurn: () => Stream.empty,
})

const anthropic = makeModel("claude-opus-4-8", "anthropic")
const deepseek = makeModel("deepseek-v4-pro", "deepseek")

const run = <A, E>(effect: Effect.Effect<A, E, BunContext.BunContext>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunContext.layer)))

describe("createSessionState model ref", () => {
  test("derives modelRef from the model when none is supplied", () => {
    const state = createSessionState({
      workingDirectory: "/w",
      model: anthropic,
      currentDate: "2026-07-10",
    })
    expect(state.systemContext.modelRef).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
    })
    expect(state.systemContext.pastModels).toEqual([])
    expect(state.systemContext.requestOptions).toEqual({})
  })

  test("seeds an explicit modelRef with a variant", () => {
    const state = createSessionState({
      workingDirectory: "/w",
      model: anthropic,
      modelRef: { provider: "anthropic", modelId: "claude-opus-4-8", variant: "high" },
      requestOptions: { providerOptions: { anthropic: { thinking: { type: "adaptive" } } } },
      currentDate: "2026-07-10",
    })
    expect(state.systemContext.modelRef.variant).toBe("high")
  })
})

describe("recordModelTransition", () => {
  test("moves the previous ref into pastModels and returns it", () => {
    const state = createSessionState({
      workingDirectory: "/w",
      model: anthropic,
      currentDate: "2026-07-10",
    })
    const previous = recordModelTransition(state, {
      model: deepseek,
      modelRef: { provider: "deepseek", modelId: "deepseek-v4-pro", variant: "max" },
      requestOptions: {},
    })
    expect(previous).toEqual({ provider: "anthropic", modelId: "claude-opus-4-8" })
    expect(state.systemContext.modelRef).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      variant: "max",
    })
    expect(state.systemContext.pastModels).toEqual([
      { provider: "anthropic", modelId: "claude-opus-4-8" },
    ])
    expect(state.systemContext.model).toBe(deepseek)
  })

  test("a same-target transition is a no-op for history", () => {
    const state = createSessionState({
      workingDirectory: "/w",
      model: anthropic,
      currentDate: "2026-07-10",
    })
    const previous = recordModelTransition(state, {
      model: anthropic,
      modelRef: { provider: "anthropic", modelId: "claude-opus-4-8" },
      requestOptions: { generation: { maxTokens: 10 } },
    })
    expect(previous).toBeUndefined()
    expect(state.systemContext.pastModels).toEqual([])
    expect(state.systemContext.requestOptions).toEqual({ generation: { maxTokens: 10 } })
  })

  test("dedupes a ref that was already current earlier", () => {
    const state = createSessionState({
      workingDirectory: "/w",
      model: anthropic,
      currentDate: "2026-07-10",
    })
    const ref = (p: string, m: string): SessionModelRef => ({ provider: p, modelId: m })
    recordModelTransition(state, {
      model: deepseek,
      modelRef: ref("deepseek", "deepseek-v4-pro"),
      requestOptions: {},
    })
    recordModelTransition(state, {
      model: anthropic,
      modelRef: ref("anthropic", "claude-opus-4-8"),
      requestOptions: {},
    })
    // anthropic → deepseek again: deepseek already stopped being current once.
    recordModelTransition(state, {
      model: deepseek,
      modelRef: ref("deepseek", "deepseek-v4-pro"),
      requestOptions: {},
    })
    expect(state.systemContext.pastModels).toEqual([
      { provider: "anthropic", modelId: "claude-opus-4-8" },
      { provider: "deepseek", modelId: "deepseek-v4-pro" },
    ])
  })
})

describe("session model persistence", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swain-session-models-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("save/load preserves modelRef and pastModels", async () => {
    const state = createSessionState({
      sessionId: "s1",
      workingDirectory: dir,
      model: deepseek,
      modelRef: { provider: "deepseek", modelId: "deepseek-v4-pro", variant: "high" },
      pastModels: [{ provider: "anthropic", modelId: "claude-opus-4-8" }],
      currentDate: "2026-07-10",
    })
    const reloaded = await run(
      saveSession(state, dir).pipe(
        Effect.andThen(
          loadSession({
            sessionId: "s1",
            model: deepseek,
            modelRef: { provider: "deepseek", modelId: "deepseek-v4-pro", variant: "high" },
            requestOptions: { providerOptions: { deepseek: { thinking: true } } },
            sessionsDir: dir,
          }),
        ),
      ),
    )
    expect(reloaded.systemContext.modelRef).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      variant: "high",
    })
    expect(reloaded.systemContext.pastModels).toEqual([
      { provider: "anthropic", modelId: "claude-opus-4-8" },
    ])
    // requestOptions is rebuilt from the resolved target, not persisted.
    expect(reloaded.systemContext.requestOptions).toEqual({
      providerOptions: { deepseek: { thinking: true } },
    })
  })

  test("readPersistedModelRef returns the saved current target", async () => {
    const state = createSessionState({
      sessionId: "s2",
      workingDirectory: dir,
      model: deepseek,
      modelRef: { provider: "deepseek", modelId: "deepseek-v4-pro", variant: "max" },
      currentDate: "2026-07-10",
    })
    const ref = await run(
      saveSession(state, dir).pipe(Effect.andThen(readPersistedModelRef(dir, "s2"))),
    )
    expect(ref).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro", variant: "max" })
  })

  test("legacy metadata without modelRef falls back to the caller model and empty history", async () => {
    const sdir = join(dir, "legacy")
    await mkdir(sdir, { recursive: true })
    writeFileSync(
      join(sdir, "session.json"),
      JSON.stringify({
        sessionId: "legacy",
        workingDirectory: dir,
        permissionMode: "ask",
        currentDate: "2026-07-10",
        model: { id: "claude-opus-4-8", provider: "anthropic" },
        counters: { turns: 3, inputTokens: 5, outputTokens: 7 },
      }),
    )
    writeFileSync(join(sdir, "messages.jsonl"), "")
    const loaded = await run(
      loadSession({ sessionId: "legacy", model: anthropic, sessionsDir: dir }),
    )
    expect(loaded.systemContext.modelRef).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
    })
    expect(loaded.systemContext.pastModels).toEqual([])
    expect(loaded.counters.turns).toBe(3)
    expect(await run(readPersistedModelRef(dir, "legacy"))).toBeUndefined()
    // Missing compaction metadata defaults to auto-enabled with no summary.
    expect(loaded.compaction).toEqual({ autoEnabled: true })
    expect(loaded.toolResults).toEqual([])
  })

  test("save/load preserves compaction state and its meta message", async () => {
    const compactionMeta = Message.user(
      [{ type: "compaction", reason: "manual", compactedMessages: 9, summary: "## Goal\nS" }],
      true,
    )
    const state = createSessionState({
      sessionId: "s-compact",
      workingDirectory: dir,
      model: anthropic,
      currentDate: "2026-07-10",
      messages: [compactionMeta, Message.assistant("carrying on")],
      compaction: {
        autoEnabled: false,
        summary: "## Goal\nS",
        failureReason: "boom",
        lastCompactedAt: "2026-07-10T00:00:00Z",
      },
    })
    const reloaded = await run(
      saveSession(state, dir).pipe(
        Effect.andThen(loadSession({ sessionId: "s-compact", model: anthropic, sessionsDir: dir })),
      ),
    )
    expect(reloaded.compaction).toEqual({
      autoEnabled: false,
      summary: "## Goal\nS",
      failureReason: "boom",
      lastCompactedAt: "2026-07-10T00:00:00Z",
    })
    expect(reloaded.messages[0]).toEqual(compactionMeta)
    // Context accounting is not persisted; resume re-estimates the full history.
    expect(reloaded.contextUsage).toBeUndefined()
  })

  test("save/load preserves tool-result replacement metadata", async () => {
    const replacement = {
      toolCallId: "call-1",
      name: "Bash",
      path: join(dir, "s-tr", "tool-results", "call-1.txt"),
      originalBytes: 90_000,
      previewBytes: 2_000,
      createdAt: "2026-07-10T00:00:00Z",
    }
    const state = createSessionState({
      sessionId: "s-tr",
      workingDirectory: dir,
      model: anthropic,
      currentDate: "2026-07-10",
      toolResults: [replacement],
    })
    const reloaded = await run(
      saveSession(state, dir).pipe(
        Effect.andThen(loadSession({ sessionId: "s-tr", model: anthropic, sessionsDir: dir })),
      ),
    )
    expect(reloaded.toolResults).toEqual([replacement])
  })

  test("a missing tool-results sidecar loads as empty metadata, not a failure", async () => {
    const state = createSessionState({
      sessionId: "s-nosidecar",
      workingDirectory: dir,
      model: anthropic,
      currentDate: "2026-07-10",
      messages: [Message.user("hi")],
    })
    const reloaded = await run(
      saveSession(state, dir).pipe(
        Effect.andThen(
          loadSession({ sessionId: "s-nosidecar", model: anthropic, sessionsDir: dir }),
        ),
      ),
    )
    expect(reloaded.toolResults).toEqual([])
  })
})
