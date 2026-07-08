import { describe, expect, test } from "bun:test"
import type { Model } from "@swain/llms"
import { ModelId, ProviderId } from "@swain/llms"
import { Effect, Layer, Schema, Stream } from "effect"
import { createSessionState } from "../src/state"
import { getSubagentDefinition } from "../src/subagents/definitions"
import { makeChildToolRegistry } from "../src/subagents/tools"
import { type AnyTool, builtinTools, defineTool, makeToolRegistry, ToolContext } from "../src/tools"

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => Stream.empty,
}

const fakeAgent = defineTool({
  name: "Agent",
  description: "spawn",
  inputSchema: Schema.Struct({ prompt: Schema.String }),
  outputSchema: Schema.Struct({ ok: Schema.Boolean }),
  readOnly: false,
  call: () => Effect.succeed({ ok: true }),
})

const parentTools = makeToolRegistry([...builtinTools, fakeAgent as AnyTool])

const names = (registry: ReadonlyMap<string, AnyTool>): Array<string> => Array.from(registry.keys())

const contextLayer = Layer.succeed(ToolContext, {
  session: createSessionState({ workingDirectory: "/work", model, currentDate: "2026-07-04" }),
  abortSignal: new AbortController().signal,
  permission: { check: () => Effect.succeed({ type: "allow" as const }) },
})

describe("subagent definitions", () => {
  test("all three built-in types resolve", () => {
    expect(getSubagentDefinition("Explore").type).toBe("Explore")
    expect(getSubagentDefinition("Plan").type).toBe("Plan")
    expect(getSubagentDefinition("GeneralPurpose").type).toBe("GeneralPurpose")
  })
})

describe("makeChildToolRegistry", () => {
  test("no child registry includes Agent, Ask, or any Task* tool", () => {
    for (const type of ["Explore", "Plan", "GeneralPurpose"] as const) {
      const registry = makeChildToolRegistry(type, parentTools, { isolated: true })
      const forbidden = ["Agent", "Ask", "TaskCreate", "TaskList", "TaskGet", "TaskUpdate"]
      for (const name of forbidden) expect(registry.has(name)).toBe(false)
    }
  })

  test("Explore and Plan exclude Write/Edit and web tools and get read-only Bash", () => {
    for (const type of ["Explore", "Plan"] as const) {
      const registry = makeChildToolRegistry(type, parentTools)
      expect(registry.has("Write")).toBe(false)
      expect(registry.has("Edit")).toBe(false)
      expect(registry.has("WebSearch")).toBe(false)
      expect(registry.has("WebFetch")).toBe(false)
      expect(registry.get("Bash")?.readOnly).toBe(true)
      expect(names(registry).sort()).toEqual(["Bash", "Glob", "Grep", "Read"])
    }
  })

  test("read-only Bash denies mutating commands, including non-risky-listed ones", async () => {
    const registry = makeChildToolRegistry("Explore", parentTools)
    const bash = registry.get("Bash")!
    const mutating = [
      "rm -rf build",
      "touch marker.txt",
      "mkdir -p d",
      "cp a.txt b.txt",
      "git commit -m x",
      "echo hi > f.txt",
    ]
    for (const command of mutating) {
      const effect = bash
        .call({ command })
        .pipe(Effect.flip, Effect.provide(contextLayer)) as unknown as Effect.Effect<
        { reason: string },
        unknown,
        never
      >
      const result = await Effect.runPromise(effect)
      expect({ command, reason: result.reason }).toEqual({ command, reason: "denied" })
    }
  })

  test("GeneralPurpose gets mutating tools only with worktree isolation", () => {
    const isolated = makeChildToolRegistry("GeneralPurpose", parentTools, { isolated: true })
    expect(isolated.has("Write")).toBe(true)
    expect(isolated.has("Edit")).toBe(true)
    expect(isolated.get("Bash")?.readOnly).toBe(false)

    const confined = makeChildToolRegistry("GeneralPurpose", parentTools)
    expect(confined.has("Write")).toBe(false)
    expect(confined.has("Edit")).toBe(false)
    expect(confined.get("Bash")?.readOnly).toBe(true)
  })
})
