import { Effect } from "effect"
import { LLMError } from "../schema"

export type Auth =
  | { readonly _tag: "none" }
  | { readonly _tag: "bearer"; readonly token: string }
  | { readonly _tag: "header"; readonly name: string; readonly value: string }

const none: Auth = { _tag: "none" }

const bearer = (token: string): Auth => ({ _tag: "bearer", token })

const header = (name: string, value: string): Auth => ({ _tag: "header", name, value })

/**
 * Resolves a credential from an explicit value, falling back to an
 * environment variable. Missing credentials fail with `auth-failed`.
 */
const resolveSecret = (options: {
  readonly value?: string
  readonly env?: string
  readonly subject: string
}): Effect.Effect<string, LLMError> =>
  Effect.suspend(() => {
    if (options.value !== undefined && options.value !== "") {
      return Effect.succeed(options.value)
    }
    const fromEnv = options.env === undefined ? undefined : process.env[options.env]
    if (fromEnv !== undefined && fromEnv !== "") {
      return Effect.succeed(fromEnv)
    }
    const hint = options.env === undefined ? "" : ` (set ${options.env})`
    return Effect.fail(
      new LLMError({
        reason: "auth-failed",
        message: `Missing credentials for ${options.subject}${hint}`,
        retryable: false,
      }),
    )
  })

const toHeaders = (auth: Auth): Record<string, string> => {
  switch (auth._tag) {
    case "none":
      return {}
    case "bearer":
      return { Authorization: `Bearer ${auth.token}` }
    case "header":
      return { [auth.name]: auth.value }
  }
}

/** Merges header layers left-to-right into a fresh object; inputs are never mutated. */
const mergeHeaders = (
  ...layers: ReadonlyArray<Record<string, string> | undefined>
): Record<string, string> => {
  const merged: Record<string, string> = {}
  for (const layer of layers) {
    if (layer !== undefined) {
      Object.assign(merged, layer)
    }
  }
  return merged
}

export const Auth = {
  none,
  bearer,
  header,
  resolveSecret,
  toHeaders,
  mergeHeaders,
}
