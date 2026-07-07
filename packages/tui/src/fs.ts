import { readdirSync } from "node:fs"
import * as NodePath from "node:path"

const IGNORED = new Set([".git", "node_modules", "dist", ".swain"])
const DEFAULT_LIMIT = 20

export interface FileToken {
  /** Text following `@`, i.e. the path/filename query. */
  readonly query: string
  /** Index of the `@` in the input. */
  readonly start: number
  /** Cursor index (end of the token). */
  readonly end: number
}

/**
 * Detects the active file-search token: the cursor must sit at the end of a
 * token starting with `@` that begins the input or follows whitespace. Returns
 * `undefined` for `@` embedded in other text (e.g. email addresses).
 */
export const detectFileToken = (
  text: string,
  cursor: number = text.length,
): FileToken | undefined => {
  const before = text.slice(0, cursor)
  const match = before.match(/(?:^|\s)@(\S*)$/)
  if (match === null) return undefined
  const query = match[1] ?? ""
  return { query, start: cursor - query.length - 1, end: cursor }
}

export interface FileMatch {
  /** Path relative to the working directory; may carry `../` prefixes. */
  readonly path: string
  readonly kind: "file" | "directory"
}

const rank = (name: string, needle: string): number => {
  if (needle === "") return 1
  const lowerName = name.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  if (lowerName.startsWith(lowerNeedle)) return 0
  if (lowerName.includes(lowerNeedle)) return 1
  return -1
}

/**
 * Lists files/directories in the directory indicated by the token's path
 * segment, matching the final segment by prefix (ranked first) then substring.
 * Results are returned relative to `workingDirectory`, including `../` prefixes
 * for `@../…` queries. Listing never reads file contents and needs no approval.
 */
export const searchFiles = (
  workingDirectory: string,
  query: string,
  limit: number = DEFAULT_LIMIT,
): ReadonlyArray<FileMatch> => {
  const slash = query.lastIndexOf("/")
  const dirPart = slash === -1 ? "" : query.slice(0, slash)
  const namePart = slash === -1 ? query : query.slice(slash + 1)
  const base = NodePath.resolve(workingDirectory, dirPart)

  let entries: ReadonlyArray<{ name: string; isDirectory: boolean }>
  try {
    entries = readdirSync(base, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }))
  } catch {
    return []
  }

  return (
    entries
      .filter((entry) => !IGNORED.has(entry.name))
      .map((entry) => ({ entry, score: rank(entry.name, namePart) }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name))
      .slice(0, limit)
      .map(({ entry }) => ({
        path: NodePath.relative(workingDirectory, NodePath.join(base, entry.name)),
        kind: entry.isDirectory ? ("directory" as const) : ("file" as const),
      }))
      // Drop the working directory itself when listing a parent via `@../`.
      .filter((match) => match.path !== "")
  )
}

/** Replaces only the active token with `@relativePath`, preserving the rest. */
export const replaceToken = (
  text: string,
  token: FileToken,
  relativePath: string,
): { readonly text: string; readonly cursor: number } => {
  const before = text.slice(0, token.start)
  const after = text.slice(token.end)
  const insert = `@${relativePath}`
  return { text: before + insert + after, cursor: before.length + insert.length }
}
