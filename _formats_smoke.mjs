import { buildReportDataFromHistory } from "./src/services/reports/reportDataBuilder.js";
import { exportReportDocx } from "./src/services/reports/exporters/docxExporter.js";
import { exportReportJson } from "./src/services/reports/exporters/jsonExporter.js";
import { exportReportCsv } from "./src/services/reports/exporters/csvExporter.js";
import { exportReportPdf } from "./src/services/reports/exporters/pdfExporter.js";
import { writeFileSync } from "fs";

const now = Date.now() / 1000;
const report = buildReportDataFromHistory(
  {
    range: "1h",
    telemetry_raw_count: 12,
    telemetry: [
      {
        collected_at: now - 120,
        cpu_usage_percent: 2,
        memory_usage_percent: 20,
        hostname: "h",
      },
      {
        collected_at: now,
        cpu_usage_percent: 3,
        memory_usage_percent: 21,
        hostname: "h",
      },
    ],
    faults: [],
    recovery_history: [],
    digital_twin_simulations: [],
    dataCoverage: {
      status: "PARTIAL",
      coveragePercent: 50,
      rawSampleCount: 12,
      reportPointCount: 2,
      requestedStart: now - 3600,
      requestedEnd: now,
      availableStart: now - 120,
      availableEnd: now,
      notice: "partial",
      requestedStartIso: "a",
      requestedEndIso: "b",
      availableStartIso: "c",
      availableEndIso: "d",
      faultEventCount: 0,
      recoveryEventCount: 0,
      digitalTwinCount: 0,
    },
  },
  { intervalKey: "1h", title: "Infrastructure Health & Incident Report" }
);

const pdf = exportReportPdf(report);
const docx = await exportReportDocx(report);
const json = exportReportJson(report);
const csv = exportReportCsv(report);

writeFileSync(
  ".report_review/formats-smoke.pdf",
  Buffer.from(await pdf.blob.arrayBuffer())
);
writeFileSync(
  ".report_review/formats-smoke.docx",
  Buffer.from(await docx.blob.arrayBuffer())
);
writeFileSync(".report_review/formats-smoke.json", await json.blob.text());
writeFileSync(".report_review/formats-smoke.csv", await csv.blob.text());

const parsed = JSON.parse(await json.blob.text());
console.log({
  pdfPages: pdf.pageCount,
  docxBytes: docx.sizeBytes,
  jsonRaw: parsed.reportMetadata.rawSampleCount,
  jsonPoints: parsed.reportMetadata.reportPointCount,
  csvHasRaw: (await csv.blob.text()).includes("Raw Samples"),
  emptySafe: report.dataCoverage.status,
});
