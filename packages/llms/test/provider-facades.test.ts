import { afterEach, describe, expect, test } from "bun:test"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import type { HttpClientRequest } from "@effect/platform"
import { Effect, Layer, Stream } from "effect"
import { LLM, LLMError, Message } from "@swain/llms"
import { DeepSeek, OpenAI, OpenAICompatible, ZAI } from "@swain/llms/providers"
import type { Model } from "@swain/llms/schema"

const textChunks = [
  { choices: [{ delta: { content: "Hello" } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
]

const sseBody = (chunks: ReadonlyArray<unknown>) =>
  `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`

interface Captured {
  url?: string
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

const capturingLayer = (captured: Captured, chunks: ReadonlyArray<unknown> = textChunks) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      captured.url = request.url
      captured.headers = { ...request.headers }
      if (request.body._tag === "Uint8Array") {
        captured.body = JSON.parse(new TextDecoder().decode(request.body.body))
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(sseBody(chunks), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      )
    }),
  )

const runTurn = (model: Model, captured: Captured, providerOptions?: Record<string, unknown>) =>
  Effect.runPromise(
    LLM.streamTurn(
      LLM.request({
        model,
        messages: [Message.user("hi")],
        ...(providerOptions ? { providerOptions } : {}),
      }),
    ).pipe(
      Stream.runCollect,
      Effect.map((events) => Array.from(events)),
      Effect.provide(capturingLayer(captured)),
    ),
  )

const savedEnv: Record<string, string | undefined> = {}
const setEnv = (name: string, value: string | undefined) => {
  if (!(name in savedEnv)) {
    savedEnv[name] = process.env[name]
  }
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
    delete savedEnv[name]
  }
})

describe("provider facades", () => {
  test("model carries provider id and executable turn runtime", async () => {
    const model = OpenAI.configure({ apiKey: "k" }).chat("gpt-4.1-mini")
    expect(String(model.provider)).toBe("openai")
    expect(String(model.id)).toBe("gpt-4.1-mini")
    const captured: Captured = {}
    const events = await runTurn(model, captured)
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" })
    expect(captured.body?.model).toBe("gpt-4.1-mini")
    expect(captured.body?.stream).toBe(true)
  })

  test("profiles set expected default base URLs", async () => {
    setEnv("DEEPSEEK_API_KEY", "k")
    setEnv("ZAI_API_KEY", "k")
    const cases: ReadonlyArray<[Model, string]> = [
      [
        OpenAI.configure({ apiKey: "k" }).chat("gpt-4.1-mini"),
        "https://api.openai.com/v1/chat/completions",
      ],
      [DeepSeek.model("deepseek-chat"), "https://api.deepseek.com/chat/completions"],
      [ZAI.model("glm-4.6"), "https://api.z.ai/api/paas/v4/chat/completions"],
    ]
    for (const [model, url] of cases) {
      const captured: Captured = {}
      await runTurn(model, captured)
      expect(captured.url).toBe(url)
    }
    expect(String(DeepSeek.model("deepseek-chat").provider)).toBe("deepseek")
    expect(String(ZAI.model("glm-4.6").provider)).toBe("zai")
  })

  test("ZAI base URL is overridable for coding-plan endpoints", async () => {
    const captured: Captured = {}
    const model = ZAI.configure({
      apiKey: "k",
      baseURL: "https://api.z.ai/api/coding/paas/v4",
    }).chat("glm-4.6")
    await runTurn(model, captured)
    expect(captured.url).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions")
  })

  test("explicit apiKey wins over env fallback", async () => {
    setEnv("OPENAI_API_KEY", "from-env")
    const captured: Captured = {}
    await runTurn(OpenAI.configure({ apiKey: "explicit" }).chat("gpt-4.1-mini"), captured)
    expect(captured.headers?.authorization).toBe("Bearer explicit")
  })

  test("missing auth fails with auth-failed at execution", async () => {
    setEnv("DEEPSEEK_API_KEY", undefined)
    const model = DeepSeek.model("deepseek-chat")
    const captured: Captured = {}
    const error = await Effect.runPromise(
      LLM.streamTurn(LLM.request({ model, messages: [Message.user("hi")] })).pipe(
        Stream.runCollect,
        Effect.flip,
        Effect.provide(capturingLayer(captured)),
      ),
    )
    expect(error).toBeInstanceOf(LLMError)
    expect(error.reason).toBe("auth-failed")
    expect(captured.url).toBeUndefined()
  })

  test("option helpers return keyed ProviderOptions", () => {
    expect(OpenAI.options({ temperature: 0.2, seed: 7 })).toEqual({
      openai: { temperature: 0.2, seed: 7 },
    })
    expect(DeepSeek.options({ temperature: 0.9 })).toEqual({ deepseek: { temperature: 0.9 } })
    expect(ZAI.options({ topP: 0.5 })).toEqual({ zai: { topP: 0.5 } })
    expect(OpenAICompatible.options("custom", { temperature: 1 })).toEqual({
      custom: { temperature: 1 },
    })
    const facade = OpenAICompatible.configure({ providerId: "custom", baseURL: "https://x.test" })
    expect(facade.options({ topP: 0.1 })).toEqual({ custom: { topP: 0.1 } })
  })

  test("protocols only read their own provider options key", async () => {
    setEnv("DEEPSEEK_API_KEY", "k")
    const providerOptions = {
      ...OpenAI.options({ temperature: 0.1 }),
      ...DeepSeek.options({ temperature: 0.9 }),
    }
    const deepseekCaptured: Captured = {}
    await runTurn(DeepSeek.model("deepseek-chat"), deepseekCaptured, providerOptions)
    expect(deepseekCaptured.body?.temperature).toBe(0.9)

    const openaiCaptured: Captured = {}
    await runTurn(
      OpenAI.configure({ apiKey: "k" }).chat("gpt-4.1-mini"),
      openaiCaptured,
      DeepSeek.options({ temperature: 0.9 }),
    )
    expect(openaiCaptured.body?.temperature).toBeUndefined()
  })
})
