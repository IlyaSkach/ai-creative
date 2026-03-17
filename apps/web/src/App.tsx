import { useState, useEffect } from "react";
import type { ChannelInfo } from "./api";
import type { AiProvider } from "./api";
import { editCreativeImageWithAi, editCreativeWithAi, fetchCreativeProviders, generateCreative, sendToTelegram } from "./api";
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

function getPostMediaItems(post: { photoBase64?: string; mediaType?: string; mediaItems?: Array<{ base64: string; mediaType: string }> }): Array<{ base64: string; mediaType: string }> {
  if (post?.mediaItems && post.mediaItems.length > 0) return post.mediaItems;
  if (post?.photoBase64) return [{ base64: post.photoBase64, mediaType: post.mediaType || "image/jpeg" }];
  return [];
}

function pickMultipleMediaFromRanked(
  info: ChannelInfo,
  topic: string | undefined,
  startFromIndex: number | undefined,
  maxCount: number
): Array<{ base64: string; mediaType: string }> {
  const ranked = rankPostIndexesByTopic(info, topic);
  if (ranked.length === 0) return [];
  const startPos = startFromIndex ? ranked.indexOf(startFromIndex) : 0;
  const from = startPos >= 0 ? startPos : 0;
  const result: Array<{ base64: string; mediaType: string }> = [];
  const seen = new Set<number>();
  for (let i = 0; result.length < maxCount && i < ranked.length; i++) {
    const idx = ranked[(from + i) % ranked.length];
    if (seen.has(idx)) continue;
    seen.add(idx);
    const post = info.posts[idx - 1];
    const items = getPostMediaItems(post || {});
    for (const item of items) {
      if (result.length >= maxCount) break;
      result.push(item);
    }
  }
  return result;
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

const PROVIDER_LABELS: Record<AiProvider, string> = {
  deepseek: "DeepSeek",
  gpt: "GPT",
  claude: "Claude",
};

export default function App() {
  const [step, setStep] = useState<Step>("home");
  const [channelInfo, setChannelInfo] = useState<ChannelInfo | null>(null);
  const [creatives, setCreatives] = useState<DraftCreative[]>([]);
  const [activeCreativeIndex, setActiveCreativeIndex] = useState(0);
  const [landingMessage, setLandingMessage] = useState("");
  const [aiProvider, setAiProvider] = useState<AiProvider>("deepseek");
  const [availableProviders, setAvailableProviders] = useState<AiProvider[]>([]);

  useEffect(() => {
    fetchCreativeProviders().then(setAvailableProviders).catch(() => setAvailableProviders(["deepseek"]));
  }, []);

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
          {availableProviders.length > 1 && (
            <div className="mt1">
              <label className="block" style={{ marginBottom: "0.5rem" }}>AI для генерации:</label>
              <div className="flex" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
                {availableProviders.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={aiProvider === p ? "" : "secondary"}
                    onClick={() => setAiProvider(p)}
                  >
                    {PROVIDER_LABELS[p]}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex" style={{ marginTop: "1rem" }}>
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
          aiProvider={aiProvider}
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
            const provider = currentCreative.aiProvider ?? aiProvider;
            const newText = await editCreativeWithAi(currentText || currentCreative.text, instruction, provider);
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
            const provider = currentCreative.aiProvider ?? aiProvider;
            const regenerated = await generateCreative(
              channelInfo,
              withImage,
              topicPrompt,
              nextForcedIndex,
              currentCreative.imageMode,
              currentCreative.style,
              currentCreative.goal,
              currentCreative.landingContactsToInclude,
              currentCreative.emojiAmount ?? "medium",
              currentCreative.targetGender ?? [],
              currentCreative.targetAge ?? [],
              false,
              provider
            );
            let nextImageBase64: string | null = null;
            let nextImageMediaType: string | null = null;
            let nextMediaItems: Array<{ base64: string; mediaType: string }> | undefined;
            if (currentCreative.imageMode === "generated") {
              nextImageBase64 = regenerated.imageBase64;
              nextImageMediaType = regenerated.imageMediaType || (regenerated.imageBase64 ? "image/png" : null);
            } else if (currentCreative.imageMode === "from_post") {
              const idx = regenerated.sourcePostIndex || nextForcedIndex || currentCreative.sourcePostIndex || 1;
              const mediaCount = Math.min(currentCreative.mediaCount ?? 1, 5);
              const items = pickMultipleMediaFromRanked(channelInfo, topicPrompt, idx, mediaCount);
              if (items.length > 0) {
                nextImageBase64 = items[0].base64;
                nextImageMediaType = items[0].mediaType;
                nextMediaItems = items.length > 1 ? items : undefined;
              } else {
                const post = channelInfo.posts[idx - 1];
                nextImageBase64 = post?.photoBase64 || null;
                nextImageMediaType = post?.mediaType || (nextImageBase64 ? "image/jpeg" : null);
              }
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
              mediaItems: nextMediaItems,
            } : c));
          }}
          onSend={async (to, text, imageBase64, imageMediaType, mediaItems) => {
            await sendToTelegram(to, text, imageBase64, imageMediaType, mediaItems);
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
