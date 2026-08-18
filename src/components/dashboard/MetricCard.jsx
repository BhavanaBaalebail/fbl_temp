/**
 * Dashboard Metrics Card — hardware module telemetry readout
 */

import { HardwareIcon, getMetricIcon } from "../ui/HardwareIcon";
import { HardwareModule } from "../ui/HardwareModule";
import { LinkStatusIndicator, inferStatusLevelFromColor } from "../ui/LinkStatusIndicator";

export function MetricCard({ value, valueColor, label, subtitle, accent }) {
  const isLinkHealth = label === "Link Health";
  const linkLevel = isLinkHealth ? inferStatusLevelFromColor(accent || valueColor) : null;

  return (
    <HardwareModule accentColor={accent} className="group">
      <div className="flex items-start justify-between gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-all group-hover:shadow-[0_0_20px_rgba(34,211,238,0.15)]"
          style={{
            background: "rgba(34, 211, 238, 0.06)",
            border: "1px solid rgba(34, 211, 238, 0.12)",
          }}
        >
          {isLinkHealth ? (
            <LinkStatusIndicator level={linkLevel} size={22} variant="signal" />
          ) : (
            <HardwareIcon name={getMetricIcon(label)} size={20} style={{ color: accent }} />
          )}
        </div>
        <div className="font-mono-metrics text-[10px] font-medium uppercase tracking-wider text-[#64748b]">
          LIVE
        </div>
      </div>

      <div
        className="metric-value-animate mt-3 font-mono-metrics text-3xl font-semibold tracking-tight"
        style={{ color: valueColor }}
      >
        {value}
      </div>
      <div className="mt-1 flex items-center gap-2">
        {isLinkHealth && (
          <LinkStatusIndicator level={linkLevel} size={14} variant="interconnect" />
        )}
        <span className="font-display text-sm font-semibold text-[#f1f5f9]">{label}</span>
      </div>
      <div className="mt-1.5 text-xs leading-relaxed text-[#64748b]">{subtitle}</div>
    </HardwareModule>
  );
}
