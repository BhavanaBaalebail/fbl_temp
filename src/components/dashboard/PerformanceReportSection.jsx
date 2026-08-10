/**
 * Performance Report Section — diagnostics report generator module
 */

import { useState } from "react";
import { HardwareModule, StatusBadge, BusConnector } from "../ui/HardwareModule";
import { REPORT_INTERVALS, getSampleCount } from "../../services/metricsHistoryService";
import { downloadPerformanceReport } from "../../services/performanceReportService";
import { theme } from "../../utils/theme";

export function PerformanceReportSection({ connected, loading }) {
  const [interval, setInterval] = useState("15m");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [lastFile, setLastFile] = useState(null);

  const sampleCount = getSampleCount();

  async function handleDownload() {
    setGenerating(true);
    setError(null);
    setLastFile(null);
    try {
      const { filename } = await downloadPerformanceReport(interval);
      setLastFile(filename);
    } catch (err) {
      console.error("Report generation failed", err);
      setError(err?.message || "Failed to generate report");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <>
      <BusConnector className="my-2" />
      <HardwareModule
        icon="report"
        title="Hardware Diagnostics Report"
        subtitle="Generate comprehensive PDF from session telemetry buffer"
        accentColor={theme.cyan}
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <p className="max-w-xl text-sm leading-relaxed text-[#94a3b8]">
            Executive summary, component health analysis, inventory, trend charts,
            fault analysis, and corrective recommendations.
            {sampleCount > 0
              ? ` ${sampleCount} sample${sampleCount === 1 ? "" : "s"} buffered.`
              : " Samples accumulate while connected."}
          </p>

          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-end">
            <label className="flex flex-col gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[#64748b]">
                Report Interval
              </span>
              <select
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                disabled={generating}
                className="min-w-[200px] rounded-lg border px-3 py-2.5 text-sm font-medium text-[#f1f5f9] outline-none transition focus:ring-1 focus:ring-cyan-500/40"
                style={{
                  background: "rgba(8, 12, 18, 0.8)",
                  borderColor: "rgba(34, 211, 238, 0.15)",
                  fontFamily: "JetBrains Mono, monospace",
                }}
              >
                {Object.entries(REPORT_INTERVALS).map(([key, { label }]) => (
                  <option key={key} value={key} style={{ background: "#0a0e14" }}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={handleDownload}
              disabled={generating || loading}
              className="hw-btn-primary"
            >
              {generating ? "Generating…" : "Download Report"}
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusBadge
            status={connected ? "healthy" : "critical"}
            label={connected ? "Telemetry Active" : "Telemetry Offline"}
          />
          <span
            className="rounded-full border px-3 py-1 text-[10px] font-medium text-[#64748b]"
            style={{ borderColor: "rgba(34,211,238,0.12)" }}
          >
            Inventory · Trends · Charts · Faults
          </span>
          {lastFile && (
            <span className="font-mono-metrics text-xs text-[#38bdf8]">{lastFile}</span>
          )}
        </div>

        {error && (
          <p
            className="mt-3 rounded-lg border px-3 py-2 text-sm text-[#fca5a5]"
            style={{
              borderColor: "rgba(239, 68, 68, 0.3)",
              background: "rgba(239, 68, 68, 0.08)",
            }}
          >
            {error}
          </p>
        )}

        {!connected && !loading && (
          <p className="mt-3 text-sm text-[#64748b]">
            Connect to the Linux telemetry server to collect live metrics. Missing data appears as &quot;Not Available.&quot;
          </p>
        )}
      </HardwareModule>
    </>
  );
}
