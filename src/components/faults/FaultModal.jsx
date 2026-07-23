/**
 * Fault Modal Component
 * Displays detailed fault information and autonomous recovery console
 */

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

export function FaultModal({ fault, onClose, connected = false }) {
  if (!fault) return null;

  const showRecovery =
    fault.source === "threshold" ||
    hasRecoveryPlaybook(fault) ||
    (fault.status === "Active" && fault.source !== "kernel_event");

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
              {fault.component} · Active Fault Log · Autonomous Recovery
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

        {fault.source === "kernel_event" && fault.kernelEvent ? (
          <div className="space-y-5">
            <KernelEventDetail fault={fault} />
            {hasRecoveryPlaybook(fault) ? (
              <RecoveryConsole fault={fault} connected={connected} />
            ) : (
              <ManualInterventionNotice />
            )}
          </div>
        ) : showRecovery ? (
          <RecoveryConsole fault={fault} connected={connected} />
        ) : fault.source === "link_health" || fault.source === "derived" ? (
          <div className="space-y-5">
            <LiveTelemetrySummary fault={fault} />
            {hasRecoveryPlaybook(fault) ? (
              <RecoveryConsole fault={fault} connected={connected} />
            ) : (
              <ManualInterventionNotice />
            )}
          </div>
        ) : (
          <ResolvedFaultEntry fault={fault} />
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
            <p className="mt-1 text-white">{autoRecovered ? "Auto Recovered" : fault.status}</p>
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
