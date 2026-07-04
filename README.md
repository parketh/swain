# Swain

> **swain** (_noun_): from Old Norse _sveinn_, a servant or attendant, someone who does work on your behalf.
>
> _or perhaps_ ...  a "**S**oft**W**are **AI** e**N**gineer".

Swain is an agent harness for coding. It is organized as a Bun workspace of Effect-native packages:

- `@swain/llms`: a protocol-first, SDK-free LLM provider library implementing streaming deltas, tool-call normalization, and a provider-neutral event contract.
- `@swain/core`: the core agent harness, comprising the agentic loop, tools, memory, permissions, and file state management.

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
bun test packages/llms/test packages/core/test
```