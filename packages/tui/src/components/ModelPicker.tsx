import { Box, Text } from "ink"
import { useState } from "react"
import type { ActiveModel } from "../config"
import type { ModelOption } from "../models"
import { ListSelect, type ListSelectItem } from "./ListSelect"

export interface ModelPickerProps {
  readonly models: ReadonlyArray<ModelOption>
  readonly active: ActiveModel
  readonly onSelect: (provider: string, modelId: string) => void
  readonly onCancel: () => void
}

const keyOf = (provider: string, modelId: string): string => `${provider} ${modelId}`

export const ModelPicker = ({ models, active, onSelect, onCancel }: ModelPickerProps) => {
  const [query, setQuery] = useState("")
  if (models.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No configured models. Run /connect to add a provider.</Text>
      </Box>
    )
  }
  const items: ReadonlyArray<ListSelectItem<string>> = models.map((model) => ({
    value: keyOf(model.provider, model.modelId),
    label: model.modelId,
    description: model.providerLabel,
    group: model.providerLabel,
  }))
  return (
    <ListSelect
      title="Select a model"
      items={items}
      selected={keyOf(active.provider, active.modelId)}
      query={query}
      onQueryChange={setQuery}
      onSelect={(value) => {
        const [provider, modelId] = value.split(" ")
        if (provider !== undefined && modelId !== undefined) onSelect(provider, modelId)
      }}
      onCancel={onCancel}
    />
  )
}
