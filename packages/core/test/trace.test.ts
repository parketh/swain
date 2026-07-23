import { describe, expect, test } from "bun:test"
import type { Model } from "@swain/llms"
import { Message, ModelId, ProviderId } from "@swain/llms"
import { Stream } from "effect"
import { assembleSystemPrompt } from "../src/prompt"
import { createSessionState } from "../src/state"
import { projectTrace, TRACE_SCHEMA_VERSION } from "../src/trace"

const model: Model = {
  id: ModelId.make("claude-opus-4-8"),
  provider: ProviderId.make("anthropic"),
  streamTurn: () => Stream.empty,
}

const tools = [
  { name: "Read", description: "Read a file." },
  { name: "Bash", description: "Run a command." },
]

const session = () =>
  createSessionState({
    sessionId: "root-session",
    workingDirectory: "/work",
    model,
    modelRef: { provider: "anthropic", modelId: "claude-opus-4-8", variant: "high" },
    permissionMode: "auto",
    currentDate: "2026-07-22",
    messages: [
      Message.user("investigate", false, { createdAt: "2026-07-22T10:00:00.000Z" }),
      Message.assistant(
        [{ type: "text", text: "done" }],
        { createdAt: "2026-07-22T10:00:02.000Z", responseDurationMs: 200 },
        { inputTokens: 1000, outputTokens: 40 },
      ),
    ],
  })

describe("projectTrace", () => {
  test("produces schema v1 with exact identity, model, and metadata", () => {
    const state = session()
    state.counters.turns = 1
    state.counters.inputTokens = 1000
    state.counters.outputTokens = 40
    const trace = projectTrace({
      session: state,
      identity: { agentId: "root-agent", agentType: "root" },
      tools,
      swainVersion: "1.2.3",
      outcome: { status: "completed" },
      nonInteractive: true,
    })

    expect(trace.schemaVersion).toBe(TRACE_SCHEMA_VERSION)
    expect(trace.swainVersion).toBe("1.2.3")
    expect(trace.sessionId).toBe("root-session")
    expect(trace.agentId).toBe("root-agent")
    expect(trace.agentType).toBe("root")
    expect(trace.taskId).toBeUndefined()
    expect(trace.parentAgentId).toBeUndefined()
    expect(trace.model).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      variant: "high",
    })
    expect(trace.permissionMode).toBe("auto")
    expect(trace.workingDirectory).toBe("/work")
    expect(trace.counters).toEqual({ turns: 1, inputTokens: 1000, outputTokens: 40 })
    expect(trace.outcome).toEqual({ status: "completed" })
  })

  test("reassembles exactly the non-interactive system prompt the loop would build", () => {
    const state = session()
    const trace = projectTrace({
      session: state,
      identity: { agentId: "root-agent", agentType: "root" },
      tools,
      swainVersion: "1.2.3",
      outcome: { status: "completed" },
      nonInteractive: true,
    })
    const expected = assembleSystemPrompt({
      workingDirectory: "/work",
      currentDate: "2026-07-22",
      model: "claude-opus-4-8",
      permissionMode: "auto",
      tools,
      nonInteractive: true,
    })
    expect(trace.systemPrompt).toBe(expected)
  })

  test("carries committed messages verbatim, including reasoning and usage", () => {
    const state = session()
    const trace = projectTrace({
      session: state,
      identity: {
        agentId: "child-agent",
        agentType: "Explore",
        taskId: "t-1",
        parentAgentId: "root-agent",
      },
      tools,
      swainVersion: "1.2.3",
      outcome: { status: "failed", error: "boom" },
    })
    expect(trace.taskId).toBe("t-1")
    expect(trace.parentAgentId).toBe("root-agent")
    expect(trace.agentType).toBe("Explore")
    expect(trace.messages).toEqual(state.messages)
    const assistant = trace.messages[1]
    expect((assistant as { usage?: unknown }).usage).toEqual({
      inputTokens: 1000,
      outputTokens: 40,
    })
    expect(trace.outcome).toEqual({ status: "failed", error: "boom" })
  })

  test("serializes to JSON without model functions, locks, or file caches", () => {
    const state = session()
    const trace = projectTrace({
      session: state,
      identity: { agentId: "root-agent", agentType: "root" },
      tools,
      swainVersion: "1.2.3",
      outcome: { status: "completed" },
    })
    const roundTrip = JSON.parse(JSON.stringify(trace))
    expect(roundTrip.sessionId).toBe("root-session")
    // None of the non-serializable SessionState fields leak into the trace.
    expect(Object.keys(roundTrip)).not.toContain("locks")
    expect(Object.keys(roundTrip)).not.toContain("fileState")
    expect(Object.keys(roundTrip.model)).not.toContain("streamTurn")
  })
})
