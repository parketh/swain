# Swain

> **swain** (_noun_): from Old Norse _sveinn_, a servant or attendant, someone who does work on your behalf.
>
> _...or perhaps, a_ "<ins>**s**</ins>oft<ins>**w**</ins>are <ins>**ai**</ins> e<ins>**n**</ins>gineer".

**Swain is a meta-agent harness for coding.** Like a regular harness, it excels at a variety of long-form coding tasks such as "implement this feature", "add a test suite", or "refactor this code". 

Unlike provider-vendored harnesses, Swain:
- is **model-agnostic**, allowing users to move seamlessly between LLMs and model providers
- uses **smart routing** to route requests to the best model for the task, reducing token usage without sacrificing response quality
- enables **cross-model workflows**, fanning-out requests to multiple LLMs, and performing cross-model peer review to find consensus

## Architecture

Swain is written in Effect.js and disributed across three packages:

- `@swain/llms`: LLM provider library implementing a provider-neutral LLM interface, streaming deltas, message protocol normalization, and shared transport.
- `@swain/core`: the core agent harness, comprising the agentic loop, session state, tools, memory, permissions, and model routing.
- `@swain/tui`: Ink-based interactive CLI for running the core agent loop; manages provider connections, slash commands, file search, and more.

```
packages/
  llms/             # provider-neutral LLM interface, message protocols, transport
  core/             # core agent loop: session state, tools, memory, routing, etc.
  tui/              # interactive CLI over the core agent loop
specs/              # numbered build journals and design records
ARCHITECTURE.md     # technical architecture
AGENTS.md           # minimal agent-facing instructions
CLAUDE.md           # redirect to AGENTS.md 
```

## Spec-driven development

Swain uses spec-driven development to guide feature development.

With agents, any well-defined spec can be trivially handed off for implementation. Specs therefore replace code as the primary artifact of software development. 

New features should be described in a numbered spec in `specs/` before implementation. Post-implementation updates, particularly where they deviate from the plan, should be reflected in a `## Post-Implementation Changes` section. This keeps documentation and code in sync.

Specs also serve as a living build journal, allowing anyone to understand how an agent harness like Swain is built from first principles.

## Docs

- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Build journals & design records: [`specs/`](specs/)
- Benchmark evals (Terminal-Bench via Harbor, DeepSWE via Pier): [`evals/README.md`](evals/README.md)

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
bun run test
bun run test:live
```

## Running the TUI

```bash
bun run packages/tui/bin/swain.tsx

# optional overrides
bun run packages/tui/bin/swain.tsx --model anthropic:claude-sonnet-4-5
bun run packages/tui/bin/swain.tsx --permission-mode auto
bun run packages/tui/bin/swain.tsx --resume <session-id>
```

Some TUI commands: 
- `/connect` stores provider credentials
- `/model` and `/variants`
pick the active model
- `/plan` switches to plan mode
- `/usage` shows counters
- `/clear` starts a fresh session
- `/resume` reopens a saved one
- Shift-Tab cycles the permission mode (`ask → auto → plan`)

## Release artifacts

Pushing to `main` publishes a GitHub Release (versioned by conventional commits) with standalone Linux archives — machine-consumed artifacts for Harbor/Pier task containers, **not yet a public `curl | bash` installer**.

Each release for version `X.Y.Z` attaches:

```text
swain-vX.Y.Z-linux-x64-glibc.tar.gz   # Debian, Ubuntu, glibc images
swain-vX.Y.Z-linux-x64-musl.tar.gz    # Alpine, musl images
checksums.txt                         # SHA-256, one line per archive
```

Each archive unpacks to a standalone `bin/swain` (no Bun required), its private `libexec/rg` sidecar, `manifest.json`, and ripgrep licenses. The `musl` binary is not fully static — on a bare Alpine image install its C++ runtime first: `apk add --no-cache libstdc++ libgcc`. glibc images (Debian, Ubuntu) already ship it. Pin the version and verify before extracting:

```bash
sha256sum -c checksums.txt
tar -xzf swain-vX.Y.Z-linux-x64-glibc.tar.gz
./bin/swain --version
```

## Evals

Swain runs reproducibly as a custom installed agent against Terminal-Bench 2 (through [Harbor](https://www.harborframework.com)) and DeepSWE (through [Pier](https://github.com/datacurve-ai/deep-swe)), installing an exact checksummed release and emitting complete ATIF v1.7 parent/subagent trajectories. See [`evals/README.md`](evals/README.md) for prerequisites, model/variant mapping, single-task acceptance, and full-run commands.

Build them locally with `bun run build:release -- --version X.Y.Z --commit <sha> --all` (requires Linux and GNU tar).