export type CommandName =
  | "clear"
  | "resume"
  | "model"
  | "variants"
  | "router"
  | "help"
  | "plan"
  | "usage"
  | "connect"
  | "compact"

export type CommandParseResult =
  | { readonly type: "command"; readonly name: CommandName; readonly args: string }
  | { readonly type: "prompt"; readonly text: string }
  | { readonly type: "unknown-command"; readonly name: string; readonly args: string }

export const COMMAND_NAMES: ReadonlyArray<CommandName> = [
  "clear",
  "resume",
  "model",
  "variants",
  "router",
  "help",
  "plan",
  "usage",
  "connect",
  "compact",
]

export interface CommandInfo {
  readonly name: CommandName
  readonly summary: string
}

/** Built-in commands with terse descriptions, for the overlay and `/help`. */
export const COMMANDS: ReadonlyArray<CommandInfo> = [
  { name: "clear", summary: "Start a new empty session" },
  { name: "resume", summary: "Resume a saved session" },
  { name: "model", summary: "Select the active provider/model" },
  { name: "variants", summary: "Change the variant for the active model" },
  { name: "router", summary: "Configure automated model routing" },
  { name: "help", summary: "Show commands and keyboard controls" },
  { name: "plan", summary: "Switch to plan mode; args submit as a prompt" },
  { name: "usage", summary: "Show token and turn counters" },
  { name: "connect", summary: "Store credentials for a provider" },
  { name: "compact", summary: "Summarize older context into one summary" },
]

const isCommandName = (value: string): value is CommandName =>
  (COMMAND_NAMES as ReadonlyArray<string>).includes(value)

/**
 * Classifies raw prompt input. Only a leading `/` (no preceding whitespace)
 * marks a command; the token up to the first whitespace is the command name and
 * the remainder is the verbatim argument string.
 */
export const parseCommand = (input: string): CommandParseResult => {
  if (!input.startsWith("/")) {
    return { type: "prompt", text: input }
  }
  const withoutSlash = input.slice(1)
  const match = withoutSlash.match(/^(\S*)\s*([\s\S]*)$/)
  const name = match?.[1] ?? ""
  const args = match?.[2] ?? ""
  if (isCommandName(name)) {
    return { type: "command", name, args }
  }
  return { type: "unknown-command", name, args }
}
