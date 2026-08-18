/**
 * Reusable hardware module panel with glassmorphism and chip styling
 */

import { HardwareIcon } from "./HardwareIcon";

export function HardwareModule({
  children,
  className = "",
  accentColor,
  icon,
  title,
  subtitle,
  headerRight,
  noPadding = false,
  style = {},
}) {
  return (
    <article
      className={`hw-module ${noPadding ? "" : "p-5"} ${className}`}
      style={{
        ...(accentColor ? { "--accent-color": accentColor } : {}),
        ...style,
      }}
    >
      {accentColor && <div className="hw-module-accent" style={{ background: accentColor }} />}
      <div className="hw-module-chip-corner" />

      {(title || icon) && (
        <header className={`flex items-start justify-between gap-3 ${noPadding ? "px-5 pt-5" : ""} ${children ? "mb-4" : ""}`}>
          <div className="flex items-start gap-3">
            {icon && (
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                style={{
                  background: "rgba(34, 211, 238, 0.08)",
                  border: "1px solid rgba(34, 211, 238, 0.15)",
                }}
              >
                <HardwareIcon name={icon} size={18} />
              </div>
            )}
            <div>
              {title && (
                <h2 className="font-display text-lg font-semibold tracking-tight text-[#f1f5f9]">
                  {title}
                </h2>
              )}
              {subtitle && (
                <p className="mt-0.5 text-xs text-[#94a3b8]">{subtitle}</p>
              )}
            </div>
          </div>
          {headerRight}
        </header>
      )}

      <div className={noPadding && (title || icon) ? "px-5 pb-5" : ""}>{children}</div>
    </article>
  );
}

export function BusConnector({ className = "" }) {
  return <div className={`hw-bus-line ${className}`} aria-hidden="true" />;
}

export function StatusBadge({ status = "info", label, showDot = true }) {
  const toneClass =
    status === "healthy" || status === "clear" || status === "resolved"
      ? "status-badge-healthy"
      : status === "warning" || status === "monitor"
        ? "status-badge-warning"
        : status === "critical" || status === "active"
          ? "status-badge-critical"
          : "status-badge-info";

  const dotClass =
    status === "healthy" || status === "clear" || status === "resolved"
      ? "status-dot-glow-healthy"
      : status === "warning" || status === "monitor"
        ? "status-dot-glow-warning"
        : status === "critical" || status === "active"
          ? "status-dot-glow-critical"
          : "";

  return (
    <span className={`status-badge ${toneClass}`}>
      {showDot && dotClass && <span className={`status-dot-glow ${dotClass}`} />}
      {label}
    </span>
  );
}
