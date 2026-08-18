/**
 * Exact Utilities navigation tree — do not rename/reorder.
 */

export const UTILITIES_TREE = [
  {
    id: "system",
    label: "System",
    icon: "server",
    children: [
      { id: "server-uptime", label: "Server Uptime", icon: "server" },
      { id: "disk-usage", label: "Disk Usage", icon: "DISK" },
      { id: "find-large-files", label: "Find Large Files", icon: "DISK" },
      { id: "temperature-fan", label: "Temperature & Fan", icon: "CPU" },
      { id: "reboot-history", label: "Reboot History", icon: "server" },
    ],
  },
  {
    id: "network",
    label: "Network",
    icon: "NIC",
    children: [
      { id: "ping-node", label: "Ping Node", icon: "connectivity" },
      { id: "packet-loss", label: "Packet Loss", icon: "signal" },
      { id: "port-scanner", label: "Port Scanner", icon: "interconnect" },
      { id: "traceroute", label: "Traceroute", icon: "connectivity" },
      { id: "firewall-status", label: "Firewall Status", icon: "fault" },
    ],
  },
  {
    id: "security",
    label: "Security",
    icon: "fault",
    children: [
      { id: "failed-login-alerts", label: "Failed Login Alerts", icon: "fault" },
      { id: "ssh-login-tracker", label: "SSH Login Tracker", icon: "server" },
      { id: "ssl-certificate-checker", label: "SSL Certificate Checker", icon: "report" },
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    icon: "motherboard",
    children: [
      { id: "software-inventory", label: "Software Inventory", icon: "motherboard" },
      { id: "user-account-report", label: "User Account Report", icon: "report" },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    icon: "diagnostics",
    children: [
      { id: "backup-status", label: "Backup Status", icon: "report" },
      { id: "broadcast-message", label: "Broadcast Message", icon: "signal" },
<<<<<<< HEAD
      { id: "email-alerts", label: "Email Alerts", icon: "signal" },
      { id: "daily-report", label: "Daily Report", icon: "chart" },
    ],
  },
  {
    id: "incident-analysis",
    label: "Incident Analysis",
    icon: "diagnostics",
    children: [
      { id: "incident-analysis-utilities", label: "Incident Analysis Utilities", icon: "diagnostics" },
    ],
  },
=======
      { id: "whatsapp-alerts", label: "WhatsApp Alerts", icon: "signal" },
      { id: "daily-report", label: "Daily Report", icon: "chart" },
    ],
  },
>>>>>>> caf72871fb35f53ee17e5d75b63821ea8af10048
];

export function findUtilityMeta(utilityId) {
  for (const cat of UTILITIES_TREE) {
    for (const child of cat.children) {
      if (child.id === utilityId) {
        return { ...child, category: cat.label, categoryId: cat.id };
      }
    }
  }
  return null;
}
