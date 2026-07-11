/**
 * Live routing eval: drives the REAL Codex `gpt-5.5` model as the router's
 * "picker" and checks the tier-classification prompt right-sizes the model —
 * cheap tasks stay cheap, only risk-critical work reaches the top. Hits the
 * ChatGPT/Codex backend and costs tokens, so it lives under `test/live/`, which
 * the default `test` scripts exclude via `--path-ignore-patterns`. Run it
 * explicitly (needs a valid `OPENAI_CODEX_ACCESS_TOKEN`):
 *
 *   bun run test:live            # from packages/tui, or the repo root
 *
 * The menu is a broad capability ladder (37→56) so a graduated choice is even
 * possible. The picker's choices are non-deterministic, so assertions check a
 * loose per-tier band plus a monotonic Simple ≤ Routine ≤ Complex < Critical
 * ordering — the point is that it does NOT route everything to the strongest
 * model. Only the first turn is a real API call; the target it switches to
 * resolves to a stub so the continuation ends at once.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FetchHttpClient } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import {
  createSessionState,
  ModelResolveError,
  ModelResolverService,
  modelRefKey,
  type Permissions,
  type ResolvedModel,
  runTurn,
  type SessionState,
  submitPrompt,
  taskStoreLayer,
} from "@swain/core"
import { builtinTools, ToolContext, toolRegistryLayer } from "@swain/core/tools"
import { type LLMEvent, type Model, ModelId, ProviderId } from "@swain/llms"
import { LLMClient } from "@swain/llms/client"
import { OpenAICodex } from "@swain/llms/providers"
import { Effect, Layer, Stream } from "effect"
import { catalogRoutableTargets, parseTargetId } from "../../src/router"

type Variant = "low" | "high" | "xhigh"
type Target = { id: string; label: string; capability: number; avgCostPerTask: number }

// Every id, label, capability, and cost is imported from the tui catalog so this
// stays in sync with production — no metric is re-typed here.
const fromCatalog = (id: string): Target => {
  const t = catalogRoutableTargets().find((target) => target.id === id)
  if (t?.routing?.capability === undefined || t.routing.avgCostPerTask === undefined) {
    throw new Error(`catalog target "${id}" is missing routing metadata`)
  }
  return {
    id: t.id,
    label: t.label,
    capability: t.routing.capability,
    avgCostPerTask: t.routing.avgCostPerTask,
  }
}

// A broad capability ladder (37 → 56) with the three gpt-5.5 tiers as the
// picker's own rows, so it can move down, sideways, or up to another provider.
const TARGETS = [
  "deepseek:deepseek-v4-flash:high", // 37
  "deepseek:deepseek-v4-pro:max", // 44
  "zai:glm-5.2:max", // 51
  "openai-codex:gpt-5.5:low", // 43
  "openai-codex:gpt-5.5:high", // 53
  "openai-codex:gpt-5.5:xhigh", // 55
  "anthropic:claude-opus-4-8:max", // 56
].map(fromCatalog)

const STRONGEST = Math.max(...TARGETS.map((t) => t.capability))
const capOf = (id: string): number | undefined => TARGETS.find((t) => t.id === id)?.capability

const GPT: Record<Variant, string> = {
  low: "openai-codex:gpt-5.5:low",
  high: "openai-codex:gpt-5.5:high",
  xhigh: "openai-codex:gpt-5.5:xhigh",
}

const allow: Permissions = { check: () => Effect.succeed({ type: "allow" }) }

// After a switch the turn continues on the resolved model. We don't want a
// second real API call, so the stub emits an immediate finish (an empty stream
// would trip the loop's "missing finish event" guard).
const stubFinish: ReadonlyArray<LLMEvent> = [
  { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } },
]

const stub = (targetId: string): ResolvedModel => {
  const ref = parseTargetId(targetId)!
  const model: Model = {
    id: ModelId.make(ref.modelId),
    provider: ProviderId.make(ref.provider),
    streamTurn: () => Stream.fromIterable(stubFinish),
  }
  return { model, requestOptions: {}, modelRef: ref }
}

const resolverLayer = Layer.succeed(ModelResolverService, {
  resolve: (targetId: string) =>
    TARGETS.some((t) => t.id === targetId)
      ? Effect.succeed(stub(targetId))
      : Effect.fail(
          new ModelResolveError({ reason: "unknown-target", targetId, message: `no ${targetId}` }),
        ),
})

const picker = (): Model => OpenAICodex.configure({}).model("gpt-5.5")

// A real (empty) working dir so any filesystem/task tool the picker calls instead
// of routing degrades to a recoverable error rather than crashing the loop.
const workingDirectory = mkdtempSync(join(tmpdir(), "router-eval-"))

const session = (variant: Variant): SessionState =>
  createSessionState({
    workingDirectory,
    model: picker(),
    modelRef: { provider: "openai-codex", modelId: "gpt-5.5", variant },
    requestOptions: { providerOptions: { openaiCodex: { reasoning: { effort: variant } } } },
    currentDate: "2026-07-11",
  })

const ctxLayer = (state: SessionState) =>
  Layer.succeed(ToolContext, {
    session: state,
    abortSignal: new AbortController().signal,
    permission: allow,
  })

interface Outcome {
  readonly from: string
  readonly chosen: string
  readonly capability: number
  readonly turns: number
  readonly reason?: string
}

const route = async (prompt: string, variant: Variant): Promise<Outcome> => {
  const state = session(variant)
  submitPrompt(state, prompt)
  await Effect.runPromise(
    // maxIterations 2: the routing decision is always turn 1; this just bounds a
    // non-switch case to one forced-final turn instead of letting it wander
    // through slow tool work and blow the timeout.
    runTurn(state, { router: { targets: TARGETS }, maxIterations: 2 }).pipe(
      Effect.provide(LLMClient.layer.pipe(Layer.provide(FetchHttpClient.layer))),
      Effect.provide(ctxLayer(state)),
      Effect.provide(toolRegistryLayer(builtinTools)),
      Effect.provide(resolverLayer),
      Effect.provide(taskStoreLayer(workingDirectory)),
      Effect.provide(BunContext.layer),
    ),
  )
  const switched = state.systemContext.pastModels.length > 0
  const target = modelRefKey(state.systemContext.modelRef)
  const block = state.messages
    .flatMap((m) => m.content as ReadonlyArray<Record<string, unknown>>)
    .find((b) => b.type === "model-switch")
  return {
    from: GPT[variant],
    chosen: switched ? target : "did not switch",
    capability: capOf(target)!,
    turns: state.counters.turns,
    ...(block !== undefined && { reason: block.reason as string }),
  }
}

// The four canonical tiers with loose per-tier capability bands over the 37→56
// menu. Bands overlap on purpose (tiers aren't razor-sharp); the ceilings are
// what enforce right-sizing.
const LADDER = [
  {
    bucket: "simple",
    floor: 37,
    ceil: 44,
    prompt: "Fix the typo: change 'recieve' to 'receive' in the README. Nothing else.",
  },
  {
    bucket: "routine",
    floor: 43,
    ceil: 53,
    prompt: "Add a REST CRUD endpoint.",
  },
  {
    bucket: "complex",
    floor: 51,
    ceil: 55,
    prompt:
      "Refactor the auth module across these files to extract a shared session service and update every call site.",
  },
  {
    bucket: "critical",
    floor: 55,
    ceil: 56,
    prompt:
      "Audit this Solidity vault contract for reentrancy and fund-draining bugs before mainnet deployment; correctness is critical.",
  },
] as const

const CRITICAL_PROMPT = LADDER.find((s) => s.bucket === "critical")!.prompt

// Adversarial cases: the "right" tier is deliberately at odds with a surface cue
// (size, breadth, urgency words, or a mix). Bands assert only *defensible*
// minimums — the clear misroutes — because the exact tier for some is a genuine
// judgment call (is a bcrypt swap "critical" or "routine"?). The logged choice +
// reason is the real payload; the assert just catches gross errors.
const ADVERSARIAL = [
  {
    // A password-hashing change is security-sensitive: not the weakest model.
    label: "small but security-critical",
    floor: 44,
    ceil: 56,
    prompt: "In auth.ts, replace the MD5 password hashing with bcrypt. It's one function.",
  },
  {
    // A mechanical rename, however broad, does not need the strongest model.
    label: "broad but mechanical",
    floor: 37,
    ceil: 55,
    prompt:
      "Rename the function `getUser` to `fetchUser` across all ~40 files in the repo. Purely mechanical, no logic changes.",
  },
  {
    // A typo is a typo regardless of urgency words.
    label: "hype-framed triviality",
    floor: 37,
    ceil: 44,
    prompt: "URGENT!! CRITICAL!! Immediately fix the typo 'teh' -> 'the' in the footer text.",
  },
  {
    // An explicit cost cue should pin it to the cheap end.
    label: "explicit cost cue",
    floor: 37,
    ceil: 44,
    prompt:
      "Write a quick throwaway one-off script to count TODO comments. Don't overthink it — cheapest and fastest is fine.",
  },
  {
    // Hard but low-risk: real capability, but not the top (reserved for risk).
    label: "hard but low-risk",
    floor: 44,
    ceil: 55,
    prompt:
      "Implement an efficient solution to: given N up to 1e6, count the distinct subsequences of a string modulo 1e9+7.",
  },
  {
    // Contains a security audit: the strongest requirement must win.
    label: "mixed trivial + critical",
    floor: 55,
    ceil: 56,
    prompt:
      "First fix the typo in the README, then audit the payment-processing module for security vulnerabilities.",
  },
] as const

const VARIANTS: ReadonlyArray<Variant> = ["low", "high", "xhigh"]
const TIMEOUT = 180_000

// Collect out-of-band cases rather than throwing on the first, so one bad route
// never hides the rest of the run.
const bandViolations = (
  cases: ReadonlyArray<{ out: Outcome; floor: number; ceil: number; label: string }>,
): string[] =>
  cases
    .filter(({ out, floor, ceil }) => out.capability < floor || out.capability > ceil)
    .map(
      ({ label, out, floor, ceil }) =>
        `${label}: cap ${out.capability} ∉ [${floor}, ${ceil}] (${out.chosen})`,
    )

const runLadder = async (start: Variant) => {
  const results = await Promise.all(
    LADDER.map(async (s) => ({ s, out: await route(s.prompt, start) })),
  )
  for (const { s, out } of results) {
    console.log(`[${start}/${s.bucket}] ${out.chosen} (cap ${out.capability})`, out.reason ?? "")
  }
  expect(
    bandViolations(
      results.map(({ s, out }) => ({ out, floor: s.floor, ceil: s.ceil, label: s.bucket })),
    ),
  ).toEqual([])
  const cap = Object.fromEntries(results.map(({ s, out }) => [s.bucket, out.capability]))
  // A genuinely graduated ladder — not everything pinned to the top.
  expect(cap.simple).toBeLessThanOrEqual(cap.routine!)
  expect(cap.routine).toBeLessThanOrEqual(cap.complex!)
  expect(cap.complex).toBeLessThan(cap.critical!)
  expect(cap.critical).toBe(STRONGEST)
}

describe("router picker (live Codex gpt-5.5)", () => {
  // From a high start, down-routing to the cheap tiers is the interesting move.
  test("graduated ladder holds from a high (xhigh) start", () => runLadder("xhigh"), TIMEOUT)

  // From a low start, up-routing the hard tiers is the interesting move.
  test("graduated ladder holds from a low start", () => runLadder("low"), TIMEOUT)

  test(
    "edge cases: classify by the real work, not size, breadth, or framing",
    async () => {
      const results = await Promise.all(
        ADVERSARIAL.map(async (s) => ({ s, out: await route(s.prompt, "xhigh") })),
      )
      for (const { s, out } of results) {
        console.log(`[edge: ${s.label}] ${out.chosen} (cap ${out.capability})`, out.reason ?? "")
      }
      expect(bandViolations(results.map(({ s, out }) => ({ out, ...s })))).toEqual([])
    },
    TIMEOUT,
  )

  test(
    "classification is start-invariant: a critical task escalates from any start",
    async () => {
      const outs = await Promise.all(VARIANTS.map((v) => route(CRITICAL_PROMPT, v)))
      outs.forEach((out, i) =>
        console.log(
          `[start ${VARIANTS[i]}] ${out.chosen} (cap ${out.capability})`,
          out.reason ?? "",
        ),
      )
      for (const out of outs) expect(out.capability).toBeGreaterThanOrEqual(STRONGEST - 1)
    },
    TIMEOUT,
  )
})
