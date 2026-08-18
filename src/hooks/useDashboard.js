/**
 * useDashboard Hook
 * Dashboard-specific view of unified telemetry data.
 */

import { useTelemetry } from "./useTelemetry";

export function useDashboard() {
  const telemetry = useTelemetry();

  return {
    metrics: telemetry.metrics,
    health: telemetry.health,
    severity: telemetry.severity,
    stats: telemetry.stats,
    connected: telemetry.connected,
    loading: telemetry.loading,
    lastUpdated: telemetry.lastUpdated,
    hostname: telemetry.hostname,
    error: telemetry.error,
    linkHealthSummary: telemetry.linkHealthSummary,
  };
}
