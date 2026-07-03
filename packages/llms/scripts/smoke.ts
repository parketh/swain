/**
 * Manual live smoke runner. Runs one real streaming turn per provider whose
 * env key is present and prints the event log; providers without credentials
 * are skipped. Never part of `bun test`.
 *
 * Usage: bun packages/llms/scripts/smoke.ts
 */
import { FetchHttpClient } from "@effect/platform"
import { Effect, Stream } from "effect"
import type { Model } from "../src/index"
import { LLM } from "../src/index"
import { Anthropic, DeepSeek, OpenAI, OpenAICodex, ZAI } from "../src/providers/index"

interface SmokeTarget {
  readonly name: string
  readonly env: string
  readonly model: () => Model
}

const targets: ReadonlyArray<SmokeTarget> = [
  { name: "openai", env: "OPENAI_API_KEY", model: () => OpenAI.configure().chat("gpt-4.1-mini") },
  {
    name: "openai-codex",
    env: "OPENAI_CODEX_ACCESS_TOKEN",
    model: () => OpenAICodex.configure().model("gpt-5.5"),
  },
  {
    name: "anthropic",
    env: "ANTHROPIC_API_KEY",
    model: () => Anthropic.configure().model("claude-sonnet-4-5"),
  },
  { name: "deepseek", env: "DEEPSEEK_API_KEY", model: () => DeepSeek.model("deepseek-chat") },
  { name: "zai", env: "ZAI_API_KEY", model: () => ZAI.model("glm-4.6") },
]

const runTurn = (target: SmokeTarget) =>
  LLM.streamTurn(
    LLM.request({
      model: target.model(),
      system: "You are terse.",
      prompt: "Say hello in one short sentence.",
    }),
  ).pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => console.log(`[${target.name}]`, JSON.stringify(event))),
    ),
    Effect.provide(FetchHttpClient.layer),
  )

for (const target of targets) {
  const key = process.env[target.env]
  if (key === undefined || key === "") {
    console.log(`[${target.name}] skipped (${target.env} not set)`)
    continue
  }
  console.log(`[${target.name}] streaming one turn...`)
  try {
    await Effect.runPromise(runTurn(target))
    console.log(`[${target.name}] ok`)
  } catch (error) {
    console.error(`[${target.name}] failed:`, error)
  }
}
