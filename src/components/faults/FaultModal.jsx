/**
 * Full-screen Fault Detail View — compact incident layout (portal + scroll lock).
 * Analysis runs once per fault id; telemetry ticks do not remount/reanalyze.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { enrichThresholdFaultWithTelemetry } from "../../services/linkHealthService";
import { resolvedLogEntries } from "../../data/faultData";
import { hasRecoveryPlaybook } from "../../recovery/recoveryPlaybooks";
import {
  getLatestRecovery,
  getRecoveryHistory,
  isFaultAutoRecovered,
  subscribeRecoveryHistory,
} from "../../recovery/recoveryHistoryService";
import { analyzeRecovery } from "../../recovery/recoveryWorkflowEngine";
import { faultShowsProcessCandidates } from "../../recovery/recoveryProcessDomain";
import { StatusBadge } from "../ui/HardwareModule";
import { RecoveryConsole } from "./RecoveryConsole";
import { theme } from "../../utils/theme";

const SURFACE = {
  bg: "rgba(10, 14, 22, 0.98)",
  panel: "rgba(12, 18, 28, 0.92)",
  border: "rgba(34, 211, 238, 0.14)",
  inner: "rgba(8, 12, 18, 0.85)",
};

const PRIORITY_METRIC_LABELS = new Set([
  "Current value",
  "Threshold",
  "Health",
  "Detail status",
]);

function hasMeaningful(value) {
  if (value == null) return false;
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return false;
    const lower = t.toLowerCase();
    if (
      lower === "n/a" ||
      lower === "na" ||
      lower === "unknown" ||
      lower === "—" ||
      lower === "-" ||
      lower === "null" ||
      lower === "undefined"
    ) {
      return false;
    }
  }
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function formatTime(value) {
  if (!hasMeaningful(value)) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime()) && String(value).includes("T")) {
    return d.toLocaleString();
  }
  return String(value);
}

function severityTone(severity) {
  const s = String(severity || "").toLowerCase();
  if (s.includes("crit")) return theme.critical;
  if (s.includes("warn")) return theme.warning;
  if (s.includes("resolv") || s.includes("health")) return theme.healthy;
  return "#64748b";
}

function severityStatus(severity) {
  const s = String(severity || "").toLowerCase();
  if (s.includes("crit")) return "critical";
  if (s.includes("warn")) return "warning";
  return "healthy";
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
    for (const [k, v] of Object.entries(snapshot)) {
      if (v == null || typeof v === "object") continue;
      parts.push(`${k}: ${v}`);
      if (parts.length >= 4) break;
    }
  }
  return parts.length ? parts.join(" · ") : null;
}

function StatCard({ label, value, accent }) {
  if (!hasMeaningful(value)) return null;
  return (
    <div
      className="rounded-lg border px-3 py-2"
      style={{
        background: SURFACE.inner,
        borderColor: SURFACE.border,
        borderLeft: accent ? `3px solid ${accent}` : undefined,
      }}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono-metrics text-sm font-semibold text-[#f1f5f9]">
        {String(value)}
      </div>
    </div>
  );
}

function PanelCard({ title, children, className = "" }) {
  if (!children) return null;
  return (
    <section
      className={`rounded-lg border p-3 ${className}`}
      style={{ background: SURFACE.panel, borderColor: SURFACE.border }}
    >
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#64748b]">
        {title}
      </h3>
      {children}
    </section>
  );
}

function EvidenceCell({ label, value }) {
  if (!hasMeaningful(value)) return null;
  return (
    <div
      className="min-w-0 flex-1 rounded-md border px-3 py-2"
      style={{ background: SURFACE.inner, borderColor: SURFACE.border }}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#64748b]">
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono-metrics text-xs text-[#e2e8f0]">
        {String(value)}
      </div>
    </div>
  );
}

function MetricStrip({ pairs }) {
  const rows = (pairs || []).filter(([, v]) => hasMeaningful(v));
  if (!rows.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="min-w-[7.5rem] flex-1 rounded-md border px-2.5 py-1.5 sm:max-w-[12rem]"
          style={{ background: SURFACE.inner, borderColor: SURFACE.border }}
        >
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#64748b]">
            {label}
          </div>
          <div className="mt-0.5 truncate font-mono-metrics text-[11px] text-[#e2e8f0]">
            {String(value)}
          </div>
        </div>
      ))}
    </div>
  );
}

function VerificationPanel({ faultId, fault }) {
  const [history, setHistory] = useState(() => getRecoveryHistory(faultId));

  useEffect(() => {
    if (!faultId) return undefined;
    return subscribeRecoveryHistory(() => {
      setHistory(getRecoveryHistory(faultId));
    });
  }, [faultId]);

  const latest = history.length ? history[history.length - 1] : null;
  if (!latest) return null;

  const before = formatSnapshotBrief(latest.before, fault);
  const after = formatSnapshotBrief(latest.after, fault);
  const result =
    latest.verificationOutcome ||
    (latest.recoveryStatus ? String(latest.recoveryStatus).replace(/_/g, " ") : null) ||
    latest.reason;

  if (!hasMeaningful(before) && !hasMeaningful(after) && !hasMeaningful(result)) {
    return null;
  }

  return (
    <PanelCard title="Verification">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <EvidenceCell label="Before" value={before} />
        <EvidenceCell label="After" value={after} />
        <EvidenceCell label="Result" value={result} />
      </div>
      {latest.selectedAction?.label ? (
        <p className="mt-2 text-[11px] text-[#94a3b8]">
          {latest.selectedAction.label}
          {latest.selectedAction.level != null
            ? ` · L${latest.selectedAction.level}`
            : ""}
        </p>
      ) : null}
    </PanelCard>
  );
}

function buildTelemetryEvidence(fault) {
  const detail = fault.telemetryDetail || {};
  const type = detail.type;
  const pairs = [];

  const push = (label, value, suffix = "") => {
    if (!hasMeaningful(value) && value !== 0) return;
    pairs.push([label, suffix ? `${value}${suffix}` : value]);
  };

  if (type === "disk_performance" || type === "io_performance") {
    push("Device", detail.device);
    push("Transport", detail.transport);
    push("Busy", detail.busy_percent, "%");
    push("Queue depth", detail.queue_depth);
    push("Avg latency", detail.average_latency_ms, " ms");
    push("Read", detail.read_MB_per_sec, " MB/s");
    push("Write", detail.write_MB_per_sec, " MB/s");
    push("Throughput", detail.total_MB_per_sec, " MB/s");
    push("Read IOPS", detail.read_IOPS);
    push("Write IOPS", detail.write_IOPS);
  } else if (type === "gpu_metrics") {
    push("Model", detail.model);
    push("PCI Bus", detail.pci_bus_id);
    push("Temperature", detail.temperature_celsius, "°C");
    push("Utilization", detail.gpu_utilization_percent, "%");
    push("VRAM", detail.memory_utilization_percent, "%");
    push("VRAM used", detail.memory_used_mb, " MB");
    push("Power", detail.power_draw_watts, " W");
    push("Fan", detail.fan_speed_percent, "%");
    push("Graphics clock", detail.graphics_clock_mhz, " MHz");
    push("PCIe link", detail.link_status);
  } else if (type === "cpu_metrics") {
    push("Usage", detail.usage_percent, "%");
    push("User", detail.user_percent, "%");
    push("System", detail.system_percent, "%");
    push("IO Wait", detail.iowait_percent, "%");
    push("Load 1m", detail.load_1min);
    push("MHz", detail.current_mhz);
    push("Temperature", detail.temperature_celsius, "°C");
  } else if (type === "nic_metrics") {
    push("Interface", detail.interface);
    push("Link", detail.link_state);
    push("Speed", detail.speed);
    push("Duplex", detail.duplex);
    push("RX errors", detail.rx_errors);
    push("TX errors", detail.tx_errors);
    push("RX dropped", detail.rx_dropped);
    push("TX dropped", detail.tx_dropped);
    push("RX", detail.rx_mbps, " Mbps");
    push("TX", detail.tx_mbps, " Mbps");
    push("RX util", detail.rx_utilization_percent, "%");
    push("TX util", detail.tx_utilization_percent, "%");
    if (detail.network_connectivity != null) {
      push("Connectivity", detail.network_connectivity ? "Reachable" : "Unreachable");
    }
    push("Default route", detail.default_route_interface);
    if (detail.top_process_pid) {
      push(
        "Top process",
        `PID ${detail.top_process_pid}${
          detail.top_process_name ? ` · ${detail.top_process_name}` : ""
        }${
          detail.top_process_total_kbps != null
            ? ` · ${detail.top_process_total_kbps} KB/s`
            : ""
        }`
      );
    }
  } else {
    push("Metric", detail.metricName || fault.metricName);
    push("Current value", detail.currentValue ?? fault.currentValue);
  }

  push("Threshold", detail.thresholdCrossed ?? fault.thresholdCrossed);
  push("Health", detail.health);
  push("Detail status", detail.status);

  return pairs;
}

function buildKernelEvidence(fault) {
  const ev = fault.kernelEvent;
  if (!ev) return [];
  const pairs = [];
  const push = (label, value) => {
    if (hasMeaningful(value)) pairs.push([label, value]);
  };
  push("Category", ev.category);
  push("Device", ev.device);
  push("Timestamp", formatTime(ev.timestamp) || ev.timestamp);
  return pairs;
}

function getPrimaryMetricValue(fault) {
  const detail = fault.telemetryDetail || {};
  const candidates = [
    fault.currentValue,
    detail.currentValue,
    detail.usage_percent != null ? `${detail.usage_percent}%` : null,
    detail.gpu_utilization_percent != null ? `${detail.gpu_utilization_percent}%` : null,
    detail.busy_percent != null ? `${detail.busy_percent}%` : null,
    detail.memory_utilization_percent != null ? `${detail.memory_utilization_percent}%` : null,
    fault.metricName,
    detail.metricName,
  ];
  return candidates.find((v) => hasMeaningful(v)) || null;
}

function getPriorityEvidence(fault, displayStatus, latestRecovery) {
  const detail = fault.telemetryDetail || {};
  const current =
    fault.currentValue ??
    detail.currentValue ??
    (detail.usage_percent != null ? `${detail.usage_percent}%` : null) ??
    (detail.gpu_utilization_percent != null ? `${detail.gpu_utilization_percent}%` : null) ??
    (detail.busy_percent != null ? `${detail.busy_percent}%` : null);
  const threshold = fault.thresholdCrossed ?? detail.thresholdCrossed;
  const previous = latestRecovery?.before
    ? formatSnapshotBrief(latestRecovery.before, fault)
    : null;
  const status = displayStatus ?? detail.health ?? detail.status;
  return { current, threshold, previous, status };
}

export function FaultModal({
  fault,
  onClose,
  connected = false,
  liveMetrics = null,
  liveLinkHealth = null,
  liveInventory = null,
  onRecoveryComplete,
}) {
  const [analysisResult, setAnalysisResult] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [recoveryHistory, setRecoveryHistory] = useState([]);
  const analyzedIdRef = useRef(null);

  const [faultForView] = useState(() => {
    if (!fault) return null;
    if (fault.source === "threshold" && liveMetrics) {
      return enrichThresholdFaultWithTelemetry(
        fault,
        liveMetrics,
        liveLinkHealth,
        liveInventory
      );
    }
    return fault;
  });

  const faultId = faultForView?.id || faultForView?.faultId || null;

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!faultId) {
      setRecoveryHistory([]);
      return undefined;
    }
    setRecoveryHistory(getRecoveryHistory(faultId));
    return subscribeRecoveryHistory(() => {
      setRecoveryHistory(getRecoveryHistory(faultId));
    });
  }, [faultId]);

  useEffect(() => {
    if (!faultForView || !faultId) return undefined;
    if (analyzedIdRef.current === faultId && analysisResult) return undefined;

    const analyzable =
      hasRecoveryPlaybook(faultForView) || faultForView.source === "threshold";

    let cancelled = false;

    (async () => {
      if (!analyzable) {
        analyzedIdRef.current = faultId;
        if (!cancelled) {
          setAnalysisResult(null);
          setAnalysisLoading(false);
        }
        return;
      }
      if (!cancelled) setAnalysisLoading(true);
      try {
        const res = await analyzeRecovery(faultForView);
        if (!cancelled) {
          analyzedIdRef.current = faultId;
          setAnalysisResult(res);
        }
      } catch {
        if (!cancelled) {
          analyzedIdRef.current = faultId;
          setAnalysisResult(null);
        }
      } finally {
        if (!cancelled) setAnalysisLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally once per faultId
  }, [faultId]);

  if (!faultForView) return null;

  const autoRecovered = isFaultAutoRecovered(faultForView.id);
  const displayStatus = autoRecovered
    ? "Recovered"
    : faultForView.recoveryStatus && faultForView.recoveryStatus !== "RECOVERED"
      ? faultForView.status || "Active"
      : faultForView.status;
  const recoverable = hasRecoveryPlaybook(faultForView);

  const analysis = analysisResult?.analysis;
  const evidenceItems = (analysis?.evidence?.items || []).filter(
    (item) => hasMeaningful(item?.label) && hasMeaningful(item?.value)
  );
  const rcaLines = (analysis?.rca || []).filter((line) => hasMeaningful(line));

  const description =
    faultForView.kernelEvent?.message ||
    faultForView.faultDescription ||
    resolvedLogEntries[faultForView.component]?.summary ||
    null;

  const telemetryPairs = buildTelemetryEvidence(faultForView);
  const kernelPairs = buildKernelEvidence(faultForView);
  const metricPairs = [
    ...telemetryPairs,
    ...kernelPairs,
    ...evidenceItems.map((item) => [item.label, item.value]),
  ];
  const seen = new Set();
  const uniqueMetrics = metricPairs.filter(([label]) => {
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });

  const latestRecovery = recoveryHistory.length
    ? recoveryHistory[recoveryHistory.length - 1]
    : getLatestRecovery(faultId);
  const priorityEvidence = getPriorityEvidence(faultForView, displayStatus, latestRecovery);
  const secondaryMetrics = uniqueMetrics.filter(
    ([label]) => !PRIORITY_METRIC_LABELS.has(label)
  );

  const detected = formatTime(faultForView.detected) || faultForView.detected;
  const accent = faultForView.componentDot || severityTone(faultForView.severity);
  const metricHeadline = getPrimaryMetricValue(faultForView);

  const showRecoverySection =
    recoverable || faultShowsProcessCandidates(faultForView);

  const hasVerification =
    recoveryHistory.length > 0 &&
    (() => {
      const latest = recoveryHistory[recoveryHistory.length - 1];
      const before = formatSnapshotBrief(latest?.before, faultForView);
      const after = formatSnapshotBrief(latest?.after, faultForView);
      const result =
        latest?.verificationOutcome ||
        latest?.recoveryStatus ||
        latest?.reason;
      return (
        hasMeaningful(before) || hasMeaningful(after) || hasMeaningful(result)
      );
    })();

  const hasPriorityEvidence =
    hasMeaningful(priorityEvidence.current) ||
    hasMeaningful(priorityEvidence.threshold) ||
    hasMeaningful(priorityEvidence.previous) ||
    hasMeaningful(priorityEvidence.status);

  const hasSecondaryMetrics = secondaryMetrics.some(([, v]) => hasMeaningful(v));
  const showMetricsSection =
    hasPriorityEvidence || hasSecondaryMetrics || analysisLoading;

  const showBottomRow = showRecoverySection || hasVerification;

  const overlay = (
    <div
      className="fixed inset-0 z-[200] flex h-[100dvh] flex-col"
      style={{ background: SURFACE.bg, width: "100vw" }}
      role="dialog"
      aria-modal="true"
      aria-label="Fault details"
    >
      <header
        className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2 sm:px-4"
        style={{
          background: "rgba(8, 12, 18, 0.98)",
          borderColor: SURFACE.border,
        }}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md border px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-[#94a3b8] transition-colors hover:border-[rgba(34,211,238,0.35)] hover:text-[#f1f5f9]"
            style={{ borderColor: SURFACE.border }}
          >
            ← Back
          </button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-sm font-bold uppercase tracking-[0.08em] text-[#f1f5f9] sm:text-base">
                Fault Details
              </h1>
              {hasMeaningful(faultForView.severity) ? (
                <StatusBadge
                  status={severityStatus(faultForView.severity)}
                  label={String(faultForView.severity).toUpperCase()}
                />
              ) : null}
              {displayStatus === "Recovered" ? (
                <StatusBadge status="healthy" label="Recovered" />
              ) : null}
            </div>
            <p className="truncate font-mono-metrics text-[11px] text-[#64748b]">
              {[
                hasMeaningful(faultId) ? String(faultId) : null,
                hasMeaningful(faultForView.component) ? faultForView.component : null,
                hasMeaningful(detected) ? detected : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 px-1 text-xl leading-none text-[#94a3b8] transition-colors hover:text-[#f1f5f9]"
          onClick={onClose}
          aria-label="Close fault details"
        >
          ×
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex max-w-[1680px] flex-col gap-3 p-3 sm:p-4">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <StatCard
              label="Component"
              value={faultForView.component || faultForView.metricName}
              accent={accent}
            />
            <StatCard label="Severity" value={faultForView.severity} />
            <StatCard label="Status" value={displayStatus} />
            <StatCard label="Metric" value={metricHeadline} />
          </div>

          {(hasMeaningful(description) || rcaLines.length > 0 || analysisLoading) && (
            <div
              className={`grid gap-3 ${
                hasMeaningful(description) && (rcaLines.length > 0 || analysisLoading)
                  ? "lg:grid-cols-2"
                  : "grid-cols-1"
              }`}
            >
              {hasMeaningful(description) ? (
                <PanelCard title="What Happened">
                  <p className="line-clamp-4 text-sm leading-snug text-[#e2e8f0]">
                    {description}
                  </p>
                </PanelCard>
              ) : null}

              {rcaLines.length > 0 ? (
                <PanelCard title="Root Cause">
                  <ul className="space-y-1.5">
                    {rcaLines.slice(0, 4).map((line) => (
                      <li
                        key={line}
                        className="flex gap-2 text-sm leading-snug text-[#cbd5e1]"
                      >
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#38bdf8]" />
                        <span className="line-clamp-2">{line}</span>
                      </li>
                    ))}
                  </ul>
                </PanelCard>
              ) : analysisLoading ? (
                <PanelCard title="Root Cause">
                  <p className="text-sm text-[#64748b]">Analyzing telemetry…</p>
                </PanelCard>
              ) : null}
            </div>
          )}

          {showMetricsSection ? (
            <PanelCard title="Metrics / Evidence">
              {hasPriorityEvidence ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <EvidenceCell label="Current" value={priorityEvidence.current} />
                  <EvidenceCell label="Threshold" value={priorityEvidence.threshold} />
                  <EvidenceCell label="Previous" value={priorityEvidence.previous} />
                  <EvidenceCell label="Status" value={priorityEvidence.status} />
                </div>
              ) : analysisLoading ? (
                <p className="text-sm text-[#64748b]">Collecting evidence…</p>
              ) : null}
              {hasSecondaryMetrics ? (
                <div className={hasPriorityEvidence ? "mt-2 border-t border-[rgba(34,211,238,0.08)] pt-2" : ""}>
                  <MetricStrip pairs={secondaryMetrics} />
                </div>
              ) : null}
            </PanelCard>
          ) : null}

          {showBottomRow ? (
            <div
              className={`grid gap-3 ${
                showRecoverySection && hasVerification ? "lg:grid-cols-2" : "grid-cols-1"
              }`}
            >
              {showRecoverySection ? (
                <PanelCard title="Recovery" className="min-w-0">
                  <div className="[&_.rounded-xl]:rounded-lg [&_.rounded-xl]:border [&_.p-4]:p-3 [&_.space-y-4]:space-y-2 [&_section]:border-0 [&_section]:p-0 [&_section]:shadow-none">
                    <RecoveryConsole
                      fault={faultForView}
                      connected={connected}
                      mode="actions"
                      hideHistory
                      onRecoveryComplete={onRecoveryComplete}
                    />
                  </div>
                </PanelCard>
              ) : null}

              {hasVerification ? (
                <VerificationPanel faultId={faultId} fault={faultForView} />
              ) : null}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );

  return createPortal(overlay, document.body);
}
