/**
 * Derives live utility status from CM.py telemetry — no fabricated values.
 */

import { utilitiesCatalog } from "../data/utilitiesCatalog";
import { getPrimaryGpu } from "./linkHealthService";

function formatUptime(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return null;
  const s = Number(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function sumNicRates(nics) {
  if (!Array.isArray(nics) || nics.length === 0) return null;
  let rx = 0;
  let tx = 0;
  let hasRate = false;
  for (const nic of nics) {
    if (nic.name === "lo" || nic.name === "lo0") continue;
    if (nic.rx_mbps != null) {
      rx += Number(nic.rx_mbps);
      hasRate = true;
    }
    if (nic.tx_mbps != null) {
      tx += Number(nic.tx_mbps);
      hasRate = true;
    }
  }
  return hasRate ? { rx, tx, total: rx + tx } : null;
}

function maxNicLoss(nics) {
  if (!Array.isArray(nics)) return null;
  let maxDrop = 0;
  let maxErr = 0;
  let found = false;
  for (const nic of nics) {
    if (nic.name === "lo" || nic.name === "lo0") continue;
    const drop = Math.max(Number(nic.rx_drop_rate_percent || 0), Number(nic.tx_drop_rate_percent || 0));
    const err = Math.max(Number(nic.rx_error_rate_percent || 0), Number(nic.tx_error_rate_percent || 0));
    if (nic.rx_drop_rate_percent != null || nic.tx_drop_rate_percent != null) found = true;
    maxDrop = Math.max(maxDrop, drop);
    maxErr = Math.max(maxErr, err);
  }
  return found ? { maxDrop, maxErr } : null;
}

function countKernelEvents(linkHealth) {
  const events = linkHealth?.kernel_events;
  if (!events || typeof events !== "object") return null;
  let total = 0;
  let categories = 0;
  for (const list of Object.values(events)) {
    if (Array.isArray(list) && list.length > 0) {
      categories += 1;
      total += list.length;
    }
  }
  return total > 0 ? { total, categories } : { total: 0, categories: 0 };
}

function countAuthFailures(linkHealth) {
  const events = linkHealth?.kernel_events || {};
  const authish = [];
  for (const [cat, list] of Object.entries(events)) {
    if (!Array.isArray(list)) continue;
    const lc = cat.toLowerCase();
    if (lc.includes("auth") || lc.includes("login") || lc.includes("ssh")) {
      authish.push(...list);
    }
    for (const ev of list) {
      const msg = `${ev.message || ""} ${ev.category || ""}`.toLowerCase();
      if (
        msg.includes("failed password") ||
        msg.includes("authentication failure") ||
        msg.includes("invalid user")
      ) {
        authish.push(ev);
      }
    }
  }
  return authish.length;
}

function diskUsageSummary(metrics, linkHealth) {
  const mounts = metrics?.disk?.mounts;
  if (Array.isArray(mounts) && mounts.length > 0) {
    const root = mounts.find((m) => m.mountpoint === "/") || mounts[0];
    const pct = root?.usage_percent ?? root?.used_percent;
    if (pct != null) {
      return {
        percent: pct,
        mount: root.mountpoint || root.mount_point || "/",
        free_gb: root.free_gb,
      };
    }
  }
  const nvme = linkHealth?.nvme?.[0];
  if (nvme?.used_percent != null) {
    return { percent: nvme.used_percent, mount: "/", free_gb: null };
  }
  return null;
}

function temperatureSummary(metrics, inventory, linkHealth) {
  const parts = [];
  const cpuTemp = metrics?.cpu?.temperature_celsius;
  if (cpuTemp != null) parts.push(`CPU ${cpuTemp}°C`);

  const gpu = getPrimaryGpu(metrics, inventory, linkHealth);
  if (gpu?.temperature_celsius != null) parts.push(`GPU ${gpu.temperature_celsius}°C`);

  const smartMap = metrics?.disk?.smart;
  if (smartMap && typeof smartMap === "object") {
    const first = Object.values(smartMap).find((s) => s?.temperature_celsius != null);
    if (first?.temperature_celsius != null) parts.push(`Disk ${first.temperature_celsius}°C`);
  }

  return parts.length ? parts.join(" · ") : null;
}

function fanSummary(metrics, inventory, linkHealth, platformExtras) {
  const parts = [];
  const gpu = getPrimaryGpu(metrics, inventory, linkHealth);
  if (gpu?.fan_speed_percent != null) parts.push(`GPU ${gpu.fan_speed_percent}%`);

  const cooling = platformExtras?.cooling_devices;
  if (Array.isArray(cooling) && cooling.length > 0) {
    const rpm = cooling.find((c) => c.nominal_speed_rpm || c.speed_rpm);
    if (rpm) {
      parts.push(`${rpm.device_type || "Fan"} ${rpm.nominal_speed_rpm || rpm.speed_rpm} RPM`);
    } else {
      parts.push(`${cooling.length} cooling device(s)`);
    }
  }

  const hwmon = linkHealth?.hwmon;
  if (Array.isArray(hwmon)) {
    for (const chip of hwmon) {
      for (const fan of chip.fans || []) {
        if (fan.rpm != null) parts.push(`${fan.label || "Fan"} ${fan.rpm} RPM`);
      }
    }
  }

  return parts.length ? parts.join(" · ") : null;
}

function upsSummary(platformExtras) {
  const bat = platformExtras?.battery;
  const psu = platformExtras?.power_supply;
  if (bat?.status && bat.status !== "Unknown") {
    const pct = bat.capacity_percent != null ? `${bat.capacity_percent}%` : bat.status;
    return `Battery ${pct}${bat.status ? ` (${bat.status})` : ""}`;
  }
  if (psu?.online != null) {
    return psu.online ? "AC power online" : "On battery / offline";
  }
  if (bat?.present === false) return "No battery (desktop/server)";
  return null;
}

function softwareSummary(inventory) {
  const sys = inventory?.system || {};
  const os = sys.os || sys.operating_system || sys.distributor;
  const kernel = sys.kernel || sys.kernel_release;
  const parts = [os, kernel].filter(Boolean);
  return parts.length ? parts.join(" · ") : sys.hostname || null;
}

function rebootHint(metrics) {
  const uptime = metrics?.system?.uptime_seconds;
  if (uptime == null) return null;
  const bootApprox = new Date(Date.now() - uptime * 1000);
  return `Last boot ~${bootApprox.toLocaleString()}`;
}

function statusFromLevel(level) {
  if (level === "critical") return "critical";
  if (level === "warning") return "warning";
  if (level === "healthy") return "healthy";
  return "info";
}

function resolveLiveUtility(entry, ctx) {
  const { connected, metrics, linkHealth, inventory, faults, linkHealthSummary, platformExtras } =
    ctx;

  if (!connected) {
    return {
      ...entry,
      status: "critical",
      statusLabel: "Offline",
      detail: "Telemetry disconnected",
      value: "—",
    };
  }

  switch (entry.id) {
    case "server_health": {
      const health = linkHealthSummary?.overallHealth || "Unknown";
      const score = linkHealthSummary?.score;
      const level =
        health.toLowerCase() === "critical"
          ? "critical"
          : health.toLowerCase() === "warning"
            ? "warning"
            : "healthy";
      return {
        ...entry,
        status: statusFromLevel(level),
        statusLabel: health,
        value: score != null ? `Score ${score}` : health,
        detail: `${linkHealthSummary?.componentsChecked ?? "—"} components checked`,
      };
    }
    case "threshold_alerts": {
      const active = (faults || []).filter(
        (f) => f.source === "threshold" && f.severity !== "Resolved" && f.status !== "Resolved"
      );
      const critical = active.filter((f) => f.severity === "Critical").length;
      const warning = active.filter((f) => f.severity === "Warning").length;
      return {
        ...entry,
        status: critical > 0 ? "critical" : warning > 0 ? "warning" : "healthy",
        statusLabel: active.length ? "Active" : "Clear",
        value: String(active.length),
        detail:
          active.length > 0 ? `${critical} critical · ${warning} warning` : "No threshold breaches",
      };
    }
    case "uptime": {
      const formatted = formatUptime(metrics?.system?.uptime_seconds);
      return {
        ...entry,
        status: formatted ? "healthy" : "info",
        statusLabel: formatted ? "Running" : "Unavailable",
        value: formatted || "—",
        detail: formatted ? "From /proc/uptime" : "Not available on this host",
      };
    }
    case "temperature": {
      const summary = temperatureSummary(metrics, inventory, linkHealth);
      return {
        ...entry,
        status: summary ? "healthy" : "info",
        statusLabel: summary ? "Monitoring" : "No sensors",
        value: summary ? summary.split(" · ")[0] : "—",
        detail: summary || "No temperature sensors reported by CM.py",
      };
    }
    case "fan_speed": {
      const summary = fanSummary(metrics, inventory, linkHealth, platformExtras);
      return {
        ...entry,
        status: summary ? "healthy" : "info",
        statusLabel: summary ? "Active" : "No data",
        value: summary ? summary.split(" · ")[0] : "—",
        detail: summary || "No fan RPM data on this host",
      };
    }
    case "bandwidth": {
      const rates = sumNicRates(metrics?.nic);
      return {
        ...entry,
        status: rates ? "healthy" : "info",
        statusLabel: rates ? "Live" : "No data",
        value: rates ? `${rates.total.toFixed(2)} Mbps` : "—",
        detail: rates
          ? `RX ${rates.rx.toFixed(2)} · TX ${rates.tx.toFixed(2)} Mbps`
          : "No per-interface rates from CM.py",
      };
    }
    case "packet_loss": {
      const loss = maxNicLoss(metrics?.nic);
      const high = loss && (loss.maxDrop > 1 || loss.maxErr > 1);
      return {
        ...entry,
        status: !loss ? "info" : high ? "warning" : "healthy",
        statusLabel: !loss ? "No data" : high ? "Elevated" : "Normal",
        value: loss ? `${Math.max(loss.maxDrop, loss.maxErr).toFixed(2)}%` : "—",
        detail: loss
          ? `Max drop ${loss.maxDrop.toFixed(2)}% · err ${loss.maxErr.toFixed(2)}%`
          : "Drop/error rates unavailable",
      };
    }
    case "disk_usage": {
      const disk = diskUsageSummary(metrics, linkHealth);
      const high = disk && disk.percent >= 90;
      const warn = disk && disk.percent >= 75;
      return {
        ...entry,
        status: !disk ? "info" : high ? "critical" : warn ? "warning" : "healthy",
        statusLabel: !disk ? "No data" : high ? "Critical" : warn ? "Warning" : "OK",
        value: disk ? `${disk.percent}%` : "—",
        detail: disk
          ? `${disk.mount}${disk.free_gb != null ? ` · ${disk.free_gb} GB free` : ""}`
          : "Disk capacity not reported",
      };
    }
    case "log_analyzer": {
      const counts = countKernelEvents(linkHealth);
      return {
        ...entry,
        status: counts && counts.total > 0 ? "warning" : "healthy",
        statusLabel: counts ? "Scanning" : "Idle",
        value: counts ? String(counts.total) : "0",
        detail: counts
          ? `${counts.categories} kernel event categories`
          : "No kernel events in link_health",
      };
    }
    case "failed_login": {
      const fails = countAuthFailures(linkHealth);
      return {
        ...entry,
        status: fails > 0 ? "warning" : "healthy",
        statusLabel: fails > 0 ? "Detected" : "Clear",
        value: String(fails),
        detail:
          fails > 0
            ? "Auth failure patterns in kernel log snapshot"
            : "No failed-login patterns in current kernel log",
      };
    }
    case "software_inventory": {
      const summary = softwareSummary(inventory);
      return {
        ...entry,
        status: summary ? "healthy" : "info",
        statusLabel: summary ? "Collected" : "Partial",
        value: inventory?.system?.hostname || "—",
        detail: summary || "Host inventory from /inventory",
      };
    }
    case "ups_battery": {
      const summary = upsSummary(platformExtras);
      return {
        ...entry,
        status: summary ? "healthy" : "info",
        statusLabel: summary ? "Reported" : "N/A",
        value: summary ? summary.split(" ")[0] : "—",
        detail: summary || "No UPS/battery on this host",
      };
    }
    case "reboot_history": {
      const hint = rebootHint(metrics);
      return {
        ...entry,
        status: hint ? "healthy" : "info",
        statusLabel: hint ? "Estimated" : "Unavailable",
        value: formatUptime(metrics?.system?.uptime_seconds) || "—",
        detail: hint || "Uptime available; full reboot log requires agent",
      };
    }
    default:
      return null;
  }
}

function resolveAgentUtility(entry) {
  return {
    ...entry,
    status: "info",
    statusLabel: "Agent required",
    value: "—",
    detail: entry.agentNote || "Requires server-side agent on Ubuntu host",
  };
}

function resolveActionUtility(entry) {
  return {
    ...entry,
    status: "healthy",
    statusLabel: "Available",
    value: entry.actionLabel || "Open",
    detail: "Use the Reports tab for generation and export",
    action: entry.id,
  };
}

/**
 * @param {object} ctx
 * @returns {Array<object>}
 */
export function buildUtilityStatuses(ctx) {
  return utilitiesCatalog.map((entry) => {
    if (entry.feasibility === "agent") return resolveAgentUtility(entry);
    if (entry.feasibility === "action") return resolveActionUtility(entry);
    return resolveLiveUtility(entry, ctx) || resolveAgentUtility(entry);
  });
}

/**
 * Group utilities by category for dashboard rendering.
 */
export function groupUtilitiesByCategory(utilities) {
  const groups = {};
  for (const u of utilities) {
    if (!groups[u.category]) groups[u.category] = [];
    groups[u.category].push(u);
  }
  return groups;
}

export function countLiveUtilities(utilities) {
  const live = utilities.filter((u) => u.feasibility === "live");
  const withData = live.filter((u) => u.status !== "info" || u.value !== "—");
  return { live: live.length, reporting: withData.length, total: utilities.length };
}
