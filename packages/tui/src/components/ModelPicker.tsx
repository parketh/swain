import { Box, Text } from "ink"
import { useState } from "react"
import type { ActiveModel } from "../config"
import { type MergedModelOption, type ModelOption, mergeModelsByProvider } from "../models"
import { ListSelect, type ListSelectItem } from "./ListSelect"
import { VariantPicker } from "./VariantPicker"

export interface ModelPickerProps {
  readonly models: ReadonlyArray<ModelOption>
  readonly active: ActiveModel
  readonly onSelect: (provider: string, modelId: string, variant?: string) => void
  readonly onCancel: () => void
  readonly width: number
}

export const ModelPicker = ({ models, active, onSelect, onCancel, width }: ModelPickerProps) => {
  const [query, setQuery] = useState("")
  const [providerQuery, setProviderQuery] = useState("")
  const [chosen, setChosen] = useState<MergedModelOption | undefined>(undefined)
  const [chosenProvider, setChosenProvider] = useState<ModelOption | undefined>(undefined)

  const toModel = () => {
    setProviderQuery("")
    setChosen(undefined)
    setChosenProvider(undefined)
  }
  const toProvider = () => setChosenProvider(undefined)

  // Advance from a chosen provider: pick its variant, or commit when it has none.
  const enterProvider = (model: ModelOption): void => {
    if (model.variants.length === 0) return onSelect(model.provider, model.modelId)
    setChosenProvider(model)
  }

  if (models.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No configured models. Run /connect to add a provider.</Text>
      </Box>
    )
  }

  // Third step: pick the reasoning variant for the chosen model+provider.
  if (chosenProvider !== undefined) {
    const isActive =
      active.provider === chosenProvider.provider && active.modelId === chosenProvider.modelId
    // A single-provider model skips the provider step, so Left returns to models.
    const back = chosen !== undefined && chosen.providers.length > 1 ? toProvider : toModel
    return (
      <VariantPicker
        variants={chosenProvider.variants}
        {...(isActive && active.variant !== undefined && { current: active.variant })}
        title={`Select a variant for ${chosenProvider.modelId}`}
        onSelect={(variant) => onSelect(chosenProvider.provider, chosenProvider.modelId, variant)}
        onBack={back}
        onCancel={back}
        width={width}
      />
    )
  }

  // Second step: the chosen model is served by multiple providers, so pick one.
  if (chosen !== undefined) {
    const items: ReadonlyArray<ListSelectItem<string>> = chosen.providers.map((p) => ({
      value: p.provider,
      label: p.providerLabel,
    }))
    const enter = (provider: string): void => {
      const model = chosen.providers.find((p) => p.provider === provider)
      if (model !== undefined) enterProvider(model)
    }
    return (
      <ListSelect
        key="providers"
        title={`Select a provider for ${chosen.modelId}`}
        items={items}
        selected={active.modelId === chosen.modelId ? active.provider : undefined}
        query={providerQuery}
        onQueryChange={setProviderQuery}
        onSelect={enter}
        onRight={enter}
        onCancel={toModel}
        onLeft={toModel}
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
  // Enter/Right drill inward: to the provider step when there's a choice of
  // provider, otherwise straight to the single provider's variant step.
  const drill = (modelId: string): void => {
    const model = merged.find((m) => m.modelId === modelId)
    if (model === undefined) return
    const only = model.providers.length === 1 ? model.providers[0] : undefined
    if (only !== undefined) return enterProvider(only)
    setChosen(model)
  }
  return (
    <ListSelect
      key="models"
      title="Select a model"
      items={items}
      selected={active.modelId}
      query={query}
      onQueryChange={setQuery}
      onSelect={drill}
      onRight={drill}
      onCancel={onCancel}
      width={width}
    />
  )
}
