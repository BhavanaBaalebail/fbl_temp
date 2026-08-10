/**
 * Renders actual DOCX via docx-preview — same file as download
 */

import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";

export function DocxDocumentRenderer({ blob, onDocumentLoad }) {
  const containerRef = useRef(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!blob || !containerRef.current) return undefined;

    let cancelled = false;
    const el = containerRef.current;
    setLoading(true);
    setError(null);
    el.innerHTML = "";

    renderAsync(blob, el, null, {
      className: "docx-preview-wrapper",
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      useBase64URL: true,
    })
      .then(() => {
        if (cancelled) return;
        setLoading(false);
        const sections = el.querySelectorAll(".docx-wrapper section, .docx-wrapper > article");
        onDocumentLoad?.({
          pageCount: sections.length > 0 ? sections.length : 1,
          format: "docx",
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || "Failed to load DOCX preview");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [blob, onDocumentLoad]);

  if (error) {
    return <p className="p-8 text-center text-sm text-red-400">{error}</p>;
  }

  return (
    <div className="docx-viewer-shell flex flex-col items-center py-8">
      {loading && <p className="mb-4 text-sm text-[#64748b]">Loading Word preview…</p>}
      <div
        ref={containerRef}
        className="docx-preview-host document-page-sheet bg-white shadow-2xl"
        style={{ minWidth: "816px", maxWidth: "816px" }}
      />
    </div>
  );
}
