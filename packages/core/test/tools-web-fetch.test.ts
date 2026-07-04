import { describe, expect, test } from "bun:test"
import type { HttpClientRequest } from "@effect/platform"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import type { Model, ToolCall, ToolResultContent } from "@swain/llms"
import { ModelId, ProviderId, ToolCallId } from "@swain/llms"
import { Effect, Layer, Stream } from "effect"
import { autoApproval, makePermissions } from "../src/permission"
import { createSessionState } from "../src/state"
import { callTool, ToolContext, toolRegistryLayer, WebFetch } from "../src/tools"

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => Stream.empty,
}

const session = createSessionState({
  workingDirectory: process.cwd(),
  model,
  permissionMode: "auto",
  currentDate: "2026-07-04",
})

const run = (url: string): Promise<ToolResultContent> =>
  Effect.runPromise(
    callTool({
      type: "tool-call",
      toolCallId: ToolCallId.make("call-WebFetch"),
      name: "WebFetch",
      input: { url },
    } satisfies ToolCall).pipe(
      Effect.provide(
        Layer.succeed(ToolContext, {
          session,
          abortSignal: new AbortController().signal,
          permission: makePermissions("auto", autoApproval),
        }),
      ),
      Effect.provide(toolRegistryLayer([WebFetch])),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(BunContext.layer),
    ),
  )

describe("WebFetch input validation", () => {
  test.each([
    ["localhost", "http://localhost:8080/x"],
    ["metadata IP", "http://169.254.169.254/latest/meta-data"],
    ["resolved loopback", "http://localtest.me/x"],
    ["private IP", "http://10.0.0.5/x"],
    ["bare hostname", "http://internalhost/x"],
    ["non-http scheme", "ftp://example.com"],
    ["credentials in URL", "http://user:pass@example.com"],
    ["malformed URL", "not a url"],
  ])("rejects %s without a network call", async (_label, url) => {
    const result = await run(url)
    expect(result.isError).toBe(true)
  })
})

const toolContextLayer = Layer.succeed(ToolContext, {
  session,
  abortSignal: new AbortController().signal,
  permission: makePermissions("auto", autoApproval),
})

const stubClient = (body: string, contentType: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, { status: 200, headers: { "content-type": contentType } }),
        ),
      ),
    ),
  )

const redirectClient = (location: string, calls: { count: number }) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      calls.count += 1
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("", { status: 302, headers: { location } }),
        ),
      )
    }),
  )

const streamingTextClient = (calls: { pulls: number }, totalChunks: number) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      const chunk = new Uint8Array(1024 * 1024)
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (calls.pulls >= totalChunks) {
            controller.close()
            return
          }
          calls.pulls += 1
          controller.enqueue(chunk)
        },
      })
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(stream, { status: 200, headers: { "content-type": "text/plain" } }),
        ),
      )
    }),
  )

describe("WebFetch behavior", () => {
  test("returns text for text/html responses", async () => {
    const result = await Effect.runPromise(
      WebFetch.call({ url: "https://example.com" }).pipe(
        Effect.provide(stubClient("<html>hi</html>", "text/html; charset=utf-8")),
        Effect.provide(toolContextLayer),
      ),
    )
    expect(result.supported).toBe(true)
    expect(result.text).toBe("<html>hi</html>")
  })

  test("reports unsupported for non-text responses without body text", async () => {
    const result = await Effect.runPromise(
      WebFetch.call({ url: "https://example.com/x.png" }).pipe(
        Effect.provide(stubClient("bytes", "image/png")),
        Effect.provide(toolContextLayer),
      ),
    )
    expect(result.supported).toBe(false)
    expect(result.text).toBeUndefined()
  })

  test("rejects redirects to hostnames that resolve private", async () => {
    const calls = { count: 0 }
    const result = await Effect.runPromise(
      WebFetch.call({ url: "https://93.184.216.34" }).pipe(
        Effect.provide(redirectClient("http://localtest.me/x", calls)),
        Effect.provide(toolContextLayer),
      ),
    ).then(
      () => ({ ok: true }),
      () => ({ ok: false }),
    )
    expect(result.ok).toBe(false)
    expect(calls.count).toBe(1)
  })

  test("rejects streamed text bodies above the byte cap", async () => {
    const calls = { pulls: 0 }
    const result = await Effect.runPromise(
      WebFetch.call({ url: "https://example.com" }).pipe(
        Effect.provide(streamingTextClient(calls, 20)),
        Effect.provide(toolContextLayer),
      ),
    ).then(
      () => ({ ok: true }),
      () => ({ ok: false }),
    )
    expect(result.ok).toBe(false)
    expect(calls.pulls).toBeLessThan(20)
  })
})
