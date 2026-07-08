// Shared UI colors.
//
// We avoid Ink's `dimColor` prop: chalk closes bold with SGR `\e[22m`, which
// also resets the dim attribute (`\e[2m`). So any bold text nested inside a
// dim parent drops the dim for everything after it — dimming appears to apply
// only to the first styled child. Passing an explicit color is reliable.
export const theme = {
  /** Secondary / de-emphasized text (replaces `dimColor`). */
  muted: "#8a8a8a",
  /** Fainter still, for the least prominent text. */
  faint: "#5f5f5f",
  /** Accent — the light-blue/cyan used for the SWAIN wordmark. */
  primary: "#7dd3ff",
  /** Dimmer variant of the accent, for de-emphasized accent text. */
  primaryDim: "#66a6cc",
  /**
   * Opaque backdrop for floating overlays. Ink composites absolute-positioned
   * boxes per-glyph, so an overlay without a filled background lets long
   * transcript lines bleed through its empty cells. A solid panel color makes
   * the overlay opaque.
   */
  overlay: "#12141c",
} as const
