/**
 * Maps fault patterns to candidate recovery action IDs (CM.py keys).
 */

export const RECOMMENDATION_CATALOG = [
  {
    id: "cpu-load",
    label: "CPU Load Recovery",
    match: (f) => f.id === "threshold-cpu-usage",
    actionIds: [
      "cpu.renice",
      "cpu.pause_process",
      "cpu.terminate_process",
      "cpu.kill_process",
      "cpu.restart_service",
    ],
  },
  {
    id: "cpu-thermal",
    label: "CPU Thermal Recovery",
    match: (f) => f.id === "threshold-cpu-temperature" || f.id === "threshold-cpu-thermal-throttle",
    actionIds: [
      "cpu.renice",
      "cpu.pause_process",
      "cpu.terminate_process",
      "cpu.kill_process",
    ],
  },
  {
    id: "gpu-thermal",
    label: "GPU Thermal Recovery",
    match: (f) => f.id?.startsWith("threshold-gpu-temperature"),
    actionIds: [
      "gpu.pause_process",
      "gpu.terminate_process",
      "gpu.restart_persistence_daemon",
      "gpu.reset",
    ],
  },
  {
    id: "gpu-vram",
    label: "GPU VRAM Recovery",
    match: (f) => f.id === "threshold-gpu-vram",
    actionIds: ["gpu.pause_process", "gpu.terminate_process", "gpu.reset"],
  },
  {
    id: "gpu-pcie",
    label: "GPU PCIe Recovery",
    match: (f) => f.id === "threshold-gpu-pcie-link",
    actionIds: ["pcie.rescan", "pcie.reload_driver", "gpu.reset"],
  },
  {
    id: "ram-pressure",
    label: "Memory Pressure Recovery",
    match: (f) => f.id === "threshold-ram-usage" || f.id === "threshold-ram-swap",
    actionIds: [
      "ram.drop_caches",
      "ram.pause_process",
      "ram.terminate_process",
      "ram.restart_service",
    ],
  },
  {
    id: "disk-capacity",
    label: "Disk Capacity Recovery",
    match: (f) => f.id?.startsWith("threshold-disk-capacity"),
    actionIds: [
      "disk.identify_large_directories",
      "disk.clean_temp_files",
      "disk.vacuum_journal",
    ],
  },
  {
    id: "nic-errors",
    label: "NIC Error Recovery",
    match: (f) => f.id === "threshold-nic-errors" || f.id === "threshold-nic-lh-counters",
    actionIds: [
      "nic.restart_interface",
      "nic.reload_driver",
      "nic.restart_network_manager",
    ],
  },
  {
    id: "nic-connectivity",
    label: "Network Connectivity Recovery",
    match: (f) => f.id === "threshold-nic-connectivity" || f.id === "threshold-nic-link-down",
    actionIds: [
      "nic.restart_interface",
      "nic.renew_dhcp",
      "nic.restart_network_manager",
      "nic.reload_driver",
    ],
  },
  {
    id: "io-pcie",
    label: "PCIe Link Recovery",
    match: (f) =>
      f.id?.startsWith("threshold-io-pcie") ||
      f.id === "threshold-io-mb-pcie-crit" ||
      f.component === "IO Control",
    actionIds: ["pcie.rescan", "pcie.reload_driver"],
  },
];

export function getRecommendationCatalogForFault(fault) {
  if (!fault || fault.severity === "Resolved") return null;
  return RECOMMENDATION_CATALOG.find((c) => c.match(fault)) || null;
}

export function hasRecoveryRecommendations(fault) {
  return getRecommendationCatalogForFault(fault) != null;
}
