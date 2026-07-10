import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunContext } from "@effect/platform-bun"
import type { Model, ToolCall, ToolResultContent } from "@swain/llms"
import { ModelId, ProviderId, ToolCallId } from "@swain/llms"
import { Effect, Layer, Queue, Stream } from "effect"
import {
  ModelResolveError,
  type ModelResolver,
  ModelResolverService,
  type ResolvedModel,
} from "../src/model-resolver"
import { type ChildRunner, makeOrchestrator, OrchestratorService } from "../src/orchestrator"
import type { Permissions } from "../src/permission"
import { createSessionState, type SessionState } from "../src/state"
import { taskStoreLayer } from "../src/tasks"
import { builtinTools, callTool, ToolContext, toolRegistryLayer } from "../src/tools"
import { scriptedLLMClient } from "./utils/harness"

const makeModel = (id: string, provider: string): Model => ({
  id: ModelId.make(id),
  provider: ProviderId.make(provider),
  streamTurn: () => Stream.empty,
})

const parentModel = makeModel("test-model", "test")
const deepseek = makeModel("deepseek-v4-pro", "deepseek")

const allowPermissions: Permissions = { check: () => Effect.succeed({ type: "allow" }) }

const agentCall = (input: unknown): ToolCall => ({
  type: "tool-call",
  toolCallId: ToolCallId.make("call-1"),
  name: "Agent",
  input,
})

// biome-ignore lint/suspicious/noExplicitAny: opaque tool-result JSON
const value = (result: { result: { value?: unknown } }): any => result.result.value

const resolverLayer = (): Layer.Layer<ModelResolverService> => {
  const impl: ModelResolver = {
    resolve: (targetId) => {
      if (targetId === "deepseek:deepseek-v4-pro:max") {
        const resolved: ResolvedModel = {
          model: deepseek,
          requestOptions: { providerOptions: { deepseek: { thinking: true } } },
          modelRef: { provider: "deepseek", modelId: "deepseek-v4-pro", variant: "max" },
        }
        return Effect.succeed(resolved)
      }
      if (targetId === "other:x") {
        return Effect.fail(
          new ModelResolveError({ reason: "not-enabled", targetId, message: "not enabled" }),
        )
      }
      return Effect.fail(
        new ModelResolveError({ reason: "unknown-target", targetId, message: "unknown" }),
      )
    },
  }
  return Layer.succeed(ModelResolverService, impl)
}

describe("Agent.model override", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "swain-agent-model-"))
    execSync("git init -q", { cwd: repo })
    execSync("git config user.email t@t.com && git config user.name t", { cwd: repo })
    writeFileSync(join(repo, "seed.txt"), "seed\n")
    execSync("git add -A && git commit -q -m init", { cwd: repo })
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  const parentSession = (): SessionState =>
    createSessionState({
      workingDirectory: repo,
      model: parentModel,
      requestOptions: { generation: { maxTokens: 5 } },
      currentDate: "2026-07-10",
    })

  // Runs the Agent tool, capturing the spawned child's session for assertions.
  const spawnWith = async (input: unknown, session: SessionState) => {
    let captured: SessionState | undefined
    const runner: ChildRunner = (ctx) => {
      captured = ctx.session
      return Effect.succeed("done")
    }
    const layers = Layer.mergeAll(
      taskStoreLayer(repo).pipe(Layer.provideMerge(BunContext.layer)),
      scriptedLLMClient([]),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const orch = yield* makeOrchestrator({ runChild: runner })
        const spawned = yield* callTool(agentCall(input)).pipe(
          Effect.provideService(OrchestratorService, orch),
          Effect.provide(
            Layer.succeed(ToolContext, {
              session,
              abortSignal: new AbortController().signal,
              permission: allowPermissions,
            }),
          ),
          Effect.provide(toolRegistryLayer(builtinTools)),
          Effect.provide(resolverLayer()),
        )
        // Only a successful spawn produces a completion; errors spawn nothing.
        if (spawned.isError !== true) yield* Queue.take(orch.completions)
        return spawned
      }).pipe(Effect.provide(layers)) as Effect.Effect<ToolResultContent, unknown, never>,
    )
    return { result, captured }
  }

  test("an explicit target creates the child on that model and model ref", async () => {
    const { result, captured } = await spawnWith(
      { description: "probe", prompt: "look", model: "deepseek:deepseek-v4-pro:max" },
      parentSession(),
    )
    expect(value(result).status).toBe("spawned")
    expect(captured?.systemContext.model.id as string).toBe("deepseek-v4-pro")
    expect(captured?.systemContext.modelRef).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      variant: "max",
    })
    expect(captured?.systemContext.requestOptions).toEqual({
      providerOptions: { deepseek: { thinking: true } },
    })
  })

  test("omitting model inherits the parent's current model and options", async () => {
    const { captured } = await spawnWith({ description: "probe", prompt: "look" }, parentSession())
    expect(captured?.systemContext.model).toBe(parentModel)
    expect(captured?.systemContext.modelRef).toEqual({ provider: "test", modelId: "test-model" })
    expect(captured?.systemContext.requestOptions).toEqual({ generation: { maxTokens: 5 } })
  })

  test("an unknown target returns a recoverable Agent error", async () => {
    const { result } = await spawnWith(
      { description: "probe", prompt: "look", model: "bad:target" },
      parentSession(),
    )
    expect(result.isError).toBe(true)
  })

  test("with routing inactive, only the current model is accepted", async () => {
    // The current model itself is accepted (inherits, no resolver call).
    const current = await spawnWith(
      { description: "probe", prompt: "look", model: "test:test-model" },
      parentSession(),
    )
    expect(value(current.result).status).toBe("spawned")
    expect(current.captured?.systemContext.model).toBe(parentModel)

    // A different target that the resolver reports not-enabled is rejected.
    const other = await spawnWith(
      { description: "probe", prompt: "look", model: "other:x" },
      parentSession(),
    )
    expect(other.result.isError).toBe(true)
  })
})
