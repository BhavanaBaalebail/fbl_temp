/**
 * Helper Utilities
 * Common utility functions used across the application
 */

import { viz } from "./theme";

/**
 * Determines the color of a bus line based on the link ID
 * @param {string} linkId - The link identifier
 * @returns {string} The color code for the bus line
 */
export function busLineColor(linkId) {
  if (linkId === "IO Controller" || linkId === "DISK" || linkId === "NIC") return viz.lineSecondary;
  return viz.lineMajor;
}

const LEVEL_PRIORITY = {
  critical: 3,
  warning: 2,
  healthy: 1,
  unknown: 0,
};

const TOPOLOGY_TO_HEALTH = {
  "IO Controller": "IO Control",
};

export const HEALTH_COLORS = {
  healthy: "#4D9FFF",
  warning: "#FF9800",
  critical: "#B71C1C",
  unknown: "#95A7C7",
};

function normalizeComponentKey(id) {
  return TOPOLOGY_TO_HEALTH[id] || id;
}

export function getComponentHealthLevel(componentId, componentHealth) {
  if (!componentHealth || Object.keys(componentHealth).length === 0) {
    return "healthy";
  }
  const key = normalizeComponentKey(componentId);
  return componentHealth[key] || "unknown";
}

/**
 * Build a lookup map from buildHealthRows() output.
 * @param {Array<{ name: string, level: string }>} healthRows
 */
export function buildComponentHealthMap(healthRows) {
  const map = {};
  (healthRows || []).forEach((row) => {
    map[row.name] = row.level;
  });
  return map;
}

export function worstHealthLevel(...levels) {
  return levels.reduce((worst, current) => {
    const level = current || "unknown";
    return (LEVEL_PRIORITY[level] ?? 0) > (LEVEL_PRIORITY[worst] ?? 0)
      ? level
      : worst;
  }, "unknown");
}

export function getConnectionColor(level) {
  return HEALTH_COLORS[level] || HEALTH_COLORS.unknown;
}

export function getNodeStrokeColor(componentId, componentHealth) {
  return getConnectionColor(getComponentHealthLevel(componentId, componentHealth));
}

export function getNodeFill(componentId, componentHealth, variant = "peripheral") {
  const level = getComponentHealthLevel(componentId, componentHealth);

  if (level === "healthy") {
    return variant === "center" ? "url(#centerNavyGrad)" : "url(#peripheralCardGrad)";
  }
  if (level === "unknown") {
    return variant === "center" ? "url(#centerNavyGrad)" : "url(#peripheralCardGrad)";
  }
  if (level === "critical") {
    return variant === "center" ? HEALTH_COLORS.critical : "rgba(239, 68, 68, 0.15)";
  }
  if (level === "warning") {
    return variant === "center" ? "#E65100" : "rgba(245, 158, 11, 0.12)";
  }
  return variant === "center" ? "url(#centerNavyGrad)" : "url(#peripheralCardGrad)";
}

/**
 * Resolve SVG path stroke from center + peripheral component health.
 * Priority: critical > warning > healthy > unknown.
 */
export function resolveLinkStrokeColor(centerComponentId, linkId, componentHealth) {
  if (!componentHealth || Object.keys(componentHealth).length === 0) {
    return busLineColor(linkId);
  }
  const centerKey = normalizeComponentKey(centerComponentId);
  const linkKey = normalizeComponentKey(linkId);
  const centerLevel = componentHealth[centerKey] || "unknown";
  const linkLevel = componentHealth[linkKey] || "unknown";
  return getConnectionColor(worstHealthLevel(centerLevel, linkLevel));
}

/**
 * Returns status pill styling based on status type
 * @param {string} status - The status value (ACTIVE, MONITOR, or CLEAR)
 * @returns {object} Object with bg, text, and border colors
 */
export function statusPillTone(status) {
  if (status === "ACTIVE") {
    return { bg: "rgba(239,68,68,0.12)", text: "#ef4444", border: "rgba(239,68,68,0.35)" };
  }
  if (status === "MONITOR") {
    return { bg: "rgba(245,158,11,0.12)", text: "#f59e0b", border: "rgba(245,158,11,0.35)" };
  }
  return { bg: "rgba(16,185,129,0.12)", text: "#10b981", border: "rgba(16,185,129,0.35)" };
}

export function cardStatusTone(status) {
  if (status === "WARNING") return { bg: "rgba(245,158,11,0.2)", text: "#fbbf24", accent: "#f59e0b" };
  if (status === "CRITICAL") return { bg: "rgba(239,68,68,0.2)", text: "#fca5a5", accent: "#ef4444" };
  if (status === "RESOLVED") return { bg: "rgba(16,185,129,0.2)", text: "#6ee7b7", accent: "#10b981" };
  return { bg: "rgba(34,211,238,0.08)", text: "#94a3b8", accent: "#22d3ee" };
}

/**
 * Gets center node information based on component type
 * @param {object} flags - Object with boolean flags for each component
 * @returns {object} Object with label and subtitle
 */
export function getCenterNodeInfo(flags) {
  const { showingIOCTRL, showingNIC, showingDISK, showingRAM, showingGPU } = flags;

  if (showingIOCTRL) {
    return { label: "IO Controller", subtitle: "Platform Controller Hub" };
  }
  if (showingNIC) {
    return { label: "NIC", subtitle: "Network Interface Card" };
  }
  if (showingDISK) {
    return { label: "DISK", subtitle: "Storage SSD / NVMe / HDD" };
  }
  if (showingRAM) {
    return { label: "RAM", subtitle: "DDR5 / DDR4 Memory" };
  }
  if (showingGPU) {
    return { label: "GPU", subtitle: "Graphics Processing Unit" };
  }
  return { label: "CPU", subtitle: "Central Processing Unit" };
}

/**
 * Gets the map name/title based on the selected component
 * @param {object} flags - Object with boolean flags for each component
 * @returns {string} The display name for the connectivity map
 */
export function getMapName(flags) {
  const { showingIOCTRL, showingNIC, showingDISK, showingRAM, showingGPU } = flags;

  if (showingIOCTRL) return "IO CONTROLLER";
  if (showingNIC) return "NIC";
  if (showingDISK) return "DISK";
  if (showingRAM) return "RAM";
  if (showingGPU) return "GPU";
  return "CPU";
}

/**
 * Gets the subtitle for the connectivity map based on the selected component
 * @param {object} flags - Object with boolean flags for each component
 * @returns {string} The subtitle for the connectivity map
 */
export function getMapSubtitle(flags) {
  const { showingIOCTRL, showingNIC, showingDISK, showingRAM, showingGPU } = flags;

  if (showingIOCTRL) return "I/O Controller — Block I/O, PCIe / Chipset Interconnects & Port Mapping";
  if (showingNIC) return "Network Interface Card — Physical Interconnects & Port Mapping";
  if (showingDISK) return "Storage (SSD / NVMe / HDD) — Physical Interconnects & Port Mapping";
  if (showingRAM) return "Memory Module — Physical Interconnects & Port Mapping";
  if (showingGPU) return "Graphics Processing Unit — Physical Interconnects & Port Mapping";
  return "Realistic Server Hardware Architecture — Physical Interconnects";
}
