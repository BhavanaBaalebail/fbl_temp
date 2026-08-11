/**
 * Historical report data from CM.py SQLite APIs.
 * Source of truth: telemetry_history.db via GET /reports/data
 * Never uses sessionStorage for historical report content.
 */

import { LINUX_SERVER } from "../linuxMetricsService";

export const REPORT_INTERVALS = {
  snapshot: { label: "Current System Snapshot", ms: 15 * 60 * 1000, range: "snapshot" },
  "1h": { label: "Last 1 Hour", ms: 60 * 60 * 1000, range: "1h" },
  "6h": { label: "Last 6 Hours", ms: 6 * 60 * 60 * 1000, range: "6h" },
  "24h": { label: "Last 24 Hours", ms: 24 * 60 * 60 * 1000, range: "24h" },
  "7d": { label: "Last 7 Days", ms: 7 * 24 * 60 * 60 * 1000, range: "7d" },
  "30d": { label: "Last 30 Days", ms: 30 * 24 * 60 * 60 * 1000, range: "30d" },
  custom: { label: "Custom Time Range", ms: null, range: null },
};

const FETCH_TIMEOUT_MS = 45000;

function toEpochSeconds(msOrSec) {
  if (msOrSec == null || Number.isNaN(Number(msOrSec))) return null;
  const n = Number(msOrSec);
  return n > 1e12 ? n / 1000 : n;
}

/**
 * @param {{ intervalKey?: string, customRange?: { start: number, end: number }|null }} config
 */
export function buildReportsDataUrl(config = {}) {
  const { intervalKey = "1h", customRange = null } = config;
  const params = new URLSearchParams();
  params.set("aggregate", "1");

  if (intervalKey === "custom" && customRange?.start && customRange?.end) {
    params.set("start", String(toEpochSeconds(customRange.start)));
    params.set("end", String(toEpochSeconds(customRange.end)));
  } else {
    const meta = REPORT_INTERVALS[intervalKey] || REPORT_INTERVALS["1h"];
    params.set("range", meta.range || intervalKey);
  }

  return `${LINUX_SERVER}/reports/data?${params.toString()}`;
}

/**
 * Fetch historical report payload from SQLite-backed CM.py API.
 * Throws on network/server errors — callers must NOT fall back to sessionStorage.
 */
export async function fetchHistoricalReportData(config = {}) {
  const url = buildReportsDataUrl(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Historical telemetry could not be retrieved from the monitoring server ` +
          `(HTTP ${response.status}). ${text || "The report was not generated from incomplete live data."}`
      );
    }

    const payload = await response.json();
    if (payload?.error && !Array.isArray(payload?.telemetry) && payload.telemetry == null) {
      throw new Error(
        payload.error ||
          "Historical telemetry could not be retrieved from the monitoring server."
      );
    }
    if (payload == null || typeof payload !== "object") {
      throw new Error(
        "Historical telemetry API returned a malformed response. The report was not generated."
      );
    }
    // Normalize arrays so exporters never see undefined collections.
    payload.telemetry = Array.isArray(payload.telemetry) ? payload.telemetry : [];
    payload.faults = Array.isArray(payload.faults) ? payload.faults : [];
    payload.recovery_history = Array.isArray(payload.recovery_history)
      ? payload.recovery_history
      : [];
    payload.digital_twin_simulations = Array.isArray(payload.digital_twin_simulations)
      ? payload.digital_twin_simulations
      : [];
    if (!payload.dataCoverage && (payload.start != null || payload.range)) {
      payload.dataCoverage = {
        status: payload.telemetry.length ? "PARTIAL" : "EMPTY",
        requestedStart: payload.start,
        requestedEnd: payload.end,
        notice: payload.telemetry.length
          ? "Coverage metadata was incomplete; report uses available SQLite samples only."
          : "No historical telemetry is available in the database for the requested reporting period.",
        rawSampleCount: payload.telemetry_raw_count ?? payload.telemetry.length,
        reportPointCount: payload.telemetry_count ?? payload.telemetry.length,
        faultEventCount: payload.fault_count ?? payload.faults.length,
        recoveryEventCount: payload.recovery_count ?? payload.recovery_history.length,
        digitalTwinCount: payload.digital_twin_count ?? payload.digital_twin_simulations.length,
      };
    }
    return payload;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(
        "Historical telemetry request timed out. The report was not generated from incomplete live data."
      );
    }
    if (err?.message?.includes("Historical telemetry")) throw err;
    throw new Error(
      "Historical telemetry could not be retrieved from the monitoring server. " +
        "The report was not generated from incomplete live data."
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchDatabaseStats() {
  const response = await fetch(`${LINUX_SERVER}/db/stats`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Failed to read database stats (${response.status})`);
  return response.json();
}
