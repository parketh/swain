import { Box, Text } from "ink"
import { useState } from "react"
import type { SavedSession } from "../controller"
import { ListSelect, type ListSelectItem } from "./ListSelect"

export interface ResumePickerProps {
  readonly sessions: ReadonlyArray<SavedSession>
  readonly onSelect: (sessionId: string) => void
  readonly onCancel: () => void
}

export const ResumePicker = ({ sessions, onSelect, onCancel }: ResumePickerProps) => {
  const [query, setQuery] = useState("")
  if (sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No saved sessions to resume.</Text>
      </Box>
    )
  }
  const items: ReadonlyArray<ListSelectItem<string>> = sessions.map((saved) => ({
    value: saved.sessionId,
    label: saved.sessionId.slice(0, 8),
    description: new Date(saved.modifiedMs).toISOString(),
  }))
  return (
    <ListSelect
      title="Resume a session"
      items={items}
      query={query}
      onQueryChange={setQuery}
      onSelect={onSelect}
      onCancel={onCancel}
    />
  )
}
