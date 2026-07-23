/**
 * JSON report export handler.
 */

export function exportReportJson(reportData) {
  const payload = {
    ...reportData,
    generatedAt: reportData.generatedAt?.toISOString?.() || reportData.generatedAt,
    span: {
      ...reportData.span,
      start: reportData.span?.start?.toISOString?.() || null,
      end: reportData.span?.end?.toISOString?.() || null,
    },
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${sanitizeFilename(reportData.title)}_${stamp}.json`;
  return { blob, filename, pageCount: null, sizeBytes: blob.size, format: "json" };
}

function sanitizeFilename(name) {
  return (name || "Hardware_Monitoring_Report").replace(/[^\w-]+/g, "_").slice(0, 60);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
