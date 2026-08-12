/**
 * Smoke-test report builders/exporters against SQLite /reports/data payload.
 * Usage: npx vite-node scripts/report-logbook-smoke.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { buildReportDataFromHistory } from "../src/services/reports/reportDataBuilder.js";
import { filterSelectedSections } from "../src/services/reports/reportSections.js";
import { exportReportPdf } from "../src/services/reports/exporters/pdfExporter.js";
import { exportReportJson } from "../src/services/reports/exporters/jsonExporter.js";
import { exportReportCsv } from "../src/services/reports/exporters/csvExporter.js";
import { exportReportDocx } from "../src/services/reports/exporters/docxExporter.js";

mkdirSync(".report_review", { recursive: true });

const api = JSON.parse(readFileSync(".report_review/api-1h.json", "utf8"));

// Preserve real telemetry; inject one recovery (no fault) to verify audit-trail path
const now = Date.now() / 1000;
if (!(api.recovery_history || []).length) {
  api.recovery_history = [
    {
      collected_at: now - 600,
      timestamp: new Date((now - 600) * 1000).toISOString(),
      action: "gpu.terminate_process",
      component: "GPU",
      pid: 4242,
      process: "gpu-workload",
      success: 1,
      result: "success",
      message: "Process terminated; GPU utilization confirmed decreasing",
      entry_json: JSON.stringify({
        action: "gpu.terminate_process",
        success: true,
        verification: "process terminated",
        message: "Process terminated; GPU utilization confirmed decreasing",
      }),
    },
  ];
  api.recovery_count = 1;
  if (api.dataCoverage) api.dataCoverage.recoveryEventCount = 1;
}

const reportData = buildReportDataFromHistory(api, {
  intervalKey: "1h",
  title: "Infrastructure Health & Incident Report",
  generatedBy: "smoke-test",
});
reportData.activeSections = filterSelectedSections(reportData, null);

const asserts = [];
const check = (name, ok, detail = "") => {
  asserts.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "OK" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

check("faultEvents empty (no fabrication)", (reportData.faultEvents || []).length === 0);
check("recoveryEvents retained", (reportData.recoveryEvents || []).length === 1);
check(
  "recovery without fault correlation note",
  String(reportData.recoveryEvents?.[0]?.correlation || "").toLowerCase().includes("without") ||
    String(reportData.recoveryEvents?.[0]?.correlation || "").toLowerCase().includes("not available")
);
check("activitySummary present", (reportData.activitySummary || []).length >= 5);
check(
  "systemResourceTrend object present",
  !!reportData.systemResourceTrend && Array.isArray(reportData.systemResourceTrend.series),
  `series=${reportData.systemResourceTrend?.series?.length || 0} (needs >=2 points per metric)`
);
check("faultRecoveryChains includes orphan recovery", (reportData.faultRecoveryChains || []).some((c) => !c.faultId));
check("infrastructureTimeline has recovery", (reportData.infrastructureTimeline || []).some((i) => i.kind === "RECOVERY"));

const pdf = exportReportPdf(reportData);
writeFileSync(".report_review/logbook-smoke.pdf", Buffer.from(await pdf.blob.arrayBuffer()));
check("pdf pages", pdf.pageCount >= 4, `pages=${pdf.pageCount}`);

const json = exportReportJson(reportData);
writeFileSync(".report_review/logbook-smoke.json", Buffer.from(await json.blob.arrayBuffer()));
const jsonObj = JSON.parse(readFileSync(".report_review/logbook-smoke.json", "utf8"));
check("json has faultEvents", Array.isArray(jsonObj.faultEvents));
check("json has recoveryEvents", Array.isArray(jsonObj.recoveryEvents) && jsonObj.recoveryEvents.length === 1);
check("json has activitySummary", Array.isArray(jsonObj.activitySummary));
check("json has graphSeries", !!jsonObj.graphSeries);

const csv = exportReportCsv(reportData);
writeFileSync(".report_review/logbook-smoke.csv", Buffer.from(await csv.blob.arrayBuffer()));
const csvText = readFileSync(".report_review/logbook-smoke.csv", "utf8");
check("csv has Recovery History", csvText.includes("Recovery History"));
check("csv has Activity Summary", csvText.includes("Activity Summary"));

const docx = await exportReportDocx(reportData);
writeFileSync(".report_review/logbook-smoke.docx", Buffer.from(await docx.blob.arrayBuffer()));
check("docx size", docx.sizeBytes > 1000, `bytes=${docx.sizeBytes}`);

const failed = asserts.filter((a) => !a.ok);
console.log(`\n${asserts.length - failed.length}/${asserts.length} checks passed`);
if (failed.length) process.exit(1);
