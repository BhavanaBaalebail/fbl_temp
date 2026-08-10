/**
 * Report section definitions and availability checks.
 * Only sections with real telemetry data are offered to the user.
 */

export const REPORT_SECTIONS = [
  { id: "executiveSummary", label: "Executive Summary", default: true },
  { id: "systemInventory", label: "System Inventory", default: true },
  { id: "hardwareHealthOverview", label: "Hardware Health Overview", default: true },
  { id: "cpuAnalysis", label: "CPU Analysis", default: true },
  { id: "gpuAnalysis", label: "GPU Analysis", default: true },
  { id: "memoryAnalysis", label: "Memory Analysis", default: true },
  { id: "storageAnalysis", label: "Storage Analysis", default: true },
  { id: "networkAnalysis", label: "Network Analysis", default: true },
  { id: "connectivityStatus", label: "Connectivity Status", default: true },
  { id: "activeFaults", label: "Active Faults", default: true },
  { id: "faultTimeline", label: "Fault Timeline", default: true },
  { id: "recoveryHistory", label: "Autonomous Recovery History", default: true },
  { id: "aiRootCause", label: "AI Root Cause Analysis", default: true },
  { id: "recommendations", label: "Recommendations", default: true },
  { id: "historicalTrends", label: "Historical Trends", default: true },
  { id: "rawTelemetry", label: "Raw Telemetry Appendix", default: true },
];

export const DEFAULT_SECTION_SELECTION = Object.fromEntries(
  REPORT_SECTIONS.map((s) => [s.id, s.default])
);

function hasCpuData(reportData) {
  const inv = reportData.inventory?.cpu;
  const metrics = reportData.hardwareMetrics?.some((r) =>
    String(r[0]).toLowerCase().includes("cpu")
  );
  const comp = reportData.componentAnalysis?.find((c) => c.name === "CPU");
  return Boolean(inv?.model || metrics || comp?.liveMetrics?.length);
}

function hasGpuData(reportData) {
  const gpus = reportData.inventory?.gpus;
  const metrics = reportData.hardwareMetrics?.some((r) =>
    String(r[0]).toLowerCase().includes("gpu")
  );
  const comp = reportData.componentAnalysis?.find((c) => c.name === "GPU");
  return Boolean(gpus?.length || metrics || comp?.liveMetrics?.length);
}

function hasMemoryData(reportData) {
  const mem = reportData.inventory?.memory;
  const metrics = reportData.hardwareMetrics?.some((r) =>
    String(r[0]).toLowerCase().includes("memory") || String(r[0]).toLowerCase().includes("swap")
  );
  return Boolean(mem?.dimm_count || metrics);
}

function hasStorageData(reportData) {
  const disks = reportData.inventory?.disks;
  const metrics = reportData.hardwareMetrics?.some((r) =>
    String(r[0]).toLowerCase().startsWith("disk")
  );
  return Boolean(disks?.length || metrics);
}

function hasNetworkData(reportData) {
  const nics = reportData.inventory?.nics;
  const metrics = reportData.hardwareMetrics?.some((r) =>
    String(r[0]).toLowerCase().includes("nic")
  );
  return Boolean(nics?.length || metrics);
}

const AVAILABILITY_CHECKS = {
  executiveSummary: (d) => Boolean(d.context?.inventory || d.sampleCount > 0),
  systemInventory: (d) => Boolean(d.inventory),
  hardwareHealthOverview: (d) => (d.componentHealthSnapshot?.length ?? 0) > 0,
  cpuAnalysis: hasCpuData,
  gpuAnalysis: hasGpuData,
  memoryAnalysis: hasMemoryData,
  storageAnalysis: hasStorageData,
  networkAnalysis: hasNetworkData,
  connectivityStatus: (d) => Boolean(d.connectivityStatus?.linkHealth),
  activeFaults: (d) => (d.faults?.filter((f) => f.severity !== "Resolved")?.length ?? 0) > 0,
  faultTimeline: (d) => (d.faults?.length ?? 0) > 0,
  recoveryHistory: (d) => (d.recoveryHistory?.length ?? 0) > 0,
  aiRootCause: (d) => (d.aiRootCause?.length ?? 0) > 0,
  recommendations: (d) =>
    (d.sampleCount > 0 || (d.faults?.filter((f) => f.severity !== "Resolved")?.length ?? 0) > 0) &&
    (d.recommendations?.length ?? 0) > 0,
  historicalTrends: (d) => (d.trendSeries?.length ?? 0) > 0,
  rawTelemetry: (d) => (d.sampleCount ?? 0) > 0,
};

export function getAvailableSections(reportData) {
  return REPORT_SECTIONS.filter((section) => {
    const check = AVAILABILITY_CHECKS[section.id];
    return check ? check(reportData) : false;
  });
}

export function filterSelectedSections(reportData, sectionSelection) {
  const available = new Set(getAvailableSections(reportData).map((s) => s.id));
  return Object.fromEntries(
    Object.entries(sectionSelection).map(([id, selected]) => [
      id,
      selected && available.has(id),
    ])
  );
}

export function buildPreviewPages(reportData, activeSections) {
  const pages = [];
  let pageNum = 1;

  function addPage(title, items) {
    const content = items.filter(Boolean);
    if (content.length === 0) return;
    pages.push({ page: pageNum++, title, sections: content });
  }

  if (activeSections.executiveSummary) {
    addPage("Executive Summary", [
      "Health Score",
      reportData.executive?.healthScore != null
        ? `Score: ${reportData.executive.healthScore}`
        : null,
      "System Information",
      reportData.executive?.hostname,
      reportData.executive?.os,
      activeSections.systemInventory ? "Hardware Inventory" : null,
    ]);
  } else if (activeSections.systemInventory && reportData.inventory) {
    addPage("System Inventory", [
      reportData.inventory.system?.hostname,
      reportData.inventory.cpu?.model,
      `${reportData.inventory.disks?.length || 0} storage device(s)`,
    ]);
  }

  if (activeSections.hardwareHealthOverview && reportData.componentHealthSnapshot?.length) {
    addPage("Hardware Health Overview", reportData.componentHealthSnapshot.map(
      (c) => `${c.name}: ${c.level}`
    ));
  }

  if (activeSections.cpuAnalysis && hasCpuData(reportData)) {
    const cpu = reportData.componentAnalysis?.find((c) => c.name === "CPU");
    addPage("CPU", [
      "Charts",
      "Utilization",
      reportData.hardwareMetrics?.find((r) => r[0] === "CPU Usage")?.[1]
        ? `Avg: ${reportData.hardwareMetrics.find((r) => r[0] === "CPU Usage")[1]}`
        : null,
      "Temperature",
      cpu?.liveMetrics?.find(([k]) => k === "Temperature")?.[1] || null,
    ]);
  }

  if (activeSections.gpuAnalysis && hasGpuData(reportData)) {
    const gpu = reportData.componentAnalysis?.find((c) => c.name === "GPU");
    addPage("GPU", [
      "Charts",
      "Processes",
      "Thermals",
      gpu?.liveMetrics?.find(([k]) => k === "Temperature")?.[1] || null,
    ]);
  }

  if (activeSections.memoryAnalysis && hasMemoryData(reportData)) {
    addPage("Memory", ["Usage Trends", "Capacity", "Swap Analysis"]);
  }

  if (activeSections.storageAnalysis && hasStorageData(reportData)) {
    addPage("Storage", (reportData.inventory?.disks || []).slice(0, 4).map(
      (d) => `${d.device}: ${d.model || "—"}`
    ));
  }

  if (activeSections.networkAnalysis && hasNetworkData(reportData)) {
    addPage("Network", (reportData.inventory?.nics || []).slice(0, 4).map(
      (n) => `${n.name}: ${n.model || n.speed || "—"}`
    ));
  }

  if (activeSections.connectivityStatus && reportData.connectivityStatus) {
    addPage("Connectivity Status", [
      `Overall: ${reportData.connectivityStatus.linkHealth?.overall || "—"}`,
      `Score: ${reportData.connectivityStatus.linkHealth?.score ?? "—"}`,
    ]);
  }

  const timelineItems = [];
  if (activeSections.faultTimeline && reportData.faults?.length) {
    timelineItems.push("Fault Timeline");
    reportData.faults.slice(0, 3).forEach((f) => {
      timelineItems.push(`[${f.severity}] ${f.component}`);
    });
  }
  if (activeSections.recoveryHistory && reportData.recoveryHistory?.length) {
    timelineItems.push("Recovery History");
    reportData.recoveryHistory.slice(0, 2).forEach((r) => {
      timelineItems.push(`${r.component}: ${r.result}`);
    });
  }
  if (activeSections.recommendations && reportData.recommendations?.length) {
    timelineItems.push("Recommendations");
    reportData.recommendations.slice(0, 2).forEach((r) => timelineItems.push(r.slice(0, 60)));
  }
  if (timelineItems.length) addPage("Fault & Recovery", timelineItems);

  if (activeSections.historicalTrends && reportData.trendSeries?.length) {
    addPage("Historical Trends", reportData.trendSeries.slice(0, 5).map((s) => s.label));
  }

  if (activeSections.rawTelemetry && reportData.sampleCount > 0) {
    addPage("Appendix", [
      "Raw Telemetry",
      `${reportData.sampleCount} sample(s)`,
      reportData.span?.label,
    ]);
  }

  return pages;
}
