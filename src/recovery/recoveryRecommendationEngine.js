/**
 * Recovery Recommendation Engine — maps fault + telemetry → ranked recommendations.
 */

import { getActionById } from "./recoveryActionCatalog";
import { getRecommendationCatalogForFault } from "./recoveryRecommendationCatalog";
import { isActionSupported } from "./recoveryApiService";
import { collectEvidence, getRecoveryTarget } from "./recoveryEvidence";
import { generateRootCauseAnalysis } from "./recoveryRca.js";
import { computeRecoveryConfidence } from "./recoveryConfidence.js";
import { isDiskHardwareFault, isDiskWorkloadFault, mountForFault } from "./diskRecoveryHelpers";

const NIC_PROCESS_ACTION_IDS = new Set([
  "nic.pause_process",
  "nic.resume_process",
  "nic.terminate_process",
]);

function resolveCatalogActionIds(fault, catalog, target) {
  if (!catalog) return [];
  if (fault?.id === "threshold-nic-utilization") {
    return catalog.actionIds.filter((id) => NIC_PROCESS_ACTION_IDS.has(id));
  }
  if (
    (fault?.id === "threshold-nic-errors" || fault?.id === "threshold-nic-lh-counters") &&
    target?.process?.pid
  ) {
    return catalog.actionIds.filter((id) => NIC_PROCESS_ACTION_IDS.has(id));
  }
  return catalog.actionIds;
}

function filterRecommendationsForFault(fault, recommendations, target) {
  const id = fault?.id || "";
  if (id === "threshold-nic-utilization") {
    return recommendations.filter((r) => NIC_PROCESS_ACTION_IDS.has(r.actionId));
  }
  if (
    (id === "threshold-nic-errors" || id === "threshold-nic-lh-counters") &&
    target?.process?.pid
  ) {
    return recommendations.filter((r) => NIC_PROCESS_ACTION_IDS.has(r.actionId));
  }
  return recommendations;
}

function buildActionReason(action, fault, target, rca) {
  const proc = target?.process;
  if (action.requires?.process && proc?.pid) {
    const usage =
      proc.ioTotalKbps != null
        ? `${proc.ioTotalKbps} KB/s total I/O`
        : proc.total_mbps != null
          ? `${proc.total_mbps} Mbps network`
          : proc.totalKbps != null
            ? `${proc.totalKbps} KB/s network`
            : proc.cpu != null
            ? `${proc.cpu}% CPU`
            : proc.gpuCompute != null
              ? `${proc.gpuCompute}% GPU`
              : proc.memory != null
                ? `${proc.memory}% MEM`
                : "";
    const verb =
      fault?.component === "DISK" && isDiskWorkloadFault(fault)
        ? "disk I/O consumer"
        : fault?.component === "NIC"
          ? "network bandwidth consumer"
          : "primary resource consumer";
    return `Process ${proc.name || "unknown"} (PID ${proc.pid})${usage ? ` using ${usage}` : ""} is the ${verb} contributing to this fault.`;
  }
  if (action.requires?.interface && target?.interface) {
    return `Network interface ${target.interface} is associated with this connectivity fault.`;
  }
  if (action.requires?.mount && target?.mount) {
    return `Mount ${target.mount} is above capacity threshold.`;
  }
  if (rca?.length) return rca[0];
  return `Recommended for ${fault.component} ${fault.metricName || "fault"} based on live telemetry.`;
}

function scoreRecommendation(action, fault, target, evidence) {
  let score = 50;
  if (action.level === 1) score += 25;
  else if (action.level === 2) score += 10;
  else score -= 10;

  if (action.requires?.process && target?.process?.pid) score += 15;
  if (action.requires?.process && target?.process?.ioTotalKbps != null) score += 10;
  if (action.requires?.process && target?.process?.total_mbps != null) score += 10;
  if (fault.severity === "Warning" && action.level <= 2) score += 5;
  if (fault.severity === "Critical" && action.level === 1) score += 5;

  const itemCount = evidence?.items?.length || 0;
  if (itemCount >= 3) score += 5;

  return Math.max(0, Math.min(95, score));
}

function buildParams(action, target, fault, metrics) {
  const params = { ...(action.defaultParams || {}) };
  if (action.requires?.process && target?.process?.pid) {
    params.pid = target.process.pid;
  }
  if (action.requires?.interface && target?.interface) {
    params.interface = target.interface;
  }
  if (action.requires?.service && target?.service) {
    params.unit = target.service;
  }
  if (action.requires?.slot && target?.pcieSlot) {
    params.slot = target.pcieSlot;
  }
  if (action.backendAction === "disk.identify_large_directories") {
    if (target?.mount) params.path = target.mount;
    else {
      const mountRow = mountForFault(fault, metrics);
      if (mountRow?.mountpoint || mountRow?.mount) {
        params.path = mountRow.mountpoint || mountRow.mount;
      }
    }
  }
  return params;
}

function buildDiskAdvisoryRecommendations(fault, rca) {
  const id = fault?.id || "";
  if (!isDiskHardwareFault(fault) && !id.includes("disk-capacity")) return [];

  const primary = rca[0] || "Live telemetry indicates elevated disk risk.";
  const advisory = [];

  if (id.includes("disk-smart") || id.includes("disk-nvme-errors")) {
    advisory.push(
      {
        actionId: "advisory.disk-backup",
        backendAction: null,
        label: "Backup data immediately",
        level: 1,
        impact: "Copy critical data off the affected drive before failure.",
        reason: primary,
        target: {},
        params: {},
        supported: false,
        requirementsMet: true,
        disabled: true,
        disabledReason: "Manual operator action — schedule backup before drive replacement.",
        confidence: 88,
      },
      {
        actionId: "advisory.disk-replace",
        backendAction: null,
        label: "Replace storage device",
        level: 3,
        impact: "Plan drive replacement after backup; hardware fault cannot be cleared by software.",
        reason: rca[1] || primary,
        target: {},
        params: {},
        supported: false,
        requirementsMet: true,
        disabled: true,
        disabledReason: "Hardware replacement required — escalate to datacenter operations.",
        confidence: 85,
      }
    );
  }

  if (id.includes("disk-nvme-wear")) {
    advisory.push({
      actionId: "advisory.disk-wear",
      backendAction: null,
      label: "Plan drive replacement",
      level: 2,
      impact: "NVMe endurance threshold exceeded — migrate workloads and replace media.",
      reason: primary,
      target: {},
      params: {},
      supported: false,
      requirementsMet: true,
      disabled: true,
      disabledReason: "Wear-out fault — replacement scheduling required.",
      confidence: 82,
    });
  }

  if (id.includes("disk-sata")) {
    advisory.push({
      actionId: "advisory.disk-sata",
      backendAction: null,
      label: "Escalate SATA link degradation",
      level: 2,
      impact: "Check cabling, backplane, and controller; link may retrain after physical inspection.",
      reason: primary,
      target: {},
      params: {},
      supported: false,
      requirementsMet: true,
      disabled: true,
      disabledReason: "Link-layer fault — inspect hardware connections.",
      confidence: 70,
    });
  }

  if (id.includes("disk-capacity")) {
    advisory.push({
      actionId: "advisory.disk-capacity",
      backendAction: null,
      label: "Free storage on affected mount",
      level: 1,
      impact: "Archive logs, remove stale data, or expand volume capacity.",
      reason: primary,
      target: {},
      params: {},
      supported: false,
      requirementsMet: true,
      disabled: true,
      disabledReason: "Use automated cleanup actions below or operator-driven archival.",
      confidence: 75,
    });
  }

  return advisory;
}

function meetsRequirements(action, target) {
  if (action.requires?.process && !target?.process?.pid) return false;
  if (action.requires?.interface && !target?.interface) return false;
  if (action.requires?.service && !target?.service) return false;
  if (action.requires?.slot && !target?.pcieSlot) return false;
  return true;
}

function capabilityEntry(capabilities, backendAction) {
  return (capabilities?.actions || []).find((a) => a.key === backendAction) || null;
}

/**
 * @param {object} fault
 * @param {object} inventory
 * @param {object} metrics
 * @param {object} linkHealth
 * @param {{ available: boolean, actions: object[] }} capabilities
 */
export function generateRecommendations(fault, inventory, metrics, linkHealth, capabilities) {
  const catalog = getRecommendationCatalogForFault(fault);
  if (!catalog) return [];

  const evidence = collectEvidence(fault, inventory, metrics, linkHealth);
  const rca = generateRootCauseAnalysis(fault, evidence, metrics, linkHealth);
  const target = getRecoveryTarget(fault, metrics, inventory, linkHealth);
  const actionIds = resolveCatalogActionIds(fault, catalog, target);

  const actionRecommendations = actionIds
    .map((actionId) => {
      const action = getActionById(actionId);
      if (!action) return null;

      const requirementsMet = meetsRequirements(action, target);
      const cap = capabilityEntry(capabilities, action.backendAction);
      const supported = isActionSupported(capabilities, action.backendAction);

      return {
        actionId: action.id,
        backendAction: action.backendAction,
        label: action.label,
        level: cap?.level ?? action.level,
        impact: action.impact,
        reason: buildActionReason(action, fault, target, rca),
        target: {
          pid: target.process?.pid ?? null,
          processName: target.process?.name ?? null,
          processCpu: target.process?.cpu ?? null,
          processMemory: target.process?.memory ?? null,
          processGpu: target.process?.gpuCompute ?? null,
          processIo: target.process?.ioTotalKbps ?? null,
          interface: target.interface ?? null,
          mount: target.mount ?? null,
          pcieSlot: target.pcieSlot ?? null,
        },
        params: buildParams(action, target, fault, metrics),
        supported,
        requirementsMet,
        disabled: !requirementsMet || !supported,
        disabledReason: !requirementsMet
          ? "Required telemetry not available (e.g. process PID, interface, or PCI slot)."
          : !supported
            ? cap?.reason ||
              (capabilities.available
                ? "Not supported on this host."
                : "Recovery API unavailable — ensure CM.py exposes /recovery/capabilities on :5000.")
            : null,
        confidence: scoreRecommendation(action, fault, target, evidence),
      };
    })
    .filter(Boolean);

  const recommendations = filterRecommendationsForFault(
    fault,
    [...buildDiskAdvisoryRecommendations(fault, rca), ...actionRecommendations],
    target
  );

  return recommendations.sort((a, b) => {
    const aAdv = String(a.actionId).startsWith("advisory.");
    const bAdv = String(b.actionId).startsWith("advisory.");
    if (aAdv !== bAdv) return aAdv ? -1 : 1;
    if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
    if (a.level !== b.level) return a.level - b.level;
    return b.confidence - a.confidence;
  });
}

/**
 * @param {object} fault
 * @param {object} inventory
 * @param {object} metrics
 * @param {object} linkHealth
 * @param {{ available: boolean, actions: object[] }} capabilities
 */
export function buildRecoveryAnalysis(fault, inventory, metrics, linkHealth, capabilities) {
  const catalog = getRecommendationCatalogForFault(fault);
  const evidence = collectEvidence(fault, inventory, metrics, linkHealth);
  const rca = generateRootCauseAnalysis(fault, evidence, metrics, linkHealth);
  const target = getRecoveryTarget(fault, metrics, inventory, linkHealth);
  const recommendations = generateRecommendations(
    fault,
    inventory,
    metrics,
    linkHealth,
    capabilities
  );
  const confidence = computeRecoveryConfidence(fault, evidence, catalog ? { id: catalog.id, steps: [] } : null);

  return {
    catalog,
    evidence,
    rca,
    target,
    recommendations,
    confidence,
    capabilitiesAvailable: capabilities.available,
  };
}
