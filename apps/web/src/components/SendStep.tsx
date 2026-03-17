import { useState, useEffect } from "react";
import { fetchTelegramChatIds } from "../api";
import type { DraftCreative } from "./CreativeStep";
import { RichTextEditor, getTelegramHtml } from "./RichTextEditor";

interface SendStepProps {
  creatives: DraftCreative[];
  activeCreativeIndex: number;
  onSelectCreative: (index: number) => void;
  onBack: () => void;
  onEdit: (instruction: string, currentText: string) => Promise<string>;
  onEditImage: (instruction: string, currentText: string) => Promise<void>;
  onReroll: () => Promise<void>;
  onSend: (
    to: string,
    text: string,
    imageBase64?: string | null,
    imageMediaType?: string | null,
    mediaItems?: Array<{ base64: string; mediaType: string }>
  ) => Promise<void>;
}

export function SendStep({
  creatives,
  activeCreativeIndex,
  onSelectCreative,
  onBack,
  onEdit,
  onEditImage,
  onReroll,
  onSend,
}: SendStepProps) {
  const PETR_CHAT_ID = "140349245";
  const LUMAN_CHAT_ID = "558234437";
  const current = creatives[activeCreativeIndex];
  const [editedText, setEditedText] = useState(current?.text || "");
  useEffect(() => setEditedText(current?.text || ""), [current?.text, activeCreativeIndex]);
  const [aiInstruction, setAiInstruction] = useState("");
  const [imageInstruction, setImageInstruction] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editImageLoading, setEditImageLoading] = useState(false);
  const [rerollLoading, setRerollLoading] = useState(false);
  const [to, setTo] = useState("");
  const [sendLoading, setSendLoading] = useState(false);
  const [sendProgress, setSendProgress] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [chatIdLoading, setChatIdLoading] = useState(false);
  const [chatIdResult, setChatIdResult] = useState<string | null>(null);

  const handleAiEdit = async () => {
    if (!aiInstruction.trim()) return;
    setError("");
    setEditLoading(true);
    try {
      const newText = await onEdit(aiInstruction.trim(), editedText);
      setEditedText(newText);
      setAiInstruction("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setEditLoading(false);
    }
  };

  const handleGetChatId = async () => {
    setError("");
    setChatIdResult(null);
    setChatIdLoading(true);
    try {
      const chats = await fetchTelegramChatIds();
      if (chats.length === 0) {
        setChatIdResult("Напишите боту /start в Telegram, затем нажмите снова «Узнать мой chat_id».");
        return;
      }
      // Берём последний chat_id из обновлений (тот, кто последним писал боту /start)
      const last = chats[chats.length - 1];
      setTo(String(last.chatId));
      setChatIdResult(
        `Последний chat_id из обновлений бота: ${last.chatId}. ` +
        `Подставлен в поле «Кому». ` +
        `Убедитесь, что это ваш chat_id (если недавно писали боту /start — это вы).`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setChatIdLoading(false);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSent(false);
    setSendProgress("");
    if (!to.trim()) {
      setError("Укажите получателя (chat_id или @channel)");
      return;
    }
    setSendLoading(true);
    try {
      for (let i = 0; i < creatives.length; i++) {
        const item = creatives[i];
        const textToSend = getTelegramHtml(i === activeCreativeIndex ? editedText : item.text);
        setSendProgress(`Отправляю ${i + 1} из ${creatives.length}…`);
        await onSend(
          to.trim(),
          textToSend,
          item.imageBase64 || null,
          item.imageMediaType || undefined,
          item.mediaItems
        );
      }
      setSendProgress(`Отправлено ${creatives.length} из ${creatives.length}.`);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка отправки");
    } finally {
      setSendLoading(false);
    }
  };

  return (
    <>
      <section className="card">
        <h2>Редактирование</h2>
        {creatives.length > 1 && (
          <div className="mb1">
            <p className="label" style={{ marginBottom: "0.5rem" }}>Креатив {activeCreativeIndex + 1} из {creatives.length}</p>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                className="secondary"
                onClick={() => onSelectCreative(Math.max(0, activeCreativeIndex - 1))}
                disabled={activeCreativeIndex <= 0}
              >
                ←
              </button>
              <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                {creatives.map((_, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className={idx === activeCreativeIndex ? "" : "secondary"}
                    onClick={() => onSelectCreative(idx)}
                    style={{
                      minWidth: 36,
                      padding: "0.35rem 0.5rem",
                      fontWeight: idx === activeCreativeIndex ? 600 : 400,
                    }}
                  >
                    {idx + 1}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="secondary"
                onClick={() => onSelectCreative(Math.min(creatives.length - 1, activeCreativeIndex + 1))}
                disabled={activeCreativeIndex >= creatives.length - 1}
              >
                →
              </button>
            </div>
          </div>
        )}
        <p className="label">Текст креатива (можно править, форматировать)</p>
        {((current?.mediaItems && current.mediaItems.length > 0) || current?.imageBase64) && (
          <div className="mb1">
            <p className="label">Текущее медиа</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {(current.mediaItems && current.mediaItems.length > 0
                ? current.mediaItems
                : current.imageBase64
                  ? [{ base64: current.imageBase64, mediaType: current.imageMediaType || "image/jpeg" }]
                  : []
              ).map((m, mi) => (
                <div key={mi} style={{ flex: "1 1 120px", maxWidth: 200 }}>
                  {(m.mediaType || "").toLowerCase().startsWith("video/") ? (
                    <video
                      src={`data:${m.mediaType};base64,${m.base64}`}
                      style={{ width: "100%", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}
                      controls
                      loop
                      muted
                      playsInline
                    />
                  ) : (
                    <img
                      src={`data:${m.mediaType || "image/jpeg"};base64,${m.base64}`}
                      alt={`Медиа ${mi + 1}`}
                      style={{ width: "100%", borderRadius: "var(--radius)", border: "1px solid var(--border)", objectFit: "cover" }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <RichTextEditor
          value={editedText}
          onChange={setEditedText}
          placeholder="Текст креатива…"
          minHeight={140}
        />
        <p className="label mt1">Или попросите ИИ изменить</p>
        <div className="flex" style={{ gap: "0.5rem", alignItems: "stretch" }}>
          <input
            type="text"
            placeholder="Например: сделай короче, добавь эмодзи…"
            value={aiInstruction}
            onChange={(e) => setAiInstruction(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAiEdit())}
            disabled={editLoading}
          />
          <button onClick={handleAiEdit} disabled={editLoading || !aiInstruction.trim()}>
            {editLoading ? "…" : "Применить"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={rerollLoading}
            onClick={async () => {
              setError("");
              setRerollLoading(true);
              try {
                await onReroll();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Ошибка");
              } finally {
                setRerollLoading(false);
              }
            }}
          >
            {rerollLoading ? "Переделываю…" : "Переделать креатив"}
          </button>
        </div>
        <p className="label mt1">Промпт для редактирования картинки</p>
        {current?.imageMode === "generated" && (
          <p style={{ color: "var(--muted)", fontSize: "0.85rem", margin: "0 0 0.5rem" }}>
            Для ИИ-картинок применяется полная перерисовка кадра по промпту (не элемент в угол).
          </p>
        )}
        <div className="flex" style={{ gap: "0.5rem", alignItems: "stretch" }}>
          <input
            type="text"
            placeholder="Например: добавь яркий CTA-элемент и акцент на скидке"
            value={imageInstruction}
            onChange={(e) => setImageInstruction(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), (async () => {
              if (!imageInstruction.trim()) return;
              if (!current?.imageBase64) return;
              if ((current.imageMediaType || "").toLowerCase().startsWith("video/")) return;
              setError("");
              setEditImageLoading(true);
              try {
                await onEditImage(imageInstruction.trim(), editedText);
                setImageInstruction("");
              } catch (err) {
                setError(err instanceof Error ? err.message : "Ошибка редактирования картинки");
              } finally {
                setEditImageLoading(false);
              }
            })())}
            disabled={editImageLoading || !current?.imageBase64 || (current.imageMediaType || "").toLowerCase().startsWith("video/")}
          />
          <button
            onClick={async () => {
              if (!imageInstruction.trim()) return;
              if (!current?.imageBase64) return;
              if ((current.imageMediaType || "").toLowerCase().startsWith("video/")) return;
              setError("");
              setEditImageLoading(true);
              try {
                await onEditImage(imageInstruction.trim(), editedText);
                setImageInstruction("");
              } catch (err) {
                setError(err instanceof Error ? err.message : "Ошибка редактирования картинки");
              } finally {
                setEditImageLoading(false);
              }
            }}
            disabled={
              editImageLoading ||
              !imageInstruction.trim() ||
              !current?.imageBase64 ||
              (current.imageMediaType || "").toLowerCase().startsWith("video/")
            }
          >
            {editImageLoading ? "Обновляю…" : "Применить к картинке"}
          </button>
        </div>
        {current?.imageBase64 && (current.imageMediaType || "").toLowerCase().startsWith("video/") && (
          <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: "0.5rem" }}>
            Редактирование по промпту доступно для изображений. Для видео пока можно заменить медиа через перегенерацию креатива.
          </p>
        )}
        {!current?.imageBase64 && (
          <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: "0.5rem" }}>
            У этого креатива нет медиа для редактирования.
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="card">
        <h2>Отправка в Telegram</h2>
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", margin: "0 0 0.5rem" }}>
          В личные чаты можно отправлять только по <strong>chat_id</strong> (число). @username в личку не подходит — будет «chat not found».
        </p>
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", margin: "0 0 0.5rem" }}>
          Напишите боту в Telegram команду <strong>/start</strong>, затем здесь, на сайте, нажмите кнопку <strong>«Узнать мой chat_id»</strong> — chat_id подставится в поле «Кому».
        </p>
        <p style={{ color: "var(--muted)", fontSize: "0.8rem", margin: "0 0 0.5rem" }}>
          Бот:{" "}
          <a href="https://t.me/DS_tg_creativeBot" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
            @DS_tg_creativeBot
          </a>
        </p>
        <p style={{ color: "var(--muted)", fontSize: "0.8rem", margin: "0 0 1rem" }}>
          <strong>Важно:</strong> показывается последний chat_id из обновлений бота (тот, кто последним писал /start). 
          Убедитесь, что это ваш chat_id. Если между вашим /start и нажатием кнопки кто-то ещё писал боту — будет показан его chat_id.
        </p>
        {sent ? (
          <p style={{ color: "var(--accent)" }}>
            Отправлены все креативы: {creatives.length}.
          </p>
        ) : (
          <form onSubmit={handleSend}>
            <div className="flex mb1" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
              <button type="button" className="secondary" onClick={handleGetChatId} disabled={chatIdLoading}>
                {chatIdLoading ? "Проверяю…" : "Узнать мой chat_id"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setTo(PETR_CHAT_ID);
                  setChatIdResult(`Подставлен chat_id Петра: ${PETR_CHAT_ID}`);
                }}
                disabled={sendLoading || chatIdLoading}
              >
                Отправить Петр
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setTo(LUMAN_CHAT_ID);
                  setChatIdResult(`Подставлен chat_id Люман: ${LUMAN_CHAT_ID}`);
                }}
                disabled={sendLoading || chatIdLoading}
              >
                Отправить Люман
              </button>
            </div>
            {chatIdResult && <p style={{ color: "var(--accent)", fontSize: "0.9rem", margin: "0 0 0.5rem" }}>{chatIdResult}</p>}
            <label className="label" htmlFor="send-to">
              Кому (chat_id или @channel для каналов)
            </label>
            <input
              id="send-to"
              type="text"
              placeholder="123456789"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              disabled={sendLoading}
            />
            <div className="flex mt1">
              <button type="submit" disabled={sendLoading}>
                {sendLoading ? "Отправляю…" : "Отправить"}
              </button>
              <button type="button" className="secondary" onClick={onBack}>
                Назад
              </button>
            </div>
            {sendProgress && (
              <p style={{ color: "var(--muted)", fontSize: "0.9rem", marginTop: "0.6rem" }}>
                {sendProgress}
              </p>
            )}
          </form>
        )}
      </section>
    </>
  );
}
