import type { ProviderConfig } from "./config"
import { environmentCredentialSources } from "./models"

/**
 * Minimum length for a value to be treated as a redactable secret. Short values
 * (a few characters) would collide with ordinary text and corrupt output, so
 * they are never globally replaced; real API keys and tokens far exceed this.
 */
export const MIN_SECRET_LENGTH = 8

export const REDACTED = "[REDACTED]"

type Env = Record<string, string | undefined>

/**
 * Collects the exact secret values to redact: every non-empty `apiKey`,
 * `accessToken`, and `refreshToken` from the loaded provider config plus the
 * supported environment credential overlays. Deduplicated, and sorted longest
 * first so an embedded shorter secret can't pre-empt a longer one.
 */
export const collectSecrets = (
  providers: Readonly<Record<string, ProviderConfig>> | undefined,
  env: Env,
): ReadonlyArray<string> => {
  const secrets = new Set<string>()
  const add = (value: string | undefined): void => {
    if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) secrets.add(value)
  }
  for (const creds of Object.values(providers ?? {})) {
    add(creds.apiKey)
    add(creds.accessToken)
    add(creds.refreshToken)
  }
  for (const source of environmentCredentialSources) add(env[source.envVar])
  return [...secrets].sort((a, b) => b.length - a.length)
}

/**
 * Builds a recursive redactor over the given secrets: any string containing an
 * exact secret has each occurrence replaced with `[REDACTED]`, walking arrays
 * and plain objects. The guarantee is exact known-value redaction only — a model
 * that transforms or splits a secret defeats it, which no deterministic redactor
 * can prevent. Returns an identity function when there are no secrets to redact.
 */
export const makeRedactor = (secrets: ReadonlyArray<string>): (<T>(value: T) => T) => {
  // Sort longest-first here (not only in `collectSecrets`) so any caller gets
  // correct overlapping-secret redaction: a longer secret is replaced before a
  // shorter one it contains can pre-empt it.
  const active = secrets
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
  if (active.length === 0) return (value) => value

  const redactString = (input: string): string => {
    let output = input
    for (const secret of active) {
      if (output.includes(secret)) output = output.split(secret).join(REDACTED)
    }
    return output
  }

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return redactString(value)
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === "object") {
      const output: Record<string, unknown> = {}
      for (const [key, nested] of Object.entries(value)) output[key] = walk(nested)
      return output
    }
    return value
  }

  return (value) => walk(value) as typeof value
}

export type Redactor = ReturnType<typeof makeRedactor>
