/**
 * Recovery Recommendation Engine — maps fault + telemetry → ranked recommendations.
 */

import { getActionById } from "./recoveryActionCatalog";
import { getRecommendationCatalogForFault } from "./recoveryRecommendationCatalog";
import { isActionSupported } from "./recoveryApiService";
import { collectEvidence, getRecoveryTarget } from "./recoveryEvidence";
import { generateRootCauseAnalysis } from "./recoveryRca.js";
import { computeRecoveryConfidence } from "./recoveryConfidence.js";

function buildActionReason(action, fault, target, rca) {
  const proc = target?.process;
  if (action.requires?.process && proc?.pid) {
    const usage =
      proc.cpu != null
        ? `${proc.cpu}% CPU`
        : proc.gpuCompute != null
          ? `${proc.gpuCompute}% GPU`
          : proc.memory != null
            ? `${proc.memory}% MEM`
            : "";
    return `Process ${proc.name || "unknown"} (PID ${proc.pid})${usage ? ` using ${usage}` : ""} is the primary resource consumer contributing to this fault.`;
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
  if (fault.severity === "Warning" && action.level <= 2) score += 5;
  if (fault.severity === "Critical" && action.level === 1) score += 5;

  const itemCount = evidence?.items?.length || 0;
  if (itemCount >= 3) score += 5;

  return Math.max(0, Math.min(95, score));
}

function buildParams(action, target) {
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
  if (action.backendAction === "disk.identify_large_directories" && target?.mount) {
    params.path = target.mount;
  }
  return params;
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
  const target = getRecoveryTarget(fault, metrics, inventory);

  const recommendations = catalog.actionIds
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
          interface: target.interface ?? null,
          mount: target.mount ?? null,
          pcieSlot: target.pcieSlot ?? null,
        },
        params: buildParams(action, target),
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

  return recommendations.sort((a, b) => {
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
  const target = getRecoveryTarget(fault, metrics, inventory);
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
