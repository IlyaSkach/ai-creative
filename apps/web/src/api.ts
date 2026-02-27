const API = "/api";

export interface ChannelInfo {
  title: string;
  description: string;
  username: string;
  channelLink: string;
  posts: Array<{ postId?: number; date: string; text: string; photoBase64?: string; mediaType?: string; views?: number; reactionsCount?: number }>;
  directPostMode?: boolean;
  sourcePostLink?: string;
}

export interface ChannelTopics {
  summary: string;
  topics: string[];
  bestThemesInsight?: string;
}

function stripHeavyMedia(channelInfo: ChannelInfo): ChannelInfo {
  return {
    ...channelInfo,
    posts: (channelInfo.posts || []).map((p) => ({
      ...p,
      photoBase64: undefined,
    })),
  };
}

async function parseApiResponse<T>(res: Response, fallbackError: string): Promise<T> {
  const raw = await res.text();
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    if (!res.ok) {
      throw new Error(`${fallbackError}: HTTP ${res.status}`);
    }
    throw new Error("Сервер вернул невалидный JSON");
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "error" in data && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `${fallbackError}: HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export async function analyzeChannel(link: string): Promise<ChannelInfo> {
  const res = await fetch(`${API}/channel/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ link }),
  });
  return parseApiResponse<ChannelInfo>(res, "Ошибка анализа канала");
}

export async function generateCreative(
  channelInfo: ChannelInfo,
  withImage: boolean,
  selectedTopic?: string,
  forcedSourcePostIndex?: number,
  imageMode?: "none" | "generated" | "from_post" | "hybrid",
  sourceImageBase64?: string | null,
  sourceImageMediaType?: string | null
): Promise<{ text: string; imageBase64: string | null; imageMediaType?: string | null; imagePrompt: string | null; imageError?: string | null; sourcePostIndex?: number | null }> {
  const lightChannelInfo = stripHeavyMedia(channelInfo);
  const res = await fetch(`${API}/creative/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channelInfo: lightChannelInfo,
      withImage,
      selectedTopic,
      forcedSourcePostIndex,
      imageMode,
      sourceImageBase64: sourceImageBase64 || undefined,
      sourceImageMediaType: sourceImageMediaType || undefined,
    }),
  });
  return parseApiResponse<{ text: string; imageBase64: string | null; imageMediaType?: string | null; imagePrompt: string | null; imageError?: string | null; sourcePostIndex?: number | null }>(
    res,
    "Ошибка генерации"
  );
}

export async function analyzeChannelTopics(channelInfo: ChannelInfo): Promise<ChannelTopics> {
  const lightChannelInfo = stripHeavyMedia(channelInfo);
  const res = await fetch(`${API}/creative/themes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelInfo: lightChannelInfo }),
  });
  return parseApiResponse<ChannelTopics>(res, "Ошибка анализа тем");
}

export async function editCreativeWithAi(
  text: string,
  instruction: string
): Promise<string> {
  const res = await fetch(`${API}/creative/edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, instruction }),
  });
  const data = await parseApiResponse<{ text: string }>(res, "Ошибка редактирования");
  return data.text;
}

export async function sendToTelegram(
  to: string,
  text: string,
  imageBase64?: string | null,
  imageMediaType?: string | null
): Promise<void> {
  const res = await fetch(`${API}/telegram/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to,
      text,
      imageBase64: imageBase64 || undefined,
      imageMediaType: imageMediaType || undefined,
    }),
  });
  await parseApiResponse<{ ok: boolean }>(res, "Ошибка отправки");
}

export async function fetchTelegramChatIds(): Promise<Array<{ chatId: number; username?: string }>> {
  const res = await fetch(`${API}/telegram/updates`);
  const data = await parseApiResponse<{ chats?: Array<{ chatId: number; username?: string }> }>(res, "Ошибка");
  return data.chats || [];
}
