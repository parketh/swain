import { Box, Text, useInput } from "ink"
import { useState } from "react"
import type { RouterModelView, RouterView } from "../controller"
import { isMouseEvent } from "../mouse"
import { theme } from "../theme"
import { fillPad } from "./overlayFill"

export interface RouterDialogProps {
  readonly view: RouterView
  readonly onToggleEnabled: () => void
  readonly onToggleModel: (provider: string, modelId: string) => void
  readonly onToggleTarget: (targetId: string) => void
  readonly onCancel: () => void
  readonly width?: number
}

/** Bracketed list of a model's enabled variants, or `[default]` for none. */
export const enabledVariantLabel = (model: RouterModelView): string => {
  if (model.variants.length === 0) return "[default]"
  const enabled = model.variants.filter((v) => v.enabled).map((v) => v.label)
  return `[${enabled.join(", ")}]`
}

const targetId = (provider: string, modelId: string, variant: string): string =>
  `${provider}:${modelId}:${variant}`

// Model-first router config: a global toggle plus one row per connected model,
// each showing its enabled variants; Right opens a one-level variant submenu.
export const RouterDialog = ({
  view,
  onToggleEnabled,
  onToggleModel,
  onToggleTarget,
  onCancel,
  width,
}: RouterDialogProps) => {
  // Main rows: index 0 is the global toggle, 1..n are the models.
  const [index, setIndex] = useState(0)
  const [submenu, setSubmenu] = useState<RouterModelView | undefined>(undefined)
  const [subIndex, setSubIndex] = useState(0)

  const rowCount = view.models.length + 1

  useInput((input, key) => {
    if (isMouseEvent(input)) return
    if (submenu !== undefined) {
      if (key.escape || key.leftArrow) return setSubmenu(undefined)
      if (key.upArrow) return setSubIndex((i) => Math.max(0, i - 1))
      if (key.downArrow) return setSubIndex((i) => Math.min(submenu.variants.length - 1, i + 1))
      if (key.return) {
        const variant = submenu.variants[subIndex]
        if (variant !== undefined)
          onToggleTarget(targetId(submenu.provider, submenu.modelId, variant.id))
      }
      return
    }
    if (key.escape) return onCancel()
    if (key.upArrow) return setIndex((i) => Math.max(0, i - 1))
    if (key.downArrow) return setIndex((i) => Math.min(rowCount - 1, i + 1))
    if (key.return) {
      if (index === 0) return onToggleEnabled()
      const model = view.models[index - 1]
      if (model !== undefined) onToggleModel(model.provider, model.modelId)
      return
    }
    if (key.rightArrow && index > 0) {
      const model = view.models[index - 1]
      if (model !== undefined && model.variants.length > 0) {
        setSubIndex(0)
        setSubmenu(model)
      }
    }
  })

  if (submenu !== undefined) {
    return (
      <Box flexDirection="column">
        <Text bold>
          {submenu.label} variants{fillPad(`${submenu.label} variants`.length, width)}
        </Text>
        <Text color={theme.muted}>
          Enter toggles · Esc/← back{fillPad("Enter toggles · Esc/← back".length, width)}
        </Text>
        {submenu.variants.map((variant, i) => {
          const active = i === subIndex
          const mark = variant.enabled ? "[x]" : "[ ]"
          const raw = `${mark} ${variant.label}`
          return (
            <Text key={variant.id} color={active ? "cyan" : undefined}>
              {active ? "› " : "  "}
              {raw}
              {fillPad(raw.length + 2, width)}
            </Text>
          )
        })}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold>Router configuration{fillPad("Router configuration".length, width)}</Text>
      <Text color={theme.muted}>
        Enter toggles · → variants · Esc close
        {fillPad("Enter toggles · → variants · Esc close".length, width)}
      </Text>
      <Text color={index === 0 ? "cyan" : view.enabled ? "green" : "gray"}>
        {index === 0 ? "› " : "  "}
        {`Routing: ${view.enabled ? "on" : "off"} (${view.status})`}
        {fillPad(`Routing: ${view.enabled ? "on" : "off"} (${view.status})`.length + 2, width)}
      </Text>
      {view.models.length === 0 ? (
        <Text color="yellow">
          No connected models. Run /connect first.
          {fillPad("No connected models. Run /connect first.".length, width)}
        </Text>
      ) : (
        view.models.map((model, i) => {
          const active = i + 1 === index
          const label = `${model.enabled ? "[x]" : "[ ]"} ${model.modelId} ${enabledVariantLabel(model)}`
          return (
            <Text
              key={`${model.provider}:${model.modelId}`}
              color={active ? "cyan" : model.enabled ? undefined : "gray"}
            >
              {active ? "› " : "  "}
              {label}
              {fillPad(label.length + 2, width)}
            </Text>
          )
        })
      )}
    </Box>
  )
}
