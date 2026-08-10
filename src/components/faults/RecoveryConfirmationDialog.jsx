/**
 * Recovery Confirmation Dialog — Level 2/3 approval gate.
 */

import { RECOVERY_LEVEL_LABELS } from "../../recovery/recoveryActionCatalog";

const PANEL = {
  inner: "rgba(8, 12, 18, 0.9)",
  border: "rgba(34, 211, 238, 0.2)",
};

export function RecoveryConfirmationDialog({ open, recommendation, onCancel, onProceed }) {
  if (!open || !recommendation) return null;

  const isHighRisk = recommendation.level >= 3;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      style={{ background: "rgba(4, 6, 8, 0.92)", backdropFilter: "blur(10px)" }}
      onClick={onCancel}
    >
      <div
        className="hw-module w-full max-w-md !p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className={`font-display text-lg font-bold ${isHighRisk ? "text-[#ef4444]" : "text-[#f59e0b]"}`}>
          {isHighRisk ? "High Risk Action" : "Confirm Recovery Action"}
        </h3>
        <p className="mt-1 text-xs text-[#64748b]">
          Level {recommendation.level} · {RECOVERY_LEVEL_LABELS[recommendation.level]}
        </p>

        <div
          className="mt-4 rounded-lg border p-4"
          style={{
            background: isHighRisk ? "rgba(239,68,68,0.08)" : PANEL.inner,
            borderColor: isHighRisk ? "rgba(239,68,68,0.3)" : PANEL.border,
          }}
        >
          <p className="text-sm text-[#e2e8f0]">
            You are about to execute: <strong>{recommendation.label}</strong>
          </p>

          {recommendation.target?.processName && (
            <div className="mt-3 font-mono-metrics text-sm text-[#94a3b8]">
              {recommendation.target.processName}
              {recommendation.target.pid && (
                <span className="ml-2 text-[#64748b]">PID {recommendation.target.pid}</span>
              )}
            </div>
          )}

          {recommendation.target?.interface && (
            <p className="mt-2 text-sm text-[#94a3b8]">Interface: {recommendation.target.interface}</p>
          )}

          {recommendation.target?.mount && (
            <p className="mt-2 text-sm text-[#94a3b8]">Mount: {recommendation.target.mount}</p>
          )}

          <p className="mt-4 text-xs leading-relaxed text-[#94a3b8]">
            <strong className="text-[#f1f5f9]">Impact:</strong> {recommendation.impact}
          </p>

          {isHighRisk && (
            <p className="mt-3 text-xs font-medium text-[#ef4444]">
              This action may interrupt applications and cause unsaved work to be lost.
            </p>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="hw-btn-filter px-4 py-2 text-sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-sm font-semibold rounded-lg ${
              isHighRisk
                ? "bg-[#b91c1c] text-white hover:bg-[#991b1b]"
                : "hw-btn-primary"
            }`}
            onClick={onProceed}
          >
            Proceed
          </button>
        </div>
      </div>
    </div>
  );
}
