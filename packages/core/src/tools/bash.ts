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

/**
 * Commands a read-only subagent may run as a pipeline/chain segment head. Every
 * entry must be an inspection command that cannot itself exec another command
 * (no `env`/`xargs`/`sh`/`timeout`); write-capable flags are handled separately.
 */
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

/** `find` actions that write, delete, or execute; disqualify a read-only find. */
const FIND_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
])

/**
 * Detects a write-capable flag on an otherwise-inspection command, so a segment
 * like `sort -o f` or `find … -delete` is not misclassified as read-only. Only
 * allowlisted commands that can write need an entry; writes are excluded by
 * omission everywhere else.
 */
const hasWriteFlag = (head: string, args: ReadonlyArray<string>): boolean => {
  if (head === "sort") return args.some((a) => a.startsWith("--output") || /^-[a-zA-Z]*o/.test(a))
  if (head === "find") return args.some((a) => FIND_WRITE_ACTIONS.has(a))
  return false
}

/**
 * Splits a command into chain/pipeline segments of argv tokens, honoring single
 * and double quotes and backslash escapes. Returns null when the command
 * contains a construct that can smuggle a write or extra execution past a
 * per-command allowlist — redirection (`>`/`<`) or command/process substitution
 * (`$(`, backticks, `<(`) — which no inspection command needs. Fail-closed:
 * anything the tokenizer cannot account for rejects the whole command.
 */
const tokenizeSegments = (command: string): ReadonlyArray<ReadonlyArray<string>> | null => {
  const segments: Array<Array<string>> = []
  let argv: Array<string> = []
  let token = ""
  let hasToken = false
  let quote: '"' | "'" | null = null
  const endToken = (): void => {
    if (hasToken) {
      argv.push(token)
      token = ""
      hasToken = false
    }
  }
  const endSegment = (): void => {
    endToken()
    if (argv.length > 0) segments.push(argv)
    argv = []
  }
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]
    if (quote !== null) {
      if (c === quote) quote = null
      else {
        token += c
        hasToken = true
      }
      continue
    }
    switch (c) {
      case "'":
      case '"':
        quote = c
        hasToken = true
        break
      case "\\": {
        const next = command[i + 1]
        if (next !== undefined) {
          token += next
          hasToken = true
          i += 1
        }
        break
      }
      case " ":
      case "\t":
        endToken()
        break
      case "\n":
      case ";":
        endSegment()
        break
      case "|":
      case "&":
        endSegment()
        if (command[i + 1] === c) i += 1
        break
      case ">":
      case "<":
      case "`":
        return null
      case "$":
        if (command[i + 1] === "(") return null
        token += c
        hasToken = true
        break
      default:
        token += c
        hasToken = true
    }
  }
  endSegment()
  return segments
}

/**
 * Fail-closed read-only classifier for read-only subagent Bash: the command must
 * tokenize without any write/execute construct, and every chain/pipeline segment
 * must start with an allowlisted inspection command (or a read-only git
 * subcommand) carrying no write-capable flag. Anything unrecognized is rejected.
 */
export const isReadOnlyCommand = (command: string): boolean => {
  const segments = tokenizeSegments(command)
  if (segments === null || segments.length === 0) return false
  return segments.every((argv) => {
    const [head, ...args] = argv
    if (head === undefined) return false
    if (head === "git") {
      const sub = args.find((a) => !a.startsWith("-"))
      return sub !== undefined && READ_ONLY_GIT.has(sub)
    }
    if (!READ_ONLY_COMMANDS.has(head)) return false
    return !hasWriteFlag(head, args)
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
