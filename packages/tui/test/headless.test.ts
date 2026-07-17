import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMEvent, LLMRequest } from "@swain/llms"
import { ContentId, LLMError, ToolCallId } from "@swain/llms"
import { LLMClient } from "@swain/llms/client"
import { Effect, Layer, Stream } from "effect"
import type { HeadlessOptions } from "../src/cli"
import { runHeadless } from "../src/headless"

const contentId = ContentId.make("c-1")

const textTurn = (text: string): ReadonlyArray<LLMEvent> => [
  { type: "text-start", contentId },
  { type: "text-delta", contentId, text },
  { type: "text-end", contentId },
  { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
]

const toolCallTurn = (name: string, input: unknown): ReadonlyArray<LLMEvent> => {
  const id = ToolCallId.make("call-1")
  return [
    { type: "tool-input-start", toolCallId: id, name },
    { type: "tool-input-end", toolCallId: id, name },
    { type: "tool-call", toolCallId: id, name, input },
    { type: "finish", reason: "tool-call", usage: { inputTokens: 1, outputTokens: 1 } },
  ]
}

const scripted = (turns: ReadonlyArray<ReadonlyArray<LLMEvent>>) => {
  const requests: Array<LLMRequest> = []
  let index = 0
  const next = (): ReadonlyArray<LLMEvent> => turns[Math.min(index++, turns.length - 1)] ?? []
  const layer = Layer.succeed(LLMClient.Service, {
    request: LLMClient.request,
    streamTurn: (request: LLMRequest) => {
      requests.push(request)
      return Stream.fromIterable(next())
    },
    generateTurn: (request: LLMRequest) => {
      requests.push(request)
      return Effect.succeed({ events: [...next()] })
    },
  })
  return { layer, requests }
}

const waitFor = async (predicate: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("runHeadless", () => {
  let configDir: string
  let swainDir: string
  let cwd: string
  let out: string
  let err: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "swain-exec-cfg-"))
    swainDir = join(configDir, "swain")
    mkdirSync(swainDir, { recursive: true })
    cwd = mkdtempSync(join(tmpdir(), "swain-exec-cwd-"))
    out = ""
    err = ""
  })
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  const seedAuth = (): void =>
    writeFileSync(join(swainDir, "auth.json"), JSON.stringify({ anthropic: { apiKey: "sk-test" } }))

  const options = (prompt: string, extra: Partial<HeadlessOptions> = {}): HeadlessOptions => ({
    permissionMode: "auto",
    model: { provider: "anthropic", modelId: "claude-opus-4-8" },
    router: false,
    prompt,
    // Isolate HOME so no real ~/.codex or ~/.config leaks in.
    env: { HOME: configDir, XDG_CONFIG_HOME: configDir },
    cwd,
    stdout: (t) => {
      out += t
    },
    stderr: (t) => {
      err += t
    },
    ...extra,
  })

  test("a successful turn emits only the final text and a newline, nothing to stderr", async () => {
    seedAuth()
    const code = await runHeadless(options("summarize"), {
      llmLayer: scripted([textTurn("the summary")]).layer,
    })
    expect(code).toBe(0)
    expect(out).toBe("the summary\n")
    expect(err).toBe("")
  })

  test("a tool-call turn followed by a final turn prints only the final turn", async () => {
    seedAuth()
    const llm = scripted([toolCallTurn("Read", { path: "x" }), textTurn("final only")])
    const code = await runHeadless(options("read then answer"), { llmLayer: llm.layer })
    expect(code).toBe(0)
    expect(out).toBe("final only\n")
  })

  test("Ask is absent from the tool set and the non-interactive instruction reaches the model", async () => {
    seedAuth()
    const llm = scripted([textTurn("ok")])
    await runHeadless(options("go"), { llmLayer: llm.layer })
    const request = llm.requests[0]
    const names = (request?.tools ?? []).map((t) => t.name)
    expect(names).not.toContain("Ask")
    expect(JSON.stringify(request?.system)).toContain("running non-interactively")
  })

  test("the resolved prompt reaches the model verbatim, including newlines", async () => {
    seedAuth()
    const llm = scripted([textTurn("ok")])
    await runHeadless(options("line one\nline two\n"), { llmLayer: llm.layer })
    expect(JSON.stringify(llm.requests[0]?.messages)).toContain("line one\\nline two\\n")
  })

  test("an unconfigured model produces no stdout and exits 1", async () => {
    // No auth.json seeded: the anthropic provider is not configured.
    const code = await runHeadless(options("go"), { llmLayer: scripted([textTurn("x")]).layer })
    expect(code).toBe(1)
    expect(out).toBe("")
    expect(err.length).toBeGreaterThan(0)
  })

  test("a fatal LLM failure produces no stdout and exits 1", async () => {
    seedAuth()
    const layer = Layer.succeed(LLMClient.Service, {
      request: LLMClient.request,
      streamTurn: () =>
        Stream.fail(
          new LLMError({ reason: "server-error", message: "upstream boom", retryable: false }),
        ),
      generateTurn: () =>
        Effect.fail(
          new LLMError({ reason: "server-error", message: "upstream boom", retryable: false }),
        ),
    })
    const code = await runHeadless(options("go"), { llmLayer: layer })
    expect(code).toBe(1)
    expect(out).toBe("")
    expect(err).toContain("upstream boom")
  })

  test("a detached subagent completes and informs the parent's final response before stdout", async () => {
    seedAuth()
    const spawn = toolCallTurn("Agent", {
      description: "probe",
      prompt: "look",
      subagentType: "Explore",
    })
    let parentCalls = 0
    const layer = Layer.succeed(LLMClient.Service, {
      request: LLMClient.request,
      streamTurn: (req: LLMRequest) => {
        if (JSON.stringify(req.messages).includes("## Assignment:"))
          return Stream.fromIterable(textTurn("child findings"))
        parentCalls += 1
        return Stream.fromIterable(
          parentCalls === 1
            ? spawn
            : parentCalls === 2
              ? textTurn("waiting")
              : textTurn("done using the subagent"),
        )
      },
      generateTurn: () => Effect.succeed({ events: [] }),
    })
    const code = await runHeadless(options("delegate"), { llmLayer: layer })
    expect(code).toBe(0)
    expect(out).toBe("done using the subagent\n")
  })

  test("leaves no resumable session under the real config directory and removes the temp root", async () => {
    seedAuth()
    await runHeadless(options("go"), { llmLayer: scripted([textTurn("ok")]).layer })
    expect(existsSync(join(swainDir, "sessions"))).toBe(false)
    // No leftover exec temp directories.
    const leftovers = existsSync(tmpdir())
      ? require("node:fs")
          .readdirSync(tmpdir())
          .filter(
            (name: string) =>
              name.startsWith("swain-exec-") && !name.includes("cfg") && !name.includes("cwd"),
          )
      : []
    expect(leftovers).toHaveLength(0)
  })

  test("with routing off (default) the request carries no router block; --router restores it", async () => {
    // Two configured providers with a saved, enabled router yields routable targets.
    writeFileSync(
      join(swainDir, "auth.json"),
      JSON.stringify({ anthropic: { apiKey: "sk-a" }, deepseek: { apiKey: "sk-d" } }),
    )
    writeFileSync(
      join(swainDir, "config.json"),
      JSON.stringify({ router: { enabled: true, disabledModels: [], disabledTargets: [] } }),
    )
    const off = scripted([textTurn("ok")])
    await runHeadless(options("go"), { llmLayer: off.layer })
    expect(JSON.stringify(off.requests[0]?.system)).not.toContain("Routable model targets")

    const on = scripted([textTurn("ok")])
    await runHeadless(options("go", { router: true }), { llmLayer: on.layer })
    expect(JSON.stringify(on.requests[0]?.system)).toContain("Routable model targets")

    // Neither run rewrote the saved router configuration.
    const saved = JSON.parse(require("node:fs").readFileSync(join(swainDir, "config.json"), "utf8"))
    expect(saved.router.enabled).toBe(true)
  })

  test("invoking the SIGINT handler returns 130 with no stdout", async () => {
    seedAuth()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const layer = Layer.succeed(LLMClient.Service, {
      request: LLMClient.request,
      streamTurn: () =>
        Stream.unwrap(
          Effect.promise(() => gate).pipe(Effect.as(Stream.fromIterable(textTurn("late")))),
        ),
      generateTurn: () => Effect.succeed({ events: [] }),
    })
    const before = process.listeners("SIGINT").length
    const run = runHeadless(options("go"), { llmLayer: layer })
    await waitFor(() => process.listeners("SIGINT").length > before)
    // Invoke the registered handler directly rather than killing the process.
    const handler = process.listeners("SIGINT").at(-1) as () => void
    handler()
    const code = await run
    expect(code).toBe(130)
    expect(out).toBe("")
    release()
  })

  test("invoking the SIGTERM handler returns 143", async () => {
    seedAuth()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const layer = Layer.succeed(LLMClient.Service, {
      request: LLMClient.request,
      streamTurn: () =>
        Stream.unwrap(
          Effect.promise(() => gate).pipe(Effect.as(Stream.fromIterable(textTurn("late")))),
        ),
      generateTurn: () => Effect.succeed({ events: [] }),
    })
    const before = process.listeners("SIGTERM").length
    const run = runHeadless(options("go"), { llmLayer: layer })
    await waitFor(() => process.listeners("SIGTERM").length > before)
    const handler = process.listeners("SIGTERM").at(-1) as () => void
    handler()
    expect(await run).toBe(143)
    release()
  })
})
