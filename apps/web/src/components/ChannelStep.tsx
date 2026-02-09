import { useState } from "react";
import type { ChannelInfo } from "../api";
import { analyzeChannel } from "../api";

interface ChannelStepProps {
  onDone: (info: ChannelInfo) => void;
}

export function ChannelStep({ onDone }: ChannelStepProps) {
  const [link, setLink] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!link.trim()) {
      setError("Введите ссылку на канал");
      return;
    }
    setLoading(true);
    try {
      const info = await analyzeChannel(link.trim());
      onDone(info);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="card mt1">
      <h2>Ссылка на канал</h2>
      <form onSubmit={handleSubmit}>
        <label className="label" htmlFor="channel-link">
          t.me/username или @username
        </label>
        <input
          id="channel-link"
          type="text"
          placeholder="https://t.me/durov или @durov"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          disabled={loading}
        />
        {error && <p className="error">{error}</p>}
        <div className="flex mt1">
          <button type="submit" disabled={loading}>
            {loading ? "Анализирую…" : "Анализировать канал"}
          </button>
        </div>
      </form>
    </section>
  );
}
