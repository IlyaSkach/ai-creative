import { useEffect, useState } from "react";
import type { ChannelInfo } from "../api";
import type { CreativeGoal, CreativeStyle } from "../api";
import { analyzeChannelTopics, generateCreative } from "../api";

export type ImageMode = "none" | "generated" | "from_post";
export type GenerationMode = "single" | "per_topic";

export interface DraftCreative {
  topicLabel: string;
  topicPrompt?: string;
  style: CreativeStyle;
  goal: CreativeGoal;
  landingContactsToInclude?: string[];
  selectedTopics: string[];
  attachSourcePostLink: boolean;
  imageMode: ImageMode;
  text: string;
  imageBase64: string | null;
  imageMediaType: string | null;
  sourcePostIndex: number | null;
}

interface CreativeStepProps {
  channelInfo: ChannelInfo;
  onDone: (creatives: DraftCreative[]) => void;
}

function engagementScore(p: { views?: number; reactionsCount?: number }): number {
  return (p.views ?? 0) + (p.reactionsCount ?? 0) * 2;
}

function extractKeywords(topic: string): string[] {
  return topic
    .toLowerCase()
    .split(/[^a-zA-Zа-яА-Я0-9]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4);
}

function rankPostsByTopic(channelInfo: ChannelInfo, topic?: string): number[] {
  const withIndex = channelInfo.posts.map((post, idx) => ({ post, idx: idx + 1 }));
  const sorted = withIndex.sort((a, b) => engagementScore(b.post) - engagementScore(a.post));
  if (!topic) return sorted.map((x) => x.idx);
  const keywords = extractKeywords(topic);
  if (keywords.length === 0) return sorted.map((x) => x.idx);
  const matched = sorted.filter((x) => {
    const text = (x.post.text || "").toLowerCase();
    return keywords.some((k) => text.includes(k));
  });
  if (matched.length > 0) return matched.map((x) => x.idx);
  return sorted.map((x) => x.idx);
}

function pickMediaBySourcePostIndex(
  channelInfo: ChannelInfo,
  sourcePostIndex?: number | null
): { base64: string; mediaType: string; index: number } | null {
  if (!sourcePostIndex || sourcePostIndex < 1) return null;
  const post = channelInfo.posts[sourcePostIndex - 1];
  if (!post?.photoBase64) return null;
  return {
    base64: post.photoBase64,
    mediaType: post.mediaType || "image/jpeg",
    index: sourcePostIndex,
  };
}

function pickMediaByTopic(
  channelInfo: ChannelInfo,
  topic?: string
): { base64: string; mediaType: string; index: number } | null {
  const ranked = rankPostsByTopic(channelInfo, topic);
  for (const idx of ranked) {
    const post = channelInfo.posts[idx - 1];
    if (post?.photoBase64) {
      return {
        base64: post.photoBase64,
        mediaType: post.mediaType || "image/jpeg",
        index: idx,
      };
    }
  }
  return null;
}

function resolveSourcePostLink(channelInfo: ChannelInfo, sourcePostIndex?: number | null): string | null {
  if (sourcePostIndex && sourcePostIndex >= 1 && sourcePostIndex <= channelInfo.posts.length) {
    const post = channelInfo.posts[sourcePostIndex - 1];
    if (post?.postId) return `https://t.me/${channelInfo.username}/${post.postId}`;
  }
  if (channelInfo.directPostMode && channelInfo.sourcePostLink) return channelInfo.sourcePostLink;
  return null;
}

function appendSourcePostLink(text: string, link: string | null): string {
  if (!link) return text;
  const cleaned = text.trim();
  if (cleaned.includes(link)) return cleaned;
  return `${cleaned}\n\nПост-источник: ${link}`;
}

export function CreativeStep({ channelInfo, onDone }: CreativeStepProps) {
  const isDirectPostMode = Boolean(channelInfo.directPostMode);
  const isLandingMode = !/(^https?:\/\/)?(t\.me|telegram\.me|telegram\.dog)\//i.test(channelInfo.channelLink);
  const [imageMode, setImageMode] = useState<ImageMode>("generated");
  const [style, setStyle] = useState<CreativeStyle>("native");
  const [goal, setGoal] = useState<CreativeGoal>("subscribers");
  const [generationMode, setGenerationMode] = useState<GenerationMode>("single");
  const [attachSourcePostLink, setAttachSourcePostLink] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [topicsLoading, setTopicsLoading] = useState(false);
  const [topicsError, setTopicsError] = useState("");
  const [topicSummary, setTopicSummary] = useState("");
  const [bestThemesInsight, setBestThemesInsight] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [selectedLandingMediaIndex, setSelectedLandingMediaIndex] = useState<number | null>(null);
  const [selectedLandingContacts, setSelectedLandingContacts] = useState<string[]>([]);
  const [generated, setGenerated] = useState<DraftCreative[]>([]);

  const hasPostMedia = channelInfo.posts.some((p) => p.photoBase64);
  const postMediaCount = channelInfo.posts.filter((p) => p.photoBase64).length;
  const landingMediaPosts = channelInfo.posts
    .map((p, idx) => ({ post: p, index: idx + 1 }))
    .filter((x) => Boolean(x.post.photoBase64));
  const landingContactsList = [
    ...(channelInfo.landingContacts?.phones || []).map((v) => `Телефон: ${v}`),
    ...(channelInfo.landingContacts?.emails || []).map((v) => `Email: ${v}`),
    ...(channelInfo.landingContacts?.whatsapp || []).map((v) => `WhatsApp: ${v}`),
    ...(channelInfo.landingContacts?.telegram || []).map((v) => `Telegram: ${v}`),
  ];

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (isLandingMode) {
        setTopics([]);
        setSelectedTopics([]);
        setTopicsError("");
        setBestThemesInsight("");
        setTopicSummary(channelInfo.description?.trim() || `Сайт/лендинг: ${channelInfo.title}`);
        setTopicsLoading(false);
        return;
      }
      if (isDirectPostMode) {
        setTopics([]);
        setSelectedTopics(["Пост по ссылке"]);
        setTopicSummary("");
        setBestThemesInsight("");
        setTopicsError("");
        setTopicsLoading(false);
        return;
      }
      setTopicsLoading(true);
      setTopicsError("");
      try {
        const result = await analyzeChannelTopics(channelInfo);
        if (cancelled) return;
        const nextTopics = (result.topics || []).filter((t) => t.trim().length > 0);
        setTopicSummary(result.summary || "");
        setBestThemesInsight(result.bestThemesInsight || "");
        setTopics(nextTopics);
        setSelectedTopics(nextTopics.slice(0, Math.min(2, nextTopics.length)));
      } catch (e) {
        if (cancelled) return;
        setTopicsError(e instanceof Error ? e.message : "Не удалось проанализировать темы канала");
        setTopics(["Общая тема канала"]);
        setSelectedTopics(["Общая тема канала"]);
      } finally {
        if (!cancelled) setTopicsLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [channelInfo, isDirectPostMode, isLandingMode]);

  useEffect(() => {
    if (!isLandingMode) return;
    if (landingMediaPosts.length === 0) {
      setSelectedLandingMediaIndex(null);
      return;
    }
    setSelectedLandingMediaIndex((prev) => {
      if (prev && landingMediaPosts.some((x) => x.index === prev)) return prev;
      return landingMediaPosts[0].index;
    });
  }, [isLandingMode, landingMediaPosts]);

  useEffect(() => {
    if (!isLandingMode) return;
    setSelectedLandingContacts(landingContactsList);
  }, [isLandingMode, channelInfo.channelLink]);

  const toggleTopic = (topic: string) => {
    setSelectedTopics((prev) =>
      prev.includes(topic) ? prev.filter((t) => t !== topic) : [...prev, topic]
    );
  };

  const buildCreative = async (topicPrompt: string | undefined, topicLabel: string, allSelected: string[]): Promise<DraftCreative> => {
    const withImage = imageMode === "generated";
    const forcedSourcePostIndex = isDirectPostMode
      ? 1
      : (isLandingMode && imageMode === "from_post" ? (selectedLandingMediaIndex ?? undefined) : undefined);
    const preferredMedia = isDirectPostMode
      ? pickMediaBySourcePostIndex(channelInfo, 1)
      : (isLandingMode && imageMode === "from_post"
        ? pickMediaBySourcePostIndex(channelInfo, selectedLandingMediaIndex ?? null)
        : pickMediaByTopic(channelInfo, topicPrompt));
    const result = await generateCreative(
      channelInfo,
      withImage,
      topicPrompt,
      forcedSourcePostIndex ?? preferredMedia?.index,
      imageMode,
      style,
      goal,
      isLandingMode ? selectedLandingContacts : undefined
    );

    let draft: DraftCreative;

    if (imageMode === "generated") {
      draft = {
        topicLabel,
        topicPrompt,
        style,
        goal,
        landingContactsToInclude: isLandingMode ? selectedLandingContacts : undefined,
        selectedTopics: allSelected,
        attachSourcePostLink,
        imageMode,
        text: result.text,
        imageBase64: result.imageBase64,
        imageMediaType: result.imageMediaType || (result.imageBase64 ? "image/png" : null),
        sourcePostIndex: result.sourcePostIndex ?? null,
      };
    } else if (imageMode === "from_post") {
      const mediaBySource = pickMediaBySourcePostIndex(
        channelInfo,
        result.sourcePostIndex ?? forcedSourcePostIndex ?? null
      );
      const mediaByTopic = preferredMedia;
      const media = mediaBySource || mediaByTopic;
      draft = {
        topicLabel,
        topicPrompt,
        style,
        goal,
        landingContactsToInclude: isLandingMode ? selectedLandingContacts : undefined,
        selectedTopics: allSelected,
        attachSourcePostLink,
        imageMode,
        text: result.text,
        imageBase64: media?.base64 || null,
        imageMediaType: media?.mediaType || null,
        sourcePostIndex: media?.index ?? result.sourcePostIndex ?? null,
      };
    } else {
      draft = {
        topicLabel,
        topicPrompt,
        style,
        goal,
        landingContactsToInclude: isLandingMode ? selectedLandingContacts : undefined,
        selectedTopics: allSelected,
        attachSourcePostLink,
        imageMode,
        text: result.text,
        imageBase64: null,
        imageMediaType: null,
        sourcePostIndex: result.sourcePostIndex ?? null,
      };
    }

    if (attachSourcePostLink) {
      const sourceLink = resolveSourcePostLink(channelInfo, draft.sourcePostIndex);
      draft = { ...draft, text: appendSourcePostLink(draft.text, sourceLink) };
    }
    return draft;
  };

  const handleGenerate = async () => {
    setError("");
    setLoading(true);
    try {
      if (isLandingMode) {
        const landingSelected = ["Лендинг"];
        const landingCreative = await buildCreative(undefined, "Креатив по лендингу", landingSelected);
        if (imageMode === "from_post" && !landingCreative.imageBase64) {
          setError("Не удалось взять картинку с сайта. Выбери другую картинку или режим «С картинкой (ИИ)».");
        }
        setGenerated([landingCreative]);
        return;
      }
      if (isDirectPostMode) {
        const directSelected = ["Пост по ссылке"];
        const directCreative = await buildCreative(undefined, "Креатив по выбранному посту", directSelected);
        if (imageMode === "from_post" && !directCreative.imageBase64) {
          setError("В выбранном посте нет медиа. Выбери режим «С картинкой (ИИ)» или «Только текст».");
        }
        setGenerated([directCreative]);
        return;
      }
      const selected = selectedTopics.length > 0 ? selectedTopics : (topics.length > 0 ? [topics[0]] : ["Общая тема канала"]);
      let nextGenerated: DraftCreative[] = [];

      if (generationMode === "single") {
        const topicPrompt = selected.join(", ");
        nextGenerated = [await buildCreative(topicPrompt, "Один креатив по выбранным темам", selected)];
      } else {
        for (const topic of selected) {
          const draft = await buildCreative(topic, `Креатив по теме: ${topic}`, selected);
          nextGenerated.push(draft);
        }
      }

      if (imageMode === "from_post" && nextGenerated.some((x) => !x.imageBase64)) {
        setError("Для части тем не нашлось медиа в постах. Выбери темы точнее или режим «С картинкой (ИИ)».");
      }
      setGenerated(nextGenerated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка генерации");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <section className="card">
        <h2>Канал</h2>
        <p style={{ margin: 0 }}>
          <strong>{channelInfo.title}</strong>
          {channelInfo.description && (
            <>
              <br />
              <span style={{ color: "var(--muted)" }}>
                {channelInfo.description.slice(0, 200)}
                {channelInfo.description.length > 200 ? "…" : ""}
              </span>
            </>
          )}
        </p>
        <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
          <a
            href={channelInfo.directPostMode && channelInfo.sourcePostLink ? channelInfo.sourcePostLink : channelInfo.channelLink}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--accent)" }}
          >
            {channelInfo.directPostMode && channelInfo.sourcePostLink ? channelInfo.sourcePostLink : channelInfo.channelLink}
          </a>
          {" · "}
          {isLandingMode ? "Блоков контента: " : "Последних постов: "}{channelInfo.posts.length}
          {postMediaCount > 0 && `, с медиа (картинка/гиф/видео): ${postMediaCount}`}
          {!isLandingMode && channelInfo.posts.length > 0 && " · креатив по постам с макс. охватом (просмотры + реакции)"}
        </p>
      </section>

      <section className="card">
        <h2>Креатив</h2>
        <div style={{ display: "grid", gap: "0.9rem" }}>
          {isLandingMode && (
            <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.85rem" }}>
              <p className="label" style={{ marginBottom: "0.45rem" }}>Аналитика сайта</p>
              <p style={{ color: "var(--muted)", margin: 0 }}>
                {topicSummary || `Сайт/лендинг: ${channelInfo.title}`}
              </p>
              {landingContactsList.length > 0 && (
                <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.45rem" }}>
                  <p className="label" style={{ margin: 0 }}>Контакты (включать в креатив)</p>
                  {landingContactsList.map((contact) => (
                    <label key={contact} style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={selectedLandingContacts.includes(contact)}
                        onChange={(e) => {
                          setSelectedLandingContacts((prev) => (
                            e.target.checked ? [...prev, contact] : prev.filter((x) => x !== contact)
                          ));
                        }}
                      />
                      <span>{contact}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {!isDirectPostMode && !isLandingMode && (
            <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.85rem" }}>
              <p className="label" style={{ marginBottom: "0.45rem" }}>Темы канала (мультивыбор)</p>
              {topicsLoading ? (
                <p style={{ color: "var(--muted)", margin: 0 }}>Анализирую темы постов…</p>
              ) : (
                <>
                  {topicsError && <p className="error">{topicsError}</p>}
                  {topicSummary && (
                    <p style={{ color: "var(--muted)", marginTop: 0, marginBottom: "0.65rem" }}>{topicSummary}</p>
                  )}
                  {bestThemesInsight && (
                    <p style={{ color: "var(--accent)", marginTop: 0, marginBottom: "0.75rem" }}>
                      Аналитика: {bestThemesInsight}
                    </p>
                  )}
                  {topics.length > 0 && (
                    <div style={{ display: "grid", gap: "0.45rem" }}>
                      {topics.map((topic) => (
                        <label key={topic} style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={selectedTopics.includes(topic)}
                            onChange={() => toggleTopic(topic)}
                          />
                          <span>{topic}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {!isDirectPostMode && !isLandingMode && (
            <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.85rem" }}>
              <p className="label" style={{ marginBottom: "0.45rem" }}>Как генерировать</p>
              <div style={{ display: "grid", gap: "0.5rem" }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="gen-mode"
                    checked={generationMode === "single"}
                    onChange={() => setGenerationMode("single")}
                  />
                  <span>Один креатив по всем выбранным темам</span>
                </label>
                <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="gen-mode"
                    checked={generationMode === "per_topic"}
                    onChange={() => setGenerationMode("per_topic")}
                  />
                  <span>Отдельный креатив по каждой выбранной теме</span>
                </label>
              </div>
            </div>
          )}

          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.85rem" }}>
            <p className="label" style={{ marginBottom: "0.45rem" }}>Стиль креатива</p>
            <div style={{ display: "grid", gap: "0.5rem" }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="creative-style"
                  checked={style === "native"}
                  onChange={() => setStyle("native")}
                />
                <span>Нативный стиль (как обычный пост)</span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="creative-style"
                  checked={style === "direct"}
                  onChange={() => setStyle("direct")}
                />
                <span>Прямой продающий (жесткий оффер)</span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="creative-style"
                  checked={style === "clickbait"}
                  onChange={() => setStyle("clickbait")}
                />
                <span>Кликбейт / интрига</span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="creative-style"
                  checked={style === "history"}
                  onChange={() => setStyle("history")}
                />
                <span>История (Storytelling)</span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="creative-style"
                  checked={style === "useful"}
                  onChange={() => setStyle("useful")}
                />
                <span>Полезный пост + реклама</span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="creative-style"
                  checked={style === "expert"}
                  onChange={() => setStyle("expert")}
                />
                <span>Экспертный / аналитический</span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="creative-style"
                  checked={style === "humor"}
                  onChange={() => setStyle("humor")}
                />
                <span>Мемный / юмористический</span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="creative-style"
                  checked={style === "mini_landing"}
                  onChange={() => setStyle("mini_landing")}
                />
                <span>Мини-лендинг внутри поста</span>
              </label>
            </div>
          </div>

          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.85rem" }}>
            <p className="label" style={{ marginBottom: "0.45rem" }}>Цель креатива</p>
            <div style={{ display: "grid", gap: "0.5rem" }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="creative-goal"
                  checked={goal === "subscribers"}
                  onChange={() => setGoal("subscribers")}
                />
                <span>Подписчики — привлечь новых подписчиков в канал</span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="creative-goal"
                  checked={goal === "sales"}
                  onChange={() => setGoal("sales")}
                />
                <span>Продажи — продать товар или услугу</span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="creative-goal"
                  checked={goal === "brand"}
                  onChange={() => setGoal("brand")}
                />
                <span>Бренд / PR — повысить узнаваемость и интерес к бренду</span>
              </label>
            </div>
          </div>

          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.85rem" }}>
            <p className="label" style={{ marginBottom: "0.45rem" }}>Формат креатива</p>
            <div style={{ display: "grid", gap: "0.5rem" }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="format"
                  checked={imageMode === "generated"}
                  onChange={() => setImageMode("generated")}
                />
                <span>С картинкой (ИИ сгенерирует)</span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="format"
                  checked={imageMode === "from_post"}
                  onChange={() => setImageMode("from_post")}
                  disabled={!hasPostMedia}
                />
                <span>
                  С медиа с поста (картинка/гиф/видео)
                  {!hasPostMedia && channelInfo.posts.length > 0 && " (в постах нет медиа)"}
                </span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="format"
                  checked={imageMode === "none"}
                  onChange={() => setImageMode("none")}
                />
                <span>Только текст</span>
              </label>
            </div>
            {isLandingMode && imageMode === "from_post" && landingMediaPosts.length > 0 && (
              <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.45rem" }}>
                <p className="label" style={{ margin: 0 }}>Картинка с сайта (выбери одну)</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "0.6rem" }}>
                  {landingMediaPosts.map(({ index, post }, idx) => {
                    const checked = selectedLandingMediaIndex === index;
                    return (
                      <label
                        key={index}
                        style={{
                          border: checked ? "1px solid var(--accent)" : "1px solid var(--border)",
                          borderRadius: "var(--radius)",
                          padding: "0.45rem",
                          cursor: "pointer",
                          display: "grid",
                          gap: "0.35rem",
                          background: checked ? "rgba(88,166,255,0.08)" : "transparent",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setSelectedLandingMediaIndex((prev) => (prev === index ? null : index))}
                          />
                          <span style={{ fontSize: "0.9rem" }}>{`Картинка ${idx + 1}`}</span>
                        </div>
                        <img
                          src={`data:${post.mediaType || "image/jpeg"};base64,${post.photoBase64}`}
                          alt={`Картинка ${idx + 1}`}
                          style={{
                            width: "100%",
                            height: "110px",
                            objectFit: "cover",
                            borderRadius: "0.45rem",
                            border: "1px solid var(--border)",
                          }}
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          {!isLandingMode && (
            <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.85rem" }}>
              <p className="label" style={{ marginBottom: "0.45rem" }}>Дополнительно</p>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={attachSourcePostLink}
                  onChange={(e) => setAttachSourcePostLink(e.target.checked)}
                />
                <span>Добавлять в конец креатива ссылку на пост-источник</span>
              </label>
            </div>
          )}
        </div>
        <div className="flex">
          <button
            onClick={handleGenerate}
            disabled={
              loading ||
              topicsLoading ||
              (!isDirectPostMode && !isLandingMode && selectedTopics.length === 0) ||
              (isLandingMode && imageMode === "from_post" && !selectedLandingMediaIndex)
            }
          >
            {loading ? "Генерирую…" : "Сгенерировать креатив"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      {generated.length > 0 && (
        <section className="card">
          <h2>Результат ({generated.length})</h2>
          <div style={{ display: "grid", gap: "0.9rem" }}>
            {generated.map((item, idx) => (
              <div key={`${item.topicLabel}-${idx}`} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.75rem" }}>
                <p style={{ marginTop: 0, marginBottom: "0.5rem", color: "var(--muted)" }}>{item.topicLabel}</p>
                {item.imageBase64 && (
                  <div className="mb1">
                    {(item.imageMediaType || "").toLowerCase().startsWith("video/") ? (
                      <video
                        src={`data:${item.imageMediaType};base64,${item.imageBase64}`}
                        style={{ maxWidth: "100%", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}
                        controls
                        loop
                        muted
                        playsInline
                      />
                    ) : (
                      <img
                        src={`data:${item.imageMediaType || "image/png"};base64,${item.imageBase64}`}
                        alt="Креатив"
                        style={{ maxWidth: "100%", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}
                      />
                    )}
                  </div>
                )}
                <div
                  style={{
                    whiteSpace: "pre-wrap",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    padding: "0.7rem 0.8rem",
                    background: "var(--card)",
                    lineHeight: 1.45,
                  }}
                >
                  {item.text}
                </div>
              </div>
            ))}
          </div>
          <div className="flex mt1">
            <button onClick={() => onDone(generated)}>
              Дальше: редактирование и отправка
            </button>
          </div>
        </section>
      )}
    </>
  );
}
