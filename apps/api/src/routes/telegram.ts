import { Router } from "express";
import { sendMessage, sendPhoto, getUpdates } from "../services/telegram.js";

export const telegramRouter = Router();

/**
 * Webhook для Telegram: при /start бот присылает пользователю его chat_id.
 * Настройка: setWebhook с URL https://ваш-домен/api/telegram/webhook (нужен публичный HTTPS).
 */
telegramRouter.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const body = req.body as { message?: { chat?: { id: number }; text?: string } };
  const text = body.message?.text?.trim();
  const chatId = body.message?.chat?.id;
  if (text !== "/start" || chatId == null) return;
  try {
    await sendMessage(String(chatId), `Ваш <b>chat_id</b>: <code>${chatId}</code>. Подставьте его в поле «Кому» на сайте.`);
  } catch {
    // ignore
  }
});

/** Получить chat_id после того, как пользователь написал боту /start. */
telegramRouter.get("/updates", async (_req, res) => {
  try {
    const chats = await getUpdates();
    res.json({ chats });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Ошибка";
    res.status(500).json({ error: message });
  }
});

/**
 * Отправка креатива в Telegram.
 * Body: { to: string (username @user или chat_id), text: string, imageBase64?: string }
 */
telegramRouter.post("/send", async (req, res) => {
  try {
    const { to, text, imageBase64 } = req.body as {
      to?: string;
      text?: string;
      imageBase64?: string;
    };
    if (!to || typeof to !== "string") {
      res.status(400).json({ error: "Укажите to — @username или chat_id получателя" });
      return;
    }
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Укажите text — текст креатива" });
      return;
    }
    const chatId = to.startsWith("@") ? to : to.trim();
    if (imageBase64 && typeof imageBase64 === "string") {
      await sendPhoto(chatId, text, imageBase64);
    } else {
      await sendMessage(chatId, text);
    }
    res.json({ ok: true, message: "Отправлено" });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Ошибка отправки в Telegram";
    res.status(500).json({ error: message });
  }
});
