import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunContext } from "@effect/platform-bun"
import type { Model, ToolCall } from "@swain/llms"
import { ModelId, ProviderId, ToolCallId } from "@swain/llms"
import { Effect, Layer, Schema, Stream } from "effect"
import { type AgentEvent, runTurn, submitPrompt } from "../src/agent"
import { autoApproval, makePermissions } from "../src/permission"
import { createSessionState } from "../src/state"
import { Bash, callTool, defineTool, ToolContext, toolRegistryLayer } from "../src/tools"
import { textTurn, toolCallTurn } from "./utils/fixtures"
import { scriptedLLMClient } from "./utils/harness"

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => Stream.empty,
}

describe("Bash streaming progress", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swain-bash-stream-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const contextLayer = (
    state = createSessionState({
      workingDirectory: dir,
      model,
      currentDate: "2026-07-04",
      permissionMode: "auto",
    }),
  ) =>
    Layer.succeed(ToolContext, {
      session: state,
      abortSignal: new AbortController().signal,
      permission: makePermissions("auto", autoApproval),
    })

  const runBash = (command: string, onProgress?: (delta: string) => Effect.Effect<void>) => {
    const toolCall: ToolCall = {
      type: "tool-call",
      toolCallId: ToolCallId.make("bash-1"),
      name: "Bash",
      input: { command },
    }
    return Effect.runPromise(
      callTool(toolCall, onProgress).pipe(
        Effect.provide(contextLayer()),
        Effect.provide(toolRegistryLayer([Bash])),
        Effect.provide(BunContext.layer),
      ),
    )
  }

  test("concatenated deltas equal the final stdout", async () => {
    const deltas: Array<string> = []
    const result = await runBash("printf 'a\\nb\\nc\\n'", (text) =>
      Effect.sync(() => deltas.push(text)),
    )
    const value = (result.result as { value: { stdout: string; truncated: boolean } }).value
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.join("")).toBe(value.stdout)
    expect(value.truncated).toBe(false)
  })

  test("a non-streaming tool with no onProgress still succeeds via the no-op emitter", async () => {
    const doubler = defineTool({
      name: "Doubler",
      description: "doubles a number",
      inputSchema: Schema.Struct({ value: Schema.Number }),
      outputSchema: Schema.Struct({ doubled: Schema.Number }),
      readOnly: true,
      call: (input) => Effect.succeed({ doubled: input.value * 2 }),
    })
    const result = await Effect.runPromise(
      callTool(
        {
          type: "tool-call",
          toolCallId: ToolCallId.make("c"),
          name: "Doubler",
          input: { value: 4 },
        },
        undefined,
      ).pipe(Effect.provide(contextLayer()), Effect.provide(toolRegistryLayer([doubler]))),
    )
    expect(result.result).toEqual({ type: "json", value: { doubled: 8 } })
  })

  test("output past MAX_OUTPUT truncates the result and stops further deltas", async () => {
    const deltas: Array<string> = []
    const result = await runBash("head -c 40000 </dev/zero | tr '\\0' a", (text) =>
      Effect.sync(() => deltas.push(text)),
    )
    const value = (result.result as { value: { stdout: string; truncated: boolean } }).value
    const joined = deltas.join("")
    expect(value.truncated).toBe(true)
    // Deltas stop at the cap: their concatenation is the un-annotated capped text.
    expect(joined.length).toBe(30_000)
    expect(value.stdout.startsWith(joined)).toBe(true)
  })

  test("deltas are emitted before tool-execution-end when driven through runTurn", async () => {
    const state = createSessionState({
      workingDirectory: dir,
      model,
      currentDate: "2026-07-04",
      permissionMode: "auto",
    })
    submitPrompt(state, "run it")
    const events: Array<AgentEvent> = []
    await Effect.runPromise(
      runTurn(state, { onEvent: (event) => Effect.sync(() => events.push(event)) }).pipe(
        Effect.provide(
          scriptedLLMClient([
            toolCallTurn("Bash", { command: "printf 'x\\ny\\n'" }),
            textTurn("done"),
          ]),
        ),
        Effect.provide(
          Layer.succeed(ToolContext, {
            session: state,
            abortSignal: new AbortController().signal,
            permission: makePermissions("auto", autoApproval),
          }),
        ),
        Effect.provide(toolRegistryLayer([Bash])),
        Effect.provide(BunContext.layer),
      ),
    )
    const delta = events.findIndex((e) => e.type === "tool-execution-delta")
    const end = events.findIndex((e) => e.type === "tool-execution-end")
    const start = events.findIndex((e) => e.type === "tool-execution-start")
    expect(start).toBeGreaterThanOrEqual(0)
    expect(delta).toBeGreaterThan(start)
    expect(delta).toBeLessThan(end)
  })
})
