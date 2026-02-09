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

/** Охват поста: просмотры + реакции (реакции учитываем с весом). */
function engagementScore(p: { views?: number; reactionsCount?: number }): number {
  return (p.views ?? 0) + (p.reactionsCount ?? 0) * 2;
}

function buildContext(info: ChannelInfo): string {
  let context = `Название канала: ${info.title}\nОписание: ${info.description}\nСсылка: ${info.channelLink}\n`;
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

export async function generateCreative(
  channelInfo: ChannelInfo,
  withImage: boolean
): Promise<{ text: string; imagePrompt: string | null }> {
  const { base: DEEPSEEK_BASE, apiKey: API_KEY } = getConfig();
  if (!API_KEY) throw new Error("DEEPSEEK_API_KEY не задан");
  const context = buildContext(channelInfo);
  const system = `Ты — креативщик для рекламы Telegram-каналов. Твоя задача: создать короткий рекламный пост-креатив по тематике канала.
Креатив должен быть эксклюзивным: опирайся на конкретные посты и темы канала (например, если есть пост про "SEO в 2026" — упомяни это в креативе: "Всё про SEO в 2026 и не только — подписывайтесь").
Обязательно включи призыв зайти в канал и ссылку на канал. Длина 200–400 символов, можно эмодзи.`;
  const user = `${context}\n\nСгенерируй креатив. Ответь СТРОГО в формате JSON, без markdown и лишнего текста:\n{\n  "text": "Текст креатива со ссылкой на канал",\n  "image_prompt": "короткое описание картинки на английском для DALL-E, до 150 символов, или null если картинка не нужна"\n}\n${withImage ? "Нужна картинка — заполни image_prompt на английском." : "Картинка не нужна — в image_prompt укажи null."}`;

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
  const content = data.choices?.[0]?.message?.content?.trim() || "";
  const cleaned = content.replace(/^```json?\s*/i, "").replace(/\s*```$/, "").trim();
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
