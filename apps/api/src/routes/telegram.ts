import { Router } from "express";
import { sendMessage, sendPhoto, sendAnimation, sendMediaGroup, getUpdates } from "../services/telegram.js";

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
 * Body: { to, text, imageBase64?, imageMediaType?, mediaItems?: Array<{base64, mediaType}> }
 * Если mediaItems.length > 1 — отправляется sendMediaGroup.
 */
telegramRouter.post("/send", async (req, res) => {
  try {
    const { to, text, imageBase64, imageMediaType, mediaItems } = req.body as {
      to?: string;
      text?: string;
      imageBase64?: string;
      imageMediaType?: string;
      mediaItems?: Array<{ base64: string; mediaType: string }>;
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
    const items = Array.isArray(mediaItems) && mediaItems.length > 0
      ? mediaItems.filter((m) => m && typeof m.base64 === "string")
      : imageBase64 && typeof imageBase64 === "string"
        ? [{ base64: imageBase64, mediaType: imageMediaType || "image/png" }]
        : [];
    if (items.length > 0) {
      if (items.length > 1) {
        await sendMediaGroup(chatId, text, items);
      } else {
        const m = items[0];
        const mediaType = (m.mediaType || "image/png").toLowerCase();
        const isAnimated = mediaType.includes("gif") || mediaType.startsWith("video/");
        if (isAnimated) {
          await sendAnimation(chatId, text, m.base64, mediaType);
        } else {
          await sendPhoto(chatId, text, m.base64, mediaType);
        }
      }
    } else {
      await sendMessage(chatId, text);
    }
    res.json({ ok: true, message: "Отправлено" });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Ошибка отправки в Telegram";
    res.status(500).json({ error: message });
  }
});
