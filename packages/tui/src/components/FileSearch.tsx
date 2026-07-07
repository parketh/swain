import { Box, Text } from "ink"
import type { FileMatch } from "../fs"
import { clampCols, fillPad } from "./overlayFill"

export interface FileSearchProps {
  readonly matches: ReadonlyArray<FileMatch>
  readonly highlight: number
  /** Fills each row to this width so the floated menu occludes the transcript. */
  readonly width?: number
}

export const FileSearch = ({ matches, highlight, width }: FileSearchProps) => {
  if (matches.length === 0) return null
  return (
    <Box flexDirection="column">
      <Text>{fillPad(0, width)}</Text>
      {matches.map((match, i) => {
        const prefix = i === highlight ? "› " : "  "
        const raw = `${match.path}${match.kind === "directory" ? "/" : ""}`
        const body = width === undefined ? raw : clampCols(raw, Math.max(0, width - prefix.length))
        return (
          <Text key={match.path} color={i === highlight ? "cyan" : undefined}>
            {prefix}
            {body}
            {fillPad(prefix.length + body.length, width)}
          </Text>
        )
      })}
    </Box>
  )
}
