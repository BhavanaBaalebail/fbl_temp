/**
 * CSV report export handler — flattens hardware metrics and fault events.
 */

function sanitizeFilename(name) {
  return (name || "Hardware_Monitoring_Report").replace(/[^\w-]+/g, "_").slice(0, 60);
}

function escapeCsv(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowsToCsv(rows) {
  return rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
}

export function exportReportCsv(reportData) {
  const lines = [];

  lines.push("Section,Field,Value");
  lines.push(`Metadata,Title,${escapeCsv(reportData.title)}`);
  lines.push(`Metadata,Generated At,${escapeCsv(reportData.generatedAt?.toISOString?.())}`);
  lines.push(`Metadata,Interval,${escapeCsv(reportData.intervalLabel)}`);
  lines.push(`Metadata,Hostname,${escapeCsv(reportData.executive?.hostname)}`);
  lines.push(`Metadata,Health Score,${escapeCsv(reportData.executive?.healthScore)}`);
  lines.push("");

  if (reportData.hardwareMetrics?.length) {
    lines.push("Hardware Metrics");
    lines.push(rowsToCsv([["Metric", "Avg", "Min", "Max", "Current", "Trend"], ...reportData.hardwareMetrics]));
    lines.push("");
  }

  if (reportData.faults?.length) {
    lines.push("Fault Events");
    lines.push(
      rowsToCsv([
        ["Timestamp", "Severity", "Component", "Metric", "Value", "Description"],
        ...reportData.faults.map((f) => [
          new Date(f.t).toISOString(),
          f.severity,
          f.component,
          f.metricName || "",
          f.currentValue || "",
          f.description || "",
        ]),
      ])
    );
    lines.push("");
  }

  if (reportData.recoveryHistory?.length) {
    lines.push("Recovery History");
    lines.push(
      rowsToCsv([
        ["Timestamp", "Component", "Result", "Duration (ms)", "Outcome"],
        ...reportData.recoveryHistory.map((r) => [
          r.timestamp,
          r.component,
          r.result,
          r.durationMs,
          r.verificationOutcome || r.reason || "",
        ]),
      ])
    );
    lines.push("");
  }

  if (reportData.recommendations?.length) {
    lines.push("Recommendations");
    reportData.recommendations.forEach((rec, i) => {
      lines.push(`Recommendation ${i + 1},${escapeCsv(rec)}`);
    });
  }

  const csv = lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${sanitizeFilename(reportData.title)}_${stamp}.csv`;
  return { blob, filename, pageCount: null, sizeBytes: blob.size, format: "csv" };
}
