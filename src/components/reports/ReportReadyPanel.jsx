/**
 * Report ready panel with download actions
 */

import { HardwareModule, StatusBadge } from "../ui/HardwareModule";
import { theme } from "../../utils/theme";

export function ReportReadyPanel({ generationResult, downloadResult, formatFileSize }) {
  if (!generationResult) return null;

  const { generatedAt, pageCount, fileSize, outputs } = generationResult;
  const formats = Object.keys(outputs || {});

  return (
    <HardwareModule
      icon="report"
      title="Report Ready"
      subtitle="Generation complete — download in your selected formats"
      accentColor={theme.cyan}
      className="animate-fade-in"
      headerRight={<StatusBadge status="healthy" label="Ready" />}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#64748b]">
            Generated Time
          </p>
          <p className="mt-1 font-mono-metrics text-sm text-[#e2e8f0]">
            {generatedAt?.toLocaleString?.()}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#64748b]">
            File Size
          </p>
          <p className="mt-1 font-mono-metrics text-sm text-[#e2e8f0]">
            {formatFileSize(fileSize)}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#64748b]">
            Pages
          </p>
          <p className="mt-1 font-mono-metrics text-sm text-[#e2e8f0]">
            {pageCount ?? "—"}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#64748b]">
            Formats
          </p>
          <p className="mt-1 font-mono-metrics text-sm uppercase text-[#38bdf8]">
            {formats.join(", ")}
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {formats.map((fmt) => (
          <button
            key={fmt}
            type="button"
            onClick={() => downloadResult(fmt)}
            className="hw-btn-primary text-xs uppercase tracking-wide"
          >
            Download {fmt.toUpperCase()}
          </button>
        ))}
      </div>
    </HardwareModule>
  );
}
