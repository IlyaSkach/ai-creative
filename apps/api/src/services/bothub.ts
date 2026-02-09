/**
 * Генерация картинки через BotHub (OpenAI-совместимый API).
 * В BotHub модель dall-e-2 может быть недоступна — используем dall-e-3.
 */

const BOTHUB_IMAGES_URL = "https://bothub.chat/api/v2/openai/v1/images/generations";

function getApiKey(): string {
  return process.env.BOTHUB_API_KEY?.trim() || "";
}

export async function generateImage(prompt: string): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("BOTHUB_API_KEY не задан");

  // dall-e-3 — актуальная модель в BotHub; dall-e-2 часто возвращает MODEL_NOT_FOUND
  const model = "dall-e-3";
  const body: Record<string, unknown> = {
    model,
    prompt,
    n: 1,
    size: "1024x1024",
    response_format: "b64_json",
    quality: "standard",
  };

  const res = await fetch(BOTHUB_IMAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`BotHub API error: ${res.status} ${raw}`);
  }

  let data: { data?: Array<{ b64_json?: string; url?: string }> };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    throw new Error("BotHub не вернул JSON");
  }

  const first = data.data?.[0];
  if (first?.b64_json) return first.b64_json;
  if (first?.url) {
    const imgRes = await fetch(first.url);
    if (!imgRes.ok) throw new Error("Не удалось загрузить изображение по URL");
    const buf = await imgRes.arrayBuffer();
    return Buffer.from(buf).toString("base64");
  }
  throw new Error("BotHub не вернул изображение");
}
