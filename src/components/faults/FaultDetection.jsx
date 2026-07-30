/**
 * Fault Detection Tab — anomaly diagnostics & active fault log
 */

import { useState } from "react";
import { FaultModal } from "./FaultModal";
import { HardwareModule, StatusBadge, BusConnector } from "../ui/HardwareModule";
import { HardwareIcon, getComponentIcon } from "../ui/HardwareIcon";
import { theme } from "../../utils/theme";

export function FaultDetectionTab({
  faults,
  anomalyCategories = [],
  anomalyStats = { active: 0, monitoring: 0, clear: 0, total: 0 },
  connected = false,
  lastUpdated = null,
  linkHealthSummary = null,
  statusPillTone,
  cardStatusTone,
  liveMetrics = null,
}) {
  const [activeFaultModal, setActiveFaultModal] = useState(null);

  const liveFaultRow = activeFaultModal
    ? faults.faults?.find((f) => f.id === activeFaultModal.id) || activeFaultModal
    : null;

  const scanLabel = lastUpdated ? lastUpdated.toLocaleTimeString() : "—";

  return (
    <div className="relative space-y-5 pt-1">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-lg"
            style={{
              background: "rgba(34, 211, 238, 0.08)",
              border: "1px solid rgba(34, 211, 238, 0.15)",
            }}
          >
            <HardwareIcon name="diagnostics" size={20} />
          </div>
          <div>
            <h1 className="font-display text-xl font-bold text-[#f1f5f9]">
              Fault Detection Engine
            </h1>
            <p className="text-xs text-[#64748b]">
              Threshold-based anomaly classification · 5s scan cycle
            </p>
          </div>
        </div>
        <StatusBadge
          status={connected ? "healthy" : "critical"}
          label={connected ? "Engine Active" : "Engine Offline"}
        />
      </header>

      <AnomalyCategoriesSection
        anomalyCategories={anomalyCategories}
        anomalyStats={anomalyStats}
        statusPillTone={statusPillTone}
        cardStatusTone={cardStatusTone}
      />

      <BusConnector />

      <FaultLogSection
        filteredFaultRows={faults.filteredFaultRows}
        activeFaultFilter={faults.activeFaultFilter}
        setActiveFaultFilter={faults.setActiveFaultFilter}
        setActiveFaultModal={setActiveFaultModal}
        totalFaults={faults.faults?.length ?? 0}
      />

      <div
        className="rounded-lg border px-4 py-2.5 text-center font-mono-metrics text-[10px] text-[#64748b]"
        style={{
          background: "rgba(8, 12, 18, 0.6)",
          borderColor: "rgba(34, 211, 238, 0.08)",
        }}
      >
        Link Health Engine · {connected ? "Connected" : "Disconnected"} · Scan: 5s · Last: {scanLabel}
        {linkHealthSummary?.score != null && ` · Score: ${linkHealthSummary.score}`}
      </div>

      {liveFaultRow && (
        <FaultModal
          fault={liveFaultRow}
          connected={connected}
          liveMetrics={liveMetrics}
          onClose={() => setActiveFaultModal(null)}
        />
      )}
    </div>
  );
}

function AnomalyCategoriesSection({
  anomalyCategories,
  anomalyStats,
  statusPillTone,
  cardStatusTone,
}) {
  return (
    <HardwareModule
      icon="fault"
      title="Anomaly Categories"
      subtitle="Per-component threshold monitoring across the hardware bus"
      headerRight={
        <div className="flex flex-wrap gap-1.5">
          <StatusBadge
            status={anomalyStats.active > 0 ? "critical" : "info"}
            label={`${anomalyStats.active} Active`}
          />
          <StatusBadge
            status={anomalyStats.monitoring > 0 ? "warning" : "info"}
            label={`${anomalyStats.monitoring} Monitor`}
          />
          <StatusBadge status="healthy" label={`${anomalyStats.clear} Clear`} />
        </div>
      }
    >
      {anomalyCategories.length === 0 ? (
        <p className="text-sm text-[#64748b]">Waiting for link_health telemetry…</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {anomalyCategories.slice(0, 4).map((card) => (
              <AnomalyCard
                key={card.component}
                card={card}
                statusPillTone={statusPillTone}
                cardStatusTone={cardStatusTone}
              />
            ))}
          </div>
          <div className="grid max-w-[1100px] grid-cols-1 gap-4 md:grid-cols-2">
            {anomalyCategories.slice(4).map((card) => (
              <AnomalyCard
                key={card.component}
                card={card}
                statusPillTone={statusPillTone}
                cardStatusTone={cardStatusTone}
              />
            ))}
          </div>
        </div>
      )}
    </HardwareModule>
  );
}

function AnomalyCard({ card, statusPillTone, cardStatusTone }) {
  const tone = cardStatusTone(card.overallStatus);
  return (
    <article className="hw-module overflow-hidden !p-0">
      <div
        className="h-0.5 w-full"
        style={{
          background: `linear-gradient(90deg, transparent, ${tone.accent}, transparent)`,
          boxShadow: `0 0 8px ${tone.accent}44`,
        }}
      />
      <div className="p-4">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="flex items-start gap-2.5">
            <HardwareIcon name={getComponentIcon(card.component)} size={18} style={{ opacity: 0.8 }} />
            <div>
              <h3 className="font-display text-sm font-semibold text-[#f1f5f9]">
                {card.component}
              </h3>
              <p className="mt-0.5 font-mono-metrics text-[10px] text-[#64748b]">
                {card.interfaceType}
              </p>
            </div>
          </div>
          <span
            className="rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
            style={{
              backgroundColor: tone.bg,
              color: tone.text,
              borderColor: `${tone.accent}44`,
            }}
          >
            {card.overallStatus}
          </span>
        </div>
        <div
          className="overflow-hidden rounded-lg"
          style={{ border: "1px solid rgba(34, 211, 238, 0.08)" }}
        >
          {card.rows.map((row, idx) => {
            const pillTone = statusPillTone(row.status);
            return (
              <div
                key={`${card.component}-${row.faultName}`}
                className="flex items-start justify-between gap-3 px-3 py-2 transition-colors hover:bg-[rgba(34,211,238,0.04)]"
                style={{
                  borderBottom:
                    idx === card.rows.length - 1 ? "none" : "1px solid rgba(34,211,238,0.06)",
                }}
              >
                <div className="flex items-start gap-2">
                  <span
                    className="mt-1 inline-block h-1.5 w-1.5 rounded-full"
                    style={{
                      backgroundColor: row.dot,
                      boxShadow: `0 0 6px ${row.dot}`,
                    }}
                  />
                  <div>
                    <div className="text-[11px] font-medium text-[#f1f5f9]">{row.faultName}</div>
                    <div className="font-mono-metrics text-[10px] text-[#64748b]">{row.subtitle}</div>
                  </div>
                </div>
                <span
                  className="shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                  style={{
                    backgroundColor: pillTone.bg,
                    color: pillTone.text,
                    borderColor: pillTone.border,
                  }}
                >
                  {row.status}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </article>
  );
}

function formatDetectedTime(detected) {
  if (!detected) return "—";
  const parsed = new Date(detected);
  if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString();
  return String(detected);
}

const FILTER_COLORS = {
  Critical: theme.critical,
  Warning: theme.warning,
  Resolved: theme.healthy,
  All: theme.cyan,
};

function FaultLogSection({
  filteredFaultRows,
  activeFaultFilter,
  setActiveFaultFilter,
  setActiveFaultModal,
  totalFaults,
}) {
  return (
    <HardwareModule
      icon="diagnostics"
      title="Active Fault Log"
      subtitle={`${totalFaults} events · threshold violations auto-detected and cleared when healthy`}
      headerRight={
        <div className="flex flex-wrap gap-1.5">
          {["Critical", "Warning", "Resolved", "All"].map((filter) => {
            const isActive = activeFaultFilter === filter;
            return (
              <button
                key={filter}
                type="button"
                onClick={() => setActiveFaultFilter(filter)}
                className={`hw-btn-filter ${isActive ? "hw-btn-filter-active" : ""}`}
                style={
                  isActive
                    ? {
                        backgroundColor: `${FILTER_COLORS[filter]}22`,
                        borderColor: `${FILTER_COLORS[filter]}55`,
                        color: FILTER_COLORS[filter],
                      }
                    : {}
                }
              >
                {filter}
              </button>
            );
          })}
        </div>
      }
      noPadding
    >
      <div className="hw-table-wrap mx-5 mb-5 overflow-x-auto">
        {filteredFaultRows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-[#64748b]">
            No faults match the current filter. All components nominal.
          </p>
        ) : (
          <table className="hw-table min-w-full">
            <thead>
              <tr>
                {[
                  "Timestamp",
                  "Severity",
                  "Component",
                  "Metric",
                  "Value",
                  "Threshold",
                  "Description",
                  "Status",
                  "Action",
                ].map((header) => (
                  <th key={header}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredFaultRows.map((row, idx) => {
                const sevStatus =
                  row.severity === "Critical"
                    ? "critical"
                    : row.severity === "Warning"
                      ? "warning"
                      : "healthy";
                const rowStatus =
                  row.status === "Auto Recovered"
                    ? "healthy"
                    : row.status === "Active"
                      ? "critical"
                      : row.status === "Monitor"
                        ? "warning"
                        : "healthy";

                return (
                  <tr
                    key={row.id || `${row.component}-${row.detected}-${idx}`}
                    style={{
                      boxShadow:
                        row.status === "Active"
                          ? "inset 2px 0 0 rgba(239,68,68,0.6)"
                          : row.status === "Monitor"
                            ? "inset 2px 0 0 rgba(245,158,11,0.5)"
                            : "none",
                    }}
                  >
                    <td className="font-mono-metrics text-[10px] text-[#94a3b8]">
                      {formatDetectedTime(row.detected)}
                    </td>
                    <td>
                      <StatusBadge status={sevStatus} label={row.severity} showDot={false} />
                    </td>
                    <td>
                      <span className="flex items-center gap-2 text-xs font-medium text-[#f1f5f9]">
                        <HardwareIcon
                          name={getComponentIcon(row.component)}
                          size={12}
                          style={{ opacity: 0.7 }}
                        />
                        {row.component}
                      </span>
                    </td>
                    <td className="text-xs text-[#38bdf8]">{row.metricName || "—"}</td>
                    <td className="font-mono-metrics text-xs text-[#f1f5f9]">
                      {row.currentValue || "—"}
                    </td>
                    <td className="font-mono-metrics text-xs text-[#f59e0b]">
                      {row.thresholdCrossed || "—"}
                    </td>
                    <td className="text-xs leading-relaxed text-[#94a3b8]">
                      {row.faultDescription}
                    </td>
                    <td>
                      <StatusBadge status={rowStatus} label={row.status} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="text-xs font-medium text-[#38bdf8] transition-colors hover:text-[#22d3ee]"
                        onClick={() => setActiveFaultModal(row)}
                      >
                        {row.action}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </HardwareModule>
  );
}
