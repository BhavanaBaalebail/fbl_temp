/**
 * Autonomous Recovery Engine
 * Orchestrates telemetry-driven recovery: evidence → safety → monitor → verify.
 * Does not execute unsupported shell commands or fabricate hardware actions.
 */

import { fetchLinuxTelemetry } from "../services/linuxMetricsService";
import { buildThresholdFaults } from "../services/linkHealthService";
import { getPlaybookForFault } from "./recoveryPlaybooks";
import {
  collectEvidence,
  readMetricValue,
  snapshotMetrics,
} from "./recoveryEvidence";
import { recordRecoveryExecution } from "./recoveryHistoryService";
import { generateRootCauseAnalysis } from "./recoveryRca.js";
import { computeRecoveryConfidence } from "./recoveryConfidence.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const RECOVERY_PHASES = [
  { id: "collect", label: "Collecting Evidence" },
  { id: "safety", label: "Validating Safety Checks" },
  { id: "execute", label: "Executing Recovery" },
  { id: "verify", label: "Verifying Hardware State" },
  { id: "complete", label: "Complete" },
];

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

function runSafetyChecks(fault, metrics, linkHealth, baselineSnapshot) {
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
    issues.push("SMART disk failure detected on another component — aborting.");
  }

  const otherCritical = buildThresholdFaults(linkHealth, {}, metrics).filter(
    (f) => f.severity === "Critical" && f.id !== fault.id
  );
  if (otherCritical.length >= 2) {
    issues.push(`${otherCritical.length} other critical faults active — aborting for safety.`);
  }

  return { passed: issues.length === 0, issues };
}

async function fetchTelemetry() {
  const data = await fetchLinuxTelemetry();
  return data;
}

/**
 * @param {object} fault
 * @param {{ onPhaseUpdate: Function, onStepUpdate: Function, signal: AbortSignal }} callbacks
 */
export async function executeRecovery(fault, callbacks = {}) {
  const { onPhaseUpdate, onStepUpdate, signal } = callbacks;
  const playbook = getPlaybookForFault(fault);
  const startedAt = Date.now();
  const actionsExecuted = [];
  const timeline = RECOVERY_PHASES.map((p) => ({ ...p, status: "pending" }));
  const stepResults = [];

  if (!playbook) {
    return {
      success: false,
      aborted: false,
      reason: "No recovery playbook available for this fault.",
      timeline,
      stepResults,
      before: null,
      after: null,
    };
  }

  let beforeSnapshot = null;
  let afterSnapshot = null;
  let inventory;
  let metrics;
  let linkHealth;
  let evidence;

  const setPhase = (id, status) => {
    const idx = timeline.findIndex((p) => p.id === id);
    if (idx >= 0) timeline[idx].status = status;
    onPhaseUpdate?.([...timeline]);
  };

  const checkAbort = () => {
    if (signal?.aborted) throw new Error("Recovery aborted by operator.");
  };

  try {
    setPhase("collect", "running");
    checkAbort();
    ({ inventory, metrics, linkHealth } = await fetchTelemetry());
    evidence = collectEvidence(fault, inventory, metrics, linkHealth);
    beforeSnapshot = snapshotMetrics(metrics, linkHealth);
    stepResults.push({ step: "Collect baseline telemetry", status: "success" });
    setPhase("collect", "done");

    setPhase("safety", "running");
    checkAbort();
    const safety = runSafetyChecks(fault, metrics, linkHealth, beforeSnapshot);
    if (!safety.passed) {
      setPhase("safety", "failed");
      setPhase("execute", "skipped");
      setPhase("verify", "skipped");
      setPhase("complete", "done");
      return finalize(false, false, safety.issues.join(" "), startedAt, fault, playbook, actionsExecuted, timeline, stepResults, beforeSnapshot, afterSnapshot);
    }
    stepResults.push({ step: "Safety validation", status: "success" });
    setPhase("safety", "done");

    setPhase("execute", "running");
    checkAbort();

    for (const step of playbook.steps) {
      checkAbort();
      onStepUpdate?.({ step, status: "running" });

      if (step.type === "collect_evidence") {
        stepResults.push({ step: step.label, status: "success" });
        actionsExecuted.push(step.label);
        continue;
      }

      if (step.type === "safety_check") {
        const s = runSafetyChecks(fault, metrics, linkHealth, beforeSnapshot);
        if (!s.passed) {
          stepResults.push({ step: step.label, status: "failed", detail: s.issues.join(" ") });
          throw new Error(s.issues.join(" "));
        }
        stepResults.push({ step: step.label, status: "success" });
        actionsExecuted.push(step.label);
        continue;
      }

      if (step.type === "identify_workload") {
        const workload = evidence.items.find((i) => i.label.includes("Process"));
        stepResults.push({
          step: step.label,
          status: workload ? "success" : "skipped",
          detail: workload?.value || "top_processes data not available from backend",
        });
        if (workload) actionsExecuted.push(`${step.label}: ${workload.value}`);
        continue;
      }

      if (step.type === "monitor_metric") {
        const readings = [];
        let worsened = false;
        let prev = readMetricValue(step.metric, metrics, linkHealth, fault);

        for (let i = 0; i < (step.polls || 3); i += 1) {
          checkAbort();
          await sleep(step.intervalMs || 5000);
          ({ inventory, metrics, linkHealth } = await fetchTelemetry());
          const cur = readMetricValue(step.metric, metrics, linkHealth, fault);
          if (cur != null) readings.push(cur);

          if (
            step.abortIfWorsening &&
            prev != null &&
            cur != null &&
            cur > prev * 1.1 &&
            step.metric.includes("temp")
          ) {
            worsened = true;
            break;
          }
          if (
            step.abortIfWorsening &&
            prev != null &&
            cur != null &&
            cur > prev + 5 &&
            (step.metric.includes("usage") || step.metric.includes("errors"))
          ) {
            worsened = true;
            break;
          }
          prev = cur;
        }

        if (worsened) {
          stepResults.push({
            step: step.label,
            status: "failed",
            detail: `Metric ${step.metric} worsened during monitoring — recovery aborted.`,
            readings,
          });
          throw new Error("Conditions worsened during monitoring — recovery aborted.");
        }

        stepResults.push({
          step: step.label,
          status: "success",
          detail: readings.length ? `Readings: ${readings.join(" → ")}` : "No numeric readings available",
          readings,
        });
        actionsExecuted.push(step.label);
        continue;
      }

      if (step.type === "verify_fault_cleared") {
        ({ inventory, metrics, linkHealth } = await fetchTelemetry());
        afterSnapshot = snapshotMetrics(metrics, linkHealth);
        const stillActive = faultStillActive(fault, inventory, metrics, linkHealth);
        stepResults.push({
          step: step.label,
          status: stillActive ? "failed" : "success",
          detail: stillActive ? "Fault condition still present in live telemetry" : "Fault cleared in live telemetry",
        });
        actionsExecuted.push(step.label);
        if (stillActive) {
          throw new Error("Verification failed — fault condition still active.");
        }
        continue;
      }
    }

    setPhase("execute", "done");

    setPhase("verify", "running");
    checkAbort();
    if (!afterSnapshot) {
      ({ inventory, metrics, linkHealth } = await fetchTelemetry());
      afterSnapshot = snapshotMetrics(metrics, linkHealth);
    }
    const cleared = !faultStillActive(fault, inventory, metrics, linkHealth);
    setPhase("verify", cleared ? "done" : "failed");
    setPhase("complete", "done");

    return finalize(
      cleared,
      false,
      cleared ? "Fault condition cleared — system returned to healthy state." : "Fault condition persists after recovery workflow.",
      startedAt,
      fault,
      playbook,
      actionsExecuted,
      timeline,
      stepResults,
      beforeSnapshot,
      afterSnapshot
    );
  } catch (err) {
    setPhase("execute", timeline.find((p) => p.id === "execute")?.status === "running" ? "failed" : timeline.find((p) => p.id === "execute")?.status);
    setPhase("verify", "failed");
    setPhase("complete", "done");

    try {
      ({ inventory, metrics, linkHealth } = await fetchTelemetry());
      afterSnapshot = snapshotMetrics(metrics, linkHealth);
    } catch {
      /* keep partial after */
    }

    const aborted = signal?.aborted || err.message.includes("aborted");
    return finalize(
      false,
      aborted,
      err.message || "Recovery failed.",
      startedAt,
      fault,
      playbook,
      actionsExecuted,
      timeline,
      stepResults,
      beforeSnapshot,
      afterSnapshot
    );
  }
}

function finalize(
  success,
  aborted,
  reason,
  startedAt,
  fault,
  playbook,
  actionsExecuted,
  timeline,
  stepResults,
  before,
  after
) {
  const durationMs = Date.now() - startedAt;
  const record = {
    faultId: fault.id,
    component: fault.component,
    metricName: fault.metricName,
    playbookId: playbook.id,
    result: success ? "success" : aborted ? "aborted" : "failed",
    durationMs,
    actionsExecuted,
    verificationOutcome: success ? "Fault cleared" : reason,
    before,
    after,
    reason,
    timestamp: new Date().toISOString(),
  };

  recordRecoveryExecution(record);

  return {
    success,
    aborted,
    reason,
    timeline,
    stepResults,
    actionsExecuted,
    before,
    after,
    durationMs,
    record,
  };
}

/**
 * Build recovery context for display (no execution).
 */
export async function buildRecoveryContext(fault) {
  const playbook = getPlaybookForFault(fault);
  if (!playbook) return null;

  let inventory = {};
  let metrics = {};
  let linkHealth = {};
  try {
    ({ inventory, metrics, linkHealth } = await fetchLinuxTelemetry());
  } catch {
    return { playbook, evidence: { items: [] }, rca: [], confidence: { percent: 0, label: "Not Available", factors: [] }, connected: false };
  }

  const evidence = collectEvidence(fault, inventory, metrics, linkHealth);
  const rca = generateRootCauseAnalysis(fault, evidence, metrics, linkHealth);
  const confidence = computeRecoveryConfidence(fault, evidence, playbook);

  return {
    playbook,
    evidence,
    rca,
    confidence,
    connected: true,
    planSteps: playbook.steps.map((s) => s.label),
  };
}
