import { runHeadless } from "./headless"
import { runInteractive } from "./index"
import { version } from "./version"

type Env = Record<string, string | undefined>

/** A parsed `provider:model[:variant]` model reference. */
export interface ParsedModelRef {
  readonly provider: string
  readonly modelId: string
  readonly variant?: string
}

/** Where an exec run reads its single prompt from. */
export type ExecPromptSource =
  | { readonly source: "text"; readonly text: string }
  | { readonly source: "stdin" }

/** A validated `exec` invocation, before stdin is resolved. */
export interface ExecInvocation {
  readonly permissionMode: "auto" | "plan"
  readonly model?: ParsedModelRef
  readonly router: boolean
  readonly prompt: ExecPromptSource
}

export type ParsedCommand =
  | { readonly kind: "interactive"; readonly argv: ReadonlyArray<string> }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "exec"; readonly exec: ExecInvocation }
  | { readonly kind: "usage-error"; readonly message: string }

/** Resolved options handed to the headless frontend (Task 4). */
export interface HeadlessOptions {
  readonly permissionMode: "auto" | "plan"
  readonly model?: ParsedModelRef
  readonly router: boolean
  readonly prompt: string
  readonly env: Env
  readonly cwd: string
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

export interface CliDeps {
  readonly argv?: ReadonlyArray<string>
  readonly env?: Env
  readonly cwd?: string
  /** Reads all of stdin; injected in tests. */
  readonly stdin?: () => Promise<string>
  readonly stdout?: (text: string) => void
  readonly stderr?: (text: string) => void
  /** Injected in tests to assert dispatch without starting a real frontend. */
  readonly runInteractive?: (options: {
    argv: ReadonlyArray<string>
    env: Env
    cwd: string
  }) => Promise<void>
  readonly runHeadless?: (options: HeadlessOptions) => Promise<number>
}

const HELP_TEXT = `swain — an Effect-native agentic coding assistant

Usage:
  swain [--resume <id>] [--model provider:model[:variant]] [--permission-mode ask|auto|plan]
      Start the interactive TUI.

  swain exec --permission-mode auto|plan [--model provider:model[:variant]] [--router] "<prompt>"
  swain exec --permission-mode auto|plan [--model provider:model[:variant]] [--router] -
      Run one prompt non-interactively to completion and print only the final
      assistant text. Pass the prompt as a positional argument or "-" to read it
      from stdin. Routing is off by default; pass --router to enable it.

Options:
  --help, -h       Show this help and exit.
  --version, -v    Print the version and exit.
`

/** Parses `provider:model[:variant]`; rejects empty parts and extra segments. */
const parseModelRef = (value: string): ParsedModelRef | undefined => {
  const parts = value.split(":")
  if (parts.length < 2 || parts.length > 3) return undefined
  if (parts.some((part) => part === "")) return undefined
  const [provider, modelId, variant] = parts
  return {
    provider: provider!,
    modelId: modelId!,
    ...(variant !== undefined && { variant }),
  }
}

const usage = (message: string): ParsedCommand => ({ kind: "usage-error", message })

/** Parses `exec` arguments (everything after the `exec` token). */
const parseExec = (args: ReadonlyArray<string>): ParsedCommand => {
  let permissionMode: "auto" | "plan" | undefined
  let model: ParsedModelRef | undefined
  let router = false
  let promptText: string | undefined
  let promptStdin = false
  let onlyPositional = false

  const claimPrompt = (): ParsedCommand | undefined =>
    promptText !== undefined || promptStdin
      ? usage("Multiple prompt sources; provide a single prompt or -.")
      : undefined

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (!onlyPositional && arg === "--") {
      onlyPositional = true
      continue
    }
    if (!onlyPositional && arg.startsWith("--")) {
      switch (arg) {
        case "--permission-mode": {
          const value = args[i + 1]
          i += 1
          if (value === undefined)
            return usage("--permission-mode requires a value (auto or plan).")
          if (value === "ask")
            return usage("--permission-mode ask is not valid in exec; use auto or plan.")
          if (value !== "auto" && value !== "plan")
            return usage(`Invalid permission mode "${value}"; expected auto or plan.`)
          permissionMode = value
          break
        }
        case "--model": {
          const value = args[i + 1]
          i += 1
          if (value === undefined)
            return usage("--model requires a value like provider:model[:variant].")
          const ref = parseModelRef(value)
          if (ref === undefined)
            return usage(`Malformed model reference "${value}"; expected provider:model[:variant].`)
          model = ref
          break
        }
        case "--router":
          router = true
          break
        default:
          return usage(`Unknown flag "${arg}".`)
      }
      continue
    }
    if (!onlyPositional && arg === "-") {
      const clash = claimPrompt()
      if (clash !== undefined) return clash
      promptStdin = true
      continue
    }
    const clash = claimPrompt()
    if (clash !== undefined) return clash
    promptText = arg
  }

  if (permissionMode === undefined) return usage("--permission-mode is required (auto or plan).")
  if (!promptStdin && promptText === undefined)
    return usage("Missing prompt; provide a prompt string or - to read stdin.")
  if (promptText !== undefined && promptText.trim() === "") return usage("Prompt text is empty.")

  return {
    kind: "exec",
    exec: {
      permissionMode,
      ...(model !== undefined && { model }),
      router,
      prompt: promptStdin ? { source: "stdin" } : { source: "text", text: promptText! },
    },
  }
}

/**
 * Dispatches the raw argv to a command without touching stdin or starting any
 * runtime. Interactive is the default for anything that isn't `exec`, `--help`,
 * or `--version`; interactive flag parsing stays inside `runInteractive`.
 */
export const parseArgs = (argv: ReadonlyArray<string>): ParsedCommand => {
  const first = argv[0]
  if (first === "exec") return parseExec(argv.slice(1))
  if (first === "--help" || first === "-h") return { kind: "help" }
  if (first === "--version" || first === "-v") return { kind: "version" }
  return { kind: "interactive", argv }
}

/** Reads all of stdin as UTF-8 text. */
const readStdin = (): Promise<string> => Bun.stdin.text()

/**
 * CLI entrypoint. Parses argv, dispatches to the interactive or headless
 * frontend, and returns a process exit code. Only the binary assigns
 * `process.exitCode`; every dependency is injectable for unit tests.
 */
export const runCli = async (deps: CliDeps = {}): Promise<number> => {
  const argv = deps.argv ?? process.argv.slice(2)
  const env = deps.env ?? process.env
  const cwd = deps.cwd ?? process.cwd()
  const stdout = deps.stdout ?? ((text) => void process.stdout.write(text))
  const stderr = deps.stderr ?? ((text) => void process.stderr.write(text))
  const parsed = parseArgs(argv)

  switch (parsed.kind) {
    case "version":
      stdout(`${version()}\n`)
      return 0
    case "help":
      stdout(HELP_TEXT)
      return 0
    case "usage-error":
      stderr(`${parsed.message}\n`)
      return 2
    case "interactive":
      await (deps.runInteractive ?? runInteractive)({ argv: parsed.argv, env, cwd })
      return 0
    case "exec": {
      let prompt: string
      if (parsed.exec.prompt.source === "stdin") {
        const raw = await (deps.stdin ?? readStdin)()
        if (raw.trim() === "") {
          stderr("No input received on stdin.\n")
          return 2
        }
        prompt = raw
      } else {
        prompt = parsed.exec.prompt.text
      }
      const run = deps.runHeadless ?? runHeadless
      return run({
        permissionMode: parsed.exec.permissionMode,
        ...(parsed.exec.model !== undefined && { model: parsed.exec.model }),
        router: parsed.exec.router,
        prompt,
        env,
        cwd,
        stdout,
        stderr,
      })
    }
  }
}
