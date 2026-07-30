/**
 * Recovery API Service — POST /recovery/execute on CM.py telemetry server (:5000).
 */

import { LINUX_SERVER } from "../services/linuxMetricsService";

/**
 * @returns {Promise<{ available: boolean, actions: Array<{ key: string, supported?: boolean, level?: number }> }>}
 */
export async function fetchRecoveryCapabilities() {
  try {
    const res = await fetch(`${LINUX_SERVER}/recovery/capabilities`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return { available: false, actions: [] };
    }
    const data = await res.json();
    return {
      available: true,
      actions: data.actions || [],
      version: data.version || null,
    };
  } catch {
    return { available: false, actions: [] };
  }
}

/**
 * Action is supported when CM.py reports key present and supported !== false.
 */
export function isActionSupported(capabilities, backendAction) {
  if (!capabilities?.available) return false;
  const entry = (capabilities.actions || []).find((a) => a.key === backendAction);
  if (!entry) return false;
  return entry.supported !== false;
}

/**
 * @param {object} payload
 * @returns {Promise<object>}
 */
export async function executeRecoveryAction(payload) {
  const pid = payload?.params?.pid;
  if (payload?.action?.includes("kill") || payload?.action?.includes("terminate")) {
    console.info("[recovery] execute force-kill request", {
      action: payload.action,
      pid,
      params: payload.params,
    });
  }

  const res = await fetch(`${LINUX_SERVER}/recovery/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });

  let body = {};
  try {
    body = await res.json();
  } catch {
    body = { success: false, message: res.statusText || "Unknown error" };
  }

  if (!res.ok && res.status !== 409) {
    const err = new Error(body.message || body.error || `Recovery HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  if (payload?.action?.includes("kill") || payload?.action?.includes("terminate")) {
    console.info("[recovery] execute force-kill response", {
      action: payload.action,
      pid,
      success: body.success,
      command: body.command,
      returncode: body.returncode,
      stdout: body.stdout,
      stderr: body.stderr,
      message: body.message,
    });
  }

  return body;
}

/**
 * @param {number} [limit]
 */
export async function fetchRecoveryHistory(limit = 50) {
  try {
    const res = await fetch(`${LINUX_SERVER}/recovery/history?limit=${limit}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.history || [];
  } catch {
    return [];
  }
}

/**
 * @param {"cpu"|"gpu"|"disk"} domain
 * @param {{ minPercent?: number, limit?: number }} [options]
 */
export async function fetchProcessCandidates(domain, options = {}) {
  const minPercent = options.minPercent ?? 1;
  const limit = options.limit ?? 50;
  const params = new URLSearchParams({
    domain: domain || "cpu",
    min_percent: String(minPercent),
    limit: String(limit),
  });
  const res = await fetch(`${LINUX_SERVER}/recovery/process_candidates?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const err = new Error(`Process candidates HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
