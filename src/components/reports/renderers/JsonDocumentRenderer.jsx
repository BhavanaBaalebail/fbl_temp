/**
 * Renders JSON blob with syntax highlighting — exact download content
 */

import { useEffect, useState } from "react";

function highlightJson(json) {
  const escaped = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped.replace(
    /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = "json-number";
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "json-key" : "json-string";
      } else if (/true|false/.test(match)) {
        cls = "json-boolean";
      } else if (/null/.test(match)) {
        cls = "json-null";
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

export function JsonDocumentRenderer({ blob, onDocumentLoad }) {
  const [content, setContent] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!blob) {
      setContent("");
      return undefined;
    }

    let cancelled = false;
    blob
      .text()
      .then((text) => {
        if (cancelled) return;
        try {
          const formatted = JSON.stringify(JSON.parse(text), null, 2);
          setContent(formatted);
        } catch {
          setContent(text);
        }
        onDocumentLoad?.({ pageCount: 1, format: "json" });
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [blob, onDocumentLoad]);

  if (error) {
    return <p className="p-8 text-center text-sm text-red-400">{error}</p>;
  }

  if (!content) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[#64748b]">
        Loading JSON preview…
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center py-8">
      <span className="mb-4 font-mono-metrics text-[11px] uppercase tracking-widest text-[#64748b]">
        JSON Document
      </span>
      <div
        className="document-page-sheet w-full max-w-4xl overflow-auto bg-[#1e1e1e] p-6 shadow-2xl"
        style={{ minHeight: "480px" }}
      >
        <pre
          className="json-preview-code font-mono-metrics text-[13px] leading-relaxed text-[#d4d4d4]"
          dangerouslySetInnerHTML={{ __html: highlightJson(content) }}
        />
      </div>
    </div>
  );
}
