import { useState } from "react";
import type { ChannelInfo } from "./api";
import {
  analyzeChannel,
  generateCreative,
  editCreativeWithAi,
  sendToTelegram,
} from "./api";
import { ChannelStep } from "./components/ChannelStep";
import { CreativeStep } from "./components/CreativeStep";
import { SendStep } from "./components/SendStep";

type Step = "channel" | "creative" | "send";

export default function App() {
  const [step, setStep] = useState<Step>("channel");
  const [channelInfo, setChannelInfo] = useState<ChannelInfo | null>(null);
  const [creativeText, setCreativeText] = useState("");
  const [creativeImage, setCreativeImage] = useState<string | null>(null);

  const onChannelDone = (info: ChannelInfo) => {
    setChannelInfo(info);
    setStep("creative");
  };

  const onCreativeDone = (text: string, imageBase64: string | null) => {
    setCreativeText(text);
    setCreativeImage(imageBase64);
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
        <CreativeStep
          channelInfo={channelInfo}
          onDone={onCreativeDone}
        />
      )}

      {step === "send" && (
        <SendStep
          text={creativeText}
          imageBase64={creativeImage}
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
