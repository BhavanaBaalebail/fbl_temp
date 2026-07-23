/**
 * Output format selector — professional format cards
 */

import { HardwareModule } from "../ui/HardwareModule";
import { theme } from "../../utils/theme";

export function OutputFormatSelector({ supportedFormats, selectedFormats, toggleFormat }) {
  return (
    <HardwareModule
      icon="report"
      title="Output Format"
      subtitle="Select export formats — only fully supported backends are enabled"
      accentColor={theme.blue}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {supportedFormats.map((format) => {
          const active = selectedFormats.includes(format.id);
          return (
            <button
              key={format.id}
              type="button"
              disabled={!format.supported}
              onClick={() => toggleFormat(format.id)}
              className="flex flex-col items-center gap-2 rounded-xl border px-3 py-4 text-center transition"
              style={{
                borderColor: active ? "rgba(34, 211, 238, 0.4)" : "rgba(34, 211, 238, 0.12)",
                background: active
                  ? "rgba(34, 211, 238, 0.08)"
                  : "rgba(8, 12, 18, 0.5)",
                opacity: format.supported ? 1 : 0.4,
                boxShadow: active ? "0 0 20px rgba(34, 211, 238, 0.1)" : "none",
              }}
            >
              <span
                className="text-lg font-bold tracking-wide"
                style={{ color: active ? theme.cyan : "#64748b" }}
              >
                {format.label}
              </span>
              <span className="text-[10px] leading-snug text-[#64748b]">
                {format.description}
              </span>
            </button>
          );
        })}
      </div>
    </HardwareModule>
  );
}
