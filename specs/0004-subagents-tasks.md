# Agent Loop Orchestration Implementation Plan

> Use subagents to implement this plan task-by-task.

**Goal:** Improve Swain's agent loop with a persisted session-scoped task list and non-blocking subagents that can handle delegated work and report completion back to the parent session.

**Architecture:** Add two Effect-native services in `@swain/core`: a persisted `TaskStore` and an `Orchestrator`. Tasks are persisted under the existing global session store (`~/.config/swain/sessions/<project-slug>/<session-id>/tasks.json`). The `Agent` tool registers a task-backed child run, returns immediately, and a TUI-owned drain loop injects completed subagent notifications into the parent as synthetic user messages when no parent turn is running.

**Tech Stack:** Bun workspace, TypeScript ESM, Effect, Effect Schema, `@effect/platform`, `@effect/platform-bun`, `@swain/llms`, Ink/React, Bun test runner, Biome.

---

## Decisions

- The coarse plan-mode permission gate stays inline in `callTool`. Tool-specific permission checks stay inside tools.
- Tasks are **session-scoped** and persisted in the existing global session directory, not in the project tree.
- The task system is **independent of delegation**. The main agent loop uses tasks as a plain to-do list (plan, track, and update its own work) with no subagent involved. Delegation is one *optional* use of a task: `Agent` claims a task and assigns an `owner`/`agentType`. A task with no `owner` is simply parent-owned work. Subagent fields (`owner`, `agentType`, `worktreePath`, `worktreeBranch`, `parentNotifiedAt`) are all optional and unset for main-loop-only tasks.
- Task management uses separate tools: `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`. These are usable with or without subagents.
- Subagents are non-blocking by default. `Agent` returns a spawned result immediately.
- Subagent completion is persisted on the task (durable), then a contentless wake-up signal (`Queue<void>`) nudges the controller, which re-reads the durable result and injects it as a synthetic parent message. The queue carries no payload, so a crash between signal and drain loses nothing.
- The controller drains completions only while the parent is idle. It may batch multiple completions into one synthetic user message.
- Active subagents are capped by an internal `maxConcurrentSubagents`, default `4`.
- `Agent` accepts an optional `taskId`. Without one, it creates and claims a task atomically from `description` and `prompt`.
- V1 subagents must not mutate the parent worktree. `Explore` and `Plan` are read-only. `GeneralPurpose` may implement changes only inside an isolated git worktree.
- Subagent context is always a **fresh task prompt** in v1. The child's entire context is the delegated `prompt` plus task metadata; it never inherits the parent transcript. Forked context is deferred (see Deferred Follow-Ups).
- Worktree isolation is a per-subagent launch option, not a parent-session mode. V1 implements child worktree creation/cleanup for `Agent`; it does not add `EnterWorktree`/`ExitWorktree` tools that switch the parent session's cwd.
- Built-in subagent types are `Explore`, `Plan`, and `GeneralPurpose`. No custom agent loading yet.
- Subagents inherit the parent approval `permissionMode`. In `ask`, a child's approval request bubbles up through the parent approval path to the user. In `auto`, the child runs without prompts. Tool-level restriction (read-only child registries, `GeneralPurpose` worktree confinement) is independent of `permissionMode`.
- On restart, tasks left `in_progress` with an `owner` are dead mid-run children. They are reset to `pending` (clear `owner`, keep `agentType`) and re-delegated to a fresh subagent. Read-only `Explore`/`Plan` tasks re-delegate freely. Write-capable `GeneralPurpose` tasks re-delegate into a new worktree; any partial worktree from the dead run is retained and surfaced, never auto-reused or auto-deleted.
- Recovery is task-granular, not step-granular. A reassigned task restarts from scratch and may re-apply partial side effects, so delegated tasks should be scoped small enough that a full redo is cheap.
- `TaskStore` failures are a tagged `TaskError` with `reason: "not-found" | "blocked" | "already-owned" | "bad-transition"`. `already-owned` structurally prevents double-delegation of one task.

## Architecture Rationale

- The task list serves two independent purposes: (1) a persisted to-do list the main agent loop manages directly for its own multi-step work, and (2) the coordination substrate for delegated subagent runs. Purpose (1) requires no orchestrator, no subagent, and no worktree — just the task tools over `TaskStore`. Purpose (2) layers ownership, agent type, and completion notification on top of the same task records.
- The task list should be a persisted graph, not a whole-list replacement blob. Individual tasks need stable IDs, ownership, status, dependencies, and result fields so parent and child agents can coordinate safely.
- Subagents should start from an isolated child session and report only their final result to the parent. The parent should not absorb the child's intermediate tool noise unless a future inspection feature explicitly asks for it.
- Subagent progress may update UI/task state while the child runs, but progress updates are not parent conversation messages. Only the final completion/failure notification is injected into the parent model context.
- Child agents must not receive the `Agent` tool. Recursion is prevented structurally by excluding the spawn tool from every child registry.
- Async completion should be durable-before-visible: update the task result first, then ring the contentless wake-up signal. The signal is disposable; the durable task result is what the drain and restart recovery re-read, guarded by `parentNotifiedAt`. If the process dies between the two steps, the result is still found and shown after restart.
- Built-in child agent prompts should be small static definitions with explicit tool allowlists. This keeps v1 deterministic and avoids custom agent loading, prompt discovery, or user configuration semantics.
- Worktree isolation belongs in the orchestrator because it is lifecycle-bound to the child run. Session-level worktree navigation is a different workflow: it changes the parent's cwd, invalidates cwd-derived caches, and requires explicit user intent to keep or remove the session worktree.

## Current Context

- Main loop: `packages/core/src/agent.ts`
  - `runTurn` assembles the system prompt once, then calls recursive `loop`.
  - `loop` streams one model turn, appends assistant content, executes tool calls, appends tool results, and repeats.
- Tool dispatch: `packages/core/src/tool.ts`
  - `callTool` validates input, currently applies the coarse plan-mode gate, calls the tool, validates output, and converts failures to tool-result errors.
- Existing services:
  - `ToolRegistry`, `ToolContext`, `ToolProgress` are `Context.Tag` services.
  - `AskService` and approval wiring are provided by TUI runtime/controller.
- Persistence:
  - `packages/core/src/state/store.ts` persists `session.json` and `messages.jsonl` under a caller-provided `sessionsDir`.
  - `packages/tui/src/config.ts` resolves that directory under `~/.config/swain/sessions/<project-slug>`.
- TUI controller:
  - `packages/tui/src/controller.ts` owns one active parent `runTurn` fiber and already serializes parent turns through `running`, `currentFiber`, and `currentAbort`.

## Data Model

Add `packages/core/src/tasks.ts`.

```ts
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed"

export interface Task {
  readonly id: string
  readonly subject: string
  readonly description: string
  readonly status: TaskStatus
  readonly owner?: string
  readonly blockedBy: ReadonlyArray<string>
  readonly agentType?: "Explore" | "Plan" | "GeneralPurpose"
  readonly result?: string
  readonly error?: string
  readonly worktreePath?: string
  readonly worktreeBranch?: string
  readonly parentNotifiedAt?: string
  readonly createdAt: string
  readonly updatedAt: string
}
```

`worktreePath` and `worktreeBranch` are set only when a write-capable subagent leaves changes behind in an isolated worktree. Clean worktrees are removed and do not persist those fields.

`parentNotifiedAt` is the durable notification guard. A completed or failed task with a result/error and no `parentNotifiedAt` must be re-injected into the parent after restart.

On restart, a task left `status: "in_progress"` with an `owner` is a subagent that died with the process. Recovery resets it to `pending` and clears `owner` (keeping `agentType` and `description` so a replacement can be re-delegated). Completed tasks keep their `result` and are never recomputed.

## Built-In Subagents

Add `packages/core/src/subagents/definitions.ts`.

Each definition should include:

```ts
interface SubagentDefinition {
  readonly type: "Explore" | "Plan" | "GeneralPurpose"
  readonly description: string
  readonly whenToUse: string
  readonly tools: ReadonlyArray<string>
  readonly systemPrompt: string
}
```

### `Explore`

**Purpose:** fast codebase search, file discovery, and source reading.

**Tools:** `Read`, `Glob`, `Grep`, safe `Bash` commands only.

**When to use:** Use for finding files by pattern, searching for code/text, tracing where a concept is implemented, or answering factual questions about the repository. The caller should specify desired thoroughness: `quick`, `medium`, or `very thorough`.

**System prompt draft:**

```text
You are a file search and codebase exploration specialist for Swain, an AI agent harness for coding. Your job is to inspect the repository, find relevant files and code paths, and report concise findings to the parent agent.

This is a READ-ONLY exploration task:
- Do not create, edit, move, copy, or delete files.
- Do not install dependencies or run commands that change system state.
- Use Bash only for read-only commands such as ls, pwd, git status, git log, git diff, find, grep, cat, head, tail, and wc.
- Do not use shell redirection, heredocs, mkdir, touch, rm, cp, mv, chmod, chown, git add, git commit, git push, package-manager install commands, or network-mutating commands.

You will be provided with an exploration request and optionally a desired thoroughness level: quick, medium, or very thorough.

You excel at:
- Rapidly finding files using Glob and Grep
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents efficiently

Exploration guidance:
- Identify what evidence would answer the request before searching
- Start broad when the location is unknown; use Glob for file patterns and Grep for source/text searches
- Use multiple search terms when names may differ
- Use Read once search results point to likely relevant files, or when the caller provided exact paths
- Trace related code paths, tests, and documentation only as far as needed to answer the assignment
- Prioritize speed and relevance over exhaustiveness unless the caller asks for a very thorough search

Report your findings clearly and provide a concise answer to the exploration request.

Reminder: You can only explore and report. You must not edit files or run commands that change system state.
```

### `Plan`

**Purpose:** implementation planning, designing software architectures, considering tradeoffs, and creating detailed step-by-step implementation plans.

**Tools:** same as `Explore`.

**When to use:** Use when you need to plan implementation strategy before editing: architecture choices, likely files to change, risks, tradeoffs, sequencing, and validation.

**System prompt draft:**

```text
You are a software architect and planning specialist for Swain, an AI agent harness for coding. Your job is to inspect the repository, gather requirements from the user to understand the requested change, and create a detailed, step-by-step implementation plan.

This is a READ-ONLY exploration task:
- Do not create, edit, move, copy, or delete files.
- Do not install dependencies or run commands that change system state.
- Use Bash only for read-only commands such as ls, pwd, git status, git log, git diff, find, grep, cat, head, tail, and wc.
- Do not use shell redirection, heredocs, mkdir, touch, rm, cp, mv, chmod, chown, git add, git commit, git push, package-manager install commands, or network-mutating commands.

You will be provided with an initial prompt containing the requested change, its requirements, and relevant context. The user may also provide a perspective on how to approach the implementation.

Planning process:
1. Gather requirements: review the initial prompt, the user's perspective, and any relevant context to understand the requested change. Ask clarifying questions if needed.
2. Explore: search the repository for relevant files, code, and documentation. Read through any files provided. Understand the current architecture (if any). Explore existing code paths, tests, and conventions relevant to the change.
3. Design: identify the smallest coherent implementation strategy. Consider tradeoffs, risks, and validation strategies. Follow existing patterns and conventions where appropriate.
4. Plan: Create a detailed, step-by-step implementation plan. Identify dependencies and sequencing. Anticipate potential risks and challenges.

Output:
- Proposed approach.
- Ordered implementation steps.
- Files likely to change.
- Tests or validation to run.
- Open questions only when genuinely blocking.

Reminder: You can only explore and plan. You must not edit files or run commands that change system state.
```

### `GeneralPurpose`

**Purpose:** catchall agent for broader investigation and implementation work that may require code search, web lookup, multi-step analysis, file edits, and verification.

**Tools:** all built-in tools except `Agent`, `Ask`, and every `Task*` tool. When the agent runs with mutating tools, its `workingDirectory` must be an isolated git worktree, never the parent worktree.

**When to use:** Use for complex tasks that do not fit pure code search or planning, especially when the parent wants independent implementation or a broad multi-step investigation.

**System prompt draft:**

```text
You are a general-purpose agent for Swain, an AI agent harness for coding. Your job is to complete tasks using the tools available.

Complete the assigned task thoroughly within the requested scope. Do not gold-plate, and do not leave the work half-done.

Execution constraints:
- You may inspect, edit, and verify code only within your assigned working directory.
- Your assigned working directory may be an isolated git worktree. Treat it as your sandbox.
- Do not modify files outside the assigned working directory.
- Do not use the Agent tool or delegate further.
- Do not ask the user questions directly. If clarification is needed, report the blocker to the parent in your final response.
- Do not update the parent task list directly; report your result to the parent through your final response.

You will be provided with a delegated task, relevant context, and the expected output shape. The task may involve multiple steps, including repository search, code reading, web documentation lookup, implementation, and verification.

Once completed, report back with a concise summary of what was done and the key findings. 

Reminder: Complete the assigned task directly. Stay within scope and within your assigned working directory.
```

All child registries must exclude `Agent`, `Ask`, and every `Task*` tool. `Explore` and `Plan` must also exclude `Write`, `Edit`, and mutating Bash. `GeneralPurpose` may receive mutating tools only when its session runs in an isolated worktree. Child `Bash` must still enforce hard denies.

Rationale:

- Child agents must not spawn recursively in v1.
- Child agents must not initiate direct user interaction. Permission prompts are a separate runtime concern and may be surfaced through the parent approval path later, but delegated task clarification should return as the child result.
- Child agents must not directly mutate the parent task graph in v1. The orchestrator owns task claims, completion, failure, retained worktree metadata, and `parentNotifiedAt`. This keeps task persistence durable-before-visible and prevents a child from marking parent-visible work complete before the orchestrator has captured its result.

## Worktree Isolation

Implement worktree isolation as an internal utility used by `Orchestrator` when spawning a write-capable `GeneralPurpose` child. This is separate from any future tool that lets the parent session enter or exit a worktree.

`Agent` input should include `isolation?: "worktree"`. In v1:

- `GeneralPurpose` defaults to `isolation: "worktree"`.
- `Explore` and `Plan` ignore isolation and remain read-only in the parent working directory.
- No other isolation modes are accepted.

Add `packages/core/src/subagents/worktree.ts` with:

```ts
interface AgentWorktree {
  readonly path: string
  readonly branch?: string
  readonly headCommit: string
  readonly gitRoot: string
}

interface WorktreeCleanupResult {
  readonly retained: boolean
  readonly path?: string
  readonly branch?: string
}
```

Required behavior:

- Resolve the canonical git root from the parent working directory before creating a child worktree.
- Create worktrees under the canonical git root, not under the current working copy when already inside a worktree: `<git-root>/.swain/worktrees/<agent-id>`.
- Use a branch name derived from the child agent id, for example `swain-agent-<short-id>`.
- Record the initial `HEAD` commit when the worktree is created.
- Run the child with its `workingDirectory` set to the worktree path.
- On completion or failure, detect changes with both `git status --porcelain` and `git rev-list --count <headCommit>..HEAD`.
- Remove the worktree and branch automatically when there are no changes.
- Keep the worktree when there are uncommitted changes, new commits, or change detection fails.
- Persist retained `worktreePath` and `worktreeBranch` on the task before enqueueing the parent notification.
- Fail spawn with a recoverable tool error when the repository cannot create a git worktree.

Use Git worktrees only. Do not implement non-git worktree support.

## Launching Subagents

To guide the agent loop to use and launch subagents, make the following changes:

1. Add `Agent` tool with detailed usage instructions, available subagent types, prompting rules, examples, and worktree isolation notes.
2. Update the main system prompt to add a short reminder of how to use the `Agent` tool to spawn and manage subagents.

Do not duplicate the full `Agent` usage guide in the main system prompt.

### `Agent` Tool Input

Start with this input shape:

```ts
interface AgentInput {
  readonly description: string
  readonly prompt: string
  readonly subagentType?: "Explore" | "Plan" | "GeneralPurpose"
  readonly taskId?: string
  readonly isolation?: "worktree"
}
```

Field meaning:

- `description`: short 3-5 word label for UI, task ownership, and completion notifications. This is not the child task brief.
- `prompt`: full delegated task brief. In fresh mode, this becomes the child session's initial user message.
- `subagentType`: selects the child agent definition. Defaults to `GeneralPurpose`.
- `taskId`: optional existing task to claim. Without it, `Agent` creates and claims a task from `description` and `prompt`.
- `isolation`: currently only `"worktree"`. Used for write-capable `GeneralPurpose` work and defaulted by the tool when needed.

### `Agent` Tool Description

```text
Launch a new subagent to handle complex, multi-step tasks autonomously. Use this tool to carry out independent work that can run in its own context.

Available subagent types:
- Explore: fast repository search and code reading. (Tools: Read, Glob, Grep)
- Plan: read-only implementation planning and architecture analysis. (Tools: Read, Glob, Grep)
- GeneralPurpose: general-purpose investigation or implementation work, optionally in an isolated worktree. (Tools: all built-in tools except Agent, Ask, and Task* tools)

Use Agent when:
- The task is independent enough to run in parallel.
- The work would require broad search or reading many files, so would benefit from running in its own context to avoid cluttering the main context window.
- Multiple agents need to carry out mutating work in parallel; use isolated worktrees so their changes do not race in the same working copy.
- The intermediate search output is not worth keeping in the parent context.

Do not use Agent when:
- You already know the exact file to read.
- The question can be answered by one or two direct tool calls.
- You need immediate user input inside the delegated work.

Prompting rules:
- Set description to a short 3-5 word summary of what the agent will do.
- Provide a complete brief in the prompt. Fresh subagents do not know what the parent has tried unless you include it.
- Include relevant file paths, constraints, and expected output shape.
- Provide the child everything it needs in the prompt; it does not inherit the parent conversation.
- Use isolation: "worktree" for write-capable GeneralPurpose work; this is also the default for GeneralPurpose.
- If launching multiple independent agents, issue the Agent tool calls in the same model step where possible.
- Do not predict or fabricate subagent results. Wait for the task notification.
- When a notification arrives, summarize the result to the user or act on it in the next parent turn.
```

### Main System Prompt Addendum

Add this only when the `Agent` tool is available:

```text
Use Agent for independent exploration, planning, or isolated implementation work. Subagents are useful for parallel work and for keeping broad search or implementation noise out of the main context. Do not delegate work that can be handled with one or two direct tool calls. After launching a subagent, wait for its completion notification before using its result.
```

## Implementation Phases

### Task 1: Add Persisted Task Store

**Objective:** Persist a session task graph under the global session directory and expose it as an Effect service.

**Files:**
- Create: `packages/core/src/tasks.ts`
- Create: `packages/core/test/tasks.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/state/store.ts` only if shared path helpers are needed

**Steps:**
1. Add failing tests for:
   - empty store loads as `[]`.
   - `createTask` persists to `tasks.json`.
   - `updateTask` preserves unknown tasks as typed not-found errors or structured failed results.
   - blocked tasks are reported as blocked until dependencies complete.
   - completed task with no `parentNotifiedAt` is returned by `pendingParentNotifications`.
   - `resetDanglingTasks` turns an `in_progress` task with an `owner` into a `pending` task with no `owner`, keeping `agentType`, and leaves completed tasks untouched.
2. Implement `TaskStore` with an in-memory `Ref<Map<string, Task>>` and write-through persistence. Represent all store failures as a tagged `TaskError` (`reason: "not-found" | "blocked" | "already-owned" | "bad-transition"`).
3. Store at `<sessionsDir>/<sessionId>/tasks.json`.
4. Use atomic-ish writes: write JSON to a temp file in the same directory, then rename when the platform supports it.
5. Export APIs:
   - `loadTaskStore`
   - `taskStoreLayer`
   - `createTask`
   - `listTasks`
   - `getTask`
   - `updateTask`
   - `claimTask`
   - `completeTask`
   - `failTask`
   - `pendingParentNotifications`
   - `markParentNotified`
   - `resetDanglingTasks`

**Validation:**
- `bun test packages/core/test/tasks.test.ts`
- Commit: `feat(core): add persisted task store`

### Task 2: Add Task Tools

**Objective:** Let the model create, inspect, and update the task list through separate tools.

**Files:**
- Create: `packages/core/src/tools/task-create.ts`
- Create: `packages/core/src/tools/task-list.ts`
- Create: `packages/core/src/tools/task-get.ts`
- Create: `packages/core/src/tools/task-update.ts`
- Modify: `packages/core/src/tools/index.ts`
- Create: `packages/core/test/task-tools.test.ts`

**Steps:**
1. Add failing tool tests for `TaskCreate`, `TaskList`, `TaskGet`, and `TaskUpdate`.
2. Implement schemas:
   - `TaskCreate`: `{ subject, description, blockedBy? }`
   - `TaskList`: `{}`
   - `TaskGet`: `{ taskId }`
   - `TaskUpdate`: `{ taskId, subject?, description?, status?, owner?, addBlockedBy?, removeBlockedBy?, result?, error? }`
3. Return compact structured JSON from each tool plus a human-readable tool result string where current helper patterns support it.
4. Register these tools in `builtinTools`.
5. Keep tools concurrency-safe by making `TaskStore` updates serialized through the store `Ref`.

**Validation:**
- `bun test packages/core/test/task-tools.test.ts`
- Commit: `feat(core): add task list tools`

### Task 3: Add Subagent Definitions And Child Tool Registry

**Objective:** Provide the three built-in agent types and construct restricted tool registries for child sessions.

**Files:**
- Create: `packages/core/src/subagents/definitions.ts`
- Create: `packages/core/src/subagents/tools.ts`
- Create: `packages/core/test/subagent-definitions.test.ts`

**Steps:**
1. Add tests proving:
   - `Explore`, `Plan`, and `GeneralPurpose` resolve.
   - child registries never include `Agent`, `Ask`, or any `Task*` tool.
   - `Explore` and `Plan` registries never include `Write`, `Edit`, or mutating Bash.
   - `GeneralPurpose` may include `Write`, `Edit`, and normal Bash only when spawned with worktree isolation.
   - `Explore` and `Plan` omit web tools.
2. Implement static definitions with `agentType`, `description`, `whenToUse`, `systemPrompt`, and `toolNames`.
3. Add `makeChildToolRegistry(agentType, parentTools)` that filters the parent registry by definition allowlist and global child denylist.

**Validation:**
- `bun test packages/core/test/subagent-definitions.test.ts`
- Commit: `feat(core): add built-in subagent definitions`

### Task 4: Add Orchestrator And Agent Tool

**Objective:** Add the model-callable `Agent` tool that starts task-backed, detached child runs.

**Files:**
- Create: `packages/core/src/orchestrator.ts`
- Create: `packages/core/src/subagents/worktree.ts`
- Create: `packages/core/src/tools/agent.ts`
- Modify: `packages/core/src/tools/index.ts`
- Create: `packages/core/test/orchestrator.test.ts`
- Create: `packages/core/test/subagent-worktree.test.ts`
- Create: `packages/core/test/agent-tool.test.ts`

**Steps:**
1. Add failing tests for:
   - `Agent` with no `taskId` creates, claims, and returns a spawned result.
   - `Agent` with a `taskId` claims the existing task.
   - cap of `4` active subagents rejects the fifth spawn with a recoverable tool error.
   - child sessions do not include the `Agent` tool.
   - `GeneralPurpose` creates an isolated git worktree before receiving mutating tools.
   - `GeneralPurpose` completion reports retained worktree path/branch when changes remain.
   - clean `GeneralPurpose` worktrees are removed on completion.
   - worktree change detection keeps the worktree when git status/rev-list fails.
   - child completion writes `status: "completed"` and `result` to the task.
   - child failure writes `status: "failed"` and `error`.
   - `recoverDangling` resets a dangling `in_progress` task and re-spawns a subagent of the recorded `agentType`.
   - a child inheriting `ask` mode surfaces its approval request through the parent approval path.
2. Implement `Orchestrator` service:
   - holds `active: Ref<Map<agentId, Fiber.RuntimeFiber<...>>>`
   - holds `completions: Queue<void>` — a contentless **wake-up signal**, not a payload store. Child results live durably in `TaskStore`; the queue only nudges the controller to re-read it.
   - accepts an `onEvent` callback (the UI-only progress channel) and emits `subagent-start`/`subagent-progress`/`subagent-complete`/`subagent-failed` for child activity such as last tool, token count, and tool-use count. These never touch parent `session.messages`.
   - forks each child with `Effect.forkDaemon` from within the parent runtime scope so the daemon inherits the shared `ManagedRuntime` services (`LLMClient`, `TaskStore`, `AskService`, HTTP/platform). A child forked outside that scope cannot resolve them. The per-child `ToolRegistry` and `ToolContext` are **not** inherited — `spawn` provides them explicitly (step 3).
   - exposes `spawn`, `activeCount`, `completions` (the wake-up queue), `interruptAll`, and `recoverDangling`
3. `spawn` creates a child `SessionState` and provides the child effect its own services (the base `ManagedRuntime` does **not** carry these): a child `ToolRegistry` from `makeChildToolRegistry(agentType, parentTools)`, and a child `ToolContext`. The child effect is `runTurn(childSession, …).pipe(Effect.provide(childToolContextLayer), Effect.provide(childToolRegistryLayer))` before `forkDaemon`. The child `SessionState`:
   - `sessionId`: `${parent.sessionId}:${agentId}`
   - same model and current date
   - `workingDirectory` is the parent working directory for `Explore` and `Plan`
   - `workingDirectory` is a temporary git worktree for `GeneralPurpose`
   - empty file cache and locks
   The child `ToolContext` reuses the **parent's `permission`** object (read from the parent `ToolContext`, which is live inside the `Agent` tool's `call`), so an `ask`-mode child's approval requests bubble through the exact same parent approval path to the user; in `auto` the child runs without prompts. The child abort signal is a fresh per-child `AbortController` so cancelling the parent turn does not kill detached children (and vice versa).
   - read-only tool registries (`Explore`/`Plan`) and worktree confinement (`GeneralPurpose`) enforce tool-level restriction independently of `permissionMode`
4. Worktree isolation:
   - create a branch/worktree name derived from the child `agentId`
   - create the worktree under `<git-root>/.swain/worktrees/<agent-id>`
   - record the initial `HEAD` commit for cleanup decisions
   - remove the worktree automatically if no changes remain on completion
   - keep the worktree and include its path in the completion notification if changes remain
   - persist retained worktree path/branch on the task before enqueueing completion
   - fail the spawn with a recoverable tool error when the repository cannot create a worktree
5. Fresh context:
   - child messages contain one user message with the delegated prompt and task metadata.
6. Child run uses `runTurn(childSession, { maxIterations: 20 })`.
7. On completion, extract the final assistant text and persist it to the task (durable write first), then `Queue.offer(void)` on `completions` to ring the wake-up signal. Order matters: durable-before-visible.
8. Register `Agent` in parent `builtinTools` only; child registries exclude it.
9. `recoverDangling` reads the task store, resets each dangling `in_progress` task via `resetDanglingTasks`, and re-spawns a fresh subagent per reset task using its `agentType` and `description`. `GeneralPurpose` re-delegations run in a new worktree; a retained partial worktree from the dead run is left in place and surfaced.

**Validation:**
- `bun test packages/core/test/orchestrator.test.ts packages/core/test/subagent-worktree.test.ts packages/core/test/agent-tool.test.ts`
- Commit: `feat(core): add task-backed subagent spawning`

### Task 5: Wire Runtime And Controller Notification Drain

**Objective:** Provide task/subagent services in the TUI and feed completed subagent notifications back into the parent session.

**Files:**
- Modify: `packages/tui/src/runtime.ts`
- Modify: `packages/tui/src/controller.ts`
- Modify: `packages/tui/test/controller.test.ts`

**Mechanism.** A detached child has no one awaiting it, so delivery is a durable record plus a contentless wake-up:

- The **durable record** is `TaskStore` on disk. On finish the child writes its `result`/`error` to the task. If the process dies here, nothing is lost.
- The **wake-up** is `orchestrator.completions: Queue<void>` — a doorbell carrying no payload. The child rings it (`Queue.offer(void)`) *after* the durable write.
- A single **completion-listener fiber** parks on `Queue.take` (zero CPU while waiting; not a timer/poll) and calls `maybeDrainCompletions()` each time the doorbell rings.
- `maybeDrainCompletions()` decides drain-vs-defer; the actual payload is always re-read from `TaskStore`, never from the queue. This keeps the queue disposable and the `parentNotifiedAt` guard crash-safe.

**Steps:**
1. Add controller tests for:
   - task store path uses `sessionsDir(configPath, workingDirectory)`.
   - a child finishing while the parent is running defers: `drainPending` is set, no message injected yet.
   - a child finishing while idle injects one synthetic user message and starts one parent turn.
   - multiple completions are batched into one synthetic message.
   - `cancelTurn()` interrupts only the parent turn, not detached background subagents.
   - `dispose()` interrupts all active subagents and the completion-listener fiber.
   - on session load, dangling `in_progress` tasks are re-delegated via `recoverDangling`.
2. Build per-session layers for `TaskStore` and `Orchestrator`.
3. Rebuild those layers when `clearConversation()` or `resumeSession()` swaps `session`; interrupt the previous session's listener fiber and active subagents first.
4. Fork one **completion-listener fiber** per session (alongside the orchestrator): a loop that blocks on `Queue.take(orchestrator.completions)` and calls `maybeDrainCompletions()` on each wake-up.
5. Add `maybeDrainCompletions()` (decides drain-or-defer right now — not a scheduled timer):
   - if `running`, set a `drainPending` flag and return.
   - if idle, read `pendingParentNotifications()` from `TaskStore` (finished tasks with a `result`/`error` and no `parentNotifiedAt`).
   - if none pending, return.
   - append one user message containing a `<task-notification>` block per pending result.
   - set `parentNotifiedAt` on each after the message is appended.
   - run one parent `runTurn`.
6. In `runTurnNow`'s `finally`, if `drainPending` was set during the turn, clear it and call `maybeDrainCompletions()` again.
7. On session load (initial, `resumeSession()`, `clearConversation()`), after building the per-session layers and forking the listener, call `orchestrator.recoverDangling()`, then `maybeDrainCompletions()` to flush results that completed while the app was closed.

**Validation:**
- `bun test packages/tui/test/controller.test.ts`
- Commit: `feat(tui): drain subagent completions into parent turns`

### Task 6: Add Task Events And TUI Task Display

**Objective:** Make the task list visible without requiring the model to call `TaskList` for the user.

**Files:**
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/tui/src/controller.ts`
- Modify: `packages/tui/src/components/App.tsx`
- Create: `packages/tui/src/components/TaskList.tsx`
- Modify: `packages/tui/test/app.test.tsx`

**Steps:**
1. Add `AgentEvent` variants:
   - `task-updated`
   - `subagent-start`
   - `subagent-progress`
   - `subagent-complete`
   - `subagent-failed`
2. Emit events from task tools and orchestrator lifecycle (via the orchestrator's `onEvent` callback).
3. Add controller subscription state for current tasks.
4. Render a compact task list:
   - completed count, in-progress count, pending count
   - prioritize in-progress, pending unblocked, pending blocked, recent completed
   - show owner/agent type when present
5. Avoid transcript noise for task tool calls where the task panel already reflects the state.

**Validation:**
- `bun test packages/tui/test/app.test.tsx packages/tui/test/controller.test.ts`
- Commit: `feat(tui): show task list and subagent status`

### Task 7: Prompt And Documentation Updates

**Objective:** Teach the parent model when to use tasks and subagents, with the v1 safety constraints.

**Files:**
- Modify: `packages/core/src/prompt.ts`
- Modify: `packages/core/src/tools/agent.ts`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `packages/core/test/agent.test.ts`

**Steps:**
1. Add detailed `Agent` tool description guidance:
   - available subagent types and when to use each.
   - use `Agent` for independent exploration, planning, or isolated implementation.
   - default to `GeneralPurpose` when no specialized type fits.
   - use `Explore` for search, `Plan` for strategy.
   - the child gets a fresh context and does not inherit the parent conversation; put everything it needs in the prompt.
   - use `isolation: "worktree"` for write-capable `GeneralPurpose` work.
   - do not assume a background agent result before a notification arrives.
2. Add main system prompt guidance for the task tools, framed as a to-do list for the model's own multi-step work — independent of delegation. Make clear the model may create/track/update tasks without ever spawning a subagent, and that delegation via `Agent` is one optional way to advance a task.
3. Add a short main system prompt reminder about `Agent` only when the `Agent` tool is available.
4. Document persistence under `~/.config/swain/sessions`.
5. Document v1 limitation: subagents must not mutate the parent worktree; `GeneralPurpose` mutations happen in isolated worktrees.
6. Add tests proving:
   - the `Agent` tool description contains the detailed usage guidance.
   - the main system prompt contains the task to-do guidance and the compact `Agent` reminder.
   - child agent system prompts do not include parent `Agent` usage guidance.

**Validation:**
- `bun test packages/core/test/agent.test.ts`
- Commit: `docs: document task and subagent orchestration`

## Full Verification

Run before claiming complete:

```bash
bun run typecheck
bun run format:check
bun test packages/core/test packages/tui/test packages/llms/test
```

Manual smoke:

1. Start `swain` with a test model/provider.
2. Ask for a multi-part codebase investigation.
3. Confirm the parent creates tasks and spawns at least two subagents.
4. Confirm the UI remains usable while subagents run.
5. Confirm completion notifications trigger follow-up parent turns.
6. Resume the same session and confirm completed task results with no `parentNotifiedAt` are not lost.

## Risks And Tradeoffs

- **Read-only Bash classification:** `isRisky` bash safety classifier is heuristic. It should remain conservative for `Explore` and `Plan`; false positives are acceptable for v1.
- **Worktree lifecycle:** write-capable `GeneralPurpose` agents avoid parent-worktree races by editing isolated worktrees. Cleanup must be conservative: keep the worktree if change detection is uncertain.
- **No custom agents yet:** static built-ins keep the feature bounded. User/project agent definition loading is a later layer.
- **No mid-turn notification drain:** Swain v1 drains subagent completions between parent turns only. This is simpler and consistent with the current controller, but a parent may not see a child result until its current turn finishes.
- **Persistence is not transactional across transcript and task files:** `parentNotifiedAt` may fail to persist after a crash between transcript append and task update, duplicating a notification on restart. Duplicate notification is safer than losing a result.
- **Task-granular recovery:** re-delegating a dangling `in_progress` task re-runs it from scratch. A task that applied partial side effects before the crash will have them re-applied by the replacement subagent, which reads current file state and proceeds. This is not transactional; keep delegated tasks small.
- **Restart worktree leakage:** a dead `GeneralPurpose` run may leave a partial worktree. Recovery re-delegates into a fresh worktree and leaves the old one retained/surfaced rather than auto-deleting it, to avoid discarding partial work. Orphaned worktrees accumulate until manually resolved.

## Deferred Follow-Ups

These are intentionally out of scope for v1. The v1 implementation should leave clear seams for them but should not implement them.

- Add parent workflow for inspecting, applying, or discarding retained subagent worktrees.
- Add explicit `EnterWorktree` and `ExitWorktree` tools for parent-session worktree use.
- Add `context: "fork"` so a child can inherit the completed parent transcript instead of a fresh brief. Requires copying only the completed transcript and dropping any active assistant tool-call message to preserve provider invariants.
- Add user-defined agent definitions.
- Add `TaskOutput` or transcript inspection for long-running agents.
- Add addressed messages to running subagents.
- Add loop/tool hook extension points (internal typed hooks, then external/user-configurable hooks) once a second consumer beyond the plan-mode gate exists.
