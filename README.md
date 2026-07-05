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
```

Provider credentials are stored in a global config file at
`${XDG_CONFIG_HOME:-~/.config}/swain/config.json` (mode `0600`). Use `/connect`
inside the TUI to store them; after connecting, remove any real provider keys
from a local `.env`. The `.env.example` variables remain for standalone package
smoke tests and non-TUI callers that intentionally use provider env fallbacks.