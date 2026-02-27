import { useState } from "react";
import type { ChannelInfo } from "./api";
import { editCreativeWithAi, generateCreative, sendToTelegram } from "./api";
import { ChannelStep } from "./components/ChannelStep";
import { CreativeStep, type DraftCreative } from "./components/CreativeStep";
import { SendStep } from "./components/SendStep";

type Step = "channel" | "creative" | "send";

function engagementScore(p: { views?: number; reactionsCount?: number }): number {
  return (p.views ?? 0) + (p.reactionsCount ?? 0) * 2;
}

function extractKeywords(topic?: string): string[] {
  if (!topic) return [];
  return topic
    .toLowerCase()
    .split(/[^a-zA-Zа-яА-Я0-9]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4);
}

function rankPostIndexesByTopic(info: ChannelInfo, topic?: string): number[] {
  const indexed = info.posts.map((post, idx) => ({ post, idx: idx + 1 }));
  const sorted = indexed.sort((a, b) => engagementScore(b.post) - engagementScore(a.post));
  const keywords = extractKeywords(topic);
  if (keywords.length === 0) return sorted.map((x) => x.idx);
  const matched = sorted.filter((x) => {
    const text = (x.post.text || "").toLowerCase();
    return keywords.some((k) => text.includes(k));
  });
  return (matched.length > 0 ? matched : sorted).map((x) => x.idx);
}

function getNextSourcePostIndex(info: ChannelInfo, topic: string | undefined, current?: number | null): number | undefined {
  const ranked = rankPostIndexesByTopic(info, topic);
  if (ranked.length === 0) return undefined;
  if (!current) return ranked[0];
  const pos = ranked.indexOf(current);
  if (pos < 0) return ranked[0];
  return ranked[(pos + 1) % ranked.length];
}

function resolveSourcePostLink(info: ChannelInfo, sourcePostIndex?: number | null): string | null {
  if (sourcePostIndex && sourcePostIndex >= 1 && sourcePostIndex <= info.posts.length) {
    const post = info.posts[sourcePostIndex - 1];
    if (post?.postId) return `https://t.me/${info.username}/${post.postId}`;
  }
  if (info.directPostMode && info.sourcePostLink) return info.sourcePostLink;
  return null;
}

function appendSourcePostLink(text: string, link: string | null): string {
  if (!link) return text;
  const cleaned = text.trim();
  if (cleaned.includes(link)) return cleaned;
  return `${cleaned}\n\nПост-источник: ${link}`;
}

export default function App() {
  const [step, setStep] = useState<Step>("channel");
  const [channelInfo, setChannelInfo] = useState<ChannelInfo | null>(null);
  const [creatives, setCreatives] = useState<DraftCreative[]>([]);
  const [activeCreativeIndex, setActiveCreativeIndex] = useState(0);
  const [autoGenerating, setAutoGenerating] = useState(false);
  const [autoGenerateError, setAutoGenerateError] = useState("");

  const onChannelDone = async (info: ChannelInfo) => {
    setChannelInfo(info);
    if (!info.directPostMode) {
      setStep("creative");
      return;
    }
    setAutoGenerateError("");
    setAutoGenerating(true);
    try {
      // Режим ссылки на пост: сразу генерируем текст по этому посту
      const generated = await generateCreative(info, false, undefined, 1);
      const mediaFromPost = info.posts.find((p) => p.photoBase64);
      setCreatives([{
        topicLabel: "Креатив по выбранному посту",
        topicPrompt: undefined,
        selectedTopics: [],
        attachSourcePostLink: false,
        imageMode: mediaFromPost ? "from_post" : "none",
        text: generated.text,
        imageBase64: mediaFromPost?.photoBase64 || null,
        imageMediaType: mediaFromPost?.mediaType || (mediaFromPost ? "image/jpeg" : null),
        sourcePostIndex: generated.sourcePostIndex ?? 1,
      }]);
      setActiveCreativeIndex(0);
      setStep("send");
    } catch (e) {
      setAutoGenerateError(e instanceof Error ? e.message : "Ошибка генерации креатива");
      setStep("creative");
    } finally {
      setAutoGenerating(false);
    }
  };

  const onCreativeDone = (nextCreatives: DraftCreative[]) => {
    setCreatives(nextCreatives);
    setActiveCreativeIndex(0);
    setStep("send");
  };

  const currentCreative = creatives[activeCreativeIndex] || null;

  return (
    <>
      <h1>AI Creative</h1>
      <p style={{ color: "var(--muted)", margin: 0 }}>
        Вставьте ссылку на Telegram-канал — ИИ проанализирует канал и создаст рекламный креатив.
      </p>

      {step === "channel" && (
        <ChannelStep onDone={onChannelDone} />
      )}

      {step === "creative" && channelInfo && (
        <>
          {autoGenerating && (
            <section className="card">
              <h2>Подготовка креатива</h2>
              <p style={{ color: "var(--muted)", margin: 0 }}>
                Обнаружена ссылка на пост. Генерирую креатив сразу по этому посту и перенаправляю в редактирование…
              </p>
            </section>
          )}
          {autoGenerateError && (
            <section className="card">
              <h2>Ошибка авто-режима</h2>
              <p className="error" style={{ margin: 0 }}>{autoGenerateError}</p>
            </section>
          )}
          <CreativeStep
            channelInfo={channelInfo}
            onDone={onCreativeDone}
          />
        </>
      )}

      {step === "send" && (
        <SendStep
          creatives={creatives}
          activeCreativeIndex={activeCreativeIndex}
          onSelectCreative={setActiveCreativeIndex}
          onBack={() => setStep("creative")}
          onEdit={async (instruction, currentText) => {
            if (!currentCreative) return "";
            const newText = await editCreativeWithAi(currentText || currentCreative.text, instruction);
            const finalText = currentCreative.attachSourcePostLink
              ? appendSourcePostLink(
                  newText,
                  channelInfo ? resolveSourcePostLink(channelInfo, currentCreative.sourcePostIndex) : null
                )
              : newText;
            setCreatives((prev) => prev.map((c, i) => i === activeCreativeIndex ? { ...c, text: finalText } : c));
            return finalText;
          }}
          onReroll={async () => {
            if (!channelInfo || !currentCreative) return;
            const topicPrompt = currentCreative.topicPrompt;
            const nextForcedIndex = getNextSourcePostIndex(channelInfo, topicPrompt, currentCreative.sourcePostIndex);
            const withImage = currentCreative.imageMode === "generated" || currentCreative.imageMode === "hybrid";
            const sourcePost = nextForcedIndex ? channelInfo.posts[nextForcedIndex - 1] : undefined;
            const regenerated = await generateCreative(
              channelInfo,
              withImage,
              topicPrompt,
              nextForcedIndex,
              currentCreative.imageMode,
              currentCreative.imageMode === "hybrid" ? (sourcePost?.photoBase64 || null) : null,
              currentCreative.imageMode === "hybrid" ? (sourcePost?.mediaType || null) : null
            );
            let nextImageBase64: string | null = null;
            let nextImageMediaType: string | null = null;
            if (currentCreative.imageMode === "generated") {
              nextImageBase64 = regenerated.imageBase64;
              nextImageMediaType = regenerated.imageMediaType || (regenerated.imageBase64 ? "image/png" : null);
            } else if (currentCreative.imageMode === "hybrid") {
              nextImageBase64 = regenerated.imageBase64;
              nextImageMediaType = regenerated.imageMediaType || (regenerated.imageBase64 ? "image/png" : null);
            } else if (currentCreative.imageMode === "from_post") {
              const idx = regenerated.sourcePostIndex || nextForcedIndex || currentCreative.sourcePostIndex || 1;
              const post = channelInfo.posts[idx - 1];
              nextImageBase64 = post?.photoBase64 || null;
              nextImageMediaType = post?.mediaType || (nextImageBase64 ? "image/jpeg" : null);
            }
            setCreatives((prev) => prev.map((c, i) => i === activeCreativeIndex ? {
              ...c,
              text: c.attachSourcePostLink
                ? appendSourcePostLink(
                    regenerated.text,
                    resolveSourcePostLink(channelInfo, regenerated.sourcePostIndex ?? nextForcedIndex ?? c.sourcePostIndex)
                  )
                : regenerated.text,
              sourcePostIndex: regenerated.sourcePostIndex ?? nextForcedIndex ?? c.sourcePostIndex,
              imageBase64: nextImageBase64,
              imageMediaType: nextImageMediaType,
            } : c));
          }}
          onSend={async (to, text, imageBase64, imageMediaType) => {
            await sendToTelegram(to, text, imageBase64, imageMediaType);
          }}
        />
      )}
    </>
  );
}
