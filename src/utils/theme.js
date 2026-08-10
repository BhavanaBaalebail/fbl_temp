/**
 * Enterprise Hardware Monitoring Theme
 * Dark graphite / silicon palette with cyan trace accents
 */

export const theme = {
  /* Core surfaces */
  void: "#040608",
  graphite: "#0a0e14",
  graphiteMid: "#0f1419",
  graphiteLight: "#161c24",
  panel: "rgba(12, 18, 28, 0.72)",
  panelSolid: "#0c121c",
  glass: "rgba(14, 22, 34, 0.55)",
  glassBorder: "rgba(56, 189, 248, 0.18)",
  glassHighlight: "rgba(255, 255, 255, 0.04)",

  /* Accents */
  cyan: "#22d3ee",
  cyanDim: "#0891b2",
  cyanGlow: "rgba(34, 211, 238, 0.35)",
  blue: "#38bdf8",
  blueDeep: "#0ea5e9",
  electricBlue: "#38bdf8",
  icyBlue: "#7dd3fc",
  trace: "rgba(34, 211, 238, 0.12)",

  /* Legacy aliases (used by services/charts) */
  snow: "#e2e8f0",
  navy: "#0c121c",
  shellNavy: "#0a0e14",
  shellMid: "#0a0e14",
  shellDeep: "#0f1419",
  shellSlate: "#161c24",
  shellBorder: "rgba(34, 211, 238, 0.22)",
  cyanGlowLegacy: "#22d3ee",

  /* Status */
  healthy: "#10b981",
  healthyGlow: "rgba(16, 185, 129, 0.45)",
  warning: "#f59e0b",
  warningGlow: "rgba(245, 158, 11, 0.45)",
  critical: "#ef4444",
  criticalGlow: "rgba(239, 68, 68, 0.45)",
  unknown: "#64748b",

  /* Text */
  textPrimary: "#f1f5f9",
  textSecondary: "#94a3b8",
  textMuted: "#64748b",
  textAccent: "#38bdf8",

  /* Gradients */
  headerGradient:
    "linear-gradient(180deg, rgba(10,14,20,0.98) 0%, rgba(12,18,28,0.95) 100%)",
  sidebarGradient:
    "linear-gradient(195deg, rgba(10,14,20,0.95) 0%, rgba(15,20,25,0.92) 100%)",
  mainGradient: "transparent",
  metallicBorder:
    "linear-gradient(135deg, rgba(34,211,238,0.35) 0%, rgba(100,116,139,0.15) 40%, rgba(34,211,238,0.25) 100%)",
  chipShine:
    "linear-gradient(145deg, rgba(255,255,255,0.06) 0%, transparent 45%, rgba(34,211,238,0.04) 100%)",

  /* Interactive */
  rowHover: "rgba(34, 211, 238, 0.06)",
  rowActiveBg: "rgba(34, 211, 238, 0.1)",
  rowActiveBorder: "#22d3ee",

  fonts: {
    sans: "'IBM Plex Sans', 'Inter', system-ui, sans-serif",
    display: "'Inter', 'IBM Plex Sans', system-ui, sans-serif",
    mono: "'JetBrains Mono', 'Fira Code', monospace",
  },
};

export const fonts = theme.fonts;

export const viz = {
  lineMajor: "#22d3ee",
  lineSecondary: "#38bdf8",
  grid: "rgba(34, 211, 238, 0.08)",
  tooltipBg: "rgba(10, 14, 20, 0.95)",
};

export const statusColors = {
  active: theme.critical,
  warning: theme.warning,
  resolved: theme.healthy,
  info: theme.cyan,
};
