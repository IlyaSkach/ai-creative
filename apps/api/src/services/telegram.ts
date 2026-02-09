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

const SEND_PHOTO_TIMEOUT_MS = 60000;

function buildMultipartBody(
  boundary: string,
  chatId: string,
  caption: string,
  photoBuffer: Buffer
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
    `Content-Disposition: form-data; name="photo"; filename="image.png"`,
    "Content-Type: image/png",
    "",
  ];
  const head = parts.join(crlf) + crlf;
  const tail = crlf + `--${boundary}--` + crlf;
  return Buffer.concat([Buffer.from(head, "utf8"), photoBuffer, Buffer.from(tail, "utf8")]);
}

export async function sendPhoto(chatId: string, caption: string, photoBase64: string): Promise<void> {
  const token = getBotToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN не задан");
  const url = `${BASE}${token}/sendPhoto`;
  const photoBuffer = Buffer.from(photoBase64, "base64");
  const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const body = buildMultipartBody(boundary, chatId, caption, photoBuffer);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEND_PHOTO_TIMEOUT_MS);

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
      throw new Error("Таймаут отправки фото (60 сек). Попробуйте «Только текст» или отправьте без картинки.");
    }
    throw e;
  }
}
