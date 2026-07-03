import { FileSystem } from "@effect/platform"
import { Effect, Option, Schema } from "effect"
import { ToolError } from "../errors"
import { classify } from "../files/media"
import { resolveWorkspacePath } from "../files/paths"
import { cacheEntry } from "../state"
import { defineTool, ToolContext } from "./tool"

const NAME = "Read"

export const ReadInput = Schema.Struct({
  path: Schema.String,
})

export const ReadResult = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literal("text", "image", "pdf", "binary"),
  supported: Schema.Boolean,
  bytes: Schema.Number,
  content: Schema.optional(Schema.String),
})

const mtimeMs = (mtime: Option.Option<Date>): number =>
  Option.match(mtime, { onNone: () => 0, onSome: (date) => date.getTime() })

export const Read = defineTool({
  name: NAME,
  description: "Read text file contents. Non-text files report metadata only.",
  inputSchema: ReadInput,
  outputSchema: ReadResult,
  readOnly: true,
  call: (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { session } = yield* ToolContext
      const path = yield* resolveWorkspacePath(NAME, session.workingDirectory, input.path)

      const exists = yield* fs
        .exists(path)
        .pipe(Effect.mapError((error) => execError(error.message)))
      if (!exists) {
        return yield* new ToolError({
          tool: NAME,
          reason: "not-found",
          message: `File not found: ${input.path}`,
        })
      }

      const stat = yield* fs.stat(path).pipe(Effect.mapError((error) => execError(error.message)))
      const bytes = yield* fs
        .readFile(path)
        .pipe(Effect.mapError((error) => execError(error.message)))
      const media = classify(path, bytes)
      if (!media.supported) {
        return { path, kind: media.kind, supported: false, bytes: bytes.length }
      }

      const content = new TextDecoder().decode(bytes)
      session.fileState.set(
        path,
        cacheEntry({ path, lastModifiedMs: mtimeMs(stat.mtime), content }),
      )
      return { path, kind: "text" as const, supported: true, bytes: bytes.length, content }
    }),
})

const execError = (message: string): ToolError =>
  new ToolError({ tool: NAME, reason: "execution-failed", message })
