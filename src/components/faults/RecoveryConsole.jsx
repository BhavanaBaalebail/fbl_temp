/**
 * Recovery Console — enterprise incident response assistant.
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
import { faultShowsProcessCandidates, processCandidatesDomainForFault, processCandidatesMinPercent } from "../../recovery/recoveryProcessDomain";

const PANEL = {
  bg: "rgba(12, 18, 28, 0.95)",
  border: "rgba(34, 211, 238, 0.15)",
  inner: "rgba(8, 12, 18, 0.8)",
};

function SectionHeader({ title, subtitle }) {
  return (
    <div className="mb-3">
      <h3 className="font-display text-sm font-semibold uppercase tracking-[0.12em] text-[#94a3b8]">
        {title}
      </h3>
      {subtitle && <p className="mt-0.5 text-xs text-[#64748b]">{subtitle}</p>}
    </div>
  );
}

function MetricGrid({ children }) {
  return <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

function MetricCell({ label, value }) {
  return (
    <div
      className="rounded-lg border px-3 py-2"
      style={{ background: PANEL.inner, borderColor: PANEL.border }}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
        {label}
      </div>
      <div className="mt-1 font-mono-metrics text-sm text-[#f1f5f9]">{value || "—"}</div>
    </div>
  );
}

function formatDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function levelBadgeStatus(level) {
  if (level === 1) return "healthy";
  if (level === 2) return "warning";
  return "critical";
}

export function RecoveryConsole({ fault, connected = false, onRecoveryComplete }) {
  const [analysisResult, setAnalysisResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState([]);
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
    refreshAnalysis();
    setHistory(getRecoveryHistory(fault.id));
    return subscribeRecoveryHistory(() => setHistory(getRecoveryHistory(fault.id)));
  }, [fault.id, fault.currentValue, refreshAnalysis]);

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
        {
          signal: controller.signal,
        }
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

  const severityStatus =
    fault.severity === "Critical" ? "critical" : fault.severity === "Warning" ? "warning" : "healthy";

  const displayStatus =
    result?.success
      ? "Recovered"
      : history.some((h) => h.result === "success")
        ? "Recovered"
        : fault.status;

  const confidence = analysis?.confidence || { percent: 0, label: "Not Available", factors: [] };
  const evidence = analysis?.evidence?.items || [];
  const rca = analysis?.rca || [];
  const recommendations = analysis?.recommendations || [];

  return (
    <div className="space-y-5">
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

      {/* Fault Summary */}
      <section
        className="rounded-xl border p-4"
        style={{
          background: PANEL.bg,
          borderColor: PANEL.border,
          borderLeft: `3px solid ${fault.componentDot || "#38bdf8"}`,
        }}
      >
        <SectionHeader title="Fault Summary" subtitle="Active incident record" />
        <MetricGrid>
          <MetricCell label="Component" value={fault.component} />
          <MetricCell label="Severity" value={fault.severity} />
          <MetricCell label="Detection Time" value={formatTime(fault.detected)} />
          <MetricCell label="Current Status" value={displayStatus} />
        </MetricGrid>
        {fault.faultDescription && (
          <p className="mt-3 text-sm leading-relaxed text-[#94a3b8]">{fault.faultDescription}</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <StatusBadge status={severityStatus} label={fault.severity} />
          {displayStatus === "Recovered" && (
            <StatusBadge status="healthy" label="Recovered" />
          )}
          {!connected && <StatusBadge status="critical" label="Telemetry Offline" />}
        </div>
      </section>

      {/* Evidence */}
      <section className="rounded-xl border p-4" style={{ background: PANEL.bg, borderColor: PANEL.border }}>
        <SectionHeader title="Evidence Collected" subtitle="Live metrics from /inventory · /metrics · /link_health" />
        {loading ? (
          <p className="text-sm text-[#64748b]">Collecting telemetry evidence…</p>
        ) : evidence.length === 0 ? (
          <p className="text-sm text-[#64748b]">No additional telemetry fields available.</p>
        ) : (
          <MetricGrid>
            {evidence.map((item) => (
              <MetricCell key={`${item.label}-${item.value}`} label={item.label} value={item.value} />
            ))}
          </MetricGrid>
        )}
      </section>

      {recoverable && faultShowsProcessCandidates(fault) && (
        <section className="rounded-xl border p-4" style={{ background: PANEL.bg, borderColor: PANEL.border }}>
          <SectionHeader
            title="Process Candidates"
            subtitle="Live workloads from GET /recovery/process_candidates · pause, resume, or terminate per PID"
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
      )}

      {/* RCA */}
      <section className="rounded-xl border p-4" style={{ background: PANEL.bg, borderColor: PANEL.border }}>
        <SectionHeader title="Root Cause Analysis" subtitle="Evidence-based diagnosis" />
        {loading ? (
          <p className="text-sm text-[#64748b]">Analyzing telemetry…</p>
        ) : rca.length === 0 ? (
          <p className="text-sm text-[#64748b]">Insufficient telemetry for root cause analysis.</p>
        ) : (
          <ul className="space-y-2">
            {rca.map((line) => (
              <li key={line} className="flex gap-2 text-sm leading-relaxed text-[#cbd5e1]">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#38bdf8]" />
                {line}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recommendations */}
      {recoverable ? (
        <section className="rounded-xl border p-4" style={{ background: PANEL.bg, borderColor: PANEL.border }}>
          <SectionHeader
            title="Recovery Recommendations"
            subtitle={analysis?.catalog?.label || "Intelligent recovery assistant"}
          />
          {loading ? (
            <p className="text-sm text-[#64748b]">Generating recommendations…</p>
          ) : (
            <>
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
                      <p className="mt-0.5 text-xs text-[#64748b]">{rec.reason}</p>
                      {rec.disabledReason && (
                        <p className="mt-0.5 text-[10px] text-[#f59e0b]">{rec.disabledReason}</p>
                      )}
                    </div>
                    <span className="font-mono-metrics text-[10px] text-[#64748b]">{rec.confidence}%</span>
                  </div>
                ))}
              </div>
        {!analysis?.capabilitiesAvailable && (
          <p className="mt-3 text-xs text-[#f59e0b]">
            Recovery API not detected on :5000 — ensure CM.py is running with GET /recovery/capabilities.
            Unsupported actions are shown until the backend is reachable.
          </p>
        )}
              {connected && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="hw-btn-primary px-4 py-2 text-sm font-semibold disabled:opacity-40"
                    disabled={executing || loading}
                    onClick={() => setShowRecommendDialog(true)}
                  >
                    {executing ? "Recovery In Progress…" : "Review Recovery Actions"}
                  </button>
                  {executing && (
                    <button
                      type="button"
                      className="hw-btn-filter px-4 py-2 text-sm"
                      onClick={() => abortRef.current?.abort()}
                    >
                      Abort
                    </button>
                  )}
                </div>
              )}
              {!connected && (
                <p className="mt-4 text-sm text-[#f59e0b]">Telemetry offline — recovery actions unavailable.</p>
              )}
              {result && (
                <div
                  className="mt-4 rounded-lg border p-4"
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
                  <div className="flex items-center gap-2">
                    <StatusBadge
                      status={result.success ? "healthy" : result.partial ? "warning" : "critical"}
                      label={
                        result.success
                          ? "Recovery Successful"
                          : result.partial
                            ? "Partially Improved"
                            : result.aborted
                              ? "Recovery Aborted"
                              : "Recovery Failed"
                      }
                    />
                    {result.durationMs != null && (
                      <span className="font-mono-metrics text-xs text-[#64748b]">
                        {formatDuration(result.durationMs)}
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-sm text-[#cbd5e1]">{result.reason}</p>
                </div>
              )}
            </>
          )}
        </section>
      ) : (
        <section
          className="rounded-xl border p-4"
          style={{ background: PANEL.bg, borderColor: "rgba(239,68,68,0.2)" }}
        >
          <SectionHeader title="Recovery Recommendations" subtitle="Manual intervention required" />
          <p className="text-sm text-[#94a3b8]">
            No automated recommendations for this fault class. Hardware errors require operator action.
          </p>
        </section>
      )}

      {/* Confidence */}
      {recoverable && (
        <section className="rounded-xl border p-4" style={{ background: PANEL.bg, borderColor: PANEL.border }}>
          <SectionHeader title="Recovery Confidence" />
          <div className="flex flex-wrap items-center gap-4">
            <div
              className="relative flex h-20 w-20 items-center justify-center rounded-full border-2"
              style={{
                borderColor:
                  confidence.percent >= 75 ? "#22c55e" : confidence.percent >= 50 ? "#f59e0b" : "#64748b",
              }}
            >
              <span className="font-mono-metrics text-xl font-bold text-[#f1f5f9]">
                {confidence.percent}%
              </span>
            </div>
            <div>
              <div className="text-sm font-semibold text-[#f1f5f9]">{confidence.label} Confidence</div>
              <ul className="mt-1 space-y-0.5">
                {(confidence.factors || []).map((f) => (
                  <li key={f} className="text-xs text-[#64748b]">
                    · {f}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {/* History */}
      <section className="rounded-xl border p-4" style={{ background: PANEL.bg, borderColor: PANEL.border }}>
        <SectionHeader title="Recovery History" subtitle="Session recovery execution log" />
        {history.length === 0 ? (
          <p className="text-sm text-[#64748b]">No recovery executions recorded for this fault.</p>
        ) : (
          <div className="space-y-3">
            {[...history].reverse().map((rec) => (
              <article
                key={rec.id}
                className="rounded-lg border p-3"
                style={{ background: PANEL.inner, borderColor: PANEL.border }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono-metrics text-xs text-[#64748b]">
                    {formatTime(rec.timestamp)}
                  </span>
                  <StatusBadge
                    status={
                      rec.result === "success"
                        ? "healthy"
                        : rec.result === "partial"
                          ? "warning"
                          : rec.result === "aborted"
                            ? "warning"
                            : "critical"
                    }
                    label={rec.result === "success" ? "Success" : rec.result === "partial" ? "Partial" : rec.result}
                    showDot={false}
                  />
                </div>
                {rec.selectedAction && (
                  <p className="mt-2 text-xs text-[#e2e8f0]">
                    {rec.selectedAction.label}
                    {rec.selectedAction.level != null &&
                      ` · L${rec.selectedAction.level} ${RECOVERY_LEVEL_LABELS[rec.selectedAction.level]}`}
                  </p>
                )}
                <p className="mt-1 text-xs text-[#64748b]">{rec.verificationOutcome || rec.reason}</p>
                {rec.confirmationGiven != null && (
                  <p className="mt-1 text-[10px] text-[#475569]">
                    Confirmation: {rec.confirmationGiven ? "Yes" : "No"}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
