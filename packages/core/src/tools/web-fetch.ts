import * as NodeDns from "node:dns/promises"
import * as NodeNet from "node:net"
import type { HttpClientResponse } from "@effect/platform"
import { FetchHttpClient, HttpClient } from "@effect/platform"
import { Duration, Effect, Schema, Stream } from "effect"
import { ToolError } from "../errors"
import { defineTool } from "../tool"

const NAME = "WebFetch"
const MAX_TEXT = 100_000
const MAX_BYTES = 10 * 1024 * 1024
const MAX_REDIRECTS = 10
const TIMEOUT_MS = 30_000

export const WebFetchInput = Schema.Struct({
  url: Schema.String,
})

export const WebFetchResult = Schema.Struct({
  url: Schema.String,
  contentType: Schema.String,
  supported: Schema.Boolean,
  text: Schema.optional(Schema.String),
  truncated: Schema.Boolean,
})

const isTextLike = (contentType: string): boolean =>
  /text\/html|text\/plain|application\/(json|xml)|text\//.test(contentType)

const fail = (reason: ToolError["reason"], message: string): ToolError =>
  new ToolError({ tool: NAME, reason, message })

const normalizeHost = (host: string): string => {
  const h = host.toLowerCase()
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h
}

/** Blocks loopback, private, link-local (incl. cloud metadata), and bare hosts. */
const isBlockedHost = (host: string): boolean => {
  const h = normalizeHost(host)
  if (h === "localhost" || h.endsWith(".localhost")) return true
  if (NodeNet.isIP(h) !== 0) return isBlockedIp(h)
  // Reject bare hostnames (no dot) — they resolve to internal/search-domain hosts.
  return !h.includes(".")
}

const isBlockedIp = (ip: string): boolean => {
  const h = normalizeHost(ip)
  const mapped = h.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped?.[1] !== undefined) return isBlockedIpv4(mapped[1])
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isBlockedIpv4(h)

  if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd")) return true
  if (/^fe[89ab][0-9a-f]?:/i.test(h)) return true
  return false
}

const isBlockedIpv4 = (ip: string): boolean => {
  const octets = ip.split(".")
  const a = Number(octets[0])
  const b = Number(octets[1])
  if (a === 127 || a === 10 || a === 0) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true // link-local + 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

const validateUrl = (raw: string): Effect.Effect<URL, ToolError> =>
  Effect.gen(function* () {
    if (raw.length > 2000) return yield* fail("invalid-input", "URL is too long.")
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return yield* fail("invalid-input", `Not a valid URL: ${raw}`)
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return yield* fail("invalid-input", `Unsupported URL scheme: ${url.protocol}`)
    }
    if (url.username !== "" || url.password !== "") {
      return yield* fail("invalid-input", "Credentials in URLs are not allowed.")
    }
    if (isBlockedHost(url.hostname)) {
      return yield* fail("denied", `Refusing to fetch a private or local address: ${url.hostname}`)
    }
    return url
  })

const validateResolvedTargets = (url: URL): Effect.Effect<void, ToolError> => {
  const host = normalizeHost(url.hostname)
  if (NodeNet.isIP(host) !== 0) {
    return isBlockedIp(host)
      ? Effect.fail(fail("denied", `Refusing to fetch a private or local address: ${url.hostname}`))
      : Effect.void
  }

  return Effect.tryPromise({
    try: () => NodeDns.lookup(host, { all: true }),
    catch: (error) =>
      fail("execution-failed", error instanceof Error ? error.message : String(error)),
  }).pipe(
    Effect.flatMap((addresses) => {
      const blocked = addresses.find((address) => isBlockedIp(address.address))
      if (blocked !== undefined) {
        return Effect.fail(
          fail("denied", `Refusing to fetch a private or local address: ${url.hostname}`),
        )
      }
      return Effect.void
    }),
  )
}

const httpError = (error: { message: string }): ToolError => fail("execution-failed", error.message)

const readTextBody = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<string, ToolError> =>
  response.stream.pipe(
    Stream.runFoldEffect(
      { bytes: 0, chunks: [] as Array<Uint8Array> },
      (state, chunk: Uint8Array) => {
        const bytes = state.bytes + chunk.byteLength
        if (bytes > MAX_BYTES) {
          return Effect.fail(fail("precondition-failed", `Response is too large (${bytes} bytes).`))
        }
        state.chunks.push(chunk)
        return Effect.succeed({ bytes, chunks: state.chunks })
      },
    ),
    Effect.map(({ bytes, chunks }) => {
      const body = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }
      return new TextDecoder().decode(body)
    }),
    Effect.mapError((error) => (error instanceof ToolError ? error : httpError(error))),
  )

export const WebFetch = defineTool({
  name: NAME,
  description: "Fetch a URL over HTTP and return extracted text for text-like responses.",
  inputSchema: WebFetchInput,
  outputSchema: WebFetchResult,
  readOnly: true,
  recordDuration: true,
  call: (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        // Follow redirects manually so each hop is re-validated against SSRF
        // rules; a redirect to an internal address can't slip through.
        const fetch = (
          url: URL,
          hops: number,
        ): Effect.Effect<{ url: URL; contentType: string; body: string }, ToolError> =>
          Effect.gen(function* () {
            yield* validateResolvedTargets(url)
            const response = yield* client.get(url.href).pipe(Effect.mapError(httpError))
            if (response.status >= 300 && response.status < 400) {
              const location = response.headers["location"]
              if (location === undefined)
                return yield* fail("execution-failed", "Redirect without a location.")
              if (hops >= MAX_REDIRECTS)
                return yield* fail("execution-failed", "Too many redirects.")
              const next = yield* validateUrl(new URL(location, url).href)
              return yield* fetch(next, hops + 1)
            }
            const contentType = response.headers["content-type"] ?? ""
            const declaredLength = Number(response.headers["content-length"] ?? "0")
            if (declaredLength > MAX_BYTES) {
              return yield* fail(
                "precondition-failed",
                `Response is too large (${declaredLength} bytes).`,
              )
            }
            if (!isTextLike(contentType)) return { url, contentType, body: "" }
            const body = yield* readTextBody(response)
            return { url, contentType, body }
          })

        const start = yield* validateUrl(input.url)
        const result = yield* fetch(start, 0)
        if (!isTextLike(result.contentType)) {
          return {
            url: result.url.href,
            contentType: result.contentType,
            supported: false,
            truncated: false,
          }
        }
        const truncated = result.body.length > MAX_TEXT
        return {
          url: result.url.href,
          contentType: result.contentType,
          supported: true,
          text: truncated ? result.body.slice(0, MAX_TEXT) : result.body,
          truncated,
        }
      }),
    ).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeoutFail({
        duration: Duration.millis(TIMEOUT_MS),
        onTimeout: () => fail("execution-failed", `Request timed out after ${TIMEOUT_MS}ms`),
      }),
    ),
})
