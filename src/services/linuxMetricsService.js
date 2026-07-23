/**
 * Linux Hardware Metrics Service
 * Fetches live inventory, metrics, and link_health from the Linux telemetry server.
 */

import {
  buildHealthRowsFromLinkHealth,
  buildFaultLog,
  buildAnomalyCategories,
  buildAnomalyStats,
  buildTopologyContext,
  getLinkHealthSummary,
} from "./linkHealthService";

const LINUX_SERVER =
  import.meta.env.VITE_LINUX_SERVER || "http://10.16.210.13:5001";

const REFRESH_MS = 5000;

const COLORS = {
  healthy: "#00e676",
  warning: "#FF9800",
  critical: "#B71C1C",
  unknown: "#95A7C7",
};

export { LINUX_SERVER, REFRESH_MS };

function isRemovedTelemetryText(text) {
  const lower = String(text).toLowerCase();
  return (
    lower.includes("psu") ||
    lower.includes("vrm") ||
    lower.includes("power supply") ||
    lower.includes("bmc") ||
    lower.includes("ipmi") ||
    lower.includes("management")
  );
}

function stripInventory(data) {
  if (data?.management) delete data.management;
  return data;
}

function stripMetrics(data) {
  if (data?.psu) delete data.psu;
  return data;
}

function stripLinkHealth(data) {
  if (!data) return data;
  if (data.power_supply) delete data.power_supply;
  if (data.ipmi) delete data.ipmi;
  if (data.health_summary) {
    if (data.health_summary.critical_alerts) {
      data.health_summary.critical_alerts =
        data.health_summary.critical_alerts.filter((msg) => !isRemovedTelemetryText(msg));
    }
    if (data.health_summary.warnings) {
      data.health_summary.warnings =
        data.health_summary.warnings.filter((msg) => !isRemovedTelemetryText(msg));
    }
  }
  if (data.kernel_events) {
    Object.keys(data.kernel_events).forEach((cat) => {
      data.kernel_events[cat] = data.kernel_events[cat].filter(
        (ev) => !isRemovedTelemetryText(`${ev.message || ""} ${ev.category || ""} ${ev.device || ""}`)
      );
    });
  }
  return data;
}

export async function fetchInventory() {
  const res = await fetch(`${LINUX_SERVER}/inventory`);
  if (!res.ok) throw new Error(`Inventory HTTP ${res.status}`);
  return stripInventory(await res.json());
}

export async function fetchMetrics() {
  const res = await fetch(`${LINUX_SERVER}/metrics`);
  if (!res.ok) throw new Error(`Metrics HTTP ${res.status}`);
  return stripMetrics(await res.json());
}

export async function fetchLinkHealth() {
  const res = await fetch(`${LINUX_SERVER}/link_health`);
  if (!res.ok) throw new Error(`Link health HTTP ${res.status}`);
  return stripLinkHealth(await res.json());
}

export async function fetchLinuxTelemetry() {
  const [inventory, metrics, linkHealth] = await Promise.all([
    fetchInventory(),
    fetchMetrics(),
    fetchLinkHealth(),
  ]);
  return { inventory, metrics, linkHealth };
}

function formatUptime(seconds) {
  if (seconds == null) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function healthColor(level) {
  if (level === "critical") return COLORS.critical;
  if (level === "warning") return COLORS.warning;
  if (level === "healthy") return COLORS.healthy;
  return COLORS.unknown;
}

export function buildHealthRows(inventory, metrics, linkHealth) {
  return buildHealthRowsFromLinkHealth(linkHealth, inventory, metrics);
}

export function buildDashboardMetrics(inventory, metrics, linkHealth, healthRows) {
  const hostname = inventory?.system?.hostname || "unknown host";
  const cpu = metrics?.cpu || {};
  const mem = metrics?.memory || {};
  const uptimeSeconds = metrics?.system?.uptime_seconds;
  const lhSummary = getLinkHealthSummary(linkHealth);
  const load = cpu.load_average || {};

  const criticalCount = healthRows.filter((r) => r.level === "critical").length;
  const warningCount = healthRows.filter((r) => r.level === "warning").length;
  const healthyCount = healthRows.filter((r) => r.level === "healthy").length;
  const total = healthRows.length;

  const overallHealth = lhSummary.overallHealth || "Unknown";
  const healthLevel =
    overallHealth.toLowerCase() === "critical"
      ? "critical"
      : overallHealth.toLowerCase() === "warning"
        ? "warning"
        : overallHealth.toLowerCase() === "healthy"
          ? "healthy"
          : "unknown";

  return [
    {
      value: lhSummary.score != null ? `${lhSummary.score}` : overallHealth,
      valueColor: healthColor(healthLevel),
      label: "Link Health",
      subtitle:
        lhSummary.score != null
          ? `${overallHealth} · ${lhSummary.componentsChecked} components checked`
          : overallHealth,
      accent: healthColor(healthLevel),
    },
    {
      value: String(lhSummary.criticalAlertCount + lhSummary.warningCount || criticalCount + warningCount),
      valueColor:
        lhSummary.criticalAlertCount + lhSummary.warningCount + criticalCount + warningCount > 0
          ? COLORS.critical
          : COLORS.healthy,
      label: "Active Alerts",
      subtitle:
        lhSummary.criticalAlertCount + criticalCount > 0 || lhSummary.warningCount + warningCount > 0
          ? `${lhSummary.criticalAlertCount + criticalCount} Critical, ${lhSummary.warningCount + warningCount} Warning`
          : "All components nominal",
      accent:
        lhSummary.criticalAlertCount + lhSummary.warningCount > 0
          ? COLORS.critical
          : COLORS.healthy,
    },
    {
      value: `${healthyCount} / ${total}`,
      valueColor: COLORS.healthy,
      label: "Components OK",
      subtitle: `${lhSummary.componentsWithErrors} errors · ${lhSummary.componentsWithWarnings} warnings`,
      accent: COLORS.healthy,
    },
    {
      value: cpu.usage_percent != null ? `${cpu.usage_percent}%` : "—",
      valueColor: "#4d9fff",
      label: "System Load",
      subtitle: [
        mem.usage_percent != null ? `RAM ${mem.usage_percent}%` : null,
        load["1min"] != null ? `Load ${load["1min"]}/${load["5min"]}/${load["15min"]}` : null,
        `Uptime ${formatUptime(uptimeSeconds)}`,
        hostname,
      ]
        .filter(Boolean)
        .join(" · "),
      accent: "#4d9fff",
    },
  ];
}

export function buildSeverityData(healthRows) {
  const critical = healthRows.filter((r) => r.level === "critical").length;
  const warning = healthRows.filter((r) => r.level === "warning").length;
  const healthy = healthRows.filter((r) => r.level === "healthy").length;
  const unknown = healthRows.filter((r) => r.level === "unknown").length;

  return [
    { name: "Critical", value: critical, color: COLORS.critical },
    { name: "Warning", value: warning, color: COLORS.warning },
    { name: "Healthy", value: healthy, color: "#00c853" },
    { name: "Unknown", value: unknown, color: COLORS.unknown },
  ];
}

export function buildHealthStats(healthRows) {
  const healthyCount = healthRows.filter((r) => r.level === "healthy").length;
  const warningCount = healthRows.filter((r) => r.level === "warning").length;
  const criticalCount = healthRows.filter((r) => r.level === "critical").length;
  const unknownCount = healthRows.filter((r) => r.level === "unknown").length;
  const total = healthRows.length;

  const pct = (n) => (total > 0 ? (n / total) * 100 : 0);

  return {
    total,
    healthyCount,
    warningCount,
    criticalCount,
    unknownCount,
    healthyPct: pct(healthyCount),
    warningPct: pct(warningCount),
    criticalPct: pct(criticalCount + unknownCount),
  };
}

export function buildTelemetrySnapshot(inventory, metrics, linkHealth) {
  const health = buildHealthRows(inventory, metrics, linkHealth);
  const anomalyCategories = buildAnomalyCategories(linkHealth, inventory, metrics);

  return {
    health,
    metrics: buildDashboardMetrics(inventory, metrics, linkHealth, health),
    severity: buildSeverityData(health),
    stats: buildHealthStats(health),
    faults: buildFaultLog(linkHealth, inventory, metrics),
    anomalyCategories,
    anomalyStats: buildAnomalyStats(anomalyCategories),
    topologyContext: buildTopologyContext(inventory, metrics),
    linkHealthSummary: getLinkHealthSummary(linkHealth),
    hostname: inventory?.system?.hostname || null,
  };
}
