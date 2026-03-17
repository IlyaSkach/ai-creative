/**
 * Отправка сообщения/фото в Telegram через Bot API.
 */

const BASE = "https://api.telegram.org/bot";

function getBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
}

/** Получить последние обновления (чтобы узнать chat_id после /start). */
export async function getUpdates(): Promise<Array<{ chatId: number; username?: string }>> {
  const token = getBotToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN не задан");
  const url = `${BASE}${token}/getUpdates?limit=20`;
  const res = await fetch(url);
  const data = (await res.json()) as {
    ok?: boolean;
    result?: Array<{
      message?: { chat?: { id?: number; username?: string }; from?: { username?: string } };
    }>;
  };
  if (!data.ok) throw new Error("Не удалось получить обновления");
  const chats: Array<{ chatId: number; username?: string }> = [];
  const seen = new Set<number>();
  for (const u of data.result || []) {
    const chatId = u.message?.chat?.id;
    if (chatId != null && !seen.has(chatId)) {
      seen.add(chatId);
      chats.push({
        chatId,
        username: u.message?.chat?.username || u.message?.from?.username,
      });
    }
  }
  return chats.reverse();
}

export async function sendMessage(chatId: string, text: string): Promise<void> {
  const token = getBotToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN не задан");
  const url = `${BASE}${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });
  const data = (await res.json()) as { ok?: boolean; description?: string };
  if (!data.ok) throw new Error(data.description || `Telegram API error: ${res.status}`);
}

function getSendMediaTimeoutMs(): number {
  const raw = process.env.TELEGRAM_SEND_MEDIA_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 180000;
  return Math.floor(parsed);
}

function buildMultipartBody(
  boundary: string,
  chatId: string,
  caption: string,
  fileBuffer: Buffer,
  fieldName: "photo" | "animation",
  fileName: string,
  contentType: string
): Buffer {
  const crlf = "\r\n";
  const parts: string[] = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="chat_id"${crlf}${crlf}${chatId}`,
    `--${boundary}`,
    `Content-Disposition: form-data; name="caption"${crlf}${crlf}${caption}`,
    `--${boundary}`,
    `Content-Disposition: form-data; name="parse_mode"${crlf}${crlf}HTML`,
    `--${boundary}`,
    `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"`,
    `Content-Type: ${contentType}`,
    "",
  ];
  const head = parts.join(crlf) + crlf;
  const tail = crlf + `--${boundary}--` + crlf;
  return Buffer.concat([Buffer.from(head, "utf8"), fileBuffer, Buffer.from(tail, "utf8")]);
}

function getFileNameForMedia(mediaType: string, fallback: "png" | "gif" | "mp4"): string {
  const lower = mediaType.toLowerCase();
  if (lower.includes("gif")) return "creative.gif";
  if (lower.includes("jpeg") || lower.includes("jpg")) return "creative.jpg";
  if (lower.includes("webp")) return "creative.webp";
  if (lower.startsWith("video/")) {
    const ext = lower.split("/")[1] || "mp4";
    return `creative.${ext}`;
  }
  return `creative.${fallback}`;
}

async function sendMediaMultipart(
  method: "sendPhoto" | "sendAnimation",
  fieldName: "photo" | "animation",
  chatId: string,
  caption: string,
  mediaBase64: string,
  mediaType: string
): Promise<void> {
  const sendMediaTimeoutMs = getSendMediaTimeoutMs();
  const token = getBotToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN не задан");
  const url = `${BASE}${token}/${method}`;
  const mediaBuffer = Buffer.from(mediaBase64, "base64");
  const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const body = buildMultipartBody(
    boundary,
    chatId,
    caption,
    mediaBuffer,
    fieldName,
    getFileNameForMedia(mediaType, method === "sendPhoto" ? "png" : "gif"),
    mediaType
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), sendMediaTimeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      // node-fetch типами не знает про Buffer, но на практике принимает его
      body: body as any,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const raw = await res.text();
    let data: { ok?: boolean; description?: string };
    try {
      data = JSON.parse(raw) as { ok?: boolean; description?: string };
    } catch {
      throw new Error(`Telegram API: ${res.status} ${raw.slice(0, 200)}`);
    }
    if (!data.ok) throw new Error(data.description || `Telegram API error: ${res.status}`);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(
        `Таймаут отправки медиа (${Math.round(sendMediaTimeoutMs / 1000)} сек). Попробуйте позже или увеличьте TELEGRAM_SEND_MEDIA_TIMEOUT_MS.`
      );
    }
    throw e;
  }
}

export async function sendPhoto(
  chatId: string,
  caption: string,
  photoBase64: string,
  mediaType = "image/png"
): Promise<void> {
  await sendMediaMultipart("sendPhoto", "photo", chatId, caption, photoBase64, mediaType);
}

export async function sendAnimation(
  chatId: string,
  caption: string,
  animationBase64: string,
  mediaType = "image/gif"
): Promise<void> {
  await sendMediaMultipart("sendAnimation", "animation", chatId, caption, animationBase64, mediaType);
}

/** Отправка нескольких медиа (фото/гиф) одной группой. caption только у первого. */
export async function sendMediaGroup(
  chatId: string,
  caption: string,
  items: Array<{ base64: string; mediaType: string }>
): Promise<void> {
  if (items.length === 0) {
    await sendMessage(chatId, caption);
    return;
  }
  if (items.length === 1) {
    const m = items[0];
    const isAnimated = m.mediaType.includes("gif") || m.mediaType.startsWith("video/");
    if (isAnimated) {
      await sendAnimation(chatId, caption, m.base64, m.mediaType);
    } else {
      await sendPhoto(chatId, caption, m.base64, m.mediaType);
    }
    return;
  }
  const token = getBotToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN не задан");
  const sendMediaTimeoutMs = getSendMediaTimeoutMs();
  const media: Array<{ type: "photo" | "video"; media: string }> = [];
  const parts: Array<{ name: string; buffer: Buffer; contentType: string; filename: string }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const ext = item.mediaType.includes("gif") ? "gif" : item.mediaType.includes("webp") ? "webp" : "jpg";
    const filename = `media${i}.${ext}`;
    media.push({ type: "photo", media: `attach://${filename}` });
    parts.push({
      name: filename,
      buffer: Buffer.from(item.base64, "base64"),
      contentType: item.mediaType,
      filename,
    });
  }
  const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const crlf = "\r\n";
  const bodyParts: Buffer[] = [];
  bodyParts.push(Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="chat_id"${crlf}${crlf}${chatId}${crlf}`, "utf8"));
  bodyParts.push(Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="media"${crlf}${crlf}${JSON.stringify(media)}${crlf}`, "utf8"));
  bodyParts.push(Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="caption"${crlf}${crlf}${caption}${crlf}`, "utf8"));
  bodyParts.push(Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="parse_mode"${crlf}${crlf}HTML${crlf}`, "utf8"));
  for (const p of parts) {
    bodyParts.push(Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"${crlf}Content-Type: ${p.contentType}${crlf}${crlf}`, "utf8"));
    bodyParts.push(p.buffer);
    bodyParts.push(Buffer.from(crlf, "utf8"));
  }
  bodyParts.push(Buffer.from(`--${boundary}--${crlf}`, "utf8"));
  const body = Buffer.concat(bodyParts);
  const url = `${BASE}${token}/sendMediaGroup`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), sendMediaTimeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      body,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const raw = await res.text();
    let data: { ok?: boolean; description?: string };
    try {
      data = JSON.parse(raw) as { ok?: boolean; description?: string };
    } catch {
      throw new Error(`Telegram API: ${res.status} ${raw.slice(0, 200)}`);
    }
    if (!data.ok) throw new Error(data.description || `Telegram API error: ${res.status}`);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(
        `Таймаут отправки медиа (${Math.round(sendMediaTimeoutMs / 1000)} сек). Попробуйте позже.`
      );
    }
    throw e;
  }
}
