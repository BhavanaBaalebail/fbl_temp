/**
 * useFaults Hook
 * Manages fault log filtering; fault data is supplied by live telemetry.
 * Overlays Recovered / recovery status only when post-action verification confirmed recovery.
 */

import { useState, useMemo, useEffect } from "react";
import {
  getFaultRecoveryOverlay,
  isFaultAutoRecovered,
  subscribeRecoveryHistory,
  RECOVERY_STATUS,
} from "../recovery/recoveryHistoryService";

function enrichFaultRow(row) {
  if (!row?.id) return row;
  const overlay = getFaultRecoveryOverlay(row.id);
  if (!overlay) return row;

  if (isFaultAutoRecovered(row.id)) {
    return {
      ...row,
      status: "Recovered",
      recoveryStatus: RECOVERY_STATUS.RECOVERED,
      recoveryNote: overlay.verificationOutcome,
    };
  }

  // Action taken but fault not recovered — keep Active, surface recovery note.
  if (
    overlay.recoveryStatus === RECOVERY_STATUS.STILL_ACTIVE ||
    overlay.recoveryStatus === RECOVERY_STATUS.RECOVERY_FAILED ||
    overlay.recoveryStatus === RECOVERY_STATUS.VERIFICATION_UNAVAILABLE ||
    overlay.actionStatus === RECOVERY_STATUS.ACTION_SUCCESS
  ) {
    return {
      ...row,
      status: row.status || "Active",
      recoveryStatus: overlay.recoveryStatus || overlay.actionStatus,
      recoveryNote: overlay.verificationOutcome,
    };
  }

  return row;
}

export function useFaults(faultRows = []) {
  const [activeFaultFilter, setActiveFaultFilter] = useState("All");
  const [historyTick, setHistoryTick] = useState(0);

  useEffect(() => subscribeRecoveryHistory(() => setHistoryTick((n) => n + 1)), []);

  const enrichedRows = useMemo(
    () => faultRows.map(enrichFaultRow),
    // historyTick forces recompute when recovery history changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [faultRows, historyTick]
  );

  const filteredFaultRows = useMemo(() => {
    if (activeFaultFilter === "All") return enrichedRows;
    if (activeFaultFilter === "Resolved") {
      return enrichedRows.filter(
        (row) =>
          row.severity.toLowerCase() === "resolved" ||
          row.status === "Recovered" ||
          row.recoveryStatus === RECOVERY_STATUS.RECOVERED
      );
    }
    return enrichedRows.filter(
      (row) => row.severity.toLowerCase() === activeFaultFilter.toLowerCase()
    );
  }, [enrichedRows, activeFaultFilter]);

  return {
    faults: enrichedRows,
    activeFaultFilter,
    setActiveFaultFilter,
    filteredFaultRows,
  };
}
