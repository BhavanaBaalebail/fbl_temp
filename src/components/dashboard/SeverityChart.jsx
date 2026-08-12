/**
 * Severity Chart — fault distribution analytics module
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { HardwareModule } from "../ui/HardwareModule";
import { viz, theme } from "../../utils/theme";

export function SeverityChart({ data }) {
  const maxValue = Math.max(1, ...data.map((d) => d.value));

  return (
    <HardwareModule
      icon="chart"
      title="Fault Severity Distribution"
      subtitle="Component health levels across the monitoring bus"
    >
      <div
        className="mt-2 h-[300px] rounded-lg"
        style={{
          background: "rgba(8, 12, 18, 0.6)",
          border: "1px solid rgba(34, 211, 238, 0.08)",
        }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 24, right: 18, left: 8, bottom: 28 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={viz.grid} vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fill: theme.textMuted, fontSize: 11, fontFamily: "JetBrains Mono" }}
              axisLine={{ stroke: "rgba(34,211,238,0.1)" }}
              tickLine={false}
            />
            <YAxis
              domain={[0, maxValue]}
              allowDecimals={false}
              tick={{ fill: theme.textMuted, fontSize: 11, fontFamily: "JetBrains Mono" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: "rgba(34, 211, 238, 0.06)" }}
              contentStyle={{
                backgroundColor: viz.tooltipBg,
                border: "1px solid rgba(34, 211, 238, 0.2)",
                borderRadius: "8px",
                color: theme.textPrimary,
                fontFamily: "JetBrains Mono",
                fontSize: 12,
              }}
            />
            <Bar
              dataKey="value"
              radius={[4, 4, 0, 0]}
              label={{
                position: "top",
                fill: theme.textSecondary,
                fontSize: 11,
                fontFamily: "JetBrains Mono",
              }}
            >
              {data.map((entry) => (
                <Cell
                  key={entry.name}
                  fill={entry.color}
                  style={{ filter: `drop-shadow(0 0 6px ${entry.color}66)` }}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-4 flex flex-wrap gap-4 text-xs">
        {data.map((item) => (
          <div key={item.name} className="flex items-center gap-2 text-[#94a3b8]">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{
                backgroundColor: item.color,
                boxShadow: `0 0 6px ${item.color}88`,
              }}
            />
            <span className="font-mono-metrics">{item.name}</span>
            <span className="font-mono-metrics text-[#64748b]">({item.value})</span>
          </div>
        ))}
      </div>
    </HardwareModule>
  );
}
