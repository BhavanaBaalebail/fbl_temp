/**
 * Polls platform_extras and derives utility cards from live telemetry.
 * Uses the same REFRESH_MS interval as useTelemetry (5s).
 */

import { useEffect, useMemo, useState } from "react";
import { fetchPlatformExtras, REFRESH_MS } from "../services/linuxMetricsService";
import { buildUtilityStatuses, countLiveUtilities } from "../services/utilitiesService";

export function useDashboardUtilities({
  enabled = true,
  connected = false,
  rawMetrics = null,
  rawLinkHealth = null,
  rawInventory = null,
  faults = [],
  linkHealthSummary = null,
}) {
  const [platformExtras, setPlatformExtras] = useState(null);
  const [pollTick, setPollTick] = useState(0);

  useEffect(() => {
    if (!enabled || !connected) return undefined;

    let cancelled = false;

    async function loadExtras() {
      const extras = await fetchPlatformExtras();
      if (!cancelled) setPlatformExtras(extras);
    }

    loadExtras();
    const id = setInterval(loadExtras, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, connected, pollTick]);

  const effectiveExtras = connected ? platformExtras : null;

  const utilities = useMemo(
    () =>
      buildUtilityStatuses({
        connected,
        metrics: rawMetrics,
        linkHealth: rawLinkHealth,
        inventory: rawInventory,
        faults,
        linkHealthSummary,
        platformExtras: effectiveExtras,
      }),
    [connected, rawMetrics, rawLinkHealth, rawInventory, faults, linkHealthSummary, effectiveExtras]
  );

  const summary = useMemo(() => countLiveUtilities(utilities), [utilities]);

  return {
    utilities,
    summary,
    platformExtras: effectiveExtras,
    refreshNow: () => setPollTick((t) => t + 1),
  };
}
