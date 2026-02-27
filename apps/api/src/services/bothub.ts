/**
 * Генерация картинки через BotHub (OpenAI-совместимый API).
 * В BotHub модель dall-e-2 может быть недоступна — используем dall-e-3.
 */
import sharp from "sharp";

const BOTHUB_IMAGES_URL = "https://bothub.chat/api/v2/openai/v1/images/generations";
const BOTHUB_RESPONSES_URL = "https://bothub.chat/api/v2/openai/v1/responses";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const IMAGE_TIMEOUT_MS = 45000;
const IMAGE_GENERATION_TIMEOUT_MS = 90000;
const IMAGE_GENERATION_RETRIES = 1;
const HYBRID_TIMEOUT_MS = 120000;
const HYBRID_RETRIES = 1;
const HYBRID_LOG_PREVIEW = 1800;
const DEFAULT_HYBRID_MODELS = ["gemini-3-pro-image-preview", "gemini-3.1-pro-preview", "gpt-5-image"];
const DEFAULT_DIRECT_GEMINI_MODELS = ["gemini-2.5-flash-image", "gemini-3-pro-image-preview", "nano-banana-pro-preview"];
const HYBRID_DETAILS_POLL_ATTEMPTS = 3;
const HYBRID_DETAILS_POLL_DELAY_MS = 1500;
const HYBRID_INCLUDE_FIELDS = [
  "output[*].image_generation_call.result",
  "output[*].image_generation_call.image_base64",
  "output[*].image_generation_call.b64_json",
  "output[*].image_generation_call.url",
];
const KNOWN_UNSUPPORTED_HYBRID_MODELS = new Set([
  "gpt-image-1",
  "openai/gpt-image-1",
  "openai/gpt-5-image",
  "dall-e-3",
]);

function getApiKey(): string {
  return process.env.BOTHUB_API_KEY?.trim() || "";
}

function getHybridModels(): string[] {
  const raw = process.env.BOTHUB_HYBRID_MODELS?.trim();
  const source = (raw || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const requested = source.length > 0 ? source : DEFAULT_HYBRID_MODELS;
  const filtered = requested.filter((model) => !KNOWN_UNSUPPORTED_HYBRID_MODELS.has(model));
  const unique = [...new Set(filtered)];
  return unique.length > 0 ? unique : DEFAULT_HYBRID_MODELS;
}

function shouldUseImageToolVariant(): boolean {
  return (process.env.BOTHUB_HYBRID_USE_IMAGE_TOOL?.trim() || "").toLowerCase() === "true";
}

function shouldUseBothubIncludeFields(): boolean {
  return (process.env.BOTHUB_HYBRID_USE_INCLUDE?.trim() || "").toLowerCase() === "true";
}

function getDirectGeminiApiKey(): string {
  return process.env.GEMINI_API_KEY?.trim() || "";
}

function isDirectGeminiEnabled(): boolean {
  return (process.env.HYBRID_USE_DIRECT_GEMINI?.trim() || "").toLowerCase() === "true";
}

function getDirectGeminiModels(): string[] {
  const raw = process.env.GEMINI_HYBRID_MODELS?.trim();
  const source = (raw || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return source.length > 0 ? [...new Set(source)] : DEFAULT_DIRECT_GEMINI_MODELS;
}

function preview(text: string, max = HYBRID_LOG_PREVIEW): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function logHybrid(stage: string, payload: Record<string, unknown>) {
  console.log(`[hybrid] ${stage}: ${JSON.stringify(payload)}`);
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
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= IMAGE_GENERATION_RETRIES; attempt++) {
    try {
      console.log(`[image] request: ${JSON.stringify({ url: BOTHUB_IMAGES_URL, model, timeoutMs: IMAGE_GENERATION_TIMEOUT_MS, attempt: attempt + 1, totalAttempts: IMAGE_GENERATION_RETRIES + 1, prompt })}`);

      const res = await fetchWithTimeout(BOTHUB_IMAGES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      }, IMAGE_GENERATION_TIMEOUT_MS, "BotHub images generation");

      const raw = await res.text();
      console.log(`[image] response_raw: ${JSON.stringify({ attempt: attempt + 1, status: res.status, ok: res.ok, rawPreview: preview(raw) })}`);
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
      console.log(`[image] response_parsed: ${JSON.stringify({ attempt: attempt + 1, hasB64: Boolean(first?.b64_json), hasUrl: Boolean(first?.url) })}`);
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
      console.log(`[image] attempt_error: ${JSON.stringify({ attempt: attempt + 1, error: err.message, shouldRetry })}`);
      if (!shouldRetry) throw err;
    }
  }
  throw lastError || new Error("BotHub image generation: неизвестная ошибка");
}

function buildHybridPrompt(prompt: string): string {
  return [
    "Rework the provided image into a cleaner and more clickable ad visual.",
    "Keep the core subject recognizable, simplify details, and increase contrast.",
    "Make composition clear and attention-grabbing for Telegram feed.",
    prompt,
  ].join(" ");
}

function mediaMimeType(mediaType?: string): string {
  const mt = (mediaType || "").toLowerCase();
  if (mt.includes("jpeg") || mt.includes("jpg")) return "image/jpeg";
  if (mt.includes("webp")) return "image/webp";
  if (mt.includes("gif")) return "image/gif";
  if (mt.startsWith("image/")) return mt;
  return "image/png";
}

function isTimeoutErrorMessage(message: string): boolean {
  return /timeout/i.test(message);
}

async function preprocessSourceImageForHybrid(
  sourceImageBase64: string
): Promise<{ base64: string; mime: string }> {
  const input = Buffer.from(sourceImageBase64, "base64");
  const output = await sharp(input, { failOn: "none", animated: false })
    .rotate()
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
  return { base64: output.toString("base64"), mime: "image/jpeg" };
}

function looksLikeImageBase64(value: string): boolean {
  return value.length > 1000 && /^[A-Za-z0-9+/=\r\n]+$/.test(value);
}

function extractImageFromResponsePayload(payload: unknown): { b64?: string; url?: string } {
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
    const b64Candidates = [obj.b64_json, obj.image_base64, obj.base64, obj.b64, obj.data, obj.result];
    for (const candidate of b64Candidates) {
      if (typeof candidate === "string" && looksLikeImageBase64(candidate)) {
        return { b64: candidate.replace(/\s+/g, "") };
      }
    }
    const urlCandidates = [obj.url, obj.image_url];
    for (const candidate of urlCandidates) {
      if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) {
        return { url: candidate };
      }
    }
    for (const val of Object.values(obj)) stack.push(val);
  }
  return {};
}

function extractResponseDiagnostics(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const obj = payload as Record<string, unknown>;
  const output = Array.isArray(obj.output) ? obj.output : [];
  const outputTypes = output
    .map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>).type || "unknown") : "unknown"))
    .slice(0, 12);
  return {
    responseStatus: typeof obj.status === "string" ? obj.status : undefined,
    responseId: typeof obj.id === "string" ? obj.id : undefined,
    responseModel: typeof obj.model === "string" ? obj.model : undefined,
    responseError: obj.error ?? null,
    hasOutputText: Boolean(obj.output_text),
    outputCount: output.length,
    outputTypes,
  };
}

function extractResponseId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const id = (payload as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? id : null;
}

function hasImageGenerationCall(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const output = (payload as Record<string, unknown>).output;
  if (!Array.isArray(output)) return false;
  return output.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "image_generation_call");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractImageFromGeminiPayload(payload: unknown): { b64?: string; mimeType?: string } {
  if (!payload || typeof payload !== "object") return {};
  const obj = payload as Record<string, unknown>;
  const candidates = Array.isArray(obj.candidates) ? obj.candidates : [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const content = (candidate as Record<string, unknown>).content as Record<string, unknown> | undefined;
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      const inlineCamel = p.inlineData as Record<string, unknown> | undefined;
      const inlineSnake = p.inline_data as Record<string, unknown> | undefined;
      const inline = inlineCamel || inlineSnake;
      if (!inline) continue;
      const data = inline.data;
      const mimeType = inline.mimeType || inline.mime_type;
      if (typeof data === "string" && looksLikeImageBase64(data)) {
        return {
          b64: data.replace(/\s+/g, ""),
          mimeType: typeof mimeType === "string" ? mimeType : undefined,
        };
      }
    }
  }
  return {};
}

async function tryGenerateHybridViaDirectGemini(
  sourceImageBase64: string,
  prompt: string,
  sourceMediaType?: string
): Promise<string | null> {
  const apiKey = getDirectGeminiApiKey();
  if (!apiKey) return null;
  const models = getDirectGeminiModels();
  const mime = mediaMimeType(sourceMediaType);
  const textPrompt = `${buildHybridPrompt(prompt)} Return only one edited image. No text.`;
  logHybrid("gemini_direct_start", {
    models,
    sourceMime: mime,
    sourceBase64Length: sourceImageBase64.length,
  });

  for (const model of models) {
    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: textPrompt },
            { inline_data: { mime_type: mime, data: sourceImageBase64 } },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["IMAGE"],
      },
    };
    try {
      logHybrid("gemini_direct_attempt", { model });
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, HYBRID_TIMEOUT_MS, "Direct Gemini hybrid");
      const raw = await res.text();
      logHybrid("gemini_direct_response_raw", {
        model,
        status: res.status,
        ok: res.ok,
        rawPreview: preview(raw),
      });
      if (!res.ok) continue;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        continue;
      }
      const out = extractImageFromGeminiPayload(parsed);
      logHybrid("gemini_direct_response_parsed", {
        model,
        foundBase64: Boolean(out.b64),
        base64Length: out.b64?.length || 0,
        mimeType: out.mimeType || null,
      });
      if (out.b64) return out.b64;
    } catch (e) {
      logHybrid("gemini_direct_attempt_error", {
        model,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return null;
}

async function tryResolveImageFromResponseDetails(
  responseId: string,
  apiKey: string,
  context: { attempt: number; model: string; variant: string }
): Promise<{ b64?: string; url?: string }> {
  const detailsUrl = `${BOTHUB_RESPONSES_URL}/${encodeURIComponent(responseId)}`;
  for (let poll = 1; poll <= HYBRID_DETAILS_POLL_ATTEMPTS; poll++) {
    const res = await fetchWithTimeout(detailsUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    }, IMAGE_TIMEOUT_MS, "BotHub hybrid response details");
    const raw = await res.text();
    logHybrid("response_details_raw", {
      ...context,
      poll,
      status: res.status,
      ok: res.ok,
      rawPreview: preview(raw),
    });
    if (!res.ok) {
      return {};
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      logHybrid("response_details_parse_error", { ...context, poll, responseId });
      return {};
    }
    const out = extractImageFromResponsePayload(parsed);
    logHybrid("response_details_parsed", {
      ...context,
      poll,
      responseId,
      foundBase64: Boolean(out.b64),
      base64Length: out.b64?.length || 0,
      foundUrl: Boolean(out.url),
      urlPreview: out.url ? preview(out.url, 300) : null,
    });
    if (out.b64 || out.url) return out;
    if (poll < HYBRID_DETAILS_POLL_ATTEMPTS) {
      await sleep(HYBRID_DETAILS_POLL_DELAY_MS);
    }
  }
  return {};
}

export async function generateHybridImage(
  sourceImageBase64: string,
  prompt: string,
  sourceMediaType?: string
): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("BOTHUB_API_KEY не задан");
  logHybrid("start", {
    sourceMediaType: sourceMediaType || "unknown",
    sourceBase64Length: sourceImageBase64.length,
    prompt,
  });

  if (isDirectGeminiEnabled()) {
    const directGeminiResult = await tryGenerateHybridViaDirectGemini(
      sourceImageBase64,
      prompt,
      sourceMediaType
    );
    if (directGeminiResult) {
      logHybrid("result", { via: "direct_gemini" });
      return directGeminiResult;
    }
  } else {
    logHybrid("gemini_direct_skipped", { reason: "HYBRID_USE_DIRECT_GEMINI is disabled" });
  }

  const sourceMime = mediaMimeType(sourceMediaType);
  const hybridModels = getHybridModels();
  const useImageToolVariant = shouldUseImageToolVariant();
  const useBothubIncludeFields = shouldUseBothubIncludeFields();
  const processed = await preprocessSourceImageForHybrid(sourceImageBase64).catch(() => ({
    base64: sourceImageBase64,
    mime: sourceMime,
  }));
  logHybrid("preprocess", {
    sourceMime,
    processedMime: processed.mime,
    processedBase64Length: processed.base64.length,
    compressed: processed.base64.length < sourceImageBase64.length,
  });

  const hybridPrompt = buildHybridPrompt(prompt);
  const makePayloadVariants = (model: string) => ([
    {
      name: "modalities_image",
      body: {
        model,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: `${hybridPrompt} Return only one edited image. No text.` },
              { type: "input_image", image_url: `data:${processed.mime};base64,${processed.base64}` },
            ],
          },
        ],
        modalities: ["image"],
        ...(useBothubIncludeFields ? { include: HYBRID_INCLUDE_FIELDS } : {}),
      },
    },
    {
      name: "tools_image_generation",
      body: {
        model,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: `${hybridPrompt} Return only one edited image. No text.` },
              { type: "input_image", image_url: `data:${processed.mime};base64,${processed.base64}` },
            ],
          },
        ],
        tools: [{ type: "image_generation" }],
        ...(useBothubIncludeFields ? { include: HYBRID_INCLUDE_FIELDS } : {}),
      },
    },
  ] as const).filter((v) => useImageToolVariant || v.name !== "tools_image_generation");
  logHybrid("request_payload", {
    url: BOTHUB_RESPONSES_URL,
    models: hybridModels,
    retries: HYBRID_RETRIES,
    timeoutMs: HYBRID_TIMEOUT_MS,
    prompt: hybridPrompt,
    imageDataUrlLength: `data:${processed.mime};base64,${processed.base64}`.length,
    variants: useImageToolVariant ? ["modalities_image", "tools_image_generation"] : ["modalities_image"],
    useImageToolVariant,
    include: useBothubIncludeFields ? HYBRID_INCLUDE_FIELDS : [],
    useBothubIncludeFields,
    skippedAsUnsupported: (process.env.BOTHUB_HYBRID_MODELS?.trim() || "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .filter((m) => KNOWN_UNSUPPORTED_HYBRID_MODELS.has(m)),
  });

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= HYBRID_RETRIES; attempt++) {
    try {
      logHybrid("attempt", { attempt: attempt + 1, totalAttempts: HYBRID_RETRIES + 1 });
      for (const model of hybridModels) {
        const payloadVariants = makePayloadVariants(model);
        for (const variant of payloadVariants) {
          logHybrid("attempt_variant", { attempt: attempt + 1, model, variant: variant.name });
          const res = await fetchWithTimeout(BOTHUB_RESPONSES_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(variant.body),
          }, HYBRID_TIMEOUT_MS, "BotHub hybrid responses");

          const raw = await res.text();
          logHybrid("response_raw", {
            attempt: attempt + 1,
            model,
            variant: variant.name,
            status: res.status,
            ok: res.ok,
            rawPreview: preview(raw),
          });
          if (!res.ok) {
            // invalid_prompt/model-not-found у конкретной модели не должен ломать весь каскад
            logHybrid("response_error", {
              attempt: attempt + 1,
              model,
              variant: variant.name,
              status: res.status,
              rawPreview: preview(raw),
            });
            continue;
          }
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(raw) as unknown;
          } catch {
            throw new Error("BotHub hybrid не вернул JSON");
          }
          const out = extractImageFromResponsePayload(parsed);
          const diag = extractResponseDiagnostics(parsed);
          logHybrid("response_parsed", {
            attempt: attempt + 1,
            model,
            variant: variant.name,
            foundBase64: Boolean(out.b64),
            base64Length: out.b64?.length || 0,
            foundUrl: Boolean(out.url),
            urlPreview: out.url ? preview(out.url, 300) : null,
            ...diag,
          });
          if (out.b64) return out.b64;
          if (out.url) {
            const imgRes = await fetchWithTimeout(out.url, { method: "GET" }, IMAGE_TIMEOUT_MS, "BotHub hybrid image download");
            if (!imgRes.ok) throw new Error("Не удалось загрузить гибридное изображение по URL");
            const buf = await imgRes.arrayBuffer();
            return Buffer.from(buf).toString("base64");
          }
          const responseId = extractResponseId(parsed);
          if (responseId && hasImageGenerationCall(parsed)) {
            logHybrid("response_details_fetch_start", {
              attempt: attempt + 1,
              model,
              variant: variant.name,
              responseId,
            });
            const detailsOut = await tryResolveImageFromResponseDetails(responseId, apiKey, {
              attempt: attempt + 1,
              model,
              variant: variant.name,
            });
            if (detailsOut.b64) return detailsOut.b64;
            if (detailsOut.url) {
              const imgRes = await fetchWithTimeout(detailsOut.url, { method: "GET" }, IMAGE_TIMEOUT_MS, "BotHub hybrid image download");
              if (!imgRes.ok) throw new Error("Не удалось загрузить гибридное изображение по URL");
              const buf = await imgRes.arrayBuffer();
              return Buffer.from(buf).toString("base64");
            }
          }
          logHybrid("variant_without_image", { attempt: attempt + 1, model, variant: variant.name });
        }
      }
      throw new Error("BotHub hybrid не вернул изображение");
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      lastError = err;
      const shouldRetry = attempt < HYBRID_RETRIES && isTimeoutErrorMessage(err.message);
      logHybrid("attempt_error", {
        attempt: attempt + 1,
        error: err.message,
        shouldRetry,
      });
      if (!shouldRetry) throw err;
    }
  }
  throw lastError || new Error("BotHub hybrid: неизвестная ошибка");
}

export async function stylizeSourceImageForAd(
  sourceImageBase64: string
): Promise<string> {
  const input = Buffer.from(sourceImageBase64, "base64");
  const out = await sharp(input, { failOn: "none", animated: false })
    .rotate()
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .modulate({ brightness: 1.06, saturation: 1.15 })
    .sharpen(1.0, 1.0, 1.5)
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return out.toString("base64");
}

export async function enhanceSourceImageWithBothubOverlay(
  sourceImageBase64: string,
  prompt: string
): Promise<string> {
  const baseInput = Buffer.from(sourceImageBase64, "base64");
  const base = await sharp(baseInput, { failOn: "none", animated: false })
    .rotate()
    .resize({ width: 1024, height: 1024, fit: "cover" })
    .modulate({ brightness: 1.04, saturation: 1.08 })
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();

  const meta = await sharp(base).metadata();
  const width = meta.width || 1024;
  const height = meta.height || 1024;

  // Генерируем тематический AI-элемент и накладываем его поверх источника,
  // чтобы получить гибрид даже если image-edit endpoint недоступен.
  const overlayB64 = await generateImage(`${prompt}. clean icon-like focal element, no text`);
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
    .composite([{ input: overlay, left, top, blend: "over" }])
    .sharpen(0.8, 0.8, 1.2)
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();

  return out.toString("base64");
}
