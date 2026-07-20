import type { HttpClient } from "@effect/platform"
import { Effect } from "effect"
import type { LLMError } from "../schema"
import { Http } from "../transport"
import {
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_TOKEN_URL,
  type RefreshedCodexCredentials,
  tokensToCredentials,
} from "./openai-codex"

/** OpenAI's OAuth authorization endpoint (browser PKCE flow). */
export const OPENAI_CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"

/**
 * Fixed callback address the Codex client is registered against; the port cannot
 * be randomized, so the TUI must bind exactly this port for the callback server.
 */
export const OPENAI_CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback"

export interface AuthorizeParams {
  /** PKCE `S256` code challenge (base64url of the verifier's SHA-256). */
  readonly codeChallenge: string
  /** Random anti-forgery value echoed back on the callback and verified there. */
  readonly state: string
}

/**
 * Builds the OpenAI authorization URL with the exact query params the Codex
 * client is registered against. Pure — the caller generates the PKCE challenge
 * and anti-forgery `state`; no network or runtime behavior here.
 */
export const buildAuthorizeUrl = ({ codeChallenge, state }: AuthorizeParams): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CODEX_CLIENT_ID,
    redirect_uri: OPENAI_CODEX_REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  })
  return `${OPENAI_CODEX_AUTHORIZE_URL}?${params.toString()}`
}

/**
 * Exchanges an authorization code (and its original PKCE verifier) for rotated
 * credentials via the OAuth token endpoint. Returns the same shape as the refresh
 * flow so callers reuse one persistence path.
 */
export const exchangeCode = (
  code: string,
  codeVerifier: string,
): Effect.Effect<RefreshedCodexCredentials, LLMError, HttpClient.HttpClient> =>
  Http.postForm({
    url: OPENAI_CODEX_TOKEN_URL,
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: OPENAI_CODEX_REDIRECT_URI,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: codeVerifier,
    },
  }).pipe(Effect.flatMap((json) => tokensToCredentials(json)))
