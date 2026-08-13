/**
 * Detailed Predictive Maintenance view — explainable projections + trend graph.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { StatusBadge } from "../ui/HardwareModule";
import { PREDICTIVE_DISCLAIMER } from "../../services/predictiveMaintenance";
import { viz, theme } from "../../utils/theme";

function riskTone(risk) {
  if (risk === "HIGH") return "critical";
  if (risk === "WARNING" || risk === "WATCH") return "warning";
  return "healthy";
}

function formatAxisTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function PredictionChart({ prediction }) {
  const chartData = useMemo(() => {
    if (!prediction?.points?.length) return [];
    const hist = prediction.points.map((p) => ({
      tMs: p.tMs,
      historical: p.v,
      projected: null,
    }));
    if (prediction.hasPrediction && prediction.projected?.length >= 2) {
      const lastHist = hist[hist.length - 1];
      const projEnd = prediction.projected[prediction.projected.length - 1];
      return [
        ...hist,
        {
          tMs: lastHist.tMs,
          historical: lastHist.historical,
          projected: lastHist.historical,
        },
        {
          tMs: projEnd.tMs,
          historical: null,
          projected: projEnd.v,
        },
      ];
    }
    return hist;
  }, [prediction]);

  if (chartData.length < 3) {
    return (
      <p className="text-xs text-[#64748b]">
        Graph unavailable — insufficient meaningful historical samples.
      </p>
    );
  }

  return (
    <div
      className="h-[260px] rounded-lg"
      style={{
        background: "rgba(8, 12, 18, 0.6)",
        border: "1px solid rgba(34, 211, 238, 0.08)",
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 16, right: 20, left: 8, bottom: 12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={viz.grid} vertical={false} />
          <XAxis
            dataKey="tMs"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={formatAxisTime}
            tick={{ fill: theme.textMuted, fontSize: 10, fontFamily: "JetBrains Mono" }}
            axisLine={{ stroke: "rgba(34,211,238,0.1)" }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: theme.textMuted, fontSize: 10, fontFamily: "JetBrains Mono" }}
            axisLine={false}
            tickLine={false}
            unit={prediction.unit}
          />
          <Tooltip
            labelFormatter={(v) => new Date(v).toLocaleString()}
            contentStyle={{
              backgroundColor: viz.tooltipBg,
              border: "1px solid rgba(34, 211, 238, 0.2)",
              borderRadius: "8px",
              color: theme.textPrimary,
              fontFamily: "JetBrains Mono",
              fontSize: 11,
            }}
          />
          <Legend />
          <ReferenceLine
            y={prediction.warningThreshold}
            stroke="#f59e0b"
            strokeDasharray="4 4"
            label={{ value: "Warning", fill: "#f59e0b", fontSize: 10 }}
          />
          <ReferenceLine
            y={prediction.criticalThreshold}
            stroke="#ef4444"
            strokeDasharray="4 4"
            label={{ value: "Critical", fill: "#ef4444", fontSize: 10 }}
          />
          {prediction.currentValue != null && (
            <ReferenceLine
              y={prediction.currentValue}
              stroke="#38bdf8"
              strokeDasharray="2 2"
              label={{ value: "Current", fill: "#38bdf8", fontSize: 10 }}
            />
          )}
          <Line
            type="monotone"
            dataKey="historical"
            name="Historical"
            stroke="#22d3ee"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
          />
          {prediction.hasPrediction && (
            <Line
              type="linear"
              dataKey="projected"
              name="Projected trend"
              stroke="#a78bfa"
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={false}
              connectNulls
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function DetailCard({ prediction }) {
  const e = prediction.explanation || {};
  return (
    <article
      className="rounded-xl border p-4"
      style={{
        background: "rgba(12, 18, 28, 0.95)",
        borderColor: "rgba(34, 211, 238, 0.12)",
      }}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-display text-base font-semibold text-[#f1f5f9]">
            {prediction.metric}
          </h3>
          <p className="text-xs text-[#64748b]">
            {prediction.component} · {prediction.id}
          </p>
        </div>
        <StatusBadge status={riskTone(prediction.risk)} label={prediction.risk} />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-[#64748b]">Current</dt>
          <dd className="font-mono-metrics text-[#f1f5f9]">
            {prediction.currentValue != null
              ? `${Number(prediction.currentValue).toFixed(1)}${prediction.unit}`
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[#64748b]">Warning</dt>
          <dd className="font-mono-metrics text-[#fbbf24]">
            {prediction.warningThreshold}
            {prediction.unit}
          </dd>
        </div>
        <div>
          <dt className="text-[#64748b]">Critical</dt>
          <dd className="font-mono-metrics text-[#f87171]">
            {prediction.criticalThreshold}
            {prediction.unit}
          </dd>
        </div>
        <div>
          <dt className="text-[#64748b]">Trend</dt>
          <dd className="font-mono-metrics text-[#e2e8f0]">
            {prediction.trendRateLabel || "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[#64748b]">Window</dt>
          <dd className="font-mono-metrics text-[#e2e8f0]">
            {prediction.analysisWindowHours != null
              ? `${prediction.analysisWindowHours} hours`
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[#64748b]">Confidence</dt>
          <dd className="font-mono-metrics text-[#e2e8f0]">
            {prediction.confidence || "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[#64748b]">Est. warning</dt>
          <dd className="font-mono-metrics text-[#e2e8f0]">
            {prediction.estimatedTimeToWarningLabel || "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[#64748b]">Est. critical</dt>
          <dd className="font-mono-metrics text-[#e2e8f0]">
            {prediction.estimatedTimeToCriticalLabel || "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[#64748b]">Samples</dt>
          <dd className="font-mono-metrics text-[#e2e8f0]">
            {e.sampleCount ?? prediction.points?.length ?? "—"}
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-xs text-[#94a3b8]">
        {prediction.message ||
          prediction.summaryLine ||
          prediction.riskReason ||
          "—"}
      </p>

      <div
        className="mt-3 rounded-lg border px-3 py-2 text-[11px] leading-relaxed text-[#94a3b8]"
        style={{ borderColor: "rgba(34, 211, 238, 0.1)" }}
      >
        <p className="mb-1 font-medium text-[#cbd5e1]">How this was calculated</p>
        <ul className="list-inside list-disc space-y-0.5">
          <li>
            Current value:{" "}
            {e.currentValue != null ? `${e.currentValue}${prediction.unit}` : "—"}
          </li>
          <li>
            Thresholds: warning {e.warningThreshold}
            {prediction.unit}, critical {e.criticalThreshold}
            {prediction.unit}
          </li>
          <li>
            Historical period: last ~{e.analysisWindowHours ?? "—"} hours (
            {e.sampleCount ?? "—"} SQLite samples)
          </li>
          <li>
            Measured trend (OLS): {prediction.trendRateLabel || "—"}
            {e.rSquared != null ? ` · R²=${e.rSquared}` : ""}
          </li>
          <li>{e.formula || "time_to_threshold = (threshold − current) / slope"}</li>
          <li>Risk basis: {prediction.riskReason || e.riskBasis || "—"}</li>
        </ul>
      </div>

      <div className="mt-3">
        <PredictionChart prediction={prediction} />
      </div>
    </article>
  );
}

export function PredictiveMaintenanceDetail({
  data,
  loading,
  error,
  onClose,
  onRefresh,
}) {
  const predictions = useMemo(() => data?.predictions || [], [data?.predictions]);

  const defaultId = useMemo(() => {
    if (!predictions.length) return null;
    const preferred =
      predictions.find((p) => p.hasPrediction || p.risk === "HIGH") || predictions[0];
    return preferred.id;
  }, [predictions]);

  const [selectedId, setSelectedId] = useState(null);
  const activeId =
    selectedId && predictions.some((p) => p.id === selectedId)
      ? selectedId
      : defaultId;
  const selected = predictions.find((p) => p.id === activeId) || predictions[0];

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex flex-col"
      style={{ background: "rgba(2, 6, 12, 0.92)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Predictive Maintenance details"
    >
      <header
        className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-4"
        style={{ borderColor: "rgba(34, 211, 238, 0.12)" }}
      >
        <div>
          <h2 className="font-display text-lg font-semibold text-[#f1f5f9]">
            Predictive Maintenance
          </h2>
          <p className="mt-0.5 max-w-3xl text-xs text-[#64748b]">
            {PREDICTIVE_DISCLAIMER}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="hw-btn-filter px-3 py-1.5 text-xs"
            onClick={onRefresh}
            disabled={loading}
          >
            Refresh
          </button>
          <button
            type="button"
            className="hw-btn-filter px-3 py-1.5 text-xs"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error && (
          <p className="mb-3 text-sm text-[#f87171]">{error}</p>
        )}
        {loading && !predictions.length ? (
          <p className="text-sm text-[#64748b]">Loading SQLite history…</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
            <aside className="space-y-1">
              {predictions.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedId(p.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs"
                  style={{
                    background:
                      selected?.id === p.id
                        ? "rgba(34, 211, 238, 0.08)"
                        : "rgba(8, 12, 18, 0.8)",
                    borderColor:
                      selected?.id === p.id
                        ? "rgba(34, 211, 238, 0.35)"
                        : "rgba(34, 211, 238, 0.1)",
                  }}
                >
                  <span className="truncate text-[#e2e8f0]">{p.metric}</span>
                  <StatusBadge
                    status={riskTone(p.risk)}
                    label={p.risk}
                    showDot={false}
                  />
                </button>
              ))}
            </aside>
            <div>{selected ? <DetailCard prediction={selected} /> : null}</div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
