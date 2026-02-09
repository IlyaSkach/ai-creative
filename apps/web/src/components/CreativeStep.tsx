import { useState } from "react";
import type { ChannelInfo } from "../api";
import { generateCreative } from "../api";

interface CreativeStepProps {
  channelInfo: ChannelInfo;
  onDone: (text: string, imageBase64: string | null) => void;
}

type ImageMode = "none" | "generated" | "from_post";

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

export function CreativeStep({ channelInfo, onDone }: CreativeStepProps) {
  const [imageMode, setImageMode] = useState<ImageMode>("generated");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageFromPost, setImageFromPost] = useState(false);
  const [imageMediaType, setImageMediaType] = useState("image/png");

  const hasPostMedia = channelInfo.posts.some((p) => p.photoBase64);
  const postMediaCount = channelInfo.posts.filter((p) => p.photoBase64).length;

  const handleGenerate = async () => {
    setError("");
    setImageError(null);
    setLoading(true);
    try {
      const withImage = imageMode === "generated";
      const result = await generateCreative(channelInfo, withImage);
      setText(result.text);
      if (imageMode === "generated") {
        setImageBase64(result.imageBase64);
        setImageError(result.imageError || null);
      } else if (imageMode === "from_post") {
        const postMedia = getFirstPostMedia(channelInfo);
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
    onDone(text, imageBase64);
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
        <div className="flex mb1" style={{ flexDirection: "column", gap: "0.5rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
            <input
              type="radio"
              name="format"
              checked={imageMode === "generated"}
              onChange={() => setImageMode("generated")}
            />
            С картинкой (ИИ сгенерирует)
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
            <input
              type="radio"
              name="format"
              checked={imageMode === "from_post"}
              onChange={() => setImageMode("from_post")}
              disabled={!hasPostMedia}
            />
            С картинкой/гиф с поста
            {!hasPostMedia && channelInfo.posts.length > 0 && " (в постах нет фото/гиф)"}
            {!hasPostMedia && channelInfo.posts.length === 0 && " (загрузите посты — сессия Telegram)"}
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
            <input
              type="radio"
              name="format"
              checked={imageMode === "none"}
              onChange={() => setImageMode("none")}
            />
            Только текст
          </label>
        </div>
        <div className="flex">
          <button onClick={handleGenerate} disabled={loading}>
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
              <img
                src={`data:${imageFromPost ? imageMediaType : "image/png"};base64,${imageBase64}`}
                alt="Креатив"
                style={{ maxWidth: "100%", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}
              />
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
