const API = "/api";

export interface ChannelInfo {
  title: string;
  description: string;
  username: string;
  channelLink: string;
  posts: Array<{ date: string; text: string; photoBase64?: string; mediaType?: string; views?: number; reactionsCount?: number }>;
}

export interface ChannelTopics {
  summary: string;
  topics: string[];
}

export async function analyzeChannel(link: string): Promise<ChannelInfo> {
  const res = await fetch(`${API}/channel/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ link }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Ошибка анализа канала");
  return data;
}

export async function generateCreative(
  channelInfo: ChannelInfo,
  withImage: boolean,
  selectedTopic?: string
): Promise<{ text: string; imageBase64: string | null; imagePrompt: string | null; imageError?: string | null }> {
  const res = await fetch(`${API}/creative/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelInfo, withImage, selectedTopic }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Ошибка генерации");
  return data;
}

export async function analyzeChannelTopics(channelInfo: ChannelInfo): Promise<ChannelTopics> {
  const res = await fetch(`${API}/creative/themes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelInfo }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Ошибка анализа тем");
  return data as ChannelTopics;
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
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Ошибка редактирования");
  return data.text;
}

export async function sendToTelegram(
  to: string,
  text: string,
  imageBase64?: string | null
): Promise<void> {
  const res = await fetch(`${API}/telegram/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, text, imageBase64: imageBase64 || undefined }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Ошибка отправки");
}

export async function fetchTelegramChatIds(): Promise<Array<{ chatId: number; username?: string }>> {
  const res = await fetch(`${API}/telegram/updates`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Ошибка");
  return data.chats || [];
}
