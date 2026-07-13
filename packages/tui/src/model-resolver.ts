import {
  ModelResolveError,
  type ModelResolver,
  ModelResolverService,
  type ResolvedModel,
} from "@swain/core"
import { Effect, Layer } from "effect"
import type { TuiConfig } from "./config"
import { resolveModelSelection } from "./models"
import { catalogRoutableTargets, modelKey, parseTargetId, routerSettings } from "./router"

/**
 * Builds a `ModelResolver` over the current TUI config. `getConfig` is read on
 * each resolve so credential/router changes are always seen live — the field
 * that makes the credential-race `unavailable` case observable.
 */
export const makeModelResolver = (getConfig: () => TuiConfig): ModelResolver => ({
  resolve: (targetId) =>
    Effect.suspend(() => {
      const ref = parseTargetId(targetId)
      if (ref === undefined) {
        return Effect.fail(
          new ModelResolveError({
            reason: "unknown-target",
            targetId,
            message: `Malformed target id "${targetId}".`,
          }),
        )
      }
      if (!catalogRoutableTargets().some((target) => target.id === targetId)) {
        return Effect.fail(
          new ModelResolveError({
            reason: "unknown-target",
            targetId,
            message: `No catalog target "${targetId}".`,
          }),
        )
      }
      const config = getConfig()
      const settings = routerSettings(config)
      const optedOut =
        settings.enabled !== true ||
        settings.disabledModels.includes(modelKey(ref)) ||
        settings.disabledTargets.includes(targetId)
      if (optedOut) {
        return Effect.fail(
          new ModelResolveError({
            reason: "not-enabled",
            targetId,
            message: `Target "${targetId}" is not an enabled router target.`,
          }),
        )
      }
      const result = resolveModelSelection(ref.provider, ref.modelId, ref.variant, config)
      if (result.type === "error") {
        // Enabled in intent but no longer resolvable (creds/config changed).
        return Effect.fail(
          new ModelResolveError({
            reason: "unavailable",
            targetId,
            message: result.error.message,
          }),
        )
      }
      const resolved: ResolvedModel = {
        model: result.selection.model,
        requestOptions: result.selection.requestOptions,
        modelRef: ref,
      }
      return Effect.succeed(resolved)
    }),
})

export const modelResolverLayer = (getConfig: () => TuiConfig): Layer.Layer<ModelResolverService> =>
  Layer.succeed(ModelResolverService, makeModelResolver(getConfig))
