/**
 * Hardware-specific SVG icons for dashboard modules
 */

const ICONS = {
  CPU: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="7" y="7" width="10" height="10" rx="1" opacity="0.5" />
      <path d="M8 2v2M12 2v2M16 2v2M8 20v2M12 20v2M16 20v2M2 8h2M2 12h2M2 16h2M20 8h2M20 12h2M20 16h2" />
    </g>
  ),
  GPU: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <rect x="5" y="9" width="8" height="6" rx="1" opacity="0.4" />
      <path d="M16 10h4M16 13h4M16 16h4" />
      <circle cx="6" cy="18" r="1.5" fill="currentColor" />
      <circle cx="18" cy="18" r="1.5" fill="currentColor" />
    </g>
  ),
  RAM: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="3" y="8" width="18" height="8" rx="1" />
      <path d="M6 8V6M9 8V6M12 8V6M15 8V6M18 8V6" />
      <rect x="5" y="10" width="3" height="4" rx="0.5" opacity="0.5" />
      <rect x="10" y="10" width="3" height="4" rx="0.5" opacity="0.5" />
      <rect x="15" y="10" width="3" height="4" rx="0.5" opacity="0.5" />
    </g>
  ),
  DISK: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M7 7h10M7 11h10M7 15h6" opacity="0.6" />
      <rect x="6" y="5" width="4" height="2" rx="0.5" fill="currentColor" opacity="0.3" />
    </g>
  ),
  NIC: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="2" y="7" width="20" height="10" rx="2" />
      <path d="M6 12h2M10 12h2M14 12h2M18 12h2" />
      <path d="M8 5v2M12 5v2M16 5v2" />
      <circle cx="12" cy="17" r="1" fill="currentColor" />
    </g>
  ),
  "IO Control": (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 9h10M7 13h6" />
      <path d="M3 10h-1M3 14h-1M21 10h1M21 14h1" />
    </g>
  ),
  "IO Controller": (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 9h10M7 13h6" />
    </g>
  ),
  PCIe: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M4 12h16M4 12l3-4h10l3 4M4 12l3 4h10l3-4" />
      <path d="M8 8v8M16 8v8" opacity="0.4" />
    </g>
  ),
  motherboard: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <rect x="8" y="8" width="8" height="8" rx="1" opacity="0.3" />
      <circle cx="6" cy="7" r="1" fill="currentColor" />
      <circle cx="18" cy="7" r="1" fill="currentColor" />
      <circle cx="6" cy="17" r="1" fill="currentColor" />
      <circle cx="18" cy="17" r="1" fill="currentColor" />
    </g>
  ),
  diagnostics: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <circle cx="12" cy="12" r="5" />
      <path d="M12 9v3l2 2" />
    </g>
  ),
  report: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M6 3h10l4 4v14H6V3z" />
      <path d="M16 3v4h4M8 11h8M8 15h8M8 19h5" />
    </g>
  ),
  dashboard: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
    </g>
  ),
  connectivity: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="12" cy="12" r="3" />
      <circle cx="5" cy="7" r="2" />
      <circle cx="19" cy="7" r="2" />
      <circle cx="5" cy="17" r="2" />
      <circle cx="19" cy="17" r="2" />
      <path d="M7 8l3 3M17 8l-3 3M7 16l3-3M17 16l-3-3" />
    </g>
  ),
  fault: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M12 3L3 20h18L12 3z" />
      <path d="M12 9v5M12 17v1" />
    </g>
  ),
  interconnect: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="5" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M7 12h3M14 12h3" strokeLinecap="round" />
      <path d="M12 8v2M12 14v2" strokeLinecap="round" opacity="0.45" />
    </g>
  ),
  linkHealth: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M2 12h4l2-3 3 6 3-6 2 3h4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </g>
  ),
  busStatus: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M3 12h18" opacity="0.5" />
      <path d="M6 9v6M10 8v8M14 8v8M18 9v6" strokeLinecap="round" />
      <rect x="5" y="10" width="14" height="4" rx="1" opacity="0.25" fill="currentColor" stroke="currentColor" />
    </g>
  ),
  signal: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M3 12h3M18 12h3" strokeLinecap="round" />
      <path d="M8 12c0-2 1-3 4-3s4 1 4 3-1 3-4 3-4-1-4-3z" />
      <path d="M10 10.5v3M14 10.5v3" strokeLinecap="round" opacity="0.5" />
    </g>
  ),
  chart: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M4 18V6M4 18h16" />
      <path d="M7 14l3-4 3 2 4-6" />
    </g>
  ),
  server: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="4" y="2" width="16" height="6" rx="1" />
      <rect x="4" y="10" width="16" height="6" rx="1" />
      <rect x="4" y="18" width="16" height="4" rx="1" />
      <circle cx="7" cy="5" r="1" fill="currentColor" />
      <circle cx="7" cy="13" r="1" fill="currentColor" />
    </g>
  ),
};

export function HardwareIcon({ name = "CPU", size = 20, className = "", style = {} }) {
  const icon = ICONS[name] || ICONS.CPU;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      style={{ color: "var(--hw-cyan, #22d3ee)", ...style }}
      aria-hidden="true"
    >
      {icon}
    </svg>
  );
}

export function getMetricIcon(label) {
  const map = {
    "Link Health": "linkHealth",
    "Active Alerts": "fault",
    "Components OK": "motherboard",
    "System Load": "CPU",
  };
  return map[label] || "diagnostics";
}

export function getComponentIcon(name) {
  const map = {
    CPU: "CPU",
    GPU: "GPU",
    RAM: "RAM",
    DISK: "DISK",
    NIC: "NIC",
    "IO Control": "IO Control",
    "IO Controller": "IO Controller",
  };
  return map[name] || "diagnostics";
}
