/**
 * Report Data Builder — builds format-agnostic report data from SQLite history.
 * Source of truth: CM.py GET /reports/data → telemetry_history.db
 * Does NOT use sessionStorage for historical telemetry.
 */

import { REPORT_INTERVALS, fetchHistoricalReportData } from "./historicalReportApi";
import { filterSelectedSections } from "./reportSections";
import {
  buildPredictiveMaintenance,
  PREDICTIVE_DISCLAIMER,
} from "../predictiveMaintenance";

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function computeStats(values) {
  const nums = values.map(num).filter((v) => v != null);
  if (!nums.length) {
    return { count: 0, avg: null, min: null, max: null, current: null, trend: "—" };
  }
  const sum = nums.reduce((a, b) => a + b, 0);
  const avg = Math.round((sum / nums.length) * 100) / 100;
  const min = Math.round(Math.min(...nums) * 100) / 100;
  const max = Math.round(Math.max(...nums) * 100) / 100;
  const current = Math.round(nums[nums.length - 1] * 100) / 100;
  let trend = "stable";
  if (nums.length >= 4) {
    const mid = Math.floor(nums.length / 2);
    const first = nums.slice(0, mid);
    const second = nums.slice(mid);
    const a1 = first.reduce((a, b) => a + b, 0) / first.length;
    const a2 = second.reduce((a, b) => a + b, 0) / second.length;
    if (a2 > a1 * 1.08) trend = "rising";
    else if (a2 < a1 * 0.92) trend = "falling";
  }
  return { count: nums.length, avg, min, max, current, trend };
}

function parseJsonField(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatDurationSeconds(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return `${s}s`;
}

function formatLocal(tsSecOrMs) {
  if (tsSecOrMs == null) return "—";
  const ms = Number(tsSecOrMs) > 1e12 ? Number(tsSecOrMs) : Number(tsSecOrMs) * 1000;
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString();
}

function mapTelemetrySample(row) {
  const mounts = parseJsonField(row.disk_mounts_json, []) || [];
  const collectedAt = num(row.collected_at);
  return {
    t: collectedAt != null ? collectedAt * 1000 : null,
    collected_at: collectedAt,
    timestamp: row.timestamp || null,
    hostname: row.hostname || null,
    cpu_usage: num(row.cpu_usage_percent),
    cpu_temp: num(row.cpu_temperature_celsius),
    cpu_load_1: num(row.cpu_load_1min),
    cpu_load_5: num(row.cpu_load_5min),
    cpu_load_15: num(row.cpu_load_15min),
    cpu_user: num(row.cpu_user_percent),
    cpu_system: num(row.cpu_system_percent),
    mem_usage: num(row.memory_usage_percent),
    mem_swap: num(row.memory_swap_usage_percent),
    mem_used_gb: num(row.memory_used_gb),
    mem_total_gb: num(row.memory_total_gb),
    mem_available_gb: num(row.memory_available_gb),
    gpu_temp: num(row.gpu_temperature_celsius),
    gpu_util: num(row.gpu_utilization_percent),
    gpu_vram: num(row.gpu_memory_utilization_percent),
    gpu_power: num(row.gpu_power_draw_watts),
    gpu_model: row.gpu_model || null,
    nic_up: num(row.nic_up_count),
    nic_total: num(row.nic_total_count),
    nic_errors: num(row.nic_error_count),
    nic_util: num(row.nic_utilization_percent),
    nic_rx: num(row.nic_rx_mbps),
    nic_tx: num(row.nic_tx_mbps),
    io_device: row.io_device || null,
    io_busy: num(row.io_busy_percent),
    io_read_iops: num(row.io_read_iops),
    io_write_iops: num(row.io_write_iops),
    io_iops: num(row.io_total_iops),
    io_read_mbps: num(row.io_read_mb_per_sec),
    io_write_mbps: num(row.io_write_mb_per_sec),
    io_total_mbps: num(row.io_total_mb_per_sec),
    io_queue: num(row.io_queue_depth),
    io_latency: num(row.io_avg_latency_ms),
    disk_mounts: mounts.map((m) => ({
      mp: m.mp || m.mountpoint || m.mount || "—",
      pct: num(m.pct ?? m.usage_percent),
      size_gb: num(m.size_gb),
      used_gb: num(m.used_gb),
      free_gb: num(m.free_gb),
    })),
    lh_score: num(row.lh_score),
    lh_health: row.lh_overall_health || null,
    pci_count: num(row.pci_count),
    usb_count: num(row.usb_count),
    uptime_seconds: num(row.uptime_seconds),
  };
}

function mapFault(row) {
  const first = num(row.first_seen_at) ?? num(row.timestamp);
  const last = num(row.last_seen_at) ?? first;
  const payload = parseJsonField(row.payload, {}) || {};
  const durationSec =
    first != null && last != null && last >= first ? last - first : null;
  const corrected =
    String(row.status || "").toLowerCase().includes("clear") ||
    String(row.status || "").toLowerCase().includes("resolved");

  return {
    id: row.fault_id || row.id,
    fault_id: row.fault_id,
    t: first != null ? first * 1000 : null,
    firstSeenAt: first,
    lastSeenAt: last,
    severity: row.severity || "Warning",
    component: row.component || "unknown",
    metricName: row.metric_name || payload.metric_name || null,
    currentValue: row.current_value || payload.current_value || null,
    thresholdCrossed: row.threshold_crossed || payload.threshold || null,
    description: row.message || row.description || "",
    message: row.message || row.description || "",
    status: row.status || "Active",
    source: row.source || "health_summary",
    durationSeconds: durationSec,
    durationLabel: formatDurationSeconds(durationSec),
    faultDetected: formatLocal(first),
    faultCorrected: corrected ? formatLocal(last) : "Correction time unavailable.",
    peakValue: row.current_value || payload.peak || null,
    reasonForSpike: null,
    remarks: payload.raw || row.description || "",
  };
}

function mapRecovery(row) {
  const entry = parseJsonField(row.entry_json, {}) || {};
  const params = parseJsonField(row.params_json, entry.params || {}) || {};
  const collected = num(row.collected_at);
  return {
    timestamp: row.timestamp || (collected != null ? new Date(collected * 1000).toISOString() : null),
    collected_at: collected,
    component: row.component || entry.component || entry.fault?.component || null,
    action: row.action || entry.action || null,
    pid: row.pid ?? params.pid ?? entry.params?.pid ?? null,
    process: row.process || params.process || params.name || entry.process || null,
    result: row.result || (row.success ? "success" : row.success === 0 ? "failed" : entry.result) || null,
    success: row.success === 1 || row.success === true || entry.success === true,
    message: row.message || entry.message || "",
    verification: entry.verification || entry.after_metrics ? "Recorded" : "—",
    status: row.success === 1 || entry.success ? "Completed" : row.success === 0 ? "Failed" : "Recorded",
    remarks: row.message || entry.message || "",
    duration_seconds: num(row.duration_seconds ?? entry.duration_seconds),
    raw: row,
  };
}

function mapDigitalTwin(row) {
  return {
    id: row.id,
    timestamp: row.timestamp,
    collected_at: num(row.collected_at),
    component: row.component,
    fault: row.fault,
    action: row.action,
    pid: row.pid,
    target_process: row.target_process,
    before_state: parseJsonField(row.before_state, row.before_state),
    predicted_state: parseJsonField(row.predicted_state, row.predicted_state),
    risk: row.risk,
    confidence: num(row.confidence),
    prediction_basis: row.prediction_basis,
    approved: Boolean(row.approved),
    executed: Boolean(row.executed),
    actual_state: parseJsonField(row.actual_state, row.actual_state),
    prediction_accuracy: row.prediction_accuracy,
    result: row.result,
  };
}

function detectGaps(samples, bucketSeconds) {
  const gaps = [];
  if (!samples?.length || samples.length < 2) return gaps;
  const threshold = Math.max((bucketSeconds || 60) * 3, 5 * 60);
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1].collected_at;
    const cur = samples[i].collected_at;
    if (prev == null || cur == null) continue;
    const delta = cur - prev;
    if (delta > threshold) {
      gaps.push({
        start: prev,
        end: cur,
        startIso: new Date(prev * 1000).toISOString(),
        endIso: new Date(cur * 1000).toISOString(),
        label: `Telemetry gap: ${formatLocal(prev)} – ${formatLocal(cur)}`,
        durationSeconds: delta,
      });
    }
  }
  return gaps;
}

function buildCoverageSection(api, intervalKey, customRange) {
  const cov = api.dataCoverage || {};
  const interval = REPORT_INTERVALS[intervalKey];
  const requestedLabel =
    intervalKey === "custom" && customRange?.start && customRange?.end
      ? `${formatLocal(customRange.start / 1000)} – ${formatLocal(customRange.end / 1000)}`
      : interval?.label || intervalKey;

  const reqSec = num(cov.requestedSeconds);
  const availSec = num(cov.availableSeconds);
  const missingSec = num(cov.missingSeconds);

  let narrative = cov.notice || "";
  if (cov.status === "PARTIAL" && reqSec && availSec != null) {
    const reqDays = reqSec / 86400;
    const availDays = availSec / 86400;
    const missingDays = Math.max(0, reqDays - availDays);
    if (reqDays >= 1) {
      narrative =
        `Requested reporting period: ${reqDays.toFixed(1)} days. ` +
        `Available historical telemetry: ${availDays.toFixed(1)} days. ` +
        `Telemetry was not available for the earlier ${missingDays.toFixed(1)} days.`;
    }
  }
  if (cov.status === "EMPTY") {
    narrative =
      "No historical telemetry is available in the database for the requested reporting period.";
  }

  return {
    status: cov.status || (api.telemetry_count ? "PARTIAL" : "EMPTY"),
    notice: narrative,
    requestedLabel,
    requestedStart: cov.requestedStart,
    requestedEnd: cov.requestedEnd,
    requestedStartIso: cov.requestedStartIso,
    requestedEndIso: cov.requestedEndIso,
    availableStart: cov.availableStart,
    availableEnd: cov.availableEnd,
    availableStartIso: cov.availableStartIso,
    availableEndIso: cov.availableEndIso,
    databaseStart: cov.databaseStart,
    databaseEnd: cov.databaseEnd,
    databaseStartIso: cov.databaseStartIso,
    databaseEndIso: cov.databaseEndIso,
    requestedSeconds: reqSec,
    availableSeconds: availSec,
    missingSeconds: missingSec,
    coveragePercent: cov.coveragePercent,
    coverageDurationLabel: formatDurationSeconds(availSec),
    requestedDurationLabel: formatDurationSeconds(reqSec),
    telemetrySampleCount: cov.telemetrySampleCount ?? api.telemetry_raw_count ?? 0,
    faultEventCount: cov.faultEventCount ?? api.fault_count ?? 0,
    recoveryEventCount: cov.recoveryEventCount ?? api.recovery_count ?? 0,
    digitalTwinCount: cov.digitalTwinCount ?? api.digital_twin_count ?? 0,
    retentionDays: cov.retentionDays ?? 30,
    incomplete: cov.status === "PARTIAL",
    empty: cov.status === "EMPTY" || !(api.telemetry?.length),
  };
}

function buildExecutiveSummary(samples, faults, coverage, hostname) {
  const crit = faults.filter((f) => String(f.severity).toLowerCase() === "critical").length;
  const warn = faults.filter((f) => String(f.severity).toLowerCase() === "warning").length;
  const resolved = faults.filter((f) =>
    String(f.status || "").toLowerCase().includes("resolved") ||
    String(f.severity).toLowerCase() === "resolved"
  ).length;
  const unresolved = faults.length - resolved;

  let summary;
  if (coverage.empty) {
    summary =
      "No historical telemetry is available in the database for the requested reporting period. " +
      "Historical sections below indicate unavailable data. No live metrics were substituted.";
  } else if (coverage.incomplete) {
    summary =
      `Historical data is incomplete for the requested period. ${coverage.notice} `;
    const cpu = computeStats(samples.map((s) => s.cpu_usage));
    const mem = computeStats(samples.map((s) => s.mem_usage));
    const parts = [];
    if (cpu.count) parts.push(`CPU averaged ${cpu.avg}%`);
    if (mem.count) parts.push(`memory averaged ${mem.avg}%`);
    if (parts.length) summary += `Over the available window, ${parts.join(" and ")}.`;
  } else {
    const cpu = computeStats(samples.map((s) => s.cpu_usage));
    const mem = computeStats(samples.map((s) => s.mem_usage));
    const parts = [];
    if (cpu.count) parts.push(`CPU averaged ${cpu.avg}% utilization`);
    if (mem.count) parts.push(`memory averaged ${mem.avg}%`);
    summary = `System telemetry over the requested period shows ${parts.join(" and ") || "stable operation"}.`;
  }

  if (crit > 0) summary += ` ${crit} critical fault event(s) were recorded.`;
  else if (warn > 0) summary += ` ${warn} warning fault event(s) were recorded.`;
  else if (!coverage.empty) summary += " No critical or warning fault events were recorded in this window.";

  const latest = samples[samples.length - 1] || {};
  const byComponent = {};
  faults.forEach((f) => {
    if (String(f.severity).toLowerCase() === "critical") {
      byComponent[f.component] = (byComponent[f.component] || 0) + 1;
    }
  });
  const highestSeverityComponent =
    Object.entries(byComponent).sort((a, b) => b[1] - a[1])[0]?.[0] ||
    (crit || warn ? faults[0]?.component : "None");

  return {
    overallHealth: latest.lh_health || (crit ? "Critical" : warn ? "Warning" : coverage.empty ? "No Data" : "Healthy"),
    healthScore: latest.lh_score ?? "Not Available",
    monitoringDuration: coverage.availableSeconds
      ? coverage.coverageDurationLabel
      : "0",
    sampleCount: samples.length,
    criticalAlerts: crit,
    warningAlerts: warn,
    totalFaults: faults.length,
    recoveredFaults: resolved,
    unresolvedFaults: unresolved,
    highestSeverityComponent,
    summary,
    hostname: hostname || latest.hostname || "Not Available",
    os: "Not Available",
    kernel: "Not Available",
    requestedPeriod: coverage.requestedLabel,
    availablePeriod:
      coverage.availableStartIso && coverage.availableEndIso
        ? `${formatLocal(coverage.availableStart)} – ${formatLocal(coverage.availableEnd)}`
        : "No telemetry available",
    dataCoveragePercent: coverage.coveragePercent,
    coverageStatus: coverage.status,
  };
}

function buildHardwareMetrics(samples) {
  const rows = [];
  const defs = [
    ["CPU Usage", "cpu_usage", "%"],
    ["CPU Temperature", "cpu_temp", "°C"],
    ["CPU Load (1 min)", "cpu_load_1", ""],
    ["CPU User", "cpu_user", "%"],
    ["CPU System", "cpu_system", "%"],
    ["Memory Usage", "mem_usage", "%"],
    ["Memory Available", "mem_available_gb", " GB"],
    ["Swap Usage", "mem_swap", "%"],
    ["GPU Temperature", "gpu_temp", "°C"],
    ["GPU Utilization", "gpu_util", "%"],
    ["GPU VRAM Usage", "gpu_vram", "%"],
    ["GPU Power Draw", "gpu_power", "W"],
    ["NIC Utilization", "nic_util", "%"],
    ["NIC RX", "nic_rx", " Mbps"],
    ["NIC TX", "nic_tx", " Mbps"],
    ["NIC Error Count", "nic_errors", ""],
    ["Disk / I/O Busy", "io_busy", "%"],
    ["I/O Throughput", "io_total_mbps", " MB/s"],
    ["I/O IOPS", "io_iops", ""],
    ["I/O Queue Depth", "io_queue", ""],
    ["I/O Latency", "io_latency", " ms"],
    ["Link Health Score", "lh_score", ""],
  ];

  defs.forEach(([label, key, suffix]) => {
    const stats = computeStats(samples.map((s) => s[key]));
    if (stats.count === 0) return;
    rows.push([
      label,
      `${stats.avg}${suffix}`,
      `${stats.min}${suffix}`,
      `${stats.max}${suffix}`,
      `${stats.current}${suffix}`,
      stats.trend,
    ]);
  });

  const mountKeys = new Set();
  samples.forEach((s) => (s.disk_mounts || []).forEach((m) => mountKeys.add(m.mp)));
  mountKeys.forEach((mp) => {
    const stats = computeStats(
      samples.map((s) => (s.disk_mounts || []).find((m) => m.mp === mp)?.pct ?? null)
    );
    if (stats.count === 0) return;
    rows.push([
      `Disk ${mp} Capacity`,
      `${stats.avg}%`,
      `${stats.min}%`,
      `${stats.max}%`,
      `${stats.current}%`,
      stats.trend,
    ]);
  });

  return rows;
}

function seriesFromSamples(samples, key, label, suffix) {
  const points = samples
    .filter((s) => s[key] != null && s.t != null)
    .map((s) => ({ t: s.t, v: s[key], collected_at: s.collected_at }));
  if (points.length < 2) return null;
  return { key, label, suffix, points, unit: suffix };
}

function buildTrendSeries(samples) {
  const series = [];
  const defs = [
    ["cpu_usage", "CPU Utilization (%)", "%"],
    ["gpu_util", "GPU Utilization (%)", "%"],
    ["mem_usage", "RAM Usage (%)", "%"],
    ["io_busy", "Disk Busy (%)", "%"],
    ["nic_util", "NIC Utilization (%)", "%"],
    ["io_total_mbps", "I/O Throughput (MB/s)", " MB/s"],
    ["cpu_temp", "CPU Temperature (°C)", "°C"],
    ["gpu_temp", "GPU Temperature (°C)", "°C"],
    ["io_latency", "Disk / I/O Latency (ms)", " ms"],
    ["io_queue", "I/O Queue Depth", ""],
    ["io_iops", "I/O IOPS", ""],
    ["nic_rx", "NIC RX (Mbps)", " Mbps"],
    ["nic_tx", "NIC TX (Mbps)", " Mbps"],
    ["lh_score", "Link Health Score", ""],
  ];
  defs.forEach(([key, label, suffix]) => {
    const s = seriesFromSamples(samples, key, label, suffix);
    if (s) series.push(s);
  });
  return series;
}

function buildOverallHealthGraph(samples) {
  const series = [];
  [
    ["cpu_usage", "CPU"],
    ["gpu_util", "GPU"],
    ["mem_usage", "RAM"],
    ["io_busy", "Disk"],
    ["nic_util", "NIC"],
    ["io_total_mbps", "I/O"],
  ].forEach(([key, label]) => {
    const points = samples
      .filter((s) => s[key] != null && s.t != null)
      .map((s) => ({ t: s.t, v: s[key] }));
    if (points.length >= 2) series.push({ key, label, points });
  });
  return {
    title: "Overall Component Health Trend",
    xAxis: "Time",
    yAxis: "Health / Utilization (%)",
    series,
  };
}

function buildComponentAnalysis(samples, faults) {
  const latest = samples[samples.length - 1] || {};
  const components = [
    {
      name: "CPU",
      keys: ["cpu_usage", "cpu_temp", "cpu_load_1"],
      metrics: [
        ["Usage", latest.cpu_usage != null ? `${latest.cpu_usage}%` : null],
        ["Temperature", latest.cpu_temp != null ? `${latest.cpu_temp}°C` : null],
        ["Load 1m", latest.cpu_load_1 != null ? String(latest.cpu_load_1) : null],
      ],
    },
    {
      name: "GPU",
      keys: ["gpu_util", "gpu_temp", "gpu_vram"],
      metrics: [
        ["Utilization", latest.gpu_util != null ? `${latest.gpu_util}%` : null],
        ["VRAM", latest.gpu_vram != null ? `${latest.gpu_vram}%` : null],
        ["Temperature", latest.gpu_temp != null ? `${latest.gpu_temp}°C` : null],
        ["Model", latest.gpu_model || null],
      ],
    },
    {
      name: "RAM",
      keys: ["mem_usage", "mem_available_gb", "mem_swap"],
      metrics: [
        ["Usage", latest.mem_usage != null ? `${latest.mem_usage}%` : null],
        ["Available", latest.mem_available_gb != null ? `${latest.mem_available_gb} GB` : null],
        ["Swap", latest.mem_swap != null ? `${latest.mem_swap}%` : null],
      ],
    },
    {
      name: "DISK",
      keys: ["io_busy"],
      metrics: [
        ["Busy", latest.io_busy != null ? `${latest.io_busy}%` : null],
        ["Device", latest.io_device || null],
      ],
    },
    {
      name: "NIC",
      keys: ["nic_util", "nic_rx", "nic_tx", "nic_errors"],
      metrics: [
        ["Utilization", latest.nic_util != null ? `${latest.nic_util}%` : null],
        ["RX", latest.nic_rx != null ? `${latest.nic_rx} Mbps` : null],
        ["TX", latest.nic_tx != null ? `${latest.nic_tx} Mbps` : null],
        ["Errors", latest.nic_errors != null ? String(latest.nic_errors) : null],
      ],
    },
    {
      name: "IO Control",
      keys: ["io_total_mbps", "io_iops", "io_queue", "io_latency"],
      metrics: [
        ["Throughput", latest.io_total_mbps != null ? `${latest.io_total_mbps} MB/s` : null],
        ["IOPS", latest.io_iops != null ? String(latest.io_iops) : null],
        ["Queue", latest.io_queue != null ? String(latest.io_queue) : null],
        ["Latency", latest.io_latency != null ? `${latest.io_latency} ms` : null],
      ],
    },
  ];

  return components.map((c) => {
    const stats = computeStats(samples.map((s) => s[c.keys[0]]));
    const componentFaults = faults.filter((f) => {
      const name = String(f.component || "").toLowerCase();
      const target = c.name.toLowerCase().replace(" control", "");
      return name.includes(target) || name === c.name.toLowerCase();
    });
    let level = "unknown";
    if (stats.count) {
      if (c.keys[0] === "cpu_usage" || c.keys[0] === "mem_usage" || c.keys[0] === "gpu_util" || c.keys[0] === "io_busy") {
        if (stats.max >= 90) level = "critical";
        else if (stats.max >= 75) level = "warning";
        else level = "healthy";
      } else {
        level = "healthy";
      }
    }
    if (componentFaults.some((f) => String(f.severity).toLowerCase() === "critical")) level = "critical";
    else if (componentFaults.some((f) => String(f.severity).toLowerCase() === "warning") && level === "healthy") {
      level = "warning";
    }

    return {
      name: c.name,
      level,
      status: stats.count
        ? `Avg ${stats.avg ?? "—"}, peak ${stats.max ?? "—"} over available historical window.`
        : "No historical samples for this component in the selected period.",
      faults: componentFaults,
      liveMetrics: c.metrics.filter(([, v]) => v != null),
      inventory: [],
      stats,
    };
  });
}

function buildSpikeAnalysis(samples, faults) {
  const spikes = [];
  const metricMap = [
    { key: "cpu_usage", component: "CPU", warn: 75, crit: 90, label: "CPU utilization" },
    { key: "mem_usage", component: "RAM", warn: 80, crit: 90, label: "Memory usage" },
    { key: "gpu_util", component: "GPU", warn: 80, crit: 95, label: "GPU utilization" },
    { key: "io_busy", component: "DISK", warn: 70, crit: 90, label: "Disk busy" },
    { key: "nic_util", component: "NIC", warn: 70, crit: 90, label: "NIC utilization" },
  ];

  metricMap.forEach(({ key, component, warn, crit, label }) => {
    let inSpike = false;
    let startIdx = null;
    let peak = null;
    let peakIdx = null;
    for (let i = 0; i < samples.length; i += 1) {
      const v = samples[i][key];
      if (v == null) continue;
      if (v >= warn) {
        if (!inSpike) {
          inSpike = true;
          startIdx = i;
          peak = v;
          peakIdx = i;
        } else if (v > peak) {
          peak = v;
          peakIdx = i;
        }
      } else if (inSpike) {
        const pre = startIdx > 0 ? samples[startIdx - 1][key] : null;
        const post = samples[i][key];
        spikes.push({
          component,
          metric: label,
          timestamp: formatLocal(samples[peakIdx].collected_at),
          t: samples[peakIdx].t,
          peak,
          threshold: peak >= crit ? crit : warn,
          severity: peak >= crit ? "Critical" : "Warning",
          duration: formatDurationSeconds(
            samples[i - 1].collected_at - samples[startIdx].collected_at
          ),
          preSpikeValue: pre,
          postSpikeValue: post,
          reasonForSpike:
            "An elevated period was observed in historical telemetry. " +
            "The available telemetry does not provide sufficient evidence to determine the cause.",
        });
        inSpike = false;
      }
    }
    if (inSpike && startIdx != null) {
      spikes.push({
        component,
        metric: label,
        timestamp: formatLocal(samples[peakIdx].collected_at),
        t: samples[peakIdx].t,
        peak,
        threshold: peak >= crit ? crit : warn,
        severity: peak >= crit ? "Critical" : "Warning",
        duration: formatDurationSeconds(
          samples[samples.length - 1].collected_at - samples[startIdx].collected_at
        ),
        preSpikeValue: startIdx > 0 ? samples[startIdx - 1][key] : null,
        postSpikeValue: null,
        reasonForSpike:
          "An elevated period was observed in historical telemetry. " +
          "The available telemetry does not provide sufficient evidence to determine the cause.",
      });
    }
  });

  // Enrich fault logbook rows with spike correlation when timestamps align (~5 min)
  faults.forEach((f) => {
    const near = spikes.find(
      (s) =>
        s.component.toLowerCase() === String(f.component || "").toLowerCase() &&
        f.t &&
        Math.abs(s.t - f.t) < 5 * 60 * 1000
    );
    if (near) {
      f.reasonForSpike = near.reasonForSpike;
      f.peakValue = f.peakValue ?? near.peak;
      f.thresholdCrossed = f.thresholdCrossed || String(near.threshold);
    } else if (!f.reasonForSpike) {
      f.reasonForSpike =
        "Insufficient correlated process telemetry to determine a spike cause.";
    }
  });

  return spikes;
}

function buildVisualAnalysis(samples, faults, spikes) {
  const analyses = [];
  const components = [
    { name: "CPU", key: "cpu_usage", unit: "%" },
    { name: "GPU", key: "gpu_util", unit: "%" },
    { name: "RAM", key: "mem_usage", unit: "%" },
    { name: "Disk", key: "io_busy", unit: "%" },
    { name: "NIC", key: "nic_util", unit: "%" },
    { name: "I/O", key: "io_total_mbps", unit: " MB/s" },
  ];

  components.forEach(({ name, key, unit }) => {
    const stats = computeStats(samples.map((s) => s[key]));
    if (!stats.count) {
      analyses.push({
        component: name,
        commentary: `No historical ${name} telemetry was available for the selected reporting period.`,
        average: null,
        peak: null,
        minimum: null,
        warningEvents: 0,
        criticalEvents: 0,
      });
      return;
    }
    const relatedFaults = faults.filter((f) =>
      String(f.component || "").toLowerCase().includes(name.toLowerCase().replace("/", ""))
    );
    const relatedSpikes = spikes.filter((s) => s.component.toLowerCase().includes(name.toLowerCase().split("/")[0].toLowerCase()) || s.component === name);
    const warn = relatedFaults.filter((f) => String(f.severity).toLowerCase() === "warning").length
      + relatedSpikes.filter((s) => s.severity === "Warning").length;
    const crit = relatedFaults.filter((f) => String(f.severity).toLowerCase() === "critical").length
      + relatedSpikes.filter((s) => s.severity === "Critical").length;

    let commentary;
    if (relatedSpikes.length === 0 && crit === 0 && warn === 0) {
      commentary =
        `${name} remained within observed healthy operating levels for most of the available ` +
        `historical window (average ${stats.avg}${unit}, peak ${stats.max}${unit}).`;
    } else if (relatedSpikes.length > 0) {
      const s0 = relatedSpikes[0];
      commentary =
        `${name} averaged ${stats.avg}${unit} with a peak of ${stats.max}${unit}. ` +
        `A sustained increase was observed around ${s0.timestamp}, during which the metric ` +
        `crossed the ${s0.severity.toLowerCase()} threshold (${s0.threshold}${unit}). ` +
        `The available telemetry does not provide sufficient evidence to determine the cause.`;
    } else {
      commentary =
        `${name} averaged ${stats.avg}${unit} (peak ${stats.max}${unit}). ` +
        `${warn + crit} related fault event(s) were recorded in the historical database.`;
    }

    analyses.push({
      component: name,
      commentary,
      average: stats.avg,
      peak: stats.max,
      minimum: stats.min,
      warningEvents: warn,
      criticalEvents: crit,
    });
  });

  return analyses;
}

function buildLogbook(faults) {
  return faults.map((f) => ({
    component: f.component,
    severity: f.severity,
    reason: f.description || f.message || "—",
    faultDetected: f.faultDetected,
    faultCorrected: f.faultCorrected,
    duration: f.durationLabel,
    peak: f.peakValue ?? f.currentValue ?? "—",
    threshold: f.thresholdCrossed || "—",
    reasonForSpike: f.reasonForSpike || "—",
    remarks: f.remarks || "—",
    status: f.status || "—",
  }));
}

function buildRecommendations(samples, faultAnalysis, coverage) {
  const recs = [];
  const seen = new Set();
  const add = (text) => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    recs.push(text);
  };

  if (coverage.empty) {
    add(
      "No historical telemetry is available for this period. Ensure CM.py is running and " +
        "persisting samples to telemetry_history.db, then regenerate the report."
    );
    return recs;
  }
  if (coverage.incomplete) {
    add(
      "Historical coverage is partial for the requested window. Earlier data was not present " +
        "in SQLite (aged out or not yet collected). Do not treat missing days as healthy."
    );
  }

  faultAnalysis
    .filter((f) => String(f.severity).toLowerCase() !== "resolved")
    .forEach((f) => add(`[${f.component}] Review historical fault: ${f.description || f.message}`));

  const cpu = computeStats(samples.map((s) => s.cpu_usage));
  if (cpu.max != null && cpu.max >= 90) {
    add(`CPU usage peaked at ${cpu.max}% in historical telemetry. Investigate high-load processes.`);
  }
  const mem = computeStats(samples.map((s) => s.mem_usage));
  if (mem.max != null && mem.max >= 90) {
    add(`Memory usage reached ${mem.max}% in the available historical window.`);
  }

  if (recs.length === 0) {
    add("No significant performance concerns were identified in the available historical telemetry.");
  }
  return recs;
}

function buildFaultDistribution(faults) {
  const bySeverity = { Critical: 0, Warning: 0, Resolved: 0 };
  const byComponent = {};
  faults.forEach((f) => {
    const sev = f.severity || "Warning";
    bySeverity[sev] = (bySeverity[sev] || 0) + 1;
    byComponent[f.component] = (byComponent[f.component] || 0) + 1;
  });
  return { bySeverity, byComponent };
}

/**
 * Transform SQLite /reports/data payload into report document model.
 */
export function buildReportDataFromHistory(apiPayload, config = {}) {
  const {
    intervalKey = "1h",
    customRange = null,
    title = "",
    generatedBy = "",
    description = "",
    sections = null,
  } = typeof config === "string" ? { intervalKey: config } : config;

  const api = apiPayload || {};
  const samples = (api.telemetry || []).map(mapTelemetrySample).filter((s) => s.t != null);
  const faults = (api.faults || []).map(mapFault);
  const recoveryHistory = (api.recovery_history || []).map(mapRecovery);
  const digitalTwin = (api.digital_twin_simulations || []).map(mapDigitalTwin);
  const coverage = buildCoverageSection(api, intervalKey, customRange);
  const gaps = detectGaps(samples, api.bucket_seconds || 60);
  const spikes = buildSpikeAnalysis(samples, faults);
  const faultAnalysis = faults.map((f) => ({
    ...f,
    explanation: f.description || f.message || "Fault recorded in historical database.",
    recommendation: "Review historical telemetry and recovery history for this component.",
  }));
  const visualAnalysis = buildVisualAnalysis(samples, faults, spikes);
  const trendSeries = buildTrendSeries(samples);
  const overallHealthGraph = buildOverallHealthGraph(samples);
  const interval = REPORT_INTERVALS[intervalKey];
  const intervalLabel =
    intervalKey === "custom" && customRange?.start && customRange?.end
      ? `${formatLocal(customRange.start / 1000)} – ${formatLocal(customRange.end / 1000)}`
      : interval?.label || intervalKey;

  const hostname =
    samples.find((s) => s.hostname)?.hostname ||
    api.databaseStats?.hostname ||
    null;

  const reportPeriod = {
    range: api.range || intervalKey,
    requestedStart: coverage.requestedStart,
    requestedEnd: coverage.requestedEnd,
    requestedStartIso: coverage.requestedStartIso,
    requestedEndIso: coverage.requestedEndIso,
    label: intervalLabel,
  };

  const graphs = {
    overallHealth: overallHealthGraph,
    components: trendSeries,
    gaps,
    requestedStart: coverage.requestedStart,
    requestedEnd: coverage.requestedEnd,
    availableStart: coverage.availableStart,
    availableEnd: coverage.availableEnd,
    bucketSeconds: api.bucket_seconds || null,
  };

  const reportData = {
    intervalKey,
    intervalLabel,
    generatedAt: new Date(),
    title: title || "Infrastructure Health & Incident Report",
    generatedBy: generatedBy || "System Administrator",
    description,
    dataSource: "SQLite telemetry_history.db via /reports/data",
    reportPeriod,
    dataCoverage: coverage,
    span: {
      start: coverage.availableStart != null ? new Date(coverage.availableStart * 1000) : null,
      end: coverage.availableEnd != null ? new Date(coverage.availableEnd * 1000) : null,
      label: coverage.coverageDurationLabel,
      requestedLabel: coverage.requestedLabel,
    },
    executive: buildExecutiveSummary(samples, faults, coverage, hostname),
    inventory: null,
    componentAnalysis: buildComponentAnalysis(samples, faults),
    hardwareMetrics: buildHardwareMetrics(samples),
    trendSeries,
    graphs,
    visualAnalysis,
    spikes,
    logbook: buildLogbook(faults),
    faults,
    faultAnalysis,
    faultDistribution: buildFaultDistribution(faults),
    componentHealthSnapshot: buildComponentAnalysis(samples, faults).map((c) => ({
      name: c.name,
      level: c.level,
    })),
    connectivityStatus: samples.length
      ? {
          linkHealth: {
            overall: samples[samples.length - 1].lh_health,
            score: samples[samples.length - 1].lh_score,
          },
          assessments: {},
        }
      : null,
    recoveryHistory,
    digitalTwin,
    digitalTwinEmptyMessage:
      digitalTwin.length === 0
        ? "No Digital Twin simulations were recorded during this reporting period."
        : null,
    aiRootCause: faultAnalysis.map((f) => ({
      component: f.component,
      severity: f.severity,
      metricName: f.metricName,
      analysis: f.explanation,
      recommendation: f.recommendation,
      timestamp: f.t,
    })),
    recommendations: buildRecommendations(samples, faultAnalysis, coverage),
    predictiveMaintenance: (() => {
      const predictiveWindowSec = 6 * 3600;
      const predictiveAnchor =
        samples.length > 0 ? samples[samples.length - 1].collected_at : null;
      const predictiveSamples =
        predictiveAnchor != null
          ? samples.filter(
              (s) =>
                s.collected_at != null &&
                s.collected_at >= predictiveAnchor - predictiveWindowSec
            )
          : [];
      const predictiveRaw = buildPredictiveMaintenance(predictiveSamples, {
        windowHours: 6,
      });
      return {
        disclaimer: PREDICTIVE_DISCLAIMER,
        generatedAt: predictiveRaw.generatedAt,
        windowHours: predictiveRaw.windowHours,
        sampleCount: predictiveRaw.sampleCount,
        rows: (predictiveRaw.predictions || []).map((p) => ({
          component: p.component,
          metric: p.metric,
          current:
            p.currentValue != null
              ? `${Number(p.currentValue).toFixed(1)}${p.unit}`
              : "—",
          warning: `${p.warningThreshold}${p.unit}`,
          critical: `${p.criticalThreshold}${p.unit}`,
          trend: p.trendRateLabel || "—",
          confidence: p.confidence || "—",
          etaWarning: p.estimatedTimeToWarningLabel || "—",
          etaCritical: p.estimatedTimeToCriticalLabel || "—",
          risk: p.risk,
          recommendation: p.hasPrediction
            ? `Monitor ${p.metric}; trend projects toward threshold if conditions continue. Advisory only.`
            : p.message || "No significant degradation trend detected",
          explanation: p.explanation,
        })),
      };
    })(),
    rawSamples: samples,
    telemetry: samples,
    context: { hostname, source: "sqlite" },
    sampleCount: samples.length,
    telemetryRawCount: api.telemetry_raw_count ?? samples.length,
    bucketSeconds: api.bucket_seconds || null,
    database: api.database || null,
    gaps,
  };

  if (sections) {
    reportData.activeSections = filterSelectedSections(reportData, sections);
  }

  return reportData;
}

/**
 * Fetch SQLite historical data and build the report model.
 * Never falls back to sessionStorage.
 */
export async function buildReportData(config = {}) {
  const apiPayload = await fetchHistoricalReportData(config);
  return buildReportDataFromHistory(apiPayload, config);
}

export { explainFault, recommendForFault };

function explainFault(fault) {
  return fault.description || fault.message || "Fault recorded in historical database.";
}

function recommendForFault() {
  return "Review historical telemetry and recovery history for this component.";
}

export function buildFaultAnalysis(faults) {
  return (faults || []).map((f) => ({
    ...f,
    explanation: explainFault(f),
    recommendation: recommendForFault(f),
  }));
}
