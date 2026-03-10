import { useState } from "react";
import type { ChannelInfo } from "../api";
import { analyzeLanding } from "../api";

interface LandingStepProps {
  onDone: (info: ChannelInfo) => void | Promise<void>;
  onBack: () => void;
}

export function LandingStep({ onDone, onBack }: LandingStepProps) {
  const [link, setLink] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!link.trim()) {
      setError("Введите ссылку на сайт или лендинг");
      return;
    }
    setLoading(true);
    try {
      const info = await analyzeLanding(link.trim());
      await onDone(info);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="card mt1">
      <h2>Ссылка на сайт / лендинг</h2>
      <form onSubmit={handleSubmit}>
        <label className="label" htmlFor="landing-link">
          Вставьте URL сайта или лендинга
        </label>
        <input
          id="landing-link"
          type="text"
          placeholder="https://example.com"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          disabled={loading}
        />
        {error && <p className="error">{error}</p>}
        <div className="flex mt1">
          <button type="submit" disabled={loading}>
            {loading ? "Анализирую…" : "Анализировать лендинг"}
          </button>
          <button type="button" className="secondary" onClick={onBack} disabled={loading}>
            Назад
          </button>
        </div>
      </form>
    </section>
  );
}
