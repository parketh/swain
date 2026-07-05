import { Box, Text } from "ink"
import type { FileMatch } from "../fs"

export interface FileSearchProps {
  readonly matches: ReadonlyArray<FileMatch>
  readonly highlight: number
}

export const FileSearch = ({ matches, highlight }: FileSearchProps) => {
  if (matches.length === 0) return null
  return (
    <Box flexDirection="column">
      {matches.map((match, i) => (
        <Text key={match.path} color={i === highlight ? "cyan" : undefined}>
          {i === highlight ? "› " : "  "}
          {match.path}
          {match.kind === "directory" ? "/" : ""}
        </Text>
      ))}
    </Box>
  )
}
