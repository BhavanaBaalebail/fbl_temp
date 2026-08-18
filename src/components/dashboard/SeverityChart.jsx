/**
 * Load-share doughnut — relative utilization of the six monitored components
 */

import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { HardwareModule } from "../ui/HardwareModule";
import { viz, theme } from "../../utils/theme";

export function SeverityChart({ data }) {
  const slices = Array.isArray(data) ? data : [];

  return (
    <HardwareModule
      icon="chart"
      title="Load Share by Component"
      subtitle="Relative utilization across CPU, GPU, RAM, Disk, NIC, and I/O Controller"
    >
      <div
        className="mt-2 h-[300px] rounded-lg"
        style={{
          background: "rgba(8, 12, 18, 0.6)",
          border: "1px solid rgba(34, 211, 238, 0.08)",
        }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={58}
              outerRadius={92}
              paddingAngle={1.5}
              stroke="rgba(8, 12, 18, 0.85)"
              strokeWidth={1}
              label={({ cx, cy, midAngle, innerRadius, outerRadius, percent, name }) => {
                const RADIAN = Math.PI / 180;
                const radius = innerRadius + (outerRadius - innerRadius) * 1.55;
                const x = cx + radius * Math.cos(-midAngle * RADIAN);
                const y = cy + radius * Math.sin(-midAngle * RADIAN);
                if (!percent) return null;
                return (
                  <text
                    x={x}
                    y={y}
                    fill={theme.textSecondary}
                    textAnchor={x > cx ? "start" : "end"}
                    dominantBaseline="central"
                    fontSize={10}
                    fontFamily="JetBrains Mono"
                  >
                    {`${name} ${(percent * 100).toFixed(0)}%`}
                  </text>
                );
              }}
              labelLine={{ stroke: theme.textMuted, strokeWidth: 1 }}
            >
              {slices.map((entry) => (
                <Cell
                  key={entry.name}
                  fill={entry.color}
                  style={{ filter: `drop-shadow(0 0 6px ${entry.color}66)` }}
                />
              ))}
            </Pie>
            <Tooltip
              formatter={(value, name, item) => {
                const share = item?.payload?.share;
                const util = item?.payload?.util ?? value;
                const shareLabel =
                  share != null && Number.isFinite(share) ? `${share.toFixed(1)}%` : "—";
                return [`${Number(util).toFixed(1)}% util · ${shareLabel} share`, name];
              }}
              contentStyle={{
                backgroundColor: viz.tooltipBg,
                border: "1px solid rgba(34, 211, 238, 0.2)",
                borderRadius: "8px",
                color: theme.textPrimary,
                fontFamily: "JetBrains Mono",
                fontSize: 12,
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-4 flex flex-wrap gap-4 text-xs">
        {slices.map((item) => (
          <div key={item.name} className="flex items-center gap-2 text-[#94a3b8]">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{
                backgroundColor: item.color,
                boxShadow: `0 0 6px ${item.color}88`,
              }}
            />
            <span className="font-mono-metrics">{item.name}</span>
            <span className="font-mono-metrics text-[#64748b]">
              ({Number(item.share || 0).toFixed(0)}%)
            </span>
          </div>
        ))}
      </div>
    </HardwareModule>
  );
}
