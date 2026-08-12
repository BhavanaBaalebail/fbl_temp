/**
 * Digital Twin API Service — read-only simulation endpoints on CM.py (:5000).
 */

import { LINUX_SERVER } from "../services/linuxMetricsService";

async function parseJsonResponse(res) {
  try {
    return await res.json();
  } catch {
    return { success: false, message: res.statusText || "Invalid JSON response" };
  }
}

/**
 * @returns {Promise<{ available: boolean, pressure?: object, stateSummary?: object, message?: string }>}
 */
export async function fetchDigitalTwinPressure() {
  try {
    const res = await fetch(`${LINUX_SERVER}/digital_twin/pressure`, {
      headers: { Accept: "application/json" },
    });
    const data = await parseJsonResponse(res);
    if (!res.ok || data.success === false) {
      return {
        available: false,
        message: data.message || `Pressure HTTP ${res.status}`,
      };
    }
    return {
      available: true,
      pressure: data.pressure,
      stateSummary: data.state_summary,
    };
  } catch (err) {
    return {
      available: false,
      message: err.message || "Backend unreachable",
    };
  }
}

/**
 * @param {{ topN?: number, interval?: number }} [options]
 */
export async function fetchDigitalTwinCandidates(options = {}) {
  const topN = options.topN ?? 5;
  const interval = options.interval ?? 1.0;
  const params = new URLSearchParams({
    top_n: String(topN),
    interval: String(interval),
  });
  try {
    const res = await fetch(`${LINUX_SERVER}/digital_twin/candidates?${params}`, {
      headers: { Accept: "application/json" },
    });
    const data = await parseJsonResponse(res);
    if (!res.ok || data.success === false) {
      return {
        available: false,
        message: data.message || `Candidates HTTP ${res.status}`,
        candidates: [],
      };
    }
    return {
      available: true,
      pressure: data.pressure,
      pressuredDomains: data.pressured_domains || [],
      candidates: data.candidates || [],
      count: data.count ?? (data.candidates || []).length,
      message: data.message,
    };
  } catch (err) {
    return {
      available: false,
      message: err.message || "Backend unreachable",
      candidates: [],
    };
  }
}

/**
 * Build POST /digital_twin/simulate body from a candidate row returned by the backend.
 * @param {object} candidate
 */
export function buildSimulatePayload(candidate) {
  const domain = candidate.domain;
  const action = candidate.action;
  const payload = { domain, action, use_cached_state: true };

  if (candidate.target_pid != null) {
    payload.pid = candidate.target_pid;
  }
  if (domain === "nic" && candidate.target_name) {
    payload.interface = candidate.target_name;
  }
  if (domain === "io_controller") {
    if (candidate.target_name) payload.device = candidate.target_name;
    if (candidate.target_pid != null) payload.pid = candidate.target_pid;
  }
  if (domain === "gpu") {
    if (candidate.gpu_index != null) payload.gpu_index = candidate.gpu_index;
    if (candidate.target_pid != null) payload.pid = candidate.target_pid;
  }
  if (domain === "cpu" || domain === "ram" || domain === "process") {
    if (candidate.target_pid != null) payload.pid = candidate.target_pid;
  }
  return payload;
}

/**
 * @param {object} payload — from buildSimulatePayload()
 */
export async function simulateDigitalTwinAction(payload) {
  const res = await fetch(`${LINUX_SERVER}/digital_twin/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await parseJsonResponse(res);
  if (!res.ok || data.success === false) {
    const err = new Error(data.message || `Simulate HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data.simulation;
}

/**
 * Human-readable domain label from backend domain key.
 */
export function formatDigitalTwinDomain(domain) {
  const map = {
    cpu: "CPU",
    ram: "RAM",
    disk: "Disk",
    nic: "NIC",
    io_controller: "I/O Controller",
    gpu: "GPU",
    process: "Process",
  };
  return map[domain] || domain || "—";
}

/**
 * List domains currently under pressure from a pressure object.
 * @returns {Array<{ key: string, label: string, reason: string }>}
 */
export function listPressuredDomains(pressure) {
  const domains = pressure?.domains || {};
  return Object.entries(domains)
    .filter(([, info]) => info?.pressure)
    .map(([key, info]) => ({
      key,
      label: formatDigitalTwinDomain(key),
      reason: info.reason || "Pressure detected",
    }));
}
