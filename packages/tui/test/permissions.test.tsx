import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createSessionState,
  makePermissions,
  type PermissionDecision,
  type PermissionRequest,
} from "@swain/core"
import type { LLMEvent, Model } from "@swain/llms"
import { ContentId, ModelId, ProviderId, ToolCallId } from "@swain/llms"
import { LLMClient } from "@swain/llms/client"
import { Effect, Layer, Stream } from "effect"
import { render } from "ink-testing-library"
import { App } from "../src/app"
import { PermissionPrompt } from "../src/components/PermissionPrompt"
import type { TuiConfig } from "../src/config"
import { type Controller, makeController } from "../src/controller"

const flush = () => new Promise((resolve) => setTimeout(resolve, 30))
const DOWN = "[B"
const ESC = ""

const testModel: Model = {
  id: ModelId.make("claude-sonnet-4-5"),
  provider: ProviderId.make("anthropic"),
  streamTurn: () => Stream.empty,
}
const contentId = ContentId.make("c-1")
const config: TuiConfig = { providers: { anthropic: { apiKey: "sk-test" } } }

const textTurn = (text: string): ReadonlyArray<LLMEvent> => [
  { type: "text-start", contentId },
  { type: "text-delta", contentId, text },
  { type: "text-end", contentId },
  { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
]

const bashTurn = (command: string): ReadonlyArray<LLMEvent> => {
  const id = ToolCallId.make("call-1")
  return [
    { type: "tool-input-start", toolCallId: id, name: "Bash" },
    { type: "tool-input-end", toolCallId: id, name: "Bash" },
    { type: "tool-call", toolCallId: id, name: "Bash", input: { command } },
    { type: "finish", reason: "tool-call", usage: { inputTokens: 1, outputTokens: 1 } },
  ]
}

const scripted = (turns: ReadonlyArray<ReadonlyArray<LLMEvent>>) => {
  let index = 0
  return Layer.succeed(LLMClient.Service, {
    request: LLMClient.request,
    streamTurn: () => Stream.fromIterable(turns[Math.min(index++, turns.length - 1)] ?? []),
    generateTurn: () => Effect.succeed({ events: [...(turns[0] ?? [])] }),
  })
}

const mutatingRequest: PermissionRequest = {
  toolName: "Write",
  readOnly: false,
  summary: "Write to ../outside/config.json",
  command: undefined,
}

describe("PermissionPrompt", () => {
  test("renders request context and allows on Enter", async () => {
    let decision: PermissionDecision | undefined
    const { lastFrame, stdin } = render(
      <PermissionPrompt
        request={{ toolName: "Bash", readOnly: false, summary: "Run: rm x", command: "rm x" }}
        onDecision={(d) => {
          decision = d
        }}
      />,
    )
    expect(lastFrame()).toContain("Bash")
    expect(lastFrame()).toContain("rm x")
    stdin.write("\r")
    await flush()
    expect(decision).toEqual({ type: "allow" })
  })

  test("Down then Enter denies with a user-visible reason", async () => {
    let decision: PermissionDecision | undefined
    const { stdin } = render(
      <PermissionPrompt request={mutatingRequest} onDecision={(d) => (decision = d)} />,
    )
    stdin.write(DOWN)
    await flush()
    stdin.write("\r")
    await flush()
    expect(decision?.type).toBe("deny")
    if (decision?.type === "deny") expect(decision.reason.length).toBeGreaterThan(0)
  })

  test("Esc denies the request", async () => {
    let decision: PermissionDecision | undefined
    const { stdin } = render(
      <PermissionPrompt request={mutatingRequest} onDecision={(d) => (decision = d)} />,
    )
    stdin.write(ESC)
    await flush()
    expect(decision?.type).toBe("deny")
  })

  test("an outside-working-directory write request renders the approval prompt", () => {
    const { lastFrame } = render(
      <PermissionPrompt request={mutatingRequest} onDecision={() => {}} />,
    )
    expect(lastFrame()).toContain("Permission required")
    expect(lastFrame()).toContain("../outside/config.json")
  })
})

describe("permission gate", () => {
  const record = () => {
    const seen: Array<PermissionRequest> = []
    return {
      seen,
      approval: {
        requestApproval: (request: PermissionRequest) => {
          seen.push(request)
          return Effect.succeed<PermissionDecision>({ type: "allow" })
        },
      },
    }
  }

  test("ask mode routes an outside-cwd write to the approval prompt", async () => {
    const { approval, seen } = record()
    await Effect.runPromise(makePermissions("ask", approval).check(mutatingRequest))
    expect(seen).toHaveLength(1)
  })

  test("auto mode allows an outside-cwd write without prompting", async () => {
    const { approval, seen } = record()
    const decision = await Effect.runPromise(
      makePermissions("auto", approval).check(mutatingRequest),
    )
    expect(seen).toHaveLength(0)
    expect(decision.type).toBe("allow")
  })
})

describe("App approval integration", () => {
  let dir: string
  let controller: Controller
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swain-perm-"))
  })
  afterEach(() => {
    controller?.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const makeCtrl = (
    turns: ReadonlyArray<ReadonlyArray<LLMEvent>>,
    permissionMode: "ask" | "auto" | "plan",
  ): Controller => {
    const session = createSessionState({
      workingDirectory: dir,
      model: testModel,
      permissionMode,
      currentDate: "2026-07-05",
    })
    controller = makeController({
      session,
      activeModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      config,
      configPath: join(dir, "config.json"),
      llmLayer: scripted(turns),
      persist: false,
    })
    return controller
  }

  test("ask mode opens the modal and resumes the tool on Yes", async () => {
    const c = makeCtrl([bashTurn("rm nope.txt"), textTurn("done")], "ask")
    const { stdin, lastFrame } = render(<App controller={c} />)
    const turn = c.submitPrompt("go")
    await flush()
    expect(lastFrame()).toContain("Permission required")
    stdin.write("\r") // Yes
    await turn
    expect(c.getState().session.messages.at(-1)).toMatchObject({ role: "assistant" })
  })

  test("auto mode never opens the modal", async () => {
    const c = makeCtrl([bashTurn("rm nope.txt"), textTurn("done")], "auto")
    const { lastFrame } = render(<App controller={c} />)
    await c.submitPrompt("go")
    await flush()
    expect(lastFrame()).not.toContain("Permission required")
  })

  test("plan mode denies the mutating tool before any modal", async () => {
    const c = makeCtrl([bashTurn("rm nope.txt"), textTurn("done")], "plan")
    const { lastFrame } = render(<App controller={c} />)
    await c.submitPrompt("go")
    await flush()
    expect(lastFrame()).not.toContain("Permission required")
    expect(c.getState().session.messages.at(-1)).toMatchObject({ role: "assistant" })
  })
})
