import { Router } from "express";
import { analyzeChannelTopics, generateCreative, editCreativeWithAi } from "../services/deepseek.js";
import { editImageWithAiOverlay, generateImage } from "../services/bothub.js";
import type { ChannelInfo } from "../services/deepseek.js";

export const creativeRouter = Router();

creativeRouter.post("/themes", async (req, res) => {
  try {
    const { channelInfo } = req.body as { channelInfo: ChannelInfo };
    if (!channelInfo?.title || !channelInfo?.channelLink) {
      res.status(400).json({ error: "Нужны данные канала (channelInfo). Сначала вызовите /api/channel/analyze" });
      return;
    }
    const topics = await analyzeChannelTopics(channelInfo);
    res.json(topics);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Ошибка анализа тем";
    res.status(500).json({ error: message });
  }
});

creativeRouter.post("/generate", async (req, res) => {
  try {
    const { channelInfo, withImage, selectedTopic, forcedSourcePostIndex } = req.body as {
      channelInfo: ChannelInfo;
      withImage?: boolean;
      selectedTopic?: string;
      forcedSourcePostIndex?: number;
      imageMode?: "none" | "generated" | "from_post";
      style?: "native" | "history" | "direct" | "humor";
    };
    if (!channelInfo?.title || !channelInfo?.channelLink) {
      res.status(400).json({ error: "Нужны данные канала (channelInfo). Сначала вызовите /api/channel/analyze" });
      return;
    }
    const { text, imagePrompt, sourcePostIndex } = await generateCreative(
      channelInfo,
      Boolean(withImage),
      selectedTopic,
      typeof forcedSourcePostIndex === "number" ? forcedSourcePostIndex : undefined,
      req.body?.style
    );
    const imageMode = req.body?.imageMode as "none" | "generated" | "from_post" | undefined;
    let imageBase64: string | null = null;
    let imageMediaType: string | null = null;
    let imageError: string | null = null;
    if (withImage && imagePrompt) {
      try {
        imageBase64 = await generateImage(imagePrompt);
        imageMediaType = "image/png";
      } catch (e) {
        imageError = e instanceof Error ? e.message : "Ошибка генерации картинки";
        console.error("BotHub image error:", imageError);
      }
    }
    res.json({ text, imageBase64, imageMediaType, imagePrompt: imagePrompt || null, imageError, sourcePostIndex });
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

creativeRouter.post("/edit-image", async (req, res) => {
  try {
    const { imageBase64, imageMediaType, instruction, imageMode, currentText } = req.body as {
      imageBase64?: string;
      imageMediaType?: string;
      instruction?: string;
      imageMode?: "none" | "generated" | "from_post";
      currentText?: string;
    };
    if (!imageBase64 || typeof imageBase64 !== "string") {
      res.status(400).json({ error: "Укажите imageBase64 — текущее изображение креатива" });
      return;
    }
    if (!instruction || typeof instruction !== "string") {
      res.status(400).json({ error: "Укажите instruction — что изменить в картинке" });
      return;
    }
    const mediaType = (imageMediaType || "image/jpeg").toLowerCase();
    if (!mediaType.startsWith("image/")) {
      res.status(400).json({ error: "Редактирование доступно только для изображений (image/*)." });
      return;
    }
    if (imageMode === "generated") {
      const textContext = typeof currentText === "string" && currentText.trim()
        ? ` Context: ${currentText.trim().slice(0, 500)}`
        : "";
      const regenerated = await generateImage(
        `Create a full-frame redesigned advertising image.${textContext} Edit request: ${instruction}. No text, no watermark.`
      );
      res.json({ imageBase64: regenerated, imageMediaType: "image/png" });
      return;
    }

    const editedBase64 = await editImageWithAiOverlay(imageBase64, instruction);
    res.json({ imageBase64: editedBase64, imageMediaType: "image/jpeg" });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Ошибка редактирования картинки";
    res.status(500).json({ error: message });
  }
});
