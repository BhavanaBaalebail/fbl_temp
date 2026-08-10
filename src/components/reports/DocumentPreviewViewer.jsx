/**
 * True WYSIWYG document viewer — renders actual generated report blobs
 */

import { useCallback, useMemo } from "react";
import { PdfDocumentRenderer } from "./renderers/PdfDocumentRenderer";
import { DocxDocumentRenderer } from "./renderers/DocxDocumentRenderer";
import { CsvDocumentRenderer } from "./renderers/CsvDocumentRenderer";
import { JsonDocumentRenderer } from "./renderers/JsonDocumentRenderer";

const FORMAT_LABELS = { pdf: "PDF", docx: "Word", csv: "CSV", json: "JSON" };

function ToolbarButton({ children, onClick, disabled, active, title }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
        active
          ? "border-cyan-500/40 bg-cyan-500/10 text-[#22d3ee]"
          : "border-[rgba(34,211,238,0.15)] text-[#94a3b8] hover:bg-white/5 hover:text-[#e2e8f0]"
      }`}
    >
      {children}
    </button>
  );
}

export function DocumentPreviewViewer({
  outputs,
  previewFormat,
  onPreviewFormatChange,
  supportedFormats,
  zoom,
  fitMode,
  onZoomChange,
  onFitModeChange,
  currentPage,
  totalPages,
  onPageChange,
  onDocumentLoad,
  generating,
  onGenerate,
  onDownload,
  canGenerate,
  isStale,
  error,
}) {
  const activeBlob = outputs?.[previewFormat]?.blob ?? null;
  const hasDocument = Boolean(activeBlob);

  const handleDocumentLoad = useCallback(
    (info) => {
      onDocumentLoad?.(info);
    },
    [onDocumentLoad]
  );

  const renderer = useMemo(() => {
    if (!activeBlob) return null;
    const props = {
      blob: activeBlob,
      zoom,
      fitMode,
      currentPage,
      onDocumentLoad: handleDocumentLoad,
    };

    switch (previewFormat) {
      case "pdf":
        return <PdfDocumentRenderer {...props} />;
      case "docx":
        return <DocxDocumentRenderer blob={activeBlob} onDocumentLoad={handleDocumentLoad} />;
      case "csv":
        return <CsvDocumentRenderer blob={activeBlob} onDocumentLoad={handleDocumentLoad} />;
      case "json":
        return <JsonDocumentRenderer blob={activeBlob} onDocumentLoad={handleDocumentLoad} />;
      default:
        return null;
    }
  }, [activeBlob, previewFormat, zoom, fitMode, currentPage, handleDocumentLoad]);

  const showPageNav = previewFormat === "pdf" && totalPages > 1;

  return (
    <div className="document-viewer flex h-full min-h-0 flex-col overflow-hidden rounded-xl border" style={{ borderColor: "rgba(34,211,238,0.15)", background: "rgba(6,10,16,0.85)" }}>
      {/* Toolbar */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5"
        style={{ borderColor: "rgba(34,211,238,0.1)", background: "rgba(8,12,18,0.95)" }}
      >
        <button
          type="button"
          onClick={onGenerate}
          disabled={generating || !canGenerate}
          className="hw-btn-primary px-4 py-1.5 text-xs"
        >
          {generating ? "Generating…" : isStale && hasDocument ? "Regenerate" : "Generate Report"}
        </button>

        <button
          type="button"
          onClick={() => onDownload(previewFormat)}
          disabled={!hasDocument || generating}
          className="rounded-md border px-3 py-1.5 text-xs font-medium text-[#38bdf8] transition hover:bg-cyan-500/10 disabled:opacity-40"
          style={{ borderColor: "rgba(34,211,238,0.25)" }}
        >
          Download
        </button>

        <div className="mx-1 h-5 w-px bg-[rgba(34,211,238,0.15)]" />

        <ToolbarButton
          title="Zoom out"
          disabled={!hasDocument || previewFormat !== "pdf"}
          onClick={() => {
            onFitModeChange("custom");
            onZoomChange(Math.max(25, zoom - 25));
          }}
        >
          −
        </ToolbarButton>
        <span className="min-w-[3rem] text-center font-mono-metrics text-xs text-[#64748b]">
          {fitMode === "100" ? "100%" : fitMode === "width" ? "Fit W" : fitMode === "page" ? "Fit P" : `${zoom}%`}
        </span>
        <ToolbarButton
          title="Zoom in"
          disabled={!hasDocument || previewFormat !== "pdf"}
          onClick={() => {
            onFitModeChange("custom");
            onZoomChange(Math.min(200, zoom + 25));
          }}
        >
          +
        </ToolbarButton>
        <ToolbarButton
          title="Fit width"
          active={fitMode === "width"}
          disabled={!hasDocument || previewFormat !== "pdf"}
          onClick={() => onFitModeChange("width")}
        >
          Fit Width
        </ToolbarButton>
        <ToolbarButton
          title="Fit page"
          active={fitMode === "page"}
          disabled={!hasDocument || previewFormat !== "pdf"}
          onClick={() => onFitModeChange("page")}
        >
          Fit Page
        </ToolbarButton>
        <ToolbarButton
          title="100%"
          active={fitMode === "100"}
          disabled={!hasDocument || previewFormat !== "pdf"}
          onClick={() => onFitModeChange("100")}
        >
          100%
        </ToolbarButton>

        {showPageNav && (
          <>
            <div className="mx-1 h-5 w-px bg-[rgba(34,211,238,0.15)]" />
            <ToolbarButton
              disabled={currentPage <= 1}
              onClick={() => onPageChange(currentPage - 1)}
            >
              ← Prev
            </ToolbarButton>
            <span className="font-mono-metrics text-xs text-[#94a3b8]">
              {currentPage} / {totalPages}
            </span>
            <ToolbarButton
              disabled={currentPage >= totalPages}
              onClick={() => onPageChange(currentPage + 1)}
            >
              Next →
            </ToolbarButton>
          </>
        )}

        {isStale && hasDocument && (
          <span className="ml-auto text-[10px] uppercase tracking-wider text-amber-400/90">
            Config changed — regenerate to update
          </span>
        )}
      </div>

      {/* Format tabs */}
      <div
        className="flex shrink-0 items-center gap-4 border-b px-4 py-2"
        style={{ borderColor: "rgba(34,211,238,0.08)" }}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#64748b]">
          Report Format
        </span>
        <div className="flex flex-wrap gap-3">
          {supportedFormats.map((fmt) => (
            <label
              key={fmt.id}
              className="flex cursor-pointer items-center gap-2 text-sm text-[#94a3b8]"
            >
              <input
                type="radio"
                name="preview-format"
                checked={previewFormat === fmt.id}
                onChange={() => onPreviewFormatChange(fmt.id)}
                className="accent-cyan-400"
              />
              <span className={previewFormat === fmt.id ? "font-medium text-[#22d3ee]" : ""}>
                {FORMAT_LABELS[fmt.id] || fmt.label}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Preview label */}
      <div className="shrink-0 px-4 py-1.5 text-center">
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#475569]">
          Live Preview — {FORMAT_LABELS[previewFormat] || previewFormat}
        </span>
      </div>

      {/* Document canvas */}
      <div
        className="document-viewer-canvas min-h-0 flex-1 overflow-auto"
        style={{ background: "repeating-conic-gradient(#0a0e14 0% 25%, #080c12 0% 50%) 0 0 / 16px 16px" }}
      >
        {generating && (
          <div className="flex h-full min-h-[320px] items-center justify-center">
            <p className="text-sm text-[#64748b]">Rendering document preview…</p>
          </div>
        )}

        {!generating && !hasDocument && (
          <div className="flex h-full min-h-[400px] flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm font-medium text-[#94a3b8]">No document generated yet</p>
            <p className="max-w-sm text-xs text-[#64748b]">
              Configure your report on the left, then click Generate Report to render the actual
              {` ${FORMAT_LABELS[previewFormat]}`} preview before downloading.
            </p>
          </div>
        )}

        {!generating && hasDocument && renderer}

        {error && (
          <p className="p-4 text-center text-sm text-red-400">{error}</p>
        )}
      </div>
    </div>
  );
}
