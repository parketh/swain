# Swain

> **swain** (_noun_): from Old Norse _sveinn_, a servant or attendant, someone who does work on your behalf.
>
> _or perhaps_ ...  a "**S**oft**W**are **AI** e**N**gineer".

Swain is an agent harness for coding. The first package, `@swain/llms`, is a protocol-first, SDK-free LLM provider library implementing streaming deltas, tool-call normalization, and a provider-neutral event contract.

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
specs/     # numbered build journals and design records
```

## Docs

- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Build journals & design records: [`specs/`](specs/)
- Package docs: `packages/llms/README.md`

## Commands

```bash
# install deps
bun install      
# run type checks
bun run typecheck
# run format + lint
bun run format
bun run format:check
# run tests
bun test packages/llms/test
```