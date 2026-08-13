/**
 * WhatsApp alert client — notifies the Flask backend only.
 * Never holds or requests WhatsApp API tokens.
 */

import { LINUX_SERVER } from "./linuxMetricsService";

async function postJson(path, body) {
  const res = await fetch(`${LINUX_SERVER}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function fetchWhatsAppStatus() {
  try {
    const res = await fetch(`${LINUX_SERVER}/notifications/whatsapp/status`, {
      headers: { Accept: "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch (err) {
    return {
      ok: false,
      data: {
        enabled: false,
        configured: false,
        message: "WhatsApp status unavailable",
        error: String(err?.message || err),
      },
    };
  }
}

/**
 * Ask backend to send a critical WhatsApp alert (deduped server-side).
 */
export async function notifyWhatsAppCritical(fault, hostname) {
  if (!fault?.id) return { ok: false, data: { status: "invalid" } };
  if (String(fault.severity || "").toLowerCase() !== "critical") {
    return { ok: true, data: { status: "ignored" } };
  }
  return postJson("/notifications/whatsapp/critical", {
    fault_id: fault.id,
    severity: fault.severity,
    component: fault.component,
    metric_name: fault.metricName,
    current_value: fault.currentValue,
    threshold_crossed: fault.thresholdCrossed,
    description: fault.faultDescription || fault.description,
    detected_at: fault.detected,
    hostname: hostname || undefined,
    status: fault.status,
  });
}

/**
 * Ask backend to send a recovery WhatsApp message (only if critical was sent).
 */
export async function notifyWhatsAppRecovery(fault, extras = {}) {
  if (!fault?.id && !extras.fault_id) {
    return { ok: false, data: { status: "invalid" } };
  }
  return postJson("/notifications/whatsapp/recovery", {
    fault_id: fault?.id || extras.fault_id,
    component: fault?.component || extras.component,
    metric_name: fault?.metricName || extras.metric_name,
    current_value: extras.current_value || fault?.currentValue,
    previous_value: extras.previous_value,
    recovery_action: extras.recovery_action,
    verified_at: extras.verified_at || new Date().toISOString(),
    hostname: extras.hostname,
    status: "RECOVERED",
  });
}
