/**
 * Recovery Workflow Engine — analyze → approve → POST /recovery/execute → verify.
 */

import { fetchLinuxTelemetry } from "../services/linuxMetricsService";
import { buildThresholdFaults } from "../services/linkHealthService";
import { readMetricValue, snapshotMetrics } from "./recoveryEvidence";
import { buildRecoveryAnalysis } from "./recoveryRecommendationEngine";
import {
  fetchRecoveryCapabilities,
  executeRecoveryAction,
} from "./recoveryApiService";
import { recordRecoveryExecution } from "./recoveryHistoryService";
import { getActionById } from "./recoveryActionCatalog";

export function createTimelineEvent(type, message, detail = null) {
  return {
    type,
    message,
    detail,
    timestamp: new Date().toISOString(),
    timeLabel: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  };
}

function faultStillActive(fault, inventory, metrics, linkHealth) {
  const active = buildThresholdFaults(linkHealth, inventory, metrics);
  if (fault.source === "threshold" && fault.id) {
    return active.some((f) => f.id === fault.id);
  }
  return active.some(
    (f) =>
      f.component === fault.component &&
      f.metricName === fault.metricName &&
      f.severity === fault.severity
  );
}

function runSafetyChecks(fault, metrics, linkHealth) {
  const issues = [];
  const cpuH = (linkHealth?.cpu || {})?.health || {};
  const memH = (linkHealth?.memory || {})?.health || {};

  if ((cpuH.fatal_errors || 0) > 0 && !fault.id?.includes("cpu-fatal")) {
    issues.push("CPU fatal machine-check errors detected — aborting automated recovery.");
  }
  if ((memH.uncorrectable_errors || 0) > 0 && !fault.id?.includes("uncorrectable")) {
    issues.push("Uncorrectable ECC memory errors detected — aborting automated recovery.");
  }

  const smartBad = Object.values(metrics?.disk?.smart || {}).some(
    (s) => s.health && s.health !== "PASSED" && s.health !== "OK"
  );
  if (smartBad && !fault.id?.includes("smart")) {
    issues.push("SMART disk failure detected — aborting.");
  }

  const otherCritical = buildThresholdFaults(linkHealth, {}, metrics).filter(
    (f) => f.severity === "Critical" && f.id !== fault.id
  );
  if (otherCritical.length >= 2) {
    issues.push(`${otherCritical.length} other critical faults active — aborting for safety.`);
  }

  return { passed: issues.length === 0, issues };
}

function primaryMetricForFault(fault) {
  const id = fault.id || "";
  if (id.includes("cpu-usage")) return "cpu.usage_percent";
  if (id.includes("cpu-temperature")) return "cpu.temperature_celsius";
  if (id.includes("gpu-temperature")) return "gpu.temperature_celsius";
  if (id.includes("gpu-vram")) return "gpu.memory_utilization_percent";
  if (id.includes("ram")) return "memory.usage_percent";
  if (id.includes("disk-busy")) return "disk.busy_percent";
  if (id.includes("disk-queue")) return "disk.queue_depth";
  if (id.includes("disk-latency")) return "disk.average_latency_ms";
  if (id.includes("disk-throughput")) return "disk.total_MB_per_sec";
  if (id.includes("disk-capacity")) return "disk.mount_usage";
  if (id.includes("nic")) return "nic.total_errors";
  return null;
}

function metricImproved(fault, beforeMetrics, afterMetrics, beforeLh, afterLh) {
  const path = primaryMetricForFault(fault);
  if (!path) return false;
  const before = readMetricValue(path, beforeMetrics, beforeLh, fault);
  const after = readMetricValue(path, afterMetrics, afterLh, fault);
  if (before == null || after == null) return false;
  return after < before;
}

function metricsSnapshotFromBackend(backendMetrics, linkHealth) {
  if (!backendMetrics || typeof backendMetrics !== "object") return null;
  return snapshotMetrics(backendMetrics, linkHealth || {});
}

export async function analyzeRecovery(fault) {
  let inventory = {};
  let metrics = {};
  let linkHealth = {};
  const capabilities = await fetchRecoveryCapabilities();

  try {
    ({ inventory, metrics, linkHealth } = await fetchLinuxTelemetry());
  } catch {
    return {
      connected: false,
      capabilities,
      analysis: null,
      timeline: [createTimelineEvent("analysis_failed", "Unable to reach telemetry backend.")],
    };
  }

  const analysis = buildRecoveryAnalysis(fault, inventory, metrics, linkHealth, capabilities);
  const timeline = [
    createTimelineEvent("fault_detected", `${fault.component} fault under analysis`),
    createTimelineEvent(
      "telemetry_collected",
      `${analysis.evidence.items.length} evidence field(s) collected from live telemetry`
    ),
  ];

  if (analysis.rca.length > 0) {
    timeline.push(
      createTimelineEvent(
        "rca_generated",
        `${analysis.rca.length} root cause factor(s) identified from telemetry`
      )
    );
  }

  if (analysis.target?.process?.pid) {
    timeline.push(
      createTimelineEvent(
        "process_identified",
        "Process candidates available — review the Process Candidates table"
      )
    );
  }

  timeline.push(
    createTimelineEvent(
      "recommendation_generated",
      `${analysis.recommendations.length} recovery recommendation(s) generated`
    )
  );

  if (!capabilities.available) {
    timeline.push(
      createTimelineEvent(
        "capabilities_unavailable",
        "Recovery API not reachable — deploy CM.py with /recovery/capabilities on :5000"
      )
    );
  }

  return { connected: true, capabilities, analysis, timeline };
}

export async function executeApprovedRecovery(fault, recommendation, confirmation, callbacks = {}) {
  const { onTimelineUpdate, signal } = callbacks;
  const startedAt = Date.now();
  const timeline = [];
  const append = (type, message, detail) => {
    const ev = createTimelineEvent(type, message, detail);
    timeline.push(ev);
    onTimelineUpdate?.([...timeline]);
  };

  const action = getActionById(recommendation.actionId);
  if (!action) {
    return failResult("Unknown recovery action.", timeline, startedAt, fault, recommendation, null, null);
  }

  if (recommendation.disabled) {
    return failResult(
      recommendation.disabledReason || "Action not available.",
      timeline,
      startedAt,
      fault,
      recommendation,
      null,
      null
    );
  }

  const requiredLevel = recommendation.level ?? action.level;
  if (requiredLevel >= 2 && !confirmation?.confirmed) {
    return failResult("User confirmation required.", timeline, startedAt, fault, recommendation, null, null);
  }

  append("user_selected", `User selected "${recommendation.label}"`);
  if (confirmation?.confirmed) {
    append("user_confirmed", `User confirmed Level ${requiredLevel} action`);
  }

  let beforeSnapshot = null;
  let afterSnapshot = null;

  try {
    if (signal?.aborted) throw new Error("Recovery aborted by operator.");

    if (!recommendation.supported) {
      throw new Error(
        recommendation.disabledReason ||
          "Action not supported on this host. Check GET /recovery/capabilities on the telemetry server."
      );
    }

    append("command_executing", `Executing on Linux host: ${recommendation.backendAction}`);

    const commandResult = await executeRecoveryAction({
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
        level: requiredLevel,
        userAcknowledged: true,
        acknowledgedAt: new Date().toISOString(),
      },
    });

    append(
      commandResult.success ? "command_executed" : "command_failed",
      commandResult.message || (commandResult.success ? "Command completed" : "Command failed"),
      [commandResult.command, commandResult.output || commandResult.stdout, commandResult.stderr]
        .filter(Boolean)
        .join("\n") || null
    );

    if (!commandResult.success) {
      throw new Error(commandResult.message || commandResult.stderr || "Recovery command failed on host.");
    }

    beforeSnapshot =
      metricsSnapshotFromBackend(commandResult.beforeMetrics, {}) ||
      beforeSnapshot;
    afterSnapshot =
      metricsSnapshotFromBackend(commandResult.afterMetrics, {}) ||
      afterSnapshot;

    append("telemetry_refreshed", "Post-action telemetry captured by backend");

    let inventory;
    let metrics;
    let linkHealth;
    ({ inventory, metrics, linkHealth } = await fetchLinuxTelemetry());

    if (!beforeSnapshot) beforeSnapshot = snapshotMetrics(metrics, linkHealth);
    if (!afterSnapshot) afterSnapshot = snapshotMetrics(metrics, linkHealth);

    const verificationStatus = commandResult.verificationStatus;
    const stillActive = faultStillActive(fault, inventory, metrics, linkHealth);
    const improved = metricImproved(
      fault,
      commandResult.beforeMetrics || metrics,
      metrics,
      {},
      linkHealth
    );

    let outcome = "failed";
    let success = false;
    let verificationMessage;

    if (verificationStatus === "success" || (!stillActive && commandResult.success)) {
      outcome = "success";
      success = true;
      verificationMessage = "Fault condition cleared in live telemetry.";
      append("verification_complete", "Recovery successful — fault cleared");
    } else if (verificationStatus === "partial" || improved) {
      outcome = "partial";
      verificationMessage = "Primary metric improved but fault threshold may still be exceeded.";
      append("verification_complete", "Partially improved");
    } else {
      verificationMessage =
        commandResult.message ||
        "Command succeeded but fault condition persists in telemetry.";
      append("verification_complete", "Recovery failed — fault still active");
    }

    const durationMs = Date.now() - startedAt;
    const record = recordRecoveryExecution({
      faultId: fault.id,
      component: fault.component,
      metricName: fault.metricName,
      result: success ? "success" : outcome === "partial" ? "partial" : "failed",
      durationMs,
      selectedAction: {
        actionId: recommendation.actionId,
        label: recommendation.label,
        level: requiredLevel,
      },
      params: recommendation.params,
      confirmationGiven: confirmation?.confirmed ?? true,
      commandExecuted: commandResult.command || recommendation.backendAction,
      commandOutput: commandResult,
      verificationOutcome: verificationMessage,
      verificationStatus: verificationStatus || outcome,
      before: beforeSnapshot,
      after: afterSnapshot,
      timeline,
      reason: verificationMessage,
      timestamp: new Date().toISOString(),
    });

    return {
      success,
      partial: outcome === "partial",
      aborted: false,
      outcome,
      reason: verificationMessage,
      timeline,
      before: beforeSnapshot,
      after: afterSnapshot,
      durationMs,
      commandResult,
      record,
      actionsExecuted: [recommendation.label],
    };
  } catch (err) {
    append("command_failed", err.message || "Execution failed");
    let afterMetrics = null;
    try {
      const { metrics, linkHealth } = await fetchLinuxTelemetry();
      afterMetrics = snapshotMetrics(metrics, linkHealth);
    } catch {
      /* ignore */
    }
    const aborted = signal?.aborted || err.message?.includes("aborted");
    return failResult(
      err.message || "Recovery failed.",
      timeline,
      startedAt,
      fault,
      recommendation,
      beforeSnapshot,
      afterMetrics,
      null,
      aborted
    );
  }
}

function failResult(reason, timeline, startedAt, fault, recommendation, before, after, _extra, aborted = false) {
  const durationMs = Date.now() - startedAt;
  recordRecoveryExecution({
    faultId: fault.id,
    component: fault.component,
    metricName: fault.metricName,
    result: aborted ? "aborted" : "failed",
    durationMs,
    selectedAction: recommendation
      ? { actionId: recommendation.actionId, label: recommendation.label, level: recommendation.level }
      : null,
    params: recommendation?.params,
    confirmationGiven: false,
    commandExecuted: recommendation?.backendAction || null,
    verificationOutcome: reason,
    before,
    after,
    timeline,
    reason,
    timestamp: new Date().toISOString(),
  });

  return {
    success: false,
    partial: false,
    aborted,
    outcome: aborted ? "aborted" : "failed",
    reason,
    timeline,
    before,
    after,
    durationMs,
    actionsExecuted: recommendation ? [recommendation.label] : [],
  };
}

export async function buildRecoveryContext(fault) {
  const result = await analyzeRecovery(fault);
  if (!result.analysis) return null;
  return {
    ...result.analysis,
    connected: result.connected,
    planSteps: result.analysis.recommendations.map((r) => r.label),
    playbook: result.analysis.catalog,
  };
}
