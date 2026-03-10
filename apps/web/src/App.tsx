import { useState } from "react";
import type { ChannelInfo } from "./api";
import { editCreativeImageWithAi, editCreativeWithAi, generateCreative, sendToTelegram } from "./api";
import { ChannelStep } from "./components/ChannelStep";
import { CreativeStep, type DraftCreative } from "./components/CreativeStep";
import { LandingStep } from "./components/LandingStep";
import { SendStep } from "./components/SendStep";

type Step = "home" | "channel" | "landing" | "creative" | "send";

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
  const [step, setStep] = useState<Step>("home");
  const [channelInfo, setChannelInfo] = useState<ChannelInfo | null>(null);
  const [creatives, setCreatives] = useState<DraftCreative[]>([]);
  const [activeCreativeIndex, setActiveCreativeIndex] = useState(0);
  const [landingMessage, setLandingMessage] = useState("");

  const onChannelDone = async (info: ChannelInfo) => {
    setChannelInfo(info);
    setStep("creative");
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
        Создавайте креативы из Telegram-каналов и лендингов.
      </p>

      {step === "home" && (
        <section className="card mt1">
          <h2>Выберите режим</h2>
          <div className="flex">
            <button
              type="button"
              onClick={() => {
                setLandingMessage("");
                setStep("channel");
              }}
            >
              Креатив из TG
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setLandingMessage("");
                setStep("landing");
              }}
            >
              Креатив из Лендинга
            </button>
          </div>
          {landingMessage && <p style={{ color: "var(--muted)", marginTop: "0.75rem" }}>{landingMessage}</p>}
        </section>
      )}

      {step === "channel" && (
        <ChannelStep onDone={onChannelDone} />
      )}

      {step === "landing" && (
        <LandingStep
          onDone={onChannelDone}
          onBack={() => setStep("home")}
        />
      )}

      {step === "creative" && channelInfo && (
        <CreativeStep
          channelInfo={channelInfo}
          onDone={onCreativeDone}
        />
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
            const withImage = currentCreative.imageMode === "generated";
            const regenerated = await generateCreative(
              channelInfo,
              withImage,
              topicPrompt,
              nextForcedIndex,
              currentCreative.imageMode,
              currentCreative.style,
              currentCreative.goal,
              currentCreative.landingContactsToInclude
            );
            let nextImageBase64: string | null = null;
            let nextImageMediaType: string | null = null;
            if (currentCreative.imageMode === "generated") {
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
          onEditImage={async (instruction, currentText) => {
            if (!currentCreative?.imageBase64) throw new Error("Нет изображения для редактирования");
            const edited = await editCreativeImageWithAi(
              currentCreative.imageBase64,
              instruction,
              currentCreative.imageMediaType,
              currentCreative.imageMode,
              currentText || currentCreative.text
            );
            setCreatives((prev) => prev.map((c, i) => (
              i === activeCreativeIndex
                ? { ...c, imageBase64: edited.imageBase64, imageMediaType: edited.imageMediaType }
                : c
            )));
          }}
        />
      )}
    </>
  );
}
