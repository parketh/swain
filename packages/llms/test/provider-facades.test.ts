import { afterEach, describe, expect, test } from "bun:test"
import type { HttpClientRequest } from "@effect/platform"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import { LLM, LLMError, Message, ToolCallId } from "@swain/llms"
import { KimiModel } from "@swain/llms/models"
import {
  Anthropic,
  DeepSeek,
  Kimi,
  OpenAI,
  OpenAICodex,
  OpenAICompatible,
  ZAI,
} from "@swain/llms/providers"
import type { Model } from "@swain/llms/schema"
import { Lab, Provider } from "@swain/llms/schema"
import { Effect, Layer, Stream } from "effect"

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

const runTurn = (
  model: Model,
  captured: Captured,
  providerOptions?: Record<string, unknown>,
  chunks: ReadonlyArray<unknown> = textChunks,
) =>
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
      Effect.provide(capturingLayer(captured, chunks)),
    ),
  )

const codexChunks = [
  { type: "response.output_text.delta", item_id: "msg-1", delta: "Hello" },
  { type: "response.output_item.done", item: { type: "message", id: "msg-1" } },
  { type: "response.completed", response: { output: [] } },
]

const anthropicChunks = [
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

const codexJwt = (payload: unknown) => `${base64url({ alg: "none" })}.${base64url(payload)}.sig`

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

  test("OpenAI and OpenAICodex differ in ids, endpoints, auth, and protocols", async () => {
    const resolver = () => ({ accessToken: "codex-token", accountId: "acct-1" })
    const openaiModel = OpenAI.configure({ apiKey: "api-key" }).chat("gpt-4.1-mini")
    const codexModel = OpenAICodex.configure({ credentialResolver: resolver }).model(
      "gpt-5.3-codex",
    )
    expect(String(openaiModel.provider)).toBe("openai")
    expect(String(codexModel.provider)).toBe("openai-codex")

    const openaiCaptured: Captured = {}
    await runTurn(openaiModel, openaiCaptured)
    const codexCaptured: Captured = {}
    await runTurn(codexModel, codexCaptured, undefined, codexChunks)

    expect(openaiCaptured.url).toBe("https://api.openai.com/v1/chat/completions")
    expect(codexCaptured.url).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(openaiCaptured.headers?.authorization).toBe("Bearer api-key")
    expect(codexCaptured.headers?.authorization).toBe("Bearer codex-token")
    expect(openaiCaptured.headers?.["chatgpt-account-id"]).toBeUndefined()
    expect(codexCaptured.headers?.["chatgpt-account-id"]).toBe("acct-1")
    expect(codexCaptured.headers?.["openai-beta"]).toBe("responses=experimental")
    // Different wire protocols: Chat Completions vs Responses.
    expect(openaiCaptured.body?.messages).toBeDefined()
    expect(openaiCaptured.body?.input).toBeUndefined()
    expect(codexCaptured.body?.input).toBeDefined()
    expect(codexCaptured.body?.messages).toBeUndefined()
    expect(codexCaptured.body?.store).toBe(false)
  })

  test("codex credential resolver drives bearer and account headers", async () => {
    let resolved = 0
    const model = OpenAICodex.configure({
      credentialResolver: () => {
        resolved += 1
        return Promise.resolve({ accessToken: "tok", accountId: "acct-9" })
      },
      originator: "swain",
    }).model("gpt-5.3-codex")
    const captured: Captured = {}
    await runTurn(model, captured, undefined, codexChunks)
    expect(resolved).toBe(1)
    expect(captured.headers?.authorization).toBe("Bearer tok")
    expect(captured.headers?.["chatgpt-account-id"]).toBe("acct-9")
    expect(captured.headers?.originator).toBe("swain")
    expect(captured.headers?.accept).toBe("text/event-stream")
  })

  test("codex resolver without account id derives it from the JWT claim", async () => {
    const token = codexJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-resolver-jwt" },
    })
    const model = OpenAICodex.configure({
      credentialResolver: () => ({ accessToken: token }),
    }).model("gpt-5.3-codex")
    const captured: Captured = {}
    await runTurn(model, captured, undefined, codexChunks)
    expect(captured.headers?.authorization).toBe(`Bearer ${token}`)
    expect(captured.headers?.["chatgpt-account-id"]).toBe("acct-resolver-jwt")
  })

  test("codex env fallback derives account id from the JWT claim", async () => {
    const token = codexJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-jwt" },
    })
    setEnv("OPENAI_CODEX_ACCESS_TOKEN", token)
    const captured: Captured = {}
    await runTurn(OpenAICodex.configure().model("gpt-5.3-codex"), captured, undefined, codexChunks)
    expect(captured.headers?.authorization).toBe(`Bearer ${token}`)
    expect(captured.headers?.["chatgpt-account-id"]).toBe("acct-jwt")
  })

  test("codex env fallback without account id claim fails auth-failed", async () => {
    const cases = ["not-a-jwt", codexJwt({ sub: "user" })]
    for (const token of cases) {
      setEnv("OPENAI_CODEX_ACCESS_TOKEN", token)
      const captured: Captured = {}
      const error = await Effect.runPromise(
        LLM.streamTurn(
          LLM.request({
            model: OpenAICodex.configure().model("gpt-5.3-codex"),
            messages: [Message.user("hi")],
          }),
        ).pipe(Stream.runCollect, Effect.flip, Effect.provide(capturingLayer(captured))),
      )
      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toBe("auth-failed")
      expect(captured.url).toBeUndefined()
    }
  })

  test("anthropic facade sends x-api-key and defaults max_tokens", async () => {
    const model = Anthropic.configure({ apiKey: "anthropic-key" }).model("claude-sonnet-4-5")
    expect(String(model.provider)).toBe("anthropic")
    const captured: Captured = {}
    const events = await runTurn(model, captured, undefined, anthropicChunks)
    expect(captured.url).toBe("https://api.anthropic.com/v1/messages")
    expect(captured.headers?.["x-api-key"]).toBe("anthropic-key")
    expect(captured.headers?.["anthropic-version"]).toBe("2023-06-01")
    expect(captured.body?.max_tokens).toBe(4096)
    expect(captured.body?.stream).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
  })

  test("anthropic options flow through the anthropic key only", async () => {
    const captured: Captured = {}
    await runTurn(
      Anthropic.configure({ apiKey: "k", maxTokens: 1024 }).model("claude-sonnet-4-5"),
      captured,
      { ...Anthropic.options({ topK: 5 }), ...OpenAI.options({ temperature: 0.7 }) },
      anthropicChunks,
    )
    expect(captured.body?.max_tokens).toBe(1024)
    expect(captured.body?.top_k).toBe(5)
    expect(captured.body?.temperature).toBeUndefined()
    expect(Anthropic.options({ topK: 5 })).toEqual({ anthropic: { topK: 5 } })
    expect(OpenAICodex.options({ reasoning: { effort: "high" } })).toEqual({
      openaiCodex: { reasoning: { effort: "high" } },
    })
  })

  test("Kimi facade targets Moonshot with reasoning replay and max_completion_tokens", async () => {
    expect(Provider.Kimi).toBe("kimi")
    expect(Lab.Kimi).toBe("kimi")
    expect(KimiModel.K3).toBe("kimi-k3")

    const model = Kimi.model("kimi-k3")
    expect(String(model.provider)).toBe("kimi")
    expect(String(model.id)).toBe("kimi-k3")
    expect(model.warnOnReasoningLoss).toBe(true)
    expect(Kimi.options({ reasoningEffort: "max" })).toEqual({ kimi: { reasoningEffort: "max" } })

    setEnv("MOONSHOT_API_KEY", "moonshot-key")
    const captured: Captured = {}
    await Effect.runPromise(
      LLM.streamTurn(
        LLM.request({
          model: Kimi.model("kimi-k3"),
          messages: [
            Message.user("hi"),
            Message.assistant([
              { type: "reasoning", text: "plan" },
              { type: "text", text: "ok" },
            ]),
            Message.user("again"),
          ],
          generation: { maxTokens: 4096 },
          providerOptions: Kimi.options({ reasoningEffort: "max" }),
        }),
      ).pipe(Stream.runCollect, Effect.provide(capturingLayer(captured))),
    )

    expect(captured.url).toBe("https://api.moonshot.ai/v1/chat/completions")
    expect(captured.headers?.authorization).toBe("Bearer moonshot-key")
    expect(captured.body?.reasoning_effort).toBe("max")
    expect(captured.body?.max_completion_tokens).toBe(4096)
    expect(captured.body?.max_tokens).toBeUndefined()
    const assistant = (captured.body?.messages as Array<Record<string, unknown>>).find(
      (message) => message.role === "assistant",
    )
    expect(assistant?.reasoning_content).toBe("plan")
  })

  test("K3 replays reasoning_content for every assistant message regardless of origin", async () => {
    setEnv("MOONSHOT_API_KEY", "moonshot-key")
    // A history whose reasoning came from two different models plus a tool loop:
    // K3 must receive each assistant message's reasoning as reasoning_content.
    const history = [
      Message.user("start"),
      Message.assistant([
        { type: "reasoning", text: "foreign-model reasoning" },
        { type: "text", text: "did A" },
      ]),
      Message.user("keep going"),
      Message.assistant([
        { type: "reasoning", text: "k3 reasoning" },
        { type: "text", text: "did B" },
        {
          type: "tool-call",
          toolCallId: ToolCallId.make("c1"),
          name: "Read",
          input: { path: "/x" },
        },
      ]),
      Message.user([
        {
          type: "tool-result",
          toolCallId: ToolCallId.make("c1"),
          name: "Read",
          result: { type: "text", value: "contents" },
        },
      ]),
    ]
    const captured: Captured = {}
    await Effect.runPromise(
      LLM.streamTurn(LLM.request({ model: Kimi.model("kimi-k3"), messages: history })).pipe(
        Stream.runCollect,
        Effect.provide(capturingLayer(captured)),
      ),
    )
    const messages = captured.body?.messages as Array<Record<string, unknown>>
    const assistants = messages.filter((m) => m.role === "assistant")
    expect(assistants.map((m) => m.reasoning_content)).toEqual([
      "foreign-model reasoning",
      "k3 reasoning",
    ])
    // Reasoning is replayed only via reasoning_content, never folded into content.
    expect(assistants[0]?.content).toBe("did A")
    expect(assistants[1]?.content).toBe("did B")
    expect(assistants[1]?.tool_calls).toBeDefined()
  })

  test("K3 replays reasoning for every retained message of a compacted projection", async () => {
    setEnv("MOONSHOT_API_KEY", "moonshot-key")
    // Simulates the post-compaction projection deriveContext produces: a summary
    // meta user message, then the verbatim tail whose assistant messages still
    // carry their canonical reasoning.
    const projection = [
      Message.user(
        [
          {
            type: "compaction",
            reason: "auto",
            compactedMessages: 8,
            summary: "## Goal\nship the feature",
          },
        ],
        true,
      ),
      Message.assistant([
        { type: "reasoning", text: "retained reasoning" },
        { type: "text", text: "tail answer" },
      ]),
    ]
    const captured: Captured = {}
    await Effect.runPromise(
      LLM.streamTurn(LLM.request({ model: Kimi.model("kimi-k3"), messages: projection })).pipe(
        Stream.runCollect,
        Effect.provide(capturingLayer(captured)),
      ),
    )
    const messages = captured.body?.messages as Array<Record<string, unknown>>
    const assistant = messages.find((m) => m.role === "assistant")
    expect(assistant?.reasoning_content).toBe("retained reasoning")
    // The summary rides in a normal user message as text, not as reasoning.
    const summaryUser = messages.find(
      (m) => m.role === "user" && String(m.content).includes("ship the feature"),
    )
    expect(summaryUser).toBeDefined()
    expect(summaryUser?.reasoning_content).toBeUndefined()
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
