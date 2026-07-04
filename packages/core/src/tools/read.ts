import { FileSystem } from "@effect/platform"
import { Effect, Option, Schema } from "effect"
import { ToolError } from "../errors"
import { classify } from "../files/media"
import { resolveWorkspacePath } from "../files/paths"
import { cacheEntry } from "../state"
import { defineTool, ToolContext } from "../tool"

const NAME = "Read"
const DEFAULT_LIMIT = 2000
const MAX_BYTES = 10 * 1024 * 1024

export const ReadInput = Schema.Struct({
  path: Schema.String,
  offset: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
})

export const ReadResult = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literal("text", "image", "pdf", "binary"),
  supported: Schema.Boolean,
  bytes: Schema.Number,
  content: Schema.optional(Schema.String),
  totalLines: Schema.optional(Schema.Number),
  truncated: Schema.Boolean,
})

const mtimeMs = (mtime: Option.Option<Date>): number =>
  Option.match(mtime, { onNone: () => 0, onSome: (date) => date.getTime() })

/** Prefixes each line with a 1-based, right-aligned line number (cat -n style). */
const numberLines = (lines: ReadonlyArray<string>, startLine: number): string =>
  lines.map((line, index) => `${String(startLine + index).padStart(6)}\t${line}`).join("\n")

export const Read = defineTool({
  name: NAME,
  description:
    "Read a text file's contents, returned with line numbers. Reads up to 2000 " +
    "lines from the start; use offset/limit to page through larger files. " +
    "Non-text files report metadata only.",
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
      if (stat.size > BigInt(MAX_BYTES)) {
        return yield* new ToolError({
          tool: NAME,
          reason: "precondition-failed",
          message: `File is too large to read (${stat.size} bytes, max ${MAX_BYTES}). Use Grep to search it.`,
        })
      }

      const bytes = yield* fs
        .readFile(path)
        .pipe(Effect.mapError((error) => execError(error.message)))
      const media = classify(path, bytes)
      if (!media.supported) {
        return { path, kind: media.kind, supported: false, bytes: bytes.length, truncated: false }
      }

      // Cache the full content so Edit's freshness check works after any read,
      // even when only a slice is returned to the model below.
      const content = new TextDecoder().decode(bytes)
      session.fileState.set(
        path,
        cacheEntry({ path, lastModifiedMs: mtimeMs(stat.mtime), content }),
      )

      const allLines = content.split("\n")
      const totalLines = allLines.length
      const start = Math.max(1, input.offset ?? 1)
      const limit = Math.max(1, input.limit ?? DEFAULT_LIMIT)
      const slice = allLines.slice(start - 1, start - 1 + limit)
      const truncated = start > 1 || start - 1 + limit < totalLines

      return {
        path,
        kind: "text" as const,
        supported: true,
        bytes: bytes.length,
        content: numberLines(slice, start),
        totalLines,
        truncated,
      }
    }),
})

const execError = (message: string): ToolError =>
  new ToolError({ tool: NAME, reason: "execution-failed", message })
