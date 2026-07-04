/**
 * Minimal interactive REPL for the core agent loop.
 *
 * Wires REAL layers (Anthropic model + Bun filesystem/shell + Exa web) against a
 * workspace and keeps ONE session alive across prompts, so the conversation and
 * file-state cache carry over turn to turn. Type a prompt, watch the loop run
 * tools, repeat.
 *
 *   ANTHROPIC_API_KEY=... bun packages/core/scripts/repl.ts
 *
 * Env:
 *   MODE=plan|ask|auto   permission mode (default: ask)
 *   MODEL=claude-...      model id (default: claude-sonnet-4-5)
 *   WORKDIR=/abs/path     workspace to operate in (default: a fresh temp dir with seed files)
 *
 * REPL commands: /exit, /counters, /messages
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import { FetchHttpClient } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import {
  createSessionState,
  makePermissions,
  type PermissionMode,
  runTurn,
  submitPrompt,
} from "@swain/core"
import {
  Ask,
  AskService,
  Bash,
  Edit,
  Glob,
  Grep,
  Read,
  ToolContext,
  toolRegistryLayer,
  WebFetch,
  WebSearch,
  Write,
} from "@swain/core/tools"
import { LLMClient } from "@swain/llms/client"
import { Anthropic } from "@swain/llms/providers"
import { Effect, Layer } from "effect"

const mode = (process.env.MODE ?? "ask") as PermissionMode
const modelId = process.env.MODEL ?? "claude-sonnet-4-5"

const workdir =
  process.env.WORKDIR ??
  (() => {
    const dir = mkdtempSync(join(tmpdir(), "swain-repl-"))
    writeFileSync(join(dir, "notes.txt"), "alpha\nbeta\ngamma\n")
    writeFileSync(join(dir, "README.md"), "# sandbox\nseed workspace for the swain repl\n")
    return dir
  })()

const model = Anthropic.configure().model(modelId)
const session = createSessionState({
  workingDirectory: workdir,
  model,
  permissionMode: mode,
  currentDate: new Date().toISOString().slice(0, 10),
})

const rl = createInterface({ input: process.stdin, output: process.stdout })

// Interactive approval: prompt y/N on the terminal. In `auto` this is never hit;
// in `ask` it gates every mutating tool.
const approval = {
  requestApproval: (req: { toolName: string; summary: string }) =>
    Effect.promise(async () => {
      const answer = await rl.question(`  ? approve ${req.toolName} — ${req.summary} [y/N] `)
      return answer.trim().toLowerCase() === "y"
        ? { type: "allow" as const }
        : { type: "deny" as const, reason: "user declined" }
    }),
}

// Ask handler: forward each question to the terminal, one option per line.
const askLayer = Layer.succeed(AskService, {
  ask: (input) =>
    Effect.promise(async () => {
      const answers = []
      for (const q of input.questions) {
        const menu = q.options
          .map((o, i) => `    ${i + 1}) ${o.label} — ${o.description}`)
          .join("\n")
        const raw = await rl.question(`  ${q.question}\n${menu}\n  choose: `)
        const idx = Math.max(1, Math.min(q.options.length, Number(raw) || 1)) - 1
        const label = (q.options[idx] ?? q.options[0])?.label ?? ""
        answers.push({ question: q.question, selected: [label] })
      }
      return { answers }
    }),
})

const toolContext = Layer.succeed(ToolContext, {
  session,
  abortSignal: new AbortController().signal,
  permission: makePermissions(mode, approval),
})

const http = FetchHttpClient.layer
const layers = Layer.mergeAll(
  toolRegistryLayer([Read, Write, Edit, Glob, Grep, Bash, WebSearch, WebFetch, Ask]),
  toolContext,
  askLayer,
  LLMClient.layer.pipe(Layer.provide(http)),
  http,
  BunContext.layer,
)

const preview = (value: unknown): string => {
  const s = typeof value === "string" ? value : JSON.stringify(value)
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

// biome-ignore lint/suspicious/noExplicitAny: rendering opaque message content
const render = (messages: ReadonlyArray<any>): void => {
  for (const m of messages) {
    for (const c of m.content) {
      if (c.type === "text")
        console.log(m.role === "assistant" ? `\n${c.text}` : `  ↩ ${preview(c.text)}`)
      else if (c.type === "tool-call") console.log(`  ⚙ ${c.name} ${preview(c.input)}`)
      else if (c.type === "tool-result")
        console.log(`  ${c.isError ? "✗" : "←"} ${c.name ?? ""} ${preview(c.result?.value)}`)
    }
  }
}

console.log(`swain repl · workdir=${workdir} · mode=${mode} · model=${modelId}`)
console.log("type a prompt, or /exit /counters /messages\n")

for (;;) {
  let line: string
  try {
    line = (await rl.question("> ")).trim()
  } catch {
    break // stdin reached EOF (piped input)
  }
  if (line === "") continue
  if (line === "/exit" || line === "/quit") break
  if (line === "/counters") {
    console.log(session.counters)
    continue
  }
  if (line === "/messages") {
    console.log(JSON.stringify(session.messages, null, 2))
    continue
  }

  const start = session.messages.length
  submitPrompt(session, line)
  await Effect.runPromise(runTurn(session).pipe(Effect.provide(layers))).then(
    () => render(session.messages.slice(start + 1)),
    (err) => console.error("RUN FAILED:", err),
  )
}

rl.close()
