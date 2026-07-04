import { Command } from "@effect/platform"
import { Duration, Effect, Schema } from "effect"
import { ToolError } from "../errors"
import { defineTool, ToolContext } from "../tool"
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
  /\bchmod\b/,
  /\bchown\b/,
  /\bkill\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bgit\s+push\b/,
  /\bnpm\s+(publish|install|i)\b/,
  /\bbun\s+(install|add|remove)\b/,
  />>?/,
]

export const isHardDenied = (command: string): boolean =>
  HARD_DENY.some((pattern) => pattern.test(command))

export const isRisky = (command: string): boolean => RISKY.some((pattern) => pattern.test(command))

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
              collectCapped(process.stdout, MAX_OUTPUT),
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
