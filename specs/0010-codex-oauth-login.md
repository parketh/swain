# Codex Token Refresh + OAuth Login Implementation Plan

> Use subagents to implement this plan task-by-task.

**Goal:** Make swain's ChatGPT/Codex credentials robust and self-owned: first stop it replaying already-rotated refresh tokens (the `refresh_token_reused` bug), then give it its own OpenAI OAuth login (browser PKCE flow) so it mints and refreshes its own tokens instead of piggybacking on the Codex CLI's `~/.codex/auth.json`.

**Architecture:** Two concerns across the existing two packages. **Durability** (Task 1) lives entirely in `packages/tui/src/codex-auth.ts`: the credential resolver re-reads swain's `auth.json` every turn instead of trusting a stale in-memory snapshot. **Login** (Tasks 2–9) splits by layer — `packages/llms` gains the pure OAuth *protocol* (authorize URL, code exchange) alongside the refresh logic it already owns; `packages/tui` gains a new `codex-oauth.ts` *orchestration* module (PKCE, browser open, `Bun.serve` callback, exchange, persist) plus connect-UX wiring. Tokens stay in swain's flat-JSON `~/.config/swain/auth.json` — no database.

**Tech Stack:** TypeScript, Bun, Effect, Ink/React (TUI), `@effect/platform` HttpClient. OAuth against `https://auth.openai.com` using the public Codex client.

---

## Current context / assumptions

This plan is self-contained: it starts from the pre-fix baseline and ends with swain owning its login.

- **The bug (Task 1 fixes it):** `buildCodexModel` runs on *every* turn / router pick / subagent (via `resolveModelSelection` → `spec.build`). It seeded an in-memory `state` from the controller's in-memory `config`, and the resolver read from that `state`. When the provider refreshed a token (`R → R'`), it wrote `R'` to `auth.json` and to the closure-local `state`, but **never back into the in-memory `config`**. The next turn rebuilt the model from that stale `config`, replayed the already-consumed `R`, and got `401 refresh_token_reused`. The in-place `state` mirror was dead across turns. Task 1 makes the resolver re-read `auth.json` (the source of truth refreshes are persisted to) each turn. *(This change is already committed on the `fix/codex-token-refresh` branch as `4dbf73d`; it is written out in full here so the plan stands alone.)*
- Today swain has **no login of its own**. Codex credentials currently arrive one of two ways, both removed in Task 8:
  1. Startup bootstrap from `~/.codex/auth.json` (`packages/tui/src/index.ts:88-108`, `loadCodexCliCredentials`).
  2. Manual access-token paste via the `/connect` text form (`requiredFields: ["accessToken"]`).
- The codex OAuth **protocol constants already live in `llms`**: `OPENAI_CODEX_CLIENT_ID` (`app_EMoamEEZ73f0CkXaXp7hrann`), `OPENAI_CODEX_TOKEN_URL`, the `refresh_token` exchange (`refreshAccessToken`), and JWT `chatgpt_account_id` / `exp` parsing — all in `packages/llms/src/providers/openai-codex.ts`.
- `Http.postForm` (`packages/llms/src/transport/http.ts:153`) already POSTs `application/x-www-form-urlencoded` to OAuth token endpoints and parses JSON — reuse it for the code exchange.
- Runtime is Bun, so `Bun.serve` (callback server) and `Bun.spawn` (open browser) are available with no new dependency.
- **`packages/core` is untouched** — codex appears only in `llms` and `tui`; core consumes the built `Model`.

### Fixed external constraints (server-registered; not design choices)

- `redirect_uri` **must** be `http://localhost:1455/auth/callback` (port cannot be randomized).
- `client_id` = `app_EMoamEEZ73f0CkXaXp7hrann` (reuse; already a constant in `llms`).
- Authorize request must include `codex_cli_simplified_flow=true`, `response_type=code`, `scope=openid profile email offline_access`, `code_challenge_method=S256`, and `originator=codex_cli_rs`.
- Verify a random CSRF `state` on the callback; mismatch → abort, write nothing.
- ~3 minute callback timeout.

---

## Proposed approach

Land the durability fix first (Task 1) so no token is burned again. Then the login: pure `llms` protocol helpers with unit tests (Tasks 2–3), the `tui` orchestration with unit tests for its pure parts (Tasks 4–5), the provider `auth`-kind marker and connect-UX branch (Tasks 6–7), and finally delete the two legacy credential paths (Task 8) — last, so nothing is removed before its replacement works. Task 9 is full verification.

### Data shapes

The authorize step produces a `CodexPkce` + `state`. The callback yields a `code`. The exchange yields the same rotated-credentials shape the refresh path already returns (`RefreshedCodexCredentials`: `accessToken`, `refreshToken`, `accountId?`), so persistence reuses `persistCodexCredentials` unchanged.

---

## Per-package change breakdown

### `packages/tui` — durability (Task 1)

`packages/tui/src/codex-auth.ts`: add `loadStoredCodexCredentials(configPath)` (reads the `openai-codex` entry from `auth.json`, or `undefined`), and rewrite `buildCodexModel` so its `credentialResolver` re-reads that store each call, falling back to a config-derived `seed` only until `auth.json` has a codex entry. Drop the mutable in-memory `state` mirror. `onCredentialsRefreshed` keeps persisting via `persistCodexCredentials`.

### `packages/llms` — OAuth protocol (Tasks 2–3)

The new `packages/llms/src/providers/codex-oauth.ts` module owns the provider-facing parts of login. It knows how to create OpenAI's authorization request and exchange the returned code for credentials. It does not open a browser, run a callback server, or persist credentials; those interactive responsibilities stay in `packages/tui`.

It exports the two fixed endpoints:

- `OPENAI_CODEX_AUTHORIZE_URL` — `https://auth.openai.com/oauth/authorize`.
- `OPENAI_CODEX_REDIRECT_URI` — `http://localhost:1455/auth/callback`.

**Authorization request:** provide a pure URL builder that accepts the PKCE challenge and anti-forgery value generated by the TUI. It adds the fixed client identity, callback address, scopes, and Codex flow flags required by OpenAI. Keeping this step free of network and runtime behavior makes the complete request easy to verify in a unit test.

**Code exchange:** accept the authorization code returned to the TUI together with its original PKCE verifier, then exchange them at the existing token endpoint through the shared HTTP transport. Return credentials in the same shape as the refresh flow so callers do not need a login-specific persistence path.

**Shared token handling:** reuse the existing client id, token endpoint, and account-id parsing. Move token-response normalization into one internal helper used by both initial login and token refresh, so the two paths interpret OpenAI's response consistently. Export the public OAuth pieces from the providers index.

> Device-code login remains a future extension. Keep the protocol module open to that additional flow, but do not implement it in this phase.

### `packages/tui` — orchestration + UX (Tasks 4–8)

The TUI owns the interactive login lifecycle. From the user's perspective, `/connect openai-codex` opens a browser, waits for the local callback, confirms the account, and makes the provider immediately available. API-key providers keep their existing text-entry flow.

**OAuth coordinator (`packages/tui/src/codex-oauth.ts`):**

- Create fresh PKCE and anti-forgery values for every login. Keep their generation and callback validation as small, pure functions so they can be unit-tested without opening a browser or binding a port.
- Start the callback server on the required port, build the authorization URL through `packages/llms`, and attempt to open it with the operating system's browser command. Always print the URL as a fallback.
- Wait up to roughly three minutes for the callback. Reject provider errors and anti-forgery mismatches without writing credentials.
- Exchange a valid authorization code through `packages/llms`, persist the returned credentials, and report the signed-in account when available.
- Stop the callback server on every exit path, including cancellation and failure. Return clear outcomes for a busy port, timeout, invalid callback, or failed exchange so the UI does not need to interpret low-level errors.

**Provider metadata (`packages/tui/src/models.ts`):** distinguish browser-based OAuth providers from API-key providers. Codex uses OAuth and requires no text fields. Treat it as configured only when a non-empty refresh token is stored; an access token alone is not durable enough.

**Connect experience (`packages/tui/src/components/ConnectDialog.tsx`):** show a dedicated OAuth panel for Codex. Enter starts login; the panel then shows browser-opening and callback-waiting progress with a countdown, followed by either the signed-in account or a useful failure message. Escape cancels the attempt. Leave the existing credential form unchanged for API-key providers.

**Application wiring (`packages/tui/src/controller.ts` and `packages/tui/src/components/App.tsx`):** route OAuth login through the controller, then reuse the existing post-connect refresh path so configuration and provider state update immediately. When Codex was previously unconfigured, continue into model selection after a successful login, matching the current connect behavior.

**Legacy removal (Task 8):** once browser login works, remove startup credential import from the Codex CLI and remove manual Codex token entry. Keep the credential persistence, fresh credential loading, and model-building paths introduced by the durability work.

---

## Step-by-step plan

### Task 1: Re-read persisted token each turn (durability)

**Objective:** Stop replaying a rotated refresh token by reading `auth.json` fresh each turn instead of a stale in-memory snapshot.

**Files:**
- Modify: `packages/tui/src/codex-auth.ts`
- Test: `packages/tui/test/codex-auth.test.ts`

**Step 1: Write failing tests** — append to `codex-auth.test.ts` (import `loadStoredCodexCredentials`):

```typescript
describe("loadStoredCodexCredentials", () => {
  test("returns undefined when auth.json has no codex entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swain-cfg-"))
    const configPath = join(dir, "config.json")
    await writeFile(authPath(configPath), JSON.stringify({ zai: { apiKey: "zk" } }))
    expect(await run(loadStoredCodexCredentials(configPath))).toBeUndefined()
  })

  test("reads back the freshest persisted token after a refresh rotation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swain-cfg-"))
    const configPath = join(dir, "config.json")
    // A prior turn rotated the refresh token and persisted it. The resolver must
    // see the rotated token, not the stale one it started with.
    await run(
      persistCodexCredentials(configPath, {
        accessToken: "at_new",
        refreshToken: "rt_new",
        accountId: "acct_1",
      }),
    )
    expect(await run(loadStoredCodexCredentials(configPath))).toEqual({
      accessToken: "at_new",
      refreshToken: "rt_new",
      accountId: "acct_1",
    })
  })
})
```

**Step 2: Run to verify failure**

Run: `bun test packages/tui/test/codex-auth.test.ts`
Expected: FAIL — `loadStoredCodexCredentials` is not exported.

**Step 3: Implementation** — in `packages/tui/src/codex-auth.ts`, add the reader:

```typescript
/** Reads swain's persisted Codex credentials from `auth.json`, or `undefined` when none are stored. */
export const loadStoredCodexCredentials = (
  configPath: string,
): Effect.Effect<CodexCredentials | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const store = yield* loadAuth(authPath(configPath))
    const stored = store[OPENAI_CODEX_PROVIDER_ID]
    if (stored?.accessToken === undefined && stored?.refreshToken === undefined) return undefined
    return {
      accessToken: stored.accessToken ?? "",
      ...(stored.refreshToken !== undefined && { refreshToken: stored.refreshToken }),
      ...(stored.accountId !== undefined && { accountId: stored.accountId }),
    }
  })
```

and rewrite `buildCodexModel`'s stored-credentials branch to re-read each turn (replace the mutable `state` mirror):

```typescript
  const seed: CodexCredentials = {
    accessToken: creds?.accessToken ?? "",
    ...(creds?.refreshToken !== undefined && { refreshToken: creds.refreshToken }),
    ...(creds?.accountId !== undefined && { accountId: creds.accountId }),
  }
  const configPath = defaultConfigPath(env)
  return OpenAICodexProvider.configure({
    credentialResolver: () =>
      Effect.runPromise(
        loadStoredCodexCredentials(configPath).pipe(Effect.provide(BunContext.layer)),
      ).then((stored) => stored ?? seed),
    onCredentialsRefreshed: (next) =>
      Effect.runPromise(
        persistCodexCredentials(configPath, {
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          ...((next.accountId ?? seed.accountId) !== undefined && {
            accountId: next.accountId ?? seed.accountId,
          }),
        }).pipe(Effect.provide(BunContext.layer)),
      ).then(
        () => undefined,
        () => undefined,
      ),
    ...(creds?.baseURL !== undefined && { baseURL: creds.baseURL }),
  }).model(modelId)
```

Update the `buildCodexModel` doc comment to state the resolver re-reads `auth.json` each turn (config `creds` only seed the first turn).

**Step 4: Run to verify pass**

Run: `bun test packages/tui/test/codex-auth.test.ts`
Expected: PASS (6 tests). Then `bun run --cwd packages/tui typecheck` → 0.

> Note: this is the code already committed as `4dbf73d` on `fix/codex-token-refresh`; if implementing on that branch it is already applied — verify the tests pass and move on.

### Task 2: `llms` — `buildAuthorizeUrl` + authorize constants

**Objective:** Pure authorize-URL builder with the exact server-required query params.

**Files:**
- Create: `packages/llms/src/providers/codex-oauth.ts`
- Modify: `packages/llms/src/providers/index.ts` (barrel export)
- Test: `packages/llms/test/codex-oauth.test.ts`

**Step 1: Write failing test**

```typescript
import { describe, expect, test } from "bun:test"
import { buildAuthorizeUrl, OPENAI_CODEX_REDIRECT_URI } from "@swain/llms/providers"

describe("buildAuthorizeUrl", () => {
  test("includes the server-required params", () => {
    const url = new URL(buildAuthorizeUrl({ codeChallenge: "chal", state: "st" }))
    const q = url.searchParams
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize")
    expect(q.get("response_type")).toBe("code")
    expect(q.get("code_challenge")).toBe("chal")
    expect(q.get("code_challenge_method")).toBe("S256")
    expect(q.get("state")).toBe("st")
    expect(q.get("redirect_uri")).toBe(OPENAI_CODEX_REDIRECT_URI)
    expect(q.get("codex_cli_simplified_flow")).toBe("true")
    expect(q.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
  })
})
```

**Step 2:** Run → FAIL (export not found).
**Step 3:** Add the constants + `buildAuthorizeUrl`; export from the providers barrel.
**Step 4:** Run → PASS.

### Task 3: `llms` — `exchangeCode` + shared `tokensToCredentials`

**Objective:** Exchange an auth code for rotated credentials, sharing the token-mapping with the refresh path.

**Files:**
- Modify: `packages/llms/src/providers/codex-oauth.ts` (add `exchangeCode`)
- Modify: `packages/llms/src/providers/openai-codex.ts` (extract `tokensToCredentials`, reuse in `refreshAccessToken`)
- Test: `packages/llms/test/codex-oauth.test.ts`

**Step 1: Write failing test** (reuse `jwt`/`FRESH`/`harness` from `openai-codex-refresh.test.ts`):

```typescript
test("exchanges an auth code for rotated credentials", async () => {
  const { requests, layer } = harness({ access_token: FRESH, refresh_token: "rt_new" })
  const creds = await Effect.runPromise(
    exchangeCode("auth_code", "verifier").pipe(Effect.provide(layer)),
  )
  expect(creds).toEqual({ accessToken: FRESH, refreshToken: "rt_new", accountId: "acct_new" })
  expect(requests.find((r) => r.url.includes("/oauth/token"))).toBeDefined()
})
```

**Step 2:** Run → FAIL.
**Step 3:** Implement `exchangeCode` via `Http.postForm` (grant `authorization_code`); extract `tokensToCredentials` and call it from both sites.
**Step 4:** Run → PASS; also `bun test packages/llms/test/openai-codex-refresh.test.ts` (5 pass) to confirm the refactor kept refresh green.

### Task 4: `tui` — PKCE + callback parsing (pure)

**Objective:** Deterministic PKCE generation and callback/state verification, unit-tested without a browser or port.

**Files:**
- Create: `packages/tui/src/codex-oauth.ts` (pure exports first)
- Test: `packages/tui/test/codex-oauth.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, expect, test } from "bun:test"
import { generatePkce, parseCallback } from "../src/codex-oauth"

describe("generatePkce", () => {
  test("verifier is 43+ url-safe chars, challenge is base64url, and it is random", () => {
    const { verifier, challenge } = generatePkce()
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,}$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(generatePkce().verifier).not.toBe(verifier)
  })
})

describe("parseCallback", () => {
  test("returns the code when state matches", () => {
    expect(parseCallback("http://localhost:1455/auth/callback?code=abc&state=st", "st")).toEqual({ code: "abc" })
  })
  test("rejects a state mismatch", () => {
    expect("error" in parseCallback("http://localhost:1455/auth/callback?code=abc&state=bad", "st")).toBe(true)
  })
  test("surfaces an oauth error param", () => {
    expect("error" in parseCallback("http://localhost:1455/auth/callback?error=access_denied&state=st", "st")).toBe(true)
  })
})
```

**Step 2:** Run → FAIL.
**Step 3:** Implement the three pure functions (challenge via `crypto.subtle.digest("SHA-256", …)` → `Buffer.from(...).toString("base64url")`).
**Step 4:** Run → PASS.

### Task 5: `tui` — `loginCodex` orchestration

**Objective:** The end-to-end interactive flow (server + browser + exchange + persist).

**Files:**
- Modify: `packages/tui/src/codex-oauth.ts` (add `openBrowser`, `loginCodex`, `CodexLoginResult`)

**Detail:** `Bun.serve({ port: 1455 })` with `finally { server.stop() }`; catch port-in-use → `{ ok:false, reason:"port-busy" }`. Timeout via `Promise.race` with a ~180s timer. On the callback request run `parseCallback`, respond with a small "You can close this tab" page, then exchange (`Effect.runPromise(exchangeCode(...).pipe(Effect.provide(BunContext.layer)))`) and `persistCodexCredentials`. Pure pieces are covered in Task 4; here just typecheck.

**Verify:** `bun run --cwd packages/tui typecheck` → 0.

### Task 6: `tui` — provider spec `auth` kind + `isConfigured`

**Objective:** Mark codex as OAuth; configured-ness depends on a stored refresh token.

**Files:**
- Modify: `packages/tui/src/models.ts`
- Test: `packages/tui/test/models.test.ts` (or the existing models test)

**Step 1: Failing test**

```typescript
test("oauth provider is configured when a refresh token is stored", () => {
  const cfg = { providers: { "openai-codex": { refreshToken: "rt", accessToken: "at" } } }
  expect(configuredProviders(cfg).some((p) => p.id === "openai-codex")).toBe(true)
})
test("oauth provider without a refresh token is not configured", () => {
  const cfg = { providers: { "openai-codex": { accessToken: "at" } } }
  expect(configuredProviders(cfg).some((p) => p.id === "openai-codex")).toBe(false)
})
```

**Step 2–4:** Run → FAIL; add `auth` + the oauth branch in `isConfigured`; Run → PASS.

### Task 7: `tui` — ConnectDialog OAuth panel + controller/App wiring

**Objective:** `/connect openai-codex` runs the browser login instead of a text field.

**Files:**
- Modify: `packages/tui/src/components/ConnectDialog.tsx`
- Modify: `packages/tui/src/controller.ts` (add `loginProvider`)
- Modify: `packages/tui/src/components/App.tsx` (wire `onOAuthLogin`; mirror `connect` at `App.tsx:339`)

**Verify:** `bun run --cwd packages/tui typecheck` → 0. Behavior confirmed manually in Task 9.

### Task 8: Delete the legacy credential paths

**Objective:** Remove piggyback + paste now that OAuth login exists.

**Files:**
- Modify: `packages/tui/src/codex-auth.ts` (delete `loadCodexCliCredentials`, `codexCliAuthPath`, `CodexCliAuth`; keep `persistCodexCredentials`, `loadStoredCodexCredentials`, `buildCodexModel`)
- Modify: `packages/tui/src/index.ts` (delete the `:88-108` bootstrap block + import)
- Modify: `packages/tui/test/codex-auth.test.ts` (drop the `loadCodexCliCredentials` block)

**Verify:** `bun test packages/tui` green; `bun run --cwd packages/tui typecheck` → 0; `grep -rn "codex/auth.json\|loadCodexCliCredentials" packages/tui/src` returns nothing.

### Task 9: Full verification

- `bun test packages/llms packages/tui` → all green.
- `bun run typecheck` (root) → 0.
- **Manual run:** launch swain, `/connect openai-codex`, complete the browser sign-in, confirm "signed in as …", then run a codex turn and confirm it streams. Inspect `~/.config/swain/auth.json` → `openai-codex` has a fresh `accessToken` + `refreshToken` + `accountId`. Force `exp` skew (or wait for expiry) and run another turn to confirm auto-refresh persists a rotated token (Task 1 path) without `refresh_token_reused`.

---

## Files likely to change

| Package | File | Change |
|---|---|---|
| tui | `src/codex-auth.ts` | **Task 1** — `loadStoredCodexCredentials`, re-read resolver; **Task 8** — delete CLI-bootstrap helpers |
| tui | `test/codex-auth.test.ts` | Task 1 tests; Task 8 deletion |
| llms | `src/providers/codex-oauth.ts` | **new** — `buildAuthorizeUrl`, `exchangeCode`, authorize/redirect constants |
| llms | `src/providers/openai-codex.ts` | extract shared `tokensToCredentials` |
| llms | `src/providers/index.ts` | barrel-export new symbols |
| llms | `test/codex-oauth.test.ts` | **new** — URL builder + code exchange |
| tui | `src/codex-oauth.ts` | **new** — PKCE, callback parse, `loginCodex`, browser open |
| tui | `src/models.ts` | `ProviderSpec.auth`, codex spec, `isConfigured` |
| tui | `src/components/ConnectDialog.tsx` | OAuth panel branch |
| tui | `src/controller.ts` | `loginProvider` |
| tui | `src/components/App.tsx` | wire `onOAuthLogin` |
| tui | `src/index.ts` | delete bootstrap block |
| tui | `test/codex-oauth.test.ts`, `test/models.test.ts` | tests |
| core | — | **no changes** |

---

## Tests / validation

- **tui durability (Task 1):** `loadStoredCodexCredentials` returns `undefined` with no codex entry and reads back the freshest token after a rotation.
- **llms (pure/mocked):** `buildAuthorizeUrl` param assertions; `exchangeCode` via the existing `HttpClient` mock harness (`openai-codex-refresh.test.ts` pattern); confirm the `refreshAccessToken` refactor stays green.
- **tui (pure):** `generatePkce` (shape + randomness), `parseCallback` (match / mismatch / oauth-error), `isConfigured` oauth branch.
- **tui (not unit-tested):** `Bun.serve` callback, real browser open, port binding — covered by the manual run in Task 9, not by tests (don't bind a real port or drive a browser in CI).
- **Typecheck:** `bun run typecheck` at each task boundary.

---

## Risks, tradeoffs, and open questions

- **Migration cost (accepted):** existing users who only ever logged in via the `codex` CLI must run `/connect openai-codex` once. Users who already have a swain-stored `refreshToken` keep working (they stay "configured"; Task 1 keeps refreshes durable).
- **Already-burned token:** Task 1 prevents *future* re-burns but cannot revive a token that was already consumed before this work; such a user must re-login (Task 7 flow) or manually reseed a fresh token.
- **Port 1455 collision:** if another swain login (or the Codex CLI's own callback) holds 1455, login fails with a clear message rather than hanging.
- **`originator` / flow flags:** mirror the Codex CLI; kept as named constants in `llms` for a one-line fix if OpenAI changes accepted values.
- **Effect ↔ imperative bridge:** `loginCodex` is imperative (`Bun.serve`) but calls Effect-based `exchangeCode`/`persistCodexCredentials` via `Effect.runPromise` + `BunContext.layer` — matches the existing pattern in `codex-auth.ts`.

---

## Out of scope — tracked follow-ups

1. **Tier 2 cross-process durability ("retry-on-reuse"):** on a `401 refresh_token_reused`, re-read `auth.json` and, if the stored refresh token differs from the one just tried, retry the refresh once with the stored token before surfacing an error. Closes the two-simultaneous-swain-instances race that Task 1's per-turn re-read and the provider's in-process single-flight gate don't cover. ~20 lines in the `llms` refresh path + a test. Deferred: the race needs two swain processes inside the same ~1-min expiry window (rare).
2. **Device-code / headless flow:** `requestDeviceCode()` / `pollDeviceToken()` in `llms` + a tui fallback when no browser can be opened (SSH/containers). The `llms` and `tui` modules are structured to accept it without refactor.
