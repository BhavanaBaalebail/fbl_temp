/**
 * Predictive Maintenance — threshold-degradation projections from SQLite history.
 *
 * Estimates when a metric may cross existing FBL warning/critical thresholds
 * IF the recent trend continues under similar conditions.
 * Does NOT predict exact hardware failure.
 */

import {
  CPU_UTIL_THRESHOLDS,
  CPU_TEMP_THRESHOLDS,
  GPU_UTIL_THRESHOLDS,
  GPU_TEMP_THRESHOLDS,
  IO_BUSY_THRESHOLDS,
} from "./linkHealthService";
import { MEM_UTIL_THRESHOLDS } from "./reports/reportThresholds";

/** Prefer 1–6h of SQLite history depending on availability. */
export const PREDICTIVE_WINDOW_HOURS_DEFAULT = 6;
export const PREDICTIVE_MIN_SAMPLES = 8;
export const PREDICTIVE_MIN_SPAN_SECONDS = 15 * 60;

const DISK_CAPACITY_THRESHOLDS = { warningMin: 80, criticalMin: 90 };

export const PREDICTIVE_DISCLAIMER =
  "Predictive Maintenance estimates when a monitored metric may cross an operational threshold if the current trend continues. It does not predict exact hardware failure or guarantee future system behavior.";

/**
 * Metric definitions — reuse FBL thresholds only.
 */
export const PREDICTIVE_METRICS = [
  {
    id: "cpu_usage",
    component: "CPU",
    metric: "CPU Utilization",
    unit: "%",
    column: "cpu_usage_percent",
    sampleKey: "cpu_usage",
    warning: CPU_UTIL_THRESHOLDS.warningMin,
    critical: CPU_UTIL_THRESHOLDS.criticalMin,
    /** Minimum |slope| in units/hour to treat as meaningful. */
    minAbsSlopePerHour: 0.5,
  },
  {
    id: "cpu_temp",
    component: "CPU",
    metric: "CPU Temperature",
    unit: "°C",
    column: "cpu_temperature_celsius",
    sampleKey: "cpu_temp",
    warning: CPU_TEMP_THRESHOLDS.warningC,
    critical: CPU_TEMP_THRESHOLDS.criticalC,
    minAbsSlopePerHour: 0.15,
  },
  {
    id: "gpu_usage",
    component: "GPU",
    metric: "GPU Utilization",
    unit: "%",
    column: "gpu_utilization_percent",
    sampleKey: "gpu_util",
    warning: GPU_UTIL_THRESHOLDS.warningMin,
    critical: GPU_UTIL_THRESHOLDS.criticalMin,
    minAbsSlopePerHour: 0.5,
  },
  {
    id: "gpu_temp",
    component: "GPU",
    metric: "GPU Temperature",
    unit: "°C",
    column: "gpu_temperature_celsius",
    sampleKey: "gpu_temp",
    warning: GPU_TEMP_THRESHOLDS.warningC,
    critical: GPU_TEMP_THRESHOLDS.criticalC,
    minAbsSlopePerHour: 0.15,
  },
  {
    id: "ram_usage",
    component: "RAM",
    metric: "RAM Utilization",
    unit: "%",
    column: "memory_usage_percent",
    sampleKey: "mem_usage",
    warning: MEM_UTIL_THRESHOLDS.warningMin,
    critical: MEM_UTIL_THRESHOLDS.criticalMin,
    minAbsSlopePerHour: 0.3,
  },
  {
    id: "disk_root",
    component: "DISK",
    metric: "Disk Utilization (/)",
    unit: "%",
    mountpoint: "/",
    warning: DISK_CAPACITY_THRESHOLDS.warningMin,
    critical: DISK_CAPACITY_THRESHOLDS.criticalMin,
    minAbsSlopePerHour: 0.05,
  },
  {
    id: "disk_tmp",
    component: "DISK",
    metric: "/tmp Utilization",
    unit: "%",
    mountpoint: "/tmp",
    warning: DISK_CAPACITY_THRESHOLDS.warningMin,
    critical: DISK_CAPACITY_THRESHOLDS.criticalMin,
    minAbsSlopePerHour: 0.05,
  },
  {
    id: "io_busy",
    component: "I/O",
    metric: "I/O Busy",
    unit: "%",
    column: "io_busy_percent",
    sampleKey: "io_busy",
    warning: IO_BUSY_THRESHOLDS.warningMin,
    critical: IO_BUSY_THRESHOLDS.criticalMin,
    minAbsSlopePerHour: 0.5,
  },
];

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseMounts(row) {
  if (Array.isArray(row?.disk_mounts)) return row.disk_mounts;
  const raw = row?.disk_mounts_json;
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mountPct(row, mountpoint) {
  const mounts = parseMounts(row);
  const hit = mounts.find((m) => {
    const mp = String(m.mp || m.mountpoint || m.path || "");
    return mp === mountpoint || (mountpoint === "/" && (mp === "/" || mp === ""));
  });
  if (!hit) return null;
  return num(hit.pct ?? hit.usage_percent ?? hit.use_percent);
}

function extractSeries(samples, def) {
  const points = [];
  for (const row of samples || []) {
    const t = num(row.collected_at);
    if (t == null) continue;
    let v = null;
    if (def.mountpoint) {
      v = mountPct(row, def.mountpoint);
    } else if (def.column && row[def.column] != null) {
      v = num(row[def.column]);
    } else if (def.sampleKey && row[def.sampleKey] != null) {
      v = num(row[def.sampleKey]);
    }
    if (v == null) continue;
    points.push({ t, v, tMs: t * 1000 });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

/**
 * Ordinary least-squares linear regression on (t, v).
 * Returns slope in units/second, intercept at t=0, r², and residuals stats.
 */
export function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;

  let sumT = 0;
  let sumV = 0;
  let sumTT = 0;
  let sumTV = 0;
  for (const p of points) {
    sumT += p.t;
    sumV += p.v;
    sumTT += p.t * p.t;
    sumTV += p.t * p.v;
  }

  const denom = n * sumTT - sumT * sumT;
  if (Math.abs(denom) < 1e-12) return null;

  const slope = (n * sumTV - sumT * sumV) / denom;
  const intercept = (sumV - slope * sumT) / n;

  const meanV = sumV / n;
  let ssTot = 0;
  let ssRes = 0;
  for (const p of points) {
    const pred = intercept + slope * p.t;
    ssTot += (p.v - meanV) ** 2;
    ssRes += (p.v - pred) ** 2;
  }
  const r2 = ssTot > 1e-12 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  return { slope, intercept, r2, n };
}

function countDirectionChanges(points) {
  if (points.length < 3) return 0;
  let changes = 0;
  let prevSign = 0;
  for (let i = 1; i < points.length; i += 1) {
    const d = points[i].v - points[i - 1].v;
    const sign = d > 0 ? 1 : d < 0 ? -1 : 0;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) changes += 1;
    if (sign !== 0) prevSign = sign;
  }
  return changes;
}

function confidenceLabel(r2, n, oscillating) {
  if (oscillating) return "Low";
  if (r2 >= 0.65 && n >= 20) return "High";
  if (r2 >= 0.4 && n >= 10) return "Medium";
  return "Low";
}

function formatDurationSeconds(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `~${Math.round(seconds)} sec`;
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`;
  if (seconds < 86400) {
    const h = seconds / 3600;
    return h < 10 ? `~${h.toFixed(1)} hours` : `~${Math.round(h)} hours`;
  }
  const d = seconds / 86400;
  return d < 10 ? `~${d.toFixed(1)} days` : `~${Math.round(d)} days`;
}

function formatRate(slopePerHour, unit) {
  const sign = slopePerHour > 0 ? "+" : "";
  const abs = Math.abs(slopePerHour);
  const digits = abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return `${sign}${slopePerHour.toFixed(digits)}${unit}/hour`;
}

function classifyRisk({
  etaWarningSec,
  etaCriticalSec,
  confidence,
  hasTrend,
  alreadyCritical,
  alreadyWarning,
}) {
  if (alreadyCritical) {
    return {
      risk: "HIGH",
      reason: "Metric is already at or above the critical threshold.",
    };
  }
  if (!hasTrend) {
    return {
      risk: "NORMAL",
      reason: "No significant degradation trend detected in the analysis window.",
    };
  }
  if (confidence === "Low") {
    return {
      risk: "WATCH",
      reason: "Degrading trend observed, but confidence is low — treat as advisory only.",
    };
  }
  if (
    (etaCriticalSec != null && etaCriticalSec <= 2 * 3600) ||
    (etaWarningSec != null && etaWarningSec <= 30 * 60 && confidence === "High")
  ) {
    return {
      risk: "HIGH",
      reason: "Projected to reach a critical/near-warning threshold soon under the current trend.",
    };
  }
  if (
    alreadyWarning ||
    (etaWarningSec != null && etaWarningSec <= 6 * 3600) ||
    (etaCriticalSec != null && etaCriticalSec <= 24 * 3600)
  ) {
    return {
      risk: "WARNING",
      reason: "Approaching warning/critical thresholds on the measured trend.",
    };
  }
  if (etaWarningSec != null || etaCriticalSec != null) {
    return {
      risk: "WATCH",
      reason: "Measurable upward trend toward a threshold; not imminent.",
    };
  }
  return {
    risk: "NORMAL",
    reason: "Trend does not project a near-term threshold crossing.",
  };
}

/**
 * Build one prediction for a metric definition from raw SQLite/history rows.
 */
export function predictMetric(samples, def, options = {}) {
  const nowIso = new Date().toISOString();
  const points = extractSeries(samples, def);
  const windowHours = options.windowHours ?? PREDICTIVE_WINDOW_HOURS_DEFAULT;

  const base = {
    id: def.id,
    component: def.component,
    metric: def.metric,
    unit: def.unit,
    warningThreshold: def.warning,
    criticalThreshold: def.critical,
    analysisWindowHours: windowHours,
    timestamp: nowIso,
    available: false,
    hasPrediction: false,
    risk: "NORMAL",
    confidence: null,
    message: null,
    explanation: null,
    points: [],
  };

  if (points.length < PREDICTIVE_MIN_SAMPLES) {
    return {
      ...base,
      message: "Prediction unavailable — insufficient historical data",
      explanation: {
        currentValue: points.length ? points[points.length - 1].v : null,
        sampleCount: points.length,
        requiredSamples: PREDICTIVE_MIN_SAMPLES,
        method: "linear_regression",
        note: `Need at least ${PREDICTIVE_MIN_SAMPLES} valid SQLite samples for ${def.metric}.`,
      },
      points,
    };
  }

  const span = points[points.length - 1].t - points[0].t;
  if (span < PREDICTIVE_MIN_SPAN_SECONDS) {
    return {
      ...base,
      currentValue: points[points.length - 1].v,
      message: "Prediction unavailable — insufficient historical data",
      explanation: {
        currentValue: points[points.length - 1].v,
        sampleCount: points.length,
        spanSeconds: span,
        requiredSpanSeconds: PREDICTIVE_MIN_SPAN_SECONDS,
        method: "linear_regression",
        note: "Historical span is too short for a reliable trend.",
      },
      points,
    };
  }

  const reg = linearRegression(points);
  if (!reg) {
    return {
      ...base,
      currentValue: points[points.length - 1].v,
      message: "Prediction unavailable — insufficient historical data",
      explanation: { note: "Regression could not be computed." },
      points,
    };
  }

  const currentValue = points[points.length - 1].v;
  const slopePerHour = reg.slope * 3600;
  const directionChanges = countDirectionChanges(points);
  const oscillating = directionChanges >= Math.max(3, Math.floor(points.length * 0.35));
  const confidence = confidenceLabel(reg.r2, reg.n, oscillating);

  const alreadyCritical = currentValue >= def.critical;
  const alreadyWarning = currentValue >= def.warning && !alreadyCritical;

  const meaningfulSlope = Math.abs(slopePerHour) >= def.minAbsSlopePerHour;
  const degrading = slopePerHour > 0; // toward higher thresholds
  const reliableFit = reg.r2 >= 0.35 && !oscillating;

  let etaWarningSec = null;
  let etaCriticalSec = null;
  let hasPrediction = false;
  let message = "No significant degradation trend detected";

  if (alreadyCritical) {
    message = "Already at or above critical threshold";
  } else if (
    !meaningfulSlope ||
    !degrading ||
    !reliableFit ||
    confidence === "Low"
  ) {
    message = "No significant degradation trend detected";
  } else {
    hasPrediction = true;
    if (!alreadyWarning && currentValue < def.warning && reg.slope > 0) {
      etaWarningSec = (def.warning - currentValue) / reg.slope;
      if (!Number.isFinite(etaWarningSec) || etaWarningSec < 0) etaWarningSec = null;
    }
    if (currentValue < def.critical && reg.slope > 0) {
      etaCriticalSec = (def.critical - currentValue) / reg.slope;
      if (!Number.isFinite(etaCriticalSec) || etaCriticalSec < 0) etaCriticalSec = null;
    }
    if (etaWarningSec == null && etaCriticalSec == null) {
      hasPrediction = false;
      message = "No significant degradation trend detected";
    }
  }

  const { risk, reason } = classifyRisk({
    etaWarningSec,
    etaCriticalSec,
    confidence,
    hasTrend: hasPrediction,
    alreadyCritical,
    alreadyWarning,
  });

  const actualWindowHours = Math.max(0.1, span / 3600);

  // Projection line for chart (extend to critical ETA or +2h)
  const projectTo = Math.min(
    points[points.length - 1].t + (etaCriticalSec ?? etaWarningSec ?? 2 * 3600),
    points[points.length - 1].t + 48 * 3600
  );
  const projected = hasPrediction
    ? [
        { t: points[0].t, tMs: points[0].t * 1000, v: reg.intercept + reg.slope * points[0].t },
        { t: projectTo, tMs: projectTo * 1000, v: reg.intercept + reg.slope * projectTo },
      ]
    : [];

  return {
    ...base,
    available: true,
    hasPrediction,
    currentValue,
    trendDirection: slopePerHour > 0.01 ? "increasing" : slopePerHour < -0.01 ? "decreasing" : "stable",
    trendRatePerHour: slopePerHour,
    trendRateLabel: formatRate(slopePerHour, def.unit),
    analysisWindowHours: Number(actualWindowHours.toFixed(2)),
    confidence: hasPrediction || alreadyCritical ? confidence : null,
    estimatedTimeToWarningSec: etaWarningSec,
    estimatedTimeToCriticalSec: etaCriticalSec,
    estimatedTimeToWarningLabel: formatDurationSeconds(etaWarningSec),
    estimatedTimeToCriticalLabel: formatDurationSeconds(etaCriticalSec),
    risk: alreadyCritical ? "HIGH" : risk,
    riskReason: alreadyCritical
      ? "Metric is already at or above the critical threshold."
      : reason,
    message: hasPrediction
      ? null
      : alreadyCritical
        ? "Already at or above critical threshold"
        : message,
    summaryLine: hasPrediction
      ? `${currentValue}${def.unit} → ${
          etaWarningSec != null && !alreadyWarning
            ? `Warning in ${formatDurationSeconds(etaWarningSec)}`
            : etaCriticalSec != null
              ? `Critical in ${formatDurationSeconds(etaCriticalSec)}`
              : "trending up"
        }`
      : alreadyCritical
        ? `${currentValue}${def.unit} · already critical`
        : message,
    explanation: {
      currentValue,
      warningThreshold: def.warning,
      criticalThreshold: def.critical,
      sampleCount: points.length,
      spanSeconds: span,
      analysisWindowHours: Number(actualWindowHours.toFixed(2)),
      slopePerSecond: reg.slope,
      slopePerHour,
      rSquared: Number(reg.r2.toFixed(3)),
      confidence: confidence,
      oscillating,
      directionChanges,
      method: "linear_regression",
      formula:
        "time_to_threshold = (threshold − current_value) / slope, where slope is OLS fit over the SQLite window",
      riskBasis: reason,
      disclaimer: PREDICTIVE_DISCLAIMER,
    },
    points,
    projected,
  };
}

/**
 * Run predictions for all supported metrics from SQLite/history samples.
 */
export function buildPredictiveMaintenance(samples, options = {}) {
  const predictions = PREDICTIVE_METRICS.map((def) => predictMetric(samples, def, options));
  const actionable = predictions.filter(
    (p) => p.hasPrediction || p.risk === "HIGH" || p.risk === "WARNING" || p.risk === "WATCH"
  );
  return {
    generatedAt: new Date().toISOString(),
    windowHours: options.windowHours ?? PREDICTIVE_WINDOW_HOURS_DEFAULT,
    sampleCount: (samples || []).length,
    disclaimer: PREDICTIVE_DISCLAIMER,
    predictions,
    actionable,
  };
}

export function riskBadgeStatus(risk) {
  if (risk === "HIGH") return "critical";
  if (risk === "WARNING") return "warning";
  if (risk === "WATCH") return "warning";
  return "healthy";
}
