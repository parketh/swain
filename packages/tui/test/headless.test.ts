import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
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
    outputFormat: "text",
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

  test("exec allows more than 20 tool iterations before concluding", async () => {
    seedAuth()
    // 25 tool-call turns then a final text. Interactive default (20) would fail
    // with max-iterations (exit 1) before reaching the text; exec's higher
    // budget runs to the final "finished".
    const turns = [
      ...Array.from({ length: 25 }, () => toolCallTurn("Read", { path: "does-not-exist" })),
      textTurn("finished"),
    ]
    const code = await runHeadless(options("go"), { llmLayer: scripted(turns).layer })
    expect(code).toBe(0)
    expect(out).toContain("finished")
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

  test("a fatal error carrying a provider key is redacted on stderr", async () => {
    const secret = "sk-ant-secret-0123456789"
    writeFileSync(join(swainDir, "auth.json"), JSON.stringify({ anthropic: { apiKey: secret } }))
    const boom = new LLMError({
      reason: "server-error",
      message: `401 unauthorized key=${secret}`,
      retryable: false,
    })
    const layer = Layer.succeed(LLMClient.Service, {
      request: LLMClient.request,
      streamTurn: () => Stream.fail(boom),
      generateTurn: () => Effect.fail(boom),
    })
    const code = await runHeadless(options("go"), { llmLayer: layer })
    expect(code).toBe(1)
    expect(err).not.toContain(secret)
    expect(err).toContain("[REDACTED]")
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

  const events = (): Array<Record<string, unknown>> =>
    out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)

  test("stream-json emits an init line, an assistant line, and a success result", async () => {
    seedAuth()
    const code = await runHeadless(options("summarize", { outputFormat: "stream-json" }), {
      llmLayer: scripted([textTurn("the summary")]).layer,
    })
    expect(code).toBe(0)
    const lines = events()
    expect(lines[0]).toMatchObject({ type: "init", permissionMode: "auto", cwd })
    expect(
      lines.some(
        (e) =>
          e.type === "assistant" &&
          (e.content as Array<{ type: string; text?: string }>).some(
            (c) => c.type === "text" && c.text === "the summary",
          ),
      ),
    ).toBe(true)
    expect(lines.at(-1)).toEqual({
      type: "result",
      subtype: "success",
      isError: false,
      result: "the summary",
    })
    expect(err).toBe("")
  })

  test("stream-json surfaces a tool-call and a tool-result before the result", async () => {
    seedAuth()
    const llm = scripted([toolCallTurn("Read", { path: "x" }), textTurn("done")])
    const code = await runHeadless(options("read then answer", { outputFormat: "stream-json" }), {
      llmLayer: llm.layer,
    })
    expect(code).toBe(0)
    const lines = events()
    expect(
      lines.some(
        (e) =>
          e.type === "assistant" &&
          (e.content as Array<{ type: string }>).some((c) => c.type === "tool-call"),
      ),
    ).toBe(true)
    expect(
      lines.some(
        (e) =>
          e.type === "user" &&
          (e.content as Array<{ type: string }>).some((c) => c.type === "tool-result"),
      ),
    ).toBe(true)
    expect(lines.at(-1)).toMatchObject({ type: "result", subtype: "success", result: "done" })
  })

  test("stream-json ends with an error result on a fatal failure and exits 1", async () => {
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
    const code = await runHeadless(options("go", { outputFormat: "stream-json" }), {
      llmLayer: layer,
    })
    expect(code).toBe(1)
    const lines = events()
    expect(lines[0]).toMatchObject({ type: "init" })
    expect(lines.at(-1)).toEqual({
      type: "result",
      subtype: "error_during_execution",
      isError: true,
      result: "upstream boom",
    })
    expect(err).toContain("upstream boom")
  })

  test("stream-json flushes a turn's committed events before the run completes", async () => {
    seedAuth()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let call = 0
    const layer = Layer.succeed(LLMClient.Service, {
      request: LLMClient.request,
      streamTurn: () => {
        call += 1
        // First iteration calls a tool; the second (final) iteration is gated so
        // we can observe the first iteration's committed events while the run is
        // still in flight — i.e. that events stream, not batch at the end.
        return call === 1
          ? Stream.fromIterable(toolCallTurn("Read", { path: "x" }))
          : Stream.unwrap(
              Effect.promise(() => gate).pipe(Effect.as(Stream.fromIterable(textTurn("done")))),
            )
      },
      generateTurn: () => Effect.succeed({ events: [] }),
    })
    const run = runHeadless(options("go", { outputFormat: "stream-json" }), { llmLayer: layer })
    // The tool-call assistant and tool-result appear before the gated final turn.
    await waitFor(() => out.includes('"tool-result"'))
    const midRun = events()
    expect(
      midRun.some(
        (e) =>
          e.type === "assistant" &&
          (e.content as Array<{ type: string }>).some((c) => c.type === "tool-call"),
      ),
    ).toBe(true)
    expect(midRun.some((e) => e.type === "user")).toBe(true)
    // The run has not finished, so no result line yet.
    expect(midRun.some((e) => e.type === "result")).toBe(false)
    release()
    expect(await run).toBe(0)
  })

  test("stream-json emits an interrupted result when SIGINT fires", async () => {
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
    const run = runHeadless(options("go", { outputFormat: "stream-json" }), { llmLayer: layer })
    await waitFor(() => process.listeners("SIGINT").length > before)
    ;(process.listeners("SIGINT").at(-1) as () => void)()
    expect(await run).toBe(130)
    expect(events().at(-1)).toEqual({ type: "result", subtype: "interrupted", isError: true })
    release()
  })

  // --- Native trace bundle (--trace-dir) ---------------------------------

  const readTrace = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"))

  test("without --trace-dir performs no trace I/O", async () => {
    seedAuth()
    await runHeadless(options("go"), { llmLayer: scripted([textTurn("ok")]).layer })
    // No stray trace directory materializes in the working directory.
    expect(readdirSync(cwd)).toHaveLength(0)
  })

  test("--trace-dir on a successful run writes a root snapshot and manifest", async () => {
    seedAuth()
    const traceDir = join(cwd, "logs", "agent", "swain")
    const llm = scripted([textTurn("the summary")])
    const code = await runHeadless(options("summarize", { traceDir }), { llmLayer: llm.layer })
    expect(code).toBe(0)
    const root = readTrace(traceDir, "root.json")
    expect(root.schemaVersion).toBe(1)
    expect(root.agentType).toBe("root")
    expect(root.outcome).toEqual({ status: "completed" })
    // The traced system prompt is exactly what was sent to the model.
    expect(root.systemPrompt).toBe((llm.requests[0]?.system as { text: string }).text)
    // The committed assistant response and its usage survive into the trace.
    const assistant = root.messages.find((m: { role: string }) => m.role === "assistant")
    expect(assistant.usage).toEqual({ inputTokens: 1, outputTokens: 1 })
    const manifest = readTrace(traceDir, "manifest.json")
    expect(manifest.children).toEqual([])
  })

  test("an unwritable --trace-dir fails the run before any model request", async () => {
    seedAuth()
    // A file in the parent chain makes the trace directory uncreatable.
    const filePath = join(cwd, "blocker")
    writeFileSync(filePath, "x")
    const llm = scripted([textTurn("never")])
    const code = await runHeadless(options("go", { traceDir: join(filePath, "logs") }), {
      llmLayer: llm.layer,
    })
    expect(code).toBe(1)
    expect(out).toBe("")
    expect(llm.requests).toHaveLength(0)
  })

  test("a fatal failure still leaves a root snapshot with a failed outcome", async () => {
    seedAuth()
    const traceDir = join(cwd, "logs")
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
    const code = await runHeadless(options("go", { traceDir }), { llmLayer: layer })
    expect(code).toBe(1)
    const root = readTrace(traceDir, "root.json")
    expect(root.outcome).toEqual({ status: "failed", error: "upstream boom" })
  })

  test("a completed subagent leaves its own child trace file", async () => {
    seedAuth()
    const traceDir = join(cwd, "logs")
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
          parentCalls === 1 ? spawn : parentCalls === 2 ? textTurn("waiting") : textTurn("done"),
        )
      },
      generateTurn: () => Effect.succeed({ events: [] }),
    })
    const code = await runHeadless(options("delegate", { traceDir }), { llmLayer: layer })
    expect(code).toBe(0)
    const children = readdirSync(join(traceDir, "subagents"))
    expect(children).toHaveLength(1)
    const child = readTrace(traceDir, join("subagents", children[0]!))
    expect(child.agentType).toBe("Explore")
    expect(child.parentAgentId).toBe(root_agentId(traceDir))
    expect(child.outcome).toEqual({ status: "completed" })
    // The manifest links the child by relative path.
    const manifest = readTrace(traceDir, "manifest.json")
    expect(manifest.children).toHaveLength(1)
    expect(manifest.children[0].file).toBe(join("subagents", children[0]!))
  })

  const root_agentId = (dir: string): string => readTrace(dir, "root.json").agentId

  test("a selected provider key is redacted in both stdout and the trace", async () => {
    const key = "sk-ant-secret-0123456789abcdefghij"
    writeFileSync(join(swainDir, "auth.json"), JSON.stringify({ anthropic: { apiKey: key } }))
    const traceDir = join(cwd, "logs")
    // The assistant text echoes the key; redaction must scrub it everywhere.
    const code = await runHeadless(options(`leak ${key}`, { traceDir }), {
      llmLayer: scripted([textTurn(`the key is ${key} ok`)]).layer,
    })
    expect(code).toBe(0)
    expect(out).toContain("[REDACTED]")
    expect(out).not.toContain(key)
    const rootRaw = readFileSync(join(traceDir, "root.json"), "utf8")
    expect(rootRaw).not.toContain(key)
    expect(rootRaw).toContain("[REDACTED]")
  })

  test("the traced root prompt carries the router block only when routing is active", async () => {
    writeFileSync(
      join(swainDir, "auth.json"),
      JSON.stringify({ anthropic: { apiKey: "sk-a" }, deepseek: { apiKey: "sk-d" } }),
    )
    writeFileSync(
      join(swainDir, "config.json"),
      JSON.stringify({ router: { enabled: true, disabledModels: [], disabledTargets: [] } }),
    )

    const offDir = join(cwd, "logs-off")
    await runHeadless(options("go", { traceDir: offDir }), {
      llmLayer: scripted([textTurn("ok")]).layer,
    })
    expect(readTrace(offDir, "root.json").systemPrompt).not.toContain("Routable model targets")

    const onDir = join(cwd, "logs-on")
    await runHeadless(options("go", { router: true, traceDir: onDir }), {
      llmLayer: scripted([textTurn("ok")]).layer,
    })
    expect(readTrace(onDir, "root.json").systemPrompt).toContain("Routable model targets")
  })

  test("SIGINT during a run leaves a root snapshot marked interrupted", async () => {
    seedAuth()
    const traceDir = join(cwd, "logs")
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
    const run = runHeadless(options("go", { traceDir }), { llmLayer: layer })
    await waitFor(() => process.listeners("SIGINT").length > before)
    ;(process.listeners("SIGINT").at(-1) as () => void)()
    expect(await run).toBe(130)
    const root = readTrace(traceDir, "root.json")
    expect(root.outcome).toEqual({ status: "interrupted", signal: "SIGINT" })
    release()
  })
})
