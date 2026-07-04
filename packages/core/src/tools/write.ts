import { FileSystem } from "@effect/platform"
import { Effect, Option, Schema } from "effect"
import { ToolError } from "../errors"
import { resolveWorkspacePath } from "../files/paths"
import { cacheEntry, withFileLock } from "../state"
import { defineTool, ToolContext } from "../tool"

const NAME = "Write"

export const WriteInput = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
})

export const WriteResult = Schema.Struct({
  path: Schema.String,
  bytesWritten: Schema.Number,
})

const execError = (message: string): ToolError =>
  new ToolError({ tool: NAME, reason: "execution-failed", message })

export const Write = defineTool({
  name: NAME,
  description: "Create a new text file. Fails if the file already exists; use Edit to change one.",
  inputSchema: WriteInput,
  outputSchema: WriteResult,
  readOnly: false,
  call: (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { session, permission } = yield* ToolContext
      const path = yield* resolveWorkspacePath(NAME, session.workingDirectory, input.path)

      const exists = yield* fs
        .exists(path)
        .pipe(Effect.mapError((error) => execError(error.message)))
      if (exists) {
        return yield* new ToolError({
          tool: NAME,
          reason: "precondition-failed",
          message: `File already exists: ${input.path}. Use Edit to change it.`,
        })
      }

      const decision = yield* permission.check({
        toolName: NAME,
        readOnly: false,
        summary: `Create ${input.path}`,
      })
      if (decision.type === "deny") {
        return yield* new ToolError({ tool: NAME, reason: "denied", message: decision.reason })
      }

      return yield* withFileLock(
        session,
        path,
        Effect.gen(function* () {
          yield* fs
            .writeFileString(path, input.content)
            .pipe(Effect.mapError((error) => execError(error.message)))
          const stat = yield* fs
            .stat(path)
            .pipe(Effect.mapError((error) => execError(error.message)))
          session.fileState.set(
            path,
            cacheEntry({
              path,
              lastModifiedMs: Option.match(stat.mtime, {
                onNone: () => 0,
                onSome: (date) => date.getTime(),
              }),
              content: input.content,
            }),
          )
          return { path, bytesWritten: new TextEncoder().encode(input.content).length }
        }),
      )
    }),
})
