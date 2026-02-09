/**
 * Парсинг канала: название и описание со страницы t.me; опционально посты через Telegram Client.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TME_URL = "https://t.me";

function getSessionString(): string {
  const fromEnv = process.env.TELEGRAM_SESSION_STRING?.trim();
  if (fromEnv) return fromEnv;
  try {
    const sessionFile = path.resolve(__dirname, "../../../session/session.txt");
    if (fs.existsSync(sessionFile)) {
      return fs.readFileSync(sessionFile, "utf8").trim();
    }
  } catch {}
  return "";
}

function extractUsername(input: string): string | null {
  const s = input.trim();
  const linkMatch = s.match(/(?:t\.me|telegram\.me|telegram\.dog)\/([a-zA-Z0-9_]+)/i);
  const atMatch = s.match(/@([a-zA-Z0-9_]+)/);
  if (linkMatch) return linkMatch[1];
  if (atMatch) return atMatch[1];
  if (/^[a-zA-Z0-9_]+$/.test(s)) return s;
  return null;
}

function parseTmePage(html: string): { title: string; description: string } {
  const extractMeta = (name: string): string => {
    const re1 = new RegExp(`property=["']og:${name}["'][^>]+content=["']([^"']*)["']`, "i");
    const re2 = new RegExp(`content=["']([^"']*)["'][^>]+property=["']og:${name}["']`, "i");
    const m = html.match(re1) || html.match(re2);
    return (m && m[1]) ? m[1].trim() : "";
  };
  let title = extractMeta("title");
  let description = extractMeta("description");
  if (!title) {
    const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    title = t ? t[1].replace(/^Telegram:\s*View\s*@?/i, "").trim() : "";
  }
  if (!title) title = "Канал";
  return { title, description };
}

export interface ChannelPost {
  date: string;
  text: string;
  photoBase64?: string;
  mediaType?: string;
  views?: number;
  reactionsCount?: number;
}

export interface ChannelInfo {
  title: string;
  description: string;
  username: string;
  channelLink: string;
  posts: ChannelPost[];
}

export async function parseChannelFromTme(linkOrUsername: string): Promise<ChannelInfo> {
  const username = extractUsername(linkOrUsername);
  if (!username) {
    throw new Error("Не удалось извлечь username. Укажите ссылку (t.me/username) или @username");
  }
  const url = `${TME_URL}/${username}`;
  const res = await fetch(url, { headers: { "Accept": "text/html" } });
  if (!res.ok) {
    throw new Error(`Страница канала не загрузилась: ${res.status}. Проверьте ссылку.`);
  }
  const html = await res.text();
  if (html.length < 100) {
    throw new Error("Страница канала пуста или недоступна.");
  }
  const { title, description } = parseTmePage(html);
  const channelLink = `https://t.me/${username}`;
  // Таймаут: первое подключение gramjs к Telegram может занимать 1–2 мин при нестабильной сети
  const POSTS_TIMEOUT_MS = 180000; // 3 мин
  const posts = await Promise.race([
    fetchPostsIfAvailable(username),
    new Promise<ChannelPost[]>((resolve) =>
      setTimeout(() => {
        console.log("[channelParser] Загрузка постов прервана по таймауту", POSTS_TIMEOUT_MS / 1000, "с");
        resolve([]);
      }, POSTS_TIMEOUT_MS)
    ),
  ]);
  return { title, description, username, channelLink, posts };
}

const MAX_POSTS_WITH_PHOTOS = 5;

const LAST_POSTS_LIMIT = 15;

function getReactionsCount(msg: { reactions?: { results?: Array<{ count?: number }> } }): number {
  const results = msg.reactions?.results;
  if (!Array.isArray(results)) return 0;
  return results.reduce((s, r) => s + (Number(r.count) || 0), 0);
}

async function fetchPostsIfAvailable(username: string): Promise<ChannelPost[]> {
  const apiId = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  const sessionString = getSessionString();
  if (!apiId || !apiHash || !sessionString) {
    console.log("[channelParser] Посты не загружаются: нет API_ID, API_HASH или сессии в .env");
    return [];
  }
  try {
    const { TelegramClient } = await import("telegram");
    const { StringSession } = await import("telegram/sessions/index.js");
    const { Api } = await import("telegram/tl/index.js");
    const client = new TelegramClient(
      new StringSession(sessionString),
      Number(apiId),
      apiHash,
      { connectionRetries: 5, timeout: 60 }
    );
    await client.connect();
    const entity = await client.getEntity(username.startsWith("@") ? username : `@${username}`);
    const posts: ChannelPost[] = [];
    let mediaDownloaded = 0;
    let offsetId = 0;
    let firstBatch: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await client.invoke(
        new Api.messages.GetHistory({
          peer: entity,
          offsetId,
          offsetDate: 0,
          addOffset: 0,
          limit: 100,
          maxId: 0,
          minId: 0,
          // Тип ожидает BigInteger, но для нас достаточно нулевого hash
          hash: 0 as any,
        })
      );
      const raw = res as { messages?: unknown[] };
      const messages = raw.messages || [];
      if (i === 0) firstBatch = messages;
      if (i === 0) console.log("[channelParser] GetHistory: получено сообщений в первом ответе:", messages.length);
      if (messages.length === 0) break;
      for (const m of messages) {
        if (posts.length >= LAST_POSTS_LIMIT) break;
        const msg = m as {
          date?: number;
          message?: string;
          text?: string;
          views?: number;
          reactions?: { results?: Array<{ count?: number }> };
          media?: { className?: string; photo?: unknown; document?: { mimeType?: string; mime_type?: string } };
        };
        const date = msg.date ? new Date(msg.date * 1000) : new Date();
        const text = (msg.message ?? msg.text ?? "").trim();
        const views = typeof msg.views === "number" ? msg.views : 0;
        const reactionsCount = getReactionsCount(msg);
        let photoBase64: string | undefined;
        let mediaType: string | undefined;
        const isPhoto = msg.media && (String(msg.media.className) === "MessageMediaPhoto" || msg.media.photo);
        const doc = msg.media?.className === "MessageMediaDocument" ? msg.media.document : null;
        const mime = doc && (doc.mimeType || doc.mime_type);
        const isImageDoc = mime && /^image\/(gif|jpeg|jpg|png|webp)$/i.test(mime);
        const hasMedia = mediaDownloaded < MAX_POSTS_WITH_PHOTOS && (isPhoto || isImageDoc);
        if (hasMedia) {
          try {
            const buf = await client.downloadMedia(m as never, {});
            if (buf && Buffer.isBuffer(buf)) {
              photoBase64 = buf.toString("base64");
              mediaType = isPhoto ? "image/jpeg" : (mime || "image/png");
              mediaDownloaded++;
            }
          } catch (_) {
            // skip
          }
        }
        if (text || photoBase64) {
          posts.push({
            date: date.toISOString(),
            text: text || "(медиа)",
            photoBase64,
            mediaType,
            views: views || undefined,
            reactionsCount: reactionsCount || undefined,
          });
        }
      }
      if (posts.length >= LAST_POSTS_LIMIT) break;
      const lastMsg = messages[messages.length - 1] as { id?: number };
      offsetId = lastMsg?.id ?? 0;
    }
    await client.disconnect();
    const out = posts.slice(0, LAST_POSTS_LIMIT);
    console.log("[channelParser] Последних постов загружено:", out.length);
    if (firstBatch.length > 0 && out.length === 0) {
      const first = firstBatch[0] as Record<string, unknown>;
      console.log("[channelParser] Пример ключей первого сообщения:", Object.keys(first));
    }
    return out;
  } catch (e) {
    console.error("[channelParser] Ошибка загрузки постов:", e instanceof Error ? e.message : e);
    return [];
  }
}
