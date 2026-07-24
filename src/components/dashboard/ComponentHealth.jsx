/**
 * Component Health Status — motherboard health bus overview
 */

import { HardwareModule } from "../ui/HardwareModule";
import { HardwareIcon, getComponentIcon } from "../ui/HardwareIcon";
import { StatusBadge } from "../ui/HardwareModule";
import { theme } from "../../utils/theme";

function HealthIndicator({ level }) {
  const colors = {
    healthy: theme.healthy,
    warning: theme.warning,
    critical: theme.critical,
    unknown: theme.unknown,
  };
  const glowClass =
    level === "critical"
      ? "status-dot-glow-critical"
      : level === "warning"
        ? "status-dot-glow-warning"
        : "status-dot-glow-healthy";

  return (
    <span
      className={`status-dot-glow ${glowClass}`}
      style={level === "unknown" ? { background: theme.unknown, boxShadow: "none" } : {}}
    />
  );
}

export function ComponentHealthStatus({ healthRows, stats }) {
  const total = stats?.total ?? healthRows.length;
  const healthyCount = stats?.healthyCount ?? 0;
  const warningCount = stats?.warningCount ?? 0;
  const criticalCount = stats?.criticalCount ?? 0;
  const unknownCount = stats?.unknownCount ?? 0;
  const healthyPct = stats?.healthyPct ?? 0;
  const warningPct = stats?.warningPct ?? 0;
  const criticalPct = stats?.criticalPct ?? 0;

  return (
    <HardwareModule
      icon="motherboard"
      title="Component Health Bus"
      subtitle={`${total} hardware modules · live telemetry feed`}
      headerRight={
        <div className="flex flex-wrap gap-1.5">
          {criticalCount > 0 && (
            <StatusBadge status="critical" label={`${criticalCount} Critical`} />
          )}
          {warningCount > 0 && (
            <StatusBadge status="warning" label={`${warningCount} Warning`} />
          )}
          {healthyCount > 0 && criticalCount === 0 && warningCount === 0 && (
            <StatusBadge status="healthy" label="All Nominal" />
          )}
        </div>
      }
    >
      <div
        className="flex h-2 overflow-hidden rounded-full"
        style={{
          background: "rgba(10, 14, 20, 0.8)",
          border: "1px solid rgba(34, 211, 238, 0.1)",
        }}
      >
        {healthyPct > 0 && (
          <div
            className="transition-all duration-500"
            style={{
              width: `${healthyPct}%`,
              background: `linear-gradient(90deg, ${theme.healthy}, rgba(16,185,129,0.7))`,
              boxShadow: `0 0 8px ${theme.healthyGlow}`,
            }}
          />
        )}
        {warningPct > 0 && (
          <div
            className="transition-all duration-500"
            style={{
              width: `${warningPct}%`,
              background: `linear-gradient(90deg, ${theme.warning}, rgba(245,158,11,0.7))`,
              boxShadow: `0 0 8px ${theme.warningGlow}`,
            }}
          />
        )}
        {criticalPct > 0 && (
          <div
            className="transition-all duration-500"
            style={{
              width: `${criticalPct}%`,
              background: `linear-gradient(90deg, ${theme.critical}, rgba(239,68,68,0.7))`,
              boxShadow: `0 0 8px ${theme.criticalGlow}`,
            }}
          />
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-3 text-xs text-[#94a3b8]">
        <span className="flex items-center gap-1.5">
          <HealthIndicator level="healthy" /> Healthy ({healthyCount})
        </span>
        <span className="flex items-center gap-1.5">
          <HealthIndicator level="warning" /> Warning ({warningCount})
        </span>
        <span className="flex items-center gap-1.5">
          <HealthIndicator level="critical" /> Critical ({criticalCount})
        </span>
        {unknownCount > 0 && (
          <span className="flex items-center gap-1.5">
            <HealthIndicator level="unknown" /> Unknown ({unknownCount})
          </span>
        )}
      </div>

      <div className="hw-table-wrap mt-4">
        {healthRows.map((row, idx) => (
          <div
            key={row.name}
            className="flex items-center justify-between px-3 py-2.5 text-sm transition-colors hover:bg-[rgba(34,211,238,0.04)]"
            style={{
              borderBottom:
                idx === healthRows.length - 1 ? "none" : "1px solid rgba(34,211,238,0.06)",
            }}
          >
            <div className="flex items-center gap-2.5">
              <HardwareIcon name={getComponentIcon(row.name)} size={14} style={{ opacity: 0.7 }} />
              <HealthIndicator level={row.level} />
              <span className="font-medium text-[#f1f5f9]">{row.name}</span>
            </div>
            <span
              className={`text-right text-xs leading-snug ${
                row.name === "GPU" ? "max-w-[62%] whitespace-normal" : "max-w-[55%] truncate"
              }`}
              style={{ color: row.statusColor }}
              title={row.status}
            >
              {row.status}
            </span>
          </div>
        ))}
      </div>
    </HardwareModule>
  );
}
