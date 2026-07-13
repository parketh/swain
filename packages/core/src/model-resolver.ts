import type { Model } from "@swain/llms"
import { Context, Data, type Effect } from "effect"
import type { RequestOptions, SessionModelRef } from "./state"

/** A resolved routable target: a live model plus its request options and identity. */
export interface ResolvedModel {
  readonly model: Model
  readonly requestOptions: RequestOptions
  readonly modelRef: SessionModelRef
}

/**
 * Why a target id could not be resolved to a live model:
 * - `unknown-target`: the id is malformed or names no catalog target.
 * - `not-enabled`: a real target that the router config has opted out.
 * - `unavailable`: a real, enabled target whose credentials/config disappeared
 *   between prompt assembly and execution (a recoverable race).
 */
export class ModelResolveError extends Data.TaggedError("ModelResolveError")<{
  readonly reason: "unknown-target" | "not-enabled" | "unavailable"
  readonly targetId: string
  readonly message: string
}> {}

/**
 * Resolves router target ids to live models without importing TUI catalog code.
 * The TUI provides the implementation; core tools (`SwitchModel`, `Agent.model`)
 * consume it. A resolved target's request options fully replace the previous
 * model's options — they are never merged.
 */
export interface ModelResolver {
  readonly resolve: (targetId: string) => Effect.Effect<ResolvedModel, ModelResolveError>
}

export class ModelResolverService extends Context.Tag("@swain/core/ModelResolver")<
  ModelResolverService,
  ModelResolver
>() {}
