/**
 * OpenAI model ids. There is no `gpt-5-codex` model: Codex is a *provider* that
 * serves these same OpenAI models, so a model like `gpt-5.5` is reachable via
 * both the `openai` and `openai-codex` providers.
 */
export const OpenAIModel = {
  GPT_5_5: "gpt-5.5",
  GPT_5_5_Pro: "gpt-5.5-pro",
} as const
export type OpenAIModel = (typeof OpenAIModel)[keyof typeof OpenAIModel]

/**
 * Reasoning effort vocabulary (the API `reasoning_effort` values). `XHigh` is
 * labelled "Extra" in the UI. `none` (no reasoning) and the ChatGPT web-only
 * `max` are deliberately absent — the router only considers reasoning configs.
 */
export const OpenAIVariant = {
  Low: "low",
  Medium: "medium",
  High: "high",
  XHigh: "xhigh",
} as const
export type OpenAIVariant = (typeof OpenAIVariant)[keyof typeof OpenAIVariant]

/**
 * Reasoning-effort levels each model supports, per the API docs. gpt-5.5 offers
 * `low`–`xhigh`; gpt-5.5-pro drops `low`. A serving provider may expose a
 * further subset.
 */
export const OpenAIModelVariants = {
  [OpenAIModel.GPT_5_5]: [
    OpenAIVariant.Low,
    OpenAIVariant.Medium,
    OpenAIVariant.High,
    OpenAIVariant.XHigh,
  ],
  [OpenAIModel.GPT_5_5_Pro]: [OpenAIVariant.Medium, OpenAIVariant.High, OpenAIVariant.XHigh],
} as const satisfies Record<OpenAIModel, ReadonlyArray<OpenAIVariant>>
