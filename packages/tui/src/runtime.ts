import { FetchHttpClient, type HttpClient } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { type Approval, makePermissions, type PermissionMode, type SessionState } from "@swain/core"
import {
  type AskHandler,
  AskService,
  builtinTools,
  ToolContext,
  toolRegistryLayer,
} from "@swain/core/tools"
import { LLMClient } from "@swain/llms/client"
import { type Context, Layer, ManagedRuntime } from "effect"

export type LLMClientService = Context.Tag.Identifier<typeof LLMClient.Service>

export interface RuntimeDeps {
  readonly askHandler: AskHandler
  /** Test override; defaults to the real streaming client over HTTP. */
  readonly llmLayer?: Layer.Layer<LLMClientService>
  readonly httpLayer?: Layer.Layer<HttpClient.HttpClient>
}

export const makeRuntime = (deps: RuntimeDeps) => {
  const http = deps.httpLayer ?? FetchHttpClient.layer
  const llm = deps.llmLayer ?? LLMClient.layer.pipe(Layer.provide(http))
  const base = Layer.mergeAll(
    llm,
    http,
    BunContext.layer,
    toolRegistryLayer(builtinTools),
    Layer.succeed(AskService, deps.askHandler),
  )
  return ManagedRuntime.make(base)
}

/** Per-turn `ToolContext`: it carries the live session, abort signal, and mode. */
export const toolContextLayer = (
  session: SessionState,
  mode: PermissionMode,
  approval: Approval,
  abortSignal: AbortSignal,
): Layer.Layer<ToolContext> =>
  Layer.succeed(ToolContext, {
    session,
    abortSignal,
    permission: makePermissions(mode, approval),
  })
