# Swain

> **swain** (_noun_): from Old Norse _sveinn_, a servant or attendant, someone who does work on your behalf.
>
> _...or perhaps, a_ "<ins>**S**</ins>oft<ins>**W**</ins>are <ins>**AI**</ins> e<ins>**N**</ins>gineer".

Swain is an agent harness for coding. It is organized as a Bun workspace of Effect-native packages:

- `@swain/llms`: a protocol-first, SDK-free LLM provider library implementing streaming deltas, tool-call normalization, and a provider-neutral event contract.
- `@swain/core`: the core agent harness, comprising the agentic loop, tools, memory, permissions, and file state management.
- `@swain/tui`: an Ink-based interactive CLI for running the agent loop with streaming output, commands, file search, and provider connection.

## Tech stack

- Bun
- TypeScript (ESM)
- Effect.js
- Biome
- Bun test runner

## Structure

```
packages/
  llms/    # provider-neutral LLM schema, protocols, provider facades, transport
  core/    # Effect-native agent loop: session state, tools, permissions, files
  tui/     # Ink-based interactive CLI over the core agent loop
specs/     # numbered build journals and design records
```

## Docs

- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Build journals & design records: [`specs/`](specs/)

## Commands

```bash
# install deps
bun install      
# run checks
bun run typecheck
bun run format:check
# run formatter
bun run format
# run tests
bun test packages/llms/test packages/core/test packages/tui/test
```

## Running the TUI

```bash
bun run packages/tui/bin/swain.tsx
# optional overrides
bun run packages/tui/bin/swain.tsx --model anthropic:claude-sonnet-4-5
bun run packages/tui/bin/swain.tsx --permission-mode auto
bun run packages/tui/bin/swain.tsx --resume <session-id>
```

Inside the TUI: `/connect` stores provider credentials, `/model` and `/variants`
pick the active model, `/plan` switches to plan mode, `/usage` shows counters,
`/clear` starts a fresh session, and `/resume` reopens a saved one. Shift-Tab
cycles the permission mode (`ask → auto → plan`).

## Tasks and subagents

The agent keeps a persisted per-session task list (its own to-do list) and can
delegate work to non-blocking subagents. Session metadata, transcript, and the
task graph (`tasks.json`) are stored under
`${XDG_CONFIG_HOME:-~/.config}/swain/sessions/<project-slug>/<session-id>/`.

Subagents run in their own context and report only a final result, injected back
into the parent between turns as a task notification. Three built-in types are
available: `Explore` and `Plan` are read-only; `GeneralPurpose` may implement
changes, but only inside an isolated git worktree — v1 subagents never mutate the
parent working tree directly. A retained worktree (one the child left changes in)
is surfaced on the task and never auto-deleted.

Provider credentials are stored (mode `0600`) in a global
`${XDG_CONFIG_HOME:-~/.config}/swain/auth.json`, kept separate from the
secret-free `config.json` (active model and settings) so the config file is safe
to track in dotfiles. Use `/connect` inside the TUI to store them; legacy keys
found in an older `config.json` are migrated into `auth.json` automatically on
startup. After connecting, remove any real provider keys from a local `.env`.
The `.env.example` variables remain for standalone package smoke tests and
non-TUI callers that intentionally use provider env fallbacks.