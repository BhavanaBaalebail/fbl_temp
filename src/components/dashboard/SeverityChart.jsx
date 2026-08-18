/**
<<<<<<< HEAD
 * Load-share doughnut — relative utilization of the six monitored components
 */

import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
=======
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
>>>>>>> caf72871fb35f53ee17e5d75b63821ea8af10048
} from "recharts";
import { HardwareModule } from "../ui/HardwareModule";
import { viz, theme } from "../../utils/theme";

export function SeverityChart({ data }) {
<<<<<<< HEAD
  const slices = Array.isArray(data) ? data : [];
=======
  const maxValue = Math.max(1, ...data.map((d) => d.value));
>>>>>>> caf72871fb35f53ee17e5d75b63821ea8af10048

  return (
    <HardwareModule
      icon="chart"
<<<<<<< HEAD
      title="Load Share by Component"
      subtitle="Relative utilization across CPU, GPU, RAM, Disk, NIC, and I/O Controller"
=======
      title="Fault Severity Distribution"
      subtitle="Component health levels across the monitoring bus"
>>>>>>> caf72871fb35f53ee17e5d75b63821ea8af10048
    >
      <div
        className="mt-2 h-[300px] rounded-lg"
        style={{
          background: "rgba(8, 12, 18, 0.6)",
          border: "1px solid rgba(34, 211, 238, 0.08)",
        }}
      >
        <ResponsiveContainer width="100%" height="100%">
<<<<<<< HEAD
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
=======
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
>>>>>>> caf72871fb35f53ee17e5d75b63821ea8af10048
              contentStyle={{
                backgroundColor: viz.tooltipBg,
                border: "1px solid rgba(34, 211, 238, 0.2)",
                borderRadius: "8px",
                color: theme.textPrimary,
                fontFamily: "JetBrains Mono",
                fontSize: 12,
              }}
            />
<<<<<<< HEAD
          </PieChart>
=======
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
>>>>>>> caf72871fb35f53ee17e5d75b63821ea8af10048
        </ResponsiveContainer>
      </div>

      <div className="mt-4 flex flex-wrap gap-4 text-xs">
<<<<<<< HEAD
        {slices.map((item) => (
=======
        {data.map((item) => (
>>>>>>> caf72871fb35f53ee17e5d75b63821ea8af10048
          <div key={item.name} className="flex items-center gap-2 text-[#94a3b8]">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{
                backgroundColor: item.color,
                boxShadow: `0 0 6px ${item.color}88`,
              }}
            />
            <span className="font-mono-metrics">{item.name}</span>
<<<<<<< HEAD
            <span className="font-mono-metrics text-[#64748b]">
              ({Number(item.share || 0).toFixed(0)}%)
            </span>
=======
            <span className="font-mono-metrics text-[#64748b]">({item.value})</span>
>>>>>>> caf72871fb35f53ee17e5d75b63821ea8af10048
          </div>
        ))}
      </div>
    </HardwareModule>
  );
}
