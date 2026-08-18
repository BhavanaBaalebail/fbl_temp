/**
 * FBL Utilities API client — talks to CM.py /utilities/* endpoints.
 */

import { LINUX_SERVER } from "../services/linuxMetricsService";

async function utilFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 60000);
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
        available: false,
        message: err?.name === "AbortError" ? "Request timed out" : "Unable to reach utilities backend",
        error: String(err?.message || err),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export const utilitiesApi = {
  uptime: () => utilFetch("/utilities/uptime"),
  disk: () => utilFetch("/utilities/disk"),
  temperature: () => utilFetch("/utilities/temperature"),
  reboots: () => utilFetch("/utilities/reboots"),
  firewall: () => utilFetch("/utilities/firewall"),
  failedLogins: () => utilFetch("/utilities/failed-logins"),
  sshLogins: () => utilFetch("/utilities/ssh-logins"),
  software: (search = "", limit = 200) =>
    utilFetch(`/utilities/software?search=${encodeURIComponent(search)}&limit=${limit}`),
  users: () => utilFetch("/utilities/users"),
  backup: () => utilFetch("/utilities/backup"),
  largeFiles: (body) =>
    utilFetch("/utilities/large-files", {
      method: "POST",
      body: JSON.stringify(body || {}),
      timeoutMs: 90000,
    }),
  ping: (body) =>
    utilFetch("/utilities/ping", { method: "POST", body: JSON.stringify(body || {}) }),
  packetLoss: (body) =>
    utilFetch("/utilities/packet-loss", {
      method: "POST",
      body: JSON.stringify(body || {}),
      timeoutMs: 120000,
    }),
  ports: (body) =>
    utilFetch("/utilities/ports", { method: "POST", body: JSON.stringify(body || {}) }),
  traceroute: (body) =>
    utilFetch("/utilities/traceroute", {
      method: "POST",
      body: JSON.stringify(body || {}),
      timeoutMs: 90000,
    }),
  ssl: (body) =>
    utilFetch("/utilities/ssl", { method: "POST", body: JSON.stringify(body || {}) }),
  broadcast: (body) =>
    utilFetch("/utilities/broadcast", { method: "POST", body: JSON.stringify(body || {}) }),
};
