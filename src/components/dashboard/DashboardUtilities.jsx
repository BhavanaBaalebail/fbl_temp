/**
 * Dashboard utilities grid — feasible live utilities + honest agent-required placeholders.
 */

import { UTILITY_CATEGORIES } from "../../data/utilitiesCatalog";
import { groupUtilitiesByCategory } from "../../services/utilitiesService";
import { HardwareIcon } from "../ui/HardwareIcon";
import { StatusBadge, BusConnector } from "../ui/HardwareModule";

const PANEL = {
  bg: "rgba(12, 18, 28, 0.95)",
  border: "rgba(34, 211, 238, 0.15)",
  inner: "rgba(8, 12, 18, 0.8)",
};

function UtilityCard({ utility, onAction }) {
  const isAction = utility.feasibility === "action";
  const isAgent = utility.feasibility === "agent";

  return (
    <article
      className={`rounded-xl border p-3 transition-colors ${isAction ? "cursor-pointer hover:border-[rgba(34,211,238,0.35)]" : ""}`}
      style={{ background: PANEL.inner, borderColor: PANEL.border }}
      onClick={isAction ? () => onAction?.(utility) : undefined}
      onKeyDown={
        isAction
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onAction?.(utility);
            }
          : undefined
      }
      role={isAction ? "button" : undefined}
      tabIndex={isAction ? 0 : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{
            background: "rgba(34, 211, 238, 0.06)",
            border: "1px solid rgba(34, 211, 238, 0.12)",
          }}
        >
          <HardwareIcon name={utility.icon || "diagnostics"} size={16} />
        </div>
        <StatusBadge status={utility.status} label={utility.statusLabel} showDot={false} />
      </div>
      <h4 className="mt-2 text-sm font-medium leading-snug text-[#e2e8f0]">{utility.name}</h4>
      <div className="mt-1 font-mono-metrics text-lg font-semibold text-[#f1f5f9]">
        {utility.value}
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[#64748b]">
        {utility.detail}
      </p>
      {isAgent && (
        <p className="mt-2 text-[10px] uppercase tracking-wider text-[#475569]">Planned · agent</p>
      )}
      {isAction && (
        <p className="mt-2 text-[10px] font-medium text-[#38bdf8]">{utility.actionLabel} →</p>
      )}
    </article>
  );
}

export function DashboardUtilities({
  utilities = [],
  summary,
  connected,
  onOpenReports,
  onOpenUtilities,
}) {
  const grouped = groupUtilitiesByCategory(utilities);
  const categoryOrder = Object.keys(UTILITY_CATEGORIES);

  const handleAction = (utility) => {
    if (utility.action === "report_generation" || utility.action === "daily_reports") {
      onOpenReports?.();
      return;
    }
    onOpenUtilities?.();
  };

  return (
    <section className="space-y-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight text-[#f1f5f9]">
            Server Utilities
          </h2>
          <p className="mt-0.5 text-xs text-[#64748b]">
            {summary
              ? `${summary.reporting}/${summary.live} live monitors reporting · ${summary.total} utilities catalogued`
              : "Operational utilities powered by Ubuntu CM.py telemetry"}
            {connected ? " · 5s refresh" : " · disconnected"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!connected && (
            <StatusBadge status="critical" label="Backend unavailable" showDot={false} />
          )}
          <button
            type="button"
            onClick={() => onOpenUtilities?.()}
            className="text-xs font-medium text-[#38bdf8] hover:text-[#22d3ee]"
          >
            Open Utilities →
          </button>
        </div>
      </header>

      {categoryOrder.map((catKey) => {
        const items = grouped[catKey];
        if (!items?.length) return null;
        return (
          <div key={catKey}>
            <h3 className="mb-2 font-display text-xs font-semibold uppercase tracking-[0.14em] text-[#64748b]">
              {UTILITY_CATEGORIES[catKey]}
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {items.map((utility) => (
                <UtilityCard key={utility.id} utility={utility} onAction={handleAction} />
              ))}
            </div>
          </div>
        );
      })}

      <BusConnector />
    </section>
  );
}
