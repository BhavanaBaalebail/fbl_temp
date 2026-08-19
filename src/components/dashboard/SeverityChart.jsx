/**
 * System Health doughnut — distribution of monitored components by health status.
 * Counts come from existing buildHealthStats (same source as Component Health Bus).
 */

import {
  Cell,
  Label,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { HardwareModule } from "../ui/HardwareModule";
import { viz, theme } from "../../utils/theme";

const CATEGORIES = [
  { key: "healthyCount", name: "Healthy", color: theme.healthy },
  { key: "warningCount", name: "Warning", color: theme.warning },
  { key: "criticalCount", name: "Critical", color: theme.critical },
];

function componentWord(count) {
  return count === 1 ? "component" : "components";
}

function formatPercent(count, total) {
  if (!total) return "0%";
  const pct = (count / total) * 100;
  const rounded = Math.round(pct * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function CenterLabel({ viewBox, total }) {
  const cx = viewBox?.cx ?? 0;
  const cy = viewBox?.cy ?? 0;
  return (
    <text textAnchor="middle" dominantBaseline="central">
      <tspan
        x={cx}
        y={cy - 8}
        fill={theme.textPrimary}
        fontSize={22}
        fontFamily="JetBrains Mono"
        fontWeight={600}
      >
        {total}
      </tspan>
      <tspan
        x={cx}
        y={cy + 14}
        fill={theme.textMuted}
        fontSize={11}
        fontFamily="IBM Plex Sans"
      >
        Components
      </tspan>
    </text>
  );
}

function HealthTooltip({ active, payload, total }) {
  if (!active || !payload?.length) return null;
  const item = payload[0]?.payload;
  if (!item) return null;
  return (
    <div
      style={{
        backgroundColor: viz.tooltipBg,
        border: "1px solid rgba(34, 211, 238, 0.2)",
        borderRadius: 8,
        color: theme.textPrimary,
        fontFamily: "IBM Plex Sans",
        fontSize: 12,
        padding: "8px 10px",
      }}
    >
      <div className="font-semibold">{item.name}</div>
      <div className="mt-0.5 text-[#94a3b8]">
        {item.value} {componentWord(item.value)}
      </div>
      <div className="font-mono-metrics text-[#cbd5e1]">{formatPercent(item.value, total)}</div>
    </div>
  );
}

export function SeverityChart({ stats }) {
  const healthy = Number(stats?.healthyCount) || 0;
  const warning = Number(stats?.warningCount) || 0;
  const critical = Number(stats?.criticalCount) || 0;
  const total = healthy + warning + critical;

  const legend = CATEGORIES.map((cat) => ({
    ...cat,
    value: Number(stats?.[cat.key]) || 0,
  }));

  const slices = legend.filter((row) => row.value > 0);
  const empty = total === 0;

  return (
    <HardwareModule
      icon="chart"
      title="System Health"
      subtitle="Monitored components by health status"
    >
      <div
        className="mt-2 flex h-[300px] items-center justify-center rounded-lg"
        style={{
          background: "rgba(8, 12, 18, 0.6)",
          border: "1px solid rgba(34, 211, 238, 0.08)",
        }}
      >
        {empty ? (
          <div className="px-6 text-center">
            <p className="font-mono-metrics text-2xl font-semibold text-[#f1f5f9]">0</p>
            <p className="mt-1 text-xs uppercase tracking-wider text-[#64748b]">
              Total Components
            </p>
            <p className="mt-3 text-sm text-[#94a3b8]">No component health data available</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={62}
                outerRadius={92}
                paddingAngle={slices.length > 1 ? 2 : 0}
                stroke="rgba(8, 12, 18, 0.85)"
                strokeWidth={1}
              >
                {slices.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
                <Label content={(props) => <CenterLabel {...props} total={total} />} position="center" />
              </Pie>
              <Tooltip content={<HealthTooltip total={total} />} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs">
        {legend.map((item) => (
          <div key={item.name} className="flex items-center gap-2 text-[#94a3b8]">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <span>{item.name}</span>
            <span className="font-mono-metrics text-[#f1f5f9]">{item.value}</span>
          </div>
        ))}
      </div>
    </HardwareModule>
  );
}
