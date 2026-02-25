/**
 * Генерация и редактирование текста креатива через DeepSeek API.
 */

function getConfig() {
  return {
    base: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY?.trim() || "",
  };
}

function sanitizeForModel(input: string): string {
  const normalized = input
    .normalize("NFKC")
    .replace(/\u0000/g, " ")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    // Удаляем суррогатные пары/полусуррогаты, которые иногда ломают JSON-парсеры провайдера
    .replace(/[\uD800-\uDFFF]/g, " ")
    // У некоторых провайдеров LLM бывают баги с escape-последовательностями в длинных payload
    .replace(/\\/g, "/")
    .replace(/\s{2,}/g, " ")
    .trim();
  return normalized;
}

function trimForModel(input: string, maxLen: number): string {
  const s = sanitizeForModel(input);
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

export interface ChannelInfo {
  title: string;
  description: string;
  username: string;
  channelLink: string;
  posts: Array<{ date: string; text: string; photoBase64?: string; mediaType?: string; views?: number; reactionsCount?: number }>;
}

export interface TopicsAnalysis {
  summary: string;
  topics: string[];
}

/** Охват поста: просмотры + реакции (реакции учитываем с весом). */
function engagementScore(p: { views?: number; reactionsCount?: number }): number {
  return (p.views ?? 0) + (p.reactionsCount ?? 0) * 2;
}

function buildContext(info: ChannelInfo, selectedTopic?: string): string {
  let context = `Название канала: ${info.title}\nОписание: ${info.description}\nСсылка: ${info.channelLink}\n`;
  if (selectedTopic) {
    context += `Выбранная тема для креатива: ${selectedTopic}\n`;
  }
  if (info.posts.length > 0) {
    const byEngagement = [...info.posts].sort((a, b) => engagementScore(b) - engagementScore(a));
    const topPosts = byEngagement.slice(0, 6);
    context += "\nПосты с наибольшим охватом (просмотры и реакции) — опирайся на них для креатива:\n";
    for (const p of topPosts) {
      const meta = [p.views != null && `просмотров: ${p.views}`, p.reactionsCount != null && p.reactionsCount > 0 && `реакций: ${p.reactionsCount}`].filter(Boolean).join(", ");
      const safeText = trimForModel(p.text, 220);
      context += `- ${meta ? `[${meta}] ` : ""}${safeText}\n`;
    }
  }
  return trimForModel(context, 3500);
}

function buildPostIndexContext(info: ChannelInfo): string {
  if (!info.posts || info.posts.length === 0) return "";
  const lines: string[] = [];
  for (let i = 0; i < info.posts.length; i++) {
    const p = info.posts[i];
    const hasMedia = p.photoBase64 ? "yes" : "no";
    const meta = [
      p.views != null ? `views:${p.views}` : "",
      p.reactionsCount != null ? `reactions:${p.reactionsCount}` : "",
      `media:${hasMedia}`,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`#${i + 1} [${meta}] ${trimForModel(p.text, 140)}`);
  }
  return trimForModel(lines.join("\n"), 2600);
}

function extractModelText(data: { choices?: Array<{ message?: { content?: string } }> }): string {
  return data.choices?.[0]?.message?.content?.trim() || "";
}

function cleanJsonString(content: string): string {
  return content.replace(/^```json?\s*/i, "").replace(/\s*```$/, "").trim();
}

export async function analyzeChannelTopics(channelInfo: ChannelInfo): Promise<TopicsAnalysis> {
  const { base: DEEPSEEK_BASE, apiKey: API_KEY } = getConfig();
  if (!API_KEY) throw new Error("DEEPSEEK_API_KEY не задан");

  const posts = channelInfo.posts
    .slice()
    .sort((a, b) => engagementScore(b) - engagementScore(a))
    .slice(0, 12)
    .map((p) => p.text)
    .filter((t) => t && t.trim().length > 0)
    .map((t) => trimForModel(t, 220));

  if (posts.length === 0) {
    return {
      summary: "По постам не удалось определить темы. Можно писать креатив по описанию канала.",
      topics: ["Общая тема канала"],
    };
  }

  const system = "Ты — аналитик Telegram-каналов. Выделяй основные тематические направления канала по постам.";
  const user = sanitizeForModel(`Данные канала:
Название: ${channelInfo.title}
Описание: ${channelInfo.description}
Ссылка: ${channelInfo.channelLink}

Посты:
${posts.map((p) => `- ${p}`).join("\n")}

Определи основные направления канала и верни СТРОГО JSON:
{
  "summary": "1-2 предложения с общей картиной канала",
  "topics": ["Тема 1", "Тема 2", "Тема 3"]
}

Требования:
- topics: от 1 до 6 пунктов
- темы короткие и конкретные
- без markdown, только JSON`);

  const res = await fetch(`${DEEPSEEK_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek API error: ${res.status} ${err}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = extractModelText(data);
  const cleaned = cleanJsonString(content);
  try {
    const parsed = JSON.parse(cleaned) as { summary?: string; topics?: unknown };
    const topics = Array.isArray(parsed.topics)
      ? parsed.topics.map((x) => String(x).trim()).filter(Boolean).slice(0, 6)
      : [];
    return {
      summary: (parsed.summary || "Основные направления определены по постам.").trim(),
      topics: topics.length > 0 ? topics : ["Общая тема канала"],
    };
  } catch {
    return {
      summary: "Не удалось точно распарсить темы. Используйте общий креатив по каналу.",
      topics: ["Общая тема канала"],
    };
  }
}

export async function generateCreative(
  channelInfo: ChannelInfo,
  withImage: boolean,
  selectedTopic?: string
): Promise<{ text: string; imagePrompt: string | null; sourcePostIndex: number | null }> {
  const { base: DEEPSEEK_BASE, apiKey: API_KEY } = getConfig();
  if (!API_KEY) throw new Error("DEEPSEEK_API_KEY не задан");
  const context = buildContext(channelInfo, selectedTopic);
  const indexedPostsContext = buildPostIndexContext(channelInfo);
  const system = sanitizeForModel(`Ты — креативщик для рекламы Telegram-каналов. Твоя задача: создать рекламный пост-креатив по тематике канала.
Креатив должен быть эксклюзивным: опирайся на конкретные посты и темы канала (например, если есть пост про "SEO в 2026" — упомяни это в креативе: "Всё про SEO в 2026 и не только — подписывайтесь").
Обязательно включи призыв зайти в канал и ссылку на канал.
Сделай текст длиннее и структурированнее: 2–3 абзаца, с пустой строкой между абзацами.
Целевая длина: 450–800 символов.
Добавь уместные эмодзи в текст (обычно 2–6 штук на весь креатив, без перегруза).
Если выбрана конкретная тема — креатив должен фокусироваться именно на ней.
Без markdown.`);
  const user = sanitizeForModel(`${context}

Посты с индексами (используй их для выбора релевантного поста по теме):
${indexedPostsContext || "Нет постов"}

Сгенерируй креатив.${selectedTopic ? ` Фокус-тема: ${selectedTopic}.` : ""}

Ответь СТРОГО в формате JSON, без markdown и лишнего текста:
{
  "text": "Текст креатива со ссылкой на канал",
  "image_prompt": "короткое описание картинки на английском для DALL-E, до 150 символов, или null если картинка не нужна",
  "source_post_index": 1
}

Требования к source_post_index:
- это номер поста из списка выше (1..N) или null
- если есть выбранная тема, укажи номер поста, который лучше всего соответствует теме
- при равенстве выбирай пост с media:yes
- если релевантного поста нет, укажи null

${withImage ? "Нужна картинка — заполни image_prompt на английском." : "Картинка не нужна — в image_prompt укажи null."}`);

  const res = await fetch(`${DEEPSEEK_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.7,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek API error: ${res.status} ${err}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = extractModelText(data);
  const cleaned = cleanJsonString(content);
  let text = content;
  let imagePrompt: string | null = null;
  let sourcePostIndex: number | null = null;
  try {
    const parsed = JSON.parse(cleaned) as { text?: string; image_prompt?: string | null; source_post_index?: number | null | string };
    text = parsed.text || content;
    imagePrompt = parsed.image_prompt ?? null;
    if (imagePrompt === "null" || imagePrompt === "") imagePrompt = null;
    const rawIndex = typeof parsed.source_post_index === "string"
      ? Number(parsed.source_post_index)
      : parsed.source_post_index;
    if (typeof rawIndex === "number" && Number.isFinite(rawIndex)) {
      const normalized = Math.trunc(rawIndex);
      if (normalized >= 1 && normalized <= channelInfo.posts.length) {
        sourcePostIndex = normalized;
      }
    }
  } catch {
    // use raw as text
  }
  return { text, imagePrompt: withImage ? imagePrompt : null, sourcePostIndex };
}

export async function editCreativeWithAi(
  currentText: string,
  userInstruction: string
): Promise<string> {
  const { base: DEEPSEEK_BASE, apiKey: API_KEY } = getConfig();
  if (!API_KEY) throw new Error("DEEPSEEK_API_KEY не задан");
  const res = await fetch(`${DEEPSEEK_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content:
            "Ты помогаешь редактировать рекламный текст. Возвращай только итоговый текст креатива, без пояснений и markdown.",
        },
        {
          role: "user",
          content: sanitizeForModel(`Текущий текст креатива:\n${currentText}\n\nПользователь просит: ${userInstruction}\n\nВерни только обновлённый текст креатива.`),
        },
      ],
      temperature: 0.5,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek API error: ${res.status} ${err}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim() || "";
  return content.replace(/^["']|["']$/g, "").trim() || currentText;
}
