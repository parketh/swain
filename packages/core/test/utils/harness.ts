import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HttpClientRequest } from "@effect/platform"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import type { LLMEvent } from "@swain/llms"
import { LLM, LLMClient } from "@swain/llms"
import { Effect, Layer, Stream } from "effect"
import type { Approval, PermissionDecision, PermissionRequest } from "../../src/permission"
import { allow } from "../../src/permission"
import type { AskInput, AskResult, SearchProvider, WebSearchResult } from "../../src/tools"
import { AskService } from "../../src/tools"

/** Fake `LLMClient` that replays scripted event sequences, one per turn. */
export const scriptedLLMClient = (turns: ReadonlyArray<ReadonlyArray<LLMEvent>>) => {
  let index = 0
  const next = (): ReadonlyArray<LLMEvent> => {
    const events = turns[Math.min(index, turns.length - 1)] ?? []
    index += 1
    return events
  }
  return Layer.succeed(LLMClient.Service, {
    request: LLM.request,
    streamTurn: () => Stream.fromIterable(next()),
    generateTurn: () => Effect.succeed({ events: [...next()] }),
  })
}

/** Approval fake that records each request and returns a fixed decision. */
export const recordingApproval = (
  decision: PermissionDecision = allow,
): { approval: Approval; seen: Array<PermissionRequest> } => {
  const seen: Array<PermissionRequest> = []
  return {
    seen,
    approval: {
      requestApproval: (request) => {
        seen.push(request)
        return Effect.succeed(decision)
      },
    },
  }
}

/** Ask fake wired as a layer returning deterministic answers. */
export const fakeAskLayer = (answer: (input: AskInput) => AskResult): Layer.Layer<AskService> =>
  Layer.succeed(AskService, { ask: (input) => Effect.succeed(answer(input)) })

/** Search provider fake returning configured results. */
export const fakeSearchProvider = (results: ReadonlyArray<WebSearchResult>): SearchProvider => ({
  search: () => Effect.succeed({ results }),
})

/** HttpClient stub answering every request with the same JSON payload. */
export const jsonHttpClientLayer = (payload: unknown): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    ),
  )

export const createTempDir = (): string => mkdtempSync(join(tmpdir(), "swain-harness-"))

export const removeTempDir = (dir: string): void => rmSync(dir, { recursive: true, force: true })
