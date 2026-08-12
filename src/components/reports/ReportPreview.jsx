/**
 * Live document-style report preview
 */

import { HardwareModule } from "../ui/HardwareModule";
import { theme } from "../../utils/theme";

export function ReportPreview({ previewPages, reportData }) {
  return (
    <HardwareModule
      icon="report"
      title="Report Preview"
      subtitle="Document layout preview — no file generated until you click Generate Report"
      accentColor={theme.cyan}
      noPadding
    >
      <div className="max-h-[420px] overflow-y-auto px-5 pb-5">
        {previewPages.length === 0 ? (
          <p className="py-8 text-center text-sm text-[#64748b]">
            Select report sections to preview document pages.
          </p>
        ) : (
          <div className="space-y-4">
            {previewPages.map((page) => (
              <article
                key={page.page}
                className="animate-fade-in rounded-lg border p-4 transition"
                style={{
                  borderColor: "rgba(34, 211, 238, 0.12)",
                  background: "rgba(255, 255, 255, 0.02)",
                  boxShadow: "0 4px 24px rgba(0, 0, 0, 0.2)",
                }}
              >
                <div
                  className="mb-3 flex items-center justify-between border-b pb-2"
                  style={{ borderColor: "rgba(34, 211, 238, 0.08)" }}
                >
                  <span className="font-mono-metrics text-[10px] uppercase tracking-widest text-[#64748b]">
                    Page {page.page}
                  </span>
                  <span className="text-xs font-medium text-[#94a3b8]">{page.title}</span>
                </div>
                <ul className="space-y-1.5">
                  {page.sections.map((item, i) => (
                    <li
                      key={`${page.page}-${i}`}
                      className={`text-sm ${
                        i === 0 && page.sections.length > 1
                          ? "font-semibold text-[#e2e8f0]"
                          : "text-[#94a3b8]"
                      }`}
                    >
                      {item}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}

        {reportData && (
          <p className="mt-4 text-center font-mono-metrics text-[10px] text-[#475569]">
            Preview · {reportData.intervalLabel} · {reportData.sampleCount} sample(s)
          </p>
        )}
      </div>
    </HardwareModule>
  );
}
