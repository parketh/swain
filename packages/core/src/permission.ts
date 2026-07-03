import type { Effect } from "effect"

export type PermissionMode = "plan" | "ask" | "auto"

export type PermissionDecision =
  | { readonly type: "allow" }
  | { readonly type: "deny"; readonly reason: string }
  | { readonly type: "ask"; readonly reason: string }

export interface PermissionRequest {
  readonly toolName: string
  readonly readOnly: boolean
  readonly summary: string
  readonly command?: string
  readonly diff?: string
}

/**
 * Injectable permission gate a tool consults once it has enough context to
 * explain the request (an `Edit` diff, a `Bash` command). The mode-aware
 * implementation and interactive approval layer live alongside in Task 6.
 */
export interface Permissions {
  readonly check: (request: PermissionRequest) => Effect.Effect<PermissionDecision>
}
