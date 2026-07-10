import { Effect } from "effect"
import { ToolError } from "../errors"
import type { AgentType } from "../tasks"
import { type AnyTool, defineTool } from "../tool"
import { isReadOnlyCommand } from "../tools/bash"
import { getSubagentDefinition } from "./definitions"

/** Tools no child agent may ever receive: prevents recursion, direct user prompts, parent task mutation, and model switching. */
const GLOBAL_CHILD_DENY: ReadonlySet<string> = new Set([
  "Agent",
  "Ask",
  "SwitchModel",
  "TaskCreate",
  "TaskList",
  "TaskGet",
  "TaskUpdate",
])

/** Tools dropped entirely from a read-only child registry. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit"])

export interface ChildRegistryOptions {
  /** GeneralPurpose only: true when the child runs in an isolated worktree and may mutate. */
  readonly isolated?: boolean
}

/**
 * Wraps `Bash` so a read-only child can run inspection commands but never a
 * mutating or hard-denied one, independent of `permissionMode`.
 */
const readOnlyBash = (bash: AnyTool): AnyTool =>
  defineTool({
    name: bash.name,
    description: `${bash.description} Read-only subset: only allowlisted inspection commands (ls, grep, cat, git log/diff/status, …) are permitted.`,
    inputSchema: bash.inputSchema,
    outputSchema: bash.outputSchema,
    readOnly: true,
    call: (input) =>
      Effect.gen(function* () {
        const command = (input as { command: string }).command
        // Allowlist, not the RISKY denylist: a read-only child must never mutate
        // the parent worktree, so anything unrecognized is rejected.
        if (!isReadOnlyCommand(command)) {
          return yield* new ToolError({
            tool: bash.name,
            reason: "denied",
            message: `Read-only subagent can only run allowlisted inspection commands, not: ${command}`,
          })
        }
        return yield* bash.call(input)
      }),
  })

/**
 * Builds a restricted tool registry for a child session: the agent definition's
 * allowlist intersected with the parent registry, minus the global child
 * denylist. Read-only agents (`Explore`/`Plan`, and `GeneralPurpose` without
 * worktree isolation) drop `Write`/`Edit` and receive a read-only `Bash`.
 */
export const makeChildToolRegistry = (
  agentType: AgentType,
  parentTools: ReadonlyMap<string, AnyTool>,
  options: ChildRegistryOptions = {},
): ReadonlyMap<string, AnyTool> => {
  const definition = getSubagentDefinition(agentType)
  const readOnly = agentType === "GeneralPurpose" ? options.isolated !== true : true
  const allow = new Set(definition.tools.filter((name) => !GLOBAL_CHILD_DENY.has(name)))

  const registry = new Map<string, AnyTool>()
  for (const [name, tool] of parentTools) {
    if (!allow.has(name)) continue
    if (readOnly && MUTATING_TOOLS.has(name)) continue
    registry.set(name, readOnly && name === "Bash" ? readOnlyBash(tool) : tool)
  }
  return registry
}
