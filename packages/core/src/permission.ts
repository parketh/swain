import { Context, Effect } from "effect"

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
 * explain the request (an `Edit` diff, a `Bash` command).
 */
export interface Permissions {
  readonly check: (request: PermissionRequest) => Effect.Effect<PermissionDecision>
}

/**
 * Interactive approval source consulted by `ask` mode. The runtime wires a real
 * prompt; tests inject a fake that records requests and returns fixed answers.
 */
export interface Approval {
  readonly requestApproval: (request: PermissionRequest) => Effect.Effect<PermissionDecision>
}

export class ApprovalService extends Context.Tag("@swain/core/ApprovalService")<
  ApprovalService,
  Approval
>() {}

export const allow: PermissionDecision = { type: "allow" }
export const deny = (reason: string): PermissionDecision => ({ type: "deny", reason })

/** Approval that allows every request without interaction. */
export const autoApproval: Approval = { requestApproval: () => Effect.succeed(allow) }

/**
 * Builds the mode-aware permission gate:
 * - `plan`: read-only allowed, mutating denied.
 * - `auto`: allowed without interactive approval (validation/hard-denies run elsewhere).
 * - `ask`: read-only allowed, mutating delegated to the approval source.
 *
 * `getMode` is read at each `check`, not captured, so a mid-turn mode switch
 * (Shift+Tab to `auto`) takes effect on the very next tool without rebuilding
 * the gate.
 */
export const makePermissions = (
  getMode: () => PermissionMode,
  approval: Approval,
): Permissions => ({
  check: (request) => {
    switch (getMode()) {
      case "plan":
        return Effect.succeed(
          request.readOnly
            ? allow
            : deny(`Plan mode denies the mutating tool "${request.toolName}".`),
        )
      case "auto":
        return Effect.succeed(allow)
      case "ask":
        return request.readOnly ? Effect.succeed(allow) : approval.requestApproval(request)
    }
  },
})
