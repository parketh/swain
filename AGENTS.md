# Agent Instructions

Swain is an Effect-native agent toolkit built as a Bun workspace. Discover implementation detail from the code; this file only records preferences and pointers.

## Ways of working

- Protocol-first and SDK-free: call provider HTTP APIs directly; never add provider SDKs or LLM frameworks.
- Effect idioms throughout: typed errors on the error channel, requirements via layers, cancellation via interruption.
- Dependencies are pinned exactly — no semver ranges.
- Verify before claiming done: `bun run typecheck`, `bun run format:check`, `bun test packages/llms/test`.
- Small, logically-scoped commits with conventional prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- New build phases get a numbered plan in `specs/` before implementation.
- Spec-driven development: features should be described in a spec in `specs/` before implementation. Post-implementation updates should be reflected in the spec in a `## Post-Implementation Changes` section.

## Pointers

- Architecture overview: `ARCHITECTURE.md`
- Build journals & design records: `specs/` (numbered; `0001-scaffold-llms.md` is the initial scaffold)
- Commands and structure: `README.md`
- Package-level docs: `packages/*/README.md`
