/**
 * Session report history panel
 */

import { HardwareModule, StatusBadge } from "../ui/HardwareModule";
import { theme } from "../../utils/theme";

export function ReportHistoryPanel({
  history,
  downloadHistory,
  removeHistory,
  formatFileSize,
  metadataEntry,
  setMetadataEntry,
  compact,
}) {
  return (
    <HardwareModule
      icon="chart"
      title="Report History"
      subtitle={compact ? undefined : "Reports generated during this session"}
      accentColor={theme.blue}
    >
      {history.length === 0 ? (
        <p className="text-sm text-[#64748b]">No reports generated yet this session.</p>
      ) : (
        <div className={`overflow-x-auto ${compact ? "max-w-full" : ""}`}>
          <table className={`w-full text-left text-sm ${compact ? "text-xs" : "min-w-[640px]"}`}>
            <thead>
              <tr className="border-b text-[10px] uppercase tracking-wider text-[#64748b]" style={{ borderColor: "rgba(34,211,238,0.1)" }}>
                <th className="pb-2 pr-4 font-semibold">Report Name</th>
                <th className="pb-2 pr-4 font-semibold">Timestamp</th>
                <th className="pb-2 pr-4 font-semibold">Type</th>
                <th className="pb-2 pr-4 font-semibold">Format</th>
                <th className="pb-2 pr-4 font-semibold">Status</th>
                <th className="pb-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr
                  key={entry.id}
                  className="border-b transition hover:bg-white/[0.02]"
                  style={{ borderColor: "rgba(34,211,238,0.06)" }}
                >
                  <td className="py-3 pr-4 font-medium text-[#e2e8f0]">{entry.name}</td>
                  <td className="py-3 pr-4 font-mono-metrics text-xs text-[#94a3b8]">
                    {new Date(entry.timestamp).toLocaleString()}
                  </td>
                  <td className="py-3 pr-4 text-[#94a3b8]">{entry.reportType}</td>
                  <td className="py-3 pr-4 uppercase text-[#64748b]">
                    {(entry.formats || []).join(", ")}
                  </td>
                  <td className="py-3 pr-4">
                    <StatusBadge
                      status={entry.status === "ready" ? "healthy" : "info"}
                      label={entry.status}
                    />
                  </td>
                  <td className="py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {(entry.formats || []).map((fmt) => (
                        <button
                          key={fmt}
                          type="button"
                          onClick={() => downloadHistory(entry, fmt)}
                          className="rounded border px-2 py-1 text-[10px] font-medium uppercase text-[#38bdf8] transition hover:bg-cyan-500/10"
                          style={{ borderColor: "rgba(34,211,238,0.2)" }}
                        >
                          {fmt}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          setMetadataEntry(metadataEntry?.id === entry.id ? null : entry)
                        }
                        className="rounded border px-2 py-1 text-[10px] font-medium text-[#94a3b8] transition hover:bg-white/5"
                        style={{ borderColor: "rgba(34,211,238,0.12)" }}
                      >
                        Metadata
                      </button>
                      <button
                        type="button"
                        onClick={() => removeHistory(entry.id)}
                        className="rounded border px-2 py-1 text-[10px] font-medium text-[#fca5a5] transition hover:bg-red-500/10"
                        style={{ borderColor: "rgba(239,68,68,0.2)" }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {metadataEntry && (
        <div
          className="mt-4 rounded-lg border p-4 font-mono-metrics text-xs text-[#94a3b8]"
          style={{
            borderColor: "rgba(34, 211, 238, 0.15)",
            background: "rgba(8, 12, 18, 0.6)",
          }}
        >
          <p className="mb-2 font-semibold text-[#e2e8f0]">Report Metadata</p>
          <pre className="whitespace-pre-wrap break-all">
            {JSON.stringify(
              {
                id: metadataEntry.id,
                name: metadataEntry.name,
                reportType: metadataEntry.reportType,
                timestamp: metadataEntry.timestamp,
                pageCount: metadataEntry.pageCount,
                fileSize: formatFileSize(metadataEntry.fileSize),
                formats: metadataEntry.formats,
                outputs: metadataEntry.outputs,
              },
              null,
              2
            )}
          </pre>
        </div>
      )}
    </HardwareModule>
  );
}
