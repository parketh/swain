import { useState } from "react"
import type { ModelVariantOption } from "../models"
import { ListSelect, type ListSelectItem } from "./ListSelect"

const NONE = "__none__"

export interface VariantPickerProps {
  readonly variants: ReadonlyArray<ModelVariantOption>
  readonly current?: string
  readonly onSelect: (variant?: string) => void
  readonly onCancel: () => void
  /** Left-arrow: step back to the previous menu level. Omit to leave it inert. */
  readonly onBack?: () => void
  readonly title?: string
  readonly width: number
}

export const VariantPicker = ({
  variants,
  current,
  onSelect,
  onCancel,
  onBack,
  title = "Select a variant",
  width,
}: VariantPickerProps) => {
  const [query, setQuery] = useState("")
  const defaultId = variants.find((v) => v.default === true)?.id
  const items: ReadonlyArray<ListSelectItem<string>> = [
    ...variants.map((variant) => ({
      value: variant.id,
      label: variant.label,
      ...(variant.default === true && { description: "default" }),
    })),
    { value: NONE, label: "none", description: "no reasoning override" },
  ]
  // Start the cursor on the current variant, else the default, so Enter picks
  // the sensible choice rather than the first (lowest) effort.
  const startValue = current ?? defaultId ?? NONE
  const initialIndex = Math.max(
    0,
    items.findIndex((item) => item.value === startValue),
  )
  return (
    <ListSelect
      title={title}
      items={items}
      selected={current ?? defaultId ?? NONE}
      initialIndex={initialIndex}
      query={query}
      onQueryChange={setQuery}
      onSelect={(value) => onSelect(value === NONE ? undefined : value)}
      {...(onBack !== undefined && { onLeft: () => onBack() })}
      onCancel={onCancel}
      width={width}
    />
  )
}
