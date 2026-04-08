import sharp from "sharp";

const BOTHUB_IMAGES_URL = "https://bothub.chat/api/v2/openai/v1/images/generations";
const BOTHUB_RESPONSES_URL = "https://bothub.chat/api/v2/openai/v1/responses";
const IMAGE_TIMEOUT_MS = 45000;
const IMAGE_GENERATION_TIMEOUT_MS = 90000;
const IMAGE_GENERATION_RETRIES = 1;
const LOG_PREVIEW = 1800;
const DEFAULT_IMAGE_MODELS = ["gemini-3-pro-image-preview", "gpt-5-image", "gpt-image-1", "dall-e-3"];

function getApiKey(): string {
  return process.env.BOTHUB_API_KEY?.trim() || "";
}

function getImageModels(): string[] {
  const raw = process.env.BOTHUB_IMAGE_MODELS?.trim();
  const parsed = (raw || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const unique = [...new Set(parsed)];
  return unique.length > 0 ? unique : DEFAULT_IMAGE_MODELS;
}

function preview(text: string, max = LOG_PREVIEW): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function isTimeoutErrorMessage(message: string): boolean {
  return /timeout/i.test(message);
}

function isDeprecatedOrUnsupportedError(message: string): boolean {
  return /deprecated|model.*not.*found|not available|410/i.test(message);
}

function hasKnownImageSignature(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // PNG
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return true;
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // GIF
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return true;
  }
  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return true;
  }
  return false;
}

function looksLikeImageBase64(value: string): boolean {
  const normalized = value.replace(/\s+/g, "");
  if (normalized.length < 1000 || !/^[A-Za-z0-9+/=]+$/.test(normalized)) return false;
  try {
    const buf = Buffer.from(normalized, "base64");
    return hasKnownImageSignature(buf);
  } catch {
    return false;
  }
}

function extractBase64FromDataUri(value: string): string | null {
  const m = value.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!m?.[1]) return null;
  const b64 = m[1].replace(/\s+/g, "");
  return looksLikeImageBase64(b64) ? b64 : null;
}

function tryExtractImageString(value: string): { b64?: string; url?: string } | null {
  const fromDataUri = extractBase64FromDataUri(value);
  if (fromDataUri) return { b64: fromDataUri };
  if (looksLikeImageBase64(value)) return { b64: value.replace(/\s+/g, "") };
  if (/^https?:\/\//i.test(value)) return { url: value };
  return null;
}

function extractImageFromPayload(payload: unknown): { b64?: string; url?: string } {
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }
    if (typeof cur !== "object") continue;
    const obj = cur as Record<string, unknown>;
    for (const key of [
      "b64_json",
      "image_base64",
      "base64",
      "b64",
      "result",
      "data",
      "image",
      "output_image",
      "image_data",
      "content",
    ]) {
      const candidate = obj[key];
      if (typeof candidate === "string") {
        const extracted = tryExtractImageString(candidate);
        if (extracted) return extracted;
      }
    }
    for (const key of ["url", "image_url"]) {
      const candidate = obj[key];
      if (typeof candidate === "string") {
        const extracted = tryExtractImageString(candidate);
        if (extracted) return extracted;
      }
    }
    // Резервный путь: проверяем вообще все строковые поля, т.к. провайдеры кладут
    // картинку в разные ключи (в т.ч. data URI).
    for (const val of Object.values(obj)) {
      if (typeof val === "string") {
        const extracted = tryExtractImageString(val);
        if (extracted) return extracted;
      }
      stack.push(val);
    }
  }
  return {};
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

async function downloadImageAsBase64(url: string): Promise<string> {
  const imgRes = await fetchWithTimeout(url, { method: "GET" }, IMAGE_TIMEOUT_MS, "BotHub image download");
  if (!imgRes.ok) throw new Error("Не удалось загрузить изображение по URL");
  const buf = await imgRes.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

async function generateViaImagesEndpoint(apiKey: string, model: string, prompt: string): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    prompt,
    n: 1,
    size: "1024x1024",
  };
  // Не все модели на images endpoint поддерживают response_format/quality.
  if (!/gpt-image-1/i.test(model)) {
    body.response_format = "b64_json";
    body.quality = "standard";
  }
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
  console.log(`[image] images_endpoint_raw: ${JSON.stringify({ model, status: res.status, ok: res.ok, rawPreview: preview(raw) })}`);
  if (!res.ok) throw new Error(`BotHub API error: ${res.status} ${raw}`);

  const data = JSON.parse(raw) as { data?: Array<{ b64_json?: string; url?: string }> };
  const first = data.data?.[0];
  if (first?.b64_json) return first.b64_json;
  if (first?.url) return downloadImageAsBase64(first.url);
  throw new Error("BotHub не вернул изображение");
}

async function generateViaResponsesEndpoint(apiKey: string, model: string, prompt: string): Promise<string> {
  const variants: Array<{ name: string; payload: Record<string, unknown> }> = [
    {
      name: "tools_image_generation",
      payload: {
        model,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: `${prompt}. Generate one image only. No text.` }],
          },
        ],
        tools: [{ type: "image_generation" }],
        tool_choice: { type: "tool", name: "image_generation" },
      },
    },
    {
      name: "modalities_image",
      payload: {
        model,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: `${prompt}. Generate one image only. No text.` }],
          },
        ],
        modalities: ["image"],
      },
    },
  ];

  let lastErr: Error | null = null;
  for (const variant of variants) {
    try {
      const res = await fetchWithTimeout(
        BOTHUB_RESPONSES_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(variant.payload),
        },
        IMAGE_GENERATION_TIMEOUT_MS,
        "BotHub responses image generation"
      );

      const raw = await res.text();
      console.log(
        `[image] responses_endpoint_raw: ${JSON.stringify({ model, variant: variant.name, status: res.status, ok: res.ok, rawPreview: preview(raw) })}`
      );
      if (!res.ok) throw new Error(`BotHub responses error: ${res.status} ${raw}`);
      const parsed = JSON.parse(raw) as unknown;
      const out = extractImageFromPayload(parsed);
      if (out.b64) return out.b64;
      if (out.url) return downloadImageAsBase64(out.url);
      throw new Error("BotHub responses не вернул изображение");
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr || new Error("BotHub responses не вернул изображение");
}

export async function generateImage(prompt: string): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("BOTHUB_API_KEY не задан");
  const models = getImageModels();
  let lastError: Error | null = null;

  for (const model of models) {
    for (let attempt = 0; attempt <= IMAGE_GENERATION_RETRIES; attempt++) {
      try {
        return await generateViaImagesEndpoint(apiKey, model, prompt);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        lastError = err;
        const shouldRetry = attempt < IMAGE_GENERATION_RETRIES && isTimeoutErrorMessage(err.message);
        if (shouldRetry) continue;
        if (isDeprecatedOrUnsupportedError(err.message)) break;
      }
    }
  }

  for (const model of models) {
    try {
      return await generateViaResponsesEndpoint(apiKey, model, prompt);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
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
