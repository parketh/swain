# Swain

An Effect-native agent toolkit, built as a Bun workspace. The first package, `@swain/llms`, is a protocol-first, SDK-free LLM provider library: streaming deltas, tool-call normalization, and a provider-neutral event contract.

## Tech stack

Bun, TypeScript (ESM), Effect.js, `@effect/platform` `HttpClient`, Biome, Bun test runner.

## Structure

```
packages/
  llms/    # provider-neutral LLM schema, protocols, provider facades, transport
specs/     # numbered build journals and design records
```

## Commands

```bash
bun install          # install workspace dependencies
bun run typecheck    # tsc --noEmit across packages
bun run format       # biome format --write
bun run format:check # biome format (check only)
bun test packages/llms/test  # run tests
```

## Further reading

- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Build journals & design records: [`specs/`](specs/)
- Package docs: `packages/llms/README.md`
