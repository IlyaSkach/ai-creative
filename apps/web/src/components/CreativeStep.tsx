import { useEffect, useState } from "react";
import type { ChannelInfo } from "../api";
import { analyzeChannelTopics, generateCreative } from "../api";

export type ImageMode = "none" | "generated" | "from_post";
export type GenerationMode = "single" | "per_topic";

export interface DraftCreative {
  topicLabel: string;
  topicPrompt?: string;
  selectedTopics: string[];
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

export function CreativeStep({ channelInfo, onDone }: CreativeStepProps) {
  const [imageMode, setImageMode] = useState<ImageMode>("generated");
  const [generationMode, setGenerationMode] = useState<GenerationMode>("single");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [topicsLoading, setTopicsLoading] = useState(false);
  const [topicsError, setTopicsError] = useState("");
  const [topicSummary, setTopicSummary] = useState("");
  const [bestThemesInsight, setBestThemesInsight] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [generated, setGenerated] = useState<DraftCreative[]>([]);

  const hasPostMedia = channelInfo.posts.some((p) => p.photoBase64);
  const postMediaCount = channelInfo.posts.filter((p) => p.photoBase64).length;

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
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
  }, [channelInfo]);

  const toggleTopic = (topic: string) => {
    setSelectedTopics((prev) =>
      prev.includes(topic) ? prev.filter((t) => t !== topic) : [...prev, topic]
    );
  };

  const buildCreative = async (topicPrompt: string | undefined, topicLabel: string, allSelected: string[]): Promise<DraftCreative> => {
    const withImage = imageMode === "generated";
    const result = await generateCreative(channelInfo, withImage, topicPrompt);

    if (imageMode === "generated") {
      return {
        topicLabel,
        topicPrompt,
        selectedTopics: allSelected,
        imageMode,
        text: result.text,
        imageBase64: result.imageBase64,
        imageMediaType: result.imageBase64 ? "image/png" : null,
        sourcePostIndex: result.sourcePostIndex ?? null,
      };
    }

    if (imageMode === "from_post") {
      const mediaBySource = pickMediaBySourcePostIndex(channelInfo, result.sourcePostIndex ?? null);
      const mediaByTopic = pickMediaByTopic(channelInfo, topicPrompt);
      const media = mediaBySource || mediaByTopic;
      return {
        topicLabel,
        topicPrompt,
        selectedTopics: allSelected,
        imageMode,
        text: result.text,
        imageBase64: media?.base64 || null,
        imageMediaType: media?.mediaType || null,
        sourcePostIndex: media?.index ?? result.sourcePostIndex ?? null,
      };
    }

    return {
      topicLabel,
      topicPrompt,
      selectedTopics: allSelected,
      imageMode,
      text: result.text,
      imageBase64: null,
      imageMediaType: null,
      sourcePostIndex: result.sourcePostIndex ?? null,
    };
  };

  const handleGenerate = async () => {
    setError("");
    setLoading(true);
    try {
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
        setError("Для части тем не нашлась картинка/гиф в постах. Выбери темы точнее или режим «С картинкой (ИИ)».");
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
          <a href={channelInfo.channelLink} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
            {channelInfo.channelLink}
          </a>
          {" · "}
          Последних постов: {channelInfo.posts.length}
          {postMediaCount > 0 && `, с картинкой/гиф: ${postMediaCount}`}
          {channelInfo.posts.length > 0 && " · креатив по постам с макс. охватом (просмотры + реакции)"}
        </p>
      </section>

      <section className="card">
        <h2>Креатив</h2>
        <div style={{ display: "grid", gap: "0.9rem" }}>
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
                  С картинкой/гиф с поста
                  {!hasPostMedia && channelInfo.posts.length > 0 && " (в постах нет фото/гиф)"}
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
          </div>
        </div>
        <div className="flex">
          <button onClick={handleGenerate} disabled={loading || topicsLoading || selectedTopics.length === 0}>
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
                <textarea readOnly value={item.text} style={{ minHeight: 100 }} />
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
