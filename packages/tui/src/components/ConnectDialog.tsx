import { Box, Text, useInput } from "ink"
import { useEffect, useRef, useState } from "react"
import type { ProviderConfig } from "../config"
import type { ConnectResult } from "../controller"
import type { CredentialField, ProviderOption } from "../models"
import { isMouseEvent } from "../mouse"
import { theme } from "../theme"
import { ListSelect, type ListSelectItem } from "./ListSelect"

export interface ConnectDialogProps {
  readonly providers: ReadonlyArray<ProviderOption>
  readonly onSubmit: (provider: string, creds: ProviderConfig) => void
  /** Runs the browser OAuth login for an OAuth provider (Codex). `onUrl` receives
   * the authorize URL for manual sign-in when the browser can't be opened; `signal`
   * aborts the login when the dialog is cancelled. */
  readonly onOAuthLogin: (
    provider: string,
    onUrl: (url: string) => void,
    signal: AbortSignal,
  ) => Promise<ConnectResult>
  /** Called after a successful OAuth login, once the user acknowledges it. */
  readonly onOAuthComplete: () => void
  readonly onCancel: () => void
  /** Preselect a provider (from `/connect <provider>`); skips the picker. */
  readonly initialProvider?: string
}

const OAUTH_TIMEOUT_S = 180

const OAuthPanel = ({
  provider,
  onLogin,
  onComplete,
  onCancel,
}: {
  readonly provider: ProviderOption
  readonly onLogin: (onUrl: (url: string) => void, signal: AbortSignal) => Promise<ConnectResult>
  readonly onComplete: () => void
  readonly onCancel: () => void
}) => {
  const [phase, setPhase] = useState<"idle" | "running" | "success" | "error">("idle")
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [url, setUrl] = useState<string | undefined>(undefined)
  const [remaining, setRemaining] = useState(OAUTH_TIMEOUT_S)
  const abortRef = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    if (phase !== "running") return
    const id = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000)
    return () => clearInterval(id)
  }, [phase])

  // Abort an in-flight login when the panel unmounts (Esc/cancel), so the callback
  // server is torn down instead of lingering until its own timeout.
  useEffect(() => () => abortRef.current?.abort(), [])

  const start = (): void => {
    setPhase("running")
    setRemaining(OAUTH_TIMEOUT_S)
    setUrl(undefined)
    const controller = new AbortController()
    abortRef.current = controller
    void onLogin(setUrl, controller.signal).then((result) => {
      if (result.ok) {
        setMessage(result.accountId)
        setPhase("success")
      } else {
        setMessage(result.error)
        setPhase("error")
      }
    })
  }

  useInput((input, key) => {
    if (isMouseEvent(input)) return
    if (key.escape) return onCancel()
    if (!key.return) return
    if (phase === "idle" || phase === "error") return start()
    if (phase === "success") return onComplete()
  })

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Connect {provider.label}</Text>
      {phase === "idle" ? (
        <Text>Press Enter to sign in with your browser.</Text>
      ) : phase === "running" ? (
        <Box flexDirection="column">
          <Text color="cyan">Opening browser… waiting for sign-in ({remaining}s)</Text>
          {url !== undefined && <Text color={theme.muted}>Or open this URL manually: {url}</Text>}
        </Box>
      ) : phase === "success" ? (
        <Text color="green">
          Signed in{message !== undefined ? ` as ${message}` : ""}. Press Enter to continue.
        </Text>
      ) : (
        <Text color="red">Login failed: {message ?? "unknown error"}. Press Enter to retry.</Text>
      )}
      <Text color={theme.muted}>Esc to cancel</Text>
    </Box>
  )
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
  const fields: ReadonlyArray<CredentialField> = provider.requiredFields
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
    if (isMouseEvent(input)) return
    if (key.escape) return onCancel()
    if (key.upArrow) return setActive((a) => Math.max(0, a - 1))
    if (key.downArrow) return setActive((a) => Math.min(fields.length - 1, a + 1))
    if (key.return) return onSubmit(build())
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
        const value = values[field] ?? ""
        return (
          <Text key={field} color={i === active ? "cyan" : undefined}>
            {i === active ? "› " : "  "}
            {fieldLabel[field]}: {value}
          </Text>
        )
      })}
      <Text color={theme.muted}>↑/↓ to move · Enter to save · Esc to cancel</Text>
    </Box>
  )
}

export const ConnectDialog = ({
  providers,
  onSubmit,
  onOAuthLogin,
  onOAuthComplete,
  onCancel,
  initialProvider,
}: ConnectDialogProps) => {
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<string | undefined>(initialProvider)
  const provider = providers.find((p) => p.id === selected)

  if (provider !== undefined) {
    if (provider.auth === "oauth") {
      return (
        <OAuthPanel
          provider={provider}
          onLogin={(onUrl, signal) => onOAuthLogin(provider.id, onUrl, signal)}
          onComplete={onOAuthComplete}
          onCancel={onCancel}
        />
      )
    }
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
