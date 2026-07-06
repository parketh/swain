import { Box, Text, useInput } from "ink"
import { useState } from "react"
import type { ProviderConfig } from "../config"
import type { CredentialField, ProviderOption } from "../models"
import { theme } from "../theme"
import { ListSelect, type ListSelectItem } from "./ListSelect"

export interface ConnectDialogProps {
  readonly providers: ReadonlyArray<ProviderOption>
  readonly onSubmit: (provider: string, creds: ProviderConfig) => void
  readonly onCancel: () => void
  /** Preselect a provider (from `/connect <provider>`); skips the picker. */
  readonly initialProvider?: string
}

const fieldLabel: Record<CredentialField, string> = {
  apiKey: "API key",
  baseURL: "Base URL",
  accountId: "Account id",
  accessToken: "Access token",
}

const CredentialForm = ({
  provider,
  onSubmit,
  onCancel,
}: {
  readonly provider: ProviderOption
  readonly onSubmit: (creds: ProviderConfig) => void
  readonly onCancel: () => void
}) => {
  const fields: ReadonlyArray<CredentialField> = [
    ...provider.requiredFields,
    ...provider.optionalFields,
  ]
  const [values, setValues] = useState<Record<string, string>>({})
  const [active, setActive] = useState(0)

  const build = (): ProviderConfig => {
    const creds: Record<string, string> = {}
    for (const field of fields) {
      const value = values[field]
      if (value !== undefined && value !== "") creds[field] = value
    }
    return creds as ProviderConfig
  }

  useInput((input, key) => {
    if (key.escape) return onCancel()
    if (key.return) {
      if (active < fields.length - 1) return setActive((a) => a + 1)
      return onSubmit(build())
    }
    if (key.backspace || key.delete) {
      const field = fields[active]
      if (field !== undefined) setValues((v) => ({ ...v, [field]: (v[field] ?? "").slice(0, -1) }))
      return
    }
    if (input && !key.ctrl && !key.meta) {
      const field = fields[active]
      if (field !== undefined) setValues((v) => ({ ...v, [field]: (v[field] ?? "") + input }))
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Connect {provider.label}</Text>
      {fields.map((field, i) => {
        const required = provider.requiredFields.includes(field)
        const raw = values[field] ?? ""
        const masked = field === "apiKey" || field === "accessToken" ? "*".repeat(raw.length) : raw
        return (
          <Text key={field} color={i === active ? "cyan" : undefined}>
            {i === active ? "› " : "  "}
            {fieldLabel[field]}
            {required ? "*" : ""}: {masked}
          </Text>
        )
      })}
      <Text color={theme.muted}>
        Enter to advance · Enter on the last field to save · Esc to cancel
      </Text>
    </Box>
  )
}

export const ConnectDialog = ({
  providers,
  onSubmit,
  onCancel,
  initialProvider,
}: ConnectDialogProps) => {
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<string | undefined>(initialProvider)
  const provider = providers.find((p) => p.id === selected)

  if (provider !== undefined) {
    return (
      <CredentialForm
        provider={provider}
        onSubmit={(creds) => onSubmit(provider.id, creds)}
        onCancel={onCancel}
      />
    )
  }

  const items: ReadonlyArray<ListSelectItem<string>> = [...providers]
    .sort((a, b) => Number(b.popular) - Number(a.popular))
    .map((p) => ({
      value: p.id,
      label: p.label,
      description: p.configured ? `configured ${p.redactedKey ?? ""}`.trim() : "not configured",
    }))

  return (
    <ListSelect
      title="Connect a provider"
      items={items}
      query={query}
      onQueryChange={setQuery}
      onSelect={setSelected}
      onCancel={onCancel}
    />
  )
}
