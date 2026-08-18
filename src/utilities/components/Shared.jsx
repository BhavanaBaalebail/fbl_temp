/**
 * Shared Utilities UI primitives — dense, content-driven layouts.
 */

import { StatusBadge } from "../../components/ui/HardwareModule";
import { hasValue } from "../utils/value";

const SURFACE = {
  background: "rgba(8, 12, 18, 0.9)",
  borderColor: "rgba(34, 211, 238, 0.14)",
};

export function UtilityUnavailable({ message = "Data unavailable on this host" }) {
  return (
    <div className="inline-block max-w-sm rounded-lg border px-4 py-3 text-left" style={SURFACE}>
      <p className="text-sm text-[#94a3b8]">{message}</p>
    </div>
  );
}

/**
 * layout:
 *  - "compact"   → top-left, no full-bleed stretch
 *  - "dashboard" → tables / multi-metric (still capped)
 *  - "split"     → UtilitySplitPane
 */
export function UtilityPanel({ title, subtitle, status, children, actions, layout = "dashboard" }) {
  const widthClass =
    layout === "compact"
      ? "max-w-xl"
      : layout === "split"
        ? "max-w-5xl"
        : "max-w-[1100px] w-full";

  return (
    <div className={`space-y-2.5 ${widthClass}`}>
      <header className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-display text-base font-semibold tracking-tight text-[#f1f5f9]">
            {title}
          </h2>
          {subtitle ? <p className="mt-0.5 text-[11px] text-[#64748b]">{subtitle}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {status ? <StatusBadge status={status} label={String(status)} showDot={false} /> : null}
          {actions}
        </div>
      </header>
      {children}
    </div>
  );
}

export function UtilitySection({ title, children, className = "" }) {
  if (!children) return null;
  return (
    <section className={`space-y-1.5 ${className}`}>
      {title ? (
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
          {title}
        </h3>
      ) : null}
      {children}
    </section>
  );
}

/** Fixed-size compact metric — never grows to fill the row. */
export function CompactMetricCard({ label, value, status, emphasize = false }) {
  if (!hasValue(value)) return null;
  return (
    <div
      className="w-[11.5rem] shrink-0 rounded-lg border px-3 py-2.5 sm:w-[13rem]"
      style={SURFACE}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#64748b]">
          {label}
        </div>
        {status ? <StatusBadge status={status} label={String(status)} showDot={false} /> : null}
      </div>
      <div
        className={`mt-1 font-mono-metrics font-semibold leading-tight text-[#f1f5f9] ${
          emphasize ? "text-lg" : "text-sm"
        }`}
      >
        {String(value)}
      </div>
    </div>
  );
}

/** Left-aligned wrap — cards stay small; no stretch. */
export function UtilityGrid({ children, columns = "auto" }) {
  const colClass =
    columns === 3
      ? "grid-cols-2 lg:grid-cols-3"
      : columns === 2
        ? "grid-cols-2"
        : columns === 4
          ? "grid-cols-2 lg:grid-cols-4"
          : "";

  if (columns === "auto") {
    return <div className="flex flex-wrap content-start gap-2">{children}</div>;
  }

  return (
    <div className={`grid max-w-3xl gap-2 ${colClass}`}>
      {children}
    </div>
  );
}

export function UtilitySplitPane({ left, right, leftWidth = "280px" }) {
  return (
    <div
      className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(220px,var(--util-left))_minmax(0,1fr)]"
      style={{ ["--util-left"]: leftWidth }}
    >
      <div
        className="rounded-lg border p-3"
        style={{
          background: "rgba(10, 14, 22, 0.92)",
          borderColor: "rgba(34, 211, 238, 0.12)",
        }}
      >
        {left}
      </div>
      <div className="min-w-0 space-y-2">{right}</div>
    </div>
  );
}

export function UtilityStatusCard({ title, pairs, status }) {
  const rows = (pairs || []).filter(([, v]) => hasValue(v));
  if (!rows.length) return null;
  return (
    <div className="inline-block max-w-sm rounded-lg border p-3" style={SURFACE}>
      <div className="mb-2 flex items-center justify-between gap-3">
        {title ? (
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#94a3b8]">
            {title}
          </h3>
        ) : (
          <span />
        )}
        {status ? <StatusBadge status={status} label={String(status)} showDot={false} /> : null}
      </div>
      <dl className="space-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4">
            <dt className="text-[10px] uppercase tracking-wider text-[#64748b]">{label}</dt>
            <dd className="font-mono-metrics text-xs font-medium text-[#f1f5f9]">{String(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function KvGrid({ pairs, emphasizeFirst = false }) {
  const rows = (pairs || []).filter(([, v]) => hasValue(v));
  if (!rows.length) return null;
  return (
    <UtilityGrid columns="auto">
      {rows.map(([label, value], i) => (
        <CompactMetricCard
          key={label}
          label={label}
          value={value}
          emphasize={emphasizeFirst && i === 0}
        />
      ))}
    </UtilityGrid>
  );
}

export function DataTable({ columns, rows, dense = true, highlightStatus = true }) {
  const visibleCols = (columns || []).filter((c) =>
    (rows || []).some((r) => hasValue(r[c.key]))
  );
  if (!rows?.length || !visibleCols.length) return null;

  const statusTone = (status) => {
    const s = String(status || "").toLowerCase();
    if (s.includes("crit") || s === "closed" || s === "failed") return "text-[#f87171]";
    if (s.includes("warn") || s === "filtered") return "text-[#fbbf24]";
    if (s.includes("healthy") || s === "open" || s === "current" || s === "success") {
      return "text-[#34d399]";
    }
    return "text-[#e2e8f0]";
  };

  return (
    <div
      className="w-full overflow-x-auto rounded-lg border"
      style={{ borderColor: "rgba(34, 211, 238, 0.12)" }}
    >
      <table className={`w-full min-w-[24rem] text-left ${dense ? "text-[11px]" : "text-xs"}`}>
        <thead style={{ background: "rgba(12, 18, 28, 0.95)" }}>
          <tr>
            {visibleCols.map((c) => (
              <th
                key={c.key}
                className="whitespace-nowrap px-2.5 py-1.5 font-semibold uppercase tracking-wider text-[#64748b]"
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const rowStatus = String(row.status || "").toLowerCase();
            const rowBg =
              highlightStatus && rowStatus.includes("crit")
                ? "rgba(178, 34, 34, 0.08)"
                : highlightStatus && rowStatus.includes("warn")
                  ? "rgba(204, 102, 0, 0.07)"
                  : "transparent";
            return (
              <tr
                key={row.id || i}
                className="border-t"
                style={{ borderColor: "rgba(34, 211, 238, 0.08)", background: rowBg }}
              >
                {visibleCols.map((c) => (
                  <td
                    key={c.key}
                    className={`px-2.5 py-1.5 font-mono-metrics ${
                      c.key === "status" || c.key === "state"
                        ? statusTone(row[c.key])
                        : "text-[#e2e8f0]"
                    }`}
                  >
                    {hasValue(row[c.key]) ? String(row[c.key]) : ""}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <label className="block text-xs text-[#94a3b8]">
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[#64748b]">
        {label}
      </span>
      {children}
    </label>
  );
}

export function TextInput(props) {
  return (
    <input
      {...props}
      className={`w-full rounded-md border bg-[rgba(8,12,18,0.9)] px-2.5 py-1.5 text-sm text-[#f1f5f9] outline-none focus:border-[rgba(34,211,238,0.45)] ${props.className || ""}`}
      style={{ borderColor: "rgba(34, 211, 238, 0.18)", ...(props.style || {}) }}
    />
  );
}

export function SelectInput(props) {
  return (
    <select
      {...props}
      className={`w-full rounded-md border bg-[rgba(8,12,18,0.9)] px-2.5 py-1.5 text-sm text-[#f1f5f9] outline-none ${props.className || ""}`}
      style={{ borderColor: "rgba(34, 211, 238, 0.18)", ...(props.style || {}) }}
    />
  );
}

export function PrimaryButton({ children, ...props }) {
  return (
    <button
      type="button"
      {...props}
      className={`rounded-md px-3 py-1.5 text-sm font-medium text-[#041016] disabled:opacity-50 ${props.className || ""}`}
      style={{
        background: "linear-gradient(135deg, #22d3ee, #38bdf8)",
        ...(props.style || {}),
      }}
    >
      {children}
    </button>
  );
}

export function ResultsPlaceholder({ text = "Configure and run to see results" }) {
  return (
    <div
      className="rounded-lg border border-dashed px-3 py-4"
      style={{ borderColor: "rgba(34, 211, 238, 0.16)" }}
    >
      <p className="text-[11px] text-[#64748b]">{text}</p>
    </div>
  );
}
