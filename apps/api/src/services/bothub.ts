import sharp from "sharp";

const BOTHUB_IMAGES_URL = "https://bothub.chat/api/v2/openai/v1/images/generations";
const IMAGE_TIMEOUT_MS = 45000;
const IMAGE_GENERATION_TIMEOUT_MS = 90000;
const IMAGE_GENERATION_RETRIES = 1;
const LOG_PREVIEW = 1800;

function getApiKey(): string {
  return process.env.BOTHUB_API_KEY?.trim() || "";
}

function preview(text: string, max = LOG_PREVIEW): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function isTimeoutErrorMessage(message: string): boolean {
  return /timeout/i.test(message);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`${label}: timeout ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function generateImage(prompt: string): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("BOTHUB_API_KEY не задан");

  const model = "dall-e-3";
  const body = {
    model,
    prompt,
    n: 1,
    size: "1024x1024",
    response_format: "b64_json",
    quality: "standard",
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= IMAGE_GENERATION_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(
        BOTHUB_IMAGES_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        },
        IMAGE_GENERATION_TIMEOUT_MS,
        "BotHub images generation"
      );

      const raw = await res.text();
      console.log(
        `[image] response_raw: ${JSON.stringify({ attempt: attempt + 1, status: res.status, ok: res.ok, rawPreview: preview(raw) })}`
      );
      if (!res.ok) throw new Error(`BotHub API error: ${res.status} ${raw}`);

      const data = JSON.parse(raw) as { data?: Array<{ b64_json?: string; url?: string }> };
      const first = data.data?.[0];
      if (first?.b64_json) return first.b64_json;
      if (first?.url) {
        const imgRes = await fetchWithTimeout(first.url, { method: "GET" }, IMAGE_TIMEOUT_MS, "BotHub image download");
        if (!imgRes.ok) throw new Error("Не удалось загрузить изображение по URL");
        const buf = await imgRes.arrayBuffer();
        return Buffer.from(buf).toString("base64");
      }
      throw new Error("BotHub не вернул изображение");
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      lastError = err;
      const shouldRetry = attempt < IMAGE_GENERATION_RETRIES && isTimeoutErrorMessage(err.message);
      if (!shouldRetry) throw err;
    }
  }

  throw lastError || new Error("BotHub image generation: неизвестная ошибка");
}

export async function editImageWithAiOverlay(sourceImageBase64: string, prompt: string): Promise<string> {
  const baseInput = Buffer.from(sourceImageBase64, "base64");
  const base = await sharp(baseInput, { failOn: "none", animated: false })
    .rotate()
    .resize({ width: 1024, height: 1024, fit: "cover" })
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();

  const meta = await sharp(base).metadata();
  const width = meta.width || 1024;
  const height = meta.height || 1024;

  const overlayB64 = await generateImage(
    `${prompt}. one clear visual element, attention grabbing, no text, no watermark`
  );
  const overlayInput = Buffer.from(overlayB64, "base64");
  const overlay = await sharp(overlayInput, { failOn: "none", animated: false })
    .resize({
      width: Math.max(260, Math.round(width * 0.38)),
      height: Math.max(260, Math.round(height * 0.38)),
      fit: "cover",
    })
    .png()
    .toBuffer();

  const left = Math.max(0, width - Math.round(width * 0.38) - Math.round(width * 0.04));
  const top = Math.max(0, height - Math.round(height * 0.38) - Math.round(height * 0.04));

  const out = await sharp(base)
    .modulate({ brightness: 1.03, saturation: 1.06 })
    .composite([{ input: overlay, left, top, blend: "over" }])
    .sharpen(0.9, 0.9, 1.3)
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();

  return out.toString("base64");
}
