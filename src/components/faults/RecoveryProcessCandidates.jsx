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
import { recordRecoveryExecution, RECOVERY_STATUS } from "../../recovery/recoveryHistoryService";
import { StatusBadge } from "../ui/HardwareModule";
import { RecoveryConfirmationDialog } from "./RecoveryConfirmationDialog";

const PANEL = {
  inner: "rgba(8, 12, 18, 0.9)",
  border: "rgba(34, 211, 238, 0.15)",
};

function buildPendingRecommendation(actionKey, candidate, domain) {
  const action = getActionByBackendKey(actionKey);
  const isKill = actionKey.includes("kill") || actionKey.includes("terminate");
  const isResume = actionKey.includes("resume");
  let label = "Pause Process";
  if (isResume) label = "Resume Process";
  else if (isKill)
    label =
      domain === "disk" || domain === "io" || domain === "gpu" || domain === "nic"
        ? "Terminate Process"
        : "Kill Process";

  return {
    actionId: action?.id || actionKey,
    backendAction: actionKey,
    label,
    level: action?.level ?? (isKill ? 3 : isResume ? 1 : 2),
    impact:
      action?.impact ||
      (isKill
        ? domain === "disk" || domain === "io"
          ? "Sends SIGTERM to the selected process."
          : domain === "gpu"
            ? "Sends SIGTERM to the selected GPU process."
            : domain === "nic"
              ? "Sends SIGTERM to the selected network process."
            : "Terminates the selected process."
        : isResume
          ? "Sends SIGCONT to resume the selected process."
          : "Suspends the selected process."),
    params: { pid: candidate.pid },
    target: {
      pid: candidate.pid,
      processName: candidateCommandLine(candidate),
    },
    domain,
  };
}

function diskUsageEmptyLabel(minPercent) {
  return `No processes at or above ${minPercent} KB/s total disk I/O.`;
}

function ioUsageEmptyLabel(minPercent) {
  return `No processes at or above ${minPercent} MB/s total I/O.`;
}

function fmtMBps(value) {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(1);
}

function gpuUsageEmptyLabel(minPercent) {
  return `No GPU processes at or above ${minPercent}% utilization or 64 MB VRAM.`;
}

function nicUsageEmptyLabel(minPercent) {
  return `No network processes at or above ${minPercent} KB/s total throughput.`;
}

function fmtMbps(value) {
  if (value == null) return "—";
  return Number(value).toFixed(1);
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
  const [actionStatus, setActionStatus] = useState(null);

  const refresh = useCallback(async () => {
    if (!connected) {
      setLoading(false);
      return null;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchProcessCandidates(domain, { minPercent, limit: 50 });
      setCandidates(data.candidates || []);
      setMeta(data);
      return data;
    } catch (err) {
      setCandidates([]);
      setMeta(null);
      setError(err.message || "Failed to load process candidates");
      return null;
    } finally {
      setLoading(false);
    }
  }, [connected, domain, minPercent]);

  useEffect(() => {
    refresh();
  }, [refresh, fault?.id]);

  const pauseSupported = isActionSupported(capabilities, actionKeys.pause);
  const resumeSupported = actionKeys.resume
    ? isActionSupported(capabilities, actionKeys.resume)
    : false;
  const killSupported = isActionSupported(capabilities, actionKeys.kill);

  const runAction = async (recommendation) => {
    const selectedPid = recommendation.params?.pid;
    const isKill =
      recommendation.backendAction?.includes("kill") ||
      recommendation.backendAction?.includes("terminate");

    console.info("[recovery] user process action", {
      action: recommendation.backendAction,
      pid: selectedPid,
      command: candidateCommandLine(
        candidates.find((c) => c.pid === selectedPid) || {
          command: recommendation.target?.processName,
        }
      ),
    });
    setExecutingPid(selectedPid);
    setActionMessage(null);
    setActionStatus(RECOVERY_STATUS.ACTION_EXECUTING);
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

      let processVerified =
        result.verified === true ||
        (result.verified == null && result.success === true);
      let actionOk = Boolean(result.success) && processVerified && result.verified !== false;
      let detail =
        result.verification ||
        result.message ||
        (actionOk ? "Process action completed on host." : "Process action failed on host.");

      const refreshed = await refresh();
      if (
        isKill &&
        actionOk &&
        refreshed?.candidates?.some((c) => c.pid === selectedPid)
      ) {
        actionOk = false;
        detail = `Process ${selectedPid} is still running on the host after kill.`;
        processVerified = false;
      }

      setActionStatus(
        actionOk ? RECOVERY_STATUS.ACTION_SUCCESS : RECOVERY_STATUS.ACTION_FAILED
      );
      setActionMessage(
        actionOk
          ? `${detail}${result.command ? ` · ${result.command}` : ""}`
          : detail
      );

      recordRecoveryExecution({
        faultId: fault.id,
        component: fault.component,
        metricName: fault.metricName,
        pid: selectedPid,
        processName: recommendation.target?.processName,
        action: recommendation.backendAction,
        actionStatus: actionOk
          ? RECOVERY_STATUS.ACTION_SUCCESS
          : RECOVERY_STATUS.ACTION_FAILED,
        recoveryStatus: actionOk
          ? RECOVERY_STATUS.ACTION_SUCCESS
          : RECOVERY_STATUS.RECOVERY_FAILED,
        result: actionOk ? "success" : "failed",
        selectedAction: {
          actionId: recommendation.actionId,
          label: recommendation.label,
          level: recommendation.level,
        },
        params: recommendation.params,
        confirmationGiven: true,
        commandExecuted: result.command || recommendation.backendAction,
        commandOutput: result,
        processStateBefore: result.processStateBefore ?? null,
        processStateAfter: result.processStateAfter ?? null,
        processVerified: result.verified ?? processVerified,
        verificationOutcome: detail,
        reason: detail,
        timestamp: new Date().toISOString(),
      });

      onActionComplete?.({
        ...result,
        success: actionOk,
        actionSuccess: actionOk,
        recovered: false,
        message: detail,
      });
    } catch (err) {
      setActionStatus(RECOVERY_STATUS.ACTION_FAILED);
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

  const emptyLabel =
    domain === "io"
      ? ioUsageEmptyLabel(meta?.min_percent ?? minPercent)
      : domain === "disk"
      ? diskUsageEmptyLabel(meta?.min_percent ?? minPercent)
      : domain === "gpu"
        ? gpuUsageEmptyLabel(meta?.min_percent ?? minPercent)
        : domain === "nic"
          ? nicUsageEmptyLabel(meta?.min_percent ?? minPercent)
        : `No processes at or above ${meta?.min_percent ?? minPercent}% ${domain === "gpu" ? "GPU" : "CPU"} usage.`;

  const terminateLabel =
    domain === "disk" || domain === "io" || domain === "gpu" || domain === "nic"
      ? "Terminate"
      : "Kill";

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
        <p className="text-sm text-[#64748b]">{emptyLabel}</p>
      ) : domain === "gpu" ? (
        <div className="hw-table-wrap overflow-x-auto">
          <table className="hw-table min-w-full text-xs">
            <thead>
              <tr>
                <th>PID</th>
                <th>Process</th>
                <th className="text-right">GPU %</th>
                <th className="text-right">VRAM MB</th>
                <th className="text-right">CPU %</th>
                <th className="text-right">Mem %</th>
                <th>User</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((row) => {
                const busy = executingPid === row.pid;
                const pauseDisabled = !row.recoverable || !pauseSupported || busy;
                const resumeDisabled = !row.recoverable || !resumeSupported || busy;
                const killDisabled = !row.recoverable || !killSupported || busy;
                const tip = !row.recoverable ? row.reason || "Not recoverable" : undefined;
                return (
                  <tr key={row.pid}>
                    <td className="font-mono-metrics">{row.pid}</td>
                    <td className="max-w-[220px] truncate" title={candidateCommandLine(row)}>
                      {candidateCommandLine(row)}
                    </td>
                    <td className="text-right font-mono-metrics">
                      {row.gpu_compute_percent ?? "—"}
                    </td>
                    <td className="text-right font-mono-metrics">
                      {row.gpu_memory_mb ?? row.gpu_memory_percent ?? "—"}
                    </td>
                    <td className="text-right font-mono-metrics">{row.cpu_percent ?? "—"}</td>
                    <td className="text-right font-mono-metrics">{row.memory_percent ?? "—"}</td>
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
                        {actionKeys.resume && (
                          <button
                            type="button"
                            className="hw-btn-filter px-2 py-1 text-[10px] disabled:opacity-40"
                            disabled={resumeDisabled}
                            title={tip}
                            onClick={() => requestAction(actionKeys.resume, row)}
                          >
                            Resume
                          </button>
                        )}
                        <button
                          type="button"
                          className="rounded px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40"
                          style={{ background: killDisabled ? "#475569" : "#b91c1c" }}
                          disabled={killDisabled}
                          title={tip}
                          onClick={() => requestAction(actionKeys.kill, row)}
                        >
                          {terminateLabel}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : domain === "nic" ? (
        <div className="hw-table-wrap-scroll">
          <table className="hw-table hw-table-sticky-actions min-w-full text-xs">
            <thead>
              <tr>
                <th>PID</th>
                <th>Process</th>
                <th>User</th>
                <th className="text-right">RX Mbps</th>
                <th className="text-right">TX Mbps</th>
                <th className="text-right">CPU %</th>
                <th className="text-right">Mem %</th>
                <th className="text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((row) => {
                const busy = executingPid === row.pid;
                const pauseDisabled = !row.recoverable || !pauseSupported || busy;
                const resumeDisabled = !row.recoverable || !resumeSupported || busy;
                const killDisabled = !row.recoverable || !killSupported || busy;
                const tip = !row.recoverable ? row.reason || "Not recoverable" : undefined;
                const executable = row.command || row.program || candidateCommandLine(row);
                const processTitle = executable !== candidateCommandLine(row)
                  ? `${candidateCommandLine(row)}\n${executable}`
                  : candidateCommandLine(row);
                return (
                  <tr key={row.pid}>
                    <td className="font-mono-metrics">{row.pid}</td>
                    <td className="max-w-[200px] truncate" title={processTitle}>
                      {candidateCommandLine(row)}
                    </td>
                    <td>{row.user || "—"}</td>
                    <td className="text-right font-mono-metrics">
                      {fmtMbps(row.rx_mbps ?? (row.received_kbps != null ? (row.received_kbps * 8) / 1000 : null))}
                    </td>
                    <td className="text-right font-mono-metrics">
                      {fmtMbps(row.tx_mbps ?? (row.sent_kbps != null ? (row.sent_kbps * 8) / 1000 : null))}
                    </td>
                    <td className="text-right font-mono-metrics">{row.cpu_percent ?? "—"}</td>
                    <td className="text-right font-mono-metrics">{row.memory_percent ?? "—"}</td>
                    <td className="text-right whitespace-nowrap">
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
                        {actionKeys.resume && (
                          <button
                            type="button"
                            className="hw-btn-filter px-2 py-1 text-[10px] disabled:opacity-40"
                            disabled={resumeDisabled}
                            title={tip}
                            onClick={() => requestAction(actionKeys.resume, row)}
                          >
                            Resume
                          </button>
                        )}
                        <button
                          type="button"
                          className="rounded px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40"
                          style={{ background: killDisabled ? "#475569" : "#b91c1c" }}
                          disabled={killDisabled}
                          title={tip}
                          onClick={() => requestAction(actionKeys.kill, row)}
                        >
                          {terminateLabel}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : domain === "io" ? (
        <div className="hw-table-wrap overflow-x-auto">
          <table className="hw-table min-w-full text-xs">
            <thead>
              <tr>
                <th>PID</th>
                <th>Process</th>
                <th>User</th>
                <th className="text-right">Read</th>
                <th className="text-right">Write</th>
                <th className="text-right">Total I/O</th>
                <th className="text-right">CPU %</th>
                <th className="text-right">Mem %</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((row) => {
                const busy = executingPid === row.pid;
                const pauseDisabled = !row.recoverable || !pauseSupported || busy;
                const resumeDisabled = !row.recoverable || !resumeSupported || busy;
                const killDisabled = !row.recoverable || !killSupported || busy;
                const tip = !row.recoverable ? row.reason || "Not recoverable" : undefined;
                const processTitle = row.command && row.command !== row.process
                  ? `${row.process || candidateCommandLine(row)}\n${row.command}`
                  : candidateCommandLine(row);
                return (
                  <tr key={row.pid}>
                    <td className="font-mono-metrics">{row.pid}</td>
                    <td className="max-w-[200px] truncate" title={processTitle}>
                      {row.process || candidateCommandLine(row)}
                    </td>
                    <td>{row.user || "—"}</td>
                    <td className="text-right font-mono-metrics">
                      {fmtMBps(row.read_MB_per_sec)} MB/s
                    </td>
                    <td className="text-right font-mono-metrics">
                      {fmtMBps(row.write_MB_per_sec)} MB/s
                    </td>
                    <td className="text-right font-mono-metrics">
                      {candidateUsageLabel(row, domain)}
                    </td>
                    <td className="text-right font-mono-metrics">{row.cpu_percent ?? "—"}</td>
                    <td className="text-right font-mono-metrics">{row.memory_percent ?? "—"}</td>
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
                        {actionKeys.resume && (
                          <button
                            type="button"
                            className="hw-btn-filter px-2 py-1 text-[10px] disabled:opacity-40"
                            disabled={resumeDisabled}
                            title={tip}
                            onClick={() => requestAction(actionKeys.resume, row)}
                          >
                            Resume
                          </button>
                        )}
                        <button
                          type="button"
                          className="rounded px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40"
                          style={{ background: killDisabled ? "#475569" : "#b91c1c" }}
                          disabled={killDisabled}
                          title={tip}
                          onClick={() => requestAction(actionKeys.kill, row)}
                        >
                          {terminateLabel}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : domain === "io" ? (
        <div className="hw-table-wrap overflow-x-auto">
          <table className="hw-table min-w-full text-xs">
            <thead>
              <tr>
                <th>PID</th>
                <th>Process</th>
                <th>User</th>
                <th className="text-right">Read</th>
                <th className="text-right">Write</th>
                <th className="text-right">Total I/O</th>
                <th className="text-right">CPU %</th>
                <th className="text-right">Mem %</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((row) => {
                const busy = executingPid === row.pid;
                const pauseDisabled = !row.recoverable || !pauseSupported || busy;
                const resumeDisabled = !row.recoverable || !resumeSupported || busy;
                const killDisabled = !row.recoverable || !killSupported || busy;
                const tip = !row.recoverable ? row.reason || "Not recoverable" : undefined;
                const processTitle = row.command && row.command !== row.process
                  ? `${row.process || candidateCommandLine(row)}\n${row.command}`
                  : candidateCommandLine(row);
                return (
                  <tr key={row.pid}>
                    <td className="font-mono-metrics">{row.pid}</td>
                    <td className="max-w-[200px] truncate" title={processTitle}>
                      {row.process || candidateCommandLine(row)}
                    </td>
                    <td>{row.user || "—"}</td>
                    <td className="text-right font-mono-metrics">
                      {fmtMBps(row.read_MB_per_sec)} MB/s
                    </td>
                    <td className="text-right font-mono-metrics">
                      {fmtMBps(row.write_MB_per_sec)} MB/s
                    </td>
                    <td className="text-right font-mono-metrics">
                      {candidateUsageLabel(row, domain)}
                    </td>
                    <td className="text-right font-mono-metrics">{row.cpu_percent ?? "—"}</td>
                    <td className="text-right font-mono-metrics">{row.memory_percent ?? "—"}</td>
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
                        {actionKeys.resume && (
                          <button
                            type="button"
                            className="hw-btn-filter px-2 py-1 text-[10px] disabled:opacity-40"
                            disabled={resumeDisabled}
                            title={tip}
                            onClick={() => requestAction(actionKeys.resume, row)}
                          >
                            Resume
                          </button>
                        )}
                        <button
                          type="button"
                          className="rounded px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40"
                          style={{ background: killDisabled ? "#475569" : "#b91c1c" }}
                          disabled={killDisabled}
                          title={tip}
                          onClick={() => requestAction(actionKeys.kill, row)}
                        >
                          {terminateLabel}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : domain === "disk" ? (
        <div className="hw-table-wrap overflow-x-auto">
          <table className="hw-table min-w-full text-xs">
            <thead>
              <tr>
                <th>PID</th>
                <th>Process</th>
                <th className="text-right">Read KB/s</th>
                <th className="text-right">Write KB/s</th>
                <th className="text-right">Total I/O</th>
                <th className="text-right">CPU %</th>
                <th className="text-right">Mem %</th>
                <th>User</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((row) => {
                const busy = executingPid === row.pid;
                const pauseDisabled = !row.recoverable || !pauseSupported || busy;
                const resumeDisabled = !row.recoverable || !resumeSupported || busy;
                const killDisabled = !row.recoverable || !killSupported || busy;
                const tip = !row.recoverable ? row.reason || "Not recoverable" : undefined;
                return (
                  <tr key={row.pid}>
                    <td className="font-mono-metrics">{row.pid}</td>
                    <td className="max-w-[220px] truncate" title={candidateCommandLine(row)}>
                      {candidateCommandLine(row)}
                    </td>
                    <td className="text-right font-mono-metrics">{row.read_kbps ?? "—"}</td>
                    <td className="text-right font-mono-metrics">{row.write_kbps ?? "—"}</td>
                    <td className="text-right font-mono-metrics">
                      {candidateUsageLabel(row, domain)}
                    </td>
                    <td className="text-right font-mono-metrics">{row.cpu_percent ?? "—"}</td>
                    <td className="text-right font-mono-metrics">{row.memory_percent ?? "—"}</td>
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
                        {actionKeys.resume && (
                          <button
                            type="button"
                            className="hw-btn-filter px-2 py-1 text-[10px] disabled:opacity-40"
                            disabled={resumeDisabled}
                            title={tip}
                            onClick={() => requestAction(actionKeys.resume, row)}
                          >
                            Resume
                          </button>
                        )}
                        <button
                          type="button"
                          className="rounded px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40"
                          style={{ background: killDisabled ? "#475569" : "#b91c1c" }}
                          disabled={killDisabled}
                          title={tip}
                          onClick={() => requestAction(actionKeys.kill, row)}
                        >
                          {terminateLabel}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
                          {terminateLabel}
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
        <div
          className="mt-2 flex flex-wrap items-start gap-2 rounded-lg border px-3 py-2 text-xs"
          style={{ background: PANEL.inner, borderColor: PANEL.border }}
        >
          {actionStatus ? (
            <StatusBadge
              status={
                actionStatus === RECOVERY_STATUS.RECOVERED
                  ? "healthy"
                  : actionStatus === RECOVERY_STATUS.VERIFYING ||
                      actionStatus === RECOVERY_STATUS.ACTION_EXECUTING ||
                      actionStatus === RECOVERY_STATUS.ACTION_SUCCESS
                    ? "warning"
                    : actionStatus === RECOVERY_STATUS.STILL_ACTIVE ||
                        actionStatus === RECOVERY_STATUS.VERIFICATION_UNAVAILABLE
                      ? "warning"
                      : "critical"
              }
              label={String(actionStatus).replace(/_/g, " ")}
              showDot={false}
            />
          ) : null}
          <p className="min-w-0 flex-1 text-[#94a3b8]">{actionMessage}</p>
        </div>
      )}

      {!capabilities?.available && connected && (
        <p className="mt-2 text-[10px] text-[#64748b]">
          Recovery API offline — actions disabled until /recovery/capabilities is reachable.
        </p>
      )}
    </>
  );
}
