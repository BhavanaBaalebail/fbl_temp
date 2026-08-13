/**
 * Recovery Console — recovery recommendations, execution, process candidates, history.
 * Diagnostic overview (fault summary / RCA / evidence) lives in FaultModal.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { hasRecoveryPlaybook } from "../../recovery/recoveryPlaybooks";
import { analyzeRecovery, executeApprovedRecovery } from "../../recovery/recoveryWorkflowEngine";
import {
  getRecoveryHistory,
  subscribeRecoveryHistory,
} from "../../recovery/recoveryHistoryService";
import { StatusBadge } from "../ui/HardwareModule";
import { RecoveryRecommendationDialog } from "./RecoveryRecommendationDialog";
import { RecoveryConfirmationDialog } from "./RecoveryConfirmationDialog";
import { RecoveryProcessCandidates } from "./RecoveryProcessCandidates";
import { RECOVERY_LEVEL_LABELS } from "../../recovery/recoveryActionCatalog";
import {
  faultShowsProcessCandidates,
  processCandidatesDomainForFault,
  processCandidatesMinPercent,
} from "../../recovery/recoveryProcessDomain";

const PANEL = {
  bg: "rgba(12, 18, 28, 0.95)",
  border: "rgba(34, 211, 238, 0.15)",
  inner: "rgba(8, 12, 18, 0.8)",
};

function SectionHeader({ title, subtitle }) {
  return (
    <div className="mb-2.5">
      <h3 className="font-display text-sm font-semibold uppercase tracking-[0.12em] text-[#94a3b8]">
        {title}
      </h3>
      {subtitle ? <p className="mt-0.5 text-xs text-[#64748b]">{subtitle}</p> : null}
    </div>
  );
}

function formatDuration(ms) {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function levelBadgeStatus(level) {
  if (level === 1) return "healthy";
  if (level === 2) return "warning";
  return "critical";
}

function hasMeaningful(value) {
  if (value == null) return false;
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return false;
    const lower = t.toLowerCase();
    if (lower === "n/a" || lower === "unknown" || lower === "—" || lower === "-") return false;
  }
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

/**
 * @param {"full"|"actions"} [mode="actions"]
 *   - actions: recovery UI only (used by full-screen FaultModal)
 *   - full: legacy self-contained console (kept for compatibility)
 */
export function RecoveryConsole({
  fault,
  connected = false,
  onRecoveryComplete,
  mode = "actions",
  hideHistory = false,
}) {
  const [analysisResult, setAnalysisResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState(() => getRecoveryHistory(fault?.id));
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState(null);
  const [showRecommendDialog, setShowRecommendDialog] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingRecommendation, setPendingRecommendation] = useState(null);
  const abortRef = useRef(null);

  const recoverable = hasRecoveryPlaybook(fault);
  const analyzable = recoverable || fault.source === "threshold";
  const analysis = analysisResult?.analysis;
  const capabilities = analysisResult?.capabilities;

  const refreshAnalysis = useCallback(async () => {
    if (!analyzable) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await analyzeRecovery(fault);
      setAnalysisResult(res);
    } catch {
      setAnalysisResult(null);
    } finally {
      setLoading(false);
    }
  }, [fault, analyzable]);

  useEffect(() => {
    let cancelled = false;
    const faultId = fault?.id;

    queueMicrotask(() => {
      if (!cancelled) setHistory(getRecoveryHistory(faultId));
    });

    (async () => {
      if (!analyzable) {
        if (!cancelled) {
          setLoading(false);
          setAnalysisResult(null);
        }
        return;
      }
      if (!cancelled) setLoading(true);
      try {
        const res = await analyzeRecovery(fault);
        if (!cancelled) setAnalysisResult(res);
      } catch {
        if (!cancelled) setAnalysisResult(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    const unsub = subscribeRecoveryHistory(() => {
      if (!cancelled) setHistory(getRecoveryHistory(faultId));
    });
    return () => {
      cancelled = true;
      unsub();
    };
    // Analyze once per fault id — not on every metrics/currentValue tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fault?.id, analyzable]);

  const runExecution = async (recommendation, confirmed) => {
    setExecuting(true);
    setResult(null);
    setShowConfirmDialog(false);
    setShowRecommendDialog(false);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const outcome = await executeApprovedRecovery(
        fault,
        recommendation,
        { confirmed, level: recommendation.level },
        { signal: controller.signal }
      );
      setResult(outcome);
      setHistory(getRecoveryHistory(fault.id));
      onRecoveryComplete?.(outcome);
    } catch (err) {
      setResult({ success: false, reason: err.message || "Recovery failed." });
    } finally {
      setExecuting(false);
      abortRef.current = null;
      setPendingRecommendation(null);
    }
  };

  const handleRecommendationContinue = (recommendation) => {
    setPendingRecommendation(recommendation);
    setShowRecommendDialog(false);
    if (recommendation.level >= 2) {
      setShowConfirmDialog(true);
    } else {
      runExecution(recommendation, true);
    }
  };

  const handleConfirmProceed = () => {
    if (pendingRecommendation) {
      runExecution(pendingRecommendation, true);
    }
  };

  const confidence = analysis?.confidence || null;
  const recommendations = analysis?.recommendations || [];
  const showConfidence =
    recoverable &&
    confidence &&
    (confidence.percent > 0 || (confidence.factors || []).length > 0);
  const showHistory = !hideHistory && history.length > 0;
  const showProcessCandidates = recoverable && faultShowsProcessCandidates(fault);
  const showRecommendations = recoverable;
  const showManualNotice = !recoverable && mode === "full";

  return (
    <div className="space-y-4">
      <RecoveryRecommendationDialog
        open={showRecommendDialog}
        onClose={() => setShowRecommendDialog(false)}
        fault={fault}
        analysis={analysis}
        onContinue={handleRecommendationContinue}
      />
      <RecoveryConfirmationDialog
        open={showConfirmDialog}
        recommendation={pendingRecommendation}
        onCancel={() => {
          setShowConfirmDialog(false);
          setPendingRecommendation(null);
        }}
        onProceed={handleConfirmProceed}
      />

      {showProcessCandidates ? (
        <section
          className="rounded-xl border p-4"
          style={{ background: PANEL.bg, borderColor: PANEL.border }}
        >
          <SectionHeader
            title="Process Candidates"
            subtitle="Live workloads — pause, resume, or terminate per PID"
          />
          <RecoveryProcessCandidates
            fault={fault}
            connected={connected}
            capabilities={capabilities}
            minPercent={processCandidatesMinPercent(processCandidatesDomainForFault(fault))}
            onActionComplete={(actionResult) => {
              refreshAnalysis();
              onRecoveryComplete?.(actionResult);
            }}
          />
        </section>
      ) : null}

      {showRecommendations ? (
        <section
          className="rounded-xl border p-4"
          style={{ background: PANEL.bg, borderColor: PANEL.border }}
        >
          <SectionHeader
            title="Recovery Actions"
            subtitle={analysis?.catalog?.label || undefined}
          />
          {loading ? (
            <p className="text-sm text-[#64748b]">Generating recommendations…</p>
          ) : (
            <>
              {recommendations.length > 0 ? (
                <div className="space-y-2">
                  {recommendations.slice(0, 6).map((rec) => (
                    <div
                      key={rec.actionId}
                      className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 ${
                        rec.disabled ? "opacity-50" : ""
                      }`}
                      style={{ background: PANEL.inner, borderColor: PANEL.border }}
                    >
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm text-[#e2e8f0]">{rec.label}</span>
                          <StatusBadge
                            status={levelBadgeStatus(rec.level)}
                            label={`L${rec.level}`}
                            showDot={false}
                          />
                        </div>
                        {hasMeaningful(rec.reason) ? (
                          <p className="mt-0.5 text-xs text-[#64748b]">{rec.reason}</p>
                        ) : null}
                        {hasMeaningful(rec.disabledReason) ? (
                          <p className="mt-0.5 text-[10px] text-[#f59e0b]">{rec.disabledReason}</p>
                        ) : null}
                      </div>
                      {rec.confidence != null ? (
                        <span className="font-mono-metrics text-[10px] text-[#64748b]">
                          {rec.confidence}%
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}

              {!analysis?.capabilitiesAvailable ? (
                <p className="mt-3 text-xs text-[#f59e0b]">
                  Recovery API not detected on :5000 — ensure CM.py is running with GET
                  /recovery/capabilities.
                </p>
              ) : null}

              {connected ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="hw-btn-primary px-4 py-2 text-sm font-semibold disabled:opacity-40"
                    disabled={executing || loading}
                    onClick={() => setShowRecommendDialog(true)}
                  >
                    {executing ? "Recovery In Progress…" : "Review Recovery Actions"}
                  </button>
                  {executing ? (
                    <button
                      type="button"
                      className="hw-btn-filter px-4 py-2 text-sm"
                      onClick={() => abortRef.current?.abort()}
                    >
                      Abort
                    </button>
                  ) : null}
                </div>
              ) : (
                <p className="mt-4 text-sm text-[#f59e0b]">
                  Telemetry offline — recovery actions unavailable.
                </p>
              )}

              {result ? (
                <div
                  className="mt-4 rounded-lg border p-3"
                  style={{
                    background: result.success
                      ? "rgba(34,197,94,0.08)"
                      : result.partial
                        ? "rgba(245,158,11,0.08)"
                        : "rgba(239,68,68,0.08)",
                    borderColor: result.success
                      ? "rgba(34,197,94,0.3)"
                      : result.partial
                        ? "rgba(245,158,11,0.3)"
                        : "rgba(239,68,68,0.3)",
                  }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      status={
                        result.success ? "healthy" : result.partial ? "warning" : "critical"
                      }
                      label={
                        result.recoveryStatus
                          ? String(result.recoveryStatus).replace(/_/g, " ")
                          : result.success
                            ? "Recovered"
                            : result.partial
                              ? "Still Active"
                              : result.aborted
                                ? "Aborted"
                                : "Recovery Failed"
                      }
                    />
                    {result.actionStatus ? (
                      <StatusBadge
                        status={
                          result.actionStatus === "ACTION_SUCCESS" ? "warning" : "critical"
                        }
                        label={String(result.actionStatus).replace(/_/g, " ")}
                        showDot={false}
                      />
                    ) : null}
                    {formatDuration(result.durationMs) ? (
                      <span className="font-mono-metrics text-xs text-[#64748b]">
                        {formatDuration(result.durationMs)}
                      </span>
                    ) : null}
                  </div>
                  {hasMeaningful(result.reason) ? (
                    <p className="mt-2 text-sm text-[#cbd5e1]">{result.reason}</p>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : showManualNotice ? (
        <section
          className="rounded-xl border p-4"
          style={{ background: PANEL.bg, borderColor: "rgba(239,68,68,0.2)" }}
        >
          <SectionHeader title="Recovery" />
          <p className="text-sm text-[#94a3b8]">
            No automated recovery playbook for this fault. Review evidence and remediate
            manually.
          </p>
        </section>
      ) : null}

      {showConfidence ? (
        <section
          className="rounded-xl border p-4"
          style={{ background: PANEL.bg, borderColor: PANEL.border }}
        >
          <SectionHeader title="Recovery Confidence" />
          <div className="flex flex-wrap items-center gap-4">
            <div
              className="relative flex h-16 w-16 items-center justify-center rounded-full border-2"
              style={{
                borderColor:
                  confidence.percent >= 75
                    ? "#22c55e"
                    : confidence.percent >= 50
                      ? "#f59e0b"
                      : "#64748b",
              }}
            >
              <span className="font-mono-metrics text-lg font-bold text-[#f1f5f9]">
                {confidence.percent}%
              </span>
            </div>
            <div>
              {hasMeaningful(confidence.label) ? (
                <div className="text-sm font-semibold text-[#f1f5f9]">
                  {confidence.label} Confidence
                </div>
              ) : null}
              {(confidence.factors || []).length > 0 ? (
                <ul className="mt-1 space-y-0.5">
                  {confidence.factors.map((f) => (
                    <li key={f} className="text-xs text-[#64748b]">
                      · {f}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {showHistory ? (
        <section
          className="rounded-xl border p-4"
          style={{ background: PANEL.bg, borderColor: PANEL.border }}
        >
          <SectionHeader title="Verification / Recovery History" />
          <div className="space-y-2 pr-1">
            {[...history].reverse().map((rec) => (
              <article
                key={rec.id}
                className="rounded-lg border p-3"
                style={{ background: PANEL.inner, borderColor: PANEL.border }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {formatTime(rec.timestamp) ? (
                    <span className="font-mono-metrics text-xs text-[#64748b]">
                      {formatTime(rec.timestamp)}
                    </span>
                  ) : (
                    <span />
                  )}
                  <StatusBadge
                    status={
                      rec.recoveryStatus === "RECOVERED" || rec.result === "success"
                        ? "healthy"
                        : rec.recoveryStatus === "STILL_ACTIVE" ||
                            rec.recoveryStatus === "VERIFICATION_UNAVAILABLE" ||
                            rec.result === "partial" ||
                            rec.result === "unverifiable" ||
                            rec.result === "aborted"
                          ? "warning"
                          : "critical"
                    }
                    label={
                      rec.recoveryStatus
                        ? String(rec.recoveryStatus).replace(/_/g, " ")
                        : rec.result === "success"
                          ? "Success"
                          : rec.result === "partial"
                            ? "Partial"
                            : rec.result
                    }
                    showDot={false}
                  />
                </div>
                {rec.selectedAction?.label ? (
                  <p className="mt-2 text-xs text-[#e2e8f0]">
                    {rec.selectedAction.label}
                    {rec.selectedAction.level != null
                      ? ` · L${rec.selectedAction.level} ${
                          RECOVERY_LEVEL_LABELS[rec.selectedAction.level] || ""
                        }`
                      : ""}
                  </p>
                ) : null}
                {hasMeaningful(rec.verificationOutcome || rec.reason) ? (
                  <p className="mt-1 text-xs text-[#64748b]">
                    {rec.verificationOutcome || rec.reason}
                  </p>
                ) : null}
                {(rec.before || rec.after) && (
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {(() => {
                      const beforeText = formatSnapshotBrief(rec.before, fault);
                      const afterText = formatSnapshotBrief(rec.after, fault);
                      return (
                        <>
                          {beforeText ? (
                            <div
                              className="rounded border px-2 py-1.5 text-[10px] text-[#94a3b8]"
                              style={{ borderColor: PANEL.border }}
                            >
                              <div className="font-semibold uppercase tracking-wider text-[#64748b]">
                                Before
                              </div>
                              <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap font-mono-metrics text-[10px] text-[#cbd5e1]">
                                {beforeText}
                              </pre>
                            </div>
                          ) : null}
                          {rec.selectedAction?.label ? (
                            <div
                              className="rounded border px-2 py-1.5 text-[10px] text-[#94a3b8]"
                              style={{ borderColor: PANEL.border }}
                            >
                              <div className="font-semibold uppercase tracking-wider text-[#64748b]">
                                Action
                              </div>
                              <p className="mt-1 text-[#e2e8f0]">{rec.selectedAction.label}</p>
                            </div>
                          ) : null}
                          {afterText ? (
                            <div
                              className="rounded border px-2 py-1.5 text-[10px] text-[#94a3b8]"
                              style={{ borderColor: PANEL.border }}
                            >
                              <div className="font-semibold uppercase tracking-wider text-[#64748b]">
                                After
                              </div>
                              <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap font-mono-metrics text-[10px] text-[#cbd5e1]">
                                {afterText}
                              </pre>
                            </div>
                          ) : null}
                        </>
                      );
                    })()}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function formatSnapshotBrief(snapshot, fault) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const parts = [];
  const pick = [
    ["cpu", snapshot.cpu],
    ["ram", snapshot.ram],
    ["gpu", snapshot.gpu],
    ["disk", snapshot.disk],
    ["metric", snapshot.metric ?? snapshot.value ?? fault?.currentValue],
  ];
  for (const [k, v] of pick) {
    if (v == null || v === "") continue;
    parts.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  }
  if (!parts.length) {
    // Fall back to a few flat keys only — never dump full JSON blobs
    for (const [k, v] of Object.entries(snapshot)) {
      if (v == null || typeof v === "object") continue;
      parts.push(`${k}: ${v}`);
      if (parts.length >= 4) break;
    }
  }
  return parts.length ? parts.join("\n") : null;
}
