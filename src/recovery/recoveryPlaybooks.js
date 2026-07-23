/**
 * Recovery Playbooks — telemetry-driven autonomous recovery definitions.
 * Only includes actions verifiable via /inventory, /metrics, /link_health.
 * No shell commands or unsupported hardware controls.
 */

/** @typedef {'collect_evidence'|'safety_check'|'identify_workload'|'monitor_metric'|'verify_fault_cleared'} RecoveryStepType */

/**
 * @param {object} fault
 * @returns {boolean}
 */
export function hasRecoveryPlaybook(fault) {
  return getPlaybookForFault(fault) != null;
}

/**
 * @param {object} fault
 * @returns {object|null}
 */
export function getPlaybookForFault(fault) {
  if (!fault || fault.severity === "Resolved") return null;
  return RECOVERY_PLAYBOOKS.find((pb) => pb.match(fault)) || null;
}

export const RECOVERY_PLAYBOOKS = [
  {
    id: "gpu-thermal",
    component: "GPU",
    label: "GPU Thermal Stabilization",
    match: (f) => f.id?.startsWith("threshold-gpu-temperature"),
    monitorMetric: "gpu.temperature_celsius",
    verifyFaultId: "threshold-gpu-temperature",
    steps: [
      { id: "baseline", type: "collect_evidence", label: "Collect baseline telemetry snapshot" },
      { id: "safety", type: "safety_check", label: "Validate no concurrent critical hardware faults" },
      { id: "workload", type: "identify_workload", label: "Identify top GPU workload from live metrics" },
      {
        id: "monitor",
        type: "monitor_metric",
        label: "Monitor GPU temperature trend",
        metric: "gpu.temperature_celsius",
        polls: 4,
        intervalMs: 5000,
        abortIfWorsening: true,
      },
      { id: "verify", type: "verify_fault_cleared", label: "Verify GPU temperature below threshold" },
    ],
  },
  {
    id: "gpu-vram",
    component: "GPU",
    label: "GPU VRAM Pressure Monitoring",
    match: (f) => f.id === "threshold-gpu-vram",
    monitorMetric: "gpu.memory_utilization_percent",
    verifyFaultId: "threshold-gpu-vram",
    steps: [
      { id: "baseline", type: "collect_evidence", label: "Collect baseline telemetry snapshot" },
      { id: "safety", type: "safety_check", label: "Validate system stability" },
      { id: "workload", type: "identify_workload", label: "Identify top GPU memory consumer" },
      {
        id: "monitor",
        type: "monitor_metric",
        label: "Monitor VRAM utilization trend",
        metric: "gpu.memory_utilization_percent",
        polls: 4,
        intervalMs: 5000,
        abortIfWorsening: true,
      },
      { id: "verify", type: "verify_fault_cleared", label: "Verify VRAM usage below threshold" },
    ],
  },
  {
    id: "cpu-usage",
    component: "CPU",
    label: "CPU Load Stabilization",
    match: (f) => f.id === "threshold-cpu-usage",
    monitorMetric: "cpu.usage_percent",
    verifyFaultId: "threshold-cpu-usage",
    steps: [
      { id: "baseline", type: "collect_evidence", label: "Collect baseline telemetry snapshot" },
      { id: "safety", type: "safety_check", label: "Validate no concurrent critical hardware faults" },
      { id: "workload", type: "identify_workload", label: "Identify top CPU workload from live metrics" },
      {
        id: "monitor",
        type: "monitor_metric",
        label: "Monitor CPU utilization trend",
        metric: "cpu.usage_percent",
        polls: 4,
        intervalMs: 5000,
        abortIfWorsening: true,
      },
      { id: "verify", type: "verify_fault_cleared", label: "Verify CPU usage below threshold" },
    ],
  },
  {
    id: "cpu-thermal",
    component: "CPU",
    label: "CPU Thermal Monitoring",
    match: (f) => f.id === "threshold-cpu-temperature",
    monitorMetric: "cpu.temperature_celsius",
    verifyFaultId: "threshold-cpu-temperature",
    steps: [
      { id: "baseline", type: "collect_evidence", label: "Collect baseline telemetry snapshot" },
      { id: "safety", type: "safety_check", label: "Validate system stability" },
      { id: "workload", type: "identify_workload", label: "Identify top CPU workload from live metrics" },
      {
        id: "monitor",
        type: "monitor_metric",
        label: "Monitor CPU temperature trend",
        metric: "cpu.temperature_celsius",
        polls: 4,
        intervalMs: 5000,
        abortIfWorsening: true,
      },
      { id: "verify", type: "verify_fault_cleared", label: "Verify CPU temperature below threshold" },
    ],
  },
  {
    id: "ram-usage",
    component: "RAM",
    label: "Memory Pressure Monitoring",
    match: (f) => f.id === "threshold-ram-usage" || f.id === "threshold-ram-swap",
    monitorMetric: "memory.usage_percent",
    verifyFaultId: null,
    steps: [
      { id: "baseline", type: "collect_evidence", label: "Collect baseline telemetry snapshot" },
      { id: "safety", type: "safety_check", label: "Validate system stability" },
      { id: "workload", type: "identify_workload", label: "Identify top memory consumer from live metrics" },
      {
        id: "monitor",
        type: "monitor_metric",
        label: "Monitor memory and swap utilization trend",
        metric: "memory.usage_percent",
        polls: 4,
        intervalMs: 5000,
        abortIfWorsening: true,
      },
      { id: "verify", type: "verify_fault_cleared", label: "Verify memory pressure below threshold" },
    ],
  },
  {
    id: "disk-capacity",
    component: "DISK",
    label: "Disk Capacity Monitoring",
    match: (f) => f.id?.startsWith("threshold-disk-capacity"),
    monitorMetric: "disk.mount_usage",
    verifyFaultId: null,
    steps: [
      { id: "baseline", type: "collect_evidence", label: "Collect baseline telemetry snapshot" },
      { id: "safety", type: "safety_check", label: "Validate no SMART critical state" },
      {
        id: "monitor",
        type: "monitor_metric",
        label: "Monitor mount capacity trend",
        metric: "disk.mount_usage",
        polls: 3,
        intervalMs: 5000,
        abortIfWorsening: true,
      },
      { id: "verify", type: "verify_fault_cleared", label: "Verify mount usage below threshold" },
    ],
  },
  {
    id: "nic-errors",
    component: "NIC",
    label: "NIC Error Counter Monitoring",
    match: (f) => f.id === "threshold-nic-errors" || f.id === "threshold-nic-lh-counters",
    monitorMetric: "nic.total_errors",
    verifyFaultId: null,
    steps: [
      { id: "baseline", type: "collect_evidence", label: "Collect baseline telemetry snapshot" },
      { id: "safety", type: "safety_check", label: "Validate link state and connectivity" },
      {
        id: "monitor",
        type: "monitor_metric",
        label: "Monitor NIC error counter stability",
        metric: "nic.total_errors",
        polls: 4,
        intervalMs: 5000,
        abortIfWorsening: true,
      },
      { id: "verify", type: "verify_fault_cleared", label: "Verify NIC errors cleared or stable" },
    ],
  },
  {
    id: "nic-connectivity",
    component: "NIC",
    label: "Network Connectivity Verification",
    match: (f) => f.id === "threshold-nic-connectivity" || f.id === "threshold-nic-link-down",
    monitorMetric: "nic.up_count",
    verifyFaultId: null,
    steps: [
      { id: "baseline", type: "collect_evidence", label: "Collect baseline telemetry snapshot" },
      { id: "safety", type: "safety_check", label: "Validate physical interface inventory" },
      {
        id: "monitor",
        type: "monitor_metric",
        label: "Monitor interface link state",
        metric: "nic.up_count",
        polls: 4,
        intervalMs: 5000,
        abortIfWorsening: false,
      },
      { id: "verify", type: "verify_fault_cleared", label: "Verify connectivity restored" },
    ],
  },
];
