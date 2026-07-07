import { Box, Text } from "ink"
import type { ReactNode } from "react"
import { theme } from "../theme"

// Inline spans, tried left-to-right at the earliest match: bold, italic,
// inline code, links. Bold is listed before italic so `**x**` binds greedily
// to the two-star alternative instead of the single-star one.
const INLINE_RE = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|`([^`]+?)`|\[([^\]]+)\]\(([^)]+)\)/

const renderInline = (text: string, keyPrefix: string): ReactNode[] => {
  const out: ReactNode[] = []
  let rest = text
  let i = 0
  while (rest.length > 0) {
    const m = INLINE_RE.exec(rest)
    if (m === null) {
      out.push(rest)
      break
    }
    if (m.index > 0) out.push(rest.slice(0, m.index))
    const key = `${keyPrefix}-${i++}`
    if (m[1] !== undefined)
      out.push(
        <Text key={key} bold>
          {renderInline(m[2] ?? "", key)}
        </Text>,
      )
    else if (m[3] !== undefined)
      out.push(
        <Text key={key} italic>
          {renderInline(m[4] ?? "", key)}
        </Text>,
      )
    else if (m[5] !== undefined)
      out.push(
        <Text key={key} color={theme.primary}>
          {m[5]}
        </Text>,
      )
    else
      out.push(
        <Text key={key} underline color={theme.primary}>
          {m[6]}
        </Text>,
      )
    rest = rest.slice(m.index + m[0].length)
  }
  return out
}

const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/
const HEADING_RE = /^(#{1,6})\s+(.*)$/

export interface MarkdownProps {
  readonly children: string
  /** Base color for plain text (defaults to the terminal foreground). */
  readonly color?: string
}

/**
 * Minimal markdown renderer for the transcript. Handles headings, bullet and
 * numbered lists, fenced code blocks, blockquotes, horizontal rules, and inline
 * bold/italic/code/links — the subset that assistant responses actually use.
 * Deliberately line-oriented rather than a full AST parse.
 */
export const Markdown = ({ children, color }: MarkdownProps) => {
  const lines = children.replace(/\n+$/, "").split("\n")
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0
  let prevBlank = true

  while (i < lines.length) {
    const line = lines[i] ?? ""
    const trimmed = line.trim()

    if (trimmed === "") {
      if (!prevBlank) {
        blocks.push(<Text key={key++}> </Text>)
        prevBlank = true
      }
      i++
      continue
    }
    prevBlank = false

    if (/^```/.test(trimmed)) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test((lines[i] ?? "").trim())) {
        buf.push(lines[i] ?? "")
        i++
      }
      i++ // consume closing fence
      blocks.push(
        <Box key={key++} flexDirection="column" paddingLeft={1}>
          {buf.map((l, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static code lines
            <Text key={j} color={theme.muted}>
              {l === "" ? " " : l}
            </Text>
          ))}
        </Box>,
      )
      continue
    }

    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      blocks.push(
        <Text key={key++} color={theme.faint}>
          ────────
        </Text>,
      )
      i++
      continue
    }

    const heading = HEADING_RE.exec(trimmed)
    if (heading) {
      blocks.push(
        <Text key={key++} bold color={theme.primary}>
          {renderInline(heading[2] ?? "", `h${key}`)}
        </Text>,
      )
      i++
      continue
    }

    if (trimmed.startsWith("> ")) {
      blocks.push(
        <Text key={key++} color={theme.muted}>
          {"▎ "}
          {renderInline(trimmed.slice(2), `q${key}`)}
        </Text>,
      )
      i++
      continue
    }

    const list = LIST_RE.exec(line)
    if (list) {
      const indent = Math.floor((list[1]?.length ?? 0) / 2)
      const marker = /\d/.test(list[2] ?? "") ? `${list[2]} ` : "• "
      blocks.push(
        <Box key={key++} paddingLeft={indent + 1} flexDirection="row">
          <Text color={color}>{marker}</Text>
          <Text color={color}>{renderInline(list[3] ?? "", `li${key}`)}</Text>
        </Box>,
      )
      i++
      continue
    }

    blocks.push(
      <Text key={key++} color={color}>
        {renderInline(line, `p${key}`)}
      </Text>,
    )
    i++
  }

  return <Box flexDirection="column">{blocks}</Box>
}
