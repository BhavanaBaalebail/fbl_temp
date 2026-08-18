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
    match: (f) => f.id === "threshold-cpu-temperature",
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
      "gpu.resume_process",
      "gpu.terminate_process",
      "gpu.restart_persistence_daemon",
      "gpu.reset",
    ],
  },
  {
    id: "gpu-utilization",
    label: "GPU Utilization Recovery",
    match: (f) => f.id === "threshold-gpu-utilization",
    actionIds: [
      "gpu.pause_process",
      "gpu.resume_process",
      "gpu.terminate_process",
      "gpu.reset",
    ],
  },
  {
    id: "gpu-vram",
    label: "GPU VRAM Recovery",
    match: (f) => f.id === "threshold-gpu-vram",
    actionIds: [
      "gpu.pause_process",
      "gpu.resume_process",
      "gpu.terminate_process",
      "gpu.reset",
    ],
  },
  {
    id: "gpu-power",
    label: "GPU Power Recovery",
    match: (f) => f.id === "threshold-gpu-power",
    actionIds: [
      "gpu.pause_process",
      "gpu.resume_process",
      "gpu.terminate_process",
      "gpu.restart_persistence_daemon",
    ],
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
    id: "io-workload",
    label: "I/O Workload Recovery",
    // Match workload IDs only (before io-pcie). Use disk.* actions — already
    // registered on CM.py /recovery/capabilities (SIGSTOP/CONT/TERM).
    match: (f) =>
      f.id?.startsWith("threshold-io-busy-") ||
      f.id?.startsWith("threshold-io-queue-") ||
      f.id?.startsWith("threshold-io-latency-") ||
      f.id?.startsWith("threshold-io-throughput-"),
    actionIds: ["disk.pause_process", "disk.resume_process", "disk.terminate_process"],
  },
  {
    id: "io-workload",
    label: "I/O Workload Recovery",
    // Match workload IDs only (before io-pcie). Use disk.* actions — already
    // registered on CM.py /recovery/capabilities (SIGSTOP/CONT/TERM).
    match: (f) =>
      f.id?.startsWith("threshold-io-busy-") ||
      f.id?.startsWith("threshold-io-queue-") ||
      f.id?.startsWith("threshold-io-latency-") ||
      f.id?.startsWith("threshold-io-throughput-"),
    actionIds: ["disk.pause_process", "disk.resume_process", "disk.terminate_process"],
  },
  {
    id: "disk-workload",
    label: "Disk Workload Recovery",
    match: (f) =>
      f.id?.startsWith("threshold-disk-busy-") ||
      f.id?.startsWith("threshold-disk-queue-") ||
      f.id?.startsWith("threshold-disk-latency-") ||
      f.id?.startsWith("threshold-disk-throughput-"),
    actionIds: ["disk.pause_process", "disk.resume_process", "disk.terminate_process"],
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
    id: "disk-smart",
    label: "Disk SMART Recovery",
    match: (f) => f.id?.startsWith("threshold-disk-smart-"),
    actionIds: ["disk.identify_large_directories"],
  },
  {
    id: "disk-nvme-health",
    label: "NVMe Health Recovery",
    match: (f) =>
      f.id?.startsWith("threshold-disk-nvme-errors-") ||
      f.id?.startsWith("threshold-disk-nvme-wear-"),
    actionIds: ["disk.identify_large_directories"],
  },
  {
    id: "disk-sata",
    label: "SATA Link Recovery",
    match: (f) => f.id?.startsWith("threshold-disk-sata-"),
    actionIds: ["disk.identify_large_directories"],
  },
  {
    id: "nic-utilization",
    label: "NIC Utilization Recovery",
    match: (f) => f.id === "threshold-nic-utilization",
    actionIds: [
      "nic.pause_process",
      "nic.resume_process",
      "nic.terminate_process",
    ],
  },
  {
    id: "nic-errors",
    label: "NIC Error Recovery",
    match: (f) => f.id === "threshold-nic-errors" || f.id === "threshold-nic-lh-counters",
    actionIds: [
      "nic.pause_process",
      "nic.resume_process",
      "nic.terminate_process",
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
      "nic.pause_process",
      "nic.resume_process",
      "nic.terminate_process",
      "nic.restart_interface",
      "nic.renew_dhcp",
      "nic.restart_network_manager",
      "nic.reload_driver",
    ],
  },
  {
    id: "io-pcie",
    label: "PCIe Link Recovery",
    // PCIe/USB/chipset only — workload faults are handled by io-workload above.
    match: (f) => {
      const id = f.id || "";
      if (
        id.startsWith("threshold-io-busy-") ||
        id.startsWith("threshold-io-queue-") ||
        id.startsWith("threshold-io-latency-") ||
        id.startsWith("threshold-io-throughput-")
      ) {
        return false;
      }
      return (
        f.component === "IO Control" ||
        id.startsWith("threshold-io-pcie") ||
        id === "threshold-io-mb-pcie-crit" ||
        id === "threshold-io-usb-errors" ||
        id === "threshold-io-mb-warnings"
      );
    },
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
