/**
 * SGR mouse reports as Ink delivers them to `useInput`: `[<b;x;y[Mm]`, with the
 * leading ESC stripped (or embedded when press+release arrive in one chunk).
 * Some terminals omit the button number, hence `\d*`.
 */
const MOUSE_EVENT = /\x1b?\[<(\d*);\d+;\d+([Mm])/g

export interface MouseEvent {
  readonly button: number
  readonly release: boolean
}

/** Parses every SGR mouse report in an input chunk; empty when none present. */
export const parseMouseEvents = (input: string): ReadonlyArray<MouseEvent> =>
  [...input.matchAll(MOUSE_EVENT)].map((m) => ({
    button: Number(m[1] || "0"),
    release: m[2] === "m",
  }))

/** Transcript rows scrolled per wheel notch. */
const WHEEL_ROWS = 3

/**
 * Net transcript scroll (in rows; + = back toward older content) from a chunk's
 * wheel events, or `null` when the chunk carried no mouse report at all. Button
 * bit 64 marks a wheel event; the low bit is direction. Callers swallow any
 * non-null result so the mouse sequence never leaks into the prompt.
 */
export const wheelScroll = (input: string): number | null => {
  const mouse = parseMouseEvents(input)
  if (mouse.length === 0) return null
  let ticks = 0
  for (const m of mouse) {
    if (m.button & 64) ticks += (m.button & 1) === 0 ? 1 : -1
  }
  return ticks * WHEEL_ROWS
}

/**
 * Ink fans each stdin chunk out to every active `useInput` hook, so dialogs
 * that append raw `input` to a text field must drop mouse reports themselves —
 * a sibling handler swallowing the event does not stop propagation.
 */
export const isMouseEvent = (input: string): boolean => parseMouseEvents(input).length > 0
