/**
 * Унифицированный слой для chat completions через разные провайдеры:
 * DeepSeek, GPT и Claude (оба через Bothub по одному ключу).
 */

export type AiProvider = "deepseek" | "gpt" | "claude";

interface ProviderConfig {
  base: string;
  apiKey: string;
  model: string;
}

function getProviderConfig(provider: AiProvider): ProviderConfig {
  switch (provider) {
    case "deepseek": {
      const base = process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com";
      const apiKey = process.env.DEEPSEEK_API_KEY?.trim() || "";
      return { base, apiKey, model: "deepseek-chat" };
    }
    case "gpt": {
      const base = "https://bothub.chat/api/v2/openai/v1";
      const apiKey = process.env.BOTHUB_API_KEY?.trim() || "";
      const model = process.env.BOTHUB_GPT_MODEL?.trim() || "gpt-4o";
      return { base, apiKey, model };
    }
    case "claude": {
      const base = "https://bothub.chat/api/v2/openai/v1";
      const apiKey = process.env.BOTHUB_API_KEY?.trim() || "";
      const model = process.env.BOTHUB_CLAUDE_MODEL?.trim() || "claude-3.7-sonnet";
      return { base, apiKey, model };
    }
    default:
      throw new Error(`Неизвестный провайдер: ${provider}`);
  }
}

export function isProviderAvailable(provider: AiProvider): boolean {
  const { apiKey } = getProviderConfig(provider);
  return Boolean(apiKey);
}

export function getAvailableProviders(): AiProvider[] {
  const all: AiProvider[] = ["deepseek", "gpt", "claude"];
  return all.filter(isProviderAvailable);
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chatCompletion(
  provider: AiProvider,
  messages: ChatMessage[],
  options?: { temperature?: number }
): Promise<string> {
  const { base, apiKey, model } = getProviderConfig(provider);
  if (!apiKey) throw new Error(`API ключ для ${provider} не задан. Проверьте .env`);

  const url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options?.temperature ?? 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${provider} API error: ${res.status} ${err}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim() || "";
  return content;
}
