import { Effect, Stream } from "effect"

/**
 * Folds a byte stream into text while bounding memory: once the accumulated
 * text reaches `cap` characters, later chunks are dropped and `truncated` is
 * set. The stream is still drained, so the producing process runs to
 * completion (or is killed by an outer timeout) — this caps memory, not the
 * process. A decode/read failure yields whatever was collected so far.
 */
export const collectCapped = (
  stream: Stream.Stream<Uint8Array, unknown>,
  cap: number,
): Effect.Effect<{ text: string; truncated: boolean }, never> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold({ text: "", truncated: false }, (state, chunk) => {
      if (state.truncated) return state
      const next = state.text + chunk
      return next.length > cap
        ? { text: next.slice(0, cap), truncated: true }
        : { text: next, truncated: false }
    }),
    Effect.orElseSucceed(() => ({ text: "", truncated: false })),
  )
