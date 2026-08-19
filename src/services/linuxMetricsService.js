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
  getPrimaryGpu,
  getPrimaryNicInterface,
  getPrimaryIoDevice,
  syncCpuThrottlePoll,
  isCpuThermalThrottlingNonFaultText,
} from "./linkHealthService";
import { enrichMetricsGpu } from "./gpuMetricsSupplement";

const LINUX_SERVER =
  import.meta.env.VITE_LINUX_SERVER || "http://10.17.28.162:5000";

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
    lower.includes("management") ||
    isCpuThermalThrottlingNonFaultText(text)
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

function coerceGpuArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return [value];
  return [];
}

/** Keep gpu as arrays so downstream [0] access and merges stay consistent */
function normalizeTelemetryGpu(inventory, metrics, linkHealth) {
  if (inventory) inventory.gpu = coerceGpuArray(inventory.gpu);
  if (metrics) metrics.gpu = coerceGpuArray(metrics.gpu);
  if (linkHealth && linkHealth.gpu != null) {
    linkHealth.gpu = coerceGpuArray(linkHealth.gpu);
  }
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

export async function fetchFunctionalBlocks() {
  const res = await fetch(`${LINUX_SERVER}/functional_blocks`);
  if (!res.ok) throw new Error(`Functional blocks HTTP ${res.status}`);
  return res.json();
}

export async function fetchPlatformExtras() {
  try {
    const res = await fetch(`${LINUX_SERVER}/platform_extras`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function fetchLinuxTelemetry() {
  const [inventory, metrics, linkHealth, functionalBlocksResult] = await Promise.all([
    fetchInventory(),
    fetchMetrics(),
    fetchLinkHealth(),
    fetchFunctionalBlocks().catch(() => null),
  ]);
  normalizeTelemetryGpu(inventory, metrics, linkHealth);
  enrichMetricsGpu(metrics, inventory, linkHealth, functionalBlocksResult);
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

export function buildDashboardMetrics(inventory, metrics, linkHealth, healthRows, faultRows = []) {
  const hostname = inventory?.system?.hostname || "unknown host";
  const cpu = metrics?.cpu || {};
  const mem = metrics?.memory || {};
  const uptimeSeconds = metrics?.system?.uptime_seconds;
  const lhSummary = getLinkHealthSummary(linkHealth, inventory, metrics);
  const load = cpu.load_average || {};

  const criticalCount = healthRows.filter((r) => r.level === "critical").length;
  const warningCount = healthRows.filter((r) => r.level === "warning").length;
  const healthyCount = healthRows.filter((r) => r.level === "healthy").length;
  const total = healthRows.length;

  const thresholdFaultCount = faultRows.filter(
    (f) => f.source === "threshold" && f.severity !== "Resolved"
  ).length;
  const summaryAlertCount = lhSummary.criticalAlertCount + lhSummary.warningCount;
  const componentAlertCount = criticalCount + warningCount;
  const alertTotal = Math.max(thresholdFaultCount, summaryAlertCount, componentAlertCount);
  const alertCritical = Math.max(
    lhSummary.criticalAlertCount,
    criticalCount,
    faultRows.filter((f) => f.source === "threshold" && f.severity === "Critical").length
  );
  const alertWarning = Math.max(
    lhSummary.warningCount,
    warningCount,
    faultRows.filter((f) => f.source === "threshold" && f.severity === "Warning").length
  );

  const overallHealth = lhSummary.overallHealth || "Unknown";
  const healthLevel =
    overallHealth.toLowerCase() === "critical"
      ? "critical"
      : overallHealth.toLowerCase() === "warning"
        ? "warning"
        : overallHealth.toLowerCase() === "healthy"
          ? "healthy"
          : "unknown";

  const gpu = getPrimaryGpu(metrics, inventory, linkHealth);

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
      value: String(alertTotal),
      valueColor: alertTotal > 0 ? COLORS.critical : COLORS.healthy,
      label: "Active Alerts",
      subtitle:
        alertCritical > 0 || alertWarning > 0
          ? `${alertCritical} Critical, ${alertWarning} Warning`
          : "All components nominal",
      accent: alertTotal > 0 ? COLORS.critical : COLORS.healthy,
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
        gpu && (gpu.gpu_utilization_percent != null || gpu.temperature_celsius != null)
          ? `GPU ${gpu.gpu_utilization_percent != null ? `${gpu.gpu_utilization_percent}%` : "—"} · ${gpu.temperature_celsius != null ? `${gpu.temperature_celsius}°C` : "—"}`
          : null,
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

function livePercent(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function peakDiskUsagePercent(metrics) {
  const mounts = metrics?.disk?.mounts || [];
  const usages = mounts
    .map((m) => (typeof m.usage_percent === "number" ? m.usage_percent : null))
    .filter((v) => v != null && Number.isFinite(v));
  return usages.length ? Math.max(...usages) : 0;
}

/** Relative load/utilization share across the six monitored components. */
export function buildSeverityData(_healthRows, metrics, inventory, linkHealth) {
  const gpu = getPrimaryGpu(metrics, inventory, linkHealth);
  const nic = getPrimaryNicInterface(metrics);
  const io = getPrimaryIoDevice(metrics);

  const rows = [
    { name: "CPU", util: livePercent(metrics?.cpu?.usage_percent), color: "#4d9fff" },
    { name: "GPU", util: livePercent(gpu?.gpu_utilization_percent), color: "#22d3ee" },
    { name: "RAM", util: livePercent(metrics?.memory?.usage_percent), color: "#bb86fc" },
    { name: "Disk", util: livePercent(peakDiskUsagePercent(metrics)), color: "#f59e0b" },
    { name: "NIC", util: livePercent(nic?.utilization_percent), color: "#38bdf8" },
    { name: "I/O Controller", util: livePercent(io?.busy_percent), color: "#10b981" },
  ];

  const total = rows.reduce((sum, row) => sum + row.util, 0);

  return rows.map((row) => ({
    name: row.name,
    value: row.util,
    util: row.util,
    share: total > 0 ? (row.util / total) * 100 : 0,
    color: row.color,
  }));
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
  syncCpuThrottlePoll(linkHealth);
  const health = buildHealthRows(inventory, metrics, linkHealth);
  const anomalyCategories = buildAnomalyCategories(linkHealth, inventory, metrics);
  const faults = buildFaultLog(linkHealth, inventory, metrics);

  return {
    health,
    metrics: buildDashboardMetrics(inventory, metrics, linkHealth, health, faults),
    severity: buildSeverityData(health, metrics, inventory, linkHealth),
    stats: buildHealthStats(health),
    faults,
    anomalyCategories,
    anomalyStats: buildAnomalyStats(anomalyCategories),
    topologyContext: buildTopologyContext(inventory, metrics, linkHealth),
    linkHealthSummary: getLinkHealthSummary(linkHealth, inventory, metrics),
    hostname: inventory?.system?.hostname || null,
  };
}
