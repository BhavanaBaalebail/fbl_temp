/**
 * Fetch SQLite telemetry history for Predictive Maintenance.
 * Uses existing /db/telemetry_history — does not invent samples.
 */

import { LINUX_SERVER } from "./linuxMetricsService";
import {
  buildPredictiveMaintenance,
  PREDICTIVE_WINDOW_HOURS_DEFAULT,
} from "./predictiveMaintenance";

/**
 * @param {{ hours?: number, limit?: number }} [options]
 */
export async function fetchPredictiveTelemetryHistory(options = {}) {
  const hours = options.hours ?? PREDICTIVE_WINDOW_HOURS_DEFAULT;
  const range = hours <= 1 ? "1h" : "6h";
  const limit = options.limit ?? 5000;
  const params = new URLSearchParams({ range, limit: String(limit) });

  const res = await fetch(`${LINUX_SERVER}/db/telemetry_history?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Telemetry history HTTP ${res.status}`);
  }
  const data = await res.json();
  const samples = Array.isArray(data.samples) ? data.samples : [];
  return { samples, range, count: data.count ?? samples.length };
}

/**
 * Prefer 6h; if too sparse, try 1h then use whatever exists.
 */
export async function loadPredictiveMaintenance(options = {}) {
  const preferredHours = options.hours ?? PREDICTIVE_WINDOW_HOURS_DEFAULT;
  let samples;
  let rangeUsed;

  try {
    const primary = await fetchPredictiveTelemetryHistory({ hours: preferredHours });
    samples = primary.samples;
    rangeUsed = primary.range;
  } catch (err) {
    return {
      error: err.message || "Failed to load SQLite telemetry history",
      generatedAt: new Date().toISOString(),
      windowHours: preferredHours,
      sampleCount: 0,
      disclaimer: null,
      predictions: [],
      actionable: [],
    };
  }

  if (samples.length < 8 && preferredHours > 1) {
    try {
      const fallback = await fetchPredictiveTelemetryHistory({ hours: 1 });
      if (fallback.samples.length > samples.length) {
        samples = fallback.samples;
        rangeUsed = fallback.range;
      }
    } catch {
      /* keep primary */
    }
  }

  const result = buildPredictiveMaintenance(samples, {
    windowHours: rangeUsed === "1h" ? 1 : preferredHours,
  });
  return { ...result, rangeUsed, error: null };
}
