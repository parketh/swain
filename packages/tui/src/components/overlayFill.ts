/**
 * Floated overlays (slash-command and file-search menus) draw on top of the
 * conversation, so each row must occlude the transcript behind it. Ink only
 * fills a rectangle when a `backgroundColor` is set, which forces a color that
 * won't match the terminal. Instead we pad every row to the full terminal width
 * with plain spaces: the trailing cells render in the terminal's own default
 * background, occluding without imposing a color.
 */

/** Trailing spaces so a row of `used` columns reaches `width` (none if unset). */
export const fillPad = (used: number, width: number | undefined): string =>
  width === undefined ? "" : " ".repeat(Math.max(0, width - used))

/** Truncate `text` to at most `max` columns, marking the cut with `…`. */
export const clampCols = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
