/**
 * useDigitalTwin — polls Ubuntu CM.py Digital Twin endpoints on the same
 * interval as global telemetry (REFRESH_MS = 5s). Only fetches candidates
 * when pressure.has_problem is true.
 */

import { useCallback, useEffect, useState } from "react";
import { REFRESH_MS } from "../services/linuxMetricsService";
import {
  fetchDigitalTwinPressure,
  fetchDigitalTwinCandidates,
} from "../recovery/digitalTwinApiService";

export function useDigitalTwin({ enabled = true, topN = 5 } = {}) {
  const [pressure, setPressure] = useState(null);
  const [stateSummary, setStateSummary] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [pressuredDomains, setPressuredDomains] = useState([]);
  const [candidateMessage, setCandidateMessage] = useState(null);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [pollTick, setPollTick] = useState(0);

  const refreshNow = useCallback(() => {
    setPollTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;

    async function poll() {
      try {
        const pressureRes = await fetchDigitalTwinPressure();
        if (cancelled) return;

        if (!pressureRes.available) {
          setAvailable(false);
          setError(pressureRes.message || "Backend unavailable");
          setPressure(null);
          setStateSummary(null);
          setCandidates([]);
          setPressuredDomains([]);
          setCandidateMessage(null);
          return;
        }

        setAvailable(true);
        setError(null);
        setPressure(pressureRes.pressure);
        setStateSummary(pressureRes.stateSummary);

        if (pressureRes.pressure?.has_problem) {
          const candRes = await fetchDigitalTwinCandidates({ topN });
          if (cancelled) return;
          if (candRes.available) {
            setCandidates(candRes.candidates || []);
            setPressuredDomains(candRes.pressuredDomains || []);
            setCandidateMessage(candRes.message);
          } else {
            setCandidates([]);
            setPressuredDomains([]);
            setCandidateMessage(candRes.message);
          }
        } else {
          setCandidates([]);
          setPressuredDomains([]);
          setCandidateMessage(null);
        }
        setLastUpdated(new Date());
      } catch (err) {
        if (cancelled) return;
        setAvailable(false);
        setError(err.message || "Digital Twin poll failed");
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
  }, [enabled, topN, pollTick]);

  return {
    pressure,
    stateSummary,
    candidates,
    pressuredDomains,
    candidateMessage,
    available,
    loading: enabled ? loading : false,
    error,
    lastUpdated,
    refresh: refreshNow,
    hasProblem: Boolean(pressure?.has_problem),
  };
}
