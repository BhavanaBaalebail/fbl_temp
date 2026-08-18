/**
 * Enterprise-style generation progress window
 */

import { HardwareModule } from "../ui/HardwareModule";
import { theme } from "../../utils/theme";

function StepIcon({ status }) {
  if (status === "done") {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
        ✓
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="flex h-5 w-5 items-center justify-center text-cyan-400 animate-spin">
        ⟳
      </span>
    );
  }
  return <span className="flex h-5 w-5 items-center justify-center text-[#475569]">…</span>;
}

export function GenerationProgress({ progressSteps, visible }) {
  if (!visible || !progressSteps.length) return null;

  return (
    <HardwareModule
      icon="diagnostics"
      title="Generating Report"
      subtitle="Processing telemetry and building document"
      accentColor={theme.cyan}
      className="animate-fade-in"
    >
      <ul className="space-y-3">
        {progressSteps.map((step) => (
          <li key={step.id} className="flex items-center gap-3">
            <StepIcon status={step.status} />
            <span
              className={`text-sm ${
                step.status === "active"
                  ? "font-medium text-[#22d3ee]"
                  : step.status === "done"
                    ? "text-[#94a3b8]"
                    : "text-[#64748b]"
              }`}
            >
              {step.label}
            </span>
          </li>
        ))}
      </ul>
    </HardwareModule>
  );
}
