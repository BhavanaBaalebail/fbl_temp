/**
 * useTelemetry Hook
 * Single source of truth for live Linux hardware telemetry.
 * Polls inventory, metrics, and link_health every 5 seconds.
 */

import { useState, useEffect } from "react";
import {
  dashboardMetrics,
  healthRows,
  severityData,
} from "../data/dashboardData";
import { faultLogRows } from "../data/faultData";
import { anomalyCategoryCards } from "../data/anomalyData";
import {
  fetchLinuxTelemetry,
  buildTelemetrySnapshot,
  REFRESH_MS,
} from "../services/linuxMetricsService";
import { recordTelemetrySample } from "../services/metricsHistoryService";

const FALLBACK_ANOMALY_STATS = { active: 0, monitoring: 0, clear: 6, total: 6 };

export function useTelemetry() {
  const [metrics, setMetrics] = useState(dashboardMetrics);
  const [health, setHealth] = useState(healthRows);
  const [severity, setSeverity] = useState(severityData);
  const [stats, setStats] = useState(null);
  const [faults, setFaults] = useState(faultLogRows);
  const [anomalyCategories, setAnomalyCategories] = useState(anomalyCategoryCards);
  const [anomalyStats, setAnomalyStats] = useState(FALLBACK_ANOMALY_STATS);
  const [topologyContext, setTopologyContext] = useState(null);
  const [linkHealthSummary, setLinkHealthSummary] = useState(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [hostname, setHostname] = useState(null);
  const [error, setError] = useState(null);
  const [rawMetrics, setRawMetrics] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const { inventory, metrics: liveMetrics, linkHealth } =
          await fetchLinuxTelemetry();

        if (cancelled) return;

        const snapshot = buildTelemetrySnapshot(inventory, liveMetrics, linkHealth);

        recordTelemetrySample(inventory, liveMetrics, linkHealth);

        setRawMetrics(liveMetrics);
        setHealth(snapshot.health);
        setMetrics(snapshot.metrics);
        setSeverity(snapshot.severity);
        setStats(snapshot.stats);
        setFaults(snapshot.faults);
        setAnomalyCategories(snapshot.anomalyCategories);
        setAnomalyStats(snapshot.anomalyStats);
        setTopologyContext(snapshot.topologyContext);
        setLinkHealthSummary(snapshot.linkHealthSummary);
        setHostname(snapshot.hostname);
        setLastUpdated(new Date());
        setConnected(true);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        console.error("Linux telemetry fetch failed", err);
        setConnected(false);
        setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    poll();
    const id = setInterval(poll, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return {
    metrics,
    health,
    severity,
    stats,
    faults,
    anomalyCategories,
    anomalyStats,
    topologyContext,
    linkHealthSummary,
    connected,
    loading,
    lastUpdated,
    hostname,
    error,
    rawMetrics,
  };
}
