import { Box, Text, useInput } from "ink"
import { useState } from "react"

export interface ListSelectItem<Value> {
  readonly value: Value
  readonly label: string
  readonly description?: string
  readonly group?: string
  readonly disabled?: boolean
}

export interface ListSelectProps<Value> {
  readonly title: string
  readonly items: ReadonlyArray<ListSelectItem<Value>>
  readonly selected?: Value
  readonly query: string
  readonly onQueryChange: (query: string) => void
  readonly onSelect: (value: Value) => void
  readonly onCancel: () => void
}

export const filterItems = <Value,>(
  items: ReadonlyArray<ListSelectItem<Value>>,
  query: string,
): ReadonlyArray<ListSelectItem<Value>> => {
  if (query === "") return items
  const needle = query.toLowerCase()
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(needle) ||
      (item.description?.toLowerCase().includes(needle) ?? false),
  )
}

/** Reusable keyboard-driven picker: type to filter, Up/Down, Enter, Esc. */
export const ListSelect = <Value,>({
  title,
  items,
  selected,
  query,
  onQueryChange,
  onSelect,
  onCancel,
}: ListSelectProps<Value>) => {
  const filtered = filterItems(items, query)
  const [highlight, setHighlight] = useState(0)
  const index = Math.min(highlight, Math.max(0, filtered.length - 1))

  useInput((input, key) => {
    if (key.escape) return onCancel()
    if (key.upArrow) return setHighlight((h) => Math.max(0, h - 1))
    if (key.downArrow) return setHighlight((h) => Math.min(filtered.length - 1, h + 1))
    if (key.return) {
      const item = filtered[index]
      if (item !== undefined && item.disabled !== true) onSelect(item.value)
      return
    }
    if (key.backspace || key.delete) return onQueryChange(query.slice(0, -1))
    if (input && !key.ctrl && !key.meta) onQueryChange(query + input)
  })

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dimColor>{`filter: ${query}`}</Text>
      {filtered.length === 0 ? (
        <Text dimColor>no matches</Text>
      ) : (
        filtered.map((item, i) => {
          const active = i === index
          const isSelected = selected !== undefined && item.value === selected
          return (
            <Text key={item.label} color={item.disabled ? "gray" : active ? "cyan" : undefined}>
              {active ? "› " : "  "}
              {item.label}
              {isSelected ? " (current)" : ""}
              {item.description !== undefined ? ` — ${item.description}` : ""}
            </Text>
          )
        })
      )}
    </Box>
  )
}
