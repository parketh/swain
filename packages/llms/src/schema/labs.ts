export const Lab = {
  Anthropic: "anthropic",
  OpenAI: "openai",
  DeepSeek: "deepseek",
  ZAI: "zai",
} as const

export type Lab = (typeof Lab)[keyof typeof Lab]
