/**
 * Shared formatting helpers for professional report output.
 */

export function fmtNum(value, digits = 2) {
  if (value == null || value === "" || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(digits);
}

export function fmtPct(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${Number(value).toFixed(digits)}%`;
}

export function fmtInt(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return String(Math.round(Number(value)));
}

export function fmtDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return "—";
  const s = Math.max(0, Math.round(Number(seconds)));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function fmtLocal(tsSecOrMs) {
  if (tsSecOrMs == null) return "—";
  const n = Number(tsSecOrMs);
  if (!Number.isFinite(n)) return "—";
  const ms = n > 1e12 ? n : n * 1000;
  return new Date(ms).toLocaleString();
}

export function fmtIsoLocal(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

export function statusTitle(level) {
  const l = String(level || "").toLowerCase();
  if (l === "critical") return "CRITICAL";
  if (l === "warning") return "WARNING";
  if (l === "healthy") return "HEALTHY";
  if (l === "nodata" || l === "no data" || l === "unknown") return "NO DATA";
  return String(level || "UNKNOWN").toUpperCase();
}

export function computeStats(values) {
  const nums = values
    .map((v) => (v == null || v === "" ? null : Number(v)))
    .filter((v) => v != null && Number.isFinite(v));
  if (!nums.length) {
    return {
      count: 0,
      avg: null,
      min: null,
      max: null,
      current: null,
      peakIndex: null,
      trend: "—",
    };
  }
  const sum = nums.reduce((a, b) => a + b, 0);
  const avg = sum / nums.length;
  let max = nums[0];
  let min = nums[0];
  let peakIndex = 0;
  nums.forEach((v, i) => {
    if (v > max) {
      max = v;
      peakIndex = i;
    }
    if (v < min) min = v;
  });
  let trend = "Stable";
  if (nums.length >= 4) {
    const mid = Math.floor(nums.length / 2);
    const a1 = nums.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
    const a2 = nums.slice(mid).reduce((a, b) => a + b, 0) / (nums.length - mid);
    if (a2 > a1 * 1.08) trend = "Rising";
    else if (a2 < a1 * 0.92) trend = "Falling";
  }
  return {
    count: nums.length,
    avg,
    min,
    max,
    current: nums[nums.length - 1],
    peakIndex,
    trend,
  };
}
