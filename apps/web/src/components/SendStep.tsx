import { useState, useEffect, useRef } from "react";
import { fetchTelegramChatIds } from "../api";
import type { DraftCreative } from "./CreativeStep";

interface SendStepProps {
  creatives: DraftCreative[];
  activeCreativeIndex: number;
  onSelectCreative: (index: number) => void;
  onBack: () => void;
  onEdit: (instruction: string, currentText: string) => Promise<string>;
  onReroll: () => Promise<void>;
  onSend: (to: string, text: string, imageBase64?: string | null, imageMediaType?: string | null) => Promise<void>;
}

export function SendStep({
  creatives,
  activeCreativeIndex,
  onSelectCreative,
  onBack,
  onEdit,
  onReroll,
  onSend,
}: SendStepProps) {
  const PETR_CHAT_ID = "140349245";
  const current = creatives[activeCreativeIndex];
  const [editedText, setEditedText] = useState(current?.text || "");
  useEffect(() => setEditedText(current?.text || ""), [current?.text, activeCreativeIndex]);
  const [aiInstruction, setAiInstruction] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [rerollLoading, setRerollLoading] = useState(false);
  const [to, setTo] = useState("");
  const [sendLoading, setSendLoading] = useState(false);
  const [sendProgress, setSendProgress] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [chatIdLoading, setChatIdLoading] = useState(false);
  const [chatIdResult, setChatIdResult] = useState<string | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textAreaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editedText, activeCreativeIndex]);

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
        const textToSend = i === activeCreativeIndex ? editedText : item.text;
        setSendProgress(`Отправляю ${i + 1} из ${creatives.length}…`);
        await onSend(to.trim(), textToSend, item.imageBase64 || null, item.imageMediaType || undefined);
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
            <label className="label" htmlFor="creative-select">Какой креатив редактируем</label>
            <select
              id="creative-select"
              value={String(activeCreativeIndex)}
              onChange={(e) => onSelectCreative(Number(e.target.value))}
            >
              {creatives.map((c, idx) => (
                <option key={`${c.topicLabel}-${idx}`} value={String(idx)}>
                  {idx + 1}. {c.topicLabel}
                </option>
              ))}
            </select>
          </div>
        )}
        <p className="label">Текст креатива (можно править вручную)</p>
        <textarea
          ref={textAreaRef}
          value={editedText}
          onChange={(e) => setEditedText(e.target.value)}
          placeholder="Текст креатива…"
          style={{ overflow: "hidden", resize: "none" }}
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
