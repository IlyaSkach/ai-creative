import type { ChannelInfo, ChannelPost, LandingContacts } from "./channelParser.js";
import sharp from "sharp";

const LANDING_FETCH_TIMEOUT_MS = Number(process.env.LANDING_FETCH_TIMEOUT_MS || 20000);
const LANDING_IMAGE_FETCH_TIMEOUT_MS = Number(process.env.LANDING_IMAGE_FETCH_TIMEOUT_MS || 8000);
const LANDING_MAX_IMAGES = Number(process.env.LANDING_MAX_IMAGES || 6);
const LANDING_MAX_IMAGE_BYTES = Number(process.env.LANDING_MAX_IMAGE_BYTES || 4 * 1024 * 1024);
const LANDING_MIN_IMAGE_BYTES = Number(process.env.LANDING_MIN_IMAGE_BYTES || 15000);
const LANDING_MIN_IMAGE_SIDE = Number(process.env.LANDING_MIN_IMAGE_SIDE || 220);
const LANDING_MIN_IMAGE_AREA = Number(process.env.LANDING_MIN_IMAGE_AREA || 120000);
const LANDING_MAX_POSTS = 30;
const PROMO_KEYWORDS_RE = /\b(скидк|акци|sale|discount|promo|промокод|выгод|распродаж|special offer|limited)\b/i;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function parseAbsoluteUrl(link: string): URL {
  let normalized = link.trim();
  if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
  return new URL(normalized);
}

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 ai-creative-bot" } });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchImageAsBase64(
  url: string,
  options?: { promoPriority?: boolean }
): Promise<{ base64: string; mediaType: string } | null> {
  const promoPriority = Boolean(options?.promoPriority);
  try {
    const res = await fetchTextWithTimeout(url, LANDING_IMAGE_FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) return null;
    const len = Number(res.headers.get("content-length") || 0);
    if (Number.isFinite(len) && len > 0 && len > LANDING_MAX_IMAGE_BYTES) return null;
    if (!promoPriority && Number.isFinite(len) && len > 0 && len < LANDING_MIN_IMAGE_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > LANDING_MAX_IMAGE_BYTES) return null;
    if (!promoPriority && buf.length < LANDING_MIN_IMAGE_BYTES) return null;
    const meta = await sharp(buf, { failOn: "none", animated: false }).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (w > 0 && h > 0) {
      if (!promoPriority && Math.min(w, h) < LANDING_MIN_IMAGE_SIDE) return null;
      if (!promoPriority && w * h < LANDING_MIN_IMAGE_AREA) return null;
    }
    return { base64: buf.toString("base64"), mediaType: contentType || "image/jpeg" };
  } catch {
    return null;
  }
}

function extractMeta(html: string, names: string[]): string {
  for (const name of names) {
    const reA = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
    const reB = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["'][^>]*>`, "i");
    const m = html.match(reA) || html.match(reB);
    if (m?.[1]) return stripTags(m[1]);
  }
  return "";
}

function extractTitle(html: string, fallback: string): string {
  const ogTitle = extractMeta(html, ["og:title", "twitter:title"]);
  if (ogTitle) return ogTitle;
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m?.[1]) return stripTags(m[1]);
  return fallback;
}

function extractDescription(html: string): string {
  const ogDesc = extractMeta(html, ["description", "og:description", "twitter:description"]);
  if (ogDesc) return ogDesc;
  const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return p?.[1] ? stripTags(p[1]) : "";
}

function extractMetaImageUrls(html: string, baseUrl: URL): string[] {
  const values: string[] = [];
  const keys = ["og:image", "twitter:image", "twitter:image:src"];
  for (const key of keys) {
    const raw = extractMeta(html, [key]);
    if (!raw) continue;
    try {
      const abs = new URL(raw, baseUrl).toString();
      if (/^https?:\/\//i.test(abs)) values.push(abs);
    } catch {}
  }
  return unique(values);
}

function extractTextBlocks(html: string): string[] {
  const blocks: string[] = [];
  const re = /<(h1|h2|h3|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = stripTags(m[2] || "");
    if (text.length >= 30) blocks.push(text);
    if (blocks.length >= LANDING_MAX_POSTS) break;
  }
  return unique(blocks);
}

function extractContacts(html: string, pageUrl: URL): LandingContacts {
  const text = stripTags(html);
  const phones = unique(
    (text.match(/(?:\+?\d[\d\-\s()]{8,}\d)/g) || [])
      .map((x) => x.replace(/\s+/g, " ").trim())
      .filter((x) => x.replace(/\D/g, "").length >= 10)
      .slice(0, 6)
  );
  const emails = unique(
    (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
      .map((x) => x.trim().toLowerCase())
      .slice(0, 6)
  );
  const whatsapp = unique(
    [
      ...(html.match(/https?:\/\/(?:wa\.me|api\.whatsapp\.com)\/[^\s"'<>]+/gi) || []),
      ...(html.match(/whatsapp:\+?[0-9]+/gi) || []),
    ].slice(0, 6)
  );
  const telegram = unique(
    [
      ...(html.match(/https?:\/\/t\.me\/[a-zA-Z0-9_\/]+/gi) || []),
      ...(html.match(/@[a-zA-Z0-9_]{5,}/g) || []).map((x) => `https://t.me/${x.slice(1)}`),
    ].slice(0, 6)
  );

  const contacts: LandingContacts = {};
  if (phones.length > 0) contacts.phones = phones;
  if (emails.length > 0) contacts.emails = emails;
  if (whatsapp.length > 0) contacts.whatsapp = whatsapp;
  if (telegram.length > 0) contacts.telegram = telegram.filter((x) => !x.includes(pageUrl.hostname)).slice(0, 6);
  return contacts;
}

function extractImageUrls(html: string, baseUrl: URL): Array<{ url: string; score: number; promoPriority: boolean }> {
  const scored = new Map<string, { score: number; promoPriority: boolean }>();
  for (const m of extractMetaImageUrls(html, baseUrl)) {
    scored.set(m, { score: 100, promoPriority: false });
  }

  const re = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0] || "";
    const near = html.slice(Math.max(0, m.index - 450), Math.min(html.length, m.index + tag.length + 450));
    const raw = (m[1] || "").trim();
    if (!raw || raw.startsWith("data:")) continue;
    try {
      const abs = new URL(raw, baseUrl).toString();
      if (!/^https?:\/\//i.test(abs)) continue;

      let score = 0;
      let promoPriority = false;
      const lowerUrl = abs.toLowerCase();
      const classMatch = tag.match(/class=["']([^"']+)["']/i);
      const className = (classMatch?.[1] || "").toLowerCase();
      const altMatch = tag.match(/alt=["']([^"']+)["']/i);
      const altText = (altMatch?.[1] || "").toLowerCase();
      const widthMatch = tag.match(/width=["']?(\d{2,5})["']?/i);
      const heightMatch = tag.match(/height=["']?(\d{2,5})["']?/i);
      const width = widthMatch ? Number(widthMatch[1]) : 0;
      const height = heightMatch ? Number(heightMatch[1]) : 0;

      if (/logo|icon|sprite|favicon|avatar|badge/.test(lowerUrl)) score -= 10;
      if (/logo|icon|sprite|favicon|avatar|badge/.test(className)) score -= 10;
      if (/hero|banner|cover|product|gallery|portfolio|case|project/.test(lowerUrl)) score += 4;
      if (/hero|banner|cover|product|gallery|portfolio|case|project/.test(className)) score += 4;
      if (altText.length >= 18) score += 1;
      if (PROMO_KEYWORDS_RE.test(near)) {
        // Если рядом промо-слова, картинку нужно обязательно тянуть в коллекцию.
        score += 25;
        promoPriority = true;
      }

      if (width > 0 && height > 0) {
        const area = width * height;
        if (Math.min(width, height) < 120) score -= 10;
        if (area < 40000) score -= 8;
        if (area >= 160000) score += 3;
      }

      const prev = scored.get(abs);
      if (!prev || score > prev.score || (promoPriority && !prev.promoPriority)) {
        scored.set(abs, { score, promoPriority });
      }
    } catch {}
    if (scored.size >= LANDING_MAX_IMAGES * 8) break;
  }
  return [...scored.entries()]
    .map(([url, meta]) => ({ url, score: meta.score, promoPriority: meta.promoPriority }))
    .sort((a, b) => {
      if (a.promoPriority && !b.promoPriority) return -1;
      if (!a.promoPriority && b.promoPriority) return 1;
      return b.score - a.score;
    });
}

export async function parseLanding(link: string): Promise<ChannelInfo> {
  const url = parseAbsoluteUrl(link);
  const res = await fetchTextWithTimeout(url.toString(), LANDING_FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Не удалось загрузить сайт: HTTP ${res.status}`);
  const html = await res.text();
  const title = extractTitle(html, url.hostname);
  const description = extractDescription(html);
  const blocks = extractTextBlocks(html);
  const landingContacts = extractContacts(html, url);
  const imageCandidates = extractImageUrls(html, url);

  const images: Array<{ base64: string; mediaType: string }> = [];
  for (const candidate of imageCandidates) {
    if (images.length >= LANDING_MAX_IMAGES) break;
    const parsed = await fetchImageAsBase64(candidate.url, { promoPriority: candidate.promoPriority });
    if (parsed) images.push(parsed);
  }

  const posts: ChannelPost[] = [];
  for (let i = 0; i < Math.min(LANDING_MAX_POSTS, Math.max(blocks.length, images.length, 1)); i++) {
    const text = blocks[i] || blocks[i % Math.max(blocks.length, 1)] || `Материал с сайта ${url.hostname}`;
    const image = images[i] || null;
    posts.push({
      date: new Date().toISOString(),
      text,
      photoBase64: image?.base64,
      mediaType: image?.mediaType,
      views: undefined,
      reactionsCount: undefined,
    });
  }

  return {
    title: title || url.hostname,
    description: description || `Лендинг/сайт: ${url.hostname}`,
    username: url.hostname.replace(/^www\./i, ""),
    channelLink: url.toString(),
    posts,
    directPostMode: false,
    landingContacts,
  };
}
