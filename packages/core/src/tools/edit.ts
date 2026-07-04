import { FileSystem } from "@effect/platform"
import { Effect, Option, Schema } from "effect"
import { ToolError } from "../errors"
import { makeUnifiedDiff } from "../files/diff"
import { resolveWorkspacePath } from "../files/paths"
import { cacheEntry, isFresh, withFileLock } from "../state"
import { defineTool, ToolContext } from "../tool"

const NAME = "Edit"

export const EditInput = Schema.Struct({
  path: Schema.String,
  oldText: Schema.String,
  newText: Schema.String,
  replaceAll: Schema.optional(Schema.Boolean),
})

export const EditResult = Schema.Struct({
  path: Schema.String,
  oldText: Schema.String,
  newText: Schema.String,
  replaceAll: Schema.optional(Schema.Boolean),
  replacements: Schema.Number,
  diffs: Schema.Array(
    Schema.Struct({
      format: Schema.Literal("unified"),
      text: Schema.String,
      truncated: Schema.Boolean,
    }),
  ),
})

const fail = (reason: ToolError["reason"], message: string): ToolError =>
  new ToolError({ tool: NAME, reason, message })

const mtimeMs = (mtime: Option.Option<Date>): number =>
  Option.match(mtime, { onNone: () => 0, onSome: (date) => date.getTime() })

export const Edit = defineTool({
  name: NAME,
  description: "Exact text replacement in an existing text file the model has read.",
  inputSchema: EditInput,
  outputSchema: EditResult,
  readOnly: false,
  call: (input) =>
    Effect.gen(function* () {
      if (input.oldText.length === 0) {
        return yield* fail("precondition-failed", "oldText must not be empty.")
      }
      const fs = yield* FileSystem.FileSystem
      const { session, permission } = yield* ToolContext
      const path = yield* resolveWorkspacePath(NAME, session.workingDirectory, input.path)

      const cached = session.fileState.get(path)
      if (cached === undefined) {
        return yield* fail("precondition-failed", `Read ${input.path} before editing it.`)
      }

      return yield* withFileLock(
        session,
        path,
        Effect.gen(function* () {
          const current = yield* fs
            .readFileString(path)
            .pipe(Effect.mapError((error) => fail("execution-failed", error.message)))
          const stat = yield* fs
            .stat(path)
            .pipe(Effect.mapError((error) => fail("execution-failed", error.message)))
          if (!isFresh(cached, mtimeMs(stat.mtime), current)) {
            return yield* fail(
              "precondition-failed",
              `${input.path} changed since it was read. Read it again before editing.`,
            )
          }

          const occurrences = current.split(input.oldText).length - 1
          if (occurrences === 0) {
            return yield* fail("not-found", "oldText was not found in the file.")
          }
          if (occurrences > 1 && input.replaceAll !== true) {
            return yield* fail(
              "precondition-failed",
              `oldText is not unique (${occurrences} matches). Pass replaceAll or add context.`,
            )
          }

          const updated = input.replaceAll
            ? current.split(input.oldText).join(input.newText)
            : replaceFirst(current, input.oldText, input.newText)
          const replacements = input.replaceAll ? occurrences : 1
          const diff = makeUnifiedDiff(input.path, current, updated)

          const decision = yield* permission.check({
            toolName: NAME,
            readOnly: false,
            summary: `Edit ${input.path} (${replacements} replacement${replacements === 1 ? "" : "s"})`,
            diff: diff.text,
          })
          if (decision.type === "deny") {
            return yield* fail("denied", decision.reason)
          }

          yield* fs
            .writeFileString(path, updated)
            .pipe(Effect.mapError((error) => fail("execution-failed", error.message)))
          const after = yield* fs
            .stat(path)
            .pipe(Effect.mapError((error) => fail("execution-failed", error.message)))
          session.fileState.set(
            path,
            cacheEntry({ path, lastModifiedMs: mtimeMs(after.mtime), content: updated }),
          )

          return {
            path,
            oldText: input.oldText,
            newText: input.newText,
            ...(input.replaceAll !== undefined && { replaceAll: input.replaceAll }),
            replacements,
            diffs: [diff],
          }
        }),
      )
    }),
})

const replaceFirst = (content: string, oldText: string, newText: string): string => {
  const index = content.indexOf(oldText)
  return content.slice(0, index) + newText + content.slice(index + oldText.length)
}
