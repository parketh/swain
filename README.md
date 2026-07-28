# Swain

> **swain** (_noun_): from Old Norse _sveinn_, a servant or attendant, someone who does work on your behalf.
>
> _...or perhaps, a_ "<ins>**s**</ins>oft<ins>**w**</ins>are <ins>**ai**</ins> e<ins>**n**</ins>gineer".

**Swain is an experimental agent harness for coding.** Like a regular harness, it excels at a variety of long-form coding tasks such as "implement this feature", "add a test suite", or "refactor this code". 

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
evals/              # eval harness for benchmarking Swain against TB2, DeepSWE, etc.
ARCHITECTURE.md     # technical architecture
AGENTS.md           # minimal agent-facing instructions
CLAUDE.md           # redirect to AGENTS.md 
```

## Auto-improvement loop

After hand-building an initial feature set, Swain was handed off to agents to automatically propose, implement and evaluate candidate improvements using self-guided loops. Loop broadly iterate over the following steps:

1. Review: the agent runs benchmarks, reviews past execution traces and inspects build journals to propose candidate improvements to the harness code
2. Plan: the agent writes a numbered [build spec](#spec-driven-development) breaking down the proposed code changes into small, self-contained and independently verifiable tasks
3. Implement: agents implement the change according to the build spec, and hands this off for adverserial review
4. Test: eval benchmarks (e.g. Terminal-Bench 2.0, DeepSWE) are rerun to generate new scores and execution traces
5. Gate: the proposed change is either kept or rolled back depending on benchmark results, with full logs and traces preserved to guide future iteration

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

## Evals

Supported evals:
- Terminal-Bench 2 (via [Harbor](https://www.harborframework.com))
- DeepSWE (via [Pier](https://github.com/datacurve-ai/deep-swe))

See [`evals/README.md`](evals/README.md) for more details.
