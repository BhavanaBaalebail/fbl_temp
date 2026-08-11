/**
 * Report Data Builder — format-agnostic report model from SQLite history.
 * Source of truth: CM.py GET /reports/data → telemetry_history.db
 * Never uses sessionStorage for historical telemetry.
 */

import { REPORT_INTERVALS, fetchHistoricalReportData } from "./historicalReportApi";
import { filterSelectedSections } from "./reportSections";
import {
  fmtNum,
  fmtPct,
  fmtInt,
  fmtDuration,
  fmtLocal,
  fmtIsoLocal,
  statusTitle,
  computeStats,
} from "./reportFormat";
import { REPORT_THRESHOLDS, thresholdPair } from "./reportThresholds";

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseJsonField(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function severityRank(level) {
  const l = String(level || "").toLowerCase();
  if (l === "critical") return 3;
  if (l === "warning") return 2;
  if (l === "healthy") return 1;
  return 0;
}

function worstStatus(...levels) {
  return levels.reduce(
    (worst, cur) => (severityRank(cur) > severityRank(worst) ? cur : worst),
    "nodata"
  );
}

function levelFromValue(value, pair) {
  if (value == null || !pair) return "nodata";
  const { warning, critical } = pair;
  if (critical != null && value >= critical) return "critical";
  if (warning != null && value >= warning) return "warning";
  return "healthy";
}

function thresholdLabel(pair, unit = "") {
  if (!pair) return "-";
  const parts = [];
  if (pair.warning != null) parts.push(`warn >=${pair.warning}${unit}`);
  if (pair.critical != null) parts.push(`crit >=${pair.critical}${unit}`);
  return parts.length ? parts.join(" | ") : "-";
}

function matchComponent(name, target) {
  const n = String(name || "")
    .toLowerCase()
    .replace(/\s+/g, "");
  const t = String(target || "")
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!n || !t) return false;
  if (t === "io") return n === "io" || n.includes("io") || n.includes("disk");
  if (t === "disk") return n.includes("disk") || n.includes("storage") || n === "io";
  if (t === "ram") return n.includes("ram") || n.includes("mem");
  return n.includes(t) || t.includes(n);
}

function extractProcessHint(message) {
  if (!message) return null;
  const text = String(message);
  const m =
    text.match(/process\s+[\"']?([^\s\"',:;]+)[\"']?/i) ||
    text.match(/\bpid\s*[:=]?\s*(\d+)\b/i) ||
    text.match(/\b(\d{3,})\b/);
  if (!m) return null;
  if (/^\d+$/.test(m[1])) return `process ${m[1]}`;
  return m[1];
}

function findPeakSample(samples, key) {
  let peak = null;
  let peakSample = null;
  for (const s of samples || []) {
    const v = num(s?.[key]);
    if (v == null) continue;
    if (peak == null || v > peak) {
      peak = v;
      peakSample = s;
    }
  }
  return { peak, peakSample, peakAt: peakSample ? fmtLocal(peakSample.collected_at ?? peakSample.t) : null };
}

function chartYBounds(points, pair) {
  const vals = (points || []).map((p) => p.v).filter((v) => v != null && Number.isFinite(v));
  if (!vals.length) return { yMin: 0, yMax: 1 };
  let yMin = Math.min(...vals, 0);
  let yMax = Math.max(...vals);
  if (pair?.critical != null) yMax = Math.max(yMax, pair.critical);
  if (pair?.warning != null) yMax = Math.max(yMax, pair.warning);
  if (yMax === yMin) yMax = yMin + 1;
  const pad = (yMax - yMin) * 0.08;
  return { yMin: Math.max(0, yMin - pad * 0.25), yMax: yMax + pad };
}

function makeChart(samples, { key, title, unit, yLabel, thresholds }) {
  const points = (samples || [])
    .filter((s) => s?.t != null && s[key] != null)
    .map((s) => ({ t: s.t, v: Number(s[key]) }));
  if (points.length < 2) return null;
  const pair = thresholdPair(thresholds);
  const { yMin, yMax } = chartYBounds(points, pair);
  return {
    key,
    title,
    unit: unit || "",
    yLabel: yLabel || title,
    points,
    warning: pair?.warning ?? null,
    critical: pair?.critical ?? null,
    yMin,
    yMax,
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
        label: `Telemetry gap: ${fmtLocal(prev)} – ${fmtLocal(cur)}`,
        durationSeconds: delta,
        durationLabel: fmtDuration(delta),
      });
    }
  }
  return gaps;
}

/* -------------------------------------------------------------------------- */
/* Row mappers                                                                */
/* -------------------------------------------------------------------------- */

function mapTelemetrySample(row) {
  if (!row || typeof row !== "object") return null;
  const mountsRaw = parseJsonField(row.disk_mounts_json, []) || [];
  const mounts = Array.isArray(mountsRaw) ? mountsRaw : [];
  const collectedAt = num(row.collected_at);
  return {
    t: collectedAt != null ? collectedAt * 1000 : null,
    collected_at: collectedAt,
    timestamp: row.timestamp || null,
    hostname: row.hostname || null,
    cpu_usage: num(row.cpu_usage_percent),
    cpu_temp: num(row.cpu_temperature_celsius),
    cpu_load_1: num(row.cpu_load_1min),
    cpu_user: num(row.cpu_user_percent),
    cpu_system: num(row.cpu_system_percent),
    mem_usage: num(row.memory_usage_percent),
    mem_swap: num(row.memory_swap_usage_percent),
    mem_available_gb: num(row.memory_available_gb),
    mem_used_gb: num(row.memory_used_gb),
    mem_total_gb: num(row.memory_total_gb),
    gpu_temp: num(row.gpu_temperature_celsius),
    gpu_util: num(row.gpu_utilization_percent),
    gpu_vram: num(row.gpu_memory_utilization_percent),
    gpu_power: num(row.gpu_power_draw_watts),
    gpu_model: row.gpu_model || null,
    nic_util: num(row.nic_utilization_percent),
    nic_rx: num(row.nic_rx_mbps),
    nic_tx: num(row.nic_tx_mbps),
    nic_errors: num(row.nic_error_count),
    nic_up: num(row.nic_up_count),
    io_busy: num(row.io_busy_percent),
    io_total_mbps: num(row.io_total_mb_per_sec),
    io_iops: num(row.io_total_iops),
    io_queue: num(row.io_queue_depth),
    io_latency: num(row.io_avg_latency_ms),
    io_device: row.io_device || null,
    disk_mounts: mounts.map((m) => ({
      mp: m.mp || m.mountpoint || m.mount || "—",
      pct: num(m.pct ?? m.usage_percent),
      size_gb: num(m.size_gb),
      used_gb: num(m.used_gb),
      free_gb: num(m.free_gb),
    })),
    lh_score: num(row.lh_score),
    lh_health: row.lh_overall_health || null,
  };
}

function mapFault(row) {
  if (!row || typeof row !== "object") return null;
  const first = num(row.first_seen_at) ?? num(row.timestamp);
  const last = num(row.last_seen_at) ?? first;
  const payload = parseJsonField(row.payload, {}) || {};
  const durationSec =
    first != null && last != null && last >= first ? last - first : null;
  const status = row.status || "Active";
  const corrected =
    String(status).toLowerCase().includes("clear") ||
    String(status).toLowerCase().includes("resolved");

  return {
    id: row.fault_id || row.id,
    fault_id: row.fault_id,
    t: first != null ? first * 1000 : null,
    firstSeenAt: first,
    lastSeenAt: last,
    severity: row.severity || "Warning",
    component: row.component || "unknown",
    metricName: row.metric_name || payload.metric_name || null,
    currentValue: row.current_value ?? payload.current_value ?? null,
    thresholdCrossed: row.threshold_crossed || payload.threshold || null,
    description: row.message || row.description || "",
    message: row.message || row.description || "",
    status,
    source: row.source || "health_summary",
    durationSeconds: durationSec,
    durationLabel: fmtDuration(durationSec),
    faultDetected: fmtLocal(first),
    faultCorrected: corrected ? fmtLocal(last) : "Correction time unavailable.",
    peakValue: row.current_value ?? payload.peak ?? null,
    reasonForSpike: null,
    remarks: payload.raw || row.description || row.message || "",
  };
}

function mapRecovery(row) {
  if (!row || typeof row !== "object") return null;
  const entry = parseJsonField(row.entry_json, {}) || {};
  const params = parseJsonField(row.params_json, entry.params || {}) || {};
  const collected = num(row.collected_at);
  const message = row.message || entry.message || "";
  const process =
    row.process ||
    params.process ||
    params.name ||
    entry.process ||
    extractProcessHint(message) ||
    null;
  const pid = row.pid ?? params.pid ?? entry.params?.pid ?? null;
  const success =
    row.success === 1 ||
    row.success === true ||
    entry.success === true;
  const failed = row.success === 0 || row.success === false || entry.success === false;
  const action = row.action || entry.action || "—";
  let component = row.component || entry.component || entry.fault?.component || null;
  if (!component || component === "—") {
    const act = String(action).toLowerCase();
    if (act.startsWith("gpu.")) component = "GPU";
    else if (act.startsWith("cpu.")) component = "CPU";
    else if (act.startsWith("ram.") || act.startsWith("memory.")) component = "RAM";
    else if (act.startsWith("disk.")) component = "DISK";
    else if (act.startsWith("nic.")) component = "NIC";
    else if (act.startsWith("io.")) component = "IO";
    else component = "—";
  }

  const tMs =
    collected != null
      ? collected * 1000
      : row.timestamp
        ? new Date(row.timestamp).getTime()
        : null;

  return {
    time: fmtLocal(collected) !== "—" ? fmtLocal(collected) : fmtIsoLocal(row.timestamp),
    timestamp: row.timestamp || (collected != null ? new Date(collected * 1000).toISOString() : null),
    t: Number.isFinite(tMs) ? tMs : null,
    collected_at: collected,
    component,
    action,
    pid: pid != null ? String(pid) : "—",
    process: process || "—",
    result:
      row.result ||
      (success ? "success" : failed ? "failed" : entry.result) ||
      "—",
    verification:
      entry.verification ||
      (String(message).toLowerCase().includes("confirmed")
        ? "Verified"
        : entry.after_metrics
          ? "Recorded"
          : "—"),
    status: success ? "Completed" : failed ? "Failed" : "Recorded",
    remarks: message || "—",
    success,
    message,
    trigger: entry.fault?.description || entry.confirmation ? "Operator-initiated" : "Recorded recovery",
    faultHint: entry.fault || null,
    duration_seconds: num(row.duration_seconds ?? entry.duration_seconds),
  };
}

function mapDigitalTwin(row) {
  if (!row || typeof row !== "object") return null;
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

/* -------------------------------------------------------------------------- */
/* Coverage / executive                                                       */
/* -------------------------------------------------------------------------- */

function buildCoverageSection(api, samples, intervalKey, customRange) {
  const cov = api?.dataCoverage || {};
  const interval = REPORT_INTERVALS[intervalKey];
  const requestedLabel =
    intervalKey === "custom" && customRange?.start && customRange?.end
      ? `${fmtLocal(customRange.start)} – ${fmtLocal(customRange.end)}`
      : interval?.label || intervalKey;

  const reqSec = num(cov.requestedSeconds);
  const availSec = num(cov.availableSeconds);
  const missingSec = num(cov.missingSeconds);
  const rawSampleCount = num(api?.telemetry_raw_count) ?? num(cov.telemetrySampleCount) ?? 0;
  const reportPointCount = samples?.length ?? 0;

  let status = cov.status || (reportPointCount ? "PARTIAL" : "EMPTY");
  if (!reportPointCount && !rawSampleCount) status = "EMPTY";

  let notice = cov.notice || "";
  if (status === "PARTIAL" && reqSec && availSec != null) {
    const reqDays = reqSec / 86400;
    const availDays = availSec / 86400;
    const missingDays = Math.max(0, reqDays - availDays);
    if (reqDays >= 1) {
      notice =
        `Requested reporting period: ${reqDays.toFixed(1)} days. ` +
        `Available historical telemetry: ${availDays.toFixed(1)} days. ` +
        `Telemetry was not available for the earlier ${missingDays.toFixed(1)} days. ` +
        `Report uses ${reportPointCount} aggregated point(s) derived from ${rawSampleCount} raw SQLite sample(s).`;
    }
  }
  if (status === "EMPTY") {
    notice =
      "No historical telemetry is available in the database for the requested reporting period. " +
      "Raw sample count and report point count are both zero; live metrics were not substituted.";
  } else if (status === "COMPLETE" && !notice) {
    notice =
      `Historical telemetry fully covers the requested reporting period. ` +
      `Report uses ${reportPointCount} aggregated point(s) from ${rawSampleCount} raw SQLite sample(s).`;
  } else if (status === "COMPLETE" && notice && !notice.includes("raw")) {
    notice =
      `${notice} Report uses ${reportPointCount} aggregated point(s) from ${rawSampleCount} raw SQLite sample(s).`;
  }

  return {
    status,
    notice,
    requestedLabel,
    requestedStart: cov.requestedStart ?? null,
    requestedEnd: cov.requestedEnd ?? null,
    requestedStartIso: cov.requestedStartIso ?? null,
    requestedEndIso: cov.requestedEndIso ?? null,
    availableStart: cov.availableStart ?? null,
    availableEnd: cov.availableEnd ?? null,
    availableStartIso: cov.availableStartIso ?? null,
    availableEndIso: cov.availableEndIso ?? null,
    databaseStart: cov.databaseStart ?? null,
    databaseEnd: cov.databaseEnd ?? null,
    databaseStartIso: cov.databaseStartIso ?? null,
    databaseEndIso: cov.databaseEndIso ?? null,
    requestedSeconds: reqSec,
    availableSeconds: availSec,
    missingSeconds: missingSec,
    coveragePercent: cov.coveragePercent ?? null,
    coverageDurationLabel: fmtDuration(availSec),
    requestedDurationLabel: fmtDuration(reqSec),
    rawSampleCount,
    reportPointCount,
    /** @deprecated prefer rawSampleCount — kept for transitional exporters */
    telemetrySampleCount: rawSampleCount,
    faultEventCount: cov.faultEventCount ?? api?.fault_count ?? 0,
    recoveryEventCount: cov.recoveryEventCount ?? api?.recovery_count ?? 0,
    digitalTwinCount: cov.digitalTwinCount ?? api?.digital_twin_count ?? 0,
    retentionDays: cov.retentionDays ?? 30,
    incomplete: status === "PARTIAL",
    empty: status === "EMPTY" || reportPointCount === 0,
  };
}

function buildExecutiveSummary(samples, faults, recoveries, coverage, hostname) {
  const crit = (faults || []).filter((f) => String(f.severity).toLowerCase() === "critical").length;
  const warn = (faults || []).filter((f) => String(f.severity).toLowerCase() === "warning").length;
  const resolved = (faults || []).filter(
    (f) =>
      String(f.status || "").toLowerCase().includes("resolved") ||
      String(f.status || "").toLowerCase().includes("clear") ||
      String(f.severity).toLowerCase() === "resolved"
  ).length;
  const unresolved = Math.max(0, (faults || []).length - resolved);
  const recoveryActions = (recoveries || []).length;

  const cpu = computeStats((samples || []).map((s) => s.cpu_usage));
  const gpu = computeStats((samples || []).map((s) => s.gpu_util));
  const mem = computeStats((samples || []).map((s) => s.mem_usage));
  const gpuPeak = findPeakSample(samples, "gpu_util");

  let summary;
  if (coverage.empty) {
    summary =
      `Host ${hostname || "unknown"} has no SQLite telemetry for the requested window. ` +
      `Coverage status is EMPTY (${coverage.coveragePercent ?? 0}% of requested duration). ` +
      `No live metrics were substituted. Fault events: ${faults.length}; recovery actions: ${recoveryActions}.`;
  } else {
    const bits = [];
    if (cpu.count) bits.push(`CPU averaged ${fmtPct(cpu.avg)} (peak ${fmtPct(cpu.max)})`);
    if (gpu.count) {
      bits.push(
        `GPU utilization peaked at ${fmtPct(gpuPeak.peak)}${gpuPeak.peakAt ? ` at ${gpuPeak.peakAt}` : ""}`
      );
    }
    if (mem.count) bits.push(`memory averaged ${fmtPct(mem.avg)}`);
    const coverageBit =
      coverage.status === "PARTIAL"
        ? `Available telemetry covers ${fmtDuration(coverage.availableSeconds)} ` +
          `(${coverage.coveragePercent ?? "—"}% of the requested period; ${coverage.reportPointCount} report points / ${coverage.rawSampleCount} raw samples).`
        : `Telemetry covers ${fmtDuration(coverage.availableSeconds)} with ${coverage.reportPointCount} report points from ${coverage.rawSampleCount} raw samples.`;

    summary =
      `Host ${hostname || "unknown"} — ${bits.join("; ") || "component metrics were sparse"}. ` +
      `${coverageBit} ` +
      `Recorded faults: ${crit} critical, ${warn} warning (${faults.length} total); ` +
      `${recoveryActions} recovery action(s); ${resolved} recovered / ${unresolved} unresolved.`;
  }

  const byComponent = {};
  (faults || []).forEach((f) => {
    if (String(f.severity).toLowerCase() === "critical") {
      byComponent[f.component] = (byComponent[f.component] || 0) + 1;
    }
  });
  const highestSeverityComponent =
    Object.entries(byComponent).sort((a, b) => b[1] - a[1])[0]?.[0] ||
    (crit || warn ? faults[0]?.component : "None");

  const latest = samples?.[samples.length - 1] || {};

  return {
    overallHealth:
      latest.lh_health ||
      (crit ? "Critical" : warn ? "Warning" : coverage.empty ? "No Data" : "Healthy"),
    healthScore: latest.lh_score ?? "Not Available",
    monitoringDuration: coverage.availableSeconds ? coverage.coverageDurationLabel : "0",
    sampleCount: coverage.reportPointCount,
    rawSampleCount: coverage.rawSampleCount,
    reportPointCount: coverage.reportPointCount,
    criticalAlerts: crit,
    warningAlerts: warn,
    totalFaults: (faults || []).length,
    recoveredFaults: resolved,
    unresolvedFaults: unresolved,
    recoveryActions,
    highestSeverityComponent,
    summary,
    hostname: hostname || latest.hostname || "Not Available",
    os: "Not Available",
    kernel: "Not Available",
    requestedPeriod: coverage.requestedLabel,
    availablePeriod:
      coverage.availableStart != null && coverage.availableEnd != null
        ? `${fmtLocal(coverage.availableStart)} – ${fmtLocal(coverage.availableEnd)}`
        : "No telemetry available",
    dataCoveragePercent: coverage.coveragePercent,
    coverageStatus: coverage.status,
  };
}

/* -------------------------------------------------------------------------- */
/* Component sections                                                         */
/* -------------------------------------------------------------------------- */

function buildInterpretation({
  name,
  primaryKey,
  unit,
  stats,
  peakAt,
  pair,
  warnCount,
  critCount,
  recoveries,
}) {
  if (!stats?.count) {
    return `No historical ${name} telemetry was available in SQLite for the selected reporting period.`;
  }

  const avg = unit === "%" ? fmtPct(stats.avg) : unit ? `${fmtNum(stats.avg)}${unit}` : fmtNum(stats.avg);
  const peak = unit === "%" ? fmtPct(stats.max) : unit ? `${fmtNum(stats.max)}${unit}` : fmtNum(stats.max);
  const min = unit === "%" ? fmtPct(stats.min) : unit ? `${fmtNum(stats.min)}${unit}` : fmtNum(stats.min);

  const crossedCrit = pair?.critical != null && stats.max >= pair.critical;
  const crossedWarn = pair?.warning != null && stats.max >= pair.warning;
  const thresholdBit = crossedCrit
    ? `Peak crossed the critical threshold (>=${pair.critical}${unit === "%" ? "%" : unit}).`
    : crossedWarn
      ? `Peak crossed the warning threshold (>=${pair.warning}${unit === "%" ? "%" : unit}).`
      : pair?.warning != null
        ? `Peak remained below the warning threshold (>=${pair.warning}${unit === "%" ? "%" : unit}).`
        : "No report threshold is defined for this primary metric.";

  const peakBit = peakAt ? ` Peak occurred at ${peakAt}.` : "";
  const eventBit =
    critCount || warnCount
      ? ` Correlated events: ${critCount} critical and ${warnCount} warning spike/fault marker(s).`
      : " No threshold spike or fault markers were correlated for this component.";
  const recoveryBit =
    recoveries > 0
      ? ` ${recoveries} recovery action(s) were recorded for this component.`
      : "";

  return (
    `${name} averaged ${avg} over the available window (min ${min}, peak ${peak}).` +
    peakBit +
    ` ${thresholdBit}` +
    eventBit +
    recoveryBit +
    ` Trend: ${stats.trend || "—"}.`
  );
}

function countComponentEvents(name, faults, spikes) {
  const relatedFaults = (faults || []).filter((f) => matchComponent(f.component, name));
  const relatedSpikes = (spikes || []).filter((s) => matchComponent(s.component, name));
  const warnCount =
    relatedFaults.filter((f) => String(f.severity).toLowerCase() === "warning").length +
    relatedSpikes.filter((s) => String(s.severity).toLowerCase() === "warning").length;
  const critCount =
    relatedFaults.filter((f) => String(f.severity).toLowerCase() === "critical").length +
    relatedSpikes.filter((s) => String(s.severity).toLowerCase() === "critical").length;
  return { warnCount, critCount, relatedFaults };
}

function buildComponentSections(samples, faults, spikes, recoveries) {
  const latest = samples?.[samples.length - 1] || {};
  const defs = [
    {
      name: "CPU",
      title: "CPU HEALTH ANALYSIS",
      primaryKey: "cpu_usage",
      unit: "%",
      thresholds: REPORT_THRESHOLDS.CPU.utilization,
      thresholdLabel: thresholdLabel(thresholdPair(REPORT_THRESHOLDS.CPU.utilization), "%"),
      latestRecorded: () =>
        [
          ["Usage", fmtPct(latest.cpu_usage)],
          ["Temperature", latest.cpu_temp != null ? `${fmtNum(latest.cpu_temp)}°C` : "—"],
          ["Load 1m", fmtNum(latest.cpu_load_1)],
          ["User", fmtPct(latest.cpu_user)],
          ["System", fmtPct(latest.cpu_system)],
        ],
      charts: [
        {
          key: "cpu_usage",
          title: "CPU Utilization Over Time",
          unit: "%",
          yLabel: "Utilization (%)",
          thresholds: REPORT_THRESHOLDS.CPU.utilization,
        },
        {
          key: "cpu_temp",
          title: "CPU Temperature",
          unit: "°C",
          yLabel: "Temperature (°C)",
          thresholds: REPORT_THRESHOLDS.CPU.temperature,
        },
      ],
    },
    {
      name: "GPU",
      title: "GPU HEALTH ANALYSIS",
      primaryKey: "gpu_util",
      unit: "%",
      thresholds: REPORT_THRESHOLDS.GPU.utilization,
      thresholdLabel: thresholdLabel(thresholdPair(REPORT_THRESHOLDS.GPU.utilization), "%"),
      latestRecorded: () =>
        [
          ["Utilization", fmtPct(latest.gpu_util)],
          ["VRAM", fmtPct(latest.gpu_vram)],
          ["Temperature", latest.gpu_temp != null ? `${fmtNum(latest.gpu_temp)}°C` : "—"],
          ["Power", latest.gpu_power != null ? `${fmtNum(latest.gpu_power)} W` : "—"],
          ["Model", latest.gpu_model || "—"],
        ],
      charts: [
        {
          key: "gpu_util",
          title: "GPU Utilization Over Time",
          unit: "%",
          yLabel: "Utilization (%)",
          thresholds: REPORT_THRESHOLDS.GPU.utilization,
        },
        {
          key: "gpu_vram",
          title: "VRAM Usage Over Time",
          unit: "%",
          yLabel: "VRAM (%)",
          thresholds: null,
        },
        {
          key: "gpu_temp",
          title: "GPU Temperature Over Time",
          unit: "°C",
          yLabel: "Temperature (°C)",
          thresholds: REPORT_THRESHOLDS.GPU.temperature,
        },
      ],
    },
    {
      name: "RAM",
      title: "RAM HEALTH ANALYSIS",
      primaryKey: "mem_usage",
      unit: "%",
      thresholds: REPORT_THRESHOLDS.RAM.utilization,
      thresholdLabel: thresholdLabel(thresholdPair(REPORT_THRESHOLDS.RAM.utilization), "%"),
      latestRecorded: () =>
        [
          ["Usage", fmtPct(latest.mem_usage)],
          ["Available", latest.mem_available_gb != null ? `${fmtNum(latest.mem_available_gb)} GB` : "—"],
          ["Used", latest.mem_used_gb != null ? `${fmtNum(latest.mem_used_gb)} GB` : "—"],
          ["Total", latest.mem_total_gb != null ? `${fmtNum(latest.mem_total_gb)} GB` : "—"],
          ["Swap", fmtPct(latest.mem_swap)],
        ],
      charts: [
        {
          key: "mem_usage",
          title: "Memory Utilization Over Time",
          unit: "%",
          yLabel: "Usage (%)",
          thresholds: REPORT_THRESHOLDS.RAM.utilization,
        },
        {
          key: "mem_available_gb",
          title: "Available Memory Over Time",
          unit: " GB",
          yLabel: "Available (GB)",
          thresholds: null,
        },
        {
          key: "mem_swap",
          title: "Swap Usage",
          unit: "%",
          yLabel: "Swap (%)",
          thresholds: REPORT_THRESHOLDS.RAM.swap,
        },
      ],
    },
    {
      name: "DISK",
      title: "DISK HEALTH ANALYSIS",
      primaryKey: "io_busy",
      unit: "%",
      thresholds: REPORT_THRESHOLDS.DISK.busy,
      thresholdLabel: thresholdLabel(thresholdPair(REPORT_THRESHOLDS.DISK.busy), "%"),
      latestRecorded: () => {
        const mountBits = (latest.disk_mounts || [])
          .slice(0, 3)
          .map((m) => [String(m.mp), m.pct != null ? fmtPct(m.pct) : "—"]);
        return [
          ["Busy", fmtPct(latest.io_busy)],
          ["Throughput", latest.io_total_mbps != null ? `${fmtNum(latest.io_total_mbps)} MB/s` : "—"],
          ["IOPS", fmtInt(latest.io_iops)],
          ["Latency", latest.io_latency != null ? `${fmtNum(latest.io_latency)} ms` : "—"],
          ["Queue", fmtNum(latest.io_queue)],
          ["Device", latest.io_device || "—"],
          ...mountBits,
        ];
      },
      charts: [
        {
          key: "io_busy",
          title: "Disk Busy Over Time",
          unit: "%",
          yLabel: "Busy (%)",
          thresholds: REPORT_THRESHOLDS.DISK.busy,
        },
        {
          key: "io_total_mbps",
          title: "Disk Throughput",
          unit: " MB/s",
          yLabel: "Throughput (MB/s)",
          thresholds: REPORT_THRESHOLDS.DISK.throughput,
        },
        {
          key: "io_iops",
          title: "Disk IOPS",
          unit: "",
          yLabel: "IOPS",
          thresholds: null,
        },
        {
          key: "io_latency",
          title: "Disk Latency",
          unit: " ms",
          yLabel: "Latency (ms)",
          thresholds: REPORT_THRESHOLDS.DISK.latency,
        },
        {
          key: "io_queue",
          title: "Disk Queue Depth",
          unit: "",
          yLabel: "Queue Depth",
          thresholds: REPORT_THRESHOLDS.DISK.queue,
        },
      ],
    },
    {
      name: "NIC",
      title: "NIC HEALTH ANALYSIS",
      primaryKey: "nic_util",
      unit: "%",
      thresholds: REPORT_THRESHOLDS.NIC.utilization,
      thresholdLabel: thresholdLabel(thresholdPair(REPORT_THRESHOLDS.NIC.utilization), "%"),
      latestRecorded: () =>
        [
          ["Utilization", fmtPct(latest.nic_util)],
          ["RX", latest.nic_rx != null ? `${fmtNum(latest.nic_rx)} Mbps` : "—"],
          ["TX", latest.nic_tx != null ? `${fmtNum(latest.nic_tx)} Mbps` : "—"],
          ["Errors", fmtInt(latest.nic_errors)],
          ["Links Up", fmtInt(latest.nic_up)],
        ],
      charts: [
        {
          key: "nic_util",
          title: "NIC Utilization Over Time",
          unit: "%",
          yLabel: "Utilization (%)",
          thresholds: REPORT_THRESHOLDS.NIC.utilization,
        },
        {
          key: "nic_rx",
          title: "NIC RX",
          unit: " Mbps",
          yLabel: "RX (Mbps)",
          thresholds: null,
        },
        {
          key: "nic_tx",
          title: "NIC TX",
          unit: " Mbps",
          yLabel: "TX (Mbps)",
          thresholds: null,
        },
      ],
    },
    {
      name: "IO",
      title: "IO HEALTH ANALYSIS",
      primaryKey: "io_total_mbps",
      unit: " MB/s",
      thresholds: REPORT_THRESHOLDS.IO.throughput,
      thresholdLabel: thresholdLabel(thresholdPair(REPORT_THRESHOLDS.IO.throughput), " MB/s"),
      latestRecorded: () =>
        [
          ["Throughput", latest.io_total_mbps != null ? `${fmtNum(latest.io_total_mbps)} MB/s` : "—"],
          ["IOPS", fmtInt(latest.io_iops)],
          ["Queue", fmtNum(latest.io_queue)],
          ["Latency", latest.io_latency != null ? `${fmtNum(latest.io_latency)} ms` : "—"],
          ["Device", latest.io_device || "—"],
        ],
      charts: [
        {
          key: "io_total_mbps",
          title: "I/O Throughput",
          unit: " MB/s",
          yLabel: "Throughput (MB/s)",
          thresholds: REPORT_THRESHOLDS.IO.throughput,
        },
        {
          key: "io_iops",
          title: "I/O IOPS",
          unit: "",
          yLabel: "IOPS",
          thresholds: null,
        },
        {
          key: "io_queue",
          title: "I/O Queue Depth",
          unit: "",
          yLabel: "Queue Depth",
          thresholds: REPORT_THRESHOLDS.IO.queue,
        },
        {
          key: "io_latency",
          title: "I/O Latency",
          unit: " ms",
          yLabel: "Latency (ms)",
          thresholds: REPORT_THRESHOLDS.IO.latency,
        },
      ],
    },
  ];

  return defs.map((def) => {
    const stats = computeStats((samples || []).map((s) => s[def.primaryKey]));
    const { peak, peakAt } = findPeakSample(samples, def.primaryKey);
    const pair = thresholdPair(def.thresholds);
    const peakStatus = levelFromValue(peak ?? stats.max, pair);
    const { warnCount, critCount, relatedFaults } = countComponentEvents(
      def.name,
      faults,
      spikes
    );
    const componentRecoveries = (recoveries || []).filter((r) =>
      matchComponent(r.component, def.name)
    ).length;

    let status = stats.count ? peakStatus : "nodata";
    if (critCount > 0) status = worstStatus(status, "critical");
    else if (warnCount > 0) status = worstStatus(status, "warning");

    const charts = (def.charts || [])
      .map((c) => makeChart(samples, c))
      .filter(Boolean);

    const interpretation = buildInterpretation({
      name: def.name,
      primaryKey: def.primaryKey,
      unit: def.unit,
      stats,
      peakAt,
      pair,
      warnCount,
      critCount,
      recoveries: componentRecoveries,
    });

    return {
      name: def.name,
      title: def.title,
      status,
      statusLabel: statusTitle(status),
      stats: {
        avg: stats.avg,
        min: stats.min,
        max: stats.max,
        current: stats.current,
        trend: stats.trend,
        count: stats.count,
      },
      latestRecorded: def.latestRecorded().filter(([, v]) => v != null && v !== ""),
      thresholds: def.thresholdLabel,
      thresholdLabel: def.thresholdLabel,
      warnCount,
      critCount,
      charts,
      interpretation,
      peakAt,
      faults: relatedFaults,
    };
  });
}

function buildComponentOverview(componentSections) {
  return (componentSections || []).map((c) => ({
    component: c.name,
    status: c.status,
    avg:
      c.stats?.avg == null
        ? "—"
        : c.name === "IO"
          ? `${fmtNum(c.stats.avg)} MB/s`
          : fmtPct(c.stats.avg),
    peak:
      c.stats?.max == null
        ? "—"
        : c.name === "IO"
          ? `${fmtNum(c.stats.max)} MB/s`
          : fmtPct(c.stats.max),
    min:
      c.stats?.min == null
        ? "—"
        : c.name === "IO"
          ? `${fmtNum(c.stats.min)} MB/s`
          : fmtPct(c.stats.min),
    thresholdLabel: c.thresholdLabel || c.thresholds || "—",
    warnings: c.warnCount || 0,
    criticals: c.critCount || 0,
    trend: c.stats?.trend || "—",
  }));
}

/* -------------------------------------------------------------------------- */
/* Spikes / logbook / recommendations                                         */
/* -------------------------------------------------------------------------- */

function buildSpikeAnalysis(samples, faults) {
  const spikes = [];
  const metricMap = [
    {
      key: "cpu_usage",
      component: "CPU",
      pair: thresholdPair(REPORT_THRESHOLDS.CPU.utilization),
      label: "CPU utilization",
      unit: "%",
    },
    {
      key: "mem_usage",
      component: "RAM",
      pair: thresholdPair(REPORT_THRESHOLDS.RAM.utilization),
      label: "Memory usage",
      unit: "%",
    },
    {
      key: "gpu_util",
      component: "GPU",
      pair: thresholdPair(REPORT_THRESHOLDS.GPU.utilization),
      label: "GPU utilization",
      unit: "%",
    },
    {
      key: "io_busy",
      component: "DISK",
      pair: thresholdPair(REPORT_THRESHOLDS.DISK.busy),
      label: "Disk busy",
      unit: "%",
    },
    {
      key: "nic_util",
      component: "NIC",
      pair: thresholdPair(REPORT_THRESHOLDS.NIC.utilization),
      label: "NIC utilization",
      unit: "%",
    },
    {
      key: "io_total_mbps",
      component: "IO",
      pair: thresholdPair(REPORT_THRESHOLDS.IO.throughput),
      label: "I/O throughput",
      unit: " MB/s",
    },
  ];

  metricMap.forEach(({ key, component, pair, label, unit }) => {
    if (!pair?.warning && !pair?.critical) return;
    const warn = pair.warning ?? pair.critical;
    const crit = pair.critical ?? null;
    let inSpike = false;
    let startIdx = null;
    let peak = null;
    let peakIdx = null;

    const emit = (endIdx, openEnded) => {
      const preVal = startIdx > 0 ? samples[startIdx - 1][key] : null;
      const postVal = openEnded ? null : samples[endIdx]?.[key];
      const endSample = samples[openEnded ? samples.length - 1 : Math.max(endIdx - 1, startIdx)];
      const durationSec =
        (endSample?.collected_at ?? samples[startIdx].collected_at) - samples[startIdx].collected_at;
      const possibleCause =
        "Elevated values were observed in historical telemetry around the peak. " +
        "Available SQLite samples do not include sufficient process attribution to confirm a root cause.";

      spikes.push({
        component,
        metric: label,
        timestamp: fmtLocal(samples[peakIdx].collected_at),
        t: samples[peakIdx].t,
        peak,
        before: preVal,
        after: postVal,
        preSpikeValue: preVal,
        postSpikeValue: postVal,
        duration: fmtDuration(durationSec),
        durationSeconds: durationSec,
        threshold: peak >= (crit ?? Infinity) ? crit : warn,
        severity: peak >= (crit ?? Infinity) ? "Critical" : "Warning",
        unit,
        possibleCause,
        reasonForSpike: possibleCause,
      });
    };

    for (let i = 0; i < (samples || []).length; i += 1) {
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
        emit(i, false);
        inSpike = false;
        startIdx = null;
      }
    }
    if (inSpike && startIdx != null) emit(samples.length - 1, true);
  });

  (faults || []).forEach((f) => {
    const near = spikes.find(
      (s) =>
        matchComponent(s.component, f.component) &&
        f.t &&
        Math.abs(s.t - f.t) < 5 * 60 * 1000
    );
    if (near) {
      f.reasonForSpike = near.possibleCause;
      f.peakValue = f.peakValue ?? near.peak;
      f.thresholdCrossed = f.thresholdCrossed || String(near.threshold);
    } else if (!f.reasonForSpike) {
      f.reasonForSpike =
        "Insufficient correlated process telemetry to determine a spike cause.";
    }
  });

  return spikes;
}

function buildLogbook(faults) {
  const rows = (faults || []).map((f) => ({
    component: f.component || "—",
    severity: f.severity || "—",
    reason: f.description || f.message || "—",
    faultDetected: f.faultDetected || "—",
    faultCorrected: f.faultCorrected || "—",
    duration: f.durationLabel || "—",
    peak: f.peakValue ?? f.currentValue ?? "—",
    threshold: f.thresholdCrossed || "—",
    reasonForSpike: f.reasonForSpike || "—",
    remarks: f.remarks || "—",
    status: f.status || "—",
  }));

  return {
    rows,
    emptyMessage:
      rows.length === 0
        ? "NO FAULT EVENTS RECORDED. No warning or critical fault events were recorded in the selected historical reporting period."
        : null,
  };
}

/**
 * Assign Event IDs and correlate faults <-> recoveries by component + time.
 * Correlation window: recovery within 0..30 minutes after fault first-seen.
 */
function buildCorrelatedLogs(faults, recoveries) {
  const faultEvents = (faults || []).map((f, i) => {
    const eventId = `FE-${String(i + 1).padStart(3, "0")}`;
    return {
      ...f,
      eventId,
      eventType: "fault",
      metric: f.metricName || "—",
      observedValue: f.peakValue ?? f.currentValue ?? "—",
      threshold: f.thresholdCrossed || "—",
      faultReason: f.description || f.message || "—",
      detectionStatus: f.status || "Active",
      correctedAt: f.faultCorrected || "Correction time unavailable.",
      duration: f.durationLabel || "—",
      recoveryAction: null,
      recoveryId: null,
      finalStatus: f.status || "—",
      correlation: "Correlation unavailable from historical records.",
    };
  });

  const recoveryEvents = (recoveries || []).map((r, i) => {
    const recoveryId = `RA-${String(i + 1).padStart(3, "0")}`;
    return {
      ...r,
      recoveryId,
      eventType: "recovery",
      trigger: r.trigger || "Operator-initiated / recorded recovery",
      faultEventId: null,
      correlation: "Fault correlation: Not available",
    };
  });

  const WINDOW_MS = 30 * 60 * 1000;
  faultEvents.forEach((f) => {
    if (f.t == null) return;
    const candidates = recoveryEvents.filter(
      (r) =>
        r.t != null &&
        matchComponent(r.component, f.component) &&
        r.t >= f.t - 60 * 1000 &&
        r.t <= f.t + WINDOW_MS
    );
    if (!candidates.length) return;
    candidates.sort((a, b) => Math.abs(a.t - f.t) - Math.abs(b.t - f.t));
    const best = candidates[0];
    if (best.faultEventId) return;
    best.faultEventId = f.eventId;
    best.correlation = `Linked to ${f.eventId}`;
    f.recoveryAction = best.action;
    f.recoveryId = best.recoveryId;
    f.finalStatus = best.success ? "Recovered" : best.status || f.finalStatus;
    f.correlation = `Recovery ${best.recoveryId} (${best.action})`;
  });

  recoveryEvents.forEach((r) => {
    if (!r.faultEventId) {
      r.correlation =
        "Recovery action recorded without a corresponding fault event in the selected historical fault table.";
    }
  });

  return { faultEvents, recoveryEvents };
}

function buildInfrastructureTimeline(faultEvents, recoveryEvents, spikes) {
  const items = [];
  (faultEvents || []).forEach((f) => {
    if (f.t == null) return;
    items.push({
      t: f.t,
      timestamp: f.faultDetected || fmtLocal(f.t / 1000),
      kind: "FAULT",
      severity: f.severity,
      component: f.component,
      label: `${f.eventId}: ${f.faultReason}`,
      detail: `Detected ${f.faultDetected}; peak ${f.observedValue}; threshold ${f.threshold}`,
      id: f.eventId,
    });
  });
  (recoveryEvents || []).forEach((r) => {
    if (r.t == null && !r.timestamp) return;
    const t = r.t ?? new Date(r.timestamp).getTime();
    items.push({
      t,
      timestamp: r.time || fmtLocal(t / 1000),
      kind: "RECOVERY",
      severity: r.success ? "Success" : "Failed",
      component: r.component,
      label: `${r.recoveryId}: ${r.action}`,
      detail: `PID ${r.pid}; result ${r.result}; verification ${r.verification}`,
      id: r.recoveryId,
      faultEventId: r.faultEventId,
    });
  });
  (spikes || []).forEach((s, i) => {
    if (s.t == null) return;
    // Only include spikes that approach/cross warning (already filtered)
    items.push({
      t: s.t,
      timestamp: s.timestamp,
      kind: "SPIKE",
      severity: s.severity,
      component: s.component,
      label: `SP-${String(i + 1).padStart(3, "0")}: ${s.metric} peak ${s.peak}${s.unit || ""}`,
      detail: `Baseline ${s.before ?? "—"} -> peak ${s.peak}; threshold ${s.threshold}; duration ${s.duration}`,
      id: `SP-${String(i + 1).padStart(3, "0")}`,
    });
  });
  items.sort((a, b) => a.t - b.t);
  return items;
}

function buildActivitySummary(faultEvents, recoveryEvents, spikes, digitalTwin, samples) {
  const warnings = (faultEvents || []).filter((f) =>
    String(f.severity).toLowerCase().includes("warn")
  );
  const criticals = (faultEvents || []).filter((f) =>
    String(f.severity).toLowerCase().includes("crit")
  );
  const firstTs = (arr) => {
    const withT = (arr || []).filter((x) => x && x.t != null);
    if (!withT.length) return "—";
    const first = withT.reduce((a, b) => (a.t <= b.t ? a : b));
    return first.timestamp || first.time || first.faultDetected || "—";
  };
  const lastTs = (arr) => {
    const withT = (arr || []).filter((x) => x && x.t != null);
    if (!withT.length) return "—";
    const last = withT.reduce((a, b) => (a.t >= b.t ? a : b));
    return last.timestamp || last.time || last.faultDetected || "—";
  };

  const connectivity = (samples || []).filter(
    (s) => s.lh_health && String(s.lh_health).toLowerCase() !== "healthy"
  );

  return [
    {
      category: "Faults",
      count: (faultEvents || []).length,
      firstEvent: firstTs(faultEvents || []),
      lastEvent: lastTs(faultEvents || []),
      highestSeverity: criticals.length ? "Critical" : warnings.length ? "Warning" : "None",
      recoveryActions: (faultEvents || []).filter((f) => f.recoveryId).length,
      result: (faultEvents || []).length ? "See fault log" : "No faults",
    },
    {
      category: "Warnings",
      count: warnings.length,
      firstEvent: firstTs(warnings),
      lastEvent: lastTs(warnings),
      highestSeverity: warnings.length ? "Warning" : "None",
      recoveryActions: warnings.filter((f) => f.recoveryId).length,
      result: warnings.length ? "See fault log" : "None",
    },
    {
      category: "Criticals",
      count: criticals.length,
      firstEvent: firstTs(criticals),
      lastEvent: lastTs(criticals),
      highestSeverity: criticals.length ? "Critical" : "None",
      recoveryActions: criticals.filter((f) => f.recoveryId).length,
      result: criticals.length ? "See fault log" : "None",
    },
    {
      category: "Recoveries",
      count: (recoveryEvents || []).length,
      firstEvent: firstTs(recoveryEvents || []),
      lastEvent: lastTs(recoveryEvents || []),
      highestSeverity: (recoveryEvents || []).some((r) => !r.success) ? "Failed" : (recoveryEvents || []).length ? "Success" : "None",
      recoveryActions: (recoveryEvents || []).length,
      result: (recoveryEvents || []).length ? "See recovery log" : "No recoveries",
    },
    {
      category: "Significant Spikes",
      count: (spikes || []).length,
      firstEvent: firstTs(spikes || []),
      lastEvent: lastTs(spikes || []),
      highestSeverity: (spikes || []).some((s) => s.severity === "Critical")
        ? "Critical"
        : (spikes || []).length
          ? "Warning"
          : "None",
      recoveryActions: 0,
      result: (spikes || []).length ? "See spike analysis" : "No significant spikes",
    },
    {
      category: "Connectivity Events",
      count: connectivity.length,
      firstEvent: connectivity.length ? fmtLocal(connectivity[0].collected_at) : "—",
      lastEvent: connectivity.length
        ? fmtLocal(connectivity[connectivity.length - 1].collected_at)
        : "—",
      highestSeverity: connectivity.length ? "Degraded" : "None",
      recoveryActions: 0,
      result: connectivity.length ? "Link health not Healthy" : "Healthy / no events",
    },
    {
      category: "Digital Twin Simulations",
      count: (digitalTwin || []).length,
      firstEvent: "—",
      lastEvent: "—",
      highestSeverity: "None",
      recoveryActions: 0,
      result: (digitalTwin || []).length ? "See Digital Twin section" : "None",
    },
  ];
}

function buildSystemResourceTrend(samples) {
  const series = [];
  const defs = [
    { key: "cpu_usage", label: "CPU %", warning: thresholdPair(REPORT_THRESHOLDS.CPU.utilization)?.warning, critical: thresholdPair(REPORT_THRESHOLDS.CPU.utilization)?.critical },
    { key: "mem_usage", label: "RAM %", warning: thresholdPair(REPORT_THRESHOLDS.RAM.utilization)?.warning, critical: thresholdPair(REPORT_THRESHOLDS.RAM.utilization)?.critical },
    { key: "gpu_util", label: "GPU %", warning: thresholdPair(REPORT_THRESHOLDS.GPU.utilization)?.warning, critical: thresholdPair(REPORT_THRESHOLDS.GPU.utilization)?.critical },
  ];
  defs.forEach((d) => {
    const points = (samples || [])
      .filter((s) => s[d.key] != null && s.t != null)
      .map((s) => ({ t: s.t, v: s[d.key] }));
    if (points.length >= 2) {
      series.push({
        key: d.key,
        label: d.label,
        unit: "%",
        yLabel: "Utilization (%)",
        points,
        warning: d.warning,
        critical: d.critical,
      });
    }
  });
  return {
    title: "System Resource Utilization (CPU / RAM / GPU %)",
    unit: "%",
    yLabel: "Utilization (%)",
    series,
    compatible: true,
  };
}

function buildEventMarkerSeries(faultEvents, recoveryEvents) {
  return {
    faults: (faultEvents || [])
      .filter((f) => f.t != null)
      .map((f) => ({
        t: f.t,
        severity: f.severity,
        component: f.component,
        id: f.eventId,
        label: f.eventId,
      })),
    recoveries: (recoveryEvents || [])
      .filter((r) => r.t != null)
      .map((r) => ({
        t: r.t,
        component: r.component,
        id: r.recoveryId,
        label: r.recoveryId,
        result: r.result,
        action: r.action,
      })),
  };
}

function enrichChartsWithMarkers(componentSections, faultEvents, recoveryEvents) {
  return (componentSections || []).map((section) => {
    const relatedFaults = (faultEvents || []).filter((f) =>
      matchComponent(f.component, section.name)
    );
    const relatedRecoveries = (recoveryEvents || []).filter((r) =>
      matchComponent(r.component, section.name)
    );
    return {
      ...section,
      charts: (section.charts || []).map((ch) => ({
        ...ch,
        eventMarkers: {
          faults: relatedFaults.map((f) => ({
            t: f.t,
            label: f.eventId,
            severity: f.severity,
          })),
          recoveries: relatedRecoveries.map((r) => ({
            t: r.t,
            label: r.recoveryId,
            result: r.result,
          })),
        },
      })),
    };
  });
}

function buildSignificantSpikeDetails(spikes, faultEvents, recoveryEvents) {
  if (!(spikes || []).length) {
    return {
      rows: [],
      emptyMessage:
        "No significant threshold-related spikes detected in the selected historical reporting period.",
    };
  }
  const rows = spikes.map((s, i) => {
    const id = `SP-${String(i + 1).padStart(3, "0")}`;
    const fault = (faultEvents || []).find(
      (f) =>
        matchComponent(f.component, s.component) &&
        f.t &&
        Math.abs(f.t - s.t) < 5 * 60 * 1000
    );
    const recovery = (recoveryEvents || []).find(
      (r) =>
        matchComponent(r.component, s.component) &&
        r.t &&
        Math.abs(r.t - s.t) < 30 * 60 * 1000
    );
    const baseline = s.before;
    const increasePct =
      baseline != null && baseline !== 0
        ? (((s.peak - baseline) / Math.abs(baseline)) * 100).toFixed(1)
        : "—";
    return {
      id,
      timestamp: s.timestamp,
      t: s.t,
      component: s.component,
      metric: s.metric,
      baseline: baseline ?? "—",
      peak: s.peak,
      increasePct,
      threshold: s.threshold,
      duration: s.duration,
      severity: s.severity,
      unit: s.unit || "",
      faultCorrelation: fault ? fault.eventId : "None",
      recoveryCorrelation: recovery ? recovery.recoveryId : "None",
      interpretation:
        s.possibleCause ||
        (fault
          ? `Spike correlated with fault ${fault.eventId}.`
          : `Short ${s.component} increase; ${
              s.severity === "Warning" || s.severity === "Critical"
                ? "threshold interaction observed"
                : "remained within context of available telemetry"
            }.`),
    };
  });
  return { rows, emptyMessage: null };
}

function buildFaultDetailCards(faultEvents) {
  return (faultEvents || []).map((f) => ({
    eventId: f.eventId,
    component: f.component,
    severity: f.severity,
    reason: f.faultReason,
    detected: f.faultDetected,
    peak: f.observedValue,
    threshold: f.threshold,
    corrected: f.correctedAt,
    duration: f.duration,
    recovery: f.recoveryAction || "None recorded",
    recoveryId: f.recoveryId || "—",
    result: f.finalStatus,
    remarks: f.remarks || f.correlation || "—",
    occurrences: 1,
  }));
}

function buildFaultRecoveryChains(faultEvents, recoveryEvents) {
  const chains = [];
  (faultEvents || []).forEach((f) => {
    if (!f.recoveryId) return;
    const r = (recoveryEvents || []).find((x) => x.recoveryId === f.recoveryId);
    if (!r) return;
    chains.push({
      faultId: f.eventId,
      component: f.component,
      steps: [
        { stage: "Detection", detail: `${f.faultDetected}: ${f.faultReason}` },
        { stage: "Severity", detail: f.severity },
        { stage: "Recovery Action", detail: `${r.recoveryId} ${r.action} (PID ${r.pid})` },
        { stage: "Verification", detail: r.verification || r.remarks || "—" },
        { stage: "Final Status", detail: r.success ? "SUCCESS" : r.status },
      ],
    });
  });
  (recoveryEvents || []).forEach((r) => {
    if (r.faultEventId) return;
    chains.push({
      faultId: null,
      component: r.component,
      steps: [
        { stage: "Recovery Action", detail: `${r.recoveryId} ${r.action}` },
        {
          stage: "Correlation",
          detail:
            "Recovery action recorded without a corresponding fault event in the selected historical fault table.",
        },
        { stage: "Verification", detail: r.verification || "—" },
        { stage: "Final Status", detail: r.success ? "SUCCESS" : r.status },
      ],
    });
  });
  return chains;
}

export function explainFault(fault) {
  if (!fault) return "No fault details available.";
  const parts = [];
  if (fault.component) parts.push(`${fault.component}`);
  if (fault.metricName) parts.push(`metric ${fault.metricName}`);
  if (fault.currentValue != null) parts.push(`value ${fault.currentValue}`);
  if (fault.thresholdCrossed) parts.push(`threshold ${fault.thresholdCrossed}`);
  const base = fault.description || fault.message || "Fault recorded in historical database.";
  return parts.length ? `${base} (${parts.join(", ")}).` : base;
}

export function recommendForFault(fault) {
  if (!fault) {
    return "Review historical telemetry and recovery history for affected components.";
  }
  const comp = String(fault.component || "").toLowerCase();
  if (comp.includes("cpu")) {
    return "Inspect top CPU consumers around the fault window and confirm recovery actions cleared the condition.";
  }
  if (comp.includes("gpu")) {
    return "Review GPU utilization/temperature around the event and validate workload placement or thermal headroom.";
  }
  if (comp.includes("mem") || comp.includes("ram")) {
    return "Check memory pressure and swap activity in the available window; identify processes retaining RAM.";
  }
  if (comp.includes("nic") || comp.includes("net")) {
    return "Inspect NIC utilization, errors, and link state around the event; verify traffic spikes vs. link capacity.";
  }
  if (comp.includes("disk") || comp.includes("io") || comp.includes("storage")) {
    return "Review disk busy, queue depth, and latency around the event; identify heavy I/O processes.";
  }
  return "Review historical telemetry and recovery history for this component.";
}

export function buildFaultAnalysis(faults) {
  return (faults || []).map((f) => ({
    ...f,
    explanation: explainFault(f),
    recommendation: recommendForFault(f),
  }));
}

function buildRecommendations(samples, faultAnalysis, spikes, coverage, componentSections) {
  const immediate = [];
  const preventive = [];
  const monitoring = [];
  const seen = new Set();
  const add = (bucket, text) => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    bucket.push(text);
  };

  if (coverage.empty) {
    add(
      immediate,
      "Ensure CM.py is persisting samples to telemetry_history.db, then regenerate the report. " +
        "No historical telemetry was available for this period."
    );
    return { immediate, preventive, monitoring };
  }

  if (coverage.incomplete) {
    add(
      monitoring,
      `Coverage is PARTIAL (${coverage.coveragePercent ?? "—"}%): available window is ` +
        `${fmtDuration(coverage.availableSeconds)} of ${fmtDuration(coverage.requestedSeconds)} requested. ` +
        "Do not treat missing days as healthy."
    );
  }

  (faultAnalysis || [])
    .filter((f) => !String(f.status || "").toLowerCase().includes("resolved"))
    .slice(0, 8)
    .forEach((f) => {
      add(immediate, `[${f.component}] ${recommendForFault(f)}`);
    });

  (componentSections || []).forEach((c) => {
    if (c.status === "critical") {
      add(
        immediate,
        `${c.name} peaked at ${c.stats?.max != null ? (c.name === "IO" ? `${fmtNum(c.stats.max)} MB/s` : fmtPct(c.stats.max)) : "—"}` +
          `${c.peakAt ? ` (${c.peakAt})` : ""}; investigate and verify recovery.`
      );
    } else if (c.status === "warning") {
      add(
        preventive,
        `${c.name} reached warning levels (peak ${c.stats?.max != null ? (c.name === "IO" ? `${fmtNum(c.stats.max)} MB/s` : fmtPct(c.stats.max)) : "—"}). ` +
          "Schedule capacity/workload review before the next reporting window."
      );
    }
  });

  (spikes || []).slice(0, 5).forEach((s) => {
    add(
      preventive,
      `${s.component} ${s.metric} spike to ${s.peak}${s.unit || ""} at ${s.timestamp} ` +
        `(before ${s.before ?? "—"}, after ${s.after ?? "—"}, duration ${s.duration}).`
    );
  });

  add(
    monitoring,
    `Continue SQLite retention monitoring: ${coverage.reportPointCount} report points / ` +
      `${coverage.rawSampleCount} raw samples in this window.`
  );

  if (!immediate.length && !preventive.length) {
    add(
      monitoring,
      "No critical or warning component peaks required immediate action in the available historical window."
    );
  }

  return { immediate, preventive, monitoring };
}

/* -------------------------------------------------------------------------- */
/* Public builders                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Transform SQLite /reports/data payload into the report document model.
 */
export function buildReportDataFromHistory(apiPayload, config = {}) {
  const {
    intervalKey = "1h",
    customRange = null,
    title = "",
    generatedBy = "",
    description = "",
    sections = null,
  } = typeof config === "string" ? { intervalKey: config } : config || {};

  const api = apiPayload || {};
  const samples = (api.telemetry || [])
    .map(mapTelemetrySample)
    .filter((s) => s && s.t != null);
  const faults = (api.faults || []).map(mapFault).filter(Boolean);
  const recoveryHistory = (api.recovery_history || []).map(mapRecovery).filter(Boolean);
  const digitalTwinRows = (api.digital_twin_simulations || []).map(mapDigitalTwin).filter(Boolean);

  const coverage = buildCoverageSection(api, samples, intervalKey, customRange);
  const gaps = detectGaps(samples, api.bucket_seconds || 60);
  const spikes = buildSpikeAnalysis(samples, faults);
  const faultAnalysis = buildFaultAnalysis(faults);
  const { faultEvents, recoveryEvents } = buildCorrelatedLogs(faults, recoveryHistory);
  let componentSections = buildComponentSections(
    samples,
    faults,
    spikes,
    recoveryHistory
  );
  componentSections = enrichChartsWithMarkers(componentSections, faultEvents, recoveryEvents);
  const componentOverview = buildComponentOverview(componentSections);
  const logbook = buildLogbook(faults);
  const faultIncidentLog = {
    rows: faultEvents,
    emptyMessage:
      faultEvents.length === 0
        ? "NO FAULT EVENTS RECORDED. No warning or critical fault events were recorded in the selected historical reporting period."
        : null,
  };
  const recoveryActionLog = {
    rows: recoveryEvents,
    emptyMessage:
      recoveryEvents.length === 0
        ? "No recovery actions recorded during the selected historical reporting period."
        : null,
  };
  const infrastructureTimeline = buildInfrastructureTimeline(
    faultEvents,
    recoveryEvents,
    spikes
  );
  const activitySummary = buildActivitySummary(
    faultEvents,
    recoveryEvents,
    spikes,
    digitalTwinRows,
    samples
  );
  const systemResourceTrend = buildSystemResourceTrend(samples);
  const eventMarkers = buildEventMarkerSeries(faultEvents, recoveryEvents);
  const significantEvents = buildSignificantSpikeDetails(
    spikes,
    faultEvents,
    recoveryEvents
  );
  const faultDetailCards = buildFaultDetailCards(faultEvents);
  const faultRecoveryChains = buildFaultRecoveryChains(faultEvents, recoveryEvents);

  const hostname =
    samples.find((s) => s.hostname)?.hostname ||
    api.databaseStats?.hostname ||
    null;

  const interval = REPORT_INTERVALS[intervalKey];
  const intervalLabel =
    intervalKey === "custom" && customRange?.start && customRange?.end
      ? `${fmtLocal(customRange.start)} – ${fmtLocal(customRange.end)}`
      : interval?.label || intervalKey;

  const generatedAt = new Date();
  const reportId = `HMR-${generatedAt.getTime().toString(36).toUpperCase()}`;

  const domainStart =
    coverage.availableStart != null
      ? coverage.availableStart
      : samples[0]?.collected_at ?? null;
  const domainEnd =
    coverage.availableEnd != null
      ? coverage.availableEnd
      : samples[samples.length - 1]?.collected_at ?? null;

  const graphs = {
    byComponent: Object.fromEntries(
      componentSections.map((c) => [c.name, c.charts || []])
    ),
    systemResourceTrend,
    eventMarkers,
    gaps,
    domainStart,
    domainEnd,
    domainStartMs: domainStart != null ? domainStart * 1000 : null,
    domainEndMs: domainEnd != null ? domainEnd * 1000 : null,
    availableStart: domainStart,
    availableEnd: domainEnd,
    requestedStart: coverage.requestedStart,
    requestedEnd: coverage.requestedEnd,
    bucketSeconds: api.bucket_seconds || null,
  };

  const recommendations = buildRecommendations(
    samples,
    faultAnalysis,
    spikes,
    coverage,
    componentSections
  );

  const reportPeriod = {
    range: api.range || intervalKey,
    label: intervalLabel,
    requestedStart: coverage.requestedStart,
    requestedEnd: coverage.requestedEnd,
    requestedStartIso: coverage.requestedStartIso,
    requestedEndIso: coverage.requestedEndIso,
    availableStart: coverage.availableStart,
    availableEnd: coverage.availableEnd,
    availableStartIso: coverage.availableStartIso,
    availableEndIso: coverage.availableEndIso,
  };

  const reportMetadata = {
    reportId,
    title: title || "Infrastructure Health & Incident Report",
    generatedAt,
    generatedBy: generatedBy || "System Administrator",
    description: description || "",
    intervalKey,
    intervalLabel,
    dataSource: "SQLite telemetry_history.db via /reports/data",
    database: api.database || null,
    bucketSeconds: api.bucket_seconds || null,
    aggregated: Boolean(api.aggregated),
  };

  const digitalTwin = {
    rows: digitalTwinRows,
    emptyMessage:
      digitalTwinRows.length === 0
        ? "No Digital Twin simulations were recorded during this reporting period."
        : null,
  };

  const reportData = {
    ...reportMetadata,
    reportMetadata,
    reportId,
    reportPeriod,
    dataSource: reportMetadata.dataSource,
    dataCoverage: coverage,
    span: {
      start: domainStart != null ? new Date(domainStart * 1000) : null,
      end: domainEnd != null ? new Date(domainEnd * 1000) : null,
      label: coverage.coverageDurationLabel,
      requestedLabel: coverage.requestedLabel,
    },
    executive: buildExecutiveSummary(
      samples,
      faults,
      recoveryHistory,
      coverage,
      hostname
    ),
    componentSections,
    componentOverview,
    spikes,
    significantEvents: significantEvents.rows,
    significantEventsEmptyMessage: significantEvents.emptyMessage,
    logbook: logbook.rows,
    logbookEmptyMessage: logbook.emptyMessage,
    faultEvents,
    faultIncidentLog,
    faultDetailCards,
    recoveryEvents,
    recoveryActionLog,
    recoveryHistory: recoveryEvents,
    faultRecoveryChains,
    infrastructureTimeline,
    activitySummary,
    systemResourceTrend,
    eventMarkers,
    faults,
    faultAnalysis,
    faultDistribution: (() => {
      const bySeverity = { Critical: 0, Warning: 0, Resolved: 0 };
      const byComponent = {};
      faults.forEach((f) => {
        const sev = f.severity || "Warning";
        bySeverity[sev] = (bySeverity[sev] || 0) + 1;
        byComponent[f.component] = (byComponent[f.component] || 0) + 1;
      });
      return { bySeverity, byComponent };
    })(),
    digitalTwin: digitalTwinRows,
    digitalTwinEmptyMessage: digitalTwin.emptyMessage,
    digitalTwinBlock: digitalTwin,
    recommendations,
    graphs,
    gaps,
    rawSamples: samples,
    telemetry: samples,
    context: { hostname, source: "sqlite" },
    sampleCount: coverage.reportPointCount,
    rawSampleCount: coverage.rawSampleCount,
    reportPointCount: coverage.reportPointCount,
    telemetryRawCount: coverage.rawSampleCount,
    bucketSeconds: api.bucket_seconds || null,
    database: api.database || null,
    inventory: null,
    connectivityStatus: samples.length
      ? {
          linkHealth: {
            overall: samples[samples.length - 1].lh_health,
            score: samples[samples.length - 1].lh_score,
          },
          assessments: {},
        }
      : null,
    aiRootCause: faultAnalysis.map((f) => ({
      component: f.component,
      severity: f.severity,
      metricName: f.metricName,
      analysis: f.explanation,
      recommendation: f.recommendation,
      timestamp: f.t,
    })),
    // Transitional aliases for exporters still mid-migration
    componentAnalysis: componentSections.map((c) => ({
      name: c.name === "IO" ? "IO Control" : c.name,
      level: c.status,
      status: c.interpretation,
      faults: c.faults || [],
      liveMetrics: c.latestRecorded,
      latestRecorded: c.latestRecorded,
      inventory: [],
      stats: c.stats,
      charts: c.charts,
      interpretation: c.interpretation,
      warnCount: c.warnCount,
      critCount: c.critCount,
      peakAt: c.peakAt,
      thresholds: c.thresholdLabel,
    })),
    componentHealthSnapshot: componentSections.map((c) => ({
      name: c.name,
      level: c.status,
    })),
    visualAnalysis: componentSections.map((c) => ({
      component: c.name,
      commentary: c.interpretation,
      average: c.stats?.avg ?? null,
      peak: c.stats?.max ?? null,
      minimum: c.stats?.min ?? null,
      warningEvents: c.warnCount || 0,
      criticalEvents: c.critCount || 0,
      peakAt: c.peakAt,
    })),
    trendSeries: componentSections.flatMap((c) =>
      (c.charts || []).map((ch) => ({
        key: ch.key,
        label: ch.title,
        suffix: ch.unit,
        unit: ch.unit,
        points: ch.points,
        warning: ch.warning,
        critical: ch.critical,
        yMin: ch.yMin,
        yMax: ch.yMax,
        component: c.name,
      }))
    ),
    hardwareMetrics: componentSections.flatMap((c) => {
      if (!c.stats?.count) return [];
      const unit = c.name === "IO" ? " MB/s" : "%";
      return [
        [
          `${c.name} (primary)`,
          c.stats.avg != null ? `${fmtNum(c.stats.avg)}${unit}` : "—",
          c.stats.min != null ? `${fmtNum(c.stats.min)}${unit}` : "—",
          c.stats.max != null ? `${fmtNum(c.stats.max)}${unit}` : "—",
          c.stats.current != null ? `${fmtNum(c.stats.current)}${unit}` : "—",
          c.stats.trend || "—",
        ],
      ];
    }),
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
