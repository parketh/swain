import { createPatch } from "diff"

export interface UnifiedDiff {
  readonly format: "unified"
  readonly text: string
  readonly truncated: boolean
}

const MAX_DIFF_LINES = 400

/** Derives a unified diff from before/after contents, truncating large diffs. */
export const makeUnifiedDiff = (path: string, oldText: string, newText: string): UnifiedDiff => {
  const patch = createPatch(path, oldText, newText)
  const lines = patch.split("\n")
  if (lines.length <= MAX_DIFF_LINES) {
    return { format: "unified", text: patch, truncated: false }
  }
  return {
    format: "unified",
    text: `${lines.slice(0, MAX_DIFF_LINES).join("\n")}\n… diff truncated`,
    truncated: true,
  }
}
