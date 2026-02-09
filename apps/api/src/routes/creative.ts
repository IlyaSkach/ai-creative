import { Router } from "express";
import { generateCreative, editCreativeWithAi } from "../services/deepseek.js";
import { generateImage } from "../services/bothub.js";
import type { ChannelInfo } from "../services/deepseek.js";

export const creativeRouter = Router();

creativeRouter.post("/generate", async (req, res) => {
  try {
    const { channelInfo, withImage } = req.body as {
      channelInfo: ChannelInfo;
      withImage?: boolean;
    };
    if (!channelInfo?.title || !channelInfo?.channelLink) {
      res.status(400).json({ error: "Нужны данные канала (channelInfo). Сначала вызовите /api/channel/analyze" });
      return;
    }
    const { text, imagePrompt } = await generateCreative(channelInfo, Boolean(withImage));
    let imageBase64: string | null = null;
    let imageError: string | null = null;
    if (withImage && imagePrompt) {
      try {
        imageBase64 = await generateImage(imagePrompt);
      } catch (e) {
        imageError = e instanceof Error ? e.message : "Ошибка генерации картинки";
        console.error("BotHub image error:", imageError);
      }
    }
    res.json({ text, imageBase64, imagePrompt: imagePrompt || null, imageError });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Ошибка генерации креатива";
    res.status(500).json({ error: message });
  }
});

creativeRouter.post("/edit", async (req, res) => {
  try {
    const { text, instruction } = req.body as { text?: string; instruction?: string };
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Укажите text — текущий текст креатива" });
      return;
    }
    if (!instruction || typeof instruction !== "string") {
      res.status(400).json({ error: "Укажите instruction — что изменить (можно своими словами)" });
      return;
    }
    const newText = await editCreativeWithAi(text, instruction);
    res.json({ text: newText });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Ошибка редактирования";
    res.status(500).json({ error: message });
  }
});
