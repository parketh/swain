import { describe, expect, test } from "bun:test"
import { type CliDeps, type HeadlessOptions, parseArgs, runCli } from "../src/cli"
import { version } from "../src/version"

// A runCli harness that captures stdout/stderr and records whether the
// interactive/headless frontends were invoked, without starting either.
const harness = (
  argv: ReadonlyArray<string>,
  extra: Partial<CliDeps> = {},
): {
  run: () => Promise<number>
  out: () => string
  err: () => string
  interactiveCalls: () => number
  headlessCalls: () => Array<HeadlessOptions>
} => {
  let out = ""
  let err = ""
  let interactiveCalls = 0
  const headlessCalls: Array<HeadlessOptions> = []
  const deps: CliDeps = {
    argv,
    env: {},
    cwd: "/tmp/work",
    stdout: (t) => {
      out += t
    },
    stderr: (t) => {
      err += t
    },
    runInteractive: async () => {
      interactiveCalls += 1
    },
    runHeadless: async (options) => {
      headlessCalls.push(options)
      return 0
    },
    ...extra,
  }
  return {
    run: () => runCli(deps),
    out: () => out,
    err: () => err,
    interactiveCalls: () => interactiveCalls,
    headlessCalls: () => headlessCalls,
  }
}

describe("parseArgs", () => {
  test("bare and interactive argv dispatch to the interactive frontend", () => {
    expect(parseArgs([]).kind).toBe("interactive")
    expect(parseArgs(["--resume", "abc"]).kind).toBe("interactive")
    expect(parseArgs(["--model", "anthropic:claude-opus-4-8"]).kind).toBe("interactive")
  })

  test("positional prompt parses", () => {
    const parsed = parseArgs(["exec", "--permission-mode", "auto", "do the thing"])
    expect(parsed).toEqual({
      kind: "exec",
      exec: {
        permissionMode: "auto",
        router: false,
        outputFormat: "text",
        prompt: { source: "text", text: "do the thing" },
      },
    })
  })

  test("stdin prompt parses", () => {
    const parsed = parseArgs(["exec", "--permission-mode", "plan", "-"])
    expect(parsed).toEqual({
      kind: "exec",
      exec: {
        permissionMode: "plan",
        router: false,
        outputFormat: "text",
        prompt: { source: "stdin" },
      },
    })
  })

  test("--router parses as a boolean and defaults off", () => {
    const on = parseArgs(["exec", "--permission-mode", "auto", "--router", "p"])
    expect(on.kind === "exec" && on.exec.router).toBe(true)
    const off = parseArgs(["exec", "--permission-mode", "auto", "p"])
    expect(off.kind === "exec" && off.exec.router).toBe(false)
  })

  test("--output-format defaults to text and accepts stream-json", () => {
    const def = parseArgs(["exec", "--permission-mode", "auto", "p"])
    expect(def.kind === "exec" && def.exec.outputFormat).toBe("text")
    const stream = parseArgs([
      "exec",
      "--permission-mode",
      "auto",
      "--output-format",
      "stream-json",
      "p",
    ])
    expect(stream.kind === "exec" && stream.exec.outputFormat).toBe("stream-json")
  })

  test("an invalid --output-format is a usage error", () => {
    const parsed = parseArgs(["exec", "--permission-mode", "auto", "--output-format", "yaml", "p"])
    expect(parsed.kind).toBe("usage-error")
  })

  test("--trace-dir is absent by default and captured when supplied", () => {
    const def = parseArgs(["exec", "--permission-mode", "auto", "p"])
    expect(def.kind === "exec" && def.exec.traceDir).toBeUndefined()
    const traced = parseArgs([
      "exec",
      "--permission-mode",
      "auto",
      "--trace-dir",
      "/logs/agent/swain",
      "p",
    ])
    expect(traced.kind === "exec" && traced.exec.traceDir).toBe("/logs/agent/swain")
  })

  test("--trace-dir without a value is a usage error", () => {
    const parsed = parseArgs(["exec", "--permission-mode", "auto", "--trace-dir"])
    expect(parsed.kind).toBe("usage-error")
  })

  test("--trace-dir is only recognized for exec, not interactive", () => {
    // Leading flag routes to interactive, where exec-only flags aren't parsed here.
    expect(parseArgs(["--trace-dir", "/logs"]).kind).toBe("interactive")
  })

  test("--output-format without a value is a usage error", () => {
    const parsed = parseArgs(["exec", "--permission-mode", "auto", "--output-format"])
    expect(parsed.kind).toBe("usage-error")
  })

  test("provider:model:variant parses without losing the variant", () => {
    const parsed = parseArgs([
      "exec",
      "--permission-mode",
      "auto",
      "--model",
      "anthropic:claude-opus-4-8:high",
      "p",
    ])
    expect(parsed.kind === "exec" && parsed.exec.model).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      variant: "high",
    })
  })

  test("provider:model parses with no variant", () => {
    const parsed = parseArgs([
      "exec",
      "--permission-mode",
      "auto",
      "--model",
      "openai:gpt-5.5",
      "p",
    ])
    expect(parsed.kind === "exec" && parsed.exec.model).toEqual({
      provider: "openai",
      modelId: "gpt-5.5",
    })
  })

  test("options may follow the positional prompt and honor --", () => {
    const parsed = parseArgs(["exec", "p", "--permission-mode", "auto"])
    expect(parsed.kind === "exec" && parsed.exec.prompt).toEqual({ source: "text", text: "p" })
    const dashed = parseArgs(["exec", "--permission-mode", "auto", "--", "--model"])
    expect(dashed.kind === "exec" && dashed.exec.prompt).toEqual({
      source: "text",
      text: "--model",
    })
  })

  test.each([
    [["exec", "the prompt"], "missing permission mode"],
    [["exec", "--permission-mode", "ask", "p"], "ask mode"],
    [["exec", "--permission-mode", "auto"], "missing prompt"],
    [["exec", "--permission-mode", "auto", "a", "b"], "multiple prompts"],
    [["exec", "--permission-mode", "auto", "-", "b"], "stdin plus positional"],
    [["exec", "--permission-mode", "auto", "--bogus", "p"], "unknown flag"],
    [["exec", "--permission-mode", "auto", "--model", "anthropic", "p"], "malformed model"],
    [["exec", "--permission-mode", "auto", "   "], "empty prompt text"],
  ])("returns a usage error: %s", (argv) => {
    expect(parseArgs(argv as string[]).kind).toBe("usage-error")
  })
})

describe("runCli", () => {
  test("--version prints only the version and returns 0", async () => {
    const h = harness(["--version"])
    expect(await h.run()).toBe(0)
    expect(h.out()).toBe(`${version()}\n`)
    expect(h.err()).toBe("")
    expect(h.interactiveCalls()).toBe(0)
  })

  test("--help documents both modes and returns 0", async () => {
    const h = harness(["--help"])
    expect(await h.run()).toBe(0)
    expect(h.out()).toContain("swain exec")
    expect(h.out()).toContain("interactive")
    expect(h.err()).toBe("")
  })

  test("interactive argv invokes the interactive frontend", async () => {
    const h = harness(["--resume", "abc"])
    expect(await h.run()).toBe(0)
    expect(h.interactiveCalls()).toBe(1)
    expect(h.headlessCalls()).toHaveLength(0)
  })

  test("a valid exec invokes headless with the resolved prompt", async () => {
    const h = harness(["exec", "--permission-mode", "auto", "--router", "hello"])
    expect(await h.run()).toBe(0)
    const calls = h.headlessCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.permissionMode).toBe("auto")
    expect(calls[0]?.router).toBe(true)
    expect(calls[0]?.prompt).toBe("hello")
  })

  test("stdin mode reads all of stdin as the prompt", async () => {
    const h = harness(["exec", "--permission-mode", "plan", "-"], {
      stdin: async () => "line one\nline two\n",
    })
    expect(await h.run()).toBe(0)
    expect(h.headlessCalls()[0]?.prompt).toBe("line one\nline two\n")
  })

  test.each([
    [["exec", "the prompt"], "missing permission"],
    [["exec", "--permission-mode", "ask", "p"], "ask mode"],
    [["exec", "--permission-mode", "auto"], "missing prompt"],
    [["exec", "--permission-mode", "auto", "a", "b"], "multiple prompts"],
    [["exec", "--permission-mode", "auto", "--bogus", "p"], "unknown flag"],
  ])("usage errors return 2 without invoking headless startup: %s", async (argv) => {
    const h = harness(argv as string[])
    expect(await h.run()).toBe(2)
    expect(h.headlessCalls()).toHaveLength(0)
    expect(h.out()).toBe("")
    expect(h.err().length).toBeGreaterThan(0)
  })

  test("empty piped input is a usage error and does not invoke headless", async () => {
    const h = harness(["exec", "--permission-mode", "auto", "-"], {
      stdin: async () => "  \n ",
    })
    expect(await h.run()).toBe(2)
    expect(h.headlessCalls()).toHaveLength(0)
  })
})
