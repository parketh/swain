import * as NodePath from "node:path"
import { FileSystem } from "@effect/platform"
import type { ToolResultContent } from "@swain/llms"
import { ToolResultContent as ToolResultContentSchema } from "@swain/llms"
import { Context, Effect, Layer } from "effect"
import type { SessionState } from "../state"

/** Bodies at or below this character count pass through unchanged. */
export const TOOL_RESULT_THRESHOLD = 50_000
/** Prefix of the full output kept inline as a preview. */
export const TOOL_RESULT_PREVIEW_CHARS = 2_000

/**
 * Persists oversized tool-result bodies so they never enter the transcript as
 * full model-visible text. Provided by the host (which owns the session
 * directory); absent in headless/test callers, in which case results pass
 * through untouched.
 */
export interface ToolResultStore {
  readonly persist: (
    session: SessionState,
    result: ToolResultContent,
  ) => Effect.Effect<ToolResultContent>
}

export class ToolResultStoreService extends Context.Tag("@swain/ToolResultStore")<
  ToolResultStoreService,
  ToolResultStore
>() {}

interface Body {
  readonly text: string
  readonly ext: "txt" | "json"
}

const bodyOf = (result: ToolResultContent): Body =>
  result.result.type === "text"
    ? { text: result.result.value, ext: "txt" }
    : { text: JSON.stringify(result.result.value, null, 2), ext: "json" }

/** Filesystem-safe file stem derived from the (possibly compound) tool call id. */
const safeStem = (toolCallId: string): string => toolCallId.replace(/[^a-zA-Z0-9._-]/g, "_")

const wrap = (originalChars: number, path: string, preview: string): string =>
  `<persisted-tool-result>\nOutput too large (${originalChars} chars). Full output saved to: ${path}\n\nPreview:\n${preview}\n...\n</persisted-tool-result>`

/**
 * Live store writing under `dir`. Oversized bodies are written once (keyed by
 * tool call id, so repeated saves/resumes neither rewrite nor duplicate), a
 * `ToolResultReplacement` is recorded on the session, and the returned result
 * carries a preview and path. On any filesystem error it degrades to the
 * original result rather than failing the turn.
 */
export const toolResultStoreLayer = (
  dir: string,
): Layer.Layer<ToolResultStoreService, never, FileSystem.FileSystem> =>
  Layer.effect(
    ToolResultStoreService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const persist = (
        session: SessionState,
        result: ToolResultContent,
      ): Effect.Effect<ToolResultContent> =>
        Effect.gen(function* () {
          const { text, ext } = bodyOf(result)
          if (text.length <= TOOL_RESULT_THRESHOLD) return result
          const existing = session.toolResults.find((r) => r.toolCallId === result.toolCallId)
          const path = existing?.path ?? NodePath.join(dir, `${safeStem(result.toolCallId)}.${ext}`)
          const preview = text.slice(0, TOOL_RESULT_PREVIEW_CHARS)
          // Write once, keyed by tool call id: a body already persisted (repeat
          // save, resume) reuses its file and metadata rather than rewriting a
          // 50k+ payload or overwriting the original artifact.
          if (existing === undefined) {
            yield* fs.makeDirectory(dir, { recursive: true })
            yield* fs.writeFileString(path, text)
            session.toolResults.push({
              toolCallId: result.toolCallId,
              ...(result.name !== undefined && { name: result.name }),
              path,
              originalChars: text.length,
              previewChars: preview.length,
              createdAt: new Date().toISOString(),
            })
          }
          return ToolResultContentSchema.make({
            type: "tool-result",
            toolCallId: result.toolCallId,
            ...(result.name !== undefined && { name: result.name }),
            result: { type: "text", value: wrap(text.length, path, preview) },
            ...(result.isError !== undefined && { isError: result.isError }),
            ...(result.durationMs !== undefined && { durationMs: result.durationMs }),
          })
        }).pipe(Effect.catchAll(() => Effect.succeed(result)))
      return { persist }
    }),
  )
