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

## Releases

- Versioning is driven by conventional commits: `fix:` → patch, `feat:` → minor, a `!`/`BREAKING CHANGE` → major. `package.json` stays private at `0.0.0`; git tags and GitHub Releases (`vX.Y.Z`) are the authoritative version source.
- Publication is automatic: pushing to `main` runs `.github/workflows/release.yml`, which invokes `semantic-release`. Its `prepare` step cross-compiles and packages the Linux artifact matrix via `bun run build:release`; `@semantic-release/github` creates the tag/Release and uploads the two archives plus `checksums.txt`.
- Release-input pins (Bun, ripgrep version + SHA-256, target matrix in `packages/tui/scripts/build-release.ts`) must be updated atomically with the code that depends on them.
- Partial-release recovery: semantic-release pushes the `vX.Y.Z` tag before uploading assets and never republishes an existing version. If a job fails mid-publish, delete **both** the remote tag and the GitHub Release before re-running — deleting the Release alone leaves the tag, which makes semantic-release skip the version. A failed job auto-opens a tracking issue.

## Pointers

- Architecture overview: `ARCHITECTURE.md`
- Build journals & design records: `specs/` (numbered; `0001-scaffold-llms.md` is the initial scaffold)
- Commands and structure: `README.md`
- Package-level docs: `packages/*/README.md`
