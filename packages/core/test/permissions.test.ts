import { describe, expect, test } from "bun:test"
import type { Model, ToolCall } from "@swain/llms"
import { ModelId, ProviderId, ToolCallId } from "@swain/llms"
import { Effect, Layer, Schema } from "effect"
import type { Approval, PermissionRequest } from "../src/permission"
import { autoApproval, deny, makePermissions } from "../src/permission"
import { createSessionState, type SessionState } from "../src/state"
import { callTool, defineTool, registryLayer, ToolContext } from "../src/tools"

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => Effect.die("unused") as never,
}

const request = (readOnly: boolean): PermissionRequest => ({
  toolName: "Edit",
  readOnly,
  summary: "edit a file",
})

const recordingApproval = () => {
  const seen: Array<PermissionRequest> = []
  const approval: Approval = {
    requestApproval: (req) => {
      seen.push(req)
      return Effect.succeed(deny("nope"))
    },
  }
  return { approval, seen }
}

describe("makePermissions", () => {
  test("plan mode denies mutating tools and allows read-only", async () => {
    const permissions = makePermissions("plan", autoApproval)
    expect(await Effect.runPromise(permissions.check(request(false)))).toEqual({
      type: "deny",
      reason: expect.any(String),
    })
    expect(await Effect.runPromise(permissions.check(request(true)))).toEqual({ type: "allow" })
  })

  test("ask mode asks for mutating tools and skips the ask for read-only", async () => {
    const { approval, seen } = recordingApproval()
    const permissions = makePermissions("ask", approval)

    const decision = await Effect.runPromise(permissions.check(request(false)))
    expect(seen).toHaveLength(1)
    expect(decision).toEqual({ type: "deny", reason: "nope" })

    await Effect.runPromise(permissions.check(request(true)))
    expect(seen).toHaveLength(1)
  })

  test("auto mode allows without consulting approval", async () => {
    const { approval, seen } = recordingApproval()
    const permissions = makePermissions("auto", approval)
    expect(await Effect.runPromise(permissions.check(request(false)))).toEqual({ type: "allow" })
    expect(seen).toHaveLength(0)
  })
})

describe("callTool coarse gate", () => {
  const mutating = defineTool({
    name: "Mutate",
    description: "mutating tool",
    inputSchema: Schema.Struct({ value: Schema.Number }),
    outputSchema: Schema.Struct({ ok: Schema.Boolean }),
    readOnly: false,
    call: () => Effect.succeed({ ok: true }),
  })

  const layer = (state: SessionState) =>
    Layer.succeed(ToolContext, {
      session: state,
      abortSignal: new AbortController().signal,
      permission: makePermissions(state.systemContext.permissionMode, autoApproval),
    })

  const call: ToolCall = {
    type: "tool-call",
    toolCallId: ToolCallId.make("call-1"),
    name: "Mutate",
    input: { value: 1 },
  }

  const run = (mode: "plan" | "auto") => {
    const state = createSessionState({
      workingDirectory: "/work",
      model,
      permissionMode: mode,
      currentDate: "2026-07-04",
    })
    return Effect.runPromise(
      callTool(call).pipe(Effect.provide(layer(state)), Effect.provide(registryLayer([mutating]))),
    )
  }

  test("plan mode blocks a mutating tool before it runs", async () => {
    const result = await run("plan")
    expect(result.isError).toBe(true)
  })

  test("auto mode lets a mutating tool run after validation", async () => {
    const result = await run("auto")
    expect(result.isError).toBeUndefined()
    expect(result.result).toEqual({ type: "json", value: { ok: true } })
  })
})
