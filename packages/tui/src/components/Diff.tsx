import { Box, Text } from "ink"
import { theme } from "../theme"
import { clampCols } from "./overlayFill"

export type DiffLineKind = "add" | "del" | "context" | "hunk"

export interface DiffLine {
  readonly kind: DiffLineKind
  /** Code content without the leading +/-/space marker (raw text for hunks). */
  readonly text: string
  /** New-side line number for add/context, old-side for del; absent on hunks. */
  readonly lineNo?: number
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Parse a unified diff (as produced by `createPatch`) into displayable lines,
 * dropping the redundant file-header rows (`Index:`, `===`, `---`, `+++`) and
 * tracking per-hunk line numbers so the view can render a gutter.
 */
export const parseDiff = (diff: string): ReadonlyArray<DiffLine> => {
  const out: DiffLine[] = []
  let oldLn = 0
  let newLn = 0
  let inHunk = false
  for (const raw of diff.split("\n")) {
    const hunk = HUNK_RE.exec(raw)
    if (hunk !== null) {
      newLn = Number(hunk[1])
      // `@@ -a,b +c,d @@` carries the old start in the first group of the match.
      oldLn = Number(/-(\d+)/.exec(raw)?.[1] ?? newLn)
      inHunk = true
      out.push({ kind: "hunk", text: raw })
      continue
    }
    if (!inHunk) continue // skip Index:/===/---/+++ preamble
    const marker = raw[0]
    if (marker === "+") out.push({ kind: "add", text: raw.slice(1), lineNo: newLn++ })
    else if (marker === "-") out.push({ kind: "del", text: raw.slice(1), lineNo: oldLn++ })
    else if (marker === " ") {
      out.push({ kind: "context", text: raw.slice(1), lineNo: newLn })
      newLn++
      oldLn++
    } else if (raw !== "")
      // A "\ No newline…" marker or the "… diff truncated" footer: show verbatim,
      // with no gutter number and without advancing the line counts. The empty
      // trailing element from split("\n") falls through and is dropped.
      out.push({ kind: "context", text: raw })
  }
  return out
}

const COLOR: Record<DiffLineKind, string> = {
  add: "green",
  del: "red",
  context: theme.muted,
  hunk: theme.faint,
}

const SIGN: Record<DiffLineKind, string> = { add: "+", del: "-", context: " ", hunk: " " }

export interface DiffViewProps {
  readonly diff: string
  /** Total terminal width; lines are truncated to fit. */
  readonly width: number
}

const GUTTER = 4

/**
 * Syntax-highlighted unified-diff preview: an `+A -B` change summary, then a
 * faint line-number gutter with add/del coloring and per-line width truncation.
 * Every line renders — upstream `makeUnifiedDiff` already collapses unchanged
 * context and caps pathological diffs, so no row cap is applied here.
 */
export const DiffView = ({ diff, width }: DiffViewProps) => {
  const lines = parseDiff(diff)
  const added = lines.filter((l) => l.kind === "add").length
  const removed = lines.filter((l) => l.kind === "del").length
  const codeWidth = Math.max(8, width - GUTTER - 2)
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="green">+{added}</Text> <Text color="red">-{removed}</Text>
      </Text>
      {lines.map((line, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: static, order-stable diff rows
          key={i}
          color={COLOR[line.kind]}
        >
          <Text color={theme.faint}>
            {(line.lineNo !== undefined ? String(line.lineNo) : "").padStart(GUTTER)}{" "}
          </Text>
          {line.kind === "hunk" ? "" : `${SIGN[line.kind]} `}
          {clampCols(line.text, codeWidth)}
        </Text>
      ))}
    </Box>
  )
}
