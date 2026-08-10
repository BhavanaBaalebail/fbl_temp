/**
 * Dashboard banner — active faults with recovery playbooks available.
 */

import { hasRecoveryPlaybook } from "../../recovery/recoveryPlaybooks";
import { StatusBadge } from "../ui/HardwareModule";
import { HardwareIcon, getComponentIcon } from "../ui/HardwareIcon";

export function DashboardRecoverableFaults({
  faults = [],
  connected,
  onViewFault,
}) {
  const recoverable = (faults || []).filter(
    (f) => f.status === "Active" && hasRecoveryPlaybook(f)
  );

  if (recoverable.length === 0) return null;

  return (
    <section
      className="rounded-xl border p-4"
      style={{
        background: "rgba(12, 18, 28, 0.95)",
        borderColor: "rgba(245, 158, 11, 0.25)",
        borderLeft: "3px solid #f59e0b",
      }}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-sm font-semibold uppercase tracking-[0.12em] text-[#f59e0b]">
            Recovery Available
          </h2>
          <p className="mt-0.5 text-xs text-[#64748b]">
            {recoverable.length} active fault{recoverable.length === 1 ? "" : "s"} with recovery playbooks
          </p>
        </div>
        {!connected && <StatusBadge status="critical" label="Telemetry Offline" />}
      </div>

      <div className="space-y-2">
        {recoverable.slice(0, 6).map((fault) => (
          <article
            key={fault.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
            style={{
              background: "rgba(8, 12, 18, 0.8)",
              borderColor: "rgba(34, 211, 238, 0.12)",
            }}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <HardwareIcon name={getComponentIcon(fault.component)} size={14} />
                <span className="text-sm font-medium text-[#f1f5f9]">{fault.component}</span>
                <StatusBadge
                  status={fault.severity === "Critical" ? "critical" : "warning"}
                  label={fault.severity}
                  showDot={false}
                />
              </div>
              <p className="mt-1 truncate text-xs text-[#94a3b8]">
                {fault.metricName}: {fault.currentValue || "—"} · {fault.faultDescription}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                className="hw-btn-filter px-3 py-1.5 text-xs"
                onClick={() => onViewFault?.(fault)}
              >
                View
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
