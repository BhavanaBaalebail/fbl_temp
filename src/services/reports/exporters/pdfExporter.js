/**
 * Infrastructure Health & Incident Report — PDF exporter (jsPDF only).
 * Corporate navy layout, Times-Roman typography, large readable charts.
 */

import { jsPDF } from "jspdf";

const NAVY = [0, 51, 102];
const WHITE = [255, 255, 255];
const DARK = [30, 30, 30];
const GRAY = [100, 100, 100];
const LIGHT_GRAY = [230, 233, 238];
const GRID = [220, 225, 232];
const GREEN = [0, 128, 0];
const ORANGE = [204, 102, 0];
const RED = [178, 34, 34];
const BLUE = [0, 82, 147];

const MARGIN = 14;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_Y = 287;
const CONTENT_BOTTOM = 278;
const HEADER_H = 16;
const CHART_H = 72;

const COMP_SECTION_IDS = {
  CPU: "cpuAnalysis",
  GPU: "gpuAnalysis",
  RAM: "memoryAnalysis",
  Memory: "memoryAnalysis",
  DISK: "storageAnalysis",
  Storage: "storageAnalysis",
  NIC: "networkAnalysis",
  Network: "networkAnalysis",
  IO: "ioAnalysis",
  "I/O": "ioAnalysis",
  "IO Control": "ioAnalysis",
  Disk: "storageAnalysis",
};

function sectionOn(reportData, id) {
  if (!reportData?.activeSections) return true;
  return reportData.activeSections[id] === true;
}

function sanitizeFilename(name) {
  return (name || "Infrastructure_Health_Incident_Report").replace(/[^\w-]+/g, "_").slice(0, 60);
}

/** jsPDF built-in Times is WinAnsi — strip/replace Unicode that corrupts glyphs. */
function pdfSafe(value) {
  if (value == null) return "";
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/→/g, "->")
    .replace(/←/g, "<-")
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .replace(/±/g, "+/-")
    .replace(/°/g, " deg")
    .replace(/·/g, "|")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, "...")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
}

function fmt(v, fallback = "-") {
  if (v == null || v === "") return fallback;
  if (typeof v === "number" && Number.isFinite(v)) {
    if (Number.isInteger(v)) return String(v);
    return Math.abs(v) >= 100 ? String(Math.round(v * 100) / 100) : Number(v).toFixed(2);
  }
  return pdfSafe(v);
}

function fmtDate(v) {
  if (v == null || v === "") return "-";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "-" : pdfSafe(v.toLocaleString());
  if (typeof v === "number") {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? "-" : pdfSafe(d.toLocaleString());
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? pdfSafe(v) : pdfSafe(d.toLocaleString());
}

function shortTime(ms) {
  if (ms == null || !Number.isFinite(ms)) return "";
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function statusColor(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("critical") || s.includes("unhealthy")) return RED;
  if (s.includes("warn")) return ORANGE;
  if (s.includes("healthy") || s.includes("ok") || s.includes("normal") || s.includes("complete")) return GREEN;
  return GRAY;
}

function setFont(doc, style = "normal") {
  doc.setFont("times", style);
}

function drawNavyBar(doc, y, h) {
  doc.setFillColor(...NAVY);
  doc.rect(0, y, PAGE_W, h, "F");
}

function addPageHeader(doc, title) {
  drawNavyBar(doc, 0, HEADER_H);
  doc.setTextColor(...WHITE);
  setFont(doc, "bold");
  doc.setFontSize(10);
  doc.text("FBL  ·  Infrastructure Health & Incident Report", MARGIN, 10.5);
  setFont(doc, "normal");
  doc.setFontSize(8);
  const short = String(title || "").slice(0, 42);
  if (short) doc.text(short, PAGE_W - MARGIN, 10.5, { align: "right" });
}

function addPageFooter(doc, pageIndex, pageCount) {
  drawNavyBar(doc, FOOTER_Y, 10);
  doc.setTextColor(...WHITE);
  setFont(doc, "normal");
  doc.setFontSize(7);
  doc.text("FBL  ·  Confidential", MARGIN, FOOTER_Y + 6.5);
  doc.text("Hardware Monitoring & Autonomous Recovery", PAGE_W / 2, FOOTER_Y + 6.5, { align: "center" });
  doc.text(`Page ${pageIndex} of ${pageCount}`, PAGE_W - MARGIN, FOOTER_Y + 6.5, { align: "right" });
}

/** Ensure vertical space; start new content page only when needed. */
function ensureSpace(doc, y, needed, title) {
  if (y + needed <= CONTENT_BOTTOM) return y;
  doc.addPage();
  addPageHeader(doc, title);
  return HEADER_H + 10;
}

function sectionTitle(doc, text, y, pageTitle) {
  y = ensureSpace(doc, y, 14, pageTitle);
  doc.setTextColor(...NAVY);
  setFont(doc, "bold");
  doc.setFontSize(14);
  doc.text(pdfSafe(text), MARGIN, y);
  y += 2;
  doc.setDrawColor(...NAVY);
  doc.setLineWidth(0.4);
  doc.line(MARGIN, y, MARGIN + CONTENT_W, y);
  return y + 7;
}

function bodyText(doc, text, y, pageTitle, opts = {}) {
  const size = opts.size || 9;
  const style = opts.style || "normal";
  const color = opts.color || DARK;
  const maxW = opts.maxW || CONTENT_W;
  const x = opts.x || MARGIN;
  const lineH = opts.lineH || size * 0.42;
  setFont(doc, style);
  doc.setFontSize(size);
  doc.setTextColor(...color);
  const lines = doc.splitTextToSize(pdfSafe(text || ""), maxW);
  lines.forEach((line) => {
    y = ensureSpace(doc, y, lineH + 1, pageTitle);
    doc.text(line, x, y);
    y += lineH;
  });
  return y;
}

function calloutBox(doc, y, text, pageTitle, kind = "warn") {
  const fill = kind === "empty" ? [255, 235, 235] : kind === "ok" ? [232, 245, 233] : [255, 244, 229];
  const border = kind === "empty" ? RED : kind === "ok" ? GREEN : ORANGE;
  const lines = doc.splitTextToSize(pdfSafe(text || ""), CONTENT_W - 8);
  const h = Math.max(12, lines.length * 4.2 + 8);
  y = ensureSpace(doc, y, h + 2, pageTitle);
  doc.setFillColor(...fill);
  doc.setDrawColor(...border);
  doc.setLineWidth(0.5);
  doc.roundedRect(MARGIN, y - 4, CONTENT_W, h, 1.5, 1.5, "FD");
  setFont(doc, "bold");
  doc.setFontSize(9);
  doc.setTextColor(...border);
  let ty = y + 2;
  lines.forEach((line) => {
    doc.text(line, MARGIN + 4, ty);
    ty += 4.2;
  });
  return y - 4 + h + 4;
}

/**
 * Simple key/value or multi-column table.
 * columns: [{ key, label, w }] — widths in mm summing ≈ CONTENT_W
 * rows: array of objects or arrays
 */
function drawTable(doc, y, columns, rows, pageTitle, opts = {}) {
  const rowH = opts.rowH || 6.5;
  const fontSize = opts.fontSize || 7.5;
  const headerH = 7;
  const x0 = MARGIN;

  const drawHeader = (yy) => {
    doc.setFillColor(...NAVY);
    doc.rect(x0, yy, CONTENT_W, headerH, "F");
    setFont(doc, "bold");
    doc.setFontSize(fontSize);
    doc.setTextColor(...WHITE);
    let cx = x0 + 1.5;
    columns.forEach((col) => {
      doc.text(pdfSafe(String(col.label)), cx, yy + 4.8);
      cx += col.w;
    });
    return yy + headerH;
  };

  y = ensureSpace(doc, y, headerH + rowH, pageTitle);
  y = drawHeader(y);

  (rows || []).forEach((row, idx) => {
    y = ensureSpace(doc, y, rowH + 1, pageTitle);
    if (y === HEADER_H + 10) y = drawHeader(y);
    if (idx % 2 === 0) {
      doc.setFillColor(248, 250, 252);
      doc.rect(x0, y, CONTENT_W, rowH, "F");
    }
    doc.setDrawColor(...LIGHT_GRAY);
    doc.setLineWidth(0.1);
    doc.line(x0, y + rowH, x0 + CONTENT_W, y + rowH);
    setFont(doc, "normal");
    doc.setFontSize(fontSize);
    doc.setTextColor(...DARK);
    let cx = x0 + 1.5;
    columns.forEach((col, ci) => {
      let val = Array.isArray(row) ? row[ci] : row[col.key];
      if (col.key === "status" || col.key === "result") {
        doc.setTextColor(...statusColor(val));
      } else {
        doc.setTextColor(...DARK);
      }
      const cell = fmt(val).slice(0, col.maxChars || Math.floor(col.w * 2.2));
      doc.text(cell, cx, y + rowH - 1.8);
      cx += col.w;
    });
    y += rowH;
  });
  return y + 3;
}

function kvTable(doc, y, pairs, pageTitle) {
  const labelW = 58;
  const valueW = CONTENT_W - labelW;
  const rowH = 6.2;
  (pairs || []).forEach(([label, value], idx) => {
    const lines = doc.splitTextToSize(fmt(value), valueW - 3);
    const h = Math.max(rowH, lines.length * 4 + 2);
    y = ensureSpace(doc, y, h + 1, pageTitle);
    if (idx % 2 === 0) {
      doc.setFillColor(246, 248, 251);
      doc.rect(MARGIN, y, CONTENT_W, h, "F");
    }
    setFont(doc, "bold");
    doc.setFontSize(8);
    doc.setTextColor(...NAVY);
    doc.text(String(label), MARGIN + 2, y + 4.2);
    setFont(doc, "normal");
    doc.setTextColor(...DARK);
    let ty = y + 4.2;
    lines.forEach((ln) => {
      doc.text(ln, MARGIN + labelW, ty);
      ty += 4;
    });
    y += h;
  });
  return y + 3;
}

function resolveDomainMs(reportData, points) {
  const g = reportData.graphs || {};
  let start = g.domainStart ?? g.availableStart ?? reportData.dataCoverage?.availableStart;
  let end = g.domainEnd ?? g.availableEnd ?? reportData.dataCoverage?.availableEnd;
  if (start != null && start < 1e12) start *= 1000;
  if (end != null && end < 1e12) end *= 1000;
  const times = (points || []).map((p) => p.t).filter((t) => t != null);
  if (start == null && times.length) start = Math.min(...times);
  if (end == null && times.length) end = Math.max(...times);
  if (start == null || end == null || end <= start) {
    const now = Date.now();
    return { start: now - 3600000, end: now };
  }
  return { start, end };
}

function computeYScale(points, warning, critical, unit) {
  const vals = (points || []).map((p) => p.v).filter((v) => v != null && Number.isFinite(v));
  const dataMax = vals.length ? Math.max(...vals) : 0;
  const u = String(unit || "").toLowerCase();
  const isPct = u.includes("%") || u.includes("percent") || u.includes("utilization") || u.includes("usage") || u.includes("busy") || u.includes("vram");
  let min = 0;
  let max;
  if (isPct) {
    // Fixed 0-100% scale so warning/critical lines are meaningful and comparable.
    max = 100;
  } else {
    max = dataMax;
    [warning, critical].forEach((t) => {
      if (t != null && Number.isFinite(Number(t))) max = Math.max(max, Number(t));
    });
    if (max <= 0) max = 1;
    max *= 1.15;
  }
  return { min, max, range: max - min || 1 };
}

/**
 * Large single-series line chart with grid, axes, thresholds, gap breaks.
 */
function drawLineChart(doc, chart, x, y, w, h, reportData) {
  const points = (chart?.points || []).filter((p) => p && p.t != null && p.v != null);
  doc.setDrawColor(...NAVY);
  doc.setLineWidth(0.35);
  doc.setFillColor(252, 253, 255);
  doc.rect(x, y, w, h, "FD");

  if (points.length < 2) {
    setFont(doc, "italic");
    doc.setFontSize(8);
    doc.setTextColor(...GRAY);
    doc.text("Insufficient data points for chart", x + w / 2, y + h / 2, { align: "center" });
    return;
  }

  const { start: domainMin, end: domainMax } = resolveDomainMs(reportData, points);
  const domain = domainMax - domainMin || 1;
  const warning = chart.warning != null ? Number(chart.warning) : null;
  const critical = chart.critical != null ? Number(chart.critical) : null;
  const { min, max, range } = computeYScale(points, warning, critical, chart.unit || chart.yLabel);
  const padL = 12;
  const padB = 8;
  const plotX = x + padL;
  const plotY = y + 3;
  const plotW = w - padL - 4;
  const plotH = h - padB - 6;

  // Optional gap shading from report gaps
  (reportData.gaps || []).forEach((gap) => {
    let gs = gap.start;
    let ge = gap.end;
    if (gs == null || ge == null) return;
    if (gs < 1e12) gs *= 1000;
    if (ge < 1e12) ge *= 1000;
    if (ge < domainMin || gs > domainMax) return;
    const x1 = plotX + ((Math.max(gs, domainMin) - domainMin) / domain) * plotW;
    const x2 = plotX + ((Math.min(ge, domainMax) - domainMin) / domain) * plotW;
    doc.setFillColor(255, 245, 245);
    doc.rect(x1, plotY, Math.max(x2 - x1, 0.4), plotH, "F");
  });

  // Grid + Y ticks
  const yTicks = 4;
  setFont(doc, "normal");
  doc.setFontSize(6.5);
  for (let i = 0; i <= yTicks; i += 1) {
    const gy = plotY + (plotH / yTicks) * i;
    const val = max - (range / yTicks) * i;
    doc.setDrawColor(...GRID);
    doc.setLineWidth(0.15);
    doc.line(plotX, gy, plotX + plotW, gy);
    doc.setTextColor(...GRAY);
    const label = Math.abs(val) >= 100 ? String(Math.round(val)) : String(Math.round(val * 10) / 10);
    doc.text(label, plotX - 1.5, gy + 1.5, { align: "right" });
  }

  // Threshold dashed lines
  const drawThresh = (thresh, color, label) => {
    if (thresh == null || !Number.isFinite(thresh) || thresh < min || thresh > max) return;
    const ty = plotY + plotH - ((thresh - min) / range) * plotH;
    doc.setDrawColor(...color);
    doc.setLineWidth(0.35);
    doc.setLineDashPattern([1.2, 1.2], 0);
    doc.line(plotX, ty, plotX + plotW, ty);
    doc.setLineDashPattern([], 0);
    setFont(doc, "normal");
    doc.setFontSize(6);
    doc.setTextColor(...color);
    doc.text(label, plotX + plotW - 1, ty - 1, { align: "right" });
  };
  drawThresh(warning, ORANGE, `Warn ${warning}`);
  drawThresh(critical, RED, `Crit ${critical}`);

  // Series with gap breaks
  const gapThresholdMs =
    reportData.bucketSeconds != null
      ? Math.max(reportData.bucketSeconds * 3000, 5 * 60 * 1000)
      : 15 * 60 * 1000;
  doc.setDrawColor(...BLUE);
  doc.setLineWidth(0.7);
  for (let i = 0; i < points.length - 1; i += 1) {
    const p1 = points[i];
    const p2 = points[i + 1];
    if (p2.t - p1.t > gapThresholdMs) continue;
    const x1 = plotX + ((p1.t - domainMin) / domain) * plotW;
    const x2 = plotX + ((p2.t - domainMin) / domain) * plotW;
    const y1 = plotY + plotH - ((p1.v - min) / range) * plotH;
    const y2 = plotY + plotH - ((p2.v - min) / range) * plotH;
    doc.line(x1, y1, x2, y2);
  }

  // Fault / recovery markers overlaid on metric charts
  const markers = chart.eventMarkers || {};
  (markers.faults || []).forEach((m) => {
    if (m.t == null || m.t < domainMin || m.t > domainMax) return;
    const mx = plotX + ((m.t - domainMin) / domain) * plotW;
    const sev = String(m.severity || "").toLowerCase();
    doc.setFillColor(...(sev.includes("crit") ? RED : ORANGE));
    doc.circle(mx, plotY + 4, 1.4, "F");
    doc.setDrawColor(...(sev.includes("crit") ? RED : ORANGE));
    doc.setLineWidth(0.25);
    doc.line(mx, plotY + 5.5, mx, plotY + plotH);
    setFont(doc, "normal");
    doc.setFontSize(5.5);
    doc.setTextColor(...(sev.includes("crit") ? RED : ORANGE));
    doc.text(pdfSafe(m.label || "FAULT"), mx + 1, plotY + 3.5);
  });
  (markers.recoveries || []).forEach((m) => {
    if (m.t == null || m.t < domainMin || m.t > domainMax) return;
    const mx = plotX + ((m.t - domainMin) / domain) * plotW;
    doc.setFillColor(...GREEN);
    doc.circle(mx, plotY + plotH - 4, 1.4, "F");
    setFont(doc, "normal");
    doc.setFontSize(5.5);
    doc.setTextColor(...GREEN);
    doc.text(pdfSafe(m.label || "REC"), mx + 1, plotY + plotH - 2);
  });

  // X ticks (3–5)
  const tickCount = Math.min(5, Math.max(3, points.length >= 5 ? 5 : 3));
  doc.setTextColor(...GRAY);
  doc.setFontSize(6);
  setFont(doc, "normal");
  for (let i = 0; i < tickCount; i += 1) {
    const t = domainMin + (domain / (tickCount - 1)) * i;
    const tx = plotX + ((t - domainMin) / domain) * plotW;
    doc.setDrawColor(...GRID);
    doc.line(tx, plotY + plotH, tx, plotY + plotH + 1.5);
    const align = i === 0 ? "left" : i === tickCount - 1 ? "right" : "center";
    doc.text(shortTime(t), tx, plotY + plotH + 5, { align });
  }

  // Axis labels
  doc.setTextColor(...NAVY);
  doc.setFontSize(7);
  setFont(doc, "bold");
  doc.text("Time", x + w / 2, y + h - 0.5, { align: "center" });
  const yLabel = pdfSafe(chart.yLabel || chart.unit || "Value");
  doc.text(String(yLabel).slice(0, 22), x + 2, y + 3);
}

const SERIES_COLORS = [
  [0, 82, 147],
  [0, 128, 90],
  [140, 60, 160],
  [178, 34, 34],
  [204, 102, 0],
];

/** Multi-series % chart (CPU/RAM/GPU) — same scale only. */
function drawMultiSeriesChart(doc, chart, x, y, w, h, reportData) {
  const series = (chart?.series || []).filter((s) => (s.points || []).length >= 2);
  doc.setDrawColor(...NAVY);
  doc.setLineWidth(0.35);
  doc.setFillColor(252, 253, 255);
  doc.rect(x, y, w, h, "FD");
  if (!series.length) {
    setFont(doc, "italic");
    doc.setFontSize(8);
    doc.setTextColor(...GRAY);
    doc.text("Insufficient data points for chart", x + w / 2, y + h / 2, { align: "center" });
    return;
  }
  const allPoints = series.flatMap((s) => s.points);
  const { start: domainMin, end: domainMax } = resolveDomainMs(reportData, allPoints);
  const domain = domainMax - domainMin || 1;
  const warning = series.map((s) => s.warning).find((v) => v != null);
  const critical = series.map((s) => s.critical).find((v) => v != null);
  const { min, max, range } = computeYScale(allPoints, warning, critical, "%");
  const padL = 12;
  const padB = 10;
  const plotX = x + padL;
  const plotY = y + 3;
  const plotW = w - padL - 4;
  const plotH = h - padB - 8;

  const yTicks = 4;
  setFont(doc, "normal");
  doc.setFontSize(6.5);
  for (let i = 0; i <= yTicks; i += 1) {
    const gy = plotY + (plotH / yTicks) * i;
    const val = max - (range / yTicks) * i;
    doc.setDrawColor(...GRID);
    doc.setLineWidth(0.15);
    doc.line(plotX, gy, plotX + plotW, gy);
    doc.setTextColor(...GRAY);
    doc.text(String(Math.round(val)), plotX - 1.5, gy + 1.5, { align: "right" });
  }

  const drawThresh = (thresh, color, label) => {
    if (thresh == null || !Number.isFinite(Number(thresh))) return;
    const tv = Number(thresh);
    if (tv < min || tv > max) return;
    const ty = plotY + plotH - ((tv - min) / range) * plotH;
    doc.setDrawColor(...color);
    doc.setLineWidth(0.35);
    doc.setLineDashPattern([1.2, 1.2], 0);
    doc.line(plotX, ty, plotX + plotW, ty);
    doc.setLineDashPattern([], 0);
    doc.setFontSize(6);
    doc.setTextColor(...color);
    doc.text(label, plotX + plotW - 1, ty - 1, { align: "right" });
  };
  drawThresh(warning, ORANGE, `Warn ${warning}`);
  drawThresh(critical, RED, `Crit ${critical}`);

  const gapThresholdMs =
    reportData.bucketSeconds != null
      ? Math.max(reportData.bucketSeconds * 3000, 5 * 60 * 1000)
      : 15 * 60 * 1000;

  series.forEach((s, si) => {
    const color = SERIES_COLORS[si % SERIES_COLORS.length];
    const pts = s.points.filter((p) => p && p.t != null && p.v != null);
    doc.setDrawColor(...color);
    doc.setLineWidth(0.65);
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      if (p2.t - p1.t > gapThresholdMs) continue;
      const x1 = plotX + ((p1.t - domainMin) / domain) * plotW;
      const x2 = plotX + ((p2.t - domainMin) / domain) * plotW;
      const y1 = plotY + plotH - ((p1.v - min) / range) * plotH;
      const y2 = plotY + plotH - ((p2.v - min) / range) * plotH;
      doc.line(x1, y1, x2, y2);
    }
  });

  // Legend
  let lx = plotX;
  series.forEach((s, si) => {
    const color = SERIES_COLORS[si % SERIES_COLORS.length];
    doc.setFillColor(...color);
    doc.rect(lx, y + h - 5.5, 3, 2, "F");
    setFont(doc, "normal");
    doc.setFontSize(6);
    doc.setTextColor(...DARK);
    doc.text(pdfSafe(s.label || s.key), lx + 4, y + h - 4);
    lx += 28;
  });

  const tickCount = 5;
  doc.setTextColor(...GRAY);
  doc.setFontSize(6);
  for (let i = 0; i < tickCount; i += 1) {
    const t = domainMin + (domain / (tickCount - 1)) * i;
    const tx = plotX + ((t - domainMin) / domain) * plotW;
    doc.setDrawColor(...GRID);
    doc.line(tx, plotY + plotH, tx, plotY + plotH + 1.5);
    const align = i === 0 ? "left" : i === tickCount - 1 ? "right" : "center";
    doc.text(shortTime(t), tx, plotY + plotH + 5, { align });
  }
  doc.setTextColor(...NAVY);
  doc.setFontSize(7);
  setFont(doc, "bold");
  doc.text(pdfSafe(chart.yLabel || "Utilization (%)"), x + 2, y + 3);
}

/** Fault / recovery event markers over time (severity bands). */
function drawEventScatterChart(doc, events, x, y, w, h, reportData, emptyTitle) {
  doc.setDrawColor(...NAVY);
  doc.setLineWidth(0.35);
  doc.setFillColor(252, 253, 255);
  doc.rect(x, y, w, h, "FD");

  const items = (events || []).filter((e) => e.t != null);
  if (!items.length) {
    setFont(doc, "bold");
    doc.setFontSize(11);
    doc.setTextColor(...GREEN);
    doc.text(emptyTitle || "0 FAULT EVENTS", x + w / 2, y + h / 2 - 3, { align: "center" });
    setFont(doc, "italic");
    doc.setFontSize(7.5);
    doc.setTextColor(...GRAY);
    doc.text(
      "No warning or critical events were recorded during the selected reporting period.",
      x + w / 2,
      y + h / 2 + 4,
      { align: "center", maxWidth: w - 10 }
    );
    return;
  }

  const { start: domainMin, end: domainMax } = resolveDomainMs(reportData, items);
  const domain = domainMax - domainMin || 1;
  const padL = 22;
  const padB = 8;
  const plotX = x + padL;
  const plotY = y + 4;
  const plotW = w - padL - 4;
  const plotH = h - padB - 6;

  const bands = [
    { key: "critical", y: 0.2, label: "Critical", color: RED, match: (e) => String(e.severity || e.kind || "").toLowerCase().includes("crit") },
    { key: "warning", y: 0.5, label: "Warning", color: ORANGE, match: (e) => String(e.severity || e.kind || "").toLowerCase().includes("warn") },
    { key: "recovery", y: 0.8, label: "Recovery", color: GREEN, match: (e) => String(e.kind || e.eventType || "").toLowerCase().includes("recov") || e.recoveryId },
  ];

  bands.forEach((b) => {
    const by = plotY + plotH * b.y;
    doc.setDrawColor(...GRID);
    doc.setLineWidth(0.15);
    doc.line(plotX, by, plotX + plotW, by);
    setFont(doc, "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(...b.color);
    doc.text(b.label, plotX - 2, by + 1.5, { align: "right" });
  });

  items.forEach((e) => {
    if (e.t < domainMin || e.t > domainMax) return;
    const mx = plotX + ((e.t - domainMin) / domain) * plotW;
    let band = bands.find((b) => b.match(e)) || bands[1];
    if (String(e.kind || "").toUpperCase() === "RECOVERY" || e.recoveryId) band = bands[2];
    const by = plotY + plotH * band.y;
    doc.setFillColor(...band.color);
    if (band.key === "critical") {
      doc.circle(mx, by, 1.6, "F");
    } else if (band.key === "warning") {
      doc.setDrawColor(...band.color);
      doc.setFillColor(...band.color);
      doc.setLineWidth(0.2);
      // upward triangle via lines
      doc.line(mx, by - 1.8, mx - 1.6, by + 1.4);
      doc.line(mx - 1.6, by + 1.4, mx + 1.6, by + 1.4);
      doc.line(mx + 1.6, by + 1.4, mx, by - 1.8);
      doc.circle(mx, by, 0.6, "F");
    } else {
      // diamond
      doc.setDrawColor(...band.color);
      doc.setLineWidth(0.8);
      doc.line(mx, by - 1.8, mx + 1.5, by);
      doc.line(mx + 1.5, by, mx, by + 1.8);
      doc.line(mx, by + 1.8, mx - 1.5, by);
      doc.line(mx - 1.5, by, mx, by - 1.8);
    }
    setFont(doc, "normal");
    doc.setFontSize(5);
    doc.setTextColor(...DARK);
    doc.text(pdfSafe(e.id || e.label || ""), mx + 2, by - 2);
  });

  const tickCount = 5;
  doc.setTextColor(...GRAY);
  doc.setFontSize(6);
  for (let i = 0; i < tickCount; i += 1) {
    const t = domainMin + (domain / (tickCount - 1)) * i;
    const tx = plotX + ((t - domainMin) / domain) * plotW;
    doc.setDrawColor(...GRID);
    doc.line(tx, plotY + plotH, tx, plotY + plotH + 1.5);
    const align = i === 0 ? "left" : i === tickCount - 1 ? "right" : "center";
    doc.text(shortTime(t), tx, plotY + plotH + 5, { align });
  }
}

function placeChartBlock(doc, y, pageTitle, title, drawFn) {
  const blockH = CHART_H + 14;
  if (y + blockH > CONTENT_BOTTOM - 4) {
    doc.addPage();
    addPageHeader(doc, pageTitle);
    y = HEADER_H + 10;
  }
  setFont(doc, "bold");
  doc.setFontSize(10);
  doc.setTextColor(...NAVY);
  doc.text(pdfSafe(title), MARGIN, y);
  y += 3;
  drawFn(MARGIN, y, CONTENT_W, CHART_H);
  return y + CHART_H + 8;
}

function normalizeRecommendations(recs) {
  if (!recs) return { immediate: [], preventive: [], monitoring: [] };
  if (Array.isArray(recs)) {
    return { immediate: recs, preventive: [], monitoring: [] };
  }
  return {
    immediate: recs.immediate || [],
    preventive: recs.preventive || [],
    monitoring: recs.monitoring || [],
  };
}

/** Build component sections from redesigned shape or legacy builder fields. */
function getComponentSections(reportData) {
  if (Array.isArray(reportData.componentSections) && reportData.componentSections.length) {
    return reportData.componentSections;
  }
  const comps = reportData.componentAnalysis || [];
  const trends = reportData.trendSeries || reportData.graphs?.components || [];
  const visual = reportData.visualAnalysis || [];
  return comps.map((c) => {
    const name = c.name || "Component";
    const va = visual.find((v) => String(v.component).toLowerCase().includes(String(name).split(/[\s/]/)[0].toLowerCase()));
    const relatedCharts = (Array.isArray(trends) ? trends : [])
      .filter((s) => String(s.label || s.title || "").toLowerCase().includes(String(name).toLowerCase().split(/[\s/]/)[0]))
      .map((s) => ({
        title: s.label || s.title || name,
        unit: s.unit || "%",
        yLabel: s.unit || "%",
        points: s.points || [],
        warning: s.warning,
        critical: s.critical,
      }));
    return {
      name,
      title: `${name} Analysis`,
      status: c.level || c.status || "unknown",
      stats: c.stats || null,
      latestRecorded: c.liveMetrics || c.latestRecorded || [],
      thresholds: c.thresholds || null,
      warnCount: c.warnCount ?? 0,
      critCount: c.critCount ?? 0,
      charts: relatedCharts,
      interpretation: c.interpretation || va?.commentary || c.status || "",
      peakAt: c.peakAt || null,
    };
  });
}

function getComponentOverview(reportData) {
  if (Array.isArray(reportData.componentOverview) && reportData.componentOverview.length) {
    return reportData.componentOverview;
  }
  return (reportData.componentAnalysis || []).map((c) => ({
    component: c.name,
    status: statusLabel(c.level),
    avg: c.stats?.avg ?? "—",
    peak: c.stats?.max ?? "—",
    min: c.stats?.min ?? "—",
    thresholdLabel: c.thresholds ? fmt(c.thresholds) : "—",
    warnings: c.warnCount ?? 0,
    criticals: c.critCount ?? 0,
    trend: c.stats?.trend || "—",
  }));
}

function statusLabel(level) {
  const s = String(level || "").toLowerCase();
  if (s === "critical") return "Critical";
  if (s === "warning") return "Warning";
  if (s === "healthy") return "Healthy";
  return level ? String(level) : "Unknown";
}

function rawAndReportCounts(reportData) {
  const cov = reportData.dataCoverage || {};
  const raw =
    cov.rawSampleCount ??
    reportData.telemetryRawCount ??
    cov.telemetrySampleCount ??
    reportData.sampleCount ??
    0;
  const points =
    cov.reportPointCount ??
    reportData.sampleCount ??
    (reportData.telemetry || reportData.rawSamples || []).length ??
    0;
  return { raw, points };
}

/* ───────────────────────── main export ───────────────────────── */

export function exportReportPdf(reportData = {}) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageTitle = reportData.title || "Infrastructure Health & Incident Report";
  const exec = reportData.executive || {};
  const cov = reportData.dataCoverage || {};
  const { raw: rawSamples, points: reportPoints } = rawAndReportCounts(reportData);
  const generatedAt = reportData.generatedAt instanceof Date
    ? reportData.generatedAt
    : new Date(reportData.generatedAt || Date.now());
  const reportId =
    reportData.reportId ||
    `FBL-${generatedAt.getTime().toString(36).toUpperCase()}`;

  // ═══ 1. COVER ═══
  drawNavyBar(doc, 0, 52);
  doc.setTextColor(...WHITE);
  setFont(doc, "bold");
  doc.setFontSize(28);
  doc.text("FBL", PAGE_W / 2, 22, { align: "center" });
  doc.setFontSize(13);
  doc.text("INFRASTRUCTURE HEALTH & INCIDENT REPORT", PAGE_W / 2, 34, { align: "center" });
  setFont(doc, "normal");
  doc.setFontSize(10);
  doc.text("Hardware Monitoring & Autonomous Recovery", PAGE_W / 2, 44, { align: "center" });

  let y = 66;
  doc.setTextColor(...NAVY);
  setFont(doc, "bold");
  doc.setFontSize(12);
  doc.text(pageTitle, MARGIN, y);
  y += 8;

  const coverPairs = [
    ["Host", exec.hostname || reportData.hostname || "—"],
    ["Operating System", exec.os || "—"],
    ["Reporting Period", exec.requestedPeriod || reportData.intervalLabel || "—"],
    ["Requested Window", `${fmt(cov.requestedStartIso)}  →  ${fmt(cov.requestedEndIso)}`],
    [
      "Available Historical Data",
      exec.availablePeriod ||
        (cov.availableStartIso && cov.availableEndIso
          ? `${cov.availableStartIso}  →  ${cov.availableEndIso}`
          : "—"),
    ],
    ["Generated", fmtDate(generatedAt)],
    ["Generated By", reportData.generatedBy || "—"],
    ["Data Source", reportData.dataSource || "SQLite telemetry_history.db"],
    ["Database", reportData.database || "telemetry_history.db"],
    ["Raw Samples", String(rawSamples)],
    ["Report Points", String(reportPoints)],
    ["Report ID", reportId],
  ];
  if (reportData.description) {
    coverPairs.splice(2, 0, ["Description", reportData.description]);
  }
  y = kvTable(doc, y, coverPairs, pageTitle);

  // ═══ 2. EXECUTIVE SUMMARY ═══
  if (sectionOn(reportData, "executiveSummary")) {
    doc.addPage();
    addPageHeader(doc, pageTitle);
    y = HEADER_H + 10;
    y = sectionTitle(doc, "2. Executive Summary", y, pageTitle);

    const kpiRows = [
      {
        metric: "Overall System Health",
        value: fmt(exec.overallHealth),
        status: exec.overallHealth,
      },
      { metric: "Health Score", value: fmt(exec.healthScore), status: "" },
      { metric: "Critical Alerts", value: String(exec.criticalAlerts ?? 0), status: (exec.criticalAlerts ?? 0) > 0 ? "critical" : "healthy" },
      { metric: "Warning Alerts", value: String(exec.warningAlerts ?? 0), status: (exec.warningAlerts ?? 0) > 0 ? "warning" : "healthy" },
      { metric: "Recovered Faults", value: String(exec.recoveredFaults ?? 0), status: "" },
      { metric: "Unresolved Faults", value: String(exec.unresolvedFaults ?? (reportData.faults || []).length), status: "" },
      { metric: "Recovery Actions", value: String(exec.recoveryActions ?? (reportData.recoveryHistory || []).length), status: "" },
      {
        metric: "Data Coverage",
        value: exec.dataCoveragePercent != null ? `${exec.dataCoveragePercent}% (${exec.coverageStatus || cov.status || "—"})` : fmt(exec.coverageStatus || cov.status),
        status: cov.empty ? "critical" : cov.incomplete ? "warning" : "healthy",
      },
      { metric: "Monitoring Duration", value: fmt(exec.monitoringDuration), status: "" },
    ];
    y = drawTable(
      doc,
      y,
      [
        { key: "metric", label: "KPI", w: 70 },
        { key: "value", label: "Value", w: 72 },
        { key: "status", label: "Status", w: 40 },
      ],
      kpiRows,
      pageTitle,
      { fontSize: 8.5, rowH: 7 }
    );
    if (exec.summary) {
      y = bodyText(doc, exec.summary, y + 2, pageTitle, { size: 9, style: "italic" });
      y += 4;
    }
  }

  // ═══ 3. HISTORICAL DATA COVERAGE ═══
  if (sectionOn(reportData, "dataCoverage") && (reportData.dataCoverage || exec.dataCoveragePercent != null)) {
    y = ensureSpace(doc, y, 55, pageTitle);
    y = sectionTitle(doc, "3. Historical Data Coverage", y, pageTitle);
    const covPairs = [
      ["Coverage Status", cov.status || exec.coverageStatus || "—"],
      ["Requested Start", cov.requestedStartIso || "—"],
      ["Requested End", cov.requestedEndIso || "—"],
      ["Available Start", cov.availableStartIso || "—"],
      ["Available End", cov.availableEndIso || "—"],
      ["Database Start", cov.databaseStartIso || "—"],
      ["Database End", cov.databaseEndIso || "—"],
      ["Requested Duration", cov.requestedDurationLabel || "—"],
      ["Coverage Duration", cov.coverageDurationLabel || "—"],
      ["Coverage Percent", cov.coveragePercent != null ? `${cov.coveragePercent}%` : "—"],
      ["Raw Samples", String(cov.rawSampleCount ?? rawSamples)],
      ["Report Points", String(cov.reportPointCount ?? reportPoints)],
      ["Fault Events", String(cov.faultEventCount ?? (reportData.faults || []).length)],
      ["Recovery Events", String(cov.recoveryEventCount ?? (reportData.recoveryHistory || []).length)],
      ["Digital Twin Records", String(cov.digitalTwinCount ?? (reportData.digitalTwin || []).length)],
    ];
    y = kvTable(doc, y, covPairs, pageTitle);
    if (cov.empty || cov.status === "EMPTY") {
      y = calloutBox(
        doc,
        y,
        cov.notice || "EMPTY: No historical telemetry is available for the requested reporting period.",
        pageTitle,
        "empty"
      );
    } else if (cov.incomplete || cov.status === "PARTIAL") {
      y = calloutBox(
        doc,
        y,
        cov.notice || "PARTIAL: Historical data is incomplete for the requested period. Missing intervals were not fabricated.",
        pageTitle,
        "warn"
      );
    } else if (cov.notice) {
      y = calloutBox(doc, y, cov.notice, pageTitle, "ok");
    }
  }

  // ═══ 4. COMPONENT HEALTH OVERVIEW ═══
  const overview = getComponentOverview(reportData);
  if (sectionOn(reportData, "hardwareHealthOverview") && overview.length) {
    y = ensureSpace(doc, y, 40, pageTitle);
    y = sectionTitle(doc, "4. Component Health Overview", y, pageTitle);
    y = drawTable(
      doc,
      y,
      [
        { key: "component", label: "Component", w: 28 },
        { key: "status", label: "Status", w: 22 },
        { key: "avg", label: "Avg", w: 18 },
        { key: "peak", label: "Peak", w: 18 },
        { key: "min", label: "Min", w: 18 },
        { key: "warnings", label: "Warn", w: 16 },
        { key: "criticals", label: "Crit", w: 16 },
        { key: "trend", label: "Trend", w: 46 },
      ],
      overview.map((r) => ({
        component: r.component,
        status: r.status,
        avg: r.avg,
        peak: r.peak,
        min: r.min,
        warnings: r.warnings,
        criticals: r.criticals,
        trend: r.trend,
      })),
      pageTitle,
      { fontSize: 7.5 }
    );
  }

  // ═══ 5. COMPONENT HEALTH ANALYSIS (stats / interpretation; charts in §6) ═══
  const componentSections = getComponentSections(reportData);
  let compIdx = 0;
  componentSections.forEach((comp) => {
    const sid = COMP_SECTION_IDS[comp.name] || COMP_SECTION_IDS[comp.title] || null;
    const analysisOn = sid ? sectionOn(reportData, sid) : sectionOn(reportData, "hardwareHealthOverview");
    if (!analysisOn) return;

    compIdx += 1;
    y = ensureSpace(doc, y, 50, pageTitle);
    const heading = comp.title || `${comp.name || "Component"} Analysis`;
    y = sectionTitle(doc, `5.${compIdx}  ${heading}`, y, pageTitle);

    const st = statusLabel(comp.status);
    setFont(doc, "bold");
    doc.setFontSize(10);
    doc.setTextColor(...statusColor(comp.status));
    doc.text(`Status: ${st}`, MARGIN, y);
    y += 6;

    if (comp.stats) {
      const s = comp.stats;
      y = bodyText(
        doc,
        `Avg: ${fmt(s.avg)}   Peak: ${fmt(s.max ?? s.peak)}   Min: ${fmt(s.min)}   Trend: ${fmt(s.trend)}` +
          (comp.peakAt ? `   Peak at: ${fmtDate(comp.peakAt)}` : "") +
          `   Warnings: ${comp.warnCount ?? 0}   Criticals: ${comp.critCount ?? 0}`,
        y,
        pageTitle,
        { size: 8, color: GRAY }
      );
      y += 2;
    }

    const latest = comp.latestRecorded || [];
    if (latest.length) {
      setFont(doc, "bold");
      doc.setFontSize(9);
      doc.setTextColor(...NAVY);
      y = ensureSpace(doc, y, 10, pageTitle);
      doc.text("Latest Recorded Values", MARGIN, y);
      y += 4;
      const latestRows = latest.slice(0, 12).map((pair) => {
        if (Array.isArray(pair)) return { metric: pair[0], value: pair[1] };
        return { metric: pair.metric || pair.key || "-", value: pair.value ?? "-" };
      });
      y = drawTable(
        doc,
        y,
        [
          { key: "metric", label: "Metric", w: 90 },
          { key: "value", label: "Value", w: 92 },
        ],
        latestRows,
        pageTitle,
        { fontSize: 8, rowH: 6 }
      );
    }

    if (comp.interpretation) {
      setFont(doc, "bold");
      doc.setFontSize(9);
      doc.setTextColor(...NAVY);
      y = ensureSpace(doc, y, 10, pageTitle);
      doc.text("Interpretation", MARGIN, y);
      y += 4;
      y = bodyText(doc, comp.interpretation, y, pageTitle, { size: 9 });
      y += 3;
    }
  });

  // ═══ 6. INFRASTRUCTURE HISTORICAL TRENDS ═══
  if (sectionOn(reportData, "historicalTrends")) {
    y = ensureSpace(doc, y, 30, pageTitle);
    y = sectionTitle(doc, "6. Infrastructure Historical Trends", y, pageTitle);
    y = bodyText(
      doc,
      "Historical telemetry, fault markers, and recovery markers for the selected reporting window. Lines break across telemetry gaps; missing intervals are not fabricated.",
      y,
      pageTitle,
      { size: 8, style: "italic", color: GRAY }
    );
    y += 3;

    const sysTrend = reportData.systemResourceTrend || reportData.graphs?.systemResourceTrend;
    if (sysTrend?.series?.length) {
      y = placeChartBlock(doc, y, pageTitle, sysTrend.title || "System Resource Utilization", (cx, cy, cw, ch) => {
        drawMultiSeriesChart(doc, sysTrend, cx, cy, cw, ch, reportData);
      });
    }

    componentSections.forEach((comp) => {
      const charts = (comp.charts || []).filter((ch) => (ch.points || []).length >= 2);
      charts.forEach((chart) => {
        y = placeChartBlock(doc, y, pageTitle, chart.title || `${comp.name} Trend`, (cx, cy, cw, ch) => {
          drawLineChart(doc, chart, cx, cy, cw, ch, reportData);
        });
      });
    });

    // Fault events over time
    const faultMarkers = [
      ...(reportData.eventMarkers?.faults || []),
      ...(reportData.faultEvents || []).map((f) => ({
        t: f.t,
        severity: f.severity,
        id: f.eventId,
        kind: "FAULT",
      })),
    ];
    const uniqFaults = [];
    const seenF = new Set();
    faultMarkers.forEach((f) => {
      const k = `${f.t}-${f.id}`;
      if (seenF.has(k)) return;
      seenF.add(k);
      uniqFaults.push(f);
    });
    y = placeChartBlock(doc, y, pageTitle, "Fault Events Over Time", (cx, cy, cw, ch) => {
      drawEventScatterChart(doc, uniqFaults, cx, cy, cw, ch, reportData, "0 FAULT EVENTS");
    });
    if (!uniqFaults.length) {
      y = bodyText(
        doc,
        "No warning or critical events were recorded during the selected reporting period.",
        y,
        pageTitle,
        { size: 8, style: "italic", color: GRAY }
      );
      y += 2;
    }

    // Recovery actions over time
    const recoveryMarkers = (reportData.recoveryEvents || reportData.recoveryHistory || []).map((r) => ({
      t: r.t,
      id: r.recoveryId || r.action,
      kind: "RECOVERY",
      severity: r.success ? "Success" : "Recovery",
      label: r.recoveryId,
    }));
    y = placeChartBlock(doc, y, pageTitle, "Recovery Actions Over Time", (cx, cy, cw, ch) => {
      drawEventScatterChart(
        doc,
        recoveryMarkers,
        cx,
        cy,
        cw,
        ch,
        reportData,
        "0 RECOVERY ACTIONS"
      );
    });
    if (!recoveryMarkers.length) {
      y = bodyText(doc, "No recovery actions recorded.", y, pageTitle, {
        size: 8,
        style: "italic",
        color: GRAY,
      });
      y += 2;
    } else {
      recoveryMarkers.forEach((r) => {
        const full = (reportData.recoveryEvents || []).find((x) => x.recoveryId === r.id);
        if (!full) return;
        y = bodyText(
          doc,
          `${fmtDate(full.t)} | ${full.recoveryId} | ${full.component} | ${full.action} | ${full.result}`,
          y,
          pageTitle,
          { size: 7.5, color: DARK }
        );
      });
      y += 2;
    }
  }

  // ═══ 7. FAULT & INCIDENT LOG ═══
  if (sectionOn(reportData, "faultTimeline") || sectionOn(reportData, "activeFaults")) {
    y = ensureSpace(doc, y, 28, pageTitle);
    y = sectionTitle(doc, "7. Fault & Incident Log", y, pageTitle);
    const faultRows = reportData.faultEvents || reportData.faultIncidentLog?.rows || [];
    if (!faultRows.length) {
      y = calloutBox(
        doc,
        y,
        reportData.faultIncidentLog?.emptyMessage ||
          reportData.logbookEmptyMessage ||
          "NO FAULT EVENTS RECORDED. No warning or critical fault events were recorded in the selected historical reporting period.",
        pageTitle,
        "ok"
      );
    } else {
      y = drawTable(
        doc,
        y,
        [
          { key: "eventId", label: "Event ID", w: 18 },
          { key: "timestamp", label: "Timestamp", w: 34 },
          { key: "component", label: "Component", w: 22 },
          { key: "severity", label: "Severity", w: 18 },
          { key: "fault", label: "Fault / Alert", w: 40 },
          { key: "metric", label: "Metric", w: 22 },
          { key: "value", label: "Value", w: 14 },
          { key: "threshold", label: "Thresh", w: 14 },
        ],
        faultRows.map((r) => ({
          eventId: r.eventId,
          timestamp: r.faultDetected || fmtDate(r.t),
          component: r.component,
          severity: r.severity,
          fault: r.faultReason || r.description || "-",
          metric: r.metric || r.metricName || "-",
          value: r.observedValue ?? r.peakValue ?? "-",
          threshold: r.threshold ?? r.thresholdCrossed ?? "-",
        })),
        pageTitle,
        { fontSize: 6.2, rowH: 6 }
      );
      y = drawTable(
        doc,
        y,
        [
          { key: "eventId", label: "Event ID", w: 18 },
          { key: "detection", label: "Detection", w: 22 },
          { key: "corrected", label: "Corrected At", w: 32 },
          { key: "duration", label: "Duration", w: 20 },
          { key: "recovery", label: "Recovery Action", w: 36 },
          { key: "status", label: "Final Status", w: 24 },
          { key: "remarks", label: "Remarks", w: 30 },
        ],
        faultRows.map((r) => ({
          eventId: r.eventId,
          detection: r.detectionStatus || r.status || "-",
          corrected: r.correctedAt || r.faultCorrected || "-",
          duration: r.duration || r.durationLabel || "-",
          recovery: r.recoveryAction || "None",
          status: r.finalStatus || r.status || "-",
          remarks: r.correlation || r.remarks || "-",
        })),
        pageTitle,
        { fontSize: 6.2, rowH: 6 }
      );

      (reportData.faultDetailCards || []).forEach((card) => {
        y = ensureSpace(doc, y, 42, pageTitle);
        setFont(doc, "bold");
        doc.setFontSize(9);
        doc.setTextColor(...NAVY);
        doc.text(pdfSafe(`FAULT EVENT ${card.eventId}`), MARGIN, y);
        y += 5;
        y = kvTable(
          doc,
          y,
          [
            ["Component", card.component],
            ["Severity", card.severity],
            ["Reason", card.reason],
            ["Detected", card.detected],
            ["Peak", card.peak],
            ["Threshold", card.threshold],
            ["Corrected", card.corrected],
            ["Duration", card.duration],
            ["Occurrences", card.occurrences],
            ["Recovery", card.recovery],
            ["Result", card.result],
            ["Remarks", card.remarks],
          ],
          pageTitle
        );
      });
    }
  }

  // ═══ 8. RECOVERY ACTION LOG ═══
  if (sectionOn(reportData, "recoveryHistory")) {
    y = ensureSpace(doc, y, 24, pageTitle);
    y = sectionTitle(doc, "8. Recovery Action Log", y, pageTitle);
    const recoveries = reportData.recoveryEvents || reportData.recoveryHistory || [];
    if (!recoveries.length) {
      y = calloutBox(
        doc,
        y,
        reportData.recoveryActionLog?.emptyMessage || "No recovery actions recorded.",
        pageTitle,
        "ok"
      );
    } else {
      y = drawTable(
        doc,
        y,
        [
          { key: "id", label: "Recovery ID", w: 20 },
          { key: "timestamp", label: "Timestamp", w: 34 },
          { key: "component", label: "Component", w: 22 },
          { key: "action", label: "Action", w: 40 },
          { key: "pid", label: "PID", w: 16 },
          { key: "process", label: "Process", w: 30 },
          { key: "result", label: "Result", w: 20 },
        ],
        recoveries.map((r) => ({
          id: r.recoveryId || "-",
          timestamp: r.time || (r.timestamp ? String(r.timestamp).replace("T", " ").slice(0, 19) : "-"),
          component: r.component,
          action: r.action,
          pid: r.pid ?? "-",
          process: r.process,
          result: r.result,
        })),
        pageTitle,
        { fontSize: 6.5, rowH: 6 }
      );
      y = drawTable(
        doc,
        y,
        [
          { key: "id", label: "Recovery ID", w: 20 },
          { key: "trigger", label: "Trigger", w: 36 },
          { key: "faultId", label: "Fault/Event ID", w: 28 },
          { key: "verification", label: "Verification", w: 30 },
          { key: "status", label: "Final Status", w: 24 },
          { key: "remarks", label: "Remarks", w: 44 },
        ],
        recoveries.map((r) => ({
          id: r.recoveryId || "-",
          trigger: r.trigger || "-",
          faultId: r.faultEventId || "Not available",
          verification: r.verification || "-",
          status: r.status || "-",
          remarks: r.correlation || r.remarks || "-",
        })),
        pageTitle,
        { fontSize: 6.5, rowH: 6 }
      );
    }
  }

  // ═══ 9. FAULT -> RECOVERY TIMELINE ═══
  if (sectionOn(reportData, "faultRecoveryTimeline") || sectionOn(reportData, "recoveryHistory")) {
    y = ensureSpace(doc, y, 28, pageTitle);
    y = sectionTitle(doc, "9. Fault -> Recovery Timeline", y, pageTitle);
    const chains = reportData.faultRecoveryChains || [];
    const timeline = reportData.infrastructureTimeline || [];
    if (!chains.length && !timeline.length) {
      y = bodyText(
        doc,
        "No fault or recovery timeline events in the selected historical reporting period.",
        y,
        pageTitle,
        { size: 9, style: "italic", color: GRAY }
      );
      y += 3;
    } else {
      chains.forEach((chain) => {
        y = ensureSpace(doc, y, 28, pageTitle);
        setFont(doc, "bold");
        doc.setFontSize(9);
        doc.setTextColor(...NAVY);
        const title = chain.faultId
          ? `${chain.faultId}  (${chain.component})`
          : `Recovery without linked fault (${chain.component})`;
        doc.text(pdfSafe(title), MARGIN, y);
        y += 5;
        (chain.steps || []).forEach((step, i) => {
          const prefix = i === (chain.steps.length - 1) ? "`-- " : "|-- ";
          y = bodyText(
            doc,
            `${prefix}${step.stage}: ${step.detail}`,
            y,
            pageTitle,
            { size: 8 }
          );
        });
        y += 3;
      });

      if (timeline.length) {
        y = ensureSpace(doc, y, 20, pageTitle);
        setFont(doc, "bold");
        doc.setFontSize(9);
        doc.setTextColor(...NAVY);
        doc.text("Infrastructure Activity Timeline", MARGIN, y);
        y += 5;
        timeline.forEach((item) => {
          y = bodyText(
            doc,
            `${item.timestamp || fmtDate(item.t)}  |  ${item.kind}  |  ${item.component || "-"}  |  ${item.label}`,
            y,
            pageTitle,
            { size: 7.5 }
          );
        });
        y += 2;
      }
    }
  }

  // ═══ 10. SIGNIFICANT EVENT / SPIKE ANALYSIS ═══
  if (sectionOn(reportData, "spikeAnalysis")) {
    y = ensureSpace(doc, y, 24, pageTitle);
    y = sectionTitle(doc, "10. Significant Event / Spike Analysis", y, pageTitle);
    const sig = reportData.significantEvents || [];
    if (!sig.length) {
      y = calloutBox(
        doc,
        y,
        reportData.significantEventsEmptyMessage ||
          "No significant threshold-related spikes detected in the selected historical reporting period.",
        pageTitle,
        "ok"
      );
    } else {
      sig.forEach((s) => {
        y = ensureSpace(doc, y, 36, pageTitle);
        setFont(doc, "bold");
        doc.setFontSize(9);
        doc.setTextColor(...NAVY);
        doc.text(pdfSafe(`${s.id}  ${s.timestamp || ""}  ${s.component} / ${s.metric}`), MARGIN, y);
        y += 4;
        y = kvTable(
          doc,
          y,
          [
            ["Baseline", s.baseline],
            ["Peak", `${s.peak}${s.unit || ""}`],
            ["Increase %", s.increasePct],
            ["Threshold", s.threshold],
            ["Duration", s.duration],
            ["Fault Correlation", s.faultCorrelation],
            ["Recovery Correlation", s.recoveryCorrelation],
            ["Interpretation", s.interpretation],
          ],
          pageTitle
        );
      });
    }
  }

  // ═══ 11. INFRASTRUCTURE ACTIVITY SUMMARY ═══
  if (sectionOn(reportData, "activitySummary")) {
    y = ensureSpace(doc, y, 30, pageTitle);
    y = sectionTitle(doc, "11. Infrastructure Activity Summary", y, pageTitle);
    const summary = reportData.activitySummary || [];
    if (!summary.length) {
      y = bodyText(doc, "Activity summary unavailable.", y, pageTitle, {
        size: 9,
        style: "italic",
        color: GRAY,
      });
    } else {
      y = drawTable(
        doc,
        y,
        [
          { key: "category", label: "Category", w: 36 },
          { key: "count", label: "Count", w: 16 },
          { key: "first", label: "First Event", w: 34 },
          { key: "last", label: "Last Event", w: 34 },
          { key: "severity", label: "Highest Sev", w: 24 },
          { key: "recovery", label: "Recoveries", w: 18 },
          { key: "result", label: "Result", w: 20 },
        ],
        summary.map((r) => ({
          category: r.category,
          count: r.count,
          first: r.firstEvent,
          last: r.lastEvent,
          severity: r.highestSeverity,
          recovery: r.recoveryActions,
          result: r.result,
        })),
        pageTitle,
        { fontSize: 6.5, rowH: 6.2 }
      );
    }
  }

  // ═══ 12. DIGITAL TWIN ═══
  if (sectionOn(reportData, "digitalTwin")) {
    y = ensureSpace(doc, y, 18, pageTitle);
    y = sectionTitle(doc, "12. Digital Twin History", y, pageTitle);
    const dt = reportData.digitalTwin || [];
    if (!dt.length) {
      y = bodyText(
        doc,
        reportData.digitalTwinEmptyMessage ||
          "No Digital Twin simulations recorded.",
        y,
        pageTitle,
        { size: 9, style: "italic", color: GRAY }
      );
      y += 4;
    } else {
      y = drawTable(
        doc,
        y,
        [
          { key: "timestamp", label: "Time", w: 36 },
          { key: "component", label: "Component", w: 26 },
          { key: "action", label: "Action", w: 36 },
          { key: "risk", label: "Risk", w: 22 },
          { key: "confidence", label: "Conf.", w: 18 },
          { key: "executed", label: "Executed", w: 22 },
          { key: "result", label: "Result", w: 22 },
        ],
        dt.map((s) => ({
          timestamp: s.timestamp ? String(s.timestamp).replace("T", " ").slice(0, 19) : "-",
          component: s.component,
          action: s.action,
          risk: s.risk,
          confidence: s.confidence ?? "-",
          executed: s.executed ? "Yes" : "No",
          result: s.result || "-",
        })),
        pageTitle,
        { fontSize: 6.5, rowH: 6 }
      );
    }
  }

  // ═══ 13. RECOMMENDATIONS ═══
  if (sectionOn(reportData, "recommendations")) {
    const recs = normalizeRecommendations(reportData.recommendations);
    const hasAny = recs.immediate.length || recs.preventive.length || recs.monitoring.length;
    if (hasAny) {
      y = ensureSpace(doc, y, 30, pageTitle);
      y = sectionTitle(doc, "13. Recommendations", y, pageTitle);
      const blocks = [
        ["Immediate", recs.immediate],
        ["Preventive", recs.preventive],
        ["Monitoring", recs.monitoring],
      ];
      blocks.forEach(([label, items]) => {
        if (!items?.length) return;
        setFont(doc, "bold");
        doc.setFontSize(10);
        doc.setTextColor(...NAVY);
        y = ensureSpace(doc, y, 10, pageTitle);
        doc.text(label, MARGIN, y);
        y += 5;
        items.forEach((item, i) => {
          y = bodyText(doc, `${i + 1}. ${item}`, y, pageTitle, { size: 9 });
          y += 1.5;
        });
        y += 3;
      });
    }
  }

  // ═══ 14. APPENDIX ═══
  {
    y = ensureSpace(doc, y, 55, pageTitle);
    y = sectionTitle(doc, "14. Appendix — Report Metadata", y, pageTitle);
    y = kvTable(
      doc,
      y,
      [
        ["Generated At", generatedAt.toISOString?.() || fmtDate(generatedAt)],
        ["Report ID", reportId],
        ["Report Interval", reportData.intervalLabel || "-"],
        ["Data Source", reportData.dataSource || "SQLite telemetry_history.db"],
        ["Database", reportData.database || "-"],
        ["Raw Samples", String(rawSamples)],
        ["Report Points", String(reportPoints)],
        ["Coverage Status", cov.status || exec.coverageStatus || "-"],
        ["Constraint", "Missing historical periods are not fabricated or filled from live /metrics"],
      ],
      pageTitle
    );

    setFont(doc, "bold");
    doc.setFontSize(9);
    doc.setTextColor(...NAVY);
    y = ensureSpace(doc, y, 28, pageTitle);
    doc.text("Data Pipeline", MARGIN, y);
    y += 6;
    doc.setFillColor(245, 247, 250);
    doc.setDrawColor(...NAVY);
    doc.setLineWidth(0.3);
    doc.roundedRect(MARGIN, y - 3, CONTENT_W, 22, 1.5, 1.5, "FD");
    setFont(doc, "normal");
    doc.setFontSize(9);
    doc.setTextColor(...DARK);
    const pipeline = "TELEMETRY -> EVENT DETECTION -> FAULT -> RCA -> RECOVERY -> VERIFICATION -> STATUS";
    doc.text(pipeline, PAGE_W / 2, y + 5, { align: "center" });
    doc.setFontSize(8);
    doc.text("CM.py  ->  SQLite  ->  /reports/data  ->  Historical Analysis  ->  Report", PAGE_W / 2, y + 12, {
      align: "center",
    });
    y += 26;
  }

  // Footers on all pages (cover included)
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i += 1) {
    doc.setPage(i);
    addPageFooter(doc, i, pageCount);
  }

  const stamp = generatedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${sanitizeFilename(pageTitle)}_${stamp}.pdf`;
  const blob = doc.output("blob");
  return { blob, filename, pageCount, sizeBytes: blob.size, format: "pdf" };
}

/** Legacy helper — triggers immediate browser download */
export function downloadReportPdf(reportData) {
  const result = exportReportPdf(reportData);
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = result.filename;
  a.click();
  URL.revokeObjectURL(url);
  return result.filename;
}
