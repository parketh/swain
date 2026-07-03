import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunContext } from "@effect/platform-bun"
import type { Model, ToolCall, ToolResultContent } from "@swain/llms"
import { ModelId, ProviderId, ToolCallId } from "@swain/llms"
import { Effect, Layer, Schema, Stream } from "effect"
import type { Approval, PermissionMode, PermissionRequest } from "../src/permission"
import { autoApproval, deny, makePermissions } from "../src/permission"
import { createSessionState, type SessionState } from "../src/state"
import { Bash, callTool, defineTool, isHardDenied, registryLayer, ToolContext } from "../src/tools"

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => Stream.empty,
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

describe("isHardDenied", () => {
  test("flags catastrophic commands", () => {
    expect(isHardDenied("rm -rf /")).toBe(true)
    expect(isHardDenied("sudo mkfs.ext4 /dev/sda")).toBe(true)
    expect(isHardDenied("echo hello")).toBe(false)
    expect(isHardDenied("rm notes.txt")).toBe(false)
  })
})

describe("Bash tool", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swain-bash-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const runBash = (
    command: string,
    mode: PermissionMode,
    approval = autoApproval,
  ): Promise<ToolResultContent> => {
    const state = createSessionState({
      workingDirectory: dir,
      model,
      permissionMode: mode,
      currentDate: "2026-07-04",
    })
    const toolCall: ToolCall = {
      type: "tool-call",
      toolCallId: ToolCallId.make("bash-1"),
      name: "Bash",
      input: { command },
    }
    return Effect.runPromise(
      callTool(toolCall).pipe(
        Effect.provide(
          Layer.succeed(ToolContext, {
            session: state,
            abortSignal: new AbortController().signal,
            permission: makePermissions(mode, approval),
          }),
        ),
        Effect.provide(registryLayer([Bash])),
        Effect.provide(BunContext.layer),
      ),
    )
  }

  test("safe command runs without asking in ask mode", async () => {
    const { approval, seen } = recordingApproval()
    const result = await runBash("echo hi", "ask", approval)
    expect(seen).toHaveLength(0)
    const value = (result.result as { value: { stdout: string; exitCode: number } }).value
    expect(value.exitCode).toBe(0)
    expect(value.stdout.trim()).toBe("hi")
  })

  test("risky command asks in ask mode and honors a denial", async () => {
    writeFileSync(join(dir, "x.txt"), "data")
    const { approval, seen } = recordingApproval()
    const result = await runBash("rm x.txt", "ask", approval)
    expect(seen).toHaveLength(1)
    expect(result.isError).toBe(true)
  })

  test("risky command runs in auto mode when not hard-denied", async () => {
    writeFileSync(join(dir, "x.txt"), "data")
    const result = await runBash("rm x.txt", "auto")
    const value = (result.result as { value: { exitCode: number } }).value
    expect(value.exitCode).toBe(0)
    expect(await Bun.file(join(dir, "x.txt")).exists()).toBe(false)
  })

  test("hard-denied command never runs, even in auto mode", async () => {
    const result = await runBash("mkfs.ext4 /dev/sda", "auto")
    expect(result.isError).toBe(true)
    expect((result.result as { value: string }).value).toContain("dangerous")
  })
})
