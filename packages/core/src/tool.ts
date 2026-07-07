import type { JsonSchemaObject, ToolCall, ToolResultContent } from "@swain/llms"
import { Tool as LLMTool } from "@swain/llms"
import { Context, Effect, JSONSchema, Layer, ParseResult, Schema } from "effect"
import { ToolError } from "./errors"
import type { Permissions } from "./permission"
import type { SessionState } from "./state"
import { errorResult, successResult } from "./tools/results"

export interface Tool<Input, Output, ExtraRequirements = never> {
  readonly name: string
  readonly description: string
  // biome-ignore lint: encoded type is invariant; `any` lets any concrete schema fit
  readonly inputSchema: Schema.Schema<Input, any>
  // biome-ignore lint: encoded type is invariant; `any` lets any concrete schema fit
  readonly outputSchema: Schema.Schema<Output, any>
  readonly readOnly: boolean
  readonly call: (input: Input) => Effect.Effect<Output, ToolError, ExtraRequirements | ToolContext>
}

// biome-ignore lint: heterogeneous tool storage erases input/output/requirement types
export type AnyTool = Tool<any, any, any>

export class ToolRegistry extends Context.Tag("@swain/core/ToolRegistry")<
  ToolRegistry,
  ReadonlyMap<string, AnyTool>
>() {}

export const makeToolRegistry = (tools: ReadonlyArray<AnyTool>): ReadonlyMap<string, AnyTool> =>
  new Map(tools.map((tool) => [tool.name, tool]))

export const toolRegistryLayer = (tools: ReadonlyArray<AnyTool>): Layer.Layer<ToolRegistry> =>
  Layer.succeed(ToolRegistry, makeToolRegistry(tools))

/** Identity helper that preserves a tool's inferred type parameters. */
export const defineTool = <Input, Output, ExtraRequirements = never>(
  tool: Tool<Input, Output, ExtraRequirements>,
): Tool<Input, Output, ExtraRequirements> => tool

export interface ToolContextValue {
  readonly session: SessionState
  readonly abortSignal: AbortSignal
  readonly permission: Permissions
}

export class ToolContext extends Context.Tag("@swain/core/ToolContext")<
  ToolContext,
  ToolContextValue
>() {}

export interface ToolProgressValue {
  readonly emit: (delta: string) => Effect.Effect<void>
}

/**
 * Per-call advisory progress channel for long-running tools (e.g. `Bash`
 * stdout). Provided by `callTool` around each `tool.call`, keyed to the active
 * `ToolCall`; observer-less turns and one-shot tools see a no-op emitter.
 * Progress deltas are never persisted — the final `ToolResultContent` remains
 * authoritative.
 */
export class ToolProgress extends Context.Tag("@swain/core/ToolProgress")<
  ToolProgress,
  ToolProgressValue
>() {}

/**
 * Adapts a callable core `Tool` into a non-callable `@swain/llms` tool
 * definition, deriving JSON Schema for the model-facing invocation contract.
 */
export const toLLMTool = (tool: AnyTool): LLMTool =>
  LLMTool.define({
    name: tool.name,
    description: tool.description,
    inputSchema: JSONSchema.make(tool.inputSchema) as unknown as JsonSchemaObject,
    outputSchema: JSONSchema.make(tool.outputSchema) as unknown as JsonSchemaObject,
  })

const format = (error: ParseResult.ParseError): string =>
  ParseResult.TreeFormatter.formatErrorSync(error)

/**
 * Executes one model-issued tool call: decode input, apply the coarse
 * permission gate (`plan` denies non-read-only tools), run `call()`, validate
 * output, and return a `ToolResultContent`. Unknown tools, decode failures, and
 * denials surface to the model as error results so it can recover.
 */
export const callTool = (
  toolCall: ToolCall,
  onProgress?: (delta: string) => Effect.Effect<void>,
): Effect.Effect<ToolResultContent, never, ToolContext | ToolRegistry> => {
  const run = Effect.gen(function* () {
    const registry = yield* ToolRegistry
    const tool = registry.get(toolCall.name)
    if (tool === undefined) {
      return yield* new ToolError({
        tool: toolCall.name,
        reason: "unknown-tool",
        message: `Unknown tool: ${toolCall.name}`,
      })
    }

    const input = yield* Schema.decodeUnknown(tool.inputSchema)(toolCall.input).pipe(
      Effect.mapError(
        (error) =>
          new ToolError({ tool: tool.name, reason: "invalid-input", message: format(error) }),
      ),
    )

    const { session } = yield* ToolContext
    if (session.systemContext.permissionMode === "plan" && !tool.readOnly) {
      return yield* new ToolError({
        tool: tool.name,
        reason: "denied",
        message: `Plan mode denies the mutating tool "${tool.name}".`,
      })
    }

    const output = yield* tool
      .call(input)
      .pipe(Effect.provideService(ToolProgress, { emit: onProgress ?? (() => Effect.void) }))

    const validated = yield* Schema.validate(tool.outputSchema)(output).pipe(
      Effect.mapError(
        (error) =>
          new ToolError({ tool: tool.name, reason: "invalid-output", message: format(error) }),
      ),
    )

    return successResult(toolCall, validated)
  })

  return run.pipe(Effect.catchAll((error) => Effect.succeed(errorResult(toolCall, error.message))))
}
