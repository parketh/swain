import { Command } from "@effect/platform"
import { Duration, Effect, Schema, Stream } from "effect"
import { ToolError } from "../errors"
import { defineTool, ToolContext, ToolProgress } from "../tool"
import { collectCapped } from "./collect"

const NAME = "Bash"
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT = 30_000

/** Obviously destructive commands blocked in every mode, before execution. */
const HARD_DENY: ReadonlyArray<RegExp> = [
  /\brm\s+-[a-z]*r[a-z]*f?\s+\/(?:\s|$|\*)/,
  /\bmkfs\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
]

/** Mutating/networked commands that require approval in `ask` mode. */
const RISKY: ReadonlyArray<RegExp> = [
  /\brm\b/,
  /\bsudo\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\bln\b/,
  /\btee\b/,
  /\btouch\b/,
  /\bmkdir\b/,
  /\brmdir\b/,
  /\btruncate\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bkill\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bsed\s[^|;&\n]*-i\b/,
  /\bgit\s+(push|add|commit|checkout|switch|restore|reset|rebase|merge|stash|clean|cherry-pick|revert|rm|mv|am|apply|tag)\b/,
  /\bnpm\s+(publish|install|i)\b/,
  /\bbun\s+(install|add|remove)\b/,
  />>?/,
]

export const isHardDenied = (command: string): boolean =>
  HARD_DENY.some((pattern) => pattern.test(command))

export const isRisky = (command: string): boolean => RISKY.some((pattern) => pattern.test(command))

/** Commands a read-only subagent may run as a pipeline/chain segment head. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "ls",
  "pwd",
  "find",
  "grep",
  "rg",
  "cat",
  "head",
  "tail",
  "wc",
  "echo",
  "printf",
  "stat",
  "file",
  "which",
  "tree",
  "sort",
  "uniq",
  "cut",
  "basename",
  "dirname",
  "realpath",
  "date",
  "du",
  "env",
])

const READ_ONLY_GIT: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "rev-list",
  "ls-files",
  "blame",
  "shortlog",
  "describe",
  "grep",
])

/** Constructs that can smuggle a write past a per-command allowlist. */
const READ_ONLY_REJECT: ReadonlyArray<RegExp> = [
  />/,
  /<</,
  /\$\(/,
  /`/,
  /\bfind\b[^|;&\n]*\s-(delete|exec|execdir|ok|okdir)\b/,
]

/**
 * Conservative allowlist classifier for read-only subagent Bash: every segment
 * of a pipeline/chain must start with an allowlisted inspection command (or a
 * read-only git subcommand), and write-smuggling shell constructs (redirection,
 * heredocs, substitution, `find -exec`) are rejected outright. Anything
 * unrecognized is rejected; false positives are acceptable.
 */
export const isReadOnlyCommand = (command: string): boolean => {
  if (READ_ONLY_REJECT.some((pattern) => pattern.test(command))) return false
  const segments = command
    .split(/[|&;\n]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  if (segments.length === 0) return false
  return segments.every((segment) => {
    const [head, sub] = segment.split(/\s+/)
    if (head === "git") return sub !== undefined && READ_ONLY_GIT.has(sub)
    return head !== undefined && READ_ONLY_COMMANDS.has(head)
  })
}

export const BashInput = Schema.Struct({
  command: Schema.String,
  timeoutMs: Schema.optional(Schema.Number),
})

export const BashResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Number,
  truncated: Schema.Boolean,
})

const render = ({ text, truncated }: { text: string; truncated: boolean }): string =>
  truncated ? `${text}\n… output truncated` : text

/**
 * Folds a byte stream into capped text like `collectCapped`, but taps each
 * decoded chunk into `emit` before folding so observers see stdout as it
 * arrives. Emission stops once the cap is reached, staying consistent with
 * `truncated`; each `emit` completes before the next chunk folds.
 */
const collectStreaming = (
  stream: Stream.Stream<Uint8Array, unknown>,
  cap: number,
  emit: (delta: string) => Effect.Effect<void>,
): Effect.Effect<{ text: string; truncated: boolean }, never> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect({ text: "", truncated: false }, (state, chunk) => {
      if (state.truncated) return Effect.succeed(state)
      if (state.text.length + chunk.length > cap) {
        const capped = chunk.slice(0, cap - state.text.length)
        return (capped.length > 0 ? emit(capped) : Effect.void).pipe(
          Effect.as({ text: state.text + capped, truncated: true }),
        )
      }
      return emit(chunk).pipe(Effect.as({ text: state.text + chunk, truncated: false }))
    }),
    Effect.orElseSucceed(() => ({ text: "", truncated: false })),
  )

export const Bash = defineTool({
  name: NAME,
  description: "Execute an approved shell command in the working directory.",
  inputSchema: BashInput,
  outputSchema: BashResult,
  readOnly: false,
  call: (input) =>
    Effect.gen(function* () {
      if (isHardDenied(input.command)) {
        return yield* new ToolError({
          tool: NAME,
          reason: "denied",
          message: `Command is blocked as dangerous: ${input.command}`,
        })
      }

      const { session, permission } = yield* ToolContext
      const progress = yield* ToolProgress
      const decision = yield* permission.check({
        toolName: NAME,
        readOnly: !isRisky(input.command),
        summary: `Run: ${input.command}`,
        command: input.command,
      })
      if (decision.type === "deny") {
        return yield* new ToolError({ tool: NAME, reason: "denied", message: decision.reason })
      }

      const command = Command.make("bash", "-c", input.command).pipe(
        Command.workingDirectory(session.workingDirectory),
      )
      const timeout = Duration.millis(
        Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
      )

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const process = yield* Command.start(command)
          const [exitCode, out, err] = yield* Effect.all(
            [
              process.exitCode,
              collectStreaming(process.stdout, MAX_OUTPUT, progress.emit),
              collectCapped(process.stderr, MAX_OUTPUT),
            ],
            { concurrency: "unbounded" },
          )
          return {
            stdout: render(out),
            stderr: render(err),
            exitCode: Number(exitCode),
            truncated: out.truncated || err.truncated,
          }
        }),
      ).pipe(
        Effect.mapError((error) =>
          error instanceof ToolError
            ? error
            : new ToolError({ tool: NAME, reason: "execution-failed", message: String(error) }),
        ),
        Effect.timeoutFail({
          duration: timeout,
          onTimeout: () =>
            new ToolError({
              tool: NAME,
              reason: "execution-failed",
              message: `Command timed out after ${Duration.toMillis(timeout)}ms`,
            }),
        }),
      )
    }),
})
