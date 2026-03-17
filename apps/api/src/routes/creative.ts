import { Router } from "express";
import { analyzeChannelTopics, generateCreative, editCreativeWithAi } from "../services/deepseek.js";
import { getAvailableProviders } from "../services/ai-providers.js";
import { editImageWithAiOverlay, generateImage } from "../services/bothub.js";
import type { ChannelInfo } from "../services/deepseek.js";
import type { AiProvider } from "../services/ai-providers.js";

export const creativeRouter = Router();

creativeRouter.get("/providers", (_req, res) => {
  try {
    const providers = getAvailableProviders();
    res.json({ providers });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Ошибка";
    res.status(500).json({ error: message });
  }
});

creativeRouter.post("/themes", async (req, res) => {
  try {
    const { channelInfo, aiProvider } = req.body as { channelInfo: ChannelInfo; aiProvider?: AiProvider };
    if (!channelInfo?.title || !channelInfo?.channelLink) {
      res.status(400).json({ error: "Нужны данные канала (channelInfo). Сначала вызовите /api/channel/analyze" });
      return;
    }
    const provider: AiProvider =
      aiProvider === "deepseek" || aiProvider === "gpt" || aiProvider === "claude" ? aiProvider : "deepseek";
    const topics = await analyzeChannelTopics(channelInfo, provider);
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
      style?: "native" | "direct" | "clickbait" | "history" | "useful" | "expert" | "humor" | "mini_landing";
      goal?: "subscribers" | "sales" | "brand";
      contactsToInclude?: string[];
    };
    if (!channelInfo?.title || !channelInfo?.channelLink) {
      res.status(400).json({ error: "Нужны данные канала (channelInfo). Сначала вызовите /api/channel/analyze" });
      return;
    }
    const emojiAmount = (req.body?.emojiAmount as "low" | "medium" | "high") || "medium";
    const targetGender = Array.isArray(req.body?.targetGender)
      ? req.body.targetGender.filter((x: unknown) => x === "male" || x === "female")
      : [];
    const targetAge = Array.isArray(req.body?.targetAge)
      ? req.body.targetAge.filter((x: unknown) =>
          ["children", "teens", "adults", "elderly"].includes(String(x))
        )
      : [];
    const rawProvider = req.body?.aiProvider;
    const provider: AiProvider =
      rawProvider === "deepseek" || rawProvider === "gpt" || rawProvider === "claude" ? rawProvider : "deepseek";
    const { text, imagePrompt, sourcePostIndex } = await generateCreative(
      channelInfo,
      Boolean(withImage),
      selectedTopic,
      typeof forcedSourcePostIndex === "number" ? forcedSourcePostIndex : undefined,
      req.body?.style,
      req.body?.goal,
      Array.isArray(req.body?.contactsToInclude)
        ? req.body.contactsToInclude.filter((x: unknown) => typeof x === "string").slice(0, 12)
        : undefined,
      emojiAmount,
      targetGender,
      targetAge,
      provider
    );
    const imageMode = req.body?.imageMode as "none" | "generated" | "from_post" | undefined;
    const textOnly = Boolean(req.body?.textOnly);
    let imageBase64: string | null = null;
    let imageMediaType: string | null = null;
    let imageError: string | null = null;
    if (withImage && imagePrompt && !textOnly) {
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
    const { text, instruction, aiProvider } = req.body as { text?: string; instruction?: string; aiProvider?: AiProvider };
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Укажите text — текущий текст креатива" });
      return;
    }
    if (!instruction || typeof instruction !== "string") {
      res.status(400).json({ error: "Укажите instruction — что изменить (можно своими словами)" });
      return;
    }
    const provider: AiProvider =
      aiProvider === "deepseek" || aiProvider === "gpt" || aiProvider === "claude" ? aiProvider : "deepseek";
    const newText = await editCreativeWithAi(text, instruction, provider);
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
