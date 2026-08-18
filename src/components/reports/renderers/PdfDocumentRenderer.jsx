/**
 * Renders actual PDF pages via PDF.js — identical to downloaded file
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { loadPdfDocument, PDF_BASE_SCALE } from "../../../services/reports/preview/pdfPreviewEngine";

export function PdfDocumentRenderer({ blob, zoom, fitMode, currentPage, onDocumentLoad }) {
  const containerRef = useRef(null);
  const pageRefs = useRef([]);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!blob) {
      setPdfDoc(null);
      setPageCount(0);
      return undefined;
    }

    let cancelled = false;
    setError(null);

    loadPdfDocument(blob)
      .then((doc) => {
        if (cancelled) return;
        setPdfDoc(doc);
        setPageCount(doc.numPages);
        onDocumentLoad?.({ pageCount: doc.numPages, format: "pdf" });
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Failed to load PDF");
      });

    return () => {
      cancelled = true;
    };
  }, [blob, onDocumentLoad]);

  const computeScale = useCallback(
    async (doc) => {
      const page = await doc.getPage(1);
      const viewport1 = page.getViewport({ scale: 1 });
      const base = PDF_BASE_SCALE * (zoom / 100);

      if (fitMode === "width" && containerRef.current) {
        const pad = 48;
        const available = containerRef.current.clientWidth - pad;
        return (available / viewport1.width) * (72 / 96);
      }
      if (fitMode === "page" && containerRef.current) {
        const pad = 48;
        const w = containerRef.current.clientWidth - pad;
        const h = containerRef.current.clientHeight - 120;
        const sw = w / viewport1.width;
        const sh = h / viewport1.height;
        return Math.min(sw, sh) * (72 / 96);
      }
      if (fitMode === "100") return PDF_BASE_SCALE;
      if (fitMode === "custom") return PDF_BASE_SCALE * (zoom / 100);
      return base;
    },
    [zoom, fitMode]
  );

  useEffect(() => {
    if (!pdfDoc || !containerRef.current) return undefined;

    let cancelled = false;

    (async () => {
      const scale = await computeScale(pdfDoc);
      if (cancelled) return;

      for (let i = 1; i <= pdfDoc.numPages; i += 1) {
        if (cancelled) break;
        const page = await pdfDoc.getPage(i);
        const viewport = page.getViewport({ scale });
        const canvas = pageRefs.current[i - 1];
        if (!canvas) continue;

        const ctx = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        await page.render({ canvasContext: ctx, viewport }).promise;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, computeScale, zoom, fitMode]);

  useEffect(() => {
    if (!currentPage || !pageRefs.current[currentPage - 1]) return;
    pageRefs.current[currentPage - 1]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [currentPage]);

  if (error) {
    return <p className="p-8 text-center text-sm text-red-400">{error}</p>;
  }

  if (!pdfDoc) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[#64748b]">
        Loading PDF preview…
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col items-center gap-8 py-8">
      {Array.from({ length: pageCount }, (_, i) => {
        const pageNum = i + 1;
        return (
          <div key={pageNum} className="flex flex-col items-center gap-2">
            <span className="font-mono-metrics text-[11px] uppercase tracking-widest text-[#64748b]">
              Page {pageNum}
            </span>
            <div className="document-page-sheet overflow-hidden bg-white shadow-2xl">
              <canvas
                ref={(el) => {
                  pageRefs.current[i] = el;
                }}
                className="block bg-white"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
