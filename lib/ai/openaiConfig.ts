export const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

type EnvLike = Record<string, string | undefined>;

export function getOpenAiApiKey(env: EnvLike = process.env): string {
  return (env.OPENAI_API_KEY || "").trim();
}

export function getOpenAiModel(env: EnvLike = process.env): string {
  const model = (env.OPENAI_MODEL || "").trim();
  return model || DEFAULT_OPENAI_MODEL;
}

export function isOpenAiConfigured(env: EnvLike = process.env): boolean {
  return Boolean(getOpenAiApiKey(env));
}
