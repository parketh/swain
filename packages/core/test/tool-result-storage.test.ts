import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { BunContext } from "@effect/platform-bun"
import type { Model, ToolResultContent } from "@swain/llms"
import { ModelId, ProviderId, ToolCallId } from "@swain/llms"
import { Effect, Layer, Schema, Stream } from "effect"
import { runTurn, submitPrompt } from "../src/agent"
import {
  TOOL_RESULT_PREVIEW_CHARS,
  TOOL_RESULT_THRESHOLD,
  ToolResultStoreService,
  toolResultStoreLayer,
} from "../src/context"
import type { Permissions } from "../src/permission"
import { createSessionState, type SessionState } from "../src/state"
import { defineTool, ToolContext, toolRegistryLayer } from "../src/tools"
import { textTurn, toolCallTurn } from "./utils/fixtures"
import { createTempDir, removeTempDir, scriptedLLMClient } from "./utils/harness"

const allowPermissions: Permissions = { check: () => Effect.succeed({ type: "allow" }) }

const toolContextLayer = (state: SessionState) =>
  Layer.succeed(ToolContext, {
    session: state,
    abortSignal: new AbortController().signal,
    permission: allowPermissions,
  })

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => Stream.empty,
}

const session = (): SessionState =>
  createSessionState({ workingDirectory: "/work", model, currentDate: "2026-07-13" })

const textResult = (value: string): ToolResultContent => ({
  type: "tool-result",
  toolCallId: ToolCallId.make("call-1"),
  name: "Bash",
  result: { type: "text", value },
})

const jsonResult = (value: unknown): ToolResultContent => ({
  type: "tool-result",
  toolCallId: ToolCallId.make("call-2"),
  name: "Read",
  result: { type: "json", value },
})

const persist = (dir: string, state: SessionState, result: ToolResultContent) =>
  Effect.runPromise(
    Effect.flatMap(ToolResultStoreService, (s) => s.persist(state, result)).pipe(
      Effect.provide(toolResultStoreLayer(dir)),
      Effect.provide(BunContext.layer),
    ),
  )

const big = "x".repeat(TOOL_RESULT_THRESHOLD + 100)

describe("toolResultStore", () => {
  test("persists an oversized text body and replaces it with a preview", async () => {
    const dir = createTempDir()
    try {
      const state = session()
      const replaced = await persist(dir, state, textResult(big))
      expect(replaced.result.type).toBe("text")
      const value = replaced.result.type === "text" ? replaced.result.value : ""
      expect(value).toContain("Output too large")
      expect(value).toContain(big.slice(0, TOOL_RESULT_PREVIEW_CHARS))
      expect(value.length).toBeLessThan(big.length)

      const path = join(dir, "call-1.txt")
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path, "utf8")).toBe(big)

      expect(state.toolResults).toHaveLength(1)
      expect(state.toolResults[0]).toMatchObject({
        toolCallId: "call-1",
        name: "Bash",
        path,
        originalBytes: big.length,
      })
    } finally {
      removeTempDir(dir)
    }
  })

  test("persists an oversized JSON body to a .json file", async () => {
    const dir = createTempDir()
    try {
      const state = session()
      const value = { blob: big }
      const replaced = await persist(dir, state, jsonResult(value))
      const path = join(dir, "call-2.json")
      expect(existsSync(path)).toBe(true)
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(value)
      expect(replaced.result.type).toBe("text")
    } finally {
      removeTempDir(dir)
    }
  })

  test("leaves a small result unchanged", async () => {
    const dir = createTempDir()
    try {
      const state = session()
      const result = textResult("small output")
      const replaced = await persist(dir, state, result)
      expect(replaced).toBe(result)
      expect(state.toolResults).toHaveLength(0)
      expect(existsSync(join(dir, "call-1.txt"))).toBe(false)
    } finally {
      removeTempDir(dir)
    }
  })

  test("re-persisting the same tool call does not duplicate the record", async () => {
    const dir = createTempDir()
    try {
      const state = session()
      await persist(dir, state, textResult(big))
      await persist(dir, state, textResult(big))
      expect(state.toolResults).toHaveLength(1)
    } finally {
      removeTempDir(dir)
    }
  })
})

describe("runTurn tool-result persistence", () => {
  const huge = defineTool({
    name: "Huge",
    description: "returns a huge blob",
    inputSchema: Schema.Struct({}),
    outputSchema: Schema.Struct({ blob: Schema.String }),
    readOnly: true,
    call: () => Effect.succeed({ blob: big }),
  })

  test("an oversized tool result is persisted before entering the transcript", async () => {
    const dir = createTempDir()
    try {
      const state = session()
      submitPrompt(state, "go")
      await Effect.runPromise(
        runTurn(state).pipe(
          Effect.provide(scriptedLLMClient([toolCallTurn("Huge", {}), textTurn("done")])),
          Effect.provide(toolContextLayer(state)),
          Effect.provide(toolRegistryLayer([huge])),
          Effect.provide(toolResultStoreLayer(dir)),
          Effect.provide(BunContext.layer),
        ),
      )
      // messages: user, assistant(tool-call), user(tool-result), assistant(final)
      const toolResultMsg = state.messages[2]
      const block = toolResultMsg?.content[0]
      expect(block?.type).toBe("tool-result")
      if (block?.type === "tool-result" && block.result.type === "text") {
        expect(block.result.value).toContain("Output too large")
        expect(block.result.value.length).toBeLessThan(big.length)
      }
      expect(state.toolResults).toHaveLength(1)
    } finally {
      removeTempDir(dir)
    }
  })
})
