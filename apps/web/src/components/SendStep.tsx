import { useState, useEffect } from "react";
import { fetchTelegramChatIds } from "../api";

interface SendStepProps {
  text: string;
  imageBase64: string | null;
  onBack: () => void;
  onEdit: (instruction: string) => Promise<string>;
  onSend: (to: string, text: string, imageBase64?: string | null) => Promise<void>;
}

export function SendStep({ text, imageBase64, onBack, onEdit, onSend }: SendStepProps) {
  const [editedText, setEditedText] = useState(text);
  useEffect(() => setEditedText(text), [text]);
  const [aiInstruction, setAiInstruction] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [to, setTo] = useState("");
  const [sendLoading, setSendLoading] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [chatIdLoading, setChatIdLoading] = useState(false);
  const [chatIdResult, setChatIdResult] = useState<string | null>(null);

  const handleAiEdit = async () => {
    if (!aiInstruction.trim()) return;
    setError("");
    setEditLoading(true);
    try {
      const newText = await onEdit(aiInstruction.trim());
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
      const last = chats[chats.length - 1];
      setTo(String(last.chatId));
      setChatIdResult(`Ваш chat_id: ${last.chatId}. Подставлен в поле «Кому».`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setChatIdLoading(false);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!to.trim()) {
      setError("Укажите получателя (chat_id или @channel)");
      return;
    }
    setSendLoading(true);
    try {
      await onSend(to.trim(), editedText, imageBase64);
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
        <p className="label">Текст креатива (можно править вручную)</p>
        <textarea
          value={editedText}
          onChange={(e) => setEditedText(e.target.value)}
          placeholder="Текст креатива…"
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
        <p style={{ color: "var(--muted)", fontSize: "0.8rem", margin: "0 0 1rem" }}>
          Бот:{" "}
          <a href="https://t.me/DS_tg_creativeBot" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
            @DS_tg_creativeBot
          </a>
        </p>
        {sent ? (
          <p style={{ color: "var(--accent)" }}>Сообщение отправлено.</p>
        ) : (
          <form onSubmit={handleSend}>
            <div className="flex mb1" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
              <button type="button" className="secondary" onClick={handleGetChatId} disabled={chatIdLoading}>
                {chatIdLoading ? "Проверяю…" : "Узнать мой chat_id"}
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
          </form>
        )}
      </section>
    </>
  );
}
