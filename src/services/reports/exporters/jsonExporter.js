/**
 * JSON report export — machine-readable SQLite historical payload.
 */

export function exportReportJson(reportData) {
  const cov = reportData.dataCoverage || {};
  const payload = {
    reportMetadata: {
      title: reportData.title,
      reportId: reportData.reportId,
      generatedAt: reportData.generatedAt?.toISOString?.() || reportData.generatedAt,
      generatedBy: reportData.generatedBy,
      intervalLabel: reportData.intervalLabel,
      dataSource: reportData.dataSource,
      database: reportData.database,
      rawSampleCount: cov.rawSampleCount ?? reportData.telemetryRawCount,
      reportPointCount: cov.reportPointCount ?? reportData.sampleCount,
    },
    reportPeriod: reportData.reportPeriod || {},
    dataCoverage: cov,
    componentSummary: reportData.componentOverview || [],
    componentSections: (reportData.componentSections || []).map((c) => ({
      name: c.name,
      status: c.status,
      stats: c.stats,
      latestRecorded: c.latestRecorded,
      thresholds: c.thresholds,
      interpretation: c.interpretation,
      peakAt: c.peakAt,
      charts: (c.charts || []).map((ch) => ({
        title: ch.title,
        unit: ch.unit || ch.yLabel,
        warning: ch.warning,
        critical: ch.critical,
        points: ch.points,
        eventMarkers: ch.eventMarkers || null,
      })),
    })),
    historicalTelemetry: (reportData.telemetry || reportData.rawSamples || []).map((s) => ({
      timestamp: s.timestamp || (s.t != null ? new Date(s.t).toISOString() : null),
      collected_at: s.collected_at,
      cpu_usage: s.cpu_usage,
      cpu_temp: s.cpu_temp,
      mem_usage: s.mem_usage,
      mem_available_gb: s.mem_available_gb,
      gpu_util: s.gpu_util,
      gpu_vram: s.gpu_vram,
      gpu_temp: s.gpu_temp,
      nic_util: s.nic_util,
      nic_rx: s.nic_rx,
      nic_tx: s.nic_tx,
      io_busy: s.io_busy,
      io_total_mbps: s.io_total_mbps,
      io_iops: s.io_iops,
      io_queue: s.io_queue,
      io_latency: s.io_latency,
      lh_score: s.lh_score,
    })),
    graphSeries: {
      systemResourceTrend: reportData.systemResourceTrend || null,
      byComponent: reportData.graphs?.byComponent || {},
      eventMarkers: reportData.eventMarkers || null,
    },
    faultEvents: reportData.faultEvents || reportData.faults || [],
    recoveryEvents: reportData.recoveryEvents || reportData.recoveryHistory || [],
    significantEvents: reportData.significantEvents || reportData.spikes || [],
    infrastructureTimeline: reportData.infrastructureTimeline || [],
    faultRecoveryChains: reportData.faultRecoveryChains || [],
    activitySummary: reportData.activitySummary || [],
    digitalTwinEvents: reportData.digitalTwin || [],
    visualAnalysis: (reportData.componentSections || []).map((c) => ({
      component: c.name,
      commentary: c.interpretation,
      average: c.stats?.avg,
      peak: c.stats?.max,
      minimum: c.stats?.min,
    })),
    spikes: reportData.spikes || [],
    recommendations: reportData.recommendations || {},
    gaps: reportData.gaps || [],
  };

  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${sanitizeFilename(reportData.title)}_${stamp}.json`;
  return { blob, filename, pageCount: null, sizeBytes: blob.size, format: "json" };
}

function sanitizeFilename(name) {
  return (name || "Infrastructure_Health_Incident_Report").replace(/[^\w-]+/g, "_").slice(0, 60);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
