import { Router } from "express";
import { analyzeChannelTopics, generateCreative, editCreativeWithAi } from "../services/deepseek.js";
import { enhanceSourceImageWithBothubOverlay, generateImage, stylizeSourceImageForAd } from "../services/bothub.js";
import type { ChannelInfo } from "../services/deepseek.js";

export const creativeRouter = Router();

function resolveHybridSourceFromChannelInfo(
  channelInfo: ChannelInfo,
  preferredIndexes: Array<number | undefined>
): { base64: string; mediaType?: string; source: string } | null {
  for (const idx of preferredIndexes) {
    if (!idx || idx < 1 || idx > channelInfo.posts.length) continue;
    const post = channelInfo.posts[idx - 1];
    if (post?.photoBase64) {
      return {
        base64: post.photoBase64,
        mediaType: post.mediaType,
        source: `post_index_${idx}`,
      };
    }
  }
  const fallbackIdx = channelInfo.posts.findIndex((p) => Boolean(p.photoBase64));
  if (fallbackIdx >= 0) {
    const post = channelInfo.posts[fallbackIdx];
    return {
      base64: post.photoBase64 as string,
      mediaType: post.mediaType,
      source: `first_media_post_index_${fallbackIdx + 1}`,
    };
  }
  return null;
}

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
      imageMode?: "none" | "generated" | "from_post" | "hybrid";
      sourceImageBase64?: string;
      sourceImageMediaType?: string;
    };
    if (!channelInfo?.title || !channelInfo?.channelLink) {
      res.status(400).json({ error: "Нужны данные канала (channelInfo). Сначала вызовите /api/channel/analyze" });
      return;
    }
    const { text, imagePrompt, sourcePostIndex } = await generateCreative(
      channelInfo,
      Boolean(withImage),
      selectedTopic,
      typeof forcedSourcePostIndex === "number" ? forcedSourcePostIndex : undefined
    );
    const imageMode = req.body?.imageMode as "none" | "generated" | "from_post" | "hybrid" | undefined;
    const sourceImageBase64 = typeof req.body?.sourceImageBase64 === "string" ? req.body.sourceImageBase64 : undefined;
    const sourceImageMediaType = typeof req.body?.sourceImageMediaType === "string" ? req.body.sourceImageMediaType : undefined;
    let hybridSourceImageBase64 = sourceImageBase64;
    let hybridSourceImageMediaType = sourceImageMediaType;
    if (imageMode === "hybrid" && !hybridSourceImageBase64) {
      const recovered = resolveHybridSourceFromChannelInfo(channelInfo, [
        sourcePostIndex ?? undefined,
        typeof forcedSourcePostIndex === "number" ? forcedSourcePostIndex : undefined,
      ]);
      if (recovered) {
        hybridSourceImageBase64 = recovered.base64;
        hybridSourceImageMediaType = recovered.mediaType;
        console.log(`[creative] hybrid source recovered from channelInfo (${recovered.source})`);
      }
    }
    let imageBase64: string | null = null;
    let imageMediaType: string | null = null;
    let imageError: string | null = null;
    if (withImage && imagePrompt) {
      try {
        if (imageMode === "hybrid" && hybridSourceImageBase64) {
          try {
            // Fast path: only the model that actually works in current setup (dall-e-3 overlay).
            imageBase64 = await enhanceSourceImageWithBothubOverlay(hybridSourceImageBase64, imagePrompt);
            imageMediaType = "image/jpeg";
            console.log("[creative] hybrid_result=bothub_overlay");
          } catch (overlayErr) {
            console.warn("BotHub overlay hybrid failed, fallback to local stylize:", overlayErr instanceof Error ? overlayErr.message : overlayErr);
            try {
              // Stable fallback: keep source relation and avoid slow/unstable responses path.
              imageBase64 = await stylizeSourceImageForAd(hybridSourceImageBase64);
              imageMediaType = "image/jpeg";
              console.log("[creative] hybrid_result=local_stylize");
            } catch (localErr) {
              console.warn("Local hybrid stylize failed, fallback to generated image:", localErr instanceof Error ? localErr.message : localErr);
              // Last fallback: regular generated image.
              imageBase64 = await generateImage(imagePrompt);
              imageMediaType = "image/png";
              console.log("[creative] hybrid_result=generated");
            }
          }
        } else {
          if (imageMode === "hybrid" && !hybridSourceImageBase64) {
            console.warn("[creative] hybrid requested but sourceImageBase64 is missing, fallback to generated image");
          }
          imageBase64 = await generateImage(imagePrompt);
          imageMediaType = "image/png";
        }
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
