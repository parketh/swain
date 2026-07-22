import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildTraceEvent, SessionState } from "@swain/core"
import { createSessionState } from "@swain/core"
import type { Model } from "@swain/llms"
import { Message, ModelId, ProviderId } from "@swain/llms"
import { Stream } from "effect"
import { initTraceRecorder } from "../src/exec-trace"

const model: Model = {
  id: ModelId.make("claude-opus-4-8"),
  provider: ProviderId.make("anthropic"),
  streamTurn: () => Stream.empty,
}

const childSession = (agentId: string): SessionState =>
  createSessionState({
    sessionId: `root:${agentId}`,
    workingDirectory: "/work",
    model,
    modelRef: { provider: "anthropic", modelId: "claude-opus-4-8" },
    permissionMode: "auto",
    currentDate: "2026-07-22",
    messages: [
      Message.user("child brief"),
      Message.assistant([{ type: "text", text: "child result" }]),
    ],
  })

const childEvent = (agentId: string, ok: boolean): ChildTraceEvent => ({
  session: childSession(agentId),
  agentId,
  taskId: `task-${agentId}`,
  agentType: "Explore",
  tools: [{ name: "Read", description: "Read a file." }],
  outcome: ok ? { ok: true } : { ok: false, error: "child failed" },
})

const rootSession = (): SessionState =>
  createSessionState({
    sessionId: "root",
    workingDirectory: "/work",
    model,
    modelRef: { provider: "anthropic", modelId: "claude-opus-4-8" },
    permissionMode: "auto",
    currentDate: "2026-07-22",
    messages: [Message.user("root prompt"), Message.assistant([{ type: "text", text: "done" }])],
  })

const read = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"))

describe("initTraceRecorder", () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "swain-trace-"))
  })
  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  test("creates the trace and subagents directories eagerly", async () => {
    const dir = join(base, "logs")
    await initTraceRecorder({ dir, swainVersion: "1.0.0", rootAgentId: "root" })
    expect(existsSync(join(dir, "subagents"))).toBe(true)
  })

  test("throws when the requested path is unwritable", async () => {
    const filePath = join(base, "a-file")
    writeFileSync(filePath, "x")
    // A file in the parent chain makes mkdir fail (ENOTDIR).
    await expect(
      initTraceRecorder({
        dir: join(filePath, "logs"),
        swainVersion: "1.0.0",
        rootAgentId: "root",
      }),
    ).rejects.toThrow()
  })

  test("writes each child snapshot, then root and manifest linking them", async () => {
    const dir = join(base, "logs")
    const recorder = await initTraceRecorder({
      dir,
      swainVersion: "1.0.0",
      rootAgentId: "root",
      nonInteractive: true,
    })
    await recorder.recordChild(childEvent("agent-a", true))
    await recorder.recordChild(childEvent("agent-b", false))
    await recorder.finalizeRoot({
      session: rootSession(),
      tools: [{ name: "Read", description: "Read a file." }],
      outcome: { status: "completed" },
    })
    expect(recorder.firstError()).toBeUndefined()

    const childA = read(dir, "subagents/agent-a.json")
    expect(childA.schemaVersion).toBe(1)
    expect(childA.agentId).toBe("agent-a")
    expect(childA.taskId).toBe("task-agent-a")
    expect(childA.parentAgentId).toBe("root")
    expect(childA.agentType).toBe("Explore")
    expect(childA.outcome).toEqual({ status: "completed" })

    const childB = read(dir, "subagents/agent-b.json")
    expect(childB.outcome).toEqual({ status: "failed", error: "child failed" })

    const root = read(dir, "root.json")
    expect(root.agentId).toBe("root")
    expect(root.agentType).toBe("root")
    expect(root.outcome).toEqual({ status: "completed" })

    const manifest = read(dir, "manifest.json")
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.rootAgentId).toBe("root")
    expect(manifest.root).toBe("root.json")
    expect(manifest.children).toEqual([
      { agentId: "agent-a", taskId: "task-agent-a", file: "subagents/agent-a.json" },
      { agentId: "agent-b", taskId: "task-agent-b", file: "subagents/agent-b.json" },
    ])
  })

  test("leaves no temporary files behind after atomic writes", async () => {
    const dir = join(base, "logs")
    const recorder = await initTraceRecorder({ dir, swainVersion: "1.0.0", rootAgentId: "root" })
    await recorder.recordChild(childEvent("agent-a", true))
    await recorder.finalizeRoot({
      session: rootSession(),
      tools: [],
      outcome: { status: "completed" },
    })
    const top = readdirSync(dir)
    const nested = readdirSync(join(dir, "subagents"))
    expect(top.some((f) => f.endsWith(".tmp"))).toBe(false)
    expect(nested.some((f) => f.endsWith(".tmp"))).toBe(false)
  })
})
