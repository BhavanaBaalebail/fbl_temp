/**
 * Recovery confidence scoring based on available evidence.
 */

import { hasRecoveryPlaybook } from "./recoveryPlaybooks";
import { isDiskHardwareFault, isDiskWorkloadFault } from "./diskRecoveryHelpers";

/**
 * @returns {{ percent: number, label: string, factors: string[] }}
 */
export function computeRecoveryConfidence(fault, evidence, playbook) {
  if (!playbook) {
    return { percent: 0, label: "Not Available", factors: ["No automated recovery playbook for this fault type."] };
  }

  let score = 35;
  const factors = [];

  const items = evidence?.items || [];
  if (items.length >= 3) {
    score += 15;
    factors.push(`${items.length} telemetry evidence fields available.`);
  } else if (items.length >= 1) {
    score += 8;
    factors.push("Limited telemetry evidence available.");
  } else {
    factors.push("Insufficient telemetry for high-confidence recovery.");
  }

  if (fault.source === "threshold") {
    score += 20;
    factors.push("Threshold fault with verifiable clearance criteria.");
  }

  const id = fault.id || "";

  const nonRecoverable = [
    "fatal-errors",
    "uncorrectable",
    "cpu-fatal",
  ];
  if (
    nonRecoverable.some((p) => id.includes(p)) ||
    (id.includes("smart-") && !id.includes("disk-smart")) ||
    (id.includes("nvme-errors") && !id.includes("disk-nvme"))
  ) {
    score = Math.min(score, 25);
    factors.push("Hardware error class — automated recovery unlikely.");
  }

  if (isDiskHardwareFault(fault)) {
    score = Math.min(score, 30);
    factors.push("Hardware disk fault — automated recovery limited to diagnostics and escalation.");
  } else if (id.includes("disk-capacity")) {
    score += 5;
    factors.push("Capacity fault — cleanup actions may restore headroom.");
  }

  if (isDiskWorkloadFault(fault)) {
    score += 10;
    factors.push("Disk workload fault — process throttling can reduce I/O pressure.");
    if (items.some((i) => i.label === "Top Disk I/O Process")) {
      score += 10;
      factors.push("Top disk I/O process identified from live telemetry.");
    }
  }

  if (id.includes("gpu") && !id.includes("pcie")) {
    score += 10;
    factors.push("GPU workload fault — process control can reduce GPU pressure.");
    if (items.some((i) => i.label === "Top GPU Process")) {
      score += 10;
      factors.push("Top GPU process identified from live nvidia-smi telemetry.");
    }
  }

  if (id.includes("nic")) {
    score += 10;
    factors.push("NIC workload fault — process control and interface actions can reduce network pressure.");
    if (items.some((i) => i.label === "Top Network Process")) {
      score += 10;
      factors.push("Top network process identified from live nethogs telemetry.");
    }
    if (items.some((i) => i.label === "Primary Interface")) {
      score += 5;
      factors.push("Primary interface telemetry available for targeted recovery.");
    }
  }

  if (fault.severity === "Warning") {
    score += 10;
    factors.push("Warning severity — higher probability of transient condition.");
  } else if (fault.severity === "Critical") {
    score -= 5;
    factors.push("Critical severity — recovery success less certain.");
  }

  const hasWorkload = items.some((i) => i.label.includes("Process"));
  if (hasWorkload) {
    score += 10;
    factors.push("Process attribution available from top_processes metrics.");
  }

  const hasMonitor = playbook.steps?.some((s) => s.type === "monitor_metric");
  if (hasMonitor) {
    score += 10;
    factors.push("Trend monitoring step included for verification.");
  }

  score = Math.max(0, Math.min(95, Math.round(score)));

  let label = "Low";
  if (score >= 75) label = "High";
  else if (score >= 50) label = "Moderate";

  if (!hasRecoveryPlaybook(fault)) {
    return { percent: 0, label: "Not Available", factors: ["Recovery playbook not matched."] };
  }

  return { percent: score, label, factors };
}
