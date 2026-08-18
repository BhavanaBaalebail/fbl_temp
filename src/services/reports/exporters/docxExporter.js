/**
 * DOCX report export — editable Times New Roman professional report.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  Header,
  Footer,
  PageNumber,
  AlignmentType,
} from "docx";

const FONT = "Times New Roman";
const NAVY = "003366";

function sanitizeFilename(name) {
  return (name || "Infrastructure_Health_Incident_Report").replace(/[^\w-]+/g, "_").slice(0, 60);
}

function sectionEnabled(reportData, id) {
  if (!reportData.activeSections) return true;
  return reportData.activeSections[id] === true;
}

function t(text, opts = {}) {
  return new TextRun({
    text: String(text ?? ""),
    font: FONT,
    size: opts.size || 20,
    bold: opts.bold || false,
    italics: opts.italics || false,
    color: opts.color,
  });
}

function heading(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({
    heading: level,
    spacing: { before: 240, after: 120 },
    children: [t(text, { bold: true, size: level === HeadingLevel.HEADING_1 ? 28 : 24 })],
  });
}

function body(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 80 },
    children: [t(text, { size: opts.size || 20, italics: opts.italics, bold: opts.bold })],
  });
}

function cell(text, opts = {}) {
  return new TableCell({
    width: { size: opts.w || 1500, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
    },
    shading: opts.header ? { fill: NAVY } : undefined,
    children: [
      new Paragraph({
        children: [
          t(text, {
            bold: opts.header || opts.bold,
            size: opts.header ? 16 : 18,
            color: opts.header ? "FFFFFF" : undefined,
          }),
        ],
      }),
    ],
  });
}

function simpleTable(headers, rows) {
  const colW = Math.floor(9000 / Math.max(headers.length, 1));
  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    rows: [
      new TableRow({
        children: headers.map((h) => cell(h, { header: true, w: colW })),
      }),
      ...rows.map(
        (row) =>
          new TableRow({
            children: row.map((c) => cell(c, { w: colW })),
          })
      ),
    ],
  });
}

function kvRows(pairs) {
  return pairs.map(([k, v]) => [String(k), String(v ?? "-")]);
}

export async function exportReportDocx(reportData) {
  const children = [];
  const exec = reportData.executive || {};
  const cov = reportData.dataCoverage || {};
  const raw = cov.rawSampleCount ?? reportData.telemetryRawCount ?? 0;
  const points = cov.reportPointCount ?? reportData.sampleCount ?? 0;

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [t("FBL", { bold: true, size: 48, color: NAVY })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [t("INFRASTRUCTURE HEALTH & INCIDENT REPORT", { bold: true, size: 32, color: NAVY })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [t("Hardware Monitoring & Autonomous Recovery", { size: 22, italics: true })],
    })
  );

  children.push(
    simpleTable(
      ["Field", "Value"],
      kvRows([
        ["Host", exec.hostname || reportData.hostname || "-"],
        ["Operating System", exec.os || "Not Available"],
        ["Reporting Period", reportData.intervalLabel || "-"],
        ["Requested Window", `${cov.requestedStartIso || "-"} -> ${cov.requestedEndIso || "-"}`],
        ["Available Historical Data", `${cov.availableStartIso || "-"} -> ${cov.availableEndIso || "-"}`],
        ["Generated", reportData.generatedAt?.toLocaleString?.() || "-"],
        ["Data Source", reportData.dataSource || "SQLite via /reports/data"],
        ["Raw Samples", raw],
        ["Report Points", points],
        ["Report ID", reportData.reportId || "-"],
      ])
    )
  );

  if (sectionEnabled(reportData, "executiveSummary")) {
    children.push(heading("2. Executive Summary", HeadingLevel.HEADING_1));
    children.push(
      simpleTable(
        ["KPI", "Value"],
        kvRows([
          ["Overall Health", exec.overallHealth],
          ["Health Score", exec.healthScore],
          ["Critical Faults", exec.criticalAlerts],
          ["Warning Faults", exec.warningAlerts],
          ["Recovered Faults", exec.recoveredFaults],
          ["Unresolved Faults", exec.unresolvedFaults],
          ["Recovery Actions", exec.recoveryActions ?? reportData.recoveryHistory?.length ?? 0],
          ["Data Coverage", `${exec.dataCoveragePercent ?? cov.coveragePercent ?? "-"}% (${cov.status || "-"})`],
        ])
      )
    );
    children.push(body(exec.summary || ""));
  }

  if (sectionEnabled(reportData, "dataCoverage") && cov) {
    children.push(heading("3. Historical Data Coverage", HeadingLevel.HEADING_1));
    children.push(
      simpleTable(
        ["Field", "Value"],
        kvRows([
          ["Status", cov.status],
          ["Requested Start", cov.requestedStartIso],
          ["Requested End", cov.requestedEndIso],
          ["Available Start", cov.availableStartIso],
          ["Available End", cov.availableEndIso],
          ["Coverage %", cov.coveragePercent],
          ["Raw Samples", raw],
          ["Report Points", points],
          ["Fault Events", cov.faultEventCount],
          ["Recovery Events", cov.recoveryEventCount],
        ])
      )
    );
    if (cov.notice) children.push(body(cov.notice, { italics: true }));
    if (cov.incomplete || cov.empty) {
      children.push(body(`WARNING: ${cov.status} HISTORICAL COVERAGE`, { bold: true }));
    }
  }

  if (sectionEnabled(reportData, "hardwareHealthOverview") && reportData.componentOverview?.length) {
    children.push(heading("4. Component Health Overview", HeadingLevel.HEADING_1));
    children.push(
      simpleTable(
        ["Component", "Status", "Avg", "Peak", "Min", "Warn", "Crit", "Trend"],
        reportData.componentOverview.map((r) => [
          r.component,
          r.status,
          r.avg,
          r.peak,
          r.min,
          r.warnings,
          r.criticals,
          r.trend,
        ])
      )
    );
  }

  (reportData.componentSections || []).forEach((comp, idx) => {
    children.push(heading(`5.${idx + 1} ${comp.title || comp.name}`, HeadingLevel.HEADING_1));
    children.push(body(`Status: ${comp.status}`));
    if (comp.stats) {
      children.push(
        body(
          `Average: ${comp.stats.avg ?? "-"} | Peak: ${comp.stats.max ?? "-"} | Min: ${comp.stats.min ?? "-"} | Trend: ${comp.stats.trend || "-"}`
        )
      );
    }
    if (comp.peakAt) children.push(body(`Peak at: ${comp.peakAt}`));
    children.push(body("Latest Recorded Values", { bold: true }));
    (comp.latestRecorded || []).forEach((pair) => {
      const [k, v] = Array.isArray(pair) ? pair : [pair.metric, pair.value];
      children.push(body(`${k}: ${v}`));
    });
    if (comp.interpretation) {
      children.push(body("Engineering Interpretation", { bold: true }));
      children.push(body(comp.interpretation));
    }
  });

  if (sectionEnabled(reportData, "historicalTrends")) {
    children.push(heading("6. Infrastructure Historical Trends", HeadingLevel.HEADING_1));
    children.push(
      body(
        "Historical telemetry charts, fault markers, and recovery markers for the selected reporting window. Chart point series are embedded as tabular series summaries for editability."
      )
    );
    const sys = reportData.systemResourceTrend || reportData.graphs?.overallHealth;
    if (sys?.series?.length) {
      children.push(heading(sys.title || "System Resource Utilization", HeadingLevel.HEADING_2));
      sys.series.forEach((s) => {
        children.push(
          body(`${s.label}: ${s.points?.length || 0} points | unit ${s.unit || "%"}`, { italics: true })
        );
      });
    }
    if (reportData.loadShare?.slices?.length) {
      children.push(heading(reportData.loadShare.title || "Load Share by Component", HeadingLevel.HEADING_2));
      children.push(
        simpleTable(
          ["Component", "Utilization", "Share"],
          reportData.loadShare.slices.map((s) => [
            s.name,
            s.util != null ? `${s.util}%` : "—",
            `${s.share ?? 0}%`,
          ])
        )
      );
    }
    (reportData.componentSections || []).forEach((comp) => {
      (comp.charts || []).forEach((ch) => {
        children.push(
          body(
            `Chart: ${ch.title || ch.key} (${ch.unit || ch.yLabel || ""}) — ${ch.points?.length || 0} points` +
              (ch.eventMarkers?.faults?.length
                ? ` | fault markers: ${ch.eventMarkers.faults.map((m) => m.label).join(", ")}`
                : ""),
            { italics: true }
          )
        );
      });
    });
    children.push(heading("Fault Events Over Time", HeadingLevel.HEADING_2));
    if (!(reportData.faultEvents || []).length) {
      children.push(body("0 FAULT EVENTS"));
      children.push(
        body("No warning or critical events were recorded during the selected reporting period.")
      );
    } else {
      children.push(
        simpleTable(
          ["Event ID", "Time", "Component", "Severity"],
          (reportData.faultEvents || []).map((f) => [
            f.eventId,
            f.faultDetected || "",
            f.component,
            f.severity,
          ])
        )
      );
    }
    children.push(heading("Recovery Actions Over Time", HeadingLevel.HEADING_2));
    if (!(reportData.recoveryEvents || reportData.recoveryHistory || []).length) {
      children.push(body("No recovery actions recorded."));
    } else {
      children.push(
        simpleTable(
          ["Recovery ID", "Time", "Component", "Action", "Result"],
          (reportData.recoveryEvents || reportData.recoveryHistory || []).map((r) => [
            r.recoveryId || "",
            r.time || r.timestamp || "",
            r.component,
            r.action,
            r.result,
          ])
        )
      );
    }
  }

  if (sectionEnabled(reportData, "predictiveMaintenance") && reportData.predictiveMaintenance) {
    const pm = reportData.predictiveMaintenance;
    children.push(heading("6b. Predictive Maintenance", HeadingLevel.HEADING_1));
    children.push(
      body(
        pm.disclaimer ||
          "Predictive Maintenance estimates when a monitored metric may cross an operational threshold if the current trend continues. It does not predict exact hardware failure or guarantee future system behavior."
      )
    );
    children.push(
      body(
        `Analysis window: last ~${pm.windowHours || 6} hours (${pm.sampleCount || 0} SQLite samples). Risk is derived from current value, threshold distance, OLS trend, and confidence. Advisory only — not used for automatic recovery.`
      )
    );
    if ((pm.rows || []).length) {
      children.push(
        simpleTable(
          [
            "Metric",
            "Current",
            "Warning",
            "Critical",
            "Trend",
            "Est. warning",
            "Est. critical",
            "Confidence",
            "Risk",
            "Recommendation",
          ],
          pm.rows.map((r) => [
            r.metric,
            r.current,
            r.warning,
            r.critical,
            r.trend,
            r.etaWarning,
            r.etaCritical,
            r.confidence,
            r.risk,
            r.recommendation,
          ])
        )
      );
    } else {
      children.push(body("No predictive rows available for this period."));
    }
  }

  if (sectionEnabled(reportData, "faultTimeline")) {
    children.push(heading("7. Fault & Incident Log", HeadingLevel.HEADING_1));
    if (!(reportData.faultEvents || []).length) {
      children.push(
        body(
          reportData.faultIncidentLog?.emptyMessage ||
            reportData.logbookEmptyMessage ||
            "NO FAULT EVENTS RECORDED"
        )
      );
      children.push(
        body(
          "No warning or critical fault events were recorded in the selected historical reporting period."
        )
      );
    } else {
      children.push(
        simpleTable(
          [
            "Event ID",
            "Timestamp",
            "Component",
            "Severity",
            "Fault",
            "Metric",
            "Value",
            "Threshold",
            "Corrected",
            "Duration",
            "Recovery",
            "Status",
          ],
          (reportData.faultEvents || []).map((r) => [
            r.eventId,
            r.faultDetected || "",
            r.component,
            r.severity,
            r.faultReason || "",
            r.metric || "",
            r.observedValue ?? "",
            r.threshold ?? "",
            r.correctedAt || "",
            r.duration || "",
            r.recoveryAction || "None",
            r.finalStatus || "",
          ])
        )
      );
      (reportData.faultDetailCards || []).forEach((card) => {
        children.push(heading(`FAULT EVENT ${card.eventId}`, HeadingLevel.HEADING_2));
        children.push(
          simpleTable(
            ["Field", "Value"],
            kvRows([
              ["Component", card.component],
              ["Severity", card.severity],
              ["Reason", card.reason],
              ["Detected", card.detected],
              ["Peak", card.peak],
              ["Threshold", card.threshold],
              ["Corrected", card.corrected],
              ["Duration", card.duration],
              ["Recovery", card.recovery],
              ["Result", card.result],
              ["Remarks", card.remarks],
            ])
          )
        );
      });
    }
  }

  if (sectionEnabled(reportData, "recoveryHistory")) {
    children.push(heading("8. Recovery Action Log", HeadingLevel.HEADING_1));
    if (!(reportData.recoveryEvents || reportData.recoveryHistory || []).length) {
      children.push(body("No recovery actions recorded."));
    } else {
      children.push(
        simpleTable(
          [
            "Recovery ID",
            "Time",
            "Component",
            "Action",
            "Trigger",
            "PID",
            "Process",
            "Fault ID",
            "Result",
            "Verification",
            "Status",
            "Remarks",
          ],
          (reportData.recoveryEvents || reportData.recoveryHistory || []).map((r) => [
            r.recoveryId || "",
            r.time || r.timestamp || "",
            r.component,
            r.action,
            r.trigger || "",
            r.pid,
            r.process,
            r.faultEventId || "Not available",
            r.result,
            r.verification || "",
            r.status,
            r.correlation || r.remarks || "",
          ])
        )
      );
    }
  }

  if (sectionEnabled(reportData, "faultRecoveryTimeline") || sectionEnabled(reportData, "recoveryHistory")) {
    children.push(heading("9. Fault -> Recovery Timeline", HeadingLevel.HEADING_1));
    const chains = reportData.faultRecoveryChains || [];
    if (!chains.length && !(reportData.infrastructureTimeline || []).length) {
      children.push(body("No fault or recovery timeline events in the selected period."));
    }
    chains.forEach((chain) => {
      children.push(
        body(
          chain.faultId
            ? `${chain.faultId} (${chain.component})`
            : `Recovery without linked fault (${chain.component})`,
          { bold: true }
        )
      );
      (chain.steps || []).forEach((step) => {
        children.push(body(`-> ${step.stage}: ${step.detail}`));
      });
    });
    (reportData.infrastructureTimeline || []).forEach((item) => {
      children.push(
        body(`${item.timestamp || ""} | ${item.kind} | ${item.component || "-"} | ${item.label}`)
      );
    });
  }

  if (sectionEnabled(reportData, "spikeAnalysis")) {
    children.push(heading("10. Significant Event / Spike Analysis", HeadingLevel.HEADING_1));
    if (!(reportData.significantEvents || []).length) {
      children.push(
        body(
          reportData.significantEventsEmptyMessage ||
            "No significant threshold-related spikes detected."
        )
      );
    } else {
      (reportData.significantEvents || []).forEach((s) => {
        children.push(body(`${s.id} ${s.timestamp || ""} ${s.component} / ${s.metric}`, { bold: true }));
        children.push(
          body(
            `Baseline ${s.baseline} | Peak ${s.peak}${s.unit || ""} | +${s.increasePct}% | Threshold ${s.threshold} | Fault ${s.faultCorrelation} | Recovery ${s.recoveryCorrelation}`
          )
        );
        children.push(body(s.interpretation || ""));
      });
    }
  }

  if (sectionEnabled(reportData, "activitySummary")) {
    children.push(heading("11. Infrastructure Activity Summary", HeadingLevel.HEADING_1));
    children.push(
      simpleTable(
        ["Category", "Count", "First Event", "Last Event", "Highest Severity", "Recoveries", "Result"],
        (reportData.activitySummary || []).map((r) => [
          r.category,
          r.count,
          r.firstEvent,
          r.lastEvent,
          r.highestSeverity,
          r.recoveryActions,
          r.result,
        ])
      )
    );
  }

  if (sectionEnabled(reportData, "recommendations")) {
    children.push(heading("12. Recommendations", HeadingLevel.HEADING_1));
    const rec = reportData.recommendations;
    if (rec && !Array.isArray(rec)) {
      [
        ["Immediate Actions", rec.immediate],
        ["Preventive Actions", rec.preventive],
        ["Monitoring Recommendations", rec.monitoring],
      ].forEach(([title, list]) => {
        children.push(heading(title, HeadingLevel.HEADING_2));
        (list || ["No corrective action is currently required."]).forEach((item, i) =>
          children.push(body(`${i + 1}. ${item}`))
        );
      });
    } else {
      (rec || []).forEach((item, i) => children.push(body(`${i + 1}. ${item}`)));
    }
  }

  if (sectionEnabled(reportData, "rawTelemetry")) {
    children.push(heading("13. Appendix / Report Metadata", HeadingLevel.HEADING_1));
    children.push(body(`Data source: ${reportData.dataSource || "-"}`));
    children.push(body(`Raw samples: ${raw} | Report points: ${points}`));
    children.push(
      body(
        "Lifecycle: TELEMETRY -> EVENT DETECTION -> FAULT -> RCA -> RECOVERY -> VERIFICATION -> STATUS"
      )
    );
    children.push(body("Pipeline: CM.py -> SQLite -> /reports/data -> Historical Analysis -> Report"));
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          styles: [{ id: "Normal", run: { font: FONT, size: 20 } }],
        },
      },
    },
    sections: [
      {
        properties: {},
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [t("FBL | Infrastructure Health & Incident Report", { bold: true, size: 16, color: NAVY })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  t("FBL • Infrastructure Monitoring  |  Confidential  |  Page ", { size: 14 }),
                  new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 14 }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBlob(doc);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${sanitizeFilename(reportData.title)}_${stamp}.docx`;
  return { blob: buffer, filename, pageCount: null, sizeBytes: buffer.size, format: "docx" };
}
