import { Box, Text, useInput } from "ink"
import { useState } from "react"
import { isMouseEvent } from "../mouse"
import { theme } from "../theme"
import { clampCols, fillPad } from "./overlayFill"

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
  /** Left arrow on the focused item; e.g. to step back up a nested menu level. */
  readonly onLeft?: (value: Value) => void
  /** Right arrow on the focused item; e.g. to drill into a nested menu level. */
  readonly onRight?: (value: Value) => void
  /** Row the cursor starts on (unfiltered index); defaults to the first row. */
  readonly initialIndex?: number
  /** Fills each row to this width so the floated menu occludes the transcript. */
  readonly width?: number
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
  onLeft,
  onRight,
  initialIndex,
  width,
}: ListSelectProps<Value>) => {
  const filtered = filterItems(items, query)
  const [highlight, setHighlight] = useState(initialIndex ?? 0)
  const index = Math.min(highlight, Math.max(0, filtered.length - 1))

  useInput((input, key) => {
    if (isMouseEvent(input)) return
    if (key.escape) return onCancel()
    if (key.upArrow) return setHighlight((h) => Math.max(0, h - 1))
    if (key.downArrow) return setHighlight((h) => Math.min(filtered.length - 1, h + 1))
    if (key.leftArrow && onLeft !== undefined) {
      const item = filtered[index]
      if (item !== undefined) onLeft(item.value)
      return
    }
    if (key.rightArrow && onRight !== undefined) {
      const item = filtered[index]
      if (item !== undefined) onRight(item.value)
      return
    }
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
      <Text>{fillPad(0, width)}</Text>
      <Text bold>
        {title}
        {fillPad(title.length, width)}
      </Text>
      <Text color={theme.muted}>
        {`filter: ${query}`}
        {fillPad(`filter: ${query}`.length, width)}
      </Text>
      {filtered.length === 0 ? (
        <Text color={theme.muted}>
          no matches
          {fillPad("no matches".length, width)}
        </Text>
      ) : (
        filtered.map((item, i) => {
          const active = i === index
          const isSelected = selected !== undefined && item.value === selected
          const prefix = active ? "› " : "  "
          const raw = `${item.label}${isSelected ? " (current)" : ""}${
            item.description !== undefined ? ` — ${item.description}` : ""
          }`
          const body =
            width === undefined ? raw : clampCols(raw, Math.max(0, width - prefix.length))
          return (
            <Text
              key={`${i}-${item.label}`}
              color={item.disabled ? "gray" : active ? "cyan" : undefined}
            >
              {prefix}
              {body}
              {fillPad(prefix.length + body.length, width)}
            </Text>
          )
        })
      )}
    </Box>
  )
}
