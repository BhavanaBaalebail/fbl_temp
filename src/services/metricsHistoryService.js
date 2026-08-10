/**
 * Metrics History Service
 * Accumulates telemetry samples during the browser session for report generation.
 * No backend history API exists — samples are recorded on each live poll.
 */

import { buildTelemetrySnapshot } from "./linuxMetricsService";
import { getPrimaryGpu } from "./linkHealthService";

const STORAGE_KEY = "fbl_metrics_history_v1";
const MAX_SAMPLES = 2000;

export const REPORT_INTERVALS = {
  snapshot: { label: "Current System Snapshot", ms: 30 * 1000 },
  "1h": { label: "Last 1 Hour", ms: 60 * 60 * 1000 },
  "24h": { label: "Last 24 Hours", ms: 24 * 60 * 60 * 1000 },
  "7d": { label: "Last 7 Days", ms: 7 * 24 * 60 * 60 * 1000 },
  "15m": { label: "Last 15 Minutes", ms: 15 * 60 * 1000 },
  "10h": { label: "Last 10 Hours", ms: 10 * 60 * 60 * 1000 },
  custom: { label: "Custom Time Range", ms: null },
};

let memoryStore = loadFromStorage();

function loadFromStorage() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { samples: [], faultEvents: [], context: null };
    const parsed = JSON.parse(raw);
    return {
      samples: Array.isArray(parsed.samples) ? parsed.samples : [],
      faultEvents: Array.isArray(parsed.faultEvents) ? parsed.faultEvents : [],
      context: parsed.context || null,
    };
  } catch {
    return { samples: [], faultEvents: [], context: null };
  }
}

function persist() {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        samples: memoryStore.samples,
        faultEvents: memoryStore.faultEvents,
        context: memoryStore.context,
      })
    );
  } catch (err) {
    console.warn("Metrics history storage full, trimming samples", err);
    memoryStore.samples = memoryStore.samples.slice(-Math.floor(MAX_SAMPLES / 2));
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(memoryStore));
    } catch {
      /* ignore */
    }
  }
}

function num(value) {
  return typeof value === "number" && !Number.isNaN(value) ? value : null;
}

export function extractCompactSample(inventory, metrics, linkHealth, snapshot) {
  const cpu = metrics?.cpu || {};
  const mem = metrics?.memory || {};
  const gpu = getPrimaryGpu(metrics, inventory, linkHealth);
  const nics = metrics?.nic || [];
  const mounts = metrics?.disk?.mounts || [];
  const lh = snapshot?.linkHealthSummary || {};
  const upNics = nics.filter((n) => String(n.link_state || "").toLowerCase() === "up");
  const componentLevels = {};
  (snapshot?.health || []).forEach((row) => {
    componentLevels[row.name] = row.level;
  });

  return {
    t: Date.now(),
    cpu_usage: num(cpu.usage_percent),
    cpu_temp: num(cpu.temperature_celsius),
    cpu_load_1: num(cpu.load_average?.["1min"]),
    mem_usage: num(mem.usage_percent),
    mem_swap: num(mem.swap_usage_percent),
    mem_used_gb: num(mem.used_gb),
    mem_total_gb: num(mem.total_gb),
    gpu_temp: num(gpu?.temperature_celsius),
    gpu_util: num(gpu?.gpu_utilization_percent),
    gpu_vram: num(gpu?.memory_utilization_percent),
    gpu_power: num(gpu?.power_draw_watts),
    disk_mounts: mounts.map((m) => ({
      mp: m.mountpoint || m.mount || "—",
      pct: num(m.usage_percent),
    })),
    nic_up: upNics.length,
    nic_total: nics.length,
    nic_errors: nics.reduce(
      (sum, n) => sum + (n.rx_errors || 0) + (n.tx_errors || 0),
      0
    ),
    lh_score: lh.score ?? null,
    lh_health: lh.overallHealth || null,
    alert_crit: (lh.criticalAlertCount ?? 0) + (snapshot?.stats?.criticalCount ?? 0),
    alert_warn: (lh.warningCount ?? 0) + (snapshot?.stats?.warningCount ?? 0),
    healthy_components: snapshot?.stats?.healthyCount ?? null,
    component_levels: componentLevels,
    uptime_seconds: num(metrics?.system?.uptime_seconds),
    pci_count: inventory?.io?.pci?.length ?? null,
    usb_count: inventory?.io?.usb?.length ?? null,
  };
}

function buildInventorySummary(inventory) {
  if (!inventory) return null;
  const sys = inventory.system || {};
  const cpu = inventory.cpu || {};
  const mem = inventory.memory || {};
  const disks = inventory.disk || [];
  const gpus = inventory.gpu || [];
  const nics = inventory.nic || [];
  const pci = inventory.io?.pci || [];
  const usb = inventory.io?.usb || [];

  return {
    hostname: sys.hostname || null,
    os: sys.os || null,
    os_release: sys.os_release || null,
    kernel: sys.kernel || null,
    cpu: {
      vendor: cpu.vendor || null,
      model: cpu.model || null,
      architecture: cpu.architecture || null,
      sockets: cpu.sockets ?? null,
      physical_cores: cpu.physical_cores ?? null,
      logical_processors: cpu.logical_processors ?? null,
    },
    memory: {
      dimm_count: (mem.dimms || []).length,
      dimms: (mem.dimms || []).slice(0, 8).map((d) => ({
        locator: d.locator,
        size: d.size,
        type: d.type,
        speed: d.speed,
      })),
    },
    disks: disks.map((d) => ({
      device: d.device,
      model: d.model,
      type: d.type,
      transport: d.transport,
      size: d.size,
    })),
    gpus: gpus.map((g) => ({
      model: g.model,
      vendor: g.vendor,
      driver_version: g.driver_version,
    })),
    nics: nics.map((n) => ({
      name: n.name || n.interface,
      model: n.model,
      speed: n.speed,
    })),
    pci_count: pci.length,
    usb_count: usb.length,
  };
}

function buildComponentSnapshot(health, inventory, metrics, linkHealth) {
  const assessments = {};
  (health || []).forEach((row) => {
    assessments[row.name] = { level: row.level, status: row.status };
  });
  return {
    assessments,
    inventory: buildInventorySummary(inventory),
    liveMetrics: {
      cpu_usage: metrics?.cpu?.usage_percent ?? null,
      cpu_temp: metrics?.cpu?.temperature_celsius ?? null,
      mem_usage: metrics?.memory?.usage_percent ?? null,
      mem_total_gb: metrics?.memory?.total_gb ?? null,
      gpu_temp: metrics?.gpu?.[0]?.temperature_celsius ?? null,
      gpu_util: metrics?.gpu?.[0]?.gpu_utilization_percent ?? null,
      io_device: (() => {
        const perf = metrics?.disk?.performance || [];
        if (!perf.length) return null;
        return perf.reduce((best, p) =>
          (p.busy_percent || 0) >= (best?.busy_percent || 0) ? p : best
        , perf[0])?.device ?? null;
      })(),
      io_busy: (() => {
        const perf = metrics?.disk?.performance || [];
        if (!perf.length) return null;
        return Math.max(...perf.map((p) => p.busy_percent || 0));
      })(),
      io_total_mbps: (() => {
        const perf = metrics?.disk?.performance || [];
        if (!perf.length) return null;
        return Math.max(...perf.map((p) => p.total_MB_per_sec || 0));
      })(),
      uptime_seconds: metrics?.system?.uptime_seconds ?? null,
    },
    linkHealth: {
      overall: linkHealth?.health_summary?.overall_health ?? null,
      score: linkHealth?.health_summary?.score ?? null,
    },
  };
}

export function recordTelemetrySample(inventory, metrics, linkHealth) {
  const snapshot = buildTelemetrySnapshot(inventory, metrics, linkHealth);
  const sample = extractCompactSample(inventory, metrics, linkHealth, {
    ...snapshot,
    linkHealthSummary: snapshot.linkHealthSummary,
  });

  memoryStore.samples.push(sample);
  if (memoryStore.samples.length > MAX_SAMPLES) {
    memoryStore.samples = memoryStore.samples.slice(-MAX_SAMPLES);
  }

  const sys = inventory?.system || {};
  memoryStore.context = {
    hostname: sys.hostname || snapshot.hostname || null,
    os: sys.os || sys.os_release || null,
    kernel: sys.kernel || null,
    cpu_model: inventory?.cpu?.model || null,
    gpu_model: getPrimaryGpu(metrics, inventory, linkHealth)?.model || null,
    pci_count: inventory?.io?.pci?.length ?? null,
    usb_count: inventory?.io?.usb?.length ?? null,
    updatedAt: Date.now(),
    inventory: buildInventorySummary(inventory),
    componentSnapshot: buildComponentSnapshot(
      snapshot.health,
      inventory,
      metrics,
      linkHealth
    ),
  };

  const seen = new Set(memoryStore.faultEvents.map((f) => f.id));
  (snapshot.faults || []).forEach((fault) => {
    if (!fault?.id || seen.has(fault.id)) return;
    memoryStore.faultEvents.push({
      id: fault.id,
      t: Date.now(),
      severity: fault.severity,
      component: fault.component,
      metricName: fault.metricName || null,
      currentValue: fault.currentValue || null,
      thresholdCrossed: fault.thresholdCrossed || null,
      description: fault.faultDescription,
      status: fault.status,
      source: fault.source || null,
    });
    if (memoryStore.faultEvents.length > 500) {
      memoryStore.faultEvents = memoryStore.faultEvents.slice(-500);
    }
  });

  persist();
  return sample;
}

function resolveIntervalCutoff(intervalKey, customRange) {
  if (intervalKey === "custom" && customRange?.start && customRange?.end) {
    return { start: customRange.start, end: customRange.end };
  }
  const interval = REPORT_INTERVALS[intervalKey];
  if (!interval?.ms) return { start: Date.now() - 60 * 60 * 1000, end: Date.now() };
  const end = Date.now();
  return { start: end - interval.ms, end };
}

export function getSamplesForInterval(intervalKey, customRange = null) {
  const { start, end } = resolveIntervalCutoff(intervalKey, customRange);
  if (intervalKey === "snapshot") {
    const latest = memoryStore.samples.slice(-1);
    return latest.length ? latest : [];
  }
  return memoryStore.samples.filter((s) => s.t >= start && s.t <= end);
}

export function getFaultEventsForInterval(intervalKey, customRange = null) {
  const { start, end } = resolveIntervalCutoff(intervalKey, customRange);
  if (intervalKey === "snapshot") {
    const recent = memoryStore.faultEvents.filter((f) => f.t >= start);
    return recent.slice(-10);
  }
  return memoryStore.faultEvents.filter((f) => f.t >= start && f.t <= end);
}

export function getHistoryContext() {
  return memoryStore.context;
}

export function getSampleCount() {
  return memoryStore.samples.length;
}

export function computeStats(values) {
  const nums = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (nums.length === 0) {
    return { avg: null, min: null, max: null, current: null, trend: "Not Available", count: 0 };
  }

  const sum = nums.reduce((a, b) => a + b, 0);
  const avg = sum / nums.length;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const current = nums[nums.length - 1];

  let trend = "Not Available";
  if (nums.length >= 4) {
    const mid = Math.floor(nums.length / 2);
    const firstAvg = nums.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
    const secondAvg = nums.slice(mid).reduce((a, b) => a + b, 0) / (nums.length - mid);
    const delta = secondAvg - firstAvg;
    if (Math.abs(delta) < 1) trend = "Stable";
    else if (delta > 0) trend = "Increasing";
    else trend = "Decreasing";
  } else if (nums.length >= 2) {
    trend = nums[nums.length - 1] > nums[0] ? "Increasing" : nums[nums.length - 1] < nums[0] ? "Decreasing" : "Stable";
  }

  return {
    avg: Math.round(avg * 100) / 100,
    min: Math.round(min * 100) / 100,
    max: Math.round(max * 100) / 100,
    current: Math.round(current * 100) / 100,
    trend,
    count: nums.length,
  };
}

export function formatDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)} seconds`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} minutes`;
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return m > 0 ? `${h} hours ${m} minutes` : `${h} hours`;
}

export function getMonitoringSpan(samples, intervalKey, customRange = null) {
  const interval = REPORT_INTERVALS[intervalKey];
  if (!samples.length) {
    const label =
      intervalKey === "snapshot"
        ? "Point-in-time snapshot"
        : "No samples collected";
    return { start: null, end: null, durationMs: 0, label };
  }
  const start = samples[0].t;
  const end = samples[samples.length - 1].t;
  const maxMs =
    intervalKey === "custom" && customRange?.start && customRange?.end
      ? customRange.end - customRange.start
      : interval?.ms || end - start;
  const durationMs = Math.min(end - start, maxMs);
  return {
    start: new Date(start),
    end: new Date(end),
    durationMs,
    label:
      intervalKey === "snapshot"
        ? "Point-in-time snapshot"
        : formatDuration(durationMs),
  };
}

export function getRawSamples() {
  return [...memoryStore.samples];
}
