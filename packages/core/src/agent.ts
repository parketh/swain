import type { LLMError, Tool as LLMTool } from "@swain/llms"
import { LLMClient, LLMTurnSummary, Message } from "@swain/llms"
import { Context, Effect, Stream } from "effect"
import { AgentError } from "./errors"
import { assembleSystemPrompt } from "./prompt"
import type { SessionState } from "./state"
import type { ToolContext, ToolRegistry } from "./tools"
import { callTool, ToolRegistry as ToolRegistryTag, toLLMTool } from "./tools"

type LLMClientService = Context.Tag.Identifier<typeof LLMClient.Service>

const DEFAULT_MAX_ITERATIONS = 20

export const submitPrompt = (session: SessionState, prompt: string): void => {
  session.messages.push(Message.user(prompt))
}

export interface RunTurnOptions {
  readonly maxIterations?: number
}

/**
 * Runs the agent loop over the session: assemble the system prompt, stream an
 * LLM turn, append the assistant content, and while the model keeps calling
 * tools, execute them and feed the results back. Stops when the finish reason
 * is not `tool-call`, or fails once the iteration guard is exceeded.
 */
export const runTurn = (
  session: SessionState,
  options: RunTurnOptions = {},
): Effect.Effect<void, AgentError | LLMError, LLMClientService | ToolRegistry | ToolContext> =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistryTag
    const tools = Array.from(registry.values())
    const llmTools = tools.map(toLLMTool)
    // TODO: assembled once per turn, outside the loop. Move inside `loop` once
    // the prompt depends on per-iteration state (memory, skills, MCP servers).
    const system = assembleSystemPrompt({
      workingDirectory: session.workingDirectory,
      currentDate: session.systemContext.currentDate,
      model: session.systemContext.model.id,
      permissionMode: session.systemContext.permissionMode,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
    })
    const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
    yield* loop(session, system, llmTools, maxIterations, 0)
  })

const loop = (
  session: SessionState,
  system: string,
  llmTools: ReadonlyArray<LLMTool>,
  maxIterations: number,
  iteration: number,
): Effect.Effect<void, AgentError | LLMError, LLMClientService | ToolContext | ToolRegistry> =>
  Effect.gen(function* () {
    if (iteration >= maxIterations) {
      return yield* new AgentError({
        reason: "max-iterations",
        message: `Exceeded ${maxIterations} tool iterations without completing the turn.`,
      })
    }

    const request = LLMClient.request({
      model: session.systemContext.model,
      system,
      messages: session.messages,
      ...(llmTools.length > 0 && { tools: llmTools, toolChoice: "auto" as const }),
    })
    const events = yield* LLMClient.streamTurn(request).pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    )
    const summary = yield* LLMTurnSummary.fromEvents(events)

    session.messages.push(Message.assistant(summary.assistantContent))
    session.counters.turns += 1
    if (summary.usage !== undefined) {
      session.counters.inputTokens += summary.usage.inputTokens
      session.counters.outputTokens += summary.usage.outputTokens
    }

    // Use the concrete tool-call blocks as the continuation signal, not
    // `finish.reason` alone: providers can report `tool-call` with no calls (or
    // vice versa), and the emitted blocks are what we actually execute.
    if (summary.toolCalls.length === 0) return

    const results = yield* Effect.forEach(summary.toolCalls, (toolCall) => callTool(toolCall))
    session.messages.push(Message.user(results))
    return yield* loop(session, system, llmTools, maxIterations, iteration + 1)
  })
