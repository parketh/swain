import { readdirSync } from "node:fs"
import * as NodePath from "node:path"

const IGNORED = new Set([".git", "node_modules", "dist", ".swain"])
const DEFAULT_LIMIT = 20
/** Bounds the recursive walk so a huge tree can't stall the prompt. */
const MAX_VISITED = 10_000

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

interface Entry {
  readonly abs: string
  readonly isDirectory: boolean
}

/** Immediate, non-ignored children of `dir`; empty if it can't be read. */
const listEntries = (dir: string): ReadonlyArray<Entry> => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !IGNORED.has(e.name))
      .map((e) => ({ abs: NodePath.join(dir, e.name), isDirectory: e.isDirectory() }))
  } catch {
    return []
  }
}

/** Depth-first walk of `base`, pruning ignored dirs and capped at MAX_VISITED. */
const walkEntries = (base: string): ReadonlyArray<Entry> => {
  const out: Entry[] = []
  const stack = [base]
  while (stack.length > 0 && out.length < MAX_VISITED) {
    for (const entry of listEntries(stack.pop()!)) {
      out.push(entry)
      if (entry.isDirectory) stack.push(entry.abs)
    }
  }
  return out
}

/**
 * Finds files/directories for the token's final segment. An empty segment
 * (`@`, `@src/`, `@../`) browses that one directory; a non-empty segment
 * recursively searches the subtree, matching each entry's name by prefix
 * (ranked first) then substring. Results are returned relative to
 * `workingDirectory`, including `../` prefixes for `@../…` queries. Listing
 * never reads file contents and needs no approval.
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

  const entries = namePart === "" ? listEntries(base) : walkEntries(base)
  const depth = (p: string): number => p.split(NodePath.sep).length

  return (
    entries
      .map((entry) => ({
        entry,
        score: rank(NodePath.basename(entry.abs), namePart),
        path: NodePath.relative(workingDirectory, entry.abs),
      }))
      .filter(({ score }) => score >= 0)
      // Drop the working directory itself when listing a parent via `@../`.
      .filter(({ path }) => path !== "")
      .sort(
        (a, b) =>
          a.score - b.score || depth(a.path) - depth(b.path) || a.path.localeCompare(b.path),
      )
      .slice(0, limit)
      .map(({ entry, path }) => ({
        path,
        kind: entry.isDirectory ? ("directory" as const) : ("file" as const),
      }))
  )
}

/**
 * Replaces only the active token with `@relativePath`, preserving the rest. A
 * trailing space is appended (unless one already follows) so the token is no
 * longer active after selection — otherwise the picker stays open and Enter can
 * never submit the prompt.
 */
export const replaceToken = (
  text: string,
  token: FileToken,
  relativePath: string,
): { readonly text: string; readonly cursor: number } => {
  const before = text.slice(0, token.start)
  const after = text.slice(token.end)
  const insert = `@${relativePath}${/^\s/.test(after) ? "" : " "}`
  return { text: before + insert + after, cursor: before.length + insert.length }
}
