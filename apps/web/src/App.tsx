import { useState } from "react";
import type { ChannelInfo } from "./api";
import { editCreativeWithAi, generateCreative, sendToTelegram } from "./api";
import { ChannelStep } from "./components/ChannelStep";
import { CreativeStep } from "./components/CreativeStep";
import { SendStep } from "./components/SendStep";

type Step = "channel" | "creative" | "send";

export default function App() {
  const [step, setStep] = useState<Step>("channel");
  const [channelInfo, setChannelInfo] = useState<ChannelInfo | null>(null);
  const [creativeText, setCreativeText] = useState("");
  const [creativeImage, setCreativeImage] = useState<string | null>(null);
  const [creativeImageMediaType, setCreativeImageMediaType] = useState<string | null>(null);
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
      const generated = await generateCreative(info, false);
      setCreativeText(generated.text);
      const mediaFromPost = info.posts.find((p) => p.photoBase64);
      setCreativeImage(mediaFromPost?.photoBase64 || null);
      setCreativeImageMediaType(mediaFromPost?.mediaType || (mediaFromPost ? "image/jpeg" : null));
      setStep("send");
    } catch (e) {
      setAutoGenerateError(e instanceof Error ? e.message : "Ошибка генерации креатива");
      setStep("creative");
    } finally {
      setAutoGenerating(false);
    }
  };

  const onCreativeDone = (text: string, imageBase64: string | null, imageMediaType?: string | null) => {
    setCreativeText(text);
    setCreativeImage(imageBase64);
    setCreativeImageMediaType(imageMediaType || null);
    setStep("send");
  };

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
          text={creativeText}
          imageBase64={creativeImage}
          imageMediaType={creativeImageMediaType}
          onBack={() => setStep("creative")}
          onEdit={async (instruction) => {
            const newText = await editCreativeWithAi(creativeText, instruction);
            setCreativeText(newText);
            return newText;
          }}
          onSend={sendToTelegram}
        />
      )}
    </>
  );
}
