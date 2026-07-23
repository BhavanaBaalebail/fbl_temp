/**
 * Report Data Builder — format-agnostic report data from session telemetry.
 */

import {
  REPORT_INTERVALS,
  getSamplesForInterval,
  getFaultEventsForInterval,
  getHistoryContext,
  computeStats,
  getMonitoringSpan,
} from "../metricsHistoryService";
import { getRecoveryHistory } from "../../recovery/recoveryHistoryService";
import { filterSelectedSections } from "./reportSections";

function buildExecutiveSummary(samples, intervalKey, faults, context, customRange) {
  const span = getMonitoringSpan(samples, intervalKey, customRange);
  const latest = samples[samples.length - 1] || {};
  const interval = REPORT_INTERVALS[intervalKey];
  const snap = context?.componentSnapshot || {};
  const lh = snap.linkHealth || {};

  const activeFaults = faults.filter((f) => f.severity !== "Resolved");
  const critAlerts = activeFaults.filter((f) => f.severity === "Critical").length;
  const warnAlerts = activeFaults.filter((f) => f.severity === "Warning").length;

  let summary;
  if (samples.length === 0) {
    summary =
      "No telemetry samples were collected during the selected interval. Keep the dashboard connected to accumulate performance data before generating a report.";
  } else if (samples.length < 3) {
    summary = `This report is based on ${samples.length} sample(s) collected over ${span.label}. Extended monitoring will improve trend accuracy and fault detection confidence.`;
  } else {
    const cpu = computeStats(samples.map((s) => s.cpu_usage));
    const mem = computeStats(samples.map((s) => s.mem_usage));
    const parts = [];
    if (cpu.count > 0) parts.push(`CPU averaged ${cpu.avg}% utilization`);
    if (mem.count > 0) parts.push(`memory averaged ${mem.avg}%`);
    summary = `System telemetry over ${span.label} shows ${parts.join(" and ") || "stable operation"}.`;
    if (lh.overall) summary += ` Link health engine reports overall status: ${lh.overall}.`;
    if (lh.score != null) summary += ` Health score: ${lh.score}.`;
  }

  if (critAlerts > 0) {
    summary += ` ${critAlerts} critical condition(s) require immediate attention.`;
  } else if (warnAlerts > 0) {
    summary += ` ${warnAlerts} warning condition(s) should be monitored.`;
  } else if (samples.length > 0) {
    summary += " All monitored components are within configured thresholds.";
  }

  const intervalLabel =
    intervalKey === "custom" && customRange?.start && customRange?.end
      ? `${new Date(customRange.start).toLocaleString()} – ${new Date(customRange.end).toLocaleString()}`
      : interval?.label || intervalKey;

  return {
    overallHealth: latest.lh_health || lh.overall || "Not Available",
    healthScore: latest.lh_score ?? lh.score ?? "Not Available",
    monitoringDuration: samples.length ? span.label : `0 of ${intervalLabel.replace("Last ", "")}`,
    sampleCount: samples.length,
    criticalAlerts: critAlerts,
    warningAlerts: warnAlerts,
    totalFaults: activeFaults.length,
    summary,
    hostname: context?.hostname || context?.inventory?.hostname || "Not Available",
    os: context?.os || context?.inventory?.os || "Not Available",
    kernel: context?.kernel || context?.inventory?.kernel || "Not Available",
  };
}

function getComponentLiveMetrics(component, live, context) {
  const inv = context?.inventory || {};
  switch (component) {
    case "CPU":
      return [
        ["Usage", live.cpu_usage != null ? `${live.cpu_usage}%` : null],
        ["Temperature", live.cpu_temp != null ? `${live.cpu_temp}°C` : null],
      ].filter(([, v]) => v != null);
    case "RAM":
      return [
        ["Usage", live.mem_usage != null ? `${live.mem_usage}%` : null],
        ["Total", live.mem_total_gb != null ? `${live.mem_total_gb} GB` : null],
      ].filter(([, v]) => v != null);
    case "GPU":
      return [
        ["Utilization", live.gpu_util != null ? `${live.gpu_util}%` : null],
        ["Temperature", live.gpu_temp != null ? `${live.gpu_temp}°C` : null],
        ["Model", inv.gpus?.[0]?.model || context?.gpu_model || null],
      ].filter(([, v]) => v != null);
    case "DISK":
      return (inv.disks || []).slice(0, 3).map((d) => [
        d.device || d.model,
        `${d.type || "—"} · ${d.transport || "—"} · ${d.size || "—"}`,
      ]);
    case "NIC":
      return (inv.nics || []).slice(0, 4).map((n) => [n.name || "—", n.model || n.speed || "—"]);
    case "IO Control":
      return [
        ["PCI Devices", inv.pci_count != null ? String(inv.pci_count) : null],
        ["USB Devices", inv.usb_count != null ? String(inv.usb_count) : null],
      ].filter(([, v]) => v != null);
    default:
      return [];
  }
}

function getComponentInventory(component, context) {
  const inv = context?.inventory || {};
  const cpu = inv.cpu || {};
  switch (component) {
    case "CPU":
      return [
        cpu.model,
        cpu.vendor,
        cpu.architecture,
        cpu.physical_cores != null ? `${cpu.physical_cores} cores` : null,
        cpu.logical_processors != null ? `${cpu.logical_processors} threads` : null,
      ].filter(Boolean);
    case "RAM":
      return [
        inv.memory?.dimm_count != null ? `${inv.memory.dimm_count} DIMM(s)` : null,
        ...(inv.memory?.dimms || []).slice(0, 2).map(
          (d) => `${d.locator || "DIMM"}: ${d.size || "—"} ${d.type || ""} ${d.speed || ""}`.trim()
        ),
      ].filter(Boolean);
    case "GPU":
      return (inv.gpus || []).map(
        (g) => `${g.vendor || ""} ${g.model || "GPU"} · driver ${g.driver_version || "—"}`.trim()
      );
    case "DISK":
      return (inv.disks || []).map(
        (d) => `${d.device || "—"}: ${d.model || "—"} (${d.transport || d.type || "—"}, ${d.size || "—"})`
      );
    case "NIC":
      return (inv.nics || []).map((n) => `${n.name || "—"}: ${n.model || n.speed || "—"}`);
    case "IO Control":
      return [
        inv.pci_count != null ? `${inv.pci_count} PCI device(s)` : null,
        inv.usb_count != null ? `${inv.usb_count} USB device(s)` : null,
      ].filter(Boolean);
    default:
      return [];
  }
}

function buildComponentAnalysis(context, faults) {
  const snap = context?.componentSnapshot || {};
  const assessments = snap.assessments || {};
  const live = snap.liveMetrics || {};
  const components = ["CPU", "GPU", "RAM", "DISK", "NIC", "IO Control"];

  return components.map((name) => {
    const a = assessments[name] || { level: "unknown", status: "No data" };
    const componentFaults = faults.filter(
      (f) => f.component === name && f.severity !== "Resolved"
    );
    return {
      name,
      level: a.level,
      status: a.status,
      faults: componentFaults,
      liveMetrics: getComponentLiveMetrics(name, live, context),
      inventory: getComponentInventory(name, context),
    };
  });
}

function buildInventorySection(context) {
  const inv = context?.inventory;
  if (!inv) return null;
  return {
    system: {
      hostname: inv.hostname,
      os: inv.os,
      os_release: inv.os_release,
      kernel: inv.kernel,
    },
    cpu: inv.cpu,
    memory: inv.memory,
    disks: inv.disks,
    gpus: inv.gpus,
    nics: inv.nics,
    io: { pci_count: inv.pci_count, usb_count: inv.usb_count },
  };
}

function buildHardwareMetrics(samples) {
  const rows = [];
  const defs = [
    ["CPU Usage", "cpu_usage", "%"],
    ["CPU Temperature", "cpu_temp", "°C"],
    ["CPU Load (1 min)", "cpu_load_1", ""],
    ["Memory Usage", "mem_usage", "%"],
    ["Swap Usage", "mem_swap", "%"],
    ["GPU Temperature", "gpu_temp", "°C"],
    ["GPU Utilization", "gpu_util", "%"],
    ["GPU VRAM Usage", "gpu_vram", "%"],
    ["GPU Power Draw", "gpu_power", "W"],
    ["NIC Active Interfaces", "nic_up", ""],
    ["NIC Error Count", "nic_errors", ""],
    ["Link Health Score", "lh_score", ""],
  ];

  defs.forEach(([label, key, suffix]) => {
    const stats = computeStats(samples.map((s) => s[key]));
    if (stats.count === 0) return;
    rows.push([
      label,
      `${stats.avg}${suffix}`,
      `${stats.min}${suffix}`,
      `${stats.max}${suffix}`,
      `${stats.current}${suffix}`,
      stats.trend,
    ]);
  });

  const mountKeys = new Set();
  samples.forEach((s) => (s.disk_mounts || []).forEach((m) => mountKeys.add(m.mp)));
  mountKeys.forEach((mp) => {
    const stats = computeStats(
      samples.map((s) => {
        const mount = (s.disk_mounts || []).find((m) => m.mp === mp);
        return mount?.pct ?? null;
      })
    );
    if (stats.count === 0) return;
    rows.push([
      `Disk ${mp}`,
      `${stats.avg}%`,
      `${stats.min}%`,
      `${stats.max}%`,
      `${stats.current}%`,
      stats.trend,
    ]);
  });

  const pciStats = computeStats(samples.map((s) => s.pci_count));
  if (pciStats.count > 0) {
    rows.push([
      "IO Controller — PCI Devices",
      String(pciStats.avg),
      String(pciStats.min),
      String(pciStats.max),
      String(pciStats.current),
      pciStats.trend,
    ]);
  }

  const usbStats = computeStats(samples.map((s) => s.usb_count));
  if (usbStats.count > 0) {
    rows.push([
      "IO Controller — USB Devices",
      String(usbStats.avg),
      String(usbStats.min),
      String(usbStats.max),
      String(usbStats.current),
      usbStats.trend,
    ]);
  }

  return rows;
}

function buildTrendSeries(samples) {
  const series = [];
  const keys = [
    { key: "cpu_usage", label: "CPU Utilization (%)", suffix: "%" },
    { key: "mem_usage", label: "Memory Utilization (%)", suffix: "%" },
    { key: "cpu_temp", label: "CPU Temperature (°C)", suffix: "°C" },
    { key: "gpu_temp", label: "GPU Temperature (°C)", suffix: "°C" },
    { key: "gpu_util", label: "GPU Utilization (%)", suffix: "%" },
    { key: "gpu_vram", label: "GPU VRAM (%)", suffix: "%" },
    { key: "nic_errors", label: "NIC Error Count", suffix: "" },
    { key: "lh_score", label: "Link Health Score", suffix: "" },
  ];

  keys.forEach(({ key, label, suffix }) => {
    const points = samples.filter((s) => s[key] != null).map((s) => ({ t: s.t, v: s[key] }));
    if (points.length >= 2) series.push({ key, label, suffix, points });
  });

  const mountKeys = new Set();
  samples.forEach((s) => (s.disk_mounts || []).forEach((m) => mountKeys.add(m.mp)));
  mountKeys.forEach((mp) => {
    const points = samples
      .map((s) => {
        const mount = (s.disk_mounts || []).find((m) => m.mp === mp);
        return mount?.pct != null ? { t: s.t, v: mount.pct } : null;
      })
      .filter(Boolean);
    if (points.length >= 2) {
      series.push({ key: `disk_${mp}`, label: `Disk ${mp} Usage (%)`, suffix: "%", points });
    }
  });

  return series;
}

function explainFault(fault) {
  if (fault.metricName && fault.thresholdCrossed) {
    return `${fault.component} ${fault.metricName} measured ${fault.currentValue || "—"}, crossing threshold ${fault.thresholdCrossed}. ${fault.description || ""}`.trim();
  }
  if (fault.source === "kernel_event") {
    return `Kernel hardware event on ${fault.component}: ${fault.description || "—"}.`;
  }
  return fault.description || "Alert raised by link health engine based on live telemetry.";
}

function recommendForFault(fault) {
  const metric = (fault.metricName || "").toLowerCase();
  const component = fault.component;

  if (metric.includes("temperature")) {
    return "Verify cooling fans, heatsink contact, and ambient temperature. Reduce workload if thermals persist.";
  }
  if (metric.includes("usage") || metric.includes("utilization")) {
    return `Review processes consuming ${component} resources. Consider workload redistribution or capacity upgrade.`;
  }
  if (metric.includes("ecc") || metric.includes("error")) {
    return "Schedule hardware diagnostics. ECC or machine-check errors may indicate failing components.";
  }
  if (metric.includes("capacity") || metric.includes("wear")) {
    return "Free disk space or plan storage expansion. For NVMe wear, schedule drive replacement before endurance limit.";
  }
  if (metric.includes("smart")) {
    return "Back up data immediately and replace the failing drive. SMART health indicates imminent failure risk.";
  }
  if (component === "NIC") {
    return "Inspect network cabling, switch ports, and driver versions. Check link_health counters for persistent errors.";
  }
  if (component === "IO Control") {
    return "Reseat PCIe devices, update firmware, and review platform error logs for recurring chipset issues.";
  }
  if (component === "GPU") {
    return "Verify GPU cooling, power delivery, and PCIe link. Update GPU drivers if link health warnings persist.";
  }
  if (fault.severity === "Critical") {
    return "Address this critical condition immediately to prevent service disruption or hardware damage.";
  }
  return "Monitor this condition during the next scan cycle. Escalate if severity increases.";
}

function buildFaultAnalysis(faults) {
  return faults.map((fault) => {
    const explanation = explainFault(fault);
    const recommendation = recommendForFault(fault);
    return { ...fault, explanation, recommendation };
  });
}

function buildRecommendations(samples, faultAnalysis) {
  const recs = [];
  const seen = new Set();

  function add(text) {
    if (!text || seen.has(text)) return;
    seen.add(text);
    recs.push(text);
  }

  if (samples.length === 0) {
    add("Keep the dashboard connected to the telemetry server to accumulate performance samples before generating a report.");
    return recs;
  }

  faultAnalysis
    .filter((f) => f.severity !== "Resolved")
    .forEach((f) => add(`[${f.component}] ${f.recommendation}`));

  const cpu = computeStats(samples.map((s) => s.cpu_usage));
  const mem = computeStats(samples.map((s) => s.mem_usage));
  const swap = computeStats(samples.map((s) => s.mem_swap));
  const gpuTemp = computeStats(samples.map((s) => s.gpu_temp));
  const nicErr = computeStats(samples.map((s) => s.nic_errors));

  if (cpu.max != null && cpu.max >= 90) {
    add(`CPU usage peaked at ${cpu.max}%. Investigate high-load processes and consider workload balancing.`);
  }
  if (mem.max != null && mem.max >= 90) {
    add(`Memory usage reached ${mem.max}%. Review memory-intensive applications or add capacity.`);
  }
  if (swap.max != null && swap.max >= 50) {
    add(`Swap usage reached ${swap.max}%, indicating sustained memory pressure.`);
  }
  if (gpuTemp.max != null && gpuTemp.max >= 85) {
    add(`GPU temperature peaked at ${gpuTemp.max}°C. Verify cooling and airflow.`);
  }
  if (nicErr.max != null && nicErr.max > 0) {
    add(`Network interfaces reported up to ${nicErr.max} cumulative errors during the interval.`);
  }

  samples.forEach((s) => {
    (s.disk_mounts || []).forEach((m) => {
      if (m.pct != null && m.pct >= 90) {
        add(`Disk mount ${m.mp} usage reached ${m.pct}%. Free space or expand storage.`);
      }
    });
  });

  if (recs.length === 0) {
    add("No significant performance concerns detected during the monitored interval. Continue routine monitoring.");
  }

  return recs;
}

function buildFaultDistribution(faults) {
  const bySeverity = { Critical: 0, Warning: 0, Resolved: 0 };
  const byComponent = {};
  faults.forEach((f) => {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    byComponent[f.component] = (byComponent[f.component] || 0) + 1;
  });
  return { bySeverity, byComponent };
}

function buildComponentHealthSnapshot(context) {
  const assessments = context?.componentSnapshot?.assessments || {};
  return Object.entries(assessments).map(([name, a]) => ({
    name,
    level: a.level || "unknown",
  }));
}

function buildConnectivityStatus(context) {
  const snap = context?.componentSnapshot || {};
  const lh = snap.linkHealth || {};
  if (!lh.overall && lh.score == null) return null;
  return {
    linkHealth: {
      overall: lh.overall,
      score: lh.score,
    },
    assessments: snap.assessments || {},
  };
}

function filterRecoveryHistory(intervalKey, customRange) {
  const history = getRecoveryHistory();
  if (!history.length) return [];

  const { start, end } = (() => {
    if (intervalKey === "custom" && customRange?.start && customRange?.end) {
      return { start: customRange.start, end: customRange.end };
    }
    const interval = REPORT_INTERVALS[intervalKey];
    const endTs = Date.now();
    return { start: endTs - (interval?.ms || 3600000), end: endTs };
  })();

  return history.filter((r) => {
    const t = new Date(r.timestamp).getTime();
    return t >= start && t <= end;
  });
}

function buildAiRootCause(faultAnalysis) {
  return faultAnalysis
    .filter((f) => f.explanation)
    .map((f) => ({
      component: f.component,
      severity: f.severity,
      metricName: f.metricName,
      analysis: f.explanation,
      recommendation: f.recommendation,
      timestamp: f.t,
    }));
}

/**
 * @param {object} config
 * @param {string} config.intervalKey
 * @param {{ start: number, end: number }|null} [config.customRange]
 * @param {string} [config.title]
 * @param {string} [config.generatedBy]
 * @param {string} [config.description]
 * @param {Record<string, boolean>} [config.sections]
 */
export function buildReportData(config = {}) {
  const {
    intervalKey = "1h",
    customRange = null,
    title = "",
    generatedBy = "",
    description = "",
    sections = null,
  } = typeof config === "string" ? { intervalKey: config } : config;

  const samples = getSamplesForInterval(intervalKey, customRange);
  const faults = getFaultEventsForInterval(intervalKey, customRange);
  const context = getHistoryContext();
  const interval = REPORT_INTERVALS[intervalKey];
  const span = getMonitoringSpan(samples, intervalKey, customRange);
  const faultAnalysis = buildFaultAnalysis(faults);
  const recoveryHistory = filterRecoveryHistory(intervalKey, customRange);
  const aiRootCause = buildAiRootCause(faultAnalysis);

  const intervalLabel =
    intervalKey === "custom" && customRange?.start && customRange?.end
      ? `${new Date(customRange.start).toLocaleString()} – ${new Date(customRange.end).toLocaleString()}`
      : interval?.label || intervalKey;

  const reportData = {
    intervalKey,
    intervalLabel,
    generatedAt: new Date(),
    title: title || "Hardware Monitoring Report",
    generatedBy: generatedBy || "System Administrator",
    description,
    span,
    executive: buildExecutiveSummary(samples, intervalKey, faults, context, customRange),
    inventory: buildInventorySection(context),
    componentAnalysis: buildComponentAnalysis(context, faults),
    hardwareMetrics: buildHardwareMetrics(samples),
    trendSeries: buildTrendSeries(samples),
    faults,
    faultAnalysis,
    faultDistribution: buildFaultDistribution(faults),
    componentHealthSnapshot: buildComponentHealthSnapshot(context),
    connectivityStatus: buildConnectivityStatus(context),
    recoveryHistory,
    aiRootCause,
    recommendations: buildRecommendations(samples, faultAnalysis),
    rawSamples: samples,
    context,
    sampleCount: samples.length,
  };

  if (sections) {
    reportData.activeSections = filterSelectedSections(reportData, sections);
  }

  return reportData;
}

export { explainFault, recommendForFault, buildFaultAnalysis };
