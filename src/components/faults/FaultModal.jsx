/**
 * Fault Modal Component
 * Displays detailed fault information and autonomous recovery console
 */

import { enrichThresholdFaultWithTelemetry } from "../../services/linkHealthService";
import { resolvedLogEntries } from "../../data/faultData";
import { hasRecoveryPlaybook } from "../../recovery/recoveryPlaybooks";
import { isFaultAutoRecovered } from "../../recovery/recoveryHistoryService";
import { RecoveryConsole } from "./RecoveryConsole";
import { theme } from "../../utils/theme";

const PANEL = {
  bg: "rgba(12, 18, 28, 0.95)",
  border: "rgba(34, 211, 238, 0.15)",
  inner: "rgba(8, 12, 18, 0.8)",
};

export function FaultModal({
  fault,
  onClose,
  connected = false,
  liveMetrics = null,
  liveLinkHealth = null,
  liveInventory = null,
  onRecoveryComplete,
}) {
  if (!fault) return null;

  const faultForView =
    fault.source === "threshold" && liveMetrics
      ? enrichThresholdFaultWithTelemetry(fault, liveMetrics, liveLinkHealth, liveInventory)
      : fault;

  const showRecovery =
    faultForView.source === "threshold" ||
    hasRecoveryPlaybook(faultForView) ||
    (faultForView.status === "Active" && faultForView.source !== "kernel_event");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(4, 6, 8, 0.85)", backdropFilter: "blur(8px)" }}
      onClick={onClose}
    >
      <div
        className="hw-module max-h-[92vh] w-full max-w-[900px] overflow-y-auto !p-6"
        style={{ animation: "modalFadeIn 220ms ease-out" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-xl font-bold text-[#f1f5f9]">
              Fault Detail Console
            </h2>
            <p className="mt-1 text-sm text-[#64748b]">
              {fault.component} · Active Fault Log · Recovery Console
            </p>
          </div>
          <button
            type="button"
            className="text-2xl leading-none text-[#94a3b8] transition-colors hover:text-[#f1f5f9]"
            onClick={onClose}
            aria-label="Close fault details modal"
          >
            ×
          </button>
        </div>

        {faultForView.source === "kernel_event" && faultForView.kernelEvent ? (
          <div className="space-y-5">
            <KernelEventDetail fault={faultForView} />
            {hasRecoveryPlaybook(faultForView) ? (
              <RecoveryConsole
                fault={faultForView}
                connected={connected}
                onRecoveryComplete={onRecoveryComplete}
              />
            ) : (
              <ManualInterventionNotice />
            )}
          </div>
        ) : faultForView.source === "threshold" ? (
          <div className="space-y-5">
            <ThresholdFaultDetail fault={faultForView} />
            {showRecovery ? (
              <RecoveryConsole
                fault={faultForView}
                connected={connected}
                onRecoveryComplete={onRecoveryComplete}
              />
            ) : (
              <ManualInterventionNotice />
            )}
          </div>
        ) : showRecovery ? (
          <RecoveryConsole
            fault={faultForView}
            connected={connected}
            onRecoveryComplete={onRecoveryComplete}
          />
        ) : faultForView.source === "link_health" || faultForView.source === "derived" ? (
          <div className="space-y-5">
            <LiveTelemetrySummary fault={faultForView} />
            {hasRecoveryPlaybook(faultForView) ? (
              <RecoveryConsole
                fault={faultForView}
                connected={connected}
                onRecoveryComplete={onRecoveryComplete}
              />
            ) : (
              <ManualInterventionNotice />
            )}
          </div>
        ) : (
          <ResolvedFaultEntry fault={faultForView} />
        )}

        <style>{`
          @keyframes modalFadeIn {
            from {
              opacity: 0;
              transform: translateY(8px) scale(0.985);
            }
            to {
              opacity: 1;
              transform: translateY(0) scale(1);
            }
          }
        `}</style>
      </div>
    </div>
  );
}

function ManualInterventionNotice() {
  return (
    <section
      className="rounded-xl border p-4"
      style={{ background: PANEL.bg, borderColor: "rgba(239,68,68,0.2)" }}
    >
      <h3 className="font-display text-sm font-semibold uppercase tracking-[0.12em] text-[#94a3b8]">
        Automated Recovery
      </h3>
      <p className="mt-2 text-sm text-[#94a3b8]">
        No recovery playbook is available for this fault type. Review telemetry evidence and
        perform manual remediation per your runbook.
      </p>
    </section>
  );
}

function ThresholdFaultDetail({ fault }) {
  const detail = fault.telemetryDetail || {};
  const isDiskPerf = detail.type === "disk_performance" || detail.type === "io_performance";
  const isGpuMetrics = detail.type === "gpu_metrics";
  const isCpuMetrics = detail.type === "cpu_metrics";
  const isNicMetrics = detail.type === "nic_metrics";
  const severityBg =
    fault.severity === "Critical"
      ? theme.critical
      : fault.severity === "Warning"
        ? theme.warning
        : theme.healthy;

  const rows = isDiskPerf
    ? [
        ["Device", detail.device ?? "—"],
        ["Transport", detail.transport ?? "—"],
        ["Busy %", detail.busy_percent != null ? `${detail.busy_percent}%` : "—"],
        ["Queue depth", detail.queue_depth != null ? String(detail.queue_depth) : "—"],
        ["Average latency", detail.average_latency_ms != null ? `${detail.average_latency_ms} ms` : "—"],
        ["Read throughput", detail.read_MB_per_sec != null ? `${detail.read_MB_per_sec} MB/s` : "—"],
        ["Write throughput", detail.write_MB_per_sec != null ? `${detail.write_MB_per_sec} MB/s` : "—"],
        ["Total throughput", detail.total_MB_per_sec != null ? `${detail.total_MB_per_sec} MB/s` : "—"],
        ["Read IOPS", detail.read_IOPS != null ? String(detail.read_IOPS) : "—"],
        ["Write IOPS", detail.write_IOPS != null ? String(detail.write_IOPS) : "—"],
        ["Timestamp", detail.timestamp ?? fault.detected ?? "—"],
        ["Threshold crossed", detail.thresholdCrossed ?? fault.thresholdCrossed ?? "—"],
        ["Health", detail.health ?? detail.status ?? fault.status ?? "—"],
        ["Status", detail.status ?? fault.status ?? "—"],
      ]
    : isGpuMetrics
      ? [
          ["Model", detail.model ?? "—"],
          ["PCI Bus", detail.pci_bus_id ?? "—"],
          ["Temperature", detail.temperature_celsius != null ? `${detail.temperature_celsius}°C` : "—"],
          ["Utilization", detail.gpu_utilization_percent != null ? `${detail.gpu_utilization_percent}%` : "—"],
          ["VRAM", detail.memory_utilization_percent != null ? `${detail.memory_utilization_percent}%` : "—"],
          ["VRAM used", detail.memory_used_mb != null ? `${detail.memory_used_mb} MB` : "—"],
          ["Power draw", detail.power_draw_watts != null ? `${detail.power_draw_watts} W` : "—"],
          ["Fan", detail.fan_speed_percent != null ? `${detail.fan_speed_percent}%` : "—"],
          ["Graphics clock", detail.graphics_clock_mhz != null ? `${detail.graphics_clock_mhz} MHz` : "—"],
          ["PCIe link", detail.link_status ?? "—"],
          ["Timestamp", detail.timestamp ?? fault.detected ?? "—"],
          ["Threshold crossed", detail.thresholdCrossed ?? fault.thresholdCrossed ?? "—"],
          ["Status", detail.status ?? fault.status ?? "—"],
        ]
      : isCpuMetrics
        ? [
            ["Usage", detail.usage_percent != null ? `${detail.usage_percent}%` : "—"],
            ["User", detail.user_percent != null ? `${detail.user_percent}%` : "—"],
            ["System", detail.system_percent != null ? `${detail.system_percent}%` : "—"],
            ["IO Wait", detail.iowait_percent != null ? `${detail.iowait_percent}%` : "—"],
            ["Load avg (1m)", detail.load_1min != null ? String(detail.load_1min) : "—"],
            ["Current MHz", detail.current_mhz != null ? String(detail.current_mhz) : "—"],
            ["Temperature", detail.temperature_celsius != null ? `${detail.temperature_celsius}°C` : "—"],
            ["Timestamp", detail.timestamp ?? fault.detected ?? "—"],
            ["Threshold crossed", detail.thresholdCrossed ?? fault.thresholdCrossed ?? "—"],
            ["Status", detail.status ?? fault.status ?? "—"],
          ]
      : isNicMetrics
        ? [
            ["Interface", detail.interface ?? "—"],
            ["Link state", detail.link_state ?? "—"],
            ["Speed", detail.speed ?? "—"],
            ["Duplex", detail.duplex ?? "—"],
            ["RX errors", detail.rx_errors != null ? String(detail.rx_errors) : "—"],
            ["TX errors", detail.tx_errors != null ? String(detail.tx_errors) : "—"],
            ["RX dropped", detail.rx_dropped != null ? String(detail.rx_dropped) : "—"],
            ["TX dropped", detail.tx_dropped != null ? String(detail.tx_dropped) : "—"],
            ["RX throughput", detail.rx_mbps != null ? `${detail.rx_mbps} Mbps` : "—"],
            ["TX throughput", detail.tx_mbps != null ? `${detail.tx_mbps} Mbps` : "—"],
            ["RX utilization", detail.rx_utilization_percent != null ? `${detail.rx_utilization_percent}%` : "—"],
            ["TX utilization", detail.tx_utilization_percent != null ? `${detail.tx_utilization_percent}%` : "—"],
            ["Connectivity", detail.network_connectivity == null ? "—" : detail.network_connectivity ? "Reachable" : "Unreachable"],
            ["Default route", detail.default_route_interface ?? "—"],
            ["Top process", detail.top_process_pid ? `PID ${detail.top_process_pid} · ${detail.top_process_name || "—"} · ${detail.top_process_total_kbps ?? "—"} KB/s` : "—"],
            ["Timestamp", detail.timestamp ?? fault.detected ?? "—"],
            ["Threshold crossed", detail.thresholdCrossed ?? fault.thresholdCrossed ?? "—"],
            ["Status", detail.status ?? fault.status ?? "—"],
          ]
      : [
        ["Metric", detail.metricName ?? fault.metricName ?? "—"],
        ["Current value", detail.currentValue ?? fault.currentValue ?? "—"],
        ["Threshold crossed", detail.thresholdCrossed ?? fault.thresholdCrossed ?? "—"],
        ["Timestamp", detail.timestamp ?? fault.detected ?? "—"],
        ["Status", detail.status ?? fault.status ?? "—"],
      ];

  return (
    <section>
      <h3 className="font-display text-lg font-semibold text-[#f1f5f9]">Threshold Fault — Live Metrics</h3>
      <p className="mt-1 text-xs text-[#64748b]">
        Sourced from live /metrics · auto-refreshed every 5s while this dialog is open
      </p>
      <article
        className="mt-4 rounded-xl border p-4"
        style={{
          backgroundColor: PANEL.inner,
          borderColor: PANEL.border,
          borderLeft: `4px solid ${fault.componentDot}`,
        }}
      >
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: fault.componentDot }}
              />
              <span className="text-lg font-bold text-white">{fault.metricName || fault.component}</span>
            </div>
            <p className="mt-2 text-sm leading-6 text-[#d8e6ff]">{fault.faultDescription}</p>
          </div>
          <span
            className="rounded-full px-3 py-1 text-xs font-bold text-white"
            style={{ backgroundColor: severityBg }}
          >
            {fault.severity}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label}>
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#95a7c7]">
                {label}
              </div>
              <p className="mt-1 font-mono-metrics text-white">{value}</p>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}

function LiveTelemetrySummary({ fault }) {
  const autoRecovered = isFaultAutoRecovered(fault.id);
  const severityBg =
    fault.severity === "Critical"
      ? theme.critical
      : fault.severity === "Warning"
        ? theme.warning
        : theme.healthy;

  return (
    <section>
      <h3 className="font-display text-lg font-semibold text-[#f1f5f9]">Live Telemetry Event</h3>
      <p className="mt-1 text-xs text-[#64748b]">
        Sourced from link_health engine · auto-refreshed every 5s
      </p>
      <article
        className="mt-4 rounded-xl border p-4"
        style={{
          backgroundColor: PANEL.inner,
          borderColor: PANEL.border,
          borderLeft: `4px solid ${fault.componentDot}`,
        }}
      >
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: fault.componentDot }}
              />
              <span className="text-lg font-bold text-white">{fault.component}</span>
              <span className="text-xs text-[#95a7c7]">{fault.source}</span>
            </div>
            <p className="mt-2 text-sm leading-6 text-[#d8e6ff]">
              {fault.faultDescription}
            </p>
          </div>
          <span
            className="rounded-full px-3 py-1 text-xs font-bold text-white"
            style={{ backgroundColor: severityBg }}
          >
            {fault.severity}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#95a7c7]">
              Affected Path
            </div>
            <p className="mt-1 text-[#4d9fff]">{fault.affectedPath}</p>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#95a7c7]">
              Detected
            </div>
            <p className="mt-1 text-white">{fault.detected}</p>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#95a7c7]">
              Status
            </div>
            <p className="mt-1 text-white">{autoRecovered ? "Recovered" : fault.status}</p>
          </div>
        </div>
      </article>
    </section>
  );
}

function KernelEventDetail({ fault }) {
  const ev = fault.kernelEvent;
  const severityBg =
    ev.severity === "critical"
      ? theme.critical
      : ev.severity === "warning"
        ? theme.warning
        : theme.healthy;

  return (
    <section>
      <h3 className="font-display text-lg font-semibold text-[#f1f5f9]">Kernel Hardware Event</h3>
      <p className="mt-1 text-xs text-[#64748b]">
        Hardware event captured from kernel ring buffer via link_health
      </p>
      <article
        className="mt-4 rounded-xl border p-4"
        style={{
          backgroundColor: PANEL.inner,
          borderColor: PANEL.border,
          borderLeft: `4px solid ${fault.componentDot}`,
        }}
      >
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: fault.componentDot }}
              />
              <span className="text-lg font-bold text-white">{fault.component}</span>
              <span className="text-xs text-[#95a7c7]">{ev.category}</span>
            </div>
            <p className="mt-2 text-sm leading-6 text-[#d8e6ff]">{ev.message}</p>
          </div>
          <span
            className="rounded-full px-3 py-1 text-xs font-bold uppercase text-white"
            style={{ backgroundColor: severityBg }}
          >
            {ev.severity || fault.severity}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#95a7c7]">
              Device
            </div>
            <p className="mt-1 text-white">{ev.device || "—"}</p>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#95a7c7]">
              Timestamp
            </div>
            <p className="mt-1 text-white">{ev.timestamp || fault.detected}</p>
          </div>
          <div className="md:col-span-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#95a7c7]">
              Affected Path
            </div>
            <p className="mt-1 text-[#4d9fff]">{fault.affectedPath}</p>
          </div>
        </div>
      </article>
    </section>
  );
}

function ResolvedFaultEntry({ fault }) {
  const entry = resolvedLogEntries[fault.component];

  return (
    <section>
      <h3 className="font-display text-lg font-semibold text-[#f1f5f9]">Resolved Fault Log Entry</h3>
      <p className="mt-1 text-xs text-[#64748b]">
        Read-only status record; no remediation action required.
      </p>
      <article
        className="mt-4 rounded-xl border p-4"
        style={{ backgroundColor: PANEL.inner, borderColor: PANEL.border }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="text-lg font-bold text-white">
              {entry?.title || "Resolved Entry"}
            </h4>
            <p className="mt-1 text-sm text-[#d8e6ff]">
              {entry?.summary || fault.faultDescription}
            </p>
          </div>
          <span className="rounded-full bg-[#00c853] px-3 py-1 text-xs font-bold text-white">
            {entry?.status || "RESOLVED"}
          </span>
        </div>
        <p className="mt-3 text-sm text-[#95a7c7]">
          Detected: {entry?.detected || fault.detected}
        </p>
        <p className="mt-2 text-sm italic text-[#95a7c7]">
          {entry?.details ||
            "Telemetry confirms system recovered and remains stable."}
        </p>
      </article>
    </section>
  );
}
