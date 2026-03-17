import { useEffect, useState } from "react";
import type { ChannelInfo } from "../api";
import type { AiProvider, CreativeGoal, CreativeStyle } from "../api";
import { analyzeChannelTopics, generateCreative } from "../api";

export type ImageMode = "none" | "generated" | "from_post";
export type GenerationMode = "single" | "per_topic";

export type EmojiAmount = "low" | "medium" | "high";
export type TargetGender = "male" | "female";
export type TargetAge = "children" | "teens" | "adults" | "elderly";

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
  /** Дополнительные медиа (при mediaCount > 1). Первое — в imageBase64. */
  mediaItems?: Array<{ base64: string; mediaType: string }>;
  sourcePostIndex: number | null;
  emojiAmount?: EmojiAmount;
  targetGender?: TargetGender[];
  targetAge?: TargetAge[];
  mediaCount?: number;
  aiProvider?: AiProvider;
}

interface CreativeStepProps {
  channelInfo: ChannelInfo;
  aiProvider: AiProvider;
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

function getPostMediaItems(post: { photoBase64?: string; mediaType?: string; mediaItems?: Array<{ base64: string; mediaType: string }> }): Array<{ base64: string; mediaType: string }> {
  if (post.mediaItems && post.mediaItems.length > 0) {
    return post.mediaItems;
  }
  if (post.photoBase64) {
    return [{ base64: post.photoBase64, mediaType: post.mediaType || "image/jpeg" }];
  }
  return [];
}

function pickMultipleMediaBySourcePostIndex(
  channelInfo: ChannelInfo,
  sourcePostIndex?: number | null,
  maxCount = 1
): Array<{ base64: string; mediaType: string; index: number }> {
  if (!sourcePostIndex || sourcePostIndex < 1) return [];
  const post = channelInfo.posts[sourcePostIndex - 1];
  const items = getPostMediaItems(post || {});
  return items.slice(0, maxCount).map((item) => ({ ...item, index: sourcePostIndex }));
}

function pickMediaBySourcePostIndex(
  channelInfo: ChannelInfo,
  sourcePostIndex?: number | null
): { base64: string; mediaType: string; index: number } | null {
  const multiple = pickMultipleMediaBySourcePostIndex(channelInfo, sourcePostIndex, 1);
  return multiple[0] ?? null;
}

function pickMediaByTopic(
  channelInfo: ChannelInfo,
  topic?: string
): { base64: string; mediaType: string; index: number } | null {
  const items = pickMultipleMediaByTopic(channelInfo, topic, 1);
  return items[0] ?? null;
}

function pickMultipleMediaByTopic(
  channelInfo: ChannelInfo,
  topic?: string,
  maxCount = 1
): Array<{ base64: string; mediaType: string; index: number }> {
  const ranked = rankPostsByTopic(channelInfo, topic);
  const result: Array<{ base64: string; mediaType: string; index: number }> = [];
  const seen = new Set<number>();
  for (const idx of ranked) {
    if (result.length >= maxCount) break;
    if (seen.has(idx)) continue;
    const post = channelInfo.posts[idx - 1];
    const items = getPostMediaItems(post || {});
    if (items.length > 0) {
      seen.add(idx);
      for (const item of items) {
        if (result.length >= maxCount) break;
        result.push({ ...item, index: idx });
      }
    }
  }
  return result;
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

export function CreativeStep({ channelInfo, aiProvider, onDone }: CreativeStepProps) {
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
  const [selectedLandingMediaIndices, setSelectedLandingMediaIndices] = useState<number[]>([]);
  const [selectedChannelMediaKeys, setSelectedChannelMediaKeys] = useState<string[]>([]);
  const [selectedLandingContacts, setSelectedLandingContacts] = useState<string[]>([]);
  const [generated, setGenerated] = useState<DraftCreative[]>([]);
  const [emojiAmount, setEmojiAmount] = useState<EmojiAmount>("medium");
  const [targetGender, setTargetGender] = useState<TargetGender[]>([]);
  const [targetAge, setTargetAge] = useState<TargetAge[]>([]);
  const [mediaCount] = useState(5);
  const [creativesCount, setCreativesCount] = useState(1);

  const hasPostMedia = channelInfo.posts.some(
    (p) => p.photoBase64 || (p.mediaItems && p.mediaItems.length > 0)
  );
  const postMediaCount = channelInfo.posts.filter(
    (p) => p.photoBase64 || (p.mediaItems && p.mediaItems.length > 0)
  ).length;
  const landingMediaPosts = channelInfo.posts
    .map((p, idx) => ({ post: p, index: idx + 1 }))
    .filter((x) => Boolean(x.post.photoBase64));
  const channelMediaItems = (() => {
    const out: Array<{ key: string; postIndex: number; mediaIndex: number; base64: string; mediaType: string }> = [];
    channelInfo.posts.forEach((p, postIdx) => {
      const items = getPostMediaItems(p);
      items.forEach((item, mediaIdx) => {
        out.push({
          key: `${postIdx + 1}-${mediaIdx}`,
          postIndex: postIdx + 1,
          mediaIndex: mediaIdx,
          base64: item.base64,
          mediaType: item.mediaType,
        });
      });
    });
    return out;
  })();
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
        const result = await analyzeChannelTopics(channelInfo, aiProvider);
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
      setSelectedLandingMediaIndices([]);
      return;
    }
    setSelectedLandingMediaIndices((prev) => {
      const valid = prev.filter((i) => landingMediaPosts.some((x) => x.index === i));
      return valid.length > 0 ? valid : [landingMediaPosts[0].index];
    });
  }, [isLandingMode, landingMediaPosts]);

  useEffect(() => {
    if (!isLandingMode) return;
    setSelectedLandingContacts(landingContactsList);
  }, [isLandingMode, channelInfo.channelLink]);

  useEffect(() => {
    if (isLandingMode) return;
    const items = channelInfo.posts.flatMap((p, postIdx) =>
      getPostMediaItems(p).map((_, mediaIdx) => ({ key: `${postIdx + 1}-${mediaIdx}` }))
    );
    if (items.length === 0) {
      setSelectedChannelMediaKeys([]);
      return;
    }
    setSelectedChannelMediaKeys((prev) => {
      const keys = items.map((i) => i.key);
      const valid = prev.filter((k) => keys.includes(k));
      if (valid.length > 0) return valid;
      return isDirectPostMode ? keys : keys.slice(0, Math.min(3, keys.length));
    });
  }, [isLandingMode, isDirectPostMode, channelInfo.channelLink, channelInfo.posts.length]);

  const toggleTopic = (topic: string) => {
    setSelectedTopics((prev) =>
      prev.includes(topic) ? prev.filter((t) => t !== topic) : [...prev, topic]
    );
  };

  const toggleGender = (g: TargetGender) => {
    setTargetGender((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  };

  const toggleAge = (a: TargetAge) => {
    setTargetAge((prev) => (prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]));
  };

  const toggleLandingMedia = (index: number) => {
    setSelectedLandingMediaIndices((prev) =>
      prev.includes(index) ? prev.filter((x) => x !== index) : [...prev, index]
    );
  };

  const toggleChannelMedia = (key: string) => {
    setSelectedChannelMediaKeys((prev) =>
      prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key]
    );
  };

  const buildCreative = async (
    topicPrompt: string | undefined,
    topicLabel: string,
    allSelected: string[],
    textOnly = false,
    reuseMediaFrom?: DraftCreative
  ): Promise<DraftCreative> => {
    const withImage = imageMode === "generated" && !textOnly;
    const forcedSourcePostIndex = isDirectPostMode
      ? 1
      : (isLandingMode && imageMode === "from_post" && selectedLandingMediaIndices.length > 0
          ? selectedLandingMediaIndices[0]
          : undefined);
    const effectiveMediaCount =
      imageMode === "from_post"
        ? (isDirectPostMode ? 10 : isLandingMode ? 1 : Math.min(mediaCount, 5))
        : 1;
    const preferredMedia = isDirectPostMode
      ? pickMediaBySourcePostIndex(channelInfo, 1)
      : (isLandingMode && imageMode === "from_post" && selectedLandingMediaIndices.length > 0
          ? pickMediaBySourcePostIndex(channelInfo, selectedLandingMediaIndices[0])
          : pickMediaByTopic(channelInfo, topicPrompt));
    const result = await generateCreative(
      channelInfo,
      withImage,
      topicPrompt,
      forcedSourcePostIndex ?? preferredMedia?.index,
      imageMode,
      style,
      goal,
      isLandingMode ? selectedLandingContacts : undefined,
      emojiAmount,
      targetGender,
      targetAge,
      textOnly,
      aiProvider
    );

    let draft: DraftCreative;

    if (imageMode === "generated") {
      const base = reuseMediaFrom ?? null;
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
        imageBase64: base?.imageBase64 ?? result.imageBase64,
        imageMediaType: base?.imageMediaType ?? result.imageMediaType ?? (result.imageBase64 ? "image/png" : null),
        mediaItems: base?.mediaItems,
        sourcePostIndex: base?.sourcePostIndex ?? result.sourcePostIndex ?? null,
        emojiAmount,
        targetGender,
        targetAge,
        mediaCount,
        aiProvider,
      };
    } else if (imageMode === "from_post") {
      let mediaItems: Array<{ base64: string; mediaType: string }> = [];
      let firstBase64: string | null = null;
      let firstMediaType: string | null = null;
      let firstIndex: number | null = null;

      if (reuseMediaFrom?.imageBase64 || reuseMediaFrom?.mediaItems) {
        firstBase64 = reuseMediaFrom.imageBase64;
        firstMediaType = reuseMediaFrom.imageMediaType;
        firstIndex = reuseMediaFrom.sourcePostIndex;
        mediaItems = reuseMediaFrom.mediaItems ?? (firstBase64 ? [{ base64: firstBase64, mediaType: firstMediaType || "image/jpeg" }] : []);
      } else if (isDirectPostMode) {
        const collected =
          selectedChannelMediaKeys.length > 0
            ? selectedChannelMediaKeys
                .map((key) => channelMediaItems.find((m) => m.key === key))
                .filter(Boolean) as Array<{ key: string; postIndex: number; mediaIndex: number; base64: string; mediaType: string }>
            : pickMultipleMediaBySourcePostIndex(channelInfo, 1, effectiveMediaCount).map((m) => ({
                key: "",
                postIndex: m.index,
                mediaIndex: 0,
                base64: m.base64,
                mediaType: m.mediaType,
              }));
        if (collected.length > 0) {
          const first = collected[0];
          firstBase64 = first.base64;
          firstMediaType = first.mediaType;
          firstIndex = first.postIndex;
          mediaItems = collected.map((m) => ({ base64: m.base64, mediaType: m.mediaType }));
        }
      } else if (isLandingMode) {
        const indices = selectedLandingMediaIndices.length > 0 ? selectedLandingMediaIndices : [forcedSourcePostIndex ?? 1];
        const collected: Array<{ base64: string; mediaType: string }> = [];
        for (const idx of indices) {
          const m = pickMultipleMediaBySourcePostIndex(channelInfo, idx, 10);
          collected.push(...m.map((x) => ({ base64: x.base64, mediaType: x.mediaType })));
        }
        if (collected.length > 0) {
          firstBase64 = collected[0].base64;
          firstMediaType = collected[0].mediaType;
          firstIndex = indices[0];
          mediaItems = collected;
        }
      } else if (selectedChannelMediaKeys.length > 0) {
        const collected = selectedChannelMediaKeys
          .map((key) => channelMediaItems.find((m) => m.key === key))
          .filter(Boolean) as Array<{ key: string; postIndex: number; mediaIndex: number; base64: string; mediaType: string }>;
        if (collected.length > 0) {
          firstBase64 = collected[0].base64;
          firstMediaType = collected[0].mediaType;
          firstIndex = collected[0].postIndex;
          mediaItems = collected.map((m) => ({ base64: m.base64, mediaType: m.mediaType }));
        }
      } else {
        const multiple = pickMultipleMediaByTopic(channelInfo, topicPrompt, effectiveMediaCount);
        if (multiple.length > 0) {
          firstBase64 = multiple[0].base64;
          firstMediaType = multiple[0].mediaType;
          firstIndex = multiple[0].index;
          mediaItems = multiple.map((m) => ({ base64: m.base64, mediaType: m.mediaType }));
        }
      }

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
        imageBase64: firstBase64,
        imageMediaType: firstMediaType,
        mediaItems: mediaItems.length > 1 ? mediaItems : undefined,
        sourcePostIndex: firstIndex ?? result.sourcePostIndex ?? null,
        emojiAmount,
        targetGender,
        targetAge,
        mediaCount,
        aiProvider,
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
        emojiAmount,
        targetGender,
        targetAge,
        mediaCount,
        aiProvider,
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
      const count = Math.max(1, Math.min(4, creativesCount));
      if (isLandingMode) {
        const landingSelected = ["Лендинг"];
        const first = await buildCreative(undefined, `Креатив по лендингу 1`, landingSelected);
        if (imageMode === "from_post" && !first.imageBase64 && count > 0) {
          setError("Не удалось взять картинку с сайта. Выбери другую картинку или режим «С картинкой (ИИ)».");
        }
        const rest: DraftCreative[] = [];
        for (let i = 2; i <= count; i++) {
          rest.push(await buildCreative(undefined, `Креатив по лендингу ${i}`, landingSelected, true, first));
        }
        setGenerated([first, ...rest]);
        return;
      }
      if (isDirectPostMode) {
        const directSelected = ["Пост по ссылке"];
        const first = await buildCreative(undefined, "Креатив по выбранному посту 1", directSelected);
        if (imageMode === "from_post" && !first.imageBase64) {
          setError("В выбранном посте нет медиа. Выбери режим «С картинкой (ИИ)» или «Только текст».");
        }
        const rest: DraftCreative[] = [];
        for (let i = 2; i <= count; i++) {
          rest.push(await buildCreative(undefined, `Креатив по выбранному посту ${i}`, directSelected, true, first));
        }
        setGenerated([first, ...rest]);
        return;
      }
      const selected = selectedTopics.length > 0 ? selectedTopics : (topics.length > 0 ? [topics[0]] : ["Общая тема канала"]);
      let nextGenerated: DraftCreative[] = [];

      if (generationMode === "single") {
        const topicPrompt = selected.join(", ");
        const first = await buildCreative(topicPrompt, "Креатив 1 по выбранным темам", selected);
        const rest: DraftCreative[] = [];
        for (let i = 2; i <= count; i++) {
          rest.push(await buildCreative(topicPrompt, `Креатив ${i} по выбранным темам`, selected, true, first));
        }
        nextGenerated = [first, ...rest];
      } else {
        for (const topic of selected) {
          const draft = await buildCreative(topic, `Креатив по теме: ${topic}`, selected);
          nextGenerated.push(draft);
        }
      }

      if (imageMode === "from_post" && nextGenerated.some((x) => !x.imageBase64 && !x.mediaItems?.length)) {
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
            <p className="label" style={{ marginBottom: "0.45rem" }}>Количество смайликов</p>
            <div style={{ display: "grid", gap: "0.5rem" }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="emoji-amount"
                  checked={emojiAmount === "low"}
                  onChange={() => setEmojiAmount("low")}
                />
                <span>Мало (0–2 эмодзи)</span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="emoji-amount"
                  checked={emojiAmount === "medium"}
                  onChange={() => setEmojiAmount("medium")}
                />
                <span>Средне (3–6 эмодзи)</span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="emoji-amount"
                  checked={emojiAmount === "high"}
                  onChange={() => setEmojiAmount("high")}
                />
                <span>Много (7–12 эмодзи)</span>
              </label>
            </div>
          </div>

          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.85rem" }}>
            <p className="label" style={{ marginBottom: "0.45rem" }}>Пол аудитории</p>
            <p style={{ color: "var(--muted)", margin: "0 0 0.5rem", fontSize: "0.9rem" }}>
              Если ничего не выбрано — креатив на всех
            </p>
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "0.45rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={targetGender.includes("male")}
                  onChange={() => toggleGender("male")}
                />
                <span>Мужская</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.45rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={targetGender.includes("female")}
                  onChange={() => toggleGender("female")}
                />
                <span>Женская</span>
              </label>
            </div>
          </div>

          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.85rem" }}>
            <p className="label" style={{ marginBottom: "0.45rem" }}>Возраст аудитории</p>
            <p style={{ color: "var(--muted)", margin: "0 0 0.5rem", fontSize: "0.9rem" }}>
              Если ничего не выбрано — креатив на всех
            </p>
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "0.45rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={targetAge.includes("children")}
                  onChange={() => toggleAge("children")}
                />
                <span>Дети</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.45rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={targetAge.includes("teens")}
                  onChange={() => toggleAge("teens")}
                />
                <span>Подростки</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.45rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={targetAge.includes("adults")}
                  onChange={() => toggleAge("adults")}
                />
                <span>Взрослые</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.45rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={targetAge.includes("elderly")}
                  onChange={() => toggleAge("elderly")}
                />
                <span>Пожилые</span>
              </label>
            </div>
          </div>

          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.85rem" }}>
            <p className="label" style={{ marginBottom: "0.45rem" }}>Количество креативов</p>
            <p style={{ color: "var(--muted)", margin: "0 0 0.5rem", fontSize: "0.9rem" }}>
              Сгенерирует несколько вариантов текста, медиа общие
            </p>
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              {[1, 2, 3, 4].map((n) => (
                <label key={n} style={{ display: "flex", alignItems: "center", gap: "0.45rem", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="creatives-count"
                    checked={creativesCount === n}
                    onChange={() => setCreativesCount(n)}
                  />
                  <span>{n}</span>
                </label>
              ))}
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
            {!isDirectPostMode && !isLandingMode && imageMode === "from_post" && channelMediaItems.length > 0 && (
              <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.45rem" }}>
                <p className="label" style={{ margin: 0 }}>Медиа с постов (выбери нужные)</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: "0.6rem" }}>
                  {channelMediaItems.map((item, idx) => {
                    const checked = selectedChannelMediaKeys.includes(item.key);
                    return (
                      <label
                        key={item.key}
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
                            onChange={() => toggleChannelMedia(item.key)}
                          />
                          <span style={{ fontSize: "0.85rem" }}>{idx + 1}</span>
                        </div>
                        {(item.mediaType || "").toLowerCase().startsWith("video/") ? (
                          <video
                            src={`data:${item.mediaType};base64,${item.base64}`}
                            style={{ width: "100%", height: 90, objectFit: "cover", borderRadius: "0.35rem", border: "1px solid var(--border)" }}
                            muted
                            playsInline
                            preload="metadata"
                          />
                        ) : (
                          <img
                            src={`data:${item.mediaType || "image/jpeg"};base64,${item.base64}`}
                            alt={`Медиа ${idx + 1}`}
                            style={{ width: "100%", height: 90, objectFit: "cover", borderRadius: "0.35rem", border: "1px solid var(--border)" }}
                          />
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            {isDirectPostMode && imageMode === "from_post" && channelMediaItems.length > 0 && (
              <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.45rem" }}>
                <p className="label" style={{ margin: 0 }}>Медиа из поста (выбери нужные)</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: "0.6rem" }}>
                  {channelMediaItems.map((item, idx) => {
                    const checked = selectedChannelMediaKeys.includes(item.key);
                    return (
                      <label
                        key={item.key}
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
                            onChange={() => toggleChannelMedia(item.key)}
                          />
                          <span style={{ fontSize: "0.85rem" }}>{idx + 1}</span>
                        </div>
                        {(item.mediaType || "").toLowerCase().startsWith("video/") ? (
                          <video
                            src={`data:${item.mediaType};base64,${item.base64}`}
                            style={{ width: "100%", height: 90, objectFit: "cover", borderRadius: "0.35rem", border: "1px solid var(--border)" }}
                            muted
                            playsInline
                            preload="metadata"
                          />
                        ) : (
                          <img
                            src={`data:${item.mediaType || "image/jpeg"};base64,${item.base64}`}
                            alt={`Медиа ${idx + 1}`}
                            style={{ width: "100%", height: 90, objectFit: "cover", borderRadius: "0.35rem", border: "1px solid var(--border)" }}
                          />
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            {isLandingMode && imageMode === "from_post" && landingMediaPosts.length > 0 && (
              <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.45rem" }}>
                <p className="label" style={{ margin: 0 }}>Картинки с сайта (выбери нужные)</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: "0.6rem" }}>
                  {landingMediaPosts.map(({ index, post }, idx) => {
                    const checked = selectedLandingMediaIndices.includes(index);
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
                            onChange={() => toggleLandingMedia(index)}
                          />
                          <span style={{ fontSize: "0.85rem" }}>{idx + 1}</span>
                        </div>
                        <img
                          src={`data:${post.mediaType || "image/jpeg"};base64,${post.photoBase64}`}
                          alt={`Картинка ${idx + 1}`}
                          style={{
                            width: "100%",
                            height: 90,
                            objectFit: "cover",
                            borderRadius: "0.35rem",
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
              (isLandingMode && imageMode === "from_post" && selectedLandingMediaIndices.length === 0)
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
                {(item.imageBase64 || (item.mediaItems && item.mediaItems.length > 0)) && (
                  <div className="mb1" style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                    {(item.mediaItems && item.mediaItems.length > 1
                      ? item.mediaItems
                      : item.imageBase64
                        ? [{ base64: item.imageBase64, mediaType: item.imageMediaType || "image/png" }]
                        : []
                    ).map((m, mi) => (
                      <div key={mi} style={{ flex: "1 1 120px", minWidth: 0 }}>
                        {(m.mediaType || "").toLowerCase().startsWith("video/") ? (
                          <video
                            src={`data:${m.mediaType};base64,${m.base64}`}
                            style={{ width: "100%", maxWidth: 200, borderRadius: "var(--radius)", border: "1px solid var(--border)" }}
                            controls
                            loop
                            muted
                            playsInline
                          />
                        ) : (
                          <img
                            src={`data:${m.mediaType || "image/jpeg"};base64,${m.base64}`}
                            alt={`Медиа ${mi + 1}`}
                            style={{ width: "100%", maxWidth: 200, borderRadius: "var(--radius)", border: "1px solid var(--border)", objectFit: "cover" }}
                          />
                        )}
                      </div>
                    ))}
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
