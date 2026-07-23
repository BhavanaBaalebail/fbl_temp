/**
 * Dashboard Data Module
 * Contains dashboard metrics, health data, and severity information
 */

export const severityData = [
  { name: "Critical", value: 2, color: "#ff4444" },
  { name: "Warning", value: 1, color: "#ff8c00" },
  { name: "Resolved", value: 2, color: "#00c853" },
  { name: "Info", value: 0, color: "#4d9fff" },
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
