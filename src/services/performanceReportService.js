/**
 * Performance Report Service — backward-compatible facade over modular report services.
 */

export { buildReportData } from "./reports/reportDataBuilder";
export {
  generateReport,
  downloadPerformanceReport,
  downloadFormatOutput,
  SUPPORTED_FORMATS,
  GENERATION_STEPS,
} from "./reports/reportGenerator";
export {
  exportReportPdf,
  downloadReportPdf as generatePerformanceReportPdf,
} from "./reports/exporters/pdfExporter";
