/**
 * Live process candidate list — GET /recovery/process_candidates + per-row execute.
 */

import { useCallback, useEffect, useState } from "react";
import {
  executeRecoveryAction,
  fetchProcessCandidates,
  isActionSupported,
} from "../../recovery/recoveryApiService";
import { getActionByBackendKey } from "../../recovery/recoveryActionCatalog";
import {
  candidateCommandLine,
  candidateUsageLabel,
  processActionKeysForDomain,
  processCandidatesDomainForFault,
} from "../../recovery/recoveryProcessDomain";
import { RecoveryConfirmationDialog } from "./RecoveryConfirmationDialog";

const PANEL = {
  inner: "rgba(8, 12, 18, 0.9)",
  border: "rgba(34, 211, 238, 0.15)",
};

function buildPendingRecommendation(actionKey, candidate, domain) {
  const action = getActionByBackendKey(actionKey);
  const isKill = actionKey.includes("kill") || actionKey.includes("terminate");
  return {
    actionId: action?.id || actionKey,
    backendAction: actionKey,
    label: isKill ? "Kill Process" : "Pause Process",
    level: action?.level ?? (isKill ? 3 : 2),
    impact: action?.impact || (isKill ? "Terminates the selected process." : "Suspends the selected process."),
    params: { pid: candidate.pid },
    target: {
      pid: candidate.pid,
      processName: candidateCommandLine(candidate),
    },
    domain,
  };
}

export function RecoveryProcessCandidates({
  fault,
  connected,
  capabilities,
  minPercent = 1,
  onActionComplete,
}) {
  const domain = processCandidatesDomainForFault(fault);
  const actionKeys = processActionKeysForDomain(domain);

  const [candidates, setCandidates] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [executingPid, setExecutingPid] = useState(null);
  const [pending, setPending] = useState(null);
  const [actionMessage, setActionMessage] = useState(null);

  const refresh = useCallback(async () => {
    if (!connected) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchProcessCandidates(domain, { minPercent, limit: 50 });
      setCandidates(data.candidates || []);
      setMeta(data);
    } catch (err) {
      setCandidates([]);
      setMeta(null);
      setError(err.message || "Failed to load process candidates");
    } finally {
      setLoading(false);
    }
  }, [connected, domain, minPercent]);

  useEffect(() => {
    refresh();
  }, [refresh, fault?.id]);

  const pauseSupported = isActionSupported(capabilities, actionKeys.pause);
  const killSupported = isActionSupported(capabilities, actionKeys.kill);

  const runAction = async (recommendation) => {
    setExecutingPid(recommendation.params?.pid);
    setActionMessage(null);
    setPending(null);
    try {
      const result = await executeRecoveryAction({
        action: recommendation.backendAction,
        params: recommendation.params,
        fault: {
          id: fault.id,
          component: fault.component,
          metricName: fault.metricName,
          severity: fault.severity,
          currentValue: fault.currentValue,
          thresholdCrossed: fault.thresholdCrossed,
        },
        confirmation: {
          level: recommendation.level,
          userAcknowledged: true,
          acknowledgedAt: new Date().toISOString(),
        },
      });
      setActionMessage(
        result.success
          ? result.message || "Action completed."
          : result.message || "Action failed on host."
      );
      await refresh();
      onActionComplete?.(result);
    } catch (err) {
      setActionMessage(err.message || "Recovery request failed.");
    } finally {
      setExecutingPid(null);
    }
  };

  const requestAction = (actionKey, candidate) => {
    if (!candidate.recoverable) return;
    const recommendation = buildPendingRecommendation(actionKey, candidate, domain);
    if (recommendation.level >= 2) {
      setPending(recommendation);
    } else {
      runAction(recommendation);
    }
  };

  return (
    <>
      <RecoveryConfirmationDialog
        open={Boolean(pending)}
        recommendation={pending}
        onCancel={() => setPending(null)}
        onProceed={() => pending && runAction(pending)}
      />

      {loading ? (
        <p className="text-sm text-[#64748b]">Loading process candidates…</p>
      ) : error ? (
        <p className="text-sm text-[#f59e0b]">
          {error}
          <span className="mt-1 block text-xs text-[#64748b]">
            Deploy CM.py with GET /recovery/process_candidates on the telemetry server.
          </span>
        </p>
      ) : candidates.length === 0 ? (
        <p className="text-sm text-[#64748b]">
          No processes at or above {meta?.min_percent ?? minPercent}% {domain === "gpu" ? "GPU" : "CPU"}{" "}
          usage.
        </p>
      ) : (
        <div className="hw-table-wrap overflow-x-auto">
          <table className="hw-table min-w-full text-xs">
            <thead>
              <tr>
                <th>PID</th>
                <th>Command</th>
                <th className="text-right">Usage</th>
                <th>User</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((row) => {
                const busy = executingPid === row.pid;
                const pauseDisabled = !row.recoverable || !pauseSupported || busy;
                const killDisabled = !row.recoverable || !killSupported || busy;
                const tip = !row.recoverable ? row.reason || "Not recoverable" : undefined;
                return (
                  <tr key={row.pid}>
                    <td className="font-mono-metrics">{row.pid}</td>
                    <td className="max-w-[220px] truncate" title={candidateCommandLine(row)}>
                      {candidateCommandLine(row)}
                    </td>
                    <td className="text-right font-mono-metrics">
                      {candidateUsageLabel(row, domain)}
                    </td>
                    <td>{row.user || "—"}</td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          className="hw-btn-filter px-2 py-1 text-[10px] disabled:opacity-40"
                          disabled={pauseDisabled}
                          title={tip}
                          onClick={() => requestAction(actionKeys.pause, row)}
                        >
                          Pause
                        </button>
                        <button
                          type="button"
                          className="rounded px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40"
                          style={{ background: killDisabled ? "#475569" : "#b91c1c" }}
                          disabled={killDisabled}
                          title={tip}
                          onClick={() => requestAction(actionKeys.kill, row)}
                        >
                          Kill
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {actionMessage && (
        <p
          className="mt-2 rounded-lg border px-3 py-2 text-xs"
          style={{ background: PANEL.inner, borderColor: PANEL.border, color: "#94a3b8" }}
        >
          {actionMessage}
        </p>
      )}

      {!capabilities?.available && connected && (
        <p className="mt-2 text-[10px] text-[#64748b]">
          Recovery API offline — actions disabled until /recovery/capabilities is reachable.
        </p>
      )}
    </>
  );
}
