/**
 * Email alert client — reads Flask status/history only.
 * Never holds or requests SMTP credentials.
 */

import { LINUX_SERVER } from "./linuxMetricsService";

export async function fetchEmailStatus() {
  try {
    const res = await fetch(`${LINUX_SERVER}/notifications/email/status`, {
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
        message: "Email status unavailable",
        error: String(err?.message || err),
      },
    };
  }
}
