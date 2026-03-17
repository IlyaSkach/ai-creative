/**
 * Генерация и редактирование текста креатива через AI (DeepSeek, Bothub, OpenAI).
 */

import { type AiProvider, chatCompletion } from "./ai-providers.js";

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
  posts: Array<{
    postId?: number;
    date: string;
    text: string;
    photoBase64?: string;
    mediaType?: string;
    mediaItems?: Array<{ base64: string; mediaType: string }>;
    views?: number;
    reactionsCount?: number;
  }>;
  landingContacts?: {
    phones?: string[];
    emails?: string[];
    whatsapp?: string[];
    telegram?: string[];
  };
}

export interface TopicsAnalysis {
  summary: string;
  topics: string[];
  bestThemesInsight: string;
}

export type CreativeStyle =
  | "native"
  | "direct"
  | "clickbait"
  | "history"
  | "useful"
  | "expert"
  | "humor"
  | "mini_landing";
export type CreativeGoal = "subscribers" | "sales" | "brand";
export type EmojiAmount = "low" | "medium" | "high";
export type TargetGender = "male" | "female";
export type TargetAge = "children" | "teens" | "adults" | "elderly";

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
    const topPosts = byEngagement.slice(0, 12);
    context += "\nПосты с наибольшим охватом (просмотры и реакции) — используй их как основной материал для креатива:\n";
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
  return trimForModel(lines.join("\n"), 4200);
}

function cleanJsonString(content: string): string {
  return content.replace(/^```json?\s*/i, "").replace(/\s*```$/, "").trim();
}

export async function analyzeChannelTopics(
  channelInfo: ChannelInfo,
  aiProvider: AiProvider = "deepseek"
): Promise<TopicsAnalysis> {
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
      bestThemesInsight: "Недостаточно данных по постам для оценки наиболее эффективных тем.",
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
  "topics": ["Тема 1", "Тема 2", "Тема 3"],
  "best_themes_insight": "Коротко: какие темы заходят лучше всего (по вовлеченности) и почему"
}

Требования:
- topics: от 1 до 6 пунктов
- темы короткие и конкретные
- best_themes_insight: 1-2 коротких предложения, с упоминанием самых сильных тем
- без markdown, только JSON`);

  const content = await chatCompletion(aiProvider, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], { temperature: 0.3 });
  const cleaned = cleanJsonString(content);
  try {
    const parsed = JSON.parse(cleaned) as { summary?: string; topics?: unknown; best_themes_insight?: string };
    const topics = Array.isArray(parsed.topics)
      ? parsed.topics.map((x) => String(x).trim()).filter(Boolean).slice(0, 6)
      : [];
    return {
      summary: (parsed.summary || "Основные направления определены по постам.").trim(),
      topics: topics.length > 0 ? topics : ["Общая тема канала"],
      bestThemesInsight: (parsed.best_themes_insight || "Наилучшие темы определяются по постам с максимальными просмотрами и реакциями.").trim(),
    };
  } catch {
    return {
      summary: "Не удалось точно распарсить темы. Используйте общий креатив по каналу.",
      topics: ["Общая тема канала"],
      bestThemesInsight: "Не удалось автоматически определить наиболее сильные темы. Проверьте посты с самым высоким охватом.",
    };
  }
}

export async function generateCreative(
  channelInfo: ChannelInfo,
  withImage: boolean,
  selectedTopic?: string,
  forcedSourcePostIndex?: number,
  style: CreativeStyle = "native",
  goal: CreativeGoal = "subscribers",
  contactsToInclude?: string[],
  emojiAmount: EmojiAmount = "medium",
  targetGender: TargetGender[] = [],
  targetAge: TargetAge[] = [],
  aiProvider: AiProvider = "deepseek"
): Promise<{ text: string; imagePrompt: string | null; sourcePostIndex: number | null }> {
  const context = buildContext(channelInfo, selectedTopic);
  const indexedPostsContext = buildPostIndexContext(channelInfo);
  const styleRules: Record<CreativeStyle, string> = {
    native:
      [
        "Стиль: НАТИВНЫЙ СТИЛЬ (как обычный пост).",
        "Формат: личная рекомендация или жизненная мини-ситуация, как будто это обычный контент канала.",
        "Особенности: разговорный тон, личный опыт, минимум продажности.",
        "Запрещено: агрессивные офферы, крикливые рекламные штампы.",
      ].join(" "),
    direct:
      [
        "Стиль: ПРЯМОЙ ПРОДАЮЩИЙ (жесткий оффер).",
        "Структура обязательна: проблема -> решение -> выгода -> CTA.",
        "Подача: классическая реклама с четким оффером и сильным призывом.",
      ].join(" "),
    clickbait:
      [
        "Стиль: КЛИКБЕЙТ/ИНТРИГА.",
        "Особенности: сильный заголовок в начале, неожиданная информация, интрига до середины текста.",
        "Сначала зацепи внимание, затем раскрой продукт и зачем идти в канал.",
      ].join(" "),
    history:
      [
        "Стиль: ИСТОРИЯ.",
        "Обязательный мини-сюжет: завязка -> поворот -> развязка, старт именно с истории.",
        "Формат обязателен: герой -> проблема -> процесс -> результат.",
        "Креатив должен читаться как кейс или рассказ, а не рекламный шаблон.",
      ].join(" "),
    useful:
      [
        "Стиль: ПОЛЕЗНЫЙ ПОСТ + РЕКЛАМА.",
        "Структура обязательна: советы/инструкция -> вывод -> рекомендация продукта/канала.",
        "Сначала дай читателю конкретную пользу, затем мягко переведи в рекламную часть.",
      ].join(" "),
    expert:
      [
        "Стиль: ЭКСПЕРТНЫЙ/АНАЛИТИЧЕСКИЙ.",
        "Подача как профессиональный совет или аналитика.",
        "Обязательно используй цифры, факты, кейсы, экспертный тон.",
      ].join(" "),
    humor:
      [
        "Стиль: МЕМНЫЙ/ЮМОРИСТИЧЕСКИЙ.",
        "Формат: мем/шутка -> неожиданный переход к рекламе.",
        "Юмор должен быть реально заметным, но без токсичности и грубости.",
      ].join(" "),
    mini_landing:
      [
        "Стиль: МИНИ-ЛЕНДИНГ ВНУТРИ ПОСТА.",
        "Структура обязательна: заголовок -> преимущества списком -> отзывы/соцдоказательство -> кнопка/ссылка (CTA).",
        "Пиши так, чтобы пост читался как компактный лендинг в Telegram.",
      ].join(" "),
  };

  const styleContrastRule = sanitizeForModel(`КРИТИЧНО: строго придерживайся только выбранного стиля и его структуры.
Не смешивай стили между собой и не перескакивай между форматами.`);
  const goalRules: Record<CreativeGoal, string> = {
    subscribers:
      "Цель креатива: ПОДПИСЧИКИ. Главный акцент — зачем подписаться прямо сейчас, какую пользу человек будет регулярно получать в канале.",
    sales:
      "Цель креатива: ПРОДАЖИ. Главный акцент — подвести к покупке товара/услуги: оффер, выгоды, снятие возражений, явный CTA на действие.",
    brand:
      "Цель креатива: БРЕНД / PR. Главный акцент — повысить узнаваемость, доверие и интерес к бренду/продукту, не давить жесткой продажей.",
  };

  const emojiRules: Record<EmojiAmount, string> = {
    low: "Эмодзи: МИНИМУМ. Используй 0–2 эмодзи на весь креатив, только если уместно.",
    medium: "Эмодзи: УМЕРЕННО. Используй 3–6 эмодзи, расставь по тексту для акцентов.",
    high: "Эмодзи: МНОГО. Используй 7–12 эмодзи, делай текст живым и выразительным.",
  };

  const genderRule =
    targetGender.length === 0
      ? "Аудитория: широкая (мужчины и женщины)."
      : targetGender.length === 2
        ? "Аудитория: широкая (мужчины и женщины)."
        : targetGender[0] === "male"
          ? "Аудитория: МУЖСКАЯ. Пиши так, чтобы креатив резонировал с мужской аудиторией: формулировки, примеры, выгоды."
          : "Аудитория: ЖЕНСКАЯ. Пиши так, чтобы креатив резонировал с женской аудиторией: формулировки, примеры, выгоды.";

  const ageLabels: Record<TargetAge, string> = {
    children: "дети",
    teens: "подростки",
    adults: "взрослые",
    elderly: "пожилые",
  };
  const ageRule =
    targetAge.length === 0
      ? "Возраст аудитории: любой."
      : `Возраст аудитории: ${targetAge.map((a) => ageLabels[a]).join(", ")}. Адаптируй тон, примеры и подачу под эту возрастную группу.`;

  const system = sanitizeForModel(`Ты профессиональный копирайтер рекламных постов для Telegram.
Твоя задача: создать рекламный пост-креатив по тематике канала.
Креатив должен быть эксклюзивным: опирайся на конкретные посты и темы канала (например, если есть пост про "SEO в 2026" — упомяни это в креативе: "Всё про SEO в 2026 и не только — подписывайтесь").
Требования:
- Пост должен быть адаптирован под Telegram.
- Короткие абзацы.
- Читается быстро.
- Сильный первый абзац (hook).
- Не пиши как классическую баннерную рекламу.
- Длина 600–1200 символов.
- Обязательно включи призыв зайти в канал и ссылку на канал.
- Если выбрана конкретная тема — креатив должен фокусироваться именно на ней.

${styleRules[style]}
${styleContrastRule}
${goalRules[goal]}
${emojiRules[emojiAmount]}
${genderRule}
${ageRule}
Без markdown.`);
  const focusedPost =
    forcedSourcePostIndex && forcedSourcePostIndex >= 1 && forcedSourcePostIndex <= channelInfo.posts.length
      ? channelInfo.posts[forcedSourcePostIndex - 1]
      : null;
  const focusedPostHint = focusedPost
    ? `\nФокусный пост для креатива: #${forcedSourcePostIndex} (${trimForModel(focusedPost.text || "(без текста)", 220)}). Используй его как главную основу.\n`
    : "";
  const contactsBlock =
    Array.isArray(contactsToInclude) && contactsToInclude.length > 0
      ? `\nКонтакты для включения в креатив (добавь их в финальный текст без изменений):\n${contactsToInclude
          .map((c) => `- ${trimForModel(String(c), 120)}`)
          .join("\n")}\n`
      : "";

  const user = sanitizeForModel(`${context}

Посты с индексами (используй их для выбора релевантного поста по теме):
${indexedPostsContext || "Нет постов"}
${focusedPostHint}
${contactsBlock}

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
- если задан фокусный пост — укажи именно его индекс
- если релевантного поста нет, укажи null

${withImage ? "Нужна картинка — заполни image_prompt на английском." : "Картинка не нужна — в image_prompt укажи null."}`);

  const content = await chatCompletion(aiProvider, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], { temperature: 0.7 });
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
  userInstruction: string,
  aiProvider: AiProvider = "deepseek"
): Promise<string> {
  const content = await chatCompletion(aiProvider, [
    {
      role: "system",
      content:
        "Ты помогаешь редактировать рекламный текст. Возвращай только итоговый текст креатива, без пояснений и markdown.",
    },
    {
      role: "user",
      content: sanitizeForModel(`Текущий текст креатива:\n${currentText}\n\nПользователь просит: ${userInstruction}\n\nВерни только обновлённый текст креатива.`),
    },
  ], { temperature: 0.5 });
  return content.replace(/^["']|["']$/g, "").trim() || currentText;
}
