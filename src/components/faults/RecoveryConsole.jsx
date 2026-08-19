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
  children,
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
      const actionKey = `${recommendation.backendAction || ""} ${recommendation.actionId || ""}`;
      const isTerminate = /kill|terminate/.test(actionKey);
      onRecoveryComplete?.({
        ...outcome,
        navigateToFaultDetection: Boolean(isTerminate && outcome?.verifying),
      });
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

  const dialogs = (
    <>
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
    </>
  );

  const slotProcess = showProcessCandidates ? (
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
  ) : null;

  const slotActionsInner = showRecommendations ? (
    <div className="min-w-0 space-y-3">
      {loading ? (
        <p className="text-sm text-[#64748b]">Generating recommendations…</p>
      ) : (
        <>
          {recommendations.length > 0 ? (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
                Recommended
              </p>
              {recommendations.slice(0, 6).map((rec) => (
                <div
                  key={rec.actionId}
                  className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 ${
                    rec.disabled ? "opacity-50" : ""
                  }`}
                  style={{ background: PANEL.inner, borderColor: PANEL.border }}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-[#f1f5f9]">{rec.label}</span>
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
                    <span className="shrink-0 font-mono-metrics text-[10px] text-[#64748b]">
                      {rec.confidence}%
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[#94a3b8]">No recovery actions available.</p>
          )}

          {!analysis?.capabilitiesAvailable ? (
            <p className="text-xs text-[#f59e0b]">
              Recovery API not detected on :5000 — ensure CM.py is running with GET
              /recovery/capabilities.
            </p>
          ) : null}

          {connected ? (
            <div className="flex flex-wrap gap-2">
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
            <p className="text-sm text-[#f59e0b]">Telemetry offline — recovery actions unavailable.</p>
          )}
        </>
      )}
    </div>
  ) : showManualNotice ? (
    <p className="text-sm text-[#94a3b8]">
      No automated recovery playbook for this fault. Review evidence and remediate
      manually.
    </p>
  ) : (
    <p className="text-sm text-[#94a3b8]">No recovery actions available.</p>
  );

  const slotStatus = (
    <div className="min-w-0 space-y-3">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">Status</p>
        <p className="mt-1 break-words font-mono-metrics text-sm font-semibold text-[#f1f5f9]">
          {executing
            ? "In progress"
            : result
              ? result.success
                ? "Completed"
                : result.partial
                  ? "Partial"
                  : result.aborted
                    ? "Aborted"
                    : "Failed"
              : loading
                ? "Analyzing…"
                : recoverable
                  ? "Ready"
                  : "Not available"}
        </p>
      </div>
      {result ? (
        <div
          className="rounded-lg border p-3"
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
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
            Recovery Result
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge
              status={result.success ? "healthy" : result.partial ? "warning" : "critical"}
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
                status={result.actionStatus === "ACTION_SUCCESS" ? "warning" : "critical"}
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
            <p className="mt-2 break-words text-sm text-[#cbd5e1]">{result.reason}</p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-[#94a3b8]">No recovery result yet.</p>
      )}
    </div>
  );

  const slotConfidence = showConfidence ? (
    <div className="flex flex-wrap items-center gap-4">
      <div
        className="relative flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-2"
        style={{
          borderColor:
            confidence.percent >= 75 ? "#22c55e" : confidence.percent >= 50 ? "#f59e0b" : "#64748b",
        }}
      >
        <span className="font-mono-metrics text-xl font-bold text-[#f1f5f9]">{confidence.percent}%</span>
      </div>
      <div className="min-w-0">
        {hasMeaningful(confidence.label) ? (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
              Confidence Level
            </p>
            <p className="mt-1 text-sm font-semibold text-[#f1f5f9]">{confidence.label}</p>
          </div>
        ) : null}
        {(confidence.factors || []).length > 0 ? (
          <div className="mt-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">Reason</p>
            <ul className="mt-1 space-y-0.5">
              {confidence.factors.map((f) => (
                <li key={f} className="break-words text-xs leading-snug text-[#94a3b8]">
                  {f}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  ) : (
    <p className="text-sm text-[#94a3b8]">No recovery confidence available.</p>
  );

  const slotHistory = showHistory ? (
    <div className="space-y-2 pr-1">
      {[...history].reverse().map((rec) => (
        <article
          key={rec.id}
          className="rounded-lg border p-3"
          style={{ background: PANEL.inner, borderColor: PANEL.border }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            {formatTime(rec.timestamp) ? (
              <span className="font-mono-metrics text-xs text-[#64748b]">{formatTime(rec.timestamp)}</span>
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
            <p className="mt-2 break-words text-xs text-[#e2e8f0]">
              {rec.selectedAction.label}
              {rec.selectedAction.level != null
                ? ` · L${rec.selectedAction.level} ${RECOVERY_LEVEL_LABELS[rec.selectedAction.level] || ""}`
                : ""}
            </p>
          ) : null}
          {hasMeaningful(rec.verificationOutcome || rec.reason) ? (
            <p className="mt-1 break-words text-xs text-[#64748b]">
              {rec.verificationOutcome || rec.reason}
            </p>
          ) : null}
        </article>
      ))}
    </div>
  ) : null;

  const slots = {
    dialogs,
    status: slotStatus,
    actions: (
      <div className="space-y-4">
        {slotProcess ? (
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
              Process Candidates
            </p>
            {slotProcess}
          </div>
        ) : null}
        {slotActionsInner}
      </div>
    ),
    confidence: slotConfidence,
    history: slotHistory,
  };

  if (typeof children === "function") {
    return (
      <div className="min-w-0">
        {dialogs}
        {children(slots)}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {dialogs}
      {slotProcess ? (
        <section className="rounded-xl border p-4" style={{ background: PANEL.bg, borderColor: PANEL.border }}>
          <SectionHeader title="Process Candidates" subtitle="Live workloads — pause, resume, or terminate per PID" />
          {slotProcess}
        </section>
      ) : null}
      {showRecommendations || showManualNotice ? (
        <section
          className="rounded-xl border p-4"
          style={{ background: PANEL.bg, borderColor: showManualNotice ? "rgba(239,68,68,0.2)" : PANEL.border }}
        >
          <SectionHeader title="Recovery Actions" subtitle={analysis?.catalog?.label || undefined} />
          {slotActionsInner}
        </section>
      ) : null}
      {showConfidence ? (
        <section className="rounded-xl border p-4" style={{ background: PANEL.bg, borderColor: PANEL.border }}>
          <SectionHeader title="Recovery Confidence" />
          {slotConfidence}
        </section>
      ) : null}
      {showHistory ? (
        <section className="rounded-xl border p-4" style={{ background: PANEL.bg, borderColor: PANEL.border }}>
          <SectionHeader title="Verification / Recovery History" />
          {slotHistory}
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
