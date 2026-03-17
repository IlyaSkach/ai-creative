/**
 * Парсинг канала: название и описание со страницы t.me; опционально посты через Telegram Client.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TME_URLS = ["https://t.me", "https://telegram.me", "https://telegram.dog"];

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
  postId?: number;
  date: string;
  text: string;
  photoBase64?: string;
  mediaType?: string;
  /** Несколько медиа из одного поста (альбом). photoBase64 — первое. */
  mediaItems?: Array<{ base64: string; mediaType: string }>;
  views?: number;
  reactionsCount?: number;
}

export interface LandingContacts {
  phones?: string[];
  emails?: string[];
  whatsapp?: string[];
  telegram?: string[];
}

export interface ChannelInfo {
  title: string;
  description: string;
  username: string;
  channelLink: string;
  posts: ChannelPost[];
  directPostMode?: boolean;
  sourcePostLink?: string;
  landingContacts?: LandingContacts;
}

interface ParsedInput {
  username: string;
  postId?: number;
}

function parseInput(input: string): ParsedInput | null {
  const s = input.trim();
  const postMatch = s.match(/(?:t\.me|telegram\.me|telegram\.dog)\/([a-zA-Z0-9_]+)\/(\d+)/i);
  if (postMatch) {
    return { username: postMatch[1], postId: Number(postMatch[2]) || undefined };
  }
  const username = extractUsername(s);
  if (!username) return null;
  return { username };
}

export async function parseChannelFromTme(linkOrUsername: string): Promise<ChannelInfo> {
  const parsedInput = parseInput(linkOrUsername);
  if (!parsedInput?.username) {
    throw new Error("Не удалось извлечь username. Укажите ссылку (t.me/username) или @username");
  }
  const { username, postId } = parsedInput;
  let title = `@${username}`;
  let description = "";
  const channelLink = `https://t.me/${username}`;
  let pageLoaded = false;
  for (const baseUrl of TME_URLS) {
    try {
      const url = `${baseUrl}/${username}`;
      const res = await fetch(url, { headers: { Accept: "text/html" } });
      if (!res.ok) continue;
      const html = await res.text();
      if (html.length < 100) continue;
      const parsed = parseTmePage(html);
      title = parsed.title || title;
      description = parsed.description || description;
      pageLoaded = true;
      break;
    } catch {
      // try next mirror
    }
  }
  if (!pageLoaded) {
    console.warn(`[channelParser] Не удалось загрузить страницу t.me для @${username}. Продолжаем без title/description со страницы.`);
  }
  // Таймаут: первое подключение gramjs к Telegram может занимать 1–2 мин при нестабильной сети
  const POSTS_TIMEOUT_MS = 180000; // 3 мин
  const posts = await Promise.race([
    postId ? fetchSpecificPostIfAvailable(username, postId) : fetchPostsIfAvailable(username),
    new Promise<ChannelPost[]>((resolve) =>
      setTimeout(() => {
        console.log("[channelParser] Загрузка постов прервана по таймауту", POSTS_TIMEOUT_MS / 1000, "с");
        resolve([]);
      }, POSTS_TIMEOUT_MS)
    ),
  ]);
  return {
    title,
    description,
    username,
    channelLink,
    posts,
    directPostMode: Boolean(postId && posts.length <= 1),
    sourcePostLink: postId ? `https://t.me/${username}/${postId}` : undefined,
  };
}

const LAST_POSTS_LIMIT = 30;
const MAX_POSTS_WITH_MEDIA = LAST_POSTS_LIMIT;
const MEDIA_DOWNLOAD_TIMEOUT_MS = Number(process.env.TELEGRAM_MEDIA_DOWNLOAD_TIMEOUT_MS || 12000);
const MAX_MEDIA_BYTES = Number(process.env.TELEGRAM_MAX_MEDIA_BYTES || 8 * 1024 * 1024);

function getReactionsCount(msg: { reactions?: { results?: Array<{ count?: number }> } }): number {
  const results = msg.reactions?.results;
  if (!Array.isArray(results)) return 0;
  return results.reduce((s, r) => s + (Number(r.count) || 0), 0);
}

function buildTelegramClientOptions() {
  const proxyHost = process.env.TELEGRAM_PROXY_HOST?.trim();
  const proxyPortRaw = process.env.TELEGRAM_PROXY_PORT?.trim();
  const proxyPort = proxyPortRaw ? Number(proxyPortRaw) : 0;
  const proxyUser = process.env.TELEGRAM_PROXY_USER?.trim();
  const proxyPass = process.env.TELEGRAM_PROXY_PASS?.trim();
  const clientOptions: any = {
    connectionRetries: 10,
    useWSS: false,
    timeout: 60,
    requestRetries: 3,
    // Нам не нужен фоновой цикл updates: мы только читаем историю канала.
    // Это убирает регулярный шум вида Error: TIMEOUT из updates.js.
    receiveUpdates: false,
  };
  if (proxyHost && proxyPort > 0) {
    clientOptions.proxy = {
      ip: proxyHost,
      port: proxyPort,
      socksType: 5,
      username: proxyUser || undefined,
      password: proxyPass || undefined,
      timeout: 15,
    };
    console.log(`[channelParser] Используем SOCKS5 прокси ${proxyHost}:${proxyPort} для Telegram Client`);
  }
  return clientOptions;
}

async function shutdownTelegramClient(client: { disconnect: () => Promise<void>; destroy?: () => Promise<void> }): Promise<void> {
  try {
    await client.disconnect();
  } catch {}
  try {
    if (typeof client.destroy === "function") {
      await client.destroy();
    }
  } catch {}
}

type MsgLike = {
  id?: number;
  date?: number;
  message?: string;
  text?: string;
  views?: number;
  grouped_id?: number | string;
  reactions?: { results?: Array<{ count?: number }> };
  media?: { className?: string; photo?: unknown; document?: { mimeType?: string; mime_type?: string; size?: number } };
};

async function downloadOneMedia(
  client: any,
  m: unknown,
  mediaDownloadedRef: { value: number },
  preferAnyMedia: boolean
): Promise<{ base64: string; mediaType: string } | null> {
  const msg = m as MsgLike;
  const isPhoto = msg.media && (String(msg.media!.className) === "MessageMediaPhoto" || (msg.media as any).photo);
  const doc = msg.media?.className === "MessageMediaDocument" ? (msg.media as any).document : null;
  const mime = doc && (doc.mimeType || doc.mime_type);
  const docSize = doc && typeof doc.size === "number" ? doc.size : undefined;
  const isTooLargeDoc = typeof docSize === "number" && docSize > MAX_MEDIA_BYTES;
  const isImageDoc = mime && /^image\/(gif|jpeg|jpg|png|webp)$/i.test(mime);
  const isVideoDoc = mime && /^video\//i.test(mime);
  const hasMedia =
    mediaDownloadedRef.value < MAX_POSTS_WITH_MEDIA &&
    !isTooLargeDoc &&
    (isPhoto || isImageDoc || isVideoDoc || (preferAnyMedia && Boolean(msg.media)));
  if (!hasMedia) return null;
  try {
    const buf = await Promise.race([
      client.downloadMedia(m as never, {}),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), MEDIA_DOWNLOAD_TIMEOUT_MS)),
    ]);
    if (buf && Buffer.isBuffer(buf)) {
      mediaDownloadedRef.value += 1;
      return {
        base64: buf.toString("base64"),
        mediaType: isPhoto ? "image/jpeg" : (mime || "image/png"),
      };
    }
  } catch {
    // skip
  }
  return null;
}

async function mapMessageToPost(
  client: any,
  m: unknown,
  mediaDownloadedRef: { value: number },
  preferAnyMedia = false
): Promise<ChannelPost | null> {
  const msg = m as MsgLike;
  const date = msg.date ? new Date(msg.date * 1000) : new Date();
  const text = (msg.message ?? msg.text ?? "").trim();
  const views = typeof msg.views === "number" ? msg.views : 0;
  const reactionsCount = getReactionsCount(msg);
  const media = await downloadOneMedia(client, m, mediaDownloadedRef, preferAnyMedia);
  const hasAnyMedia = Boolean(msg.media);
  if (!(text || media || hasAnyMedia)) return null;
  return {
    postId: typeof msg.id === "number" ? msg.id : undefined,
    date: date.toISOString(),
    text: text || "(пост без текста)",
    photoBase64: media?.base64,
    mediaType: media?.mediaType,
    views: views || undefined,
    reactionsCount: reactionsCount || undefined,
  };
}

async function mapGroupedMessagesToPost(
  client: any,
  messages: unknown[],
  mediaDownloadedRef: { value: number }
): Promise<ChannelPost | null> {
  if (messages.length === 0) return null;
  const first = messages[0] as MsgLike;
  const date = first.date ? new Date(first.date * 1000) : new Date();
  const text = (first.message ?? first.text ?? "").trim();
  const views = typeof first.views === "number" ? first.views : 0;
  const reactionsCount = getReactionsCount(first);
  const mediaItems: Array<{ base64: string; mediaType: string }> = [];
  for (const m of messages) {
    const item = await downloadOneMedia(client, m, mediaDownloadedRef, true);
    if (item) mediaItems.push(item);
  }
  if (mediaItems.length === 0 && !text) return null;
  const firstMedia = mediaItems[0];
  return {
    postId: typeof first.id === "number" ? first.id : undefined,
    date: date.toISOString(),
    text: text || "(пост без текста)",
    photoBase64: firstMedia?.base64,
    mediaType: firstMedia?.mediaType,
    mediaItems: mediaItems.length > 1 ? mediaItems : undefined,
    views: views || undefined,
    reactionsCount: reactionsCount || undefined,
  };
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
    const clientOptions = buildTelegramClientOptions();
    const client = new TelegramClient(
      new StringSession(sessionString),
      Number(apiId),
      apiHash,
      clientOptions
    );
    try {
      // Скрываем шум gramjs (INFO/WARN + TIMEOUT из update loop).
      client.setLogLevel("none" as any);
    } catch {}
    await client.connect();
    const entity = await client.getEntity(username.startsWith("@") ? username : `@${username}`);
    const allMessages: unknown[] = [];
    let offsetId = 0;
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
          hash: 0 as any,
        })
      );
      const raw = res as { messages?: unknown[] };
      const messages = raw.messages || [];
      if (i === 0) console.log("[channelParser] GetHistory: получено сообщений в первом ответе:", messages.length);
      if (messages.length === 0) break;
      allMessages.push(...messages);
      const lastMsg = messages[messages.length - 1] as { id?: number };
      offsetId = lastMsg?.id ?? 0;
    }
    const grouped = new Map<string | number, unknown[]>();
    const singles: unknown[] = [];
    for (const m of allMessages) {
      const gid = (m as MsgLike).grouped_id;
      if (gid != null && gid !== "") {
        const key = String(gid);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(m);
      } else {
        singles.push(m);
      }
    }
    const posts: ChannelPost[] = [];
    const mediaDownloadedRef = { value: 0 };
    const seenGroupIds = new Set<string>();
    for (const m of allMessages) {
      if (posts.length >= LAST_POSTS_LIMIT) break;
      const gid = (m as MsgLike).grouped_id;
      if (gid != null && gid !== "") {
        const key = String(gid);
        if (seenGroupIds.has(key)) continue;
        seenGroupIds.add(key);
        const group = grouped.get(key) || [m];
        const post = await mapGroupedMessagesToPost(client, group, mediaDownloadedRef);
        if (post) posts.push(post);
      } else {
        const post = await mapMessageToPost(client, m, mediaDownloadedRef);
        if (post) posts.push(post);
      }
    }
    await shutdownTelegramClient(client);
    const out = posts.slice(0, LAST_POSTS_LIMIT);
    console.log("[channelParser] Последних постов загружено:", out.length);
    if (allMessages.length > 0 && out.length === 0) {
      const first = allMessages[0] as Record<string, unknown>;
      console.log("[channelParser] Пример ключей первого сообщения:", Object.keys(first));
    }
    return out;
  } catch (e) {
    console.error("[channelParser] Ошибка загрузки постов:", e instanceof Error ? e.message : e);
    return [];
  }
}

async function fetchSpecificPostIfAvailable(username: string, postId: number): Promise<ChannelPost[]> {
  const apiId = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  const sessionString = getSessionString();
  if (!apiId || !apiHash || !sessionString) {
    console.log("[channelParser] Пост не загружается: нет API_ID, API_HASH или сессии в .env");
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
      buildTelegramClientOptions()
    );
    try {
      // Скрываем шум gramjs (INFO/WARN + TIMEOUT из update loop).
      client.setLogLevel("none" as any);
    } catch {}
    await client.connect();
    const entity = await client.getEntity(username.startsWith("@") ? username : `@${username}`);
    let target: unknown | null = null;
    let batchWithTarget: unknown[] = [];
    let offsetId = postId + 1;
    for (let i = 0; i < 6; i++) {
      const res = await client.invoke(
        new Api.messages.GetHistory({
          peer: entity,
          offsetId,
          offsetDate: 0,
          addOffset: 0,
          limit: 100,
          maxId: 0,
          minId: 0,
          hash: 0 as any,
        })
      );
      const messages = (res as { messages?: unknown[] }).messages || [];
      if (messages.length === 0) break;
      const found = messages.find((m) => (m as { id?: number }).id === postId);
      if (found) {
        target = found;
        batchWithTarget = messages;
        break;
      }
      offsetId = ((messages[messages.length - 1] as { id?: number }).id || 0);
      if (!offsetId || offsetId <= 1) break;
    }
    if (!target) {
      await shutdownTelegramClient(client);
      console.log(`[channelParser] Пост ${postId} не найден в истории @${username}, используем обычный режим постов.`);
      return fetchPostsIfAvailable(username);
    }
    const mediaDownloaded = { value: 0 };
    const gid = (target as MsgLike).grouped_id;
    let post: ChannelPost | null;
    if (gid != null && gid !== "") {
      const group = batchWithTarget.filter((m) => String((m as MsgLike).grouped_id) === String(gid));
      post = await mapGroupedMessagesToPost(client, group, mediaDownloaded);
    } else {
      post = await mapMessageToPost(client, target, mediaDownloaded, true);
    }
    await shutdownTelegramClient(client);
    return post ? [post] : [];
  } catch (e) {
    console.error("[channelParser] Ошибка загрузки конкретного поста:", e instanceof Error ? e.message : e);
    return fetchPostsIfAvailable(username);
  }
}
