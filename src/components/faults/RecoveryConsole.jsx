/**
 * Autonomous Recovery Console — enterprise incident response UI for Active Fault Log.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { hasRecoveryPlaybook } from "../../recovery/recoveryPlaybooks";
import {
  buildRecoveryContext,
  executeRecovery,
  RECOVERY_PHASES,
} from "../../recovery/recoveryEngine";
import {
  getRecoveryHistory,
  subscribeRecoveryHistory,
} from "../../recovery/recoveryHistoryService";
import { StatusBadge } from "../ui/HardwareModule";

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
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
  );
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

function PhaseIcon({ status }) {
  if (status === "done") return <span className="text-[#22c55e]">✓</span>;
  if (status === "running") return <span className="animate-pulse text-[#38bdf8]">⟳</span>;
  if (status === "failed") return <span className="text-[#ef4444]">✗</span>;
  if (status === "skipped") return <span className="text-[#64748b]">—</span>;
  return <span className="text-[#475569]">…</span>;
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

function compareSnapshots(before, after) {
  if (!before || !after) return [];
  const keys = [
    ["cpu_usage", "CPU Usage", "%"],
    ["cpu_temp", "CPU Temp", "°C"],
    ["mem_usage", "Memory Usage", "%"],
    ["mem_swap", "Swap Usage", "%"],
    ["gpu_temp", "GPU Temp", "°C"],
    ["gpu_util", "GPU Util", "%"],
    ["gpu_vram", "VRAM", "%"],
    ["gpu_power", "Power Draw", "W"],
    ["nic_errors", "NIC Errors", ""],
    ["nic_up", "Interfaces Up", ""],
    ["lh_score", "Link Health Score", ""],
  ];
  return keys
    .filter(([k]) => before[k] != null || after[k] != null)
    .map(([k, label, suffix]) => ({
      label,
      before: before[k] != null ? `${before[k]}${suffix}` : "—",
      after: after[k] != null ? `${after[k]}${suffix}` : "—",
      changed: before[k] !== after[k],
    }));
}

export function RecoveryConsole({ fault, connected = false, onRecoveryComplete }) {
  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState([]);
  const [executing, setExecuting] = useState(false);
  const [timeline, setTimeline] = useState([]);
  const [result, setResult] = useState(null);
  const [currentStep, setCurrentStep] = useState(null);
  const abortRef = useRef(null);

  const recoverable = hasRecoveryPlaybook(fault);

  const refreshContext = useCallback(async () => {
    if (!recoverable) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const ctx = await buildRecoveryContext(fault);
      setContext(ctx);
    } catch {
      setContext(null);
    } finally {
      setLoading(false);
    }
  }, [fault, recoverable]);

  useEffect(() => {
    refreshContext();
    setHistory(getRecoveryHistory(fault.id));
    return subscribeRecoveryHistory(() => setHistory(getRecoveryHistory(fault.id)));
  }, [fault.id, refreshContext]);

  const handleExecute = async () => {
    if (!recoverable || !connected || executing) return;
    setExecuting(true);
    setResult(null);
    setTimeline(RECOVERY_PHASES.map((p) => ({ ...p, status: "pending" })));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const outcome = await executeRecovery(fault, {
        signal: controller.signal,
        onPhaseUpdate: setTimeline,
        onStepUpdate: setCurrentStep,
      });
      setResult(outcome);
      setHistory(getRecoveryHistory(fault.id));
      onRecoveryComplete?.(outcome);
    } catch (err) {
      setResult({ success: false, reason: err.message || "Recovery failed." });
    } finally {
      setExecuting(false);
      abortRef.current = null;
    }
  };

  const handleAbort = () => {
    abortRef.current?.abort();
  };

  const severityStatus =
    fault.severity === "Critical"
      ? "critical"
      : fault.severity === "Warning"
        ? "warning"
        : "healthy";

  const displayStatus =
    result?.success
      ? "Auto Recovered"
      : history.some((h) => h.result === "success")
        ? "Auto Recovered"
        : fault.status;

  const confidence = context?.confidence || { percent: 0, label: "Not Available", factors: [] };
  const evidence = context?.evidence?.items || [];
  const rca = context?.rca || [];
  const planSteps = context?.planSteps || [];

  return (
    <div className="space-y-5">
      {/* 1. Fault Summary */}
      <section
        className="rounded-xl border p-4"
        style={{ background: PANEL.bg, borderColor: PANEL.border, borderLeft: `3px solid ${fault.componentDot || "#38bdf8"}` }}
      >
        <SectionHeader title="Fault Summary" subtitle="Active incident record" />
        <MetricGrid>
          <MetricCell label="Component" value={fault.component} />
          <MetricCell label="Severity" value={fault.severity} />
          <MetricCell
            label="Detection Time"
            value={formatTime(fault.detected)}
          />
          <MetricCell label="Current Status" value={displayStatus} />
        </MetricGrid>
        {fault.faultDescription && (
          <p className="mt-3 text-sm leading-relaxed text-[#94a3b8]">{fault.faultDescription}</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <StatusBadge status={severityStatus} label={fault.severity} />
          {displayStatus === "Auto Recovered" && (
            <StatusBadge status="healthy" label="Auto Recovered" />
          )}
          {!connected && <StatusBadge status="critical" label="Telemetry Offline" />}
        </div>
      </section>

      {/* 2. Evidence Collected */}
      <section
        className="rounded-xl border p-4"
        style={{ background: PANEL.bg, borderColor: PANEL.border }}
      >
        <SectionHeader
          title="Evidence Collected"
          subtitle="Live metrics from /inventory · /metrics · /link_health"
        />
        {loading ? (
          <p className="text-sm text-[#64748b]">Collecting telemetry evidence…</p>
        ) : evidence.length === 0 ? (
          <p className="text-sm text-[#64748b]">
            No additional telemetry fields available for this fault.
          </p>
        ) : (
          <MetricGrid>
            {evidence.map((item) => (
              <MetricCell key={`${item.label}-${item.value}`} label={item.label} value={item.value} />
            ))}
          </MetricGrid>
        )}
      </section>

      {/* 3. Root Cause Analysis */}
      <section
        className="rounded-xl border p-4"
        style={{ background: PANEL.bg, borderColor: PANEL.border }}
      >
        <SectionHeader
          title="Root Cause Analysis"
          subtitle="Evidence-based diagnosis — no inferred causes"
        />
        {loading ? (
          <p className="text-sm text-[#64748b]">Analyzing telemetry…</p>
        ) : rca.length === 0 ? (
          <p className="text-sm text-[#64748b]">
            Insufficient telemetry to determine root cause. Manual investigation required.
          </p>
        ) : (
          <ul className="space-y-2">
            {rca.map((line) => (
              <li
                key={line}
                className="flex gap-2 text-sm leading-relaxed text-[#cbd5e1]"
              >
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#38bdf8]" />
                {line}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 4. Recovery Plan */}
      {recoverable && (
        <section
          className="rounded-xl border p-4"
          style={{ background: PANEL.bg, borderColor: PANEL.border }}
        >
          <SectionHeader
            title="Recovery Plan"
            subtitle={context?.playbook?.label || "Telemetry-driven recovery workflow"}
          />
          <ol className="space-y-2">
            {planSteps.map((step, i) => (
              <li
                key={step}
                className="flex items-start gap-3 rounded-lg border px-3 py-2 text-sm text-[#e2e8f0]"
                style={{ background: PANEL.inner, borderColor: PANEL.border }}
              >
                <span className="font-mono-metrics text-xs text-[#38bdf8]">{String(i + 1).padStart(2, "0")}</span>
                {step}
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-[#64748b]">
            Recovery uses telemetry monitoring and verification only — no unsupported shell commands.
          </p>
        </section>
      )}

      {!recoverable && (
        <section
          className="rounded-xl border p-4"
          style={{ background: PANEL.bg, borderColor: "rgba(239,68,68,0.2)" }}
        >
          <SectionHeader title="Recovery Plan" subtitle="Manual intervention required" />
          <p className="text-sm text-[#94a3b8]">
            No automated recovery playbook is available for this fault class. Hardware errors,
            SMART failures, and uncorrectable ECC require operator action.
          </p>
        </section>
      )}

      {/* 5. Recovery Confidence */}
      {recoverable && (
        <section
          className="rounded-xl border p-4"
          style={{ background: PANEL.bg, borderColor: PANEL.border }}
        >
          <SectionHeader title="Recovery Confidence" />
          <div className="flex flex-wrap items-center gap-4">
            <div
              className="relative flex h-20 w-20 items-center justify-center rounded-full border-2"
              style={{
                borderColor:
                  confidence.percent >= 75
                    ? "#22c55e"
                    : confidence.percent >= 50
                      ? "#f59e0b"
                      : "#64748b",
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

      {/* 6. Execute Recovery */}
      {recoverable && (
        <section
          className="rounded-xl border p-4"
          style={{ background: PANEL.bg, borderColor: PANEL.border }}
        >
          <SectionHeader
            title="Execute Recovery"
            subtitle="Validate → Monitor → Verify workflow"
          />

          {!connected ? (
            <p className="text-sm text-[#f59e0b]">
              Cannot execute recovery — monitoring backend is offline.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="hw-btn-primary px-4 py-2 text-sm font-semibold disabled:opacity-40"
                disabled={executing || loading}
                onClick={handleExecute}
              >
                {executing ? "Recovery In Progress…" : "Execute Recovery"}
              </button>
              {executing && (
                <button
                  type="button"
                  className="hw-btn-filter px-4 py-2 text-sm"
                  onClick={handleAbort}
                >
                  Abort
                </button>
              )}
            </div>
          )}

          {(executing || timeline.length > 0) && (
            <div className="mt-4 space-y-2">
              {(timeline.length ? timeline : RECOVERY_PHASES.map((p) => ({ ...p, status: "pending" }))).map(
                (phase) => (
                  <div
                    key={phase.id}
                    className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm"
                    style={{ background: PANEL.inner, borderColor: PANEL.border }}
                  >
                    <PhaseIcon status={phase.status} />
                    <span
                      className={
                        phase.status === "running"
                          ? "font-medium text-[#38bdf8]"
                          : phase.status === "done"
                            ? "text-[#22c55e]"
                            : phase.status === "failed"
                              ? "text-[#ef4444]"
                              : "text-[#94a3b8]"
                      }
                    >
                      {phase.label}
                    </span>
                  </div>
                )
              )}
              {currentStep?.step && executing && (
                <p className="text-xs text-[#64748b]">
                  Current: {currentStep.step.label || currentStep.step}
                </p>
              )}
            </div>
          )}

          {result && (
            <div
              className="mt-4 rounded-lg border p-4"
              style={{
                background: result.success ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
                borderColor: result.success ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)",
              }}
            >
              <div className="flex items-center gap-2">
                <StatusBadge
                  status={result.success ? "healthy" : "critical"}
                  label={
                    result.success
                      ? "Recovery Successful"
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

              {!result.success && (
                <p className="mt-2 text-xs text-[#f59e0b]">
                  Recommend manual intervention — review evidence and escalate if condition persists.
                </p>
              )}

              {result.actionsExecuted?.length > 0 && (
                <div className="mt-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
                    Actions Performed
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {result.actionsExecuted.map((a) => (
                      <li key={a} className="text-xs text-[#94a3b8]">
                        · {a}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {result.before && result.after && (
                <div className="mt-4">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
                    Before / After Metrics
                  </div>
                  <div className="mt-2 overflow-x-auto">
                    <table className="hw-table min-w-full text-xs">
                      <thead>
                        <tr>
                          <th>Metric</th>
                          <th>Before</th>
                          <th>After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {compareSnapshots(result.before, result.after).map((row) => (
                          <tr key={row.label}>
                            <td>{row.label}</td>
                            <td className="font-mono-metrics">{row.before}</td>
                            <td
                              className="font-mono-metrics"
                              style={{ color: row.changed ? "#38bdf8" : undefined }}
                            >
                              {row.after}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* 7. Recovery History */}
      <section
        className="rounded-xl border p-4"
        style={{ background: PANEL.bg, borderColor: PANEL.border }}
      >
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
                    status={rec.result === "success" ? "healthy" : rec.result === "aborted" ? "warning" : "critical"}
                    label={rec.result === "success" ? "Success" : rec.result === "aborted" ? "Aborted" : "Failed"}
                    showDot={false}
                  />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <div>
                    <span className="text-[#64748b]">Duration</span>
                    <div className="font-mono-metrics text-[#e2e8f0]">{formatDuration(rec.durationMs)}</div>
                  </div>
                  <div className="col-span-2">
                    <span className="text-[#64748b]">Verification</span>
                    <div className="text-[#e2e8f0]">{rec.verificationOutcome || "—"}</div>
                  </div>
                </div>
                {rec.actionsExecuted?.length > 0 && (
                  <div className="mt-2">
                    <span className="text-[10px] uppercase tracking-wide text-[#64748b]">Actions</span>
                    <p className="text-xs text-[#94a3b8]">{rec.actionsExecuted.join(" · ")}</p>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
