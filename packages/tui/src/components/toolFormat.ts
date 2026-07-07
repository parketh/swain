// Per-tool, one-line summaries for tool calls and results, replacing raw JSON
// dumps in the transcript. Unknown tools fall back to compact key/value pairs.

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** Collapse an absolute path under the cwd to a relative display form. */
const displayPath = (path: string): string => {
  const cwd = process.cwd()
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

const join = (parts: ReadonlyArray<string | undefined>): string =>
  parts.filter((p): p is string => p !== undefined && p !== "").join(" ")

/** Concise argument summary for a tool call, keyed by tool name. */
export const formatToolUse = (name: string, input: unknown): string => {
  const a = asRecord(input)
  switch (name) {
    case "Grep":
      return join([
        str(a.pattern) && `"${str(a.pattern)}"`,
        str(a.path) && displayPath(str(a.path) as string),
        str(a.glob),
      ])
    case "Glob":
      return join([str(a.pattern), str(a.path) && displayPath(str(a.path) as string)])
    case "Read":
    case "Write":
    case "Edit":
      return str(a.path) ? displayPath(str(a.path) as string) : ""
    case "Bash":
      return truncate(str(a.command) ?? "", 80)
    case "WebFetch":
      return str(a.url) ?? ""
    case "WebSearch":
      return str(a.query) ?? ""
    default: {
      const entries = Object.entries(a)
      if (entries.length === 0) return ""
      return truncate(
        entries
          .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join(", "),
        100,
      )
    }
  }
}

const count = (n: number, singular: string): string => {
  if (n === 1) return `${n} ${singular}`
  const plural = /(s|x|z|ch|sh)$/.test(singular) ? `${singular}es` : `${singular}s`
  return `${n} ${plural}`
}

/** Short, human-readable summary of a tool result value. */
export const summarizeResult = (name: string, value: unknown, isError: boolean): string => {
  if (isError) {
    const text = typeof value === "string" ? value : JSON.stringify(value)
    return truncate(text.replace(/\s+/g, " ").trim(), 160)
  }

  if (typeof value === "object" && value !== null) {
    const a = value as Record<string, unknown>
    if (name === "Grep" && Array.isArray(a.matches))
      return `Found ${count(a.matches.length, "match")}`
    if (name === "Glob" && Array.isArray(a.matches))
      return `Found ${count(a.matches.length, "file")}`
    if (name === "Read" && typeof a.text === "string")
      return count(a.text.split("\n").length, "line")
    if (name === "Write" && typeof a.bytesWritten === "number")
      return `Wrote ${count(a.bytesWritten, "byte")}`
    if (name === "Bash" && typeof a.exitCode === "number") {
      const first = str(a.stdout)
        ?.split("\n")
        .find((l) => l.trim() !== "")
      return first ? truncate(first, 160) : `Exit ${a.exitCode}`
    }
  }

  const text = typeof value === "string" ? value : JSON.stringify(value)
  const lines = text.split("\n").filter((l) => l.trim() !== "")
  const first = lines[0] ?? ""
  const extra = lines.length > 1 ? ` (+${count(lines.length - 1, "line")})` : ""
  return `${truncate(first.trim(), 160)}${extra}`
}
