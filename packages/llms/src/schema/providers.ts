export const Provider = {
  Anthropic: "anthropic",
  OpenAI: "openai",
  DeepSeek: "deepseek",
  ZAI: "zai",
  OpenAICodex: "openai-codex",
  Pollinations: "pollinations",
} as const

export type Provider = (typeof Provider)[keyof typeof Provider]
