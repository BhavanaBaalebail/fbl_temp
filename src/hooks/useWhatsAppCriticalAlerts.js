/**
 * useWhatsAppCriticalAlerts
 *
 * Bridges existing FBL fault detection → backend WhatsApp service.
 * Does not detect faults itself. Does not call WhatsApp APIs from the browser.
 */

import { useEffect, useRef } from "react";
import {
  notifyWhatsAppCritical,
  notifyWhatsAppRecovery,
} from "../services/whatsappAlertClient";
import { RECOVERY_STATUS } from "../recovery/recoveryHistoryService";

function isCriticalActive(fault) {
  if (!fault?.id) return false;
  if (String(fault.severity || "").toLowerCase() !== "critical") return false;
  if (fault.status === "Recovered") return false;
  if (fault.recoveryStatus === RECOVERY_STATUS.RECOVERED) return false;
  return true;
}

export function useWhatsAppCriticalAlerts(faults = [], { hostname, enabled = true } = {}) {
  // fault_id → snapshot of last critical we successfully notified (or attempted)
  const activeCriticalRef = useRef(new Map());
  const inFlightRef = useRef(new Set());

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    const list = Array.isArray(faults) ? faults : [];
    const currentCritical = new Map();

    list.forEach((fault) => {
      if (isCriticalActive(fault)) {
        currentCritical.set(fault.id, fault);
      }
    });

    async function sync() {
      // New criticals → notify once (backend also dedupes)
      for (const [id, fault] of currentCritical.entries()) {
        if (cancelled) return;
        if (activeCriticalRef.current.has(id)) continue;
        if (inFlightRef.current.has(`c:${id}`)) continue;
        inFlightRef.current.add(`c:${id}`);
        try {
          const res = await notifyWhatsAppCritical(fault, hostname);
          const st = res?.data?.status;
          if (!cancelled && (st === "sent" || st === "duplicate" || st === "disabled")) {
            activeCriticalRef.current.set(id, {
              component: fault.component,
              metricName: fault.metricName,
              currentValue: fault.currentValue,
              thresholdCrossed: fault.thresholdCrossed,
            });
          }
        } catch {
          // Advisory only — never affect fault UI
        } finally {
          inFlightRef.current.delete(`c:${id}`);
        }
      }

      // Cleared or recovered criticals that we previously tracked → recovery notify
      for (const [id, prior] of [...activeCriticalRef.current.entries()]) {
        if (currentCritical.has(id)) continue;
        if (cancelled) return;
        if (inFlightRef.current.has(`r:${id}`)) continue;

        const recoveredRow = list.find(
          (f) =>
            f.id === id &&
            (f.status === "Recovered" ||
              f.recoveryStatus === RECOVERY_STATUS.RECOVERED)
        );

        inFlightRef.current.add(`r:${id}`);
        try {
          await notifyWhatsAppRecovery(recoveredRow || { id, ...prior }, {
            fault_id: id,
            component: prior.component,
            metric_name: prior.metricName,
            previous_value: prior.currentValue,
            current_value: recoveredRow?.currentValue,
            recovery_action: recoveredRow?.recoveryNote,
            hostname,
            verified_at: new Date().toISOString(),
          });
        } catch {
          /* advisory */
        } finally {
          inFlightRef.current.delete(`r:${id}`);
          activeCriticalRef.current.delete(id);
        }
      }
    }

    sync();
    return () => {
      cancelled = true;
    };
  }, [faults, hostname, enabled]);
}
