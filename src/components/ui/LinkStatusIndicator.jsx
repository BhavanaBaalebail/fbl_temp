/**
 * Engineering-focused link/bus status indicators.
 * Replaces consumer-style heart icons with interconnect visuals.
 */

import { theme } from "../../utils/theme";

const LEVEL_COLORS = {
  healthy: { stroke: theme.healthy, glow: theme.healthyGlow, fill: "rgba(16,185,129,0.15)" },
  warning: { stroke: theme.warning, glow: theme.warningGlow, fill: "rgba(245,158,11,0.12)" },
  critical: { stroke: theme.critical, glow: theme.criticalGlow, fill: "rgba(239,68,68,0.12)" },
  unknown: { stroke: theme.unknown, glow: "none", fill: "rgba(100,116,139,0.1)" },
};

export function inferStatusLevelFromColor(color) {
  if (!color) return "unknown";
  const c = String(color).toLowerCase();
  if (c.includes("b71c1c") || c.includes("ef4444") || c.includes("ff4444")) return "critical";
  if (c.includes("ff9800") || c.includes("f59e0b") || c.includes("ff8c00")) return "warning";
  if (c.includes("00e676") || c.includes("10b981") || c.includes("00c853")) return "healthy";
  return "unknown";
}

/**
 * Minimal interconnect node indicator — central bus junction with linked endpoints.
 * Used for Link Health, Bus Status, and connectivity state displays.
 */
export function LinkStatusIndicator({
  level = "unknown",
  size = 20,
  variant = "interconnect",
  className = "",
}) {
  const colors = LEVEL_COLORS[level] || LEVEL_COLORS.unknown;
  const glowId = `link-glow-${level}-${size}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      style={{ overflow: "visible" }}
    >
      <defs>
        <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="0" stdDeviation="1.2" floodColor={colors.stroke} floodOpacity="0.55" />
        </filter>
      </defs>

      {variant === "bus" ? (
        <g fill="none" stroke={colors.stroke} strokeWidth="1.2" filter={`url(#${glowId})`}>
          <path d="M3 12h18" opacity="0.5" />
          <path d="M6 9v6M10 8v8M14 8v8M18 9v6" strokeLinecap="round" />
          <rect x="5" y="10" width="14" height="4" rx="1" fill={colors.fill} stroke={colors.stroke} />
        </g>
      ) : variant === "signal" ? (
        <g fill="none" stroke={colors.stroke} strokeWidth="1.2" filter={`url(#${glowId})`}>
          <path d="M2 12h4l2-3 3 6 3-6 2 3h4" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="1.5" fill={colors.stroke} stroke="none" />
        </g>
      ) : (
        <g fill="none" stroke={colors.stroke} strokeWidth="1.2" filter={`url(#${glowId})`}>
          <circle cx="5" cy="12" r="2" fill={colors.fill} />
          <circle cx="19" cy="12" r="2" fill={colors.fill} />
          <circle cx="12" cy="12" r="2.5" fill={colors.fill} strokeWidth="1.4" />
          <path d="M7 12h3M14 12h3" strokeLinecap="round" />
          <path d="M12 8v2M12 14v2" strokeLinecap="round" opacity="0.45" />
        </g>
      )}
    </svg>
  );
}

export function LinkStatusLegend({ level, label, compact = false }) {
  const colors = LEVEL_COLORS[level] || LEVEL_COLORS.unknown;
  return (
    <span className={`inline-flex items-center gap-2 ${compact ? "text-[11px]" : "text-xs"} font-medium`} style={{ color: colors.stroke }}>
      <LinkStatusIndicator level={level} size={compact ? 14 : 16} variant="interconnect" />
      {label}
    </span>
  );
}
