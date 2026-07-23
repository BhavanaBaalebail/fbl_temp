/**
 * useFaults Hook
 * Manages fault log filtering; fault data is supplied by live telemetry.
 * Overlays Auto Recovered status from recovery history.
 */

import { useState, useMemo, useEffect } from "react";
import {
  isFaultAutoRecovered,
  subscribeRecoveryHistory,
} from "../recovery/recoveryHistoryService";

function enrichFaultRow(row) {
  if (!row?.id || !isFaultAutoRecovered(row.id)) return row;
  return {
    ...row,
    status: "Auto Recovered",
    recoveryStatus: "auto_recovered",
  };
}

export function useFaults(faultRows = []) {
  const [activeFaultFilter, setActiveFaultFilter] = useState("All");
  const [historyTick, setHistoryTick] = useState(0);

  useEffect(() => subscribeRecoveryHistory(() => setHistoryTick((n) => n + 1)), []);

  const enrichedRows = useMemo(
    () => faultRows.map(enrichFaultRow),
    [faultRows, historyTick]
  );

  const filteredFaultRows = useMemo(() => {
    if (activeFaultFilter === "All") return enrichedRows;
    if (activeFaultFilter === "Resolved") {
      return enrichedRows.filter(
        (row) =>
          row.severity.toLowerCase() === "resolved" ||
          row.status === "Auto Recovered" ||
          row.recoveryStatus === "auto_recovered"
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
