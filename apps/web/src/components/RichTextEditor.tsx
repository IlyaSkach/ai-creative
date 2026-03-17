import { useRef, useEffect, useCallback } from "react";

/** Санитизация HTML для Telegram: оставляем только b, i, u, s, code, pre, a, br */
function sanitizeHtmlForTelegram(html: string): string {
  if (!html || !html.trim()) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  const allowed = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "code", "pre", "a", "br"]);
  function walk(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") return "<br>";
    if (tag === "div" || tag === "p") return Array.from(node.childNodes).map(walk).join("") + "<br>";
    if (!allowed.has(tag)) return Array.from(node.childNodes).map(walk).join("");
    const inner = Array.from(node.childNodes).map(walk).join("");
    if (tag === "a") {
      const href = el.getAttribute("href") || "#";
      return `<a href="${href.replace(/"/g, "&quot;")}">${inner}</a>`;
    }
    return `<${tag}>${inner}</${tag}>`;
  }
  return Array.from(div.childNodes).map(walk).join("").replace(/<br>(<br>)+/g, "<br><br>").trim();
}

/** Преобразуем plain text в HTML для отображения в contenteditable */
function plainToHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

/** Проверяем, похоже ли на HTML (есть теги) */
function looksLikeHtml(s: string): boolean {
  return /<[a-z][\s\S]*>/i.test(s);
}

interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  minHeight?: number;
}

export function RichTextEditor({ value, onChange, placeholder, disabled, minHeight = 120 }: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const isInternalChange = useRef(false);

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (isInternalChange.current) {
      isInternalChange.current = false;
      return;
    }
    const current = el.innerHTML;
    const target = looksLikeHtml(value) ? value : plainToHtml(value);
    if (current !== target) {
      el.innerHTML = target || "";
      if (!target && placeholder) el.classList.add("empty");
      else el.classList.remove("empty");
    }
  }, [value, placeholder]);

  const handleInput = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const html = el.innerHTML;
    isInternalChange.current = true;
    onChange(html);
  }, [onChange]);

  const execFormat = useCallback((cmd: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, value);
    handleInput();
  }, [handleInput]);

  return (
    <div className="rich-text-editor" style={{ marginBottom: "0.5rem" }}>
      <div
        className="format-toolbar"
        style={{
          display: "flex",
          gap: "0.25rem",
          marginBottom: "0.35rem",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          className="secondary"
          onClick={() => execFormat("bold")}
          disabled={disabled}
          title="Жирный"
          style={{ padding: "0.35rem 0.6rem", fontWeight: 700 }}
        >
          B
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => execFormat("italic")}
          disabled={disabled}
          title="Курсив"
          style={{ padding: "0.35rem 0.6rem", fontStyle: "italic" }}
        >
          I
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => execFormat("underline")}
          disabled={disabled}
          title="Подчёркивание"
          style={{ padding: "0.35rem 0.6rem", textDecoration: "underline" }}
        >
          U
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => execFormat("strikeThrough")}
          disabled={disabled}
          title="Зачёркивание"
          style={{ padding: "0.35rem 0.6rem", textDecoration: "line-through" }}
        >
          S
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            editorRef.current?.focus();
            const sel = window.getSelection();
            const text = sel?.toString() || "";
            if (text) {
              document.execCommand("insertHTML", false, "<code>" + text.replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</code>");
            } else {
              document.execCommand("insertHTML", false, "<code></code>");
            }
            handleInput();
          }}
          disabled={disabled}
          title="Код"
          style={{ padding: "0.35rem 0.6rem", fontFamily: "monospace", fontSize: "0.9em" }}
        >
          &lt;/&gt;
        </button>
      </div>
      <div
        ref={editorRef}
        contentEditable={!disabled}
        onInput={handleInput}
        onBlur={handleInput}
        data-placeholder={placeholder}
        className="rich-text-content"
        style={{
          minHeight,
          width: "100%",
          padding: "0.75rem 1rem",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          color: "var(--text)",
          outline: "none",
          overflow: "auto",
          lineHeight: 1.5,
        }}
        suppressContentEditableWarning
      />
    </div>
  );
}

/** Получить HTML, готовый для отправки в Telegram */
export function getTelegramHtml(html: string): string {
  if (!html || !html.trim()) return "";
  if (!looksLikeHtml(html)) return html.replace(/\n/g, "<br>");
  return sanitizeHtmlForTelegram(html);
}
