/**
 * Recovery Recommendation Dialog — user selects a recovery action.
 */

import { useState } from "react";
import { RECOVERY_LEVEL_LABELS } from "../../recovery/recoveryActionCatalog";
import { StatusBadge } from "../ui/HardwareModule";

const PANEL = {
  bg: "rgba(12, 18, 28, 0.98)",
  border: "rgba(34, 211, 238, 0.2)",
  inner: "rgba(8, 12, 18, 0.9)",
};

function levelBadgeStatus(level) {
  if (level === 1) return "healthy";
  if (level === 2) return "warning";
  return "critical";
}

export function RecoveryRecommendationDialog({
  open,
  onClose,
  fault,
  analysis,
  onContinue,
}) {
  const [selectedId, setSelectedId] = useState(null);

  if (!open || !analysis) return null;

  const recommendations = analysis.recommendations || [];
  const target = analysis.target;
  const selected = recommendations.find((r) => r.actionId === selectedId);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: "rgba(4, 6, 8, 0.9)", backdropFilter: "blur(10px)" }}
      onClick={onClose}
    >
      <div
        className="hw-module max-h-[90vh] w-full max-w-lg overflow-y-auto !p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display text-lg font-bold text-[#f1f5f9]">Recovery Recommendation</h3>
        <p className="mt-1 text-xs text-[#64748b]">Review evidence and select an action</p>

        <div className="mt-4 space-y-3 rounded-lg border p-3" style={{ background: PANEL.inner, borderColor: PANEL.border }}>
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[#64748b]">Fault</span>
            <p className="text-sm text-[#f1f5f9]">
              {fault.component} · {fault.metricName || fault.faultDescription}
            </p>
          </div>
          {fault.currentValue && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-[#64748b]">Current Value</span>
                <p className="font-mono-metrics text-[#f1f5f9]">{fault.currentValue}</p>
              </div>
              {fault.thresholdCrossed && (
                <div>
                  <span className="text-[#64748b]">Threshold</span>
                  <p className="font-mono-metrics text-[#f59e0b]">{fault.thresholdCrossed}</p>
                </div>
              )}
            </div>
          )}
          {target?.process?.pid && (
            <div className="rounded border border-[#1e293b] p-2">
              <span className="text-[10px] font-semibold uppercase text-[#64748b]">Top Process</span>
              <p className="text-sm text-[#e2e8f0]">{target.process.name || "unknown"}</p>
              <p className="font-mono-metrics text-xs text-[#94a3b8]">
                PID {target.process.pid}
                {target.process.cpu != null && ` · ${target.process.cpu}% CPU`}
                {target.process.gpuCompute != null && ` · ${target.process.gpuCompute}% GPU`}
                {target.process.memory != null && ` · ${target.process.memory}% MEM`}
              </p>
            </div>
          )}
          {analysis.rca?.[0] && (
            <div>
              <span className="text-[10px] font-semibold uppercase text-[#64748b]">Reason</span>
              <p className="text-xs leading-relaxed text-[#94a3b8]">{analysis.rca[0]}</p>
            </div>
          )}
        </div>

        <div className="mt-4">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-[#64748b]">
            Recommended Actions
          </span>
          <div className="mt-2 space-y-2">
            {recommendations.map((rec) => (
              <label
                key={rec.actionId}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                  rec.disabled ? "cursor-not-allowed opacity-50" : "hover:border-[#38bdf8]/40"
                } ${selectedId === rec.actionId ? "border-[#38bdf8]/60" : ""}`}
                style={{ background: PANEL.inner, borderColor: PANEL.border }}
              >
                <input
                  type="radio"
                  name="recovery-action"
                  className="mt-1"
                  disabled={rec.disabled}
                  checked={selectedId === rec.actionId}
                  onChange={() => setSelectedId(rec.actionId)}
                />
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-[#f1f5f9]">{rec.label}</span>
                    <StatusBadge
                      status={levelBadgeStatus(rec.level)}
                      label={`L${rec.level} ${RECOVERY_LEVEL_LABELS[rec.level]}`}
                      showDot={false}
                    />
                    {!rec.supported && (
                      <span className="text-[10px] text-[#64748b]">Not available on host</span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-[#64748b]">{rec.reason}</p>
                  <p className="mt-1 text-[10px] italic text-[#475569]">Impact: {rec.impact}</p>
                  {rec.disabledReason && (
                    <p className="mt-1 text-[10px] text-[#f59e0b]">{rec.disabledReason}</p>
                  )}
                </div>
              </label>
            ))}
          </div>
        </div>

        {!analysis.capabilitiesAvailable && (
          <p className="mt-3 text-xs text-[#f59e0b]">
            Recovery API not detected on :5000 — only local telemetry refresh is executable. Other actions
            are shown but require POST /recovery/execute on the telemetry server.
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="hw-btn-filter px-4 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="hw-btn-primary px-4 py-2 text-sm font-semibold disabled:opacity-40"
            disabled={!selected || selected.disabled}
            onClick={() => onContinue(selected)}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
