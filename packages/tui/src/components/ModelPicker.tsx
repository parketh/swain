import { Box, Text } from "ink"
import { useState } from "react"
import type { ActiveModel } from "../config"
import { type MergedModelOption, type ModelOption, mergeModelsByProvider } from "../models"
import { ListSelect, type ListSelectItem } from "./ListSelect"

export interface ModelPickerProps {
  readonly models: ReadonlyArray<ModelOption>
  readonly active: ActiveModel
  readonly onSelect: (provider: string, modelId: string) => void
  readonly onCancel: () => void
  readonly width: number
}

export const ModelPicker = ({ models, active, onSelect, onCancel, width }: ModelPickerProps) => {
  const [query, setQuery] = useState("")
  const [providerQuery, setProviderQuery] = useState("")
  const [chosen, setChosen] = useState<MergedModelOption | undefined>(undefined)

  const back = () => {
    setProviderQuery("")
    setChosen(undefined)
  }

  if (models.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No configured models. Run /connect to add a provider.</Text>
      </Box>
    )
  }

  // Second step: the chosen model is served by multiple providers, so pick one.
  if (chosen !== undefined) {
    const items: ReadonlyArray<ListSelectItem<string>> = chosen.providers.map((p) => ({
      value: p.provider,
      label: p.providerLabel,
    }))
    return (
      <ListSelect
        key="providers"
        title={`Select a provider for ${chosen.modelId}`}
        items={items}
        selected={active.modelId === chosen.modelId ? active.provider : undefined}
        query={providerQuery}
        onQueryChange={setProviderQuery}
        onSelect={(provider) => onSelect(provider, chosen.modelId)}
        onCancel={back}
        onLeft={back}
        width={width}
      />
    )
  }

  const merged = mergeModelsByProvider(models)
  const items: ReadonlyArray<ListSelectItem<string>> = merged.map((model) => ({
    value: model.modelId,
    label: model.modelId,
    description: model.providers.map((p) => p.providerLabel).join(", "),
  }))
  // Right drills into the provider level; only meaningful when there's a choice.
  const drill = (modelId: string): void => {
    const model = merged.find((m) => m.modelId === modelId)
    if (model !== undefined && model.providers.length > 1) setChosen(model)
  }
  return (
    <ListSelect
      key="models"
      title="Select a model"
      items={items}
      selected={active.modelId}
      query={query}
      onQueryChange={setQuery}
      onSelect={(modelId) => {
        const model = merged.find((m) => m.modelId === modelId)
        if (model === undefined) return
        // Single provider: no second step; multiple: defer to the provider picker.
        const only = model.providers.length === 1 ? model.providers[0] : undefined
        if (only !== undefined) return onSelect(only.provider, model.modelId)
        setChosen(model)
      }}
      onRight={drill}
      onCancel={onCancel}
      width={width}
    />
  )
}
