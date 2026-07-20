import { createHash, randomBytes } from "node:crypto"
import { FetchHttpClient } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { buildAuthorizeUrl, exchangeCode } from "@swain/llms/providers"
import { Effect } from "effect"
import { persistCodexCredentials } from "./codex-auth"

/** Server-registered callback port; cannot be randomized. */
export const CODEX_CALLBACK_PORT = 1455
const CALLBACK_PATH = "/auth/callback"
/** Roughly three minutes to complete the browser sign-in. */
const CALLBACK_TIMEOUT_MS = 180_000

export interface CodexPkce {
  /** The high-entropy secret, sent only on the code exchange. */
  readonly verifier: string
  /** base64url(SHA-256(verifier)), sent in the authorize request. */
  readonly challenge: string
}

/** A fresh PKCE pair for one login; the verifier never leaves this process until exchange. */
export const generatePkce = (): CodexPkce => {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

export type CallbackResult = { readonly code: string } | { readonly error: string }

/**
 * Validates the OAuth callback: an `error` param or a `state` mismatch (possible
 * CSRF) yields `{ error }` and nothing is written; a matching `state` with a
 * `code` yields `{ code }`.
 */
export const parseCallback = (callbackUrl: string, expectedState: string): CallbackResult => {
  const params = new URL(callbackUrl).searchParams
  const error = params.get("error")
  if (error !== null) return { error }
  if (params.get("state") !== expectedState) return { error: "state mismatch" }
  const code = params.get("code")
  if (code === null || code === "") return { error: "missing code" }
  return { code }
}

/** Opens the system browser at `url`; failures are swallowed (the URL is printed as a fallback). */
export const openBrowser = (url: string): void => {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url]
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).unref()
  } catch {
    // No browser available; the caller prints the URL for manual sign-in.
  }
}

export type CodexLoginResult =
  | { readonly ok: true; readonly accountId?: string }
  | {
      readonly ok: false
      readonly reason: "port-busy" | "timeout" | "invalid-callback" | "exchange-failed"
      readonly message?: string
    }

export interface CodexLoginOptions {
  /** Override the browser opener (tests). */
  readonly open?: (url: string) => void
  /** Prints the authorize URL as a fallback when the browser cannot open. */
  readonly onUrl?: (url: string) => void
  readonly timeoutMs?: number
}

const closeTabHtml = (ok: boolean): string =>
  `<!doctype html><meta charset="utf-8"><title>swain</title><body style="font-family:system-ui;padding:2rem">${
    ok ? "Signed in. You can close this tab." : "Sign-in failed. You can close this tab."
  }</body>`

/**
 * Runs the interactive browser OAuth login: binds the fixed callback port, opens
 * the browser, waits for the callback, exchanges the code, and persists the
 * rotated credentials. Always stops the callback server on exit. Returns a
 * coarse outcome so the UI need not interpret low-level errors.
 */
export const loginCodex = async (
  configPath: string,
  options: CodexLoginOptions = {},
): Promise<CodexLoginResult> => {
  const pkce = generatePkce()
  const state = randomBytes(16).toString("hex")
  const authorizeUrl = buildAuthorizeUrl({ codeChallenge: pkce.challenge, state })

  let resolveCallback!: (result: CallbackResult) => void
  const callback = new Promise<CallbackResult>((resolve) => {
    resolveCallback = resolve
  })

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      port: CODEX_CALLBACK_PORT,
      hostname: "127.0.0.1",
      fetch(request) {
        const { pathname } = new URL(request.url)
        if (pathname !== CALLBACK_PATH) return new Response("Not found", { status: 404 })
        const result = parseCallback(request.url, state)
        resolveCallback(result)
        return new Response(closeTabHtml(!("error" in result)), {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      },
    })
  } catch {
    return { ok: false, reason: "port-busy" }
  }

  try {
    ;(options.open ?? openBrowser)(authorizeUrl)
    options.onUrl?.(authorizeUrl)

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), options.timeoutMs ?? CALLBACK_TIMEOUT_MS)
    })
    const outcome = await Promise.race([callback, timeout])
    if (timer !== undefined) clearTimeout(timer)

    if (outcome === "timeout") return { ok: false, reason: "timeout" }
    if ("error" in outcome) return { ok: false, reason: "invalid-callback", message: outcome.error }

    try {
      const creds = await Effect.runPromise(
        exchangeCode(outcome.code, pkce.verifier).pipe(Effect.provide(FetchHttpClient.layer)),
      )
      await Effect.runPromise(
        persistCodexCredentials(configPath, creds).pipe(Effect.provide(BunContext.layer)),
      )
      return { ok: true, ...(creds.accountId !== undefined && { accountId: creds.accountId }) }
    } catch (error) {
      return { ok: false, reason: "exchange-failed", message: String(error) }
    }
  } finally {
    server.stop(true)
  }
}
