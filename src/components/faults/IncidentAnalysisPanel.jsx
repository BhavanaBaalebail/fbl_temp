/**
 * Incident Analysis Utilities — run allowlisted diagnostics for an Active Fault.
 */

import { useCallback, useEffect, useState } from "react";
import { incidentAnalysisApi } from "../../services/incidentAnalysisApi";
import { StatusBadge } from "../ui/HardwareModule";
import { IncidentDiagnosticCli } from "./IncidentDiagnosticCli";

const SURFACE = {
  panel: "rgba(12, 18, 28, 0.92)",
  border: "rgba(34, 211, 238, 0.14)",
  inner: "rgba(8, 12, 18, 0.85)",
};

function statusTone(status) {
  const s = String(status || "Ready").toUpperCase();
  if (s === "COMPLETED") return "healthy";
  if (s === "RUNNING" || s === "QUEUED") return "warning";
  if (s === "FAILED" || s === "TIMEOUT") return "critical";
  return "info";
}

function formatWhen(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function UtilityCard({ meta, result, busy, onRun, compact }) {
  const status = result?.status || (meta?.script_configured ? "Ready" : "Ready");
  const parsed = result?.parsed || {};
  const isRca = meta?.id === "rca";
  const isPid = meta?.id === "pid500";

  return (
    <article
      className="flex min-w-0 flex-col rounded-lg border p-3"
      style={{ background: SURFACE.inner, borderColor: SURFACE.border }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-[#f1f5f9]">{meta.label}</h4>
          <p className="mt-1 text-[11px] leading-snug text-[#94a3b8]">{meta.purpose}</p>
        </div>
        <StatusBadge status={statusTone(status)} label={String(status).toUpperCase()} />
      </div>
      {meta.requires_root ? (
        <p className="mt-2 text-[10px] uppercase tracking-wider text-[#f59e0b]">
          Root may be required · FBL does not enable passwordless sudo
        </p>
      ) : null}
      <button
        type="button"
        disabled={busy || status === "RUNNING" || status === "QUEUED"}
        onClick={() => onRun(meta.id)}
        className="mt-3 rounded-md border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#67e8f9] transition-colors hover:border-[rgba(34,211,238,0.45)] disabled:opacity-40"
        style={{ borderColor: SURFACE.border, background: "rgba(34,211,238,0.06)" }}
      >
        {status === "RUNNING" || status === "QUEUED" ? "Running..." : "Run Analysis"}
      </button>

      {result ? (
        <div className="mt-3 space-y-2 border-t pt-2" style={{ borderColor: "rgba(34,211,238,0.08)" }}>
          {result.demo ? (
            <div className="rounded-md border border-[rgba(245,158,11,0.35)] bg-[rgba(245,158,11,0.08)] px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-[#fbbf24]">
              Demo mode — simulated output, not live server evidence
            </div>
          ) : null}
          {status === "COMPLETED" ? (
            <p className="text-xs font-semibold text-[#34d399]">✓ Completed</p>
          ) : status === "FAILED" || status === "TIMEOUT" ? (
            <p className="text-xs font-semibold text-[#f87171]">✕ Failed</p>
          ) : null}
          {isRca && !parsed.primary_root_cause && !parsed.insufficient && status === "COMPLETED" ? (
            <p className="text-xs text-[#94a3b8]">No RCA result available</p>
          ) : null}
          {result.error ? (
            <p className="text-[11px] text-[#94a3b8]">
              Recommended action: {result.recommended_action}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2 text-[10px] text-[#64748b]">
            <div>Start {formatWhen(result.started_at)}</div>
            <div>End {formatWhen(result.completed_at)}</div>
          </div>
          {result.output_location ? (
            <p className="truncate font-mono-metrics text-[10px] text-[#64748b]" title={result.output_location}>
              Output: {result.output_location}
            </p>
          ) : null}

          {isRca && parsed.primary_root_cause ? (
            <div className="rounded-md border px-3 py-2" style={{ borderColor: "rgba(56,189,248,0.35)" }}>
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#38bdf8]">
                Primary Root Cause
              </div>
              <div className="mt-1 text-base font-semibold text-[#f1f5f9]">{parsed.primary_root_cause}</div>
              {(parsed.contributing_factors || []).length > 0 ? (
                <ul className="mt-2 space-y-1 text-[11px] text-[#cbd5e1]">
                  {(parsed.contributing_factors || []).map((item) => (
                    <li key={item}>✓ {item}</li>
                  ))}
                </ul>
              ) : null}
              {(parsed.affected_subsystems || []).length > 0 ? (
                <p className="mt-2 text-[11px] text-[#94a3b8]">
                  Affected: {(parsed.affected_subsystems || []).join(" · ")}
                </p>
              ) : null}
            </div>
          ) : null}
          {isRca && parsed.insufficient ? (
            <p className="text-xs text-[#94a3b8]">Insufficient evidence to determine primary root cause.</p>
          ) : null}

          {isPid && (parsed.processes || []).length > 0 ? (
            <ul className="space-y-1.5 text-xs text-[#e2e8f0]">
              {parsed.processes.map((proc) => (
                <li key={`${proc.pid}-${proc.cpu_percent}`}>
                  High CPU Process Detected · PID {proc.pid} · {proc.process} · {proc.cpu_percent}%
                </li>
              ))}
            </ul>
          ) : null}

          {!compact && (result.findings || []).length > 0 && !isRca ? (
            <ul className="space-y-1 text-[11px] text-[#cbd5e1]">
              {result.findings.slice(0, 6).map((line) => (
                <li key={line} className="line-clamp-2">
                  • {line}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {result.html_report_available ? (
              <a
                href={incidentAnalysisApi.reportUrl(result.execution_id)}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] font-semibold uppercase tracking-wider text-[#67e8f9]"
              >
                Open HTML Report
              </a>
            ) : null}
            {result.execution_id ? (
              <a
                href={incidentAnalysisApi.rawUrl(result.execution_id)}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] font-semibold uppercase tracking-wider text-[#94a3b8]"
              >
                {status === "FAILED" || status === "TIMEOUT" ? "View Error" : "View Result"}
              </a>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-[11px] text-[#64748b]">Latest result: none yet for this incident.</p>
      )}
    </article>
  );
}

export function IncidentAnalysisPanel({ incidentId, compact = false }) {
  const [catalog, setCatalog] = useState([]);
  const [demoMode, setDemoMode] = useState(false);
  const [results, setResults] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [story, setStory] = useState(null);
  const [error, setError] = useState(null);

  const loadCatalog = useCallback(async () => {
    const res = await incidentAnalysisApi.utilities();
    if (!res.ok) {
      setError(res.data?.error || "Incident analysis backend unavailable");
      return;
    }
    setError(null);
    setCatalog(res.data.utilities || []);
    setDemoMode(Boolean(res.data.demo_mode));
  }, []);

  const loadHistory = useCallback(async () => {
    if (!incidentId) return;
    const res = await incidentAnalysisApi.history(incidentId);
    if (!res.ok) return;
    const next = {};
    for (const row of res.data.history || []) {
      const uid = row.utility_id;
      if (!uid) continue;
      if (!next[uid] || String(row.started_at || "") > String(next[uid].started_at || "")) {
        next[uid] = row;
      }
    }
    setResults(next);
    const sum = await incidentAnalysisApi.summary(incidentId);
    if (sum.ok) setStory(sum.data);
  }, [incidentId]);

  useEffect(() => {
    loadCatalog();
    loadHistory();
  }, [loadCatalog, loadHistory]);

  useEffect(() => {
    const running = Object.values(results).filter((r) => r.status === "RUNNING" || r.status === "QUEUED");
    if (running.length === 0) return undefined;
    const timer = setInterval(async () => {
      for (const row of running) {
        const res = await incidentAnalysisApi.status(row.execution_id);
        if (res.ok && res.data?.execution_id) {
          setResults((prev) => ({ ...prev, [res.data.utility_id]: res.data }));
        }
      }
      if (incidentId) {
        const sum = await incidentAnalysisApi.summary(incidentId);
        if (sum.ok) setStory(sum.data);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [results, incidentId]);

  const onRun = async (utilityId) => {
    setBusyId(utilityId);
    const res = await incidentAnalysisApi.run(utilityId, { incident_id: incidentId, fault_id: incidentId });
    setBusyId(null);
    if (!res.ok) {
      setError(res.data?.error || "Unable to start analysis");
      return;
    }
    setResults((prev) => ({ ...prev, [utilityId]: res.data }));
  };

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-[#94a3b8]">
        Incident Analysis collects evidence. It does not remediate. Self Healing remains a separate
        recovery step after RCA.
      </p>
      {demoMode ? (
        <div className="rounded-md border border-[rgba(245,158,11,0.4)] px-3 py-2 text-[11px] text-[#fbbf24]">
          DEMO MODE is active on the collector. Simulated utility output is labeled and never mixed
          with live captures from the same run.
        </div>
      ) : null}
      {error ? <p className="text-xs text-[#f87171]">{error}</p> : null}

      <IncidentDiagnosticCli incidentId={incidentId} />

      {story && (story.primary_root_cause || story.insufficient) ? (
        <div className="rounded-lg border p-3" style={{ borderColor: SURFACE.border, background: SURFACE.panel }}>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#64748b]">
            Incident Analysis
          </div>
          {story.demo ? (
            <p className="mt-1 text-[11px] font-semibold text-[#fbbf24]">Includes simulated evidence</p>
          ) : null}
          <p className="mt-2 text-sm text-[#e2e8f0]">
            What failed? {story.what_failed || "Not determined"}
          </p>
          <p className="mt-1 text-sm font-semibold text-[#f1f5f9]">
            Primary Root Cause{" "}
            {story.primary_root_cause || "Insufficient evidence to determine primary root cause."}
          </p>
          {(story.what_was_observed || []).length > 0 ? (
            <ul className="mt-2 space-y-1 text-[11px] text-[#cbd5e1]">
              {story.what_was_observed.slice(0, 6).map((line) => (
                <li key={line}>• {line}</li>
              ))}
            </ul>
          ) : null}
          {(story.evidence || []).length > 0 ? (
            <p className="mt-2 text-[10px] uppercase tracking-wider text-[#64748b]">
              Evidence {story.evidence.join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className={`grid gap-3 ${compact ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1 lg:grid-cols-2 xl:grid-cols-3"}`}>
        {(catalog.length ? catalog : []).map((meta) => (
          <UtilityCard
            key={meta.id}
            meta={meta}
            result={results[meta.id]}
            busy={busyId === meta.id}
            onRun={onRun}
            compact={compact}
          />
        ))}
      </div>
    </div>
  );
}

export function IncidentAnalysisArchitecture() {
  const box = "rounded-md border px-3 py-2 text-center text-[11px] text-[#e2e8f0]";
  const style = { borderColor: SURFACE.border, background: SURFACE.inner };
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#64748b]">
        Mock / demo architecture
      </p>
      <div className="flex flex-col items-center gap-2">
        <div className={box} style={style}>
          Monitored Server
        </div>
        <div className="h-4 w-px bg-[rgba(34,211,238,0.35)]" />
        <div className={box} style={style}>
          FBL Monitoring · CPU / GPU / RAM / Disk / NIC / IO
        </div>
        <div className="h-4 w-px bg-[rgba(34,211,238,0.35)]" />
        <div className={box} style={style}>
          Fault Detection → Active Fault Log
        </div>
        <div className="grid w-full max-w-3xl grid-cols-2 gap-3">
          <div className={box} style={style}>
            <div className="font-semibold text-[#67e8f9]">Incident Analysis Utilities</div>
            <div className="mt-1 text-[#94a3b8]">
              Analyze · Health · Unified RCA · Forensic · Stall · Pid500
            </div>
          </div>
          <div className={box} style={style}>
            <div className="font-semibold text-[#67e8f9]">Self Healing</div>
            <div className="mt-1 text-[#94a3b8]">Remediation · then Verification</div>
          </div>
        </div>
        <div className="h-4 w-px bg-[rgba(34,211,238,0.35)]" />
        <div className={box} style={style}>
          Evidence & Reports → Unified RCA / Incident Summary
        </div>
      </div>
    </div>
  );
}
