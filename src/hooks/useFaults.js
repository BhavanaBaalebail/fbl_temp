/**
 * useFaults Hook
 * Manages fault log filtering; fault data is supplied by live telemetry.
 * Overlays Verifying / Recovered only from recovery history + monitoring reconcile.
 */

import { useState, useMemo, useEffect } from "react";
import {
  getFaultRecoveryOverlay,
  getResolvedFaults,
  isFaultAutoRecovered,
  reconcileFaultLifecycle,
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
      status: row.status || "Active",
      recoveryStatus: RECOVERY_STATUS.STILL_ACTIVE,
      recoveryNote: "Fault condition is present again after a previous recovery.",
    };
  }

  if (
    overlay.recoveryStatus === RECOVERY_STATUS.VERIFYING ||
    overlay.recoveryStatus === RECOVERY_STATUS.ACTION_EXECUTING ||
    (overlay.actionStatus === RECOVERY_STATUS.ACTION_SUCCESS &&
      overlay.recoveryStatus !== RECOVERY_STATUS.STILL_ACTIVE &&
      overlay.recoveryStatus !== RECOVERY_STATUS.RECOVERY_FAILED)
  ) {
    return {
      ...row,
      status: "Verifying",
      recoveryStatus: overlay.recoveryStatus || RECOVERY_STATUS.VERIFYING,
      recoveryNote: overlay.verificationOutcome,
    };
  }

  if (
    overlay.recoveryStatus === RECOVERY_STATUS.STILL_ACTIVE ||
    overlay.recoveryStatus === RECOVERY_STATUS.RECOVERY_FAILED ||
    overlay.recoveryStatus === RECOVERY_STATUS.VERIFICATION_UNAVAILABLE
  ) {
    return {
      ...row,
      status: row.status || "Active",
      recoveryStatus: overlay.recoveryStatus,
      recoveryNote: overlay.verificationOutcome,
    };
  }

  return row;
}

export function useFaults(faultRows = [], { connected = false } = {}) {
  const [activeFaultFilter, setActiveFaultFilter] = useState("All");
  const [historyTick, setHistoryTick] = useState(0);

  useEffect(() => subscribeRecoveryHistory(() => setHistoryTick((n) => n + 1)), []);

  useEffect(() => {
    if (!connected) return;
    reconcileFaultLifecycle(faultRows);
  }, [faultRows, connected]);

  const enrichedRows = useMemo(
    () => faultRows.map(enrichFaultRow),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [faultRows, historyTick]
  );

  const activeRows = useMemo(
    () =>
      enrichedRows.filter(
        (row) =>
          row.status !== "Recovered" && row.recoveryStatus !== RECOVERY_STATUS.RECOVERED
      ),
    [enrichedRows]
  );

  const resolvedFaults = useMemo(() => getResolvedFaults(), [historyTick, faultRows]);

  const filteredFaultRows = useMemo(() => {
    if (activeFaultFilter === "All") return activeRows;
    if (activeFaultFilter === "Resolved") {
      return resolvedFaults.map((row) => ({
        ...row,
        status: "Recovered",
        severity: row.severity || "Resolved",
      }));
    }
    return activeRows.filter(
      (row) => row.severity.toLowerCase() === activeFaultFilter.toLowerCase()
    );
  }, [activeRows, resolvedFaults, activeFaultFilter]);

  return {
    faults: activeRows,
    activeFaultFilter,
    setActiveFaultFilter,
    filteredFaultRows,
    resolvedFaults,
  };
}
