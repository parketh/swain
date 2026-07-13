import { Effect, Schema } from "effect"
import { ToolError } from "../errors"
import { defineTool } from "../tool"

export const SWITCH_MODEL_NAME = "SwitchModel"

export const SwitchModelInput = Schema.Struct({
  /** Target id `provider:modelId[:variant]` from the routable-targets list. */
  model: Schema.String,
  /** A short justification for the switch, recorded in the transcript. */
  reason: Schema.String,
})
export type SwitchModelInput = typeof SwitchModelInput.Type

// A successful switch is intercepted as control flow and never surfaces a tool
// result, so the only result the model ever receives is the same-target no-op.
export const SwitchModelResult = Schema.Struct({
  status: Schema.Literal("noop"),
  model: Schema.String,
})

export const SWITCH_MODEL_DESCRIPTION = `Switch the model handling this conversation to one of the enabled routable targets.

- Pass \`model\` as a target id exactly as listed in the routable-targets block (\`provider:modelId[:variant]\`), plus a short \`reason\`.
- Emit SwitchModel as your ONLY tool call and then stop: any sibling tool calls in the same message are dropped and must be reissued after the switch.
- Switching to the current target is a no-op. At most one switch takes effect per user turn.
- Prefer choosing the right target at the start of a conversation; later switches should usually be upward escalation for complexity, risk, or correctness — not cost-only down-routing.`

/**
 * Model-visible routing control. The agent loop intercepts a `SwitchModel` call
 * as control flow — resolving the target, recording a transcript switch event,
 * and continuing the turn on the new model — so this `call` is never reached on
 * the normal tool path. It exists for registry membership and LLM exposure;
 * being read-only, it is also allowed in plan permission mode.
 */
export const SwitchModel = defineTool({
  name: SWITCH_MODEL_NAME,
  description: SWITCH_MODEL_DESCRIPTION,
  inputSchema: SwitchModelInput,
  outputSchema: SwitchModelResult,
  readOnly: true,
  call: () =>
    Effect.fail(
      new ToolError({
        tool: SWITCH_MODEL_NAME,
        reason: "precondition-failed",
        message: "SwitchModel is handled by the router and cannot be executed as an ordinary tool.",
      }),
    ),
})
