import { useState } from "react"
import type { ModelVariantOption } from "../models"
import { ListSelect, type ListSelectItem } from "./ListSelect"

const DEFAULT = "__default__"

export interface VariantPickerProps {
  readonly variants: ReadonlyArray<ModelVariantOption>
  readonly current?: string
  readonly onSelect: (variant?: string) => void
  readonly onCancel: () => void
  readonly width: number
}

export const VariantPicker = ({
  variants,
  current,
  onSelect,
  onCancel,
  width,
}: VariantPickerProps) => {
  const [query, setQuery] = useState("")
  const items: ReadonlyArray<ListSelectItem<string>> = [
    { value: DEFAULT, label: "default", description: "no reasoning override" },
    ...variants.map((variant) => ({ value: variant.id, label: variant.label })),
  ]
  return (
    <ListSelect
      title="Select a variant"
      items={items}
      selected={current ?? DEFAULT}
      query={query}
      onQueryChange={setQuery}
      onSelect={(value) => onSelect(value === DEFAULT ? undefined : value)}
      onCancel={onCancel}
      width={width}
    />
  )
}
