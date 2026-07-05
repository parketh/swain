import { allow, deny, type PermissionDecision } from "@swain/core"

export const DENY_REASON = "Denied by user."

export interface PermissionChoice {
  readonly label: string
  readonly decision: PermissionDecision
}

/**
 * The two explicit choices offered for a tool approval. A session-scoped
 * "always allow" option is intentionally omitted in this slice; that behavior,
 * if any, stays inside the approval service rather than the UI.
 */
export const PERMISSION_CHOICES: ReadonlyArray<PermissionChoice> = [
  { label: "Yes, allow this request", decision: allow },
  { label: "No, deny this request", decision: deny(DENY_REASON) },
]

export const denyDecision: PermissionDecision = deny(DENY_REASON)
