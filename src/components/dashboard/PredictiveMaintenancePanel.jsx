/**
 * Compact Predictive Health panel for the Dashboard.
 */

import { useState } from "react";
import { HardwareModule, StatusBadge } from "../ui/HardwareModule";
import { usePredictiveMaintenance } from "../../hooks/usePredictiveMaintenance";
import {
  PREDICTIVE_DISCLAIMER,
} from "../../services/predictiveMaintenance";
import { PredictiveMaintenanceDetail } from "./PredictiveMaintenanceDetail";

function riskTone(risk) {
  if (risk === "HIGH") return "critical";
  if (risk === "WARNING" || risk === "WATCH") return "warning";
  return "healthy";
}

export function PredictiveMaintenancePanel({ enabled = true }) {
  const { loading, error, data, refresh } = usePredictiveMaintenance({
    enabled,
    refreshMs: 60000,
  });
  const [detailOpen, setDetailOpen] = useState(false);

  const predictions = data?.predictions || [];
  const highlight = predictions
    .slice()
    .sort((a, b) => {
      const order = { HIGH: 0, WARNING: 1, WATCH: 2, NORMAL: 3 };
      return (order[a.risk] ?? 9) - (order[b.risk] ?? 9);
    })
    .slice(0, 5);

  return (
    <>
      <HardwareModule
        icon="chart"
        title="Predictive Health"
        subtitle="Threshold degradation trends from SQLite history"
        headerRight={
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="hw-btn-filter px-3 py-1.5 text-xs"
              onClick={refresh}
              disabled={loading}
            >
              Refresh
            </button>
            <button
              type="button"
              className="hw-btn-filter px-3 py-1.5 text-xs"
              onClick={() => setDetailOpen(true)}
            >
              View Predictions
            </button>
          </div>
        }
      >
        {loading && !data ? (
          <p className="text-xs text-[#64748b]">Analyzing historical telemetry…</p>
        ) : error && !predictions.length ? (
          <p className="text-xs text-[#f87171]">{error}</p>
        ) : (
          <div className="space-y-2">
            {highlight.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
                style={{
                  background: "rgba(8, 12, 18, 0.75)",
                  borderColor: "rgba(34, 211, 238, 0.1)",
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-[#f1f5f9]">{p.metric}</span>
                    <StatusBadge
                      status={riskTone(p.risk)}
                      label={p.risk}
                      showDot={false}
                    />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-[#94a3b8]">
                    {p.summaryLine || p.message || "—"}
                  </p>
                </div>
              </div>
            ))}
            {!highlight.length && (
              <p className="text-xs text-[#64748b]">
                Prediction unavailable — insufficient historical data
              </p>
            )}
            <p className="pt-1 text-[10px] leading-relaxed text-[#64748b]">
              {data?.disclaimer || PREDICTIVE_DISCLAIMER}
            </p>
            {data?.sampleCount != null && (
              <p className="font-mono-metrics text-[10px] text-[#475569]">
                Window {data.rangeUsed || `${data.windowHours}h`} · {data.sampleCount} samples
                {data.generatedAt
                  ? ` · ${new Date(data.generatedAt).toLocaleTimeString()}`
                  : ""}
              </p>
            )}
          </div>
        )}
      </HardwareModule>

      {detailOpen && (
        <PredictiveMaintenanceDetail
          data={data}
          loading={loading}
          error={error}
          onClose={() => setDetailOpen(false)}
          onRefresh={refresh}
        />
      )}
    </>
  );
}
