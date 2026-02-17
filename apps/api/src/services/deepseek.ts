/**
 * Генерация и редактирование текста креатива через DeepSeek API.
 */

function getConfig() {
  return {
    base: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY?.trim() || "",
  };
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
    const topPosts = byEngagement.slice(0, 10);
    context += "\nПосты с наибольшим охватом (просмотры и реакции) — опирайся на них для креатива:\n";
    for (const p of topPosts) {
      const meta = [p.views != null && `просмотров: ${p.views}`, p.reactionsCount != null && p.reactionsCount > 0 && `реакций: ${p.reactionsCount}`].filter(Boolean).join(", ");
      context += `- ${meta ? `[${meta}] ` : ""}${p.text.slice(0, 500)}${p.text.length > 500 ? "…" : ""}\n`;
    }
  }
  return context;
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
    .slice(0, 30)
    .map((p) => p.text)
    .filter((t) => t && t.trim().length > 0)
    .map((t) => t.slice(0, 400));

  if (posts.length === 0) {
    return {
      summary: "По постам не удалось определить темы. Можно писать креатив по описанию канала.",
      topics: ["Общая тема канала"],
    };
  }

  const system = "Ты — аналитик Telegram-каналов. Выделяй основные тематические направления канала по постам.";
  const user = `Данные канала:
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
- без markdown, только JSON`;

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
): Promise<{ text: string; imagePrompt: string | null }> {
  const { base: DEEPSEEK_BASE, apiKey: API_KEY } = getConfig();
  if (!API_KEY) throw new Error("DEEPSEEK_API_KEY не задан");
  const context = buildContext(channelInfo, selectedTopic);
  const system = `Ты — креативщик для рекламы Telegram-каналов. Твоя задача: создать короткий рекламный пост-креатив по тематике канала.
Креатив должен быть эксклюзивным: опирайся на конкретные посты и темы канала (например, если есть пост про "SEO в 2026" — упомяни это в креативе: "Всё про SEO в 2026 и не только — подписывайтесь").
Обязательно включи призыв зайти в канал и ссылку на канал. Длина 200–400 символов, можно эмодзи.
Если выбрана конкретная тема — креатив должен фокусироваться именно на ней.`;
  const user = `${context}\n\nСгенерируй креатив.${selectedTopic ? ` Фокус-тема: ${selectedTopic}.` : ""} Ответь СТРОГО в формате JSON, без markdown и лишнего текста:\n{\n  "text": "Текст креатива со ссылкой на канал",\n  "image_prompt": "короткое описание картинки на английском для DALL-E, до 150 символов, или null если картинка не нужна"\n}\n${withImage ? "Нужна картинка — заполни image_prompt на английском." : "Картинка не нужна — в image_prompt укажи null."}`;

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
  try {
    const parsed = JSON.parse(cleaned) as { text?: string; image_prompt?: string | null };
    text = parsed.text || content;
    imagePrompt = parsed.image_prompt ?? null;
    if (imagePrompt === "null" || imagePrompt === "") imagePrompt = null;
  } catch {
    // use raw as text
  }
  return { text, imagePrompt: withImage ? imagePrompt : null };
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
          content: `Текущий текст креатива:\n${currentText}\n\nПользователь просит: ${userInstruction}\n\nВерни только обновлённый текст креатива.`,
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
