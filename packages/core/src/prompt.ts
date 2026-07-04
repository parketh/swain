import type { PermissionMode } from "./permission"

export interface SystemPromptInput {
  readonly workingDirectory: string
  readonly currentDate: string
  readonly model: string
  readonly permissionMode: PermissionMode
  readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string }>
}

/**
 * Pure assembly of the system prompt from session context and the registered
 * built-in tools. Full tool schemas travel through the `@swain/llms` `tools`
 * request field via `toLLMTool`; only names/descriptions appear here.
 */
export const assembleSystemPrompt = (input: SystemPromptInput): string => {
  const toolList = input.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
  }))

  return `You are Swain, an agentic coding assistant that helps users with software engineering tasks. You and the user share the same working directory.

Use the context and available tools to assist the user. Ask clarifying questions if needed. Respect the active permission mode.

<context>
Working directory: ${input.workingDirectory}
Current date: ${input.currentDate}
Model: ${input.model}
Permission mode: ${input.permissionMode}
</context>

Available tools:
${JSON.stringify(toolList, null, 2)}
`
}
