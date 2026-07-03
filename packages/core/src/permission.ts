export type PermissionMode = "plan" | "ask" | "auto"

export type PermissionDecision =
  | { readonly type: "allow" }
  | { readonly type: "deny"; readonly reason: string }
  | { readonly type: "ask"; readonly reason: string }
