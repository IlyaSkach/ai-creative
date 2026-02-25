import { useEffect, useState } from "react";
import type { ChannelInfo } from "../api";
import { analyzeChannelTopics, generateCreative } from "../api";

interface CreativeStepProps {
  channelInfo: ChannelInfo;
  onDone: (text: string, imageBase64: string | null, imageMediaType?: string | null) => void;
}

type ImageMode = "none" | "generated" | "from_post";
const ALL_TOPICS = "__all_topics__";

function engagementScore(p: { views?: number; reactionsCount?: number }): number {
  return (p.views ?? 0) + (p.reactionsCount ?? 0) * 2;
}

function getFirstPostMedia(channelInfo: ChannelInfo): { base64: string; mediaType: string } | null {
  const withMedia = channelInfo.posts.filter((p) => p.photoBase64);
  if (withMedia.length === 0) return null;
  const best = withMedia.sort((a, b) => engagementScore(b) - engagementScore(a))[0];
  if (!best?.photoBase64) return null;
  return { base64: best.photoBase64, mediaType: best.mediaType || "image/jpeg" };
}

function pickMediaByTopic(
  channelInfo: ChannelInfo,
  selectedTopic: string
): { base64: string; mediaType: string } | null {
  const withMedia = channelInfo.posts.filter((p) => p.photoBase64);
  if (withMedia.length === 0) return null;

  // Для режима ссылки на конкретный пост всегда берем медиа именно из этого поста.
  if (channelInfo.directPostMode && withMedia[0]?.photoBase64) {
    return {
      base64: withMedia[0].photoBase64,
      mediaType: withMedia[0].mediaType || "image/jpeg",
    };
  }

  if (selectedTopic && selectedTopic !== ALL_TOPICS) {
    const keywords = selectedTopic
      .toLowerCase()
      .split(/[^a-zA-Zа-яА-Я0-9]+/u)
      .map((w) => w.trim())
      .filter((w) => w.length >= 4);

    if (keywords.length > 0) {
      const matched = withMedia.filter((post) => {
        const text = (post.text || "").toLowerCase();
        return keywords.some((k) => text.includes(k));
      });
      if (matched.length > 0) {
        const bestMatched = matched.sort((a, b) => engagementScore(b) - engagementScore(a))[0];
        if (bestMatched?.photoBase64) {
          return {
            base64: bestMatched.photoBase64,
            mediaType: bestMatched.mediaType || "image/jpeg",
          };
        }
      }
    }
  }

  return getFirstPostMedia(channelInfo);
}

function pickMediaBySourcePostIndex(
  channelInfo: ChannelInfo,
  sourcePostIndex?: number | null
): { base64: string; mediaType: string } | null {
  if (!sourcePostIndex || sourcePostIndex < 1) return null;
  const post = channelInfo.posts[sourcePostIndex - 1];
  if (!post?.photoBase64) return null;
  return {
    base64: post.photoBase64,
    mediaType: post.mediaType || "image/jpeg",
  };
}

export function CreativeStep({ channelInfo, onDone }: CreativeStepProps) {
  const [imageMode, setImageMode] = useState<ImageMode>("generated");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageFromPost, setImageFromPost] = useState(false);
  const [imageMediaType, setImageMediaType] = useState("image/png");
  const [topicsLoading, setTopicsLoading] = useState(false);
  const [topicsError, setTopicsError] = useState("");
  const [topicSummary, setTopicSummary] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [selectedTopic, setSelectedTopic] = useState("");

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
        setTopics(nextTopics);
        if (nextTopics.length > 1) {
          setSelectedTopic(ALL_TOPICS);
        } else if (nextTopics.length > 0) {
          setSelectedTopic(nextTopics[0]);
        } else {
          setSelectedTopic("");
        }
      } catch (e) {
        if (cancelled) return;
        setTopicsError(e instanceof Error ? e.message : "Не удалось проанализировать темы канала");
        setTopics(["Общая тема канала"]);
        setSelectedTopic("Общая тема канала");
      } finally {
        if (!cancelled) setTopicsLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [channelInfo]);

  const handleGenerate = async () => {
    setError("");
    setImageError(null);
    setLoading(true);
    try {
      const withImage = imageMode === "generated";
      const topicForPrompt = selectedTopic === ALL_TOPICS ? undefined : (selectedTopic || undefined);
      const result = await generateCreative(channelInfo, withImage, topicForPrompt);
      setText(result.text);
      if (imageMode === "generated") {
        setImageBase64(result.imageBase64);
        setImageError(result.imageError || null);
      } else if (imageMode === "from_post") {
        const mediaBySource = pickMediaBySourcePostIndex(channelInfo, result.sourcePostIndex);
        const postMedia = mediaBySource || pickMediaByTopic(channelInfo, selectedTopic);
        if (postMedia) {
          setImageBase64(postMedia.base64);
          setImageMediaType(postMedia.mediaType);
          setImageFromPost(true);
          setImageError(null);
        } else {
          setImageFromPost(false);
          setImageBase64(null);
          setImageError("В загруженных постах нет картинок или гифок. Выберите «С картинкой» или «Только текст».");
        }
      } else {
        setImageBase64(null);
        setImageFromPost(false);
        setImageError(null);
      }
      if (imageMode === "generated") {
        setImageFromPost(false);
        setImageMediaType("image/png");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка генерации");
    } finally {
      setLoading(false);
    }
  };

  const handleNext = () => {
    onDone(text, imageBase64, imageBase64 ? imageMediaType : null);
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
              <span style={{ color: "var(--muted)" }}>{channelInfo.description.slice(0, 200)}{channelInfo.description.length > 200 ? "…" : ""}</span>
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
            <p className="label" style={{ marginBottom: "0.45rem" }}>Темы канала (анализ ИИ)</p>
            {topicsLoading ? (
              <p style={{ color: "var(--muted)", margin: 0 }}>Анализирую темы постов…</p>
            ) : (
              <>
                {topicsError && <p className="error">{topicsError}</p>}
                {topicSummary && (
                  <p style={{ color: "var(--muted)", marginTop: 0, marginBottom: "0.75rem" }}>{topicSummary}</p>
                )}
                {topics.length > 1 && (
                  <label style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer", marginBottom: "0.5rem" }}>
                    <input
                      type="radio"
                      name="topic"
                      checked={selectedTopic === ALL_TOPICS}
                      onChange={() => setSelectedTopic(ALL_TOPICS)}
                    />
                    <span>Сделать креатив по всем затронутым темам</span>
                  </label>
                )}
                {topics.length > 0 && (
                  <div style={{ display: "grid", gap: "0.45rem" }}>
                    {topics.map((topic) => (
                      <label key={topic} style={{ display: "flex", alignItems: "flex-start", gap: "0.55rem", cursor: "pointer" }}>
                        <input
                          type="radio"
                          name="topic"
                          checked={selectedTopic === topic}
                          onChange={() => setSelectedTopic(topic)}
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
                  {!hasPostMedia && channelInfo.posts.length === 0 && " (загрузите посты — сессия Telegram)"}
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
          <button onClick={handleGenerate} disabled={loading || topicsLoading}>
            {loading ? "Генерирую…" : "Сгенерировать креатив"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      {text && (
        <section className="card">
          <h2>Результат</h2>
          {imageError && <p className="error mb1">Картинка: {imageError}</p>}
          {imageBase64 && (
            <div className="mb1">
              {(imageMediaType || "").toLowerCase().startsWith("video/") ? (
                <video
                  src={`data:${imageMediaType};base64,${imageBase64}`}
                  style={{ maxWidth: "100%", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}
                  controls
                  loop
                  muted
                  playsInline
                />
              ) : (
                <img
                  src={`data:${imageFromPost ? imageMediaType : "image/png"};base64,${imageBase64}`}
                  alt="Креатив"
                  style={{ maxWidth: "100%", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}
                />
              )}
            </div>
          )}
          <textarea
            readOnly
            value={text}
            style={{ minHeight: 100 }}
          />
          <div className="flex mt1">
            <button onClick={handleNext}>
              Дальше: редактирование и отправка
            </button>
          </div>
        </section>
      )}
    </>
  );
}
