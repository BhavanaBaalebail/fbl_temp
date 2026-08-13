/**
 * usePredictiveMaintenance — loads SQLite-backed threshold projections.
 */

import { useCallback, useEffect, useState } from "react";
import { loadPredictiveMaintenance } from "../services/predictiveMaintenanceApi";
import { PREDICTIVE_DISCLAIMER } from "../services/predictiveMaintenance";

export function usePredictiveMaintenance({ enabled = true, refreshMs = 60000 } = {}) {
  const [state, setState] = useState({
    loading: Boolean(enabled),
    error: null,
    data: null,
  });
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;

    (async () => {
      setState((s) => ({ ...s, loading: true }));
      try {
        const data = await loadPredictiveMaintenance({ hours: 6 });
        if (cancelled) return;
        setState({
          loading: false,
          error: data.error || null,
          data,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          loading: false,
          error: err.message || "Predictive maintenance unavailable",
          data: {
            disclaimer: PREDICTIVE_DISCLAIMER,
            predictions: [],
            actionable: [],
            sampleCount: 0,
          },
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, tick]);

  useEffect(() => {
    if (!enabled || !refreshMs) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), refreshMs);
    return () => clearInterval(id);
  }, [enabled, refreshMs]);

  if (!enabled) {
    return { loading: false, error: null, data: null, refresh };
  }

  return {
    loading: state.loading,
    error: state.error,
    data: state.data,
    refresh,
  };
}
