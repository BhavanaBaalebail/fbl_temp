/**
 * Dashboard Data Module
 * Contains dashboard metrics, health data, and severity information
 */

export const severityData = [
<<<<<<< HEAD
  { name: "CPU", value: 0, util: 0, share: 0, color: "#4d9fff" },
  { name: "GPU", value: 0, util: 0, share: 0, color: "#22d3ee" },
  { name: "RAM", value: 0, util: 0, share: 0, color: "#bb86fc" },
  { name: "Disk", value: 0, util: 0, share: 0, color: "#f59e0b" },
  { name: "NIC", value: 0, util: 0, share: 0, color: "#38bdf8" },
  { name: "I/O Controller", value: 0, util: 0, share: 0, color: "#10b981" },
=======
  { name: "Critical", value: 2, color: "#ff4444" },
  { name: "Warning", value: 1, color: "#ff8c00" },
  { name: "Resolved", value: 2, color: "#00c853" },
  { name: "Info", value: 0, color: "#4d9fff" },
>>>>>>> caf72871fb35f53ee17e5d75b63821ea8af10048
];

export const healthRows = [
  { name: "CPU", dot: "#00e676", status: "Healthy", statusColor: "#ffffff" },
  { name: "GPU", dot: "#ff8c00", status: "Warning — Thermal throttle", statusColor: "#ff8c00" },
  { name: "RAM", dot: "#00e676", status: "Healthy — ECC corrected", statusColor: "#ffffff" },
  { name: "DISK", dot: "#ff4444", status: "Critical — SMART alert", statusColor: "#ff4444" },
  { name: "NIC", dot: "#00e676", status: "Healthy — Link restored", statusColor: "#ffffff" },
  { name: "IO Control", dot: "#00e676", status: "Healthy", statusColor: "#ffffff" },
];

export const dashboardMetrics = [
  {
    value: "3",
    valueColor: "#ff4444",
    label: "Active Faults",
    subtitle: "2 Critical, 1 Warning",
    accent: "#ff4444",
  },
  {
    value: "4 / 6",
    valueColor: "#00e676",
    label: "Components OK",
    subtitle: "Healthy Systems",
    accent: "#00e676",
  },
  {
    value: "4.2m",
    valueColor: "#4d9fff",
    label: "Mean Recovery",
    subtitle: "Avg Resolution Time",
    accent: "#4d9fff",
  },
  {
    value: "99.87%",
    valueColor: "#bb86fc",
    label: "Uptime",
    subtitle: "SLA Target: 99.9%",
    accent: "#bb86fc",
  },
];
