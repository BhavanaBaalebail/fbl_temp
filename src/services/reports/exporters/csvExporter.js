/**
 * CSV report export — actual historical records from SQLite-backed report data.
 * Missing values are blank (never fabricated zeros).
 */

function sanitizeFilename(name) {
  return (name || "Hardware_Monitoring_Report").replace(/[^\w-]+/g, "_").slice(0, 60);
}

function escapeCsv(value) {
  if (value == null || value === "") return "";
  const str = String(value);
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
  lines.push(`Metadata,Data Source,${escapeCsv(reportData.dataSource)}`);
  lines.push(`Metadata,Raw Samples,${escapeCsv(reportData.dataCoverage?.rawSampleCount ?? reportData.telemetryRawCount)}`);
  lines.push(`Metadata,Report Points,${escapeCsv(reportData.dataCoverage?.reportPointCount ?? reportData.sampleCount)}`);
  lines.push(`Metadata,Coverage Status,${escapeCsv(reportData.dataCoverage?.status)}`);
  lines.push(`Metadata,Coverage Percent,${escapeCsv(reportData.dataCoverage?.coveragePercent)}`);
  lines.push(`Metadata,Requested Start,${escapeCsv(reportData.dataCoverage?.requestedStartIso)}`);
  lines.push(`Metadata,Requested End,${escapeCsv(reportData.dataCoverage?.requestedEndIso)}`);
  lines.push(`Metadata,Available Start,${escapeCsv(reportData.dataCoverage?.availableStartIso)}`);
  lines.push(`Metadata,Available End,${escapeCsv(reportData.dataCoverage?.availableEndIso)}`);
  lines.push(`Metadata,Hostname,${escapeCsv(reportData.executive?.hostname)}`);
  lines.push(`Coverage,Notice,${escapeCsv(reportData.dataCoverage?.notice)}`);
  lines.push("");

  const samples = reportData.telemetry || reportData.rawSamples || [];
  if (samples.length) {
    lines.push("Historical Telemetry");
    lines.push(
      rowsToCsv([
        [
          "timestamp",
          "component",
          "metric",
          "value",
          "severity",
          "threshold",
          "fault",
          "status",
        ],
        ...samples.flatMap((s) => {
          const ts = s.timestamp || (s.t != null ? new Date(s.t).toISOString() : "");
          const rows = [];
          const push = (component, metric, value) => {
            if (value == null || value === "") return;
            rows.push([ts, component, metric, value, "", "", "", ""]);
          };
          push("CPU", "usage_percent", s.cpu_usage);
          push("CPU", "temperature_celsius", s.cpu_temp);
          push("CPU", "load_1min", s.cpu_load_1);
          push("RAM", "usage_percent", s.mem_usage);
          push("RAM", "available_gb", s.mem_available_gb);
          push("RAM", "swap_percent", s.mem_swap);
          push("GPU", "utilization_percent", s.gpu_util);
          push("GPU", "vram_percent", s.gpu_vram);
          push("GPU", "temperature_celsius", s.gpu_temp);
          push("NIC", "utilization_percent", s.nic_util);
          push("NIC", "rx_mbps", s.nic_rx);
          push("NIC", "tx_mbps", s.nic_tx);
          push("NIC", "errors", s.nic_errors);
          push("DISK", "busy_percent", s.io_busy);
          push("IO", "throughput_mb_s", s.io_total_mbps);
          push("IO", "iops", s.io_iops);
          push("IO", "queue_depth", s.io_queue);
          push("IO", "latency_ms", s.io_latency);
          return rows;
        }),
      ])
    );
    lines.push("");
  }

  if (reportData.faults?.length || reportData.faultEvents?.length) {
    const faults = reportData.faultEvents || reportData.faults;
    lines.push("Fault Events");
    lines.push(
      rowsToCsv([
        [
          "timestamp",
          "eventType",
          "eventId",
          "component",
          "severity",
          "metric",
          "value",
          "threshold",
          "action",
          "result",
          "status",
          "duration",
          "corrected",
        ],
        ...faults.map((f) => [
          f.t != null ? new Date(f.t).toISOString() : f.faultDetected || "",
          "fault",
          f.eventId || "",
          f.component,
          f.severity,
          f.metric || f.metricName || "",
          f.observedValue ?? f.currentValue ?? f.peakValue ?? "",
          f.threshold ?? f.thresholdCrossed ?? "",
          f.recoveryAction || "",
          f.finalStatus || "",
          f.status || "",
          f.duration || f.durationLabel || "",
          f.correctedAt || f.faultCorrected || "",
        ]),
      ])
    );
    lines.push("");
  }

  if (reportData.recoveryHistory?.length || reportData.recoveryEvents?.length) {
    const recoveries = reportData.recoveryEvents || reportData.recoveryHistory;
    lines.push("Recovery History");
    lines.push(
      rowsToCsv([
        [
          "timestamp",
          "eventType",
          "eventId",
          "component",
          "severity",
          "metric",
          "value",
          "threshold",
          "action",
          "result",
          "status",
          "process",
          "pid",
          "faultEventId",
          "verification",
          "remarks",
        ],
        ...recoveries.map((r) => [
          r.timestamp || (r.t != null ? new Date(r.t).toISOString() : ""),
          "recovery",
          r.recoveryId || "",
          r.component,
          "",
          "",
          "",
          "",
          r.action,
          r.result,
          r.status,
          r.process,
          r.pid,
          r.faultEventId || "",
          r.verification || "",
          r.correlation || r.remarks || "",
        ]),
      ])
    );
    lines.push("");
  }

  if (reportData.significantEvents?.length) {
    lines.push("Significant Events");
    lines.push(
      rowsToCsv([
        [
          "timestamp",
          "eventType",
          "eventId",
          "component",
          "severity",
          "metric",
          "value",
          "threshold",
          "action",
          "result",
        ],
        ...reportData.significantEvents.map((s) => [
          s.timestamp || (s.t != null ? new Date(s.t).toISOString() : ""),
          "spike",
          s.id || "",
          s.component,
          s.severity || "",
          s.metric || "",
          s.peak ?? "",
          s.threshold ?? "",
          s.recoveryCorrelation || "",
          s.faultCorrelation || "",
        ]),
      ])
    );
    lines.push("");
  }

  if (reportData.infrastructureTimeline?.length) {
    lines.push("Infrastructure Timeline");
    lines.push(
      rowsToCsv([
        ["timestamp", "eventType", "eventId", "component", "severity", "metric", "value", "threshold", "action", "result"],
        ...reportData.infrastructureTimeline.map((item) => [
          item.timestamp || (item.t != null ? new Date(item.t).toISOString() : ""),
          item.kind || "",
          item.id || "",
          item.component || "",
          item.severity || "",
          "",
          "",
          "",
          item.label || "",
          item.detail || "",
        ]),
      ])
    );
    lines.push("");
  }

  if (reportData.activitySummary?.length) {
    lines.push("Activity Summary");
    lines.push(
      rowsToCsv([
        ["category", "count", "firstEvent", "lastEvent", "highestSeverity", "recoveryActions", "result"],
        ...reportData.activitySummary.map((r) => [
          r.category,
          r.count,
          r.firstEvent,
          r.lastEvent,
          r.highestSeverity,
          r.recoveryActions,
          r.result,
        ]),
      ])
    );
    lines.push("");
  }

  if (reportData.digitalTwin?.length) {
    lines.push("Digital Twin Simulations");
    lines.push(
      rowsToCsv([
        ["timestamp", "component", "action", "risk", "confidence", "approved", "executed", "result"],
        ...reportData.digitalTwin.map((s) => [
          s.timestamp,
          s.component,
          s.action,
          s.risk,
          s.confidence,
          s.approved,
          s.executed,
          s.result,
        ]),
      ])
    );
  }

  const csv = lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${sanitizeFilename(reportData.title)}_${stamp}.csv`;
  return { blob, filename, pageCount: null, sizeBytes: blob.size, format: "csv" };
}
