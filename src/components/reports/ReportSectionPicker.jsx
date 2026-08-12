/**
 * Report content section picker — enterprise-style checkboxes
 */

import { HardwareModule } from "../ui/HardwareModule";
import { theme } from "../../utils/theme";

export function ReportSectionPicker({ availableSections, sectionSelection, toggleSection, compact }) {
  return (
    <HardwareModule
      icon="chart"
      title="Report Content"
      subtitle={compact ? undefined : "Include only sections backed by live telemetry"}
      accentColor={theme.blue}
    >
      {availableSections.length === 0 ? (
        <p className="text-sm text-[#64748b]">
          No report sections available yet. Connect to the telemetry server and wait for samples to accumulate.
        </p>
      ) : (
        <div className={`grid gap-2 ${compact ? "grid-cols-1" : "sm:grid-cols-2"}`}>
          {availableSections.map((section) => {
            const checked = sectionSelection[section.id] !== false;
            return (
              <label
                key={section.id}
                className="group flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition hover:border-cyan-500/30"
                style={{
                  borderColor: checked ? "rgba(34, 211, 238, 0.25)" : "rgba(34, 211, 238, 0.1)",
                  background: checked ? "rgba(34, 211, 238, 0.04)" : "rgba(8, 12, 18, 0.4)",
                }}
              >
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded border transition"
                  style={{
                    borderColor: checked ? theme.cyan : "rgba(100, 116, 139, 0.5)",
                    background: checked ? "rgba(34, 211, 238, 0.2)" : "transparent",
                  }}
                >
                  {checked && (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path
                        d="M2 5l2.5 2.5L8 3"
                        stroke="#22d3ee"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={checked}
                  onChange={() => toggleSection(section.id)}
                />
                <span className="text-sm text-[#cbd5e1] group-hover:text-[#f1f5f9]">
                  {section.label}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </HardwareModule>
  );
}
