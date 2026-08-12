/**
 * Report section definitions for the professional infrastructure health + incident logbook report.
 */

export const REPORT_SECTIONS = [
  { id: "executiveSummary", label: "Executive Summary", default: true },
  { id: "dataCoverage", label: "Historical Data Coverage", default: true },
  { id: "hardwareHealthOverview", label: "Component Health Overview", default: true },
  { id: "cpuAnalysis", label: "CPU Analysis", default: true },
  { id: "gpuAnalysis", label: "GPU Analysis", default: true },
  { id: "memoryAnalysis", label: "Memory Analysis", default: true },
  { id: "storageAnalysis", label: "Disk Analysis", default: true },
  { id: "networkAnalysis", label: "NIC Analysis", default: true },
  { id: "ioAnalysis", label: "I/O Analysis", default: true },
  { id: "historicalTrends", label: "Infrastructure Historical Trends", default: true },
  { id: "faultTimeline", label: "Fault & Incident Log", default: true },
  { id: "recoveryHistory", label: "Recovery Action Log", default: true },
  { id: "faultRecoveryTimeline", label: "Fault → Recovery Timeline", default: true },
  { id: "spikeAnalysis", label: "Significant Event / Spike Analysis", default: true },
  { id: "activitySummary", label: "Infrastructure Activity Summary", default: true },
  { id: "digitalTwin", label: "Digital Twin History", default: true },
  { id: "recommendations", label: "Recommendations", default: true },
  { id: "rawTelemetry", label: "Appendix / Metadata", default: true },
];

export const DEFAULT_SECTION_SELECTION = Object.fromEntries(
  REPORT_SECTIONS.map((s) => [s.id, s.default])
);

function hasComponent(reportData, name) {
  const section = (reportData.componentSections || []).find(
    (c) => String(c.name || "").toLowerCase() === name.toLowerCase()
  );
  if (section?.stats?.count > 0 || section?.charts?.length) return true;
  return (reportData.sampleCount || 0) > 0 && ["CPU", "RAM"].includes(name);
}

function hasRecommendations(d) {
  const r = d.recommendations;
  if (!r) return false;
  if (Array.isArray(r)) return r.length > 0;
  return Boolean(
    (r.immediate || []).length || (r.preventive || []).length || (r.monitoring || []).length
  );
}

const AVAILABILITY_CHECKS = {
  executiveSummary: () => true,
  dataCoverage: (d) => Boolean(d.dataCoverage),
  hardwareHealthOverview: (d) => (d.componentOverview?.length || d.componentSections?.length || 0) > 0,
  cpuAnalysis: (d) => hasComponent(d, "CPU"),
  gpuAnalysis: (d) => hasComponent(d, "GPU"),
  memoryAnalysis: (d) => hasComponent(d, "RAM"),
  storageAnalysis: (d) => hasComponent(d, "DISK"),
  networkAnalysis: (d) => hasComponent(d, "NIC"),
  ioAnalysis: (d) => hasComponent(d, "IO") || hasComponent(d, "I/O"),
  historicalTrends: () => true,
  faultTimeline: () => true,
  recoveryHistory: () => true,
  faultRecoveryTimeline: () => true,
  spikeAnalysis: () => true,
  activitySummary: () => true,
  digitalTwin: () => true,
  recommendations: hasRecommendations,
  rawTelemetry: () => true,
};

export function getAvailableSections(reportData) {
  return REPORT_SECTIONS.filter((section) => {
    const check = AVAILABILITY_CHECKS[section.id];
    return check ? check(reportData) : false;
  });
}

export function filterSelectedSections(reportData, sectionSelection) {
  const available = new Set(getAvailableSections(reportData).map((s) => s.id));
  const active = {};
  REPORT_SECTIONS.forEach((section) => {
    const selected = sectionSelection?.[section.id] !== false;
    active[section.id] = selected && available.has(section.id);
  });
  if (available.has("executiveSummary")) active.executiveSummary = true;
  if (available.has("dataCoverage")) active.dataCoverage = sectionSelection?.dataCoverage !== false;
  return active;
}
