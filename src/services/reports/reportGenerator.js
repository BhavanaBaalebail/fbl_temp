/**
 * Report generation orchestrator with progress workflow.
 */

import { buildReportData } from "./reportDataBuilder";
import { exportReportPdf } from "./exporters/pdfExporter";
import { exportReportJson, downloadBlob } from "./exporters/jsonExporter";
import { exportReportCsv } from "./exporters/csvExporter";
import { exportReportDocx } from "./exporters/docxExporter";
import { addReportHistoryEntry, getReportBlobs } from "./reportHistoryManager";

export const SUPPORTED_FORMATS = [
  { id: "pdf", label: "PDF", description: "Enterprise document layout", supported: true },
  { id: "docx", label: "DOCX", description: "Microsoft Word document", supported: true },
  { id: "json", label: "JSON", description: "Structured telemetry export", supported: true },
  { id: "csv", label: "CSV", description: "Metrics & fault spreadsheet", supported: true },
];

export const GENERATION_STEPS = [
  { id: "telemetry", label: "Collecting Hardware Telemetry" },
  { id: "metrics", label: "Processing Metrics" },
  { id: "charts", label: "Generating Charts" },
  { id: "building", label: "Building Report" },
  { id: "ai", label: "Embedding AI Summary" },
  { id: "finalizing", label: "Finalizing Document" },
];

const EXPORTERS = {
  pdf: exportReportPdf,
  json: exportReportJson,
  csv: exportReportCsv,
  docx: exportReportDocx,
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} config — report configuration from UI
 * @param {string[]} formats — output format ids
 * @param {(stepIndex: number, status: string) => void} onProgress
 */
export async function generateReport(config, formats, onProgress) {
  const steps = GENERATION_STEPS.length;

  for (let i = 0; i < steps - 1; i += 1) {
    onProgress?.(i, "active");
    await delay(350 + i * 80);
    onProgress?.(i, "done");
  }

  onProgress?.(steps - 1, "active");

  const reportData = buildReportData(config);
  reportData.generatedAt = new Date();

  const outputs = {};
  let primaryPageCount = null;
  let primarySize = 0;

  for (const format of formats) {
    const exporter = EXPORTERS[format];
    if (!exporter) continue;
    const result =
      format === "docx" ? await exporter(reportData) : exporter(reportData);
    outputs[format] = result;
    if (format === "pdf") {
      primaryPageCount = result.pageCount;
      primarySize = result.sizeBytes;
    } else if (!primarySize) {
      primarySize = result.sizeBytes;
    }
  }

  onProgress?.(steps - 1, "done");

  const historyEntry = addReportHistoryEntry({
    name: reportData.title,
    reportType: reportData.intervalLabel,
    formats: Object.keys(outputs),
    status: "ready",
    pageCount: primaryPageCount,
    fileSize: primarySize,
    outputs: Object.fromEntries(
      Object.entries(outputs).map(([fmt, o]) => [
        fmt,
        { filename: o.filename, sizeBytes: o.sizeBytes, pageCount: o.pageCount },
      ])
    ),
    blobs: outputs,
  });

  return {
    reportData,
    outputs,
    historyEntry,
    pageCount: primaryPageCount,
    fileSize: primarySize,
    generatedAt: reportData.generatedAt,
  };
}

export function downloadFormatOutput(outputs, format) {
  const output = outputs[format];
  if (!output?.blob) return;
  downloadBlob(output.blob, output.filename);
}

export function downloadFromHistoryEntry(entry, format) {
  const blobs = getReportBlobs(entry.id);
  const output = blobs?.[format];
  if (!output?.blob) return;
  downloadBlob(output.blob, output.filename);
}

/** Backward-compatible one-click PDF download */
export async function downloadPerformanceReport(intervalKey) {
  const reportData = buildReportData({ intervalKey });
  const result = exportReportPdf(reportData);
  downloadBlob(result.blob, result.filename);
  return { filename: result.filename, reportData };
}

export { buildReportData };
