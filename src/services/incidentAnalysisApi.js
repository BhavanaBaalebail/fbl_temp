/**
 * Incident Analysis API — allowlisted utilities on CM.py.
 */

import { LINUX_SERVER } from "../services/linuxMetricsService";

async function iaFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  try {
    const res = await fetch(`${LINUX_SERVER}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: {
        error: err?.name === "AbortError" ? "Request timed out" : "Unable to reach incident analysis backend",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export const incidentAnalysisApi = {
  utilities: () => iaFetch("/incident-analysis/utilities"),
  run: (utilityId, body) =>
    iaFetch(`/incident-analysis/run/${encodeURIComponent(utilityId)}`, {
      method: "POST",
      body: JSON.stringify(body || {}),
    }),
  status: (executionId) => iaFetch(`/incident-analysis/status/${encodeURIComponent(executionId)}`),
  result: (executionId, raw = false) =>
    iaFetch(
      `/incident-analysis/result/${encodeURIComponent(executionId)}${raw ? "?raw=1" : ""}`
    ),
  history: (incidentId) =>
    iaFetch(
      `/incident-analysis/history${incidentId ? `?incident_id=${encodeURIComponent(incidentId)}` : ""}`
    ),
  summary: (incidentId) =>
    iaFetch(`/incident-analysis/summary/${encodeURIComponent(incidentId)}`),
  reportUrl: (executionId) =>
    `${LINUX_SERVER}/incident-analysis/report/${encodeURIComponent(executionId)}`,
  rawUrl: (executionId) =>
    `${LINUX_SERVER}/incident-analysis/raw/${encodeURIComponent(executionId)}`,
  raw: async (executionId) => {
    try {
      const res = await fetch(
        `${LINUX_SERVER}/incident-analysis/raw/${encodeURIComponent(executionId)}`
      );
      const text = await res.text();
      return { ok: res.ok, text };
    } catch (err) {
      return { ok: false, text: String(err?.message || err) };
    }
  },
};
