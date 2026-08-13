/**
 * Link Health Service
 * Parses /link_health telemetry into FBL-domain structures:
 * component health signals, fault log entries, and anomaly category cards.
 */

const COLORS = {
  healthy: "#00e676",
  warning: "#FF9800",
  critical: "#B71C1C",
  unknown: "#95A7C7",
  white: "#ffffff",
};

const COMPONENT_DOTS = {
  CPU: "#4d9fff",
  GPU: "#ffd700",
  RAM: "#00ff88",
  DISK: "#ff8c00",
  NIC: "#00bfff",
  "IO Control": "#00ffff",
};

const AFFECTED_PATHS = {
  CPU: "CPU → Platform → All subsystems",
  GPU: "GPU → PCIe → CPU",
  RAM: "RAM → Memory Bus → CPU (IMC)",
  DISK: "DISK → NVMe/SATA → CPU (PCIe)",
  NIC: "NIC → PCIe → CPU",
  "IO Control": "IO Control → Block I/O / DMI/PCIe → CPU",
};

/** GPU metric thresholds — single source for health, faults, and anomaly cards */
const GPU_TEMP_THRESHOLDS = {
  warningC: 80,
  criticalC: 90,
};

const GPU_UTIL_THRESHOLDS = {
  warningMin: 90,
  criticalMin: 97,
};

/** CPU metric thresholds — industry-standard sustained utilization (80/90 rule) */
const CPU_UTIL_THRESHOLDS = {
  warningMin: 80,
  criticalMin: 90,
};

/** NIC link utilization thresholds — combined RX+TX vs negotiated link speed */
export const NIC_UTIL_THRESHOLDS = {
  warningMin: 10, // TESTING ONLY — revert to 70 for production
  criticalMin: 20, // TESTING ONLY — revert to 80 for production
};

/**
 * I/O (block-device) thresholds — DEMO-TUNED for dd / stress-ng.
 * Source metric: metrics.disk.performance (CM.py /metrics).
 * Raise these for production; keep them easy to find/edit here.
 */
export const IO_BUSY_THRESHOLDS = {
  warningMin: 25, // TESTING/DEMO — production often ~70
  criticalMin: 50, // TESTING/DEMO — production often ~80
};

export const IO_QUEUE_THRESHOLDS = {
  warningMin: 4, // TESTING/DEMO — production often ~16
  criticalMin: 12, // TESTING/DEMO — production often ~32
};

export const IO_LATENCY_THRESHOLDS = {
  warningMin: 20, // ms — industry-standard sustained I/O latency warning
  criticalMin: 100, // ms — industry-standard critical I/O latency
};

export const IO_THROUGHPUT_THRESHOLDS = {
  warningMin: 50, // MB/s — easy to hit with dd oflag=direct
  criticalMin: 150, // MB/s
};

function ioBusyThresholdLabel(severity) {
  return severity === "Critical"
    ? `≥ ${IO_BUSY_THRESHOLDS.criticalMin}% (Critical)`
    : `≥ ${IO_BUSY_THRESHOLDS.warningMin}% (Warning)`;
}

function ioQueueThresholdLabel(severity) {
  return severity === "Critical"
    ? `≥ ${IO_QUEUE_THRESHOLDS.criticalMin} (Critical)`
    : `≥ ${IO_QUEUE_THRESHOLDS.warningMin} (Warning)`;
}

function ioLatencyThresholdLabel(severity) {
  return severity === "Critical"
    ? `≥ ${IO_LATENCY_THRESHOLDS.criticalMin} ms (Critical)`
    : `≥ ${IO_LATENCY_THRESHOLDS.warningMin} ms (Warning)`;
}

function ioThroughputThresholdLabel(severity) {
  return severity === "Critical"
    ? `≥ ${IO_THROUGHPUT_THRESHOLDS.criticalMin} MB/s (Critical)`
    : `≥ ${IO_THROUGHPUT_THRESHOLDS.warningMin} MB/s (Warning)`;
}

/**
 * CPU thermal_throttle sysfs counters are lifetime totals (often millions on
 * busy hosts). Call syncCpuThrottlePoll once per telemetry poll, then read delta.
 */
let _lastCpuThrottleTotal = null;
let _pollThrottleDelta = 0;

function cpuThrottleLifetimeTotal(cpuHealth) {
  const h = cpuHealth || {};
  return (
    (h.thermal_throttling_total_core_count || 0) +
    (h.thermal_throttling_total_package_count || 0)
  );
}

export function syncCpuThrottlePoll(linkHealth) {
  const cpuH = (linkHealth?.cpu || {}).health || {};
  const total = cpuThrottleLifetimeTotal(cpuH);
  const prev = _lastCpuThrottleTotal;
  _lastCpuThrottleTotal = total;
  _pollThrottleDelta = prev == null ? 0 : Math.max(0, total - prev);
  return _pollThrottleDelta;
}

export function getCpuThrottlePollDelta() {
  return _pollThrottleDelta;
}

function ioBusyLevel(busyPct) {
  if (busyPct == null) return null;
  if (busyPct >= IO_BUSY_THRESHOLDS.criticalMin) return "critical";
  if (busyPct >= IO_BUSY_THRESHOLDS.warningMin) return "warning";
  return "healthy";
}

/** Peak I/O device from live disk.performance telemetry. */
export function getPrimaryIoDevice(metrics) {
  const perfList = metrics?.disk?.performance || [];
  if (!perfList.length) return null;
  return perfList.reduce((best, p) => {
    const score =
      (num(p.busy_percent) || 0) +
      (num(p.queue_depth) || 0) +
      (num(p.total_MB_per_sec) || 0);
    const bestScore =
      (num(best?.busy_percent) || 0) +
      (num(best?.queue_depth) || 0) +
      (num(best?.total_MB_per_sec) || 0);
    return score >= bestScore ? p : best;
  }, perfList[0]);
}

export function buildIoTelemetryDetail(metrics) {
  const primary = getPrimaryIoDevice(metrics);
  if (!primary) return null;
  const busy = num(primary.busy_percent);
  return {
    device: primary.device,
    transport: primary.transport,
    busyPercent: busy,
    readMBps: num(primary.read_MB_per_sec),
    writeMBps: num(primary.write_MB_per_sec),
    totalMBps: num(primary.total_MB_per_sec),
    readIops: num(primary.read_IOPS),
    writeIops: num(primary.write_IOPS),
    totalIops: num(primary.total_IOPS),
    queueDepth: num(primary.queue_depth),
    averageLatencyMs: num(primary.average_latency_ms),
    thresholdLevel: ioBusyLevel(busy) || "healthy",
    warningBusyMin: IO_BUSY_THRESHOLDS.warningMin,
    criticalBusyMin: IO_BUSY_THRESHOLDS.criticalMin,
  };
}

function nicUtilThresholdLabel(severity) {
  return severity === "Critical"
    ? `≥ ${NIC_UTIL_THRESHOLDS.criticalMin}% (Critical)`
    : `≥ ${NIC_UTIL_THRESHOLDS.warningMin}% (Warning)`;
}

export function getPrimaryNicInterface(metrics) {
  const nics = metrics?.nic || [];
  const sys = metrics?.system || {};
  const def = sys.default_route_interface;
  const physical = enumeratePhysicalNetworkInterfaces(nics);
  const up = physical.filter(isLinkUp);
  if (def) {
    const match = up.find((n) => n.name === def) || nics.find((n) => n.name === def);
    if (match) return match;
  }
  return up[0] || physical[0] || null;
}

function nicUtilizationLevel(utilPct) {
  if (utilPct == null) return null;
  if (utilPct >= NIC_UTIL_THRESHOLDS.criticalMin) return "critical";
  if (utilPct >= NIC_UTIL_THRESHOLDS.warningMin) return "warning";
  return "healthy";
}

export function buildNicTelemetryDetail(metrics) {
  const primary = getPrimaryNicInterface(metrics);
  if (!primary) return null;
  const util = num(primary.utilization_percent);
  const thresholdLevel =
    nicUtilizationLevel(util) || primary.utilization_threshold_status || "healthy";
  return {
    interface: primary.name,
    linkState: primary.link_state,
    speedMbps: num(primary.speed_mbps) ?? num(primary.speed),
    utilizationPercent: util,
    rxMbps: num(primary.rx_mbps),
    txMbps: num(primary.tx_mbps),
    rxPacketsPerSec: num(primary.rx_packets_per_sec),
    txPacketsPerSec: num(primary.tx_packets_per_sec),
    rxErrors: primary.rx_errors ?? 0,
    txErrors: primary.tx_errors ?? 0,
    rxDropped: primary.rx_dropped ?? 0,
    txDropped: primary.tx_dropped ?? 0,
    thresholdLevel,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cpuUtilThresholdLabel(severity) {
  return severity === "Critical"
    ? `≥ ${CPU_UTIL_THRESHOLDS.criticalMin}% (Critical)`
    : `≥ ${CPU_UTIL_THRESHOLDS.warningMin}% (Warning)`;
}

const CPU_TEMP_THRESHOLDS = {
  warningC: 75,
  criticalC: 85,
};

const LINK_HEALTH_SCORE_PENALTY = {
  critical: 25,
  warning: 12,
};

function gpuTemperatureLevel(tempC) {
  if (tempC == null || Number.isNaN(Number(tempC))) return null;
  const t = Number(tempC);
  if (t >= GPU_TEMP_THRESHOLDS.criticalC) return "critical";
  if (t >= GPU_TEMP_THRESHOLDS.warningC) return "warning";
  return "healthy";
}

/**
 * Util > 97% is Critical only when accompanied by elevated GPU temperature (≥ warning band).
 * Otherwise util > 97% stays Warning; 90–97% is Warning; below 90% is Healthy.
 */
function gpuUtilizationLevel(utilPct, tempC) {
  if (utilPct == null || Number.isNaN(Number(utilPct))) return null;
  const u = Number(utilPct);
  if (u > GPU_UTIL_THRESHOLDS.criticalMin) {
    const tempLevel = gpuTemperatureLevel(tempC);
    if (tempLevel === "critical" || tempLevel === "warning") return "critical";
    return "warning";
  }
  if (u >= GPU_UTIL_THRESHOLDS.warningMin) return "warning";
  return "healthy";
}

function gpuMemoryUtilizationLevel(vramPct) {
  if (vramPct == null || Number.isNaN(Number(vramPct))) return null;
  if (Number(vramPct) >= 90) return "warning";
  return "healthy";
}

function gpuPowerDrawLevel(powerDrawW, powerLimitW) {
  if (powerDrawW == null || powerLimitW == null) return null;
  if (Number(powerDrawW) >= Number(powerLimitW) * 0.95) return "warning";
  return "healthy";
}

function gpuLinkStatusLevel(linkStatus) {
  if (linkStatus == null || linkStatus === "") return null;
  const s = String(linkStatus);
  if (/^critical$/i.test(s)) return "critical";
  if (/^warning$/i.test(s)) return "warning";
  return "healthy";
}

function gpuFanLevel(fanPct, tempC) {
  if (fanPct == null || Number.isNaN(Number(fanPct))) return null;
  const tempLevel = gpuTemperatureLevel(tempC);
  if ((tempLevel === "warning" || tempLevel === "critical") && Number(fanPct) < 20) {
    return tempLevel === "critical" ? "critical" : "warning";
  }
  return "healthy";
}

/**
 * Worst level across link_health GPU section and live GPU telemetry fields.
 */
function computeGpuHealthLevel(gpuM, linkHealthGpuLevel = null) {
  const levels = [];

  if (linkHealthGpuLevel && linkHealthGpuLevel !== "unknown") {
    levels.push(linkHealthGpuLevel);
  }

  if (gpuM) {
    const metricLevels = [
      gpuTemperatureLevel(gpuM.temperature_celsius),
      gpuUtilizationLevel(gpuM.gpu_utilization_percent, gpuM.temperature_celsius),
      gpuMemoryUtilizationLevel(gpuM.memory_utilization_percent),
      gpuPowerDrawLevel(gpuM.power_draw_watts, gpuM.power_limit_watts),
      gpuLinkStatusLevel(gpuM.link_status),
      gpuFanLevel(gpuM.fan_speed_percent, gpuM.temperature_celsius),
    ].filter(Boolean);

    levels.push(...metricLevels);
  }

  if (levels.length === 0) return "healthy";
  return levels.reduce((worst, current) => worstLevel(worst, current), "healthy");
}

function coerceGpuArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return [value];
  return [];
}

function pickGpuField(...sources) {
  for (const src of sources) {
    if (src == null) continue;
    if (Array.isArray(src)) {
      const found = src.find((v) => v != null);
      if (found != null) return found;
      continue;
    }
    return src;
  }
  return null;
}

function gpuEntriesFromPci(inventory) {
  const pci = inventory?.io?.pci || [];
  return pci.filter((p) =>
    /vga|3d controller|display controller|nvidia|geforce|radeon|amd/i.test(
      `${p.class || ""} ${p.device || ""} ${p.vendor || ""}`
    )
  );
}

function mergeGpuRecord(metricGpu, inventoryGpu, linkHealthGpu) {
  const inv = inventoryGpu || {};
  const met = metricGpu || {};
  const lh = linkHealthGpu || {};
  const lhH = lh.health || {};

  return {
    ...inv,
    ...met,
    model: pickGpuField(met.model, inv.model, lh.model),
    vendor: pickGpuField(met.vendor, inv.vendor),
    pci_bus_id: pickGpuField(met.pci_bus_id, inv.pci_bus_id, lh.pci_bus_id),
    driver_version: pickGpuField(met.driver_version, inv.driver_version),
    cuda_version: pickGpuField(met.cuda_version, inv.cuda_version),
    temperature_celsius: pickGpuField(
      met.temperature_celsius,
      inv.temperature_celsius,
      lhH.temperature_celsius
    ),
    gpu_utilization_percent: pickGpuField(
      met.gpu_utilization_percent,
      inv.gpu_utilization_percent,
      lhH.gpu_utilization_percent
    ),
    memory_utilization_percent: pickGpuField(
      met.memory_utilization_percent,
      inv.memory_utilization_percent,
      lhH.memory_utilization_percent
    ),
    memory_used_mb: pickGpuField(met.memory_used_mb, inv.memory_used_mb),
    memory_free_mb: pickGpuField(met.memory_free_mb, inv.memory_free_mb),
    vram_total_mb: pickGpuField(met.vram_total_mb, inv.vram_total_mb),
    power_draw_watts: pickGpuField(met.power_draw_watts, inv.power_draw_watts, lhH.power_draw_watts),
    power_limit_watts: pickGpuField(met.power_limit_watts, inv.power_limit_watts, lhH.power_limit_watts),
    fan_speed_percent: pickGpuField(
      met.fan_speed_percent,
      inv.fan_speed_percent,
      lhH.fan_speed_percent
    ),
    graphics_clock_mhz: pickGpuField(met.graphics_clock_mhz, inv.graphics_clock_mhz),
    memory_clock_mhz: pickGpuField(met.memory_clock_mhz, inv.memory_clock_mhz),
    link_status: lhH.link_status || null,
  };
}

/** Align with LinuxDashboard: metrics.gpu, else inventory.gpu, plus link_health overlays */
export function normalizeGpuList(metrics, inventory, linkHealth) {
  const metricGpus = coerceGpuArray(metrics?.gpu);
  const invGpus = coerceGpuArray(inventory?.gpu);
  const lhGpus = coerceGpuArray(linkHealth?.gpu);
  const base = metricGpus.length > 0 ? metricGpus : invGpus;

  if (base.length === 0) {
    return gpuEntriesFromPci(inventory).map((p) =>
      mergeGpuRecord(
        null,
        {
          vendor: p.vendor,
          model: p.device || p.vendor,
          pci_bus_id: p.slot || p.address,
        },
        null
      )
    );
  }

  return base.map((entry, idx) =>
    mergeGpuRecord(entry, invGpus[idx] || invGpus[0], lhGpus[idx] || lhGpus[0])
  );
}

export function getPrimaryGpu(metrics, inventory, linkHealth) {
  const list = normalizeGpuList(metrics, inventory, linkHealth);
  return list[0] || null;
}

function gpuHasIdentity(gpu) {
  return Boolean(gpu && (gpu.model || gpu.vendor || gpu.pci_bus_id));
}

function abbreviateGpuModel(model) {
  if (!model) return null;
  const bracket = model.match(/\[([^\]]+)\]/);
  if (bracket) {
    return bracket[1].replace(/^GeForce\s+/i, "").trim();
  }
  if (model.length > 36) return `${model.slice(0, 33)}…`;
  return model;
}

function buildNicStatusParts(primaryNic, nicUtil) {
  const parts = [];
  if (nicUtil != null) parts.push(`${nicUtil}% util`);
  if (primaryNic) {
    parts.push(`${primaryNic.name} ${String(primaryNic.link_state || "?").toUpperCase()}`);
    const speed = primaryNic.speed_mbps ?? primaryNic.speed;
    if (speed != null) parts.push(`${speed} Mbps`);
    if (primaryNic.rx_mbps != null) parts.push(`RX ${primaryNic.rx_mbps} Mbps`);
    if (primaryNic.tx_mbps != null) parts.push(`TX ${primaryNic.tx_mbps} Mbps`);
  }
  return parts;
}

function formatNicAssessmentStatus(nicLevel, primaryNic, nicUtil) {
  const parts = buildNicStatusParts(primaryNic, nicUtil);
  if (parts.length > 0) return `${statusLabel(nicLevel)} — ${parts.join(", ")}`;
  return `${statusLabel(nicLevel)} — nominal`;
}

function buildGpuStatusParts(gpuM) {
  const parts = [];
  parts.push(
    gpuM.gpu_utilization_percent != null && !Number.isNaN(Number(gpuM.gpu_utilization_percent))
      ? `${gpuM.gpu_utilization_percent}% util`
      : "— util"
  );
  parts.push(
    gpuM.temperature_celsius != null && !Number.isNaN(Number(gpuM.temperature_celsius))
      ? `${gpuM.temperature_celsius}°C`
      : "—°C"
  );

  const shortName = abbreviateGpuModel(gpuM.model || gpuM.vendor);
  if (shortName) parts.push(shortName);

  if (gpuM.memory_utilization_percent != null) {
    parts.push(`VRAM ${gpuM.memory_utilization_percent}%`);
  } else if (gpuM.memory_used_mb != null && gpuM.vram_total_mb != null) {
    parts.push(`VRAM ${gpuM.memory_used_mb}/${gpuM.vram_total_mb} MB`);
  }
  if (gpuM.fan_speed_percent != null) parts.push(`fan ${gpuM.fan_speed_percent}%`);
  if (gpuM.power_draw_watts != null) {
    parts.push(
      gpuM.power_limit_watts != null
        ? `${gpuM.power_draw_watts}/${gpuM.power_limit_watts}W`
        : `${gpuM.power_draw_watts}W`
    );
  }
  if (gpuM.graphics_clock_mhz != null) parts.push(`${gpuM.graphics_clock_mhz} MHz core`);
  if (gpuM.link_status && !/^healthy$/i.test(String(gpuM.link_status))) {
    parts.push(`PCIe ${gpuM.link_status}`);
  }
  return parts;
}

function formatGpuAssessmentStatus(gpuLevel, gpuM, gpuParts) {
  if (gpuParts.length > 0) {
    return `${statusLabel(gpuLevel)} — ${gpuParts.join(", ")}`;
  }
  if (gpuHasIdentity(gpuM)) {
    const pci = gpuM.pci_bus_id ? ` · ${gpuM.pci_bus_id}` : "";
    return `${statusLabel(gpuLevel)} — GPU detected${pci}`;
  }
  return `${statusLabel(gpuLevel)} — nominal`;
}

const VIRTUAL_INTERFACE_PATTERNS = [
  /^lo$/i,
  /^docker/i,
  /^virbr/i,
  /^veth/i,
  /^br[-_]/i,
  /^tun\d*/i,
  /^tap\d*/i,
  /^wg\d*/i,
  /^tailscale/i,
  /^zt\d*/i,
  /^cni/i,
  /^flannel/i,
  /^kube/i,
  /^calico/i,
  /^cali/i,
  /^dummy/i,
  /^nodelocaldns/i,
  /^cilium/i,
  /^ppp/i,
  /^vpn/i,
  /^nordlynx/i,
  /^utun/i,
  /^ipsec/i,
  /^l2tp/i,
  /^openvpn/i,
  /^nm-/i,
];

/** Cumulative error/drop counters below this are treated as nominal (not a NIC quality fault). */
const NIC_COUNTER_WARNING_THRESHOLD = 100;

function isLoopbackInterface(name) {
  return String(name || "").toLowerCase() === "lo";
}

function isVirtualOrIgnoredInterface(name) {
  if (!name) return true;
  if (isLoopbackInterface(name)) return true;
  return VIRTUAL_INTERFACE_PATTERNS.some((re) => re.test(String(name)));
}

/** Non-loopback, non-virtual interfaces (Ethernet, Wi-Fi, etc.) — names not hardcoded. */
function enumeratePhysicalNetworkInterfaces(interfaces) {
  return (interfaces || []).filter(
    (iface) => Boolean(iface?.name) && !isVirtualOrIgnoredInterface(iface.name)
  );
}

function isLinkUp(iface) {
  const link = String(iface?.link_state || "").toLowerCase();
  if (link === "up") return true;
  if (link === "down") return false;
  const oper = String(iface?.operstate || iface?.oper_state || "").toLowerCase();
  return oper === "up";
}

function interfaceCounterTotal(iface) {
  return (
    (iface?.rx_errors || 0) +
    (iface?.tx_errors || 0) +
    (iface?.rx_dropped || 0) +
    (iface?.tx_dropped || 0) +
    (iface?.collisions || 0)
  );
}

function interfaceExceedsCounterThreshold(iface) {
  return interfaceCounterTotal(iface) > NIC_COUNTER_WARNING_THRESHOLD;
}

function nicLinkHealthCounterTotal(health) {
  const h = health || {};
  return Object.entries(h).reduce((sum, [k, v]) => {
    if (/crc|error|drop|overrun|collision/i.test(k) && typeof v === "number" && v > 0) {
      return sum + v;
    }
    return sum;
  }, 0);
}

function nicLinkHealthHasErrors(linkHealth, upInterfaceNames) {
  const upSet =
    upInterfaceNames instanceof Set
      ? upInterfaceNames
      : new Set(Array.isArray(upInterfaceNames) ? upInterfaceNames : []);
  if (upSet.size === 0) return false;

  const arr = Array.isArray(linkHealth?.nic) ? linkHealth.nic : [];
  return arr.some((entry) => {
    const name = entry.name || entry.interface;
    if (!name || !upSet.has(name)) return false;
    return nicLinkHealthCounterTotal(entry.health) > NIC_COUNTER_WARNING_THRESHOLD;
  });
}

function interfacesWithErrors(interfaces) {
  return (interfaces || []).filter((n) => isLinkUp(n) && interfaceExceedsCounterThreshold(n));
}

function buildNicHealthyStatus(upNics, downNics) {
  const parts = [`${upNics.length} active (${upNics.map((n) => n.name).join(", ")})`];
  if (downNics.length > 0) {
    parts.push(`${downNics.length} inactive (${downNics.map((n) => n.name).join(", ")})`);
  }
  return `Healthy — ${parts.join(", ")}`;
}

/**
 * NIC health = availability (≥1 UP physical interface) + quality (errors on UP interfaces only).
 * Down/unused interfaces do not affect availability or warning counters.
 */
function evaluateNicHealth(linkHealth, metrics) {
  const lh = linkHealth || {};
  const allNics = metrics?.nic || [];
  const physicalNics = enumeratePhysicalNetworkInterfaces(allNics);
  const upNics = physicalNics.filter(isLinkUp);
  const downNics = physicalNics.filter((n) => !isLinkUp(n));
  const upNames = new Set(upNics.map((n) => n.name));
  const errNicsOnUp = interfacesWithErrors(upNics);
  const lhErrors = nicLinkHealthHasErrors(lh, upNames);
  const connected = hasNetworkConnectivity(metrics, upNics);
  const hasQualityIssue = errNicsOnUp.length > 0 || lhErrors;

  let nicLevel = "healthy";

  const primaryNic = getPrimaryNicInterface(metrics);
  const nicUtil = num(primaryNic?.utilization_percent);
  if (primaryNic && isLinkUp(primaryNic) && nicUtil != null) {
    if (nicUtil >= NIC_UTIL_THRESHOLDS.criticalMin) {
      nicLevel = worstLevel(nicLevel, "critical");
    } else if (nicUtil >= NIC_UTIL_THRESHOLDS.warningMin) {
      nicLevel = worstLevel(nicLevel, "warning");
    }
  }

  if (physicalNics.length === 0) {
    nicLevel = "unknown";
  } else if (upNics.length === 0) {
    nicLevel = "critical";
  } else if (hasQualityIssue) {
    nicLevel = "warning";
  }

  let status;
  if (physicalNics.length === 0) {
    status = "Unknown — no network interfaces detected";
  } else if (upNics.length === 0) {
    status = "Critical — No active network interface detected.";
  } else if (hasQualityIssue) {
    const errNames = errNicsOnUp.map((n) => n.name);
    status =
      errNames.length > 0
        ? `Warning — NIC Link Health Counters - Errors detected (${errNames.join(", ")})`
        : "Warning — NIC Link Health Counters - Errors detected";
  } else if (primaryNic && isLinkUp(primaryNic)) {
    status = formatNicAssessmentStatus(nicLevel, primaryNic, nicUtil);
  } else {
    status = buildNicHealthyStatus(upNics, downNics);
  }

  return {
    level: nicLevel,
    status,
    availabilityLevel: upNics.length === 0 && physicalNics.length > 0 ? "critical" : "healthy",
    qualityLevel: hasQualityIssue ? "warning" : "healthy",
    physicalNics,
    usableNics: physicalNics,
    upNics,
    downNics,
    allNics,
    connected,
  };
}

function hasNetworkConnectivity(metrics, upInterfaces) {
  const system = metrics?.system || {};

  if (system.network_connectivity === true || system.connectivity === true) return true;
  if (system.network_connectivity === false || system.connectivity === false) return false;
  if (system.gateway_reachable === true || system.internet_reachable === true) return true;
  if (system.gateway_reachable === false || system.internet_reachable === false) return false;

  const routeIface = system.default_route_interface || system.default_gateway_interface;
  if (routeIface && upInterfaces.some((n) => n.name === routeIface)) return true;

  return upInterfaces.length > 0;
}

function isRemovedComponentEvent(message, category, device) {
  const text = `${message || ""} ${category || ""} ${device || ""}`.toLowerCase();
  return (
    /psu|power supply|vrm rail|bmc|ipmi|smbus|management controller/i.test(text) &&
    !/motherboard|chipset|acpi/i.test(text)
  );
}

const LEVEL_PRIORITY = { critical: 3, warning: 2, healthy: 1, unknown: 0 };

function worstLevel(...levels) {
  return levels.reduce((worst, current) => {
    const lvl = current || "unknown";
    return (LEVEL_PRIORITY[lvl] ?? 0) > (LEVEL_PRIORITY[worst] ?? 0) ? lvl : worst;
  }, "unknown");
}

function healthRow(name, level, status) {
  const dot =
    level === "critical"
      ? COLORS.critical
      : level === "warning"
        ? COLORS.warning
        : level === "unknown"
          ? COLORS.unknown
          : COLORS.healthy;
  const statusColor =
    level === "healthy" || level === "unknown" ? COLORS.white : dot;
  return { name, dot, status, statusColor, level };
}

function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

function sectionStatus(key, lh) {
  const data = lh[key];
  if (isEmptyValue(data)) return "unknown";

  switch (key) {
    case "pcie": {
      const arr = Array.isArray(data) ? data : [];
      if (arr.some((d) => (d.health || {}).status === "Critical")) return "critical";
      if (arr.some((d) => (d.health || {}).status === "Warning")) return "warning";
      return arr.length ? "healthy" : "unknown";
    }
    case "gpu": {
      const arr = Array.isArray(data) ? data : [];
      if (!arr.length) return "unknown";
      const statuses = arr
        .map((g) => (g.health || {}).link_status)
        .filter(Boolean);
      if (statuses.some((s) => /^critical$/i.test(String(s)))) return "critical";
      if (statuses.some((s) => /^warning$/i.test(String(s)))) return "warning";
      return "healthy";
    }
    case "cpu": {
      const h = data.health || {};
      const throttleDelta = getCpuThrottlePollDelta();
      if ((h.fatal_errors || 0) > 0) return "critical";
      if ((h.corrected_errors || 0) > 0 || throttleDelta > 0) return "warning";
      return "healthy";
    }
    case "memory": {
      const h = data.health || {};
      if (h.supported === false) return "unknown";
      if ((h.uncorrectable_errors || 0) > 0) return "critical";
      if ((h.correctable_errors || 0) > 0) return "warning";
      return "healthy";
    }
    case "nvme": {
      const arr = Array.isArray(data) ? data : [];
      const critical = arr.some((d) => {
        const cw = d.critical_warning;
        const cwBad =
          cw !== undefined && cw !== null && cw !== 0 && cw !== "0" && cw !== "0x00";
        return cwBad || (d.media_errors || 0) > 0;
      });
      if (critical) return "critical";
      if (arr.some((d) => (d.percentage_used || 0) > 80)) return "warning";
      return arr.length ? "healthy" : "unknown";
    }
    case "sata": {
      const arr = Array.isArray(data) ? data : [];
      if (arr.some((d) => d.link_degraded)) return "warning";
      return arr.length ? "healthy" : "unknown";
    }
    case "usb": {
      const h = data.health || {};
      const bad = Object.values(h).some((v) => (v || 0) > 0);
      return bad ? "warning" : Object.keys(h).length ? "healthy" : "unknown";
    }
    case "nic": {
      const arr = Array.isArray(data) ? data : [];
      const bad = arr.some((n) => {
        const h = n.health || {};
        return Object.keys(h).some(
          (k) => /crc|error|drop|overrun|collision/i.test(k) && (h[k] || 0) > 0
        );
      });
      return bad ? "warning" : arr.length ? "healthy" : "unknown";
    }
    case "motherboard": {
      const crit = (data.pcie_errors && data.pcie_errors.critical_links) || 0;
      const warn = (data.pcie_errors && data.pcie_errors.warning_links) || 0;
      const other =
        (data.acpi_errors || 0) +
        (data.thermal_zone_errors || 0) +
        (data.power_faults || 0) +
        (data.chipset_errors || 0);
      if (crit > 0) return "critical";
      if (warn > 0 || other > 0) return "warning";
      return "healthy";
    }
    case "iommu":
      return data.enabled ? "healthy" : "unknown";
    default:
      return "unknown";
  }
}

function statusLabel(level) {
  if (level === "critical") return "Critical";
  if (level === "warning") return "Warning";
  if (level === "healthy") return "Healthy";
  return "Unknown";
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return "Just now";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return String(timestamp);
  const diffMs = Date.now() - parsed.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function inferComponent(message, category, device) {
  if (isRemovedComponentEvent(message, category, device)) return null;
  const text = `${message || ""} ${category || ""} ${device || ""}`.toLowerCase();
  if (/gpu|nvidia|cuda|vram/i.test(text)) return "GPU";
  if (/memory|ram|dimm|ecc|edac/i.test(text)) return "RAM";
  if (/disk|nvme|sata|smart|storage|ssd|hdd/i.test(text)) return "DISK";
  if (/nic|network|ethernet|link|phy/i.test(text)) return "NIC";
  if (/pci|usb|io|pch|dmi/i.test(text)) return "IO Control";
  if (/cpu|thermal|throttl/i.test(text)) return "CPU";
  return "CPU";
}

function anomalyStatus(level) {
  if (level === "critical") return "ACTIVE";
  if (level === "warning") return "MONITOR";
  return "CLEAR";
}

function overallAnomalyStatus(level) {
  if (level === "critical") return "CRITICAL";
  if (level === "warning") return "WARNING";
  return "CLEAR";
}

// ---------------------------------------------------------------------------
// Link-health component assessments (authoritative hardware error signals)
// ---------------------------------------------------------------------------

export function assessLinkHealthComponents(linkHealth, inventory, metrics) {
  const lh = linkHealth || {};
  const cpuM = metrics?.cpu || {};
  const memM = metrics?.memory || {};
  const gpuM = getPrimaryGpu(metrics, inventory, lh);

  const assessments = {};

  // CPU
  const cpuLh = lh.cpu || {};
  const cpuH = cpuLh.health || {};
  const cpuThrottleDelta = getCpuThrottlePollDelta();
  let cpuLevel = sectionStatus("cpu", lh);
  const cpuUtil = num(cpuM.usage_percent);
  const cpuTemp = num(cpuM.temperature_celsius);
  if (
    (cpuTemp != null && cpuTemp >= CPU_TEMP_THRESHOLDS.criticalC) ||
    (cpuUtil != null && cpuUtil >= CPU_UTIL_THRESHOLDS.criticalMin)
  )
    cpuLevel = worstLevel(cpuLevel, "critical");
  else if (
    (cpuTemp != null && cpuTemp >= CPU_TEMP_THRESHOLDS.warningC) ||
    (cpuUtil != null && cpuUtil >= CPU_UTIL_THRESHOLDS.warningMin)
  )
    cpuLevel = worstLevel(cpuLevel, "warning");

  const cpuParts = [];
  if (cpuH.fatal_errors > 0) cpuParts.push(`${cpuH.fatal_errors} fatal error(s)`);
  if (cpuH.corrected_errors > 0) cpuParts.push(`${cpuH.corrected_errors} corrected error(s)`);
  if (cpuThrottleDelta > 0) {
    cpuParts.push(`${cpuThrottleDelta} new throttle event(s) this poll`);
  }
  if (cpuUtil != null) {
    const utilHigh = cpuUtil >= CPU_UTIL_THRESHOLDS.warningMin ? "elevated" : "nominal";
    cpuParts.push(`${cpuUtil}% utilization (${utilHigh})`);
  }
  if (cpuTemp != null) cpuParts.push(`${cpuTemp}°C`);

  assessments.CPU = {
    level: cpuLevel,
    status:
      cpuParts.length > 0
        ? `${statusLabel(cpuLevel)} — ${cpuParts.join(", ")}`
        : `${statusLabel(cpuLevel)} — nominal`,
  };

  // RAM
  const memLh = lh.memory || {};
  const memH = memLh.health || {};
  let ramLevel = sectionStatus("memory", lh);
  if (memM.usage_percent >= 90) ramLevel = worstLevel(ramLevel, "critical");
  else if (memM.usage_percent >= 80 || memM.swap_usage_percent >= 50) ramLevel = worstLevel(ramLevel, "warning");

  const ramParts = [];
  if (memH.uncorrectable_errors > 0) ramParts.push(`${memH.uncorrectable_errors} uncorrectable ECC`);
  if (memH.correctable_errors > 0) ramParts.push(`${memH.correctable_errors} correctable ECC`);
  if (memM.usage_percent != null) ramParts.push(`${memM.usage_percent}% used`);
  if (memM.swap_usage_percent != null && memM.swap_usage_percent > 0)
    ramParts.push(`swap ${memM.swap_usage_percent}%`);

  assessments.RAM = {
    level: ramLevel,
    status:
      ramParts.length > 0
        ? `${statusLabel(ramLevel)} — ${ramParts.join(", ")}`
        : `${statusLabel(ramLevel)} — ${memM.used_gb ?? "—"} / ${memM.total_gb ?? "—"} GB`,
  };

  // GPU
  const lhGpuLevel = sectionStatus("gpu", lh);
  if (!gpuHasIdentity(gpuM)) {
    assessments.GPU = { level: "unknown", status: "No GPU detected" };
  } else {
    const gpuLevel = computeGpuHealthLevel(
      gpuM,
      lhGpuLevel === "unknown" ? null : lhGpuLevel
    );

    const gpuParts = buildGpuStatusParts(gpuM);

    assessments.GPU = {
      level: gpuLevel,
      status: formatGpuAssessmentStatus(gpuLevel, gpuM, gpuParts),
    };
  }

  // DISK
  const nvmeLevel = sectionStatus("nvme", lh);
  const sataLevel = sectionStatus("sata", lh);
  const mounts = metrics?.disk?.mounts || [];
  const smart = metrics?.disk?.smart || {};
  let diskLevel = worstLevel(nvmeLevel, sataLevel);

  const highMount = mounts.find((m) => m.usage_percent >= 90);
  const warnMount = mounts.find((m) => m.usage_percent >= 80);
  const smartIssues = Object.values(smart).filter(
    (s) => s.health && s.health !== "PASSED" && s.health !== "OK"
  );
  if (smartIssues.length > 0 || highMount) diskLevel = worstLevel(diskLevel, "critical");
  else if (warnMount) diskLevel = worstLevel(diskLevel, "warning");

  const diskParts = [];
  if (smartIssues.length > 0) diskParts.push("SMART failure");
  if (highMount) diskParts.push(`${highMount.mountpoint} ${highMount.usage_percent}% full`);
  else if (warnMount) diskParts.push(`${warnMount.mountpoint} ${warnMount.usage_percent}% full`);
  const nvmeArr = Array.isArray(lh.nvme) ? lh.nvme : [];
  const nvmeWarn = nvmeArr.filter((d) => (d.percentage_used || 0) > 80);
  if (nvmeWarn.length > 0) diskParts.push(`${nvmeWarn.length} NVMe wear warning`);

  assessments.DISK = {
    level: diskLevel,
    status:
      diskParts.length > 0
        ? `${statusLabel(diskLevel)} — ${diskParts.join(", ")}`
        : `${statusLabel(diskLevel)} — ${mounts.length} mount(s) monitored`,
  };

  // NIC
  const nicEval = evaluateNicHealth(lh, metrics);
  assessments.NIC = {
    level: nicEval.level,
    status: nicEval.status,
  };

  // IO Control — PCIe/USB/chipset + live block-device I/O performance
  const pcieLevel = sectionStatus("pcie", lh);
  const usbLevel = sectionStatus("usb", lh);
  const ioCtrlLevel = worstLevel(pcieLevel, usbLevel);
  const pciCount = inventory?.io?.pci?.length || 0;
  const usbCount = inventory?.io?.usb?.length || 0;
  const mbLevel = sectionStatus("motherboard", lh);
  let finalIoCtrlLevel = worstLevel(ioCtrlLevel, mbLevel);

  const ioDetail = buildIoTelemetryDetail(metrics);
  if (ioDetail?.thresholdLevel) {
    finalIoCtrlLevel = worstLevel(finalIoCtrlLevel, ioDetail.thresholdLevel);
  }

  let ioCtrlStatus;
  if (ioDetail && (ioDetail.thresholdLevel === "warning" || ioDetail.thresholdLevel === "critical")) {
    const busyTxt =
      ioDetail.busyPercent != null ? `${ioDetail.busyPercent}% busy` : "busy n/a";
    const thrTxt =
      ioDetail.totalMBps != null ? `${ioDetail.totalMBps.toFixed(1)} MB/s` : "throughput n/a";
    ioCtrlStatus = `${statusLabel(finalIoCtrlLevel)} — ${ioDetail.device || "device"} ${busyTxt} · ${thrTxt}`;
  } else if (pciCount > 0) {
    const busyTxt =
      ioDetail?.busyPercent != null ? ` · ${ioDetail.device || "dev"} ${ioDetail.busyPercent}% busy` : "";
    ioCtrlStatus = `${statusLabel(finalIoCtrlLevel)} — ${pciCount} PCI, ${usbCount} USB${busyTxt}`;
  } else if (ioDetail) {
    ioCtrlStatus = `${statusLabel(finalIoCtrlLevel)} — ${ioDetail.device || "device"} ${ioDetail.busyPercent ?? "—"}% busy`;
  } else {
    ioCtrlStatus = "No PCI / I/O telemetry reported";
  }

  assessments["IO Control"] = {
    level: pciCount > 0 || ioDetail ? finalIoCtrlLevel : "unknown",
    status: ioCtrlStatus,
  };

  return assessments;
}

function faultSeverityToLevel(severity) {
  if (severity === "Critical") return "critical";
  if (severity === "Warning") return "warning";
  return "healthy";
}

/** Merge live threshold faults into component assessments (single health source). */
function applyThresholdFaultsToAssessments(assessments, thresholdFaults) {
  const activeByComponent = {};
  (thresholdFaults || []).forEach((f) => {
    if (f.severity === "Resolved") return;
    const comp = f.component;
    if (!comp) return;
    if (!activeByComponent[comp]) activeByComponent[comp] = [];
    activeByComponent[comp].push(f);
  });

  Object.entries(activeByComponent).forEach(([comp, faults]) => {
    const key = comp;
    if (!assessments[key]) return;

    let level = assessments[key].level;
    const summaries = [];
    faults.forEach((f) => {
      level = worstLevel(level, faultSeverityToLevel(f.severity));
      if (f.metricName != null && f.currentValue != null) {
        summaries.push(`${f.metricName} ${f.currentValue}`);
      } else if (f.faultDescription) {
        summaries.push(f.faultDescription);
      }
    });

    assessments[key].level = level;
    const unique = [...new Set(summaries)];
    if (unique.length > 0) {
      const shown = unique.slice(0, 4).join(", ");
      const extra = unique.length > 4 ? ` (+${unique.length - 4} more)` : "";
      assessments[key].status = `${statusLabel(level)} — ${shown}${extra}`;
    }
  });
}

/** Component assessments including threshold faults (dashboard, connectivity, summary). */
export function getMergedComponentAssessments(linkHealth, inventory, metrics) {
  const assessments = assessLinkHealthComponents(linkHealth, inventory, metrics);
  const thresholdFaults = buildThresholdFaults(linkHealth, inventory, metrics);
  applyThresholdFaultsToAssessments(assessments, thresholdFaults);
  return assessments;
}

export function buildHealthRowsFromLinkHealth(linkHealth, inventory, metrics) {
  const assessments = getMergedComponentAssessments(linkHealth, inventory, metrics);
  const order = ["CPU", "GPU", "RAM", "DISK", "NIC", "IO Control"];
  return order.map((name) => {
    const a = assessments[name] || { level: "unknown", status: "No data" };
    return healthRow(name, a.level, a.status);
  });
}

// ---------------------------------------------------------------------------
// Threshold-based fault detection (auto-clears when metric returns to healthy)
// ---------------------------------------------------------------------------

function deviceFromDiskThresholdId(id) {
  if (!id || typeof id !== "string") return null;
  const prefixes = [
    "threshold-io-busy-",
    "threshold-io-queue-",
    "threshold-io-latency-",
    "threshold-io-throughput-",
    "threshold-disk-busy-",
    "threshold-disk-queue-",
    "threshold-disk-latency-",
    "threshold-disk-throughput-",
    "threshold-disk-smart-",
    "threshold-disk-nvme-errors-",
    "threshold-disk-nvme-wear-",
    "threshold-disk-sata-",
  ];
  for (const prefix of prefixes) {
    if (id.startsWith(prefix)) return id.slice(prefix.length);
  }
  return null;
}

export function enrichThresholdFaultWithTelemetry(fault, metrics, linkHealth = null, inventory = null) {
  if (!fault || fault.source !== "threshold") return fault;

  const timestamp = metrics?.timestamp || new Date().toISOString();
  const lh = linkHealth || {};
  const inv = inventory || {};
  const id = fault.id || "";
  const cpu = metrics?.cpu || {};
  const device = deviceFromDiskThresholdId(fault.id);
  const perf =
    device != null
      ? (metrics?.disk?.performance || []).find((p) => p.device === device)
      : null;

  const liveFields = syncLiveThresholdFields(fault, metrics, lh, inv);

  if (perf) {
    const isIoFault =
      id.startsWith("threshold-io-busy-") ||
      id.startsWith("threshold-io-queue-") ||
      id.startsWith("threshold-io-latency-") ||
      id.startsWith("threshold-io-throughput-");
    return {
      ...fault,
      ...liveFields,
      telemetryDetail: {
        type: isIoFault ? "io_performance" : "disk_performance",
        device: perf.device ?? device,
        transport: perf.transport,
        busy_percent: perf.busy_percent,
        queue_depth: perf.queue_depth,
        average_latency_ms: perf.average_latency_ms,
        average_read_latency_ms: perf.average_read_latency_ms,
        average_write_latency_ms: perf.average_write_latency_ms,
        read_MB_per_sec: perf.read_MB_per_sec,
        write_MB_per_sec: perf.write_MB_per_sec,
        total_MB_per_sec: perf.total_MB_per_sec,
        read_IOPS: perf.read_IOPS,
        write_IOPS: perf.write_IOPS,
        total_IOPS: perf.total_IOPS,
        timestamp,
        thresholdCrossed: liveFields.thresholdCrossed ?? fault.thresholdCrossed,
        metricName: fault.metricName,
        currentValue: liveFields.currentValue ?? fault.currentValue,
        status: fault.status,
        severity: fault.severity,
        health: isIoFault
          ? ioBusyLevel(num(perf.busy_percent)) || "healthy"
          : undefined,
      },
    };
  }

  const gpu = getPrimaryGpu(metrics, inv, lh);
  const isCpuUsageFault = id === "threshold-cpu-usage";
  if (isCpuUsageFault) {
    return {
      ...fault,
      ...liveFields,
      telemetryDetail: {
        type: "cpu_metrics",
        usage_percent: num(cpu.usage_percent),
        temperature_celsius: num(cpu.temperature_celsius),
        load_1min: cpu.load_average?.["1min"] ?? null,
        current_mhz: cpu.current_mhz ?? null,
        user_percent: cpu.user_percent ?? null,
        system_percent: cpu.system_percent ?? null,
        iowait_percent: cpu.iowait_percent ?? null,
        timestamp,
        thresholdCrossed: liveFields.thresholdCrossed ?? cpuUtilThresholdLabel(fault.severity),
        metricName: fault.metricName,
        currentValue: liveFields.currentValue ?? fault.currentValue,
        status: fault.status,
        severity: fault.severity,
      },
    };
  }

  const isGpuFault = fault.component === "GPU" || String(fault.id || "").includes("gpu");
  if (isGpuFault && gpu) {
    return {
      ...fault,
      ...liveFields,
      telemetryDetail: {
        type: "gpu_metrics",
        model: gpu.model ?? null,
        pci_bus_id: gpu.pci_bus_id ?? null,
        temperature_celsius: gpu.temperature_celsius ?? null,
        gpu_utilization_percent: gpu.gpu_utilization_percent ?? null,
        memory_utilization_percent: gpu.memory_utilization_percent ?? null,
        memory_used_mb: gpu.memory_used_mb ?? null,
        vram_total_mb: gpu.vram_total_mb ?? null,
        power_draw_watts: gpu.power_draw_watts ?? null,
        power_limit_watts: gpu.power_limit_watts ?? null,
        fan_speed_percent: gpu.fan_speed_percent ?? null,
        graphics_clock_mhz: gpu.graphics_clock_mhz ?? null,
        memory_clock_mhz: gpu.memory_clock_mhz ?? null,
        link_status: gpu.link_status ?? (lh.gpu || [])[0]?.health?.link_status ?? null,
        timestamp,
        thresholdCrossed: liveFields.thresholdCrossed ?? fault.thresholdCrossed,
        metricName: fault.metricName,
        currentValue: liveFields.currentValue ?? fault.currentValue,
        status: fault.status,
        severity: fault.severity,
      },
    };
  }

  const isNicFault = fault.component === "NIC" || id.includes("nic");
  if (isNicFault) {
    const sys = metrics?.system || {};
    const primary = getPrimaryNicInterface(metrics);
    const topNic = (metrics?.top_processes?.nic || metrics?.top_processes?.network || [])[0];
    return {
      ...fault,
      ...liveFields,
      telemetryDetail: {
        type: "nic_metrics",
        interface: primary?.name ?? null,
        link_state: primary?.link_state ?? null,
        speed: primary?.speed ?? null,
        speed_mbps: primary?.speed_mbps ?? null,
        duplex: primary?.duplex ?? null,
        rx_errors: primary?.rx_errors ?? null,
        tx_errors: primary?.tx_errors ?? null,
        rx_dropped: primary?.rx_dropped ?? null,
        tx_dropped: primary?.tx_dropped ?? null,
        rx_mbps: primary?.rx_mbps ?? null,
        tx_mbps: primary?.tx_mbps ?? null,
        utilization_percent: primary?.utilization_percent ?? null,
        rx_utilization_percent: primary?.rx_utilization_percent ?? null,
        tx_utilization_percent: primary?.tx_utilization_percent ?? null,
        utilization_threshold_status: primary?.utilization_threshold_status ?? null,
        rx_packets_per_sec: primary?.rx_packets_per_sec ?? null,
        tx_packets_per_sec: primary?.tx_packets_per_sec ?? null,
        network_connectivity: sys.network_connectivity ?? sys.connectivity ?? null,
        default_route_interface: sys.default_route_interface ?? null,
        top_process_pid: topNic?.pid ?? null,
        top_process_name: topNic?.process ?? topNic?.program ?? null,
        top_process_total_kbps: topNic?.total_kbps ?? null,
        top_process_total_mbps: topNic?.total_mbps ?? null,
        timestamp,
        thresholdCrossed: liveFields.thresholdCrossed ?? fault.thresholdCrossed,
        metricName: fault.metricName,
        currentValue: liveFields.currentValue ?? fault.currentValue,
        status: fault.status,
        severity: fault.severity,
      },
    };
  }

  return {
    ...fault,
    ...liveFields,
    telemetryDetail: {
      type: "threshold",
      metricName: fault.metricName,
      currentValue: liveFields.currentValue ?? fault.currentValue,
      thresholdCrossed: liveFields.thresholdCrossed ?? fault.thresholdCrossed,
      timestamp,
      status: fault.status,
      severity: fault.severity,
    },
  };
}

function syncLiveThresholdFields(fault, metrics, linkHealth, inventory) {
  const id = fault.id || "";
  const cpu = metrics?.cpu || {};
  const gpu = getPrimaryGpu(metrics, inventory, linkHealth);
  const fields = {};

  if (id === "threshold-cpu-usage") {
    const util = num(cpu.usage_percent);
    if (util != null) fields.currentValue = `${util}%`;
    fields.thresholdCrossed = cpuUtilThresholdLabel(fault.severity);
  }

  if (id === "threshold-cpu-temperature") {
    const temp = num(cpu.temperature_celsius);
    if (temp != null) fields.currentValue = `${temp}°C`;
    fields.thresholdCrossed =
      fault.severity === "Critical"
        ? `≥ ${CPU_TEMP_THRESHOLDS.criticalC}°C (Critical)`
        : `≥ ${CPU_TEMP_THRESHOLDS.warningC}°C (Warning)`;
  }

  if (id.startsWith("threshold-gpu-temperature") && gpu?.temperature_celsius != null) {
    fields.currentValue = `${gpu.temperature_celsius}°C`;
    fields.thresholdCrossed =
      fault.severity === "Critical"
        ? `≥ ${GPU_TEMP_THRESHOLDS.criticalC}°C (Critical)`
        : `≥ ${GPU_TEMP_THRESHOLDS.warningC}°C (Warning)`;
  }

  if (id === "threshold-gpu-utilization" && gpu?.gpu_utilization_percent != null) {
    fields.currentValue = `${gpu.gpu_utilization_percent}%`;
    fields.thresholdCrossed =
      fault.severity === "Critical"
        ? `> ${GPU_UTIL_THRESHOLDS.criticalMin}% with elevated temperature (Critical)`
        : `≥ ${GPU_UTIL_THRESHOLDS.warningMin}% (Warning)`;
  }

  if (id === "threshold-gpu-vram" && gpu?.memory_utilization_percent != null) {
    fields.currentValue = `${gpu.memory_utilization_percent}%`;
    fields.thresholdCrossed = "≥ 90% (Warning)";
  }

  if (id === "threshold-gpu-power" && gpu?.power_draw_watts != null) {
    fields.currentValue = `${gpu.power_draw_watts}W`;
    fields.thresholdCrossed =
      gpu.power_limit_watts != null
        ? `≥ 95% of ${gpu.power_limit_watts}W limit (Warning)`
        : fault.thresholdCrossed;
  }

  if (id === "threshold-nic-utilization") {
    const primary = getPrimaryNicInterface(metrics);
    const util = num(primary?.utilization_percent);
    if (util != null) fields.currentValue = `${util}%`;
    fields.thresholdCrossed = nicUtilThresholdLabel(fault.severity);
  }

  if (id === "threshold-nic-errors" || id === "threshold-nic-lh-counters") {
    const nics = metrics?.nic || [];
    const upNics = nics.filter((n) => String(n.link_state || "").toLowerCase() === "up");
    const totalErr = upNics.reduce((s, n) => s + (n.rx_errors || 0) + (n.tx_errors || 0), 0);
    if (totalErr > 0) fields.currentValue = String(totalErr);
  }

  if (id === "threshold-nic-connectivity") {
    fields.currentValue = "Unreachable";
    fields.thresholdCrossed = "Gateway/internet unreachable (Critical)";
  }

  if (id === "threshold-nic-link-down") {
    fields.currentValue = "No active interface";
    fields.thresholdCrossed = "No UP interface (Critical)";
  }

  const ioDevice = deviceFromDiskThresholdId(id);
  const ioPerf =
    ioDevice != null
      ? (metrics?.disk?.performance || []).find((p) => p.device === ioDevice)
      : null;

  if (id.startsWith("threshold-io-busy-") && ioPerf?.busy_percent != null) {
    fields.currentValue = `${ioPerf.busy_percent}%`;
    fields.thresholdCrossed = ioBusyThresholdLabel(fault.severity);
  }
  if (id.startsWith("threshold-io-queue-") && ioPerf?.queue_depth != null) {
    fields.currentValue = String(ioPerf.queue_depth);
    fields.thresholdCrossed = ioQueueThresholdLabel(fault.severity);
  }
  if (id.startsWith("threshold-io-latency-") && ioPerf?.average_latency_ms != null) {
    fields.currentValue = `${Number(ioPerf.average_latency_ms).toFixed(2)} ms`;
    fields.thresholdCrossed = ioLatencyThresholdLabel(fault.severity);
  }
  if (id.startsWith("threshold-io-throughput-") && ioPerf?.total_MB_per_sec != null) {
    fields.currentValue = `${Number(ioPerf.total_MB_per_sec).toFixed(1)} MB/s`;
    fields.thresholdCrossed = ioThroughputThresholdLabel(fault.severity);
  }

  return fields;
}

function enrichThresholdFaultList(faults, metrics, linkHealth, inventory) {
  return (faults || []).map((f) =>
    f.source === "threshold"
      ? enrichThresholdFaultWithTelemetry(f, metrics, linkHealth, inventory)
      : f
  );
}

function thresholdFault({
  id,
  severity,
  component,
  metricName,
  currentValue,
  thresholdCrossed,
  description,
}) {
  return {
    id,
    severity,
    component,
    componentDot: COMPONENT_DOTS[component] || COLORS.warning,
    metricName,
    currentValue,
    thresholdCrossed,
    faultDescription: description,
    affectedPath: AFFECTED_PATHS[component] || "Platform",
    detected: new Date().toISOString(),
    status: "Active",
    action: "View →",
    source: "threshold",
  };
}

export function buildThresholdFaults(linkHealth, inventory, metrics) {
  const lh = linkHealth || {};
  const cpuM = metrics?.cpu || {};
  const memM = metrics?.memory || {};
  const memH = (lh.memory || {}).health || {};
  const cpuH = (lh.cpu || {}).health || {};
  const gpuM = getPrimaryGpu(metrics, inventory, lh);
  const gpuLh = coerceGpuArray(lh.gpu)[0];
  const mounts = metrics?.disk?.mounts || [];
  const smart = metrics?.disk?.smart || {};
  const nvmeArr = Array.isArray(lh.nvme) ? lh.nvme : [];
  const sataArr = Array.isArray(lh.sata) ? lh.sata : [];
  const perf = metrics?.disk?.performance || [];
  const nicEval = evaluateNicHealth(lh, metrics);
  const faults = [];

  const cpuThrottleDelta = getCpuThrottlePollDelta();

  if ((cpuH.fatal_errors || 0) > 0) {
    faults.push(
      thresholdFault({
        id: "threshold-cpu-fatal-errors",
        severity: "Critical",
        component: "CPU",
        metricName: "Fatal Errors",
        currentValue: String(cpuH.fatal_errors),
        thresholdCrossed: "≥ 1 fatal MCE (Critical)",
        description: `${cpuH.fatal_errors} fatal machine-check error(s) detected on CPU.`,
      })
    );
  }
  if ((cpuH.corrected_errors || 0) > 0) {
    faults.push(
      thresholdFault({
        id: "threshold-cpu-corrected-errors",
        severity: "Warning",
        component: "CPU",
        metricName: "Corrected Errors",
        currentValue: String(cpuH.corrected_errors),
        thresholdCrossed: "≥ 1 corrected MCE (Warning)",
        description: `${cpuH.corrected_errors} corrected machine-check error(s) on CPU.`,
      })
    );
  }
  if (cpuThrottleDelta > 0) {
    faults.push(
      thresholdFault({
        id: "threshold-cpu-thermal-throttle",
        severity: "Warning",
        component: "CPU",
        metricName: "Thermal Throttling",
        currentValue: String(cpuThrottleDelta),
        thresholdCrossed: "≥ 1 new throttle event since last poll (Warning)",
        description: `CPU thermal throttling detected (${cpuThrottleDelta} new event(s) since last telemetry poll). Lifetime counter is not used for alerting.`,
      })
    );
  }
  if (cpuM.temperature_celsius != null) {
    if (cpuM.temperature_celsius >= CPU_TEMP_THRESHOLDS.criticalC) {
      faults.push(
        thresholdFault({
          id: "threshold-cpu-temperature",
          severity: "Critical",
          component: "CPU",
          metricName: "Temperature",
          currentValue: `${cpuM.temperature_celsius}°C`,
          thresholdCrossed: `≥ ${CPU_TEMP_THRESHOLDS.criticalC}°C (Critical)`,
          description: `CPU temperature ${cpuM.temperature_celsius}°C exceeds critical threshold.`,
        })
      );
    } else if (cpuM.temperature_celsius >= CPU_TEMP_THRESHOLDS.warningC) {
      faults.push(
        thresholdFault({
          id: "threshold-cpu-temperature",
          severity: "Warning",
          component: "CPU",
          metricName: "Temperature",
          currentValue: `${cpuM.temperature_celsius}°C`,
          thresholdCrossed: `≥ ${CPU_TEMP_THRESHOLDS.warningC}°C (Warning)`,
          description: `CPU temperature ${cpuM.temperature_celsius}°C exceeds warning threshold.`,
        })
      );
    }
  }
  const cpuUtil = num(cpuM.usage_percent);
  if (cpuUtil != null) {
    if (cpuUtil >= CPU_UTIL_THRESHOLDS.criticalMin) {
      faults.push(
        thresholdFault({
          id: "threshold-cpu-usage",
          severity: "Critical",
          component: "CPU",
          metricName: "Usage",
          currentValue: `${cpuUtil}%`,
          thresholdCrossed: cpuUtilThresholdLabel("Critical"),
          description: `CPU utilization at ${cpuUtil}% — saturation risk.`,
        })
      );
    } else if (cpuUtil >= CPU_UTIL_THRESHOLDS.warningMin) {
      faults.push(
        thresholdFault({
          id: "threshold-cpu-usage",
          severity: "Warning",
          component: "CPU",
          metricName: "Usage",
          currentValue: `${cpuUtil}%`,
          thresholdCrossed: cpuUtilThresholdLabel("Warning"),
          description: `CPU utilization at ${cpuUtil}% — elevated load.`,
        })
      );
    }
  }

  if ((memH.uncorrectable_errors || 0) > 0) {
    faults.push(
      thresholdFault({
        id: "threshold-ram-uncorrectable",
        severity: "Critical",
        component: "RAM",
        metricName: "ECC Uncorrectable",
        currentValue: String(memH.uncorrectable_errors),
        thresholdCrossed: "> 0 (Critical)",
        description: `${memH.uncorrectable_errors} uncorrectable ECC error(s) in memory.`,
      })
    );
  }
  if ((memH.correctable_errors || 0) > 0) {
    faults.push(
      thresholdFault({
        id: "threshold-ram-correctable",
        severity: "Warning",
        component: "RAM",
        metricName: "ECC Correctable",
        currentValue: String(memH.correctable_errors),
        thresholdCrossed: "> 0 (Warning)",
        description: `${memH.correctable_errors} correctable ECC error(s) in memory.`,
      })
    );
  }
  if (memM.usage_percent != null) {
    if (memM.usage_percent >= 90) {
      faults.push(
        thresholdFault({
          id: "threshold-ram-usage",
          severity: "Critical",
          component: "RAM",
          metricName: "Memory Usage",
          currentValue: `${memM.usage_percent}%`,
          thresholdCrossed: "≥ 90% (Critical)",
          description: `Memory usage at ${memM.usage_percent}% — critical pressure.`,
        })
      );
    } else if (memM.usage_percent >= 80) {
      faults.push(
        thresholdFault({
          id: "threshold-ram-usage",
          severity: "Warning",
          component: "RAM",
          metricName: "Memory Usage",
          currentValue: `${memM.usage_percent}%`,
          thresholdCrossed: "≥ 80% (Warning)",
          description: `Memory usage at ${memM.usage_percent}% — elevated consumption.`,
        })
      );
    }
  }
  if (memM.swap_usage_percent != null && memM.swap_usage_percent >= 50) {
    faults.push(
      thresholdFault({
        id: "threshold-ram-swap",
        severity: "Warning",
        component: "RAM",
        metricName: "Swap Usage",
        currentValue: `${memM.swap_usage_percent}%`,
        thresholdCrossed: "≥ 50% (Warning)",
        description: `Swap usage at ${memM.swap_usage_percent}% indicates memory pressure.`,
      })
    );
  }

  if (gpuM) {
    const linkStatus = gpuLh?.health?.link_status;
    if (linkStatus === "Critical") {
      faults.push(
        thresholdFault({
          id: "threshold-gpu-pcie-link",
          severity: "Critical",
          component: "GPU",
          metricName: "PCIe Link Status",
          currentValue: linkStatus,
          thresholdCrossed: "Critical",
          description: "GPU PCIe link health reported as Critical.",
        })
      );
    } else if (linkStatus === "Warning") {
      faults.push(
        thresholdFault({
          id: "threshold-gpu-pcie-link",
          severity: "Warning",
          component: "GPU",
          metricName: "PCIe Link Status",
          currentValue: linkStatus,
          thresholdCrossed: "Warning",
          description: "GPU PCIe link health reported as Warning.",
        })
      );
    }
    if (gpuM.temperature_celsius != null) {
      const gpuTempLevel = gpuTemperatureLevel(gpuM.temperature_celsius);
      if (gpuTempLevel === "critical") {
        faults.push(
          thresholdFault({
            id: "threshold-gpu-temperature",
            severity: "Critical",
            component: "GPU",
            metricName: "Temperature",
            currentValue: `${gpuM.temperature_celsius}°C`,
            thresholdCrossed: `≥ ${GPU_TEMP_THRESHOLDS.criticalC}°C (Critical)`,
            description: `GPU temperature ${gpuM.temperature_celsius}°C exceeds critical threshold.`,
          })
        );
      } else if (gpuTempLevel === "warning") {
        faults.push(
          thresholdFault({
            id: "threshold-gpu-temperature",
            severity: "Warning",
            component: "GPU",
            metricName: "Temperature",
            currentValue: `${gpuM.temperature_celsius}°C`,
            thresholdCrossed: `${GPU_TEMP_THRESHOLDS.warningC}–${GPU_TEMP_THRESHOLDS.criticalC - 1}°C (Warning)`,
            description: `GPU temperature ${gpuM.temperature_celsius}°C exceeds warning threshold.`,
          })
        );
      }
    }
    if (gpuM.gpu_utilization_percent != null) {
      const gpuUtilLevel = gpuUtilizationLevel(
        gpuM.gpu_utilization_percent,
        gpuM.temperature_celsius
      );
      if (gpuUtilLevel === "critical") {
        faults.push(
          thresholdFault({
            id: "threshold-gpu-utilization",
            severity: "Critical",
            component: "GPU",
            metricName: "Utilization",
            currentValue: `${gpuM.gpu_utilization_percent}%`,
            thresholdCrossed: `> ${GPU_UTIL_THRESHOLDS.criticalMin}% with elevated temperature (Critical)`,
            description: `GPU utilization ${gpuM.gpu_utilization_percent}% is critically high with elevated GPU temperature.`,
          })
        );
      } else if (gpuUtilLevel === "warning") {
        faults.push(
          thresholdFault({
            id: "threshold-gpu-utilization",
            severity: "Warning",
            component: "GPU",
            metricName: "Utilization",
            currentValue: `${gpuM.gpu_utilization_percent}%`,
            thresholdCrossed:
              Number(gpuM.gpu_utilization_percent) > GPU_UTIL_THRESHOLDS.criticalMin
                ? `> ${GPU_UTIL_THRESHOLDS.criticalMin}% (Warning — temperature nominal)`
                : `≥ ${GPU_UTIL_THRESHOLDS.warningMin}% (Warning)`,
            description: `GPU utilization ${gpuM.gpu_utilization_percent}% exceeds warning threshold.`,
          })
        );
      }
    }
    if (gpuM.memory_utilization_percent != null && gpuM.memory_utilization_percent >= 90) {
      faults.push(
        thresholdFault({
          id: "threshold-gpu-vram",
          severity: "Warning",
          component: "GPU",
          metricName: "VRAM Usage",
          currentValue: `${gpuM.memory_utilization_percent}%`,
          thresholdCrossed: "≥ 90% (Warning)",
          description: `GPU VRAM utilization at ${gpuM.memory_utilization_percent}%.`,
        })
      );
    }
    if (
      gpuM.power_draw_watts != null &&
      gpuM.power_limit_watts != null &&
      gpuM.power_draw_watts >= gpuM.power_limit_watts * 0.95
    ) {
      faults.push(
        thresholdFault({
          id: "threshold-gpu-power",
          severity: "Warning",
          component: "GPU",
          metricName: "Power Draw",
          currentValue: `${gpuM.power_draw_watts}W`,
          thresholdCrossed: `≥ 95% of ${gpuM.power_limit_watts}W limit (Warning)`,
          description: `GPU power draw ${gpuM.power_draw_watts}W near power limit.`,
        })
      );
    }
  }

  Object.entries(smart).forEach(([device, s]) => {
    if (s.health && s.health !== "PASSED" && s.health !== "OK") {
      faults.push(
        thresholdFault({
          id: `threshold-disk-smart-${device}`,
          severity: "Critical",
          component: "DISK",
          metricName: "SMART Health",
          currentValue: s.health,
          thresholdCrossed: "Not PASSED/OK (Critical)",
          description: `SMART health failure on ${device}: ${s.health}.`,
        })
      );
    }
  });
  mounts.forEach((m) => {
    const mp = m.mountpoint || m.mount || "unknown";
    if (m.usage_percent == null) return;
    if (m.usage_percent >= 90) {
      faults.push(
        thresholdFault({
          id: `threshold-disk-capacity-${mp}`,
          severity: "Critical",
          component: "DISK",
          metricName: "Capacity",
          currentValue: `${m.usage_percent}%`,
          thresholdCrossed: "≥ 90% (Critical)",
          description: `Mount ${mp} at ${m.usage_percent}% capacity.`,
        })
      );
    } else if (m.usage_percent >= 80) {
      faults.push(
        thresholdFault({
          id: `threshold-disk-capacity-${mp}`,
          severity: "Warning",
          component: "DISK",
          metricName: "Capacity",
          currentValue: `${m.usage_percent}%`,
          thresholdCrossed: "≥ 80% (Warning)",
          description: `Mount ${mp} at ${m.usage_percent}% capacity.`,
        })
      );
    }
  });
  nvmeArr.forEach((d, i) => {
    const dev = d.device || d.name || `nvme${i}`;
    const cw = d.critical_warning;
    const cwBad = cw !== undefined && cw !== null && cw !== 0 && cw !== "0" && cw !== "0x00";
    if (cwBad || (d.media_errors || 0) > 0) {
      faults.push(
        thresholdFault({
          id: `threshold-disk-nvme-errors-${dev}`,
          severity: "Critical",
          component: "DISK",
          metricName: "NVMe Errors",
          currentValue: cwBad ? String(cw) : String(d.media_errors),
          thresholdCrossed: "Critical warning or media errors (Critical)",
          description: `NVMe ${dev}: critical warning or media errors detected.`,
        })
      );
    }
    if ((d.percentage_used || 0) > 80) {
      faults.push(
        thresholdFault({
          id: `threshold-disk-nvme-wear-${dev}`,
          severity: "Warning",
          component: "DISK",
          metricName: "NVMe Wear",
          currentValue: `${d.percentage_used}%`,
          thresholdCrossed: "> 80% (Warning)",
          description: `NVMe ${dev} endurance at ${d.percentage_used}% used.`,
        })
      );
    }
  });
  sataArr.forEach((d, i) => {
    if (!d.link_degraded) return;
    const dev = d.device || d.name || `sata${i}`;
    faults.push(
      thresholdFault({
        id: `threshold-disk-sata-${dev}`,
        severity: "Warning",
        component: "DISK",
        metricName: "Link Degraded",
        currentValue: "Degraded",
        thresholdCrossed: "link_degraded (Warning)",
        description: `SATA device ${dev} link degraded.`,
      })
    );
  });
  // Block I/O workload faults under existing IO Control component.
  // Capacity / SMART / NVMe / SATA remain DISK faults (unchanged).
  perf.forEach((p, i) => {
    const dev = p.device || p.name || `disk${i}`;

    if (p.busy_percent != null) {
      if (p.busy_percent >= IO_BUSY_THRESHOLDS.criticalMin) {
        faults.push(
          thresholdFault({
            id: `threshold-io-busy-${dev}`,
            severity: "Critical",
            component: "IO Control",
            metricName: "I/O Busy",
            currentValue: `${p.busy_percent}%`,
            thresholdCrossed: ioBusyThresholdLabel("Critical"),
            description: `${dev} I/O busy at ${p.busy_percent}% — storage workload saturation.`,
          })
        );
      } else if (p.busy_percent >= IO_BUSY_THRESHOLDS.warningMin) {
        faults.push(
          thresholdFault({
            id: `threshold-io-busy-${dev}`,
            severity: "Warning",
            component: "IO Control",
            metricName: "I/O Busy",
            currentValue: `${p.busy_percent}%`,
            thresholdCrossed: ioBusyThresholdLabel("Warning"),
            description: `${dev} I/O busy at ${p.busy_percent}%.`,
          })
        );
      }
    }

    if (p.queue_depth != null) {
      if (p.queue_depth >= IO_QUEUE_THRESHOLDS.criticalMin) {
        faults.push(
          thresholdFault({
            id: `threshold-io-queue-${dev}`,
            severity: "Critical",
            component: "IO Control",
            metricName: "Queue Depth",
            currentValue: String(p.queue_depth),
            thresholdCrossed: ioQueueThresholdLabel("Critical"),
            description: `${dev} I/O queue depth is ${p.queue_depth} — storage congestion.`,
          })
        );
      } else if (p.queue_depth >= IO_QUEUE_THRESHOLDS.warningMin) {
        faults.push(
          thresholdFault({
            id: `threshold-io-queue-${dev}`,
            severity: "Warning",
            component: "IO Control",
            metricName: "Queue Depth",
            currentValue: String(p.queue_depth),
            thresholdCrossed: ioQueueThresholdLabel("Warning"),
            description: `${dev} I/O queue depth is ${p.queue_depth}.`,
          })
        );
      }
    }

    if (p.average_latency_ms != null) {
      if (p.average_latency_ms >= IO_LATENCY_THRESHOLDS.criticalMin) {
        faults.push(
          thresholdFault({
            id: `threshold-io-latency-${dev}`,
            severity: "Critical",
            component: "IO Control",
            metricName: "Average Latency",
            currentValue: `${Number(p.average_latency_ms).toFixed(2)} ms`,
            thresholdCrossed: ioLatencyThresholdLabel("Critical"),
            description: `${dev} average I/O latency is ${Number(p.average_latency_ms).toFixed(2)} ms.`,
          })
        );
      } else if (p.average_latency_ms >= IO_LATENCY_THRESHOLDS.warningMin) {
        faults.push(
          thresholdFault({
            id: `threshold-io-latency-${dev}`,
            severity: "Warning",
            component: "IO Control",
            metricName: "Average Latency",
            currentValue: `${Number(p.average_latency_ms).toFixed(2)} ms`,
            thresholdCrossed: ioLatencyThresholdLabel("Warning"),
            description: `${dev} average I/O latency is ${Number(p.average_latency_ms).toFixed(2)} ms.`,
          })
        );
      }
    }

    if (p.total_MB_per_sec != null) {
      if (p.total_MB_per_sec >= IO_THROUGHPUT_THRESHOLDS.criticalMin) {
        faults.push(
          thresholdFault({
            id: `threshold-io-throughput-${dev}`,
            severity: "Critical",
            component: "IO Control",
            metricName: "I/O Throughput",
            currentValue: `${Number(p.total_MB_per_sec).toFixed(1)} MB/s`,
            thresholdCrossed: ioThroughputThresholdLabel("Critical"),
            description: `${dev} I/O throughput is ${Number(p.total_MB_per_sec).toFixed(1)} MB/s.`,
          })
        );
      } else if (p.total_MB_per_sec >= IO_THROUGHPUT_THRESHOLDS.warningMin) {
        faults.push(
          thresholdFault({
            id: `threshold-io-throughput-${dev}`,
            severity: "Warning",
            component: "IO Control",
            metricName: "I/O Throughput",
            currentValue: `${Number(p.total_MB_per_sec).toFixed(1)} MB/s`,
            thresholdCrossed: ioThroughputThresholdLabel("Warning"),
            description: `${dev} I/O throughput is ${Number(p.total_MB_per_sec).toFixed(1)} MB/s.`,
          })
        );
      }
    }
  });

  if (nicEval.physicalNics.length > 0 && nicEval.upNics.length === 0) {
    faults.push(
      thresholdFault({
        id: "threshold-nic-link-down",
        severity: "Critical",
        component: "NIC",
        metricName: "Link State",
        currentValue: "No active interface",
        thresholdCrossed: "No UP interface (Critical)",
        description: "No active network interface detected.",
      })
    );
  }

  const upNames = new Set(nicEval.upNics.map((n) => n.name));
  const errNicsOnUp = interfacesWithErrors(nicEval.upNics);
  const lhErrorsOnUp = nicLinkHealthHasErrors(lh, upNames);

  if (errNicsOnUp.length > 0) {
    const totalCounters = errNicsOnUp.reduce((sum, n) => sum + interfaceCounterTotal(n), 0);
    faults.push(
      thresholdFault({
        id: "threshold-nic-errors",
        severity: "Warning",
        component: "NIC",
        metricName: "RX/TX Errors",
        currentValue: String(totalCounters),
        thresholdCrossed: `> ${NIC_COUNTER_WARNING_THRESHOLD} on active interface (Warning)`,
        description: `Active interface(s) exceeded counter threshold (${totalCounters} total): ${errNicsOnUp.map((n) => n.name).join(", ")}.`,
      })
    );
  }

  if (lhErrorsOnUp) {
    faults.push(
      thresholdFault({
        id: "threshold-nic-lh-counters",
        severity: "Warning",
        component: "NIC",
        metricName: "Link Health Counters",
        currentValue: "Errors detected",
        thresholdCrossed: `CRC/error/drop sum > ${NIC_COUNTER_WARNING_THRESHOLD} on UP interface (Warning)`,
        description: "NIC Link Health Counters - Errors detected",
      })
    );
  }

  if (
    nicEval.upNics.length > 0 &&
    nicEval.connected === false &&
    (metrics?.system?.network_connectivity === false ||
      metrics?.system?.connectivity === false ||
      metrics?.system?.gateway_reachable === false ||
      metrics?.system?.internet_reachable === false)
  ) {
    faults.push(
      thresholdFault({
        id: "threshold-nic-connectivity",
        severity: "Critical",
        component: "NIC",
        metricName: "Network Connectivity",
        currentValue: "Unreachable",
        thresholdCrossed: "Gateway/internet unreachable (Critical)",
        description: "Network interface is up but host connectivity probe failed.",
      })
    );
  }

  const primaryNic = getPrimaryNicInterface(metrics);
  const nicUtil = num(primaryNic?.utilization_percent);
  if (primaryNic && isLinkUp(primaryNic) && nicUtil != null) {
    if (nicUtil >= NIC_UTIL_THRESHOLDS.criticalMin) {
      faults.push(
        thresholdFault({
          id: "threshold-nic-utilization",
          severity: "Critical",
          component: "NIC",
          metricName: "Link Utilization",
          currentValue: `${nicUtil}%`,
          thresholdCrossed: nicUtilThresholdLabel("Critical"),
          description: `${primaryNic.name} link utilization at ${nicUtil}% — saturation risk.`,
        })
      );
    } else if (nicUtil >= NIC_UTIL_THRESHOLDS.warningMin) {
      faults.push(
        thresholdFault({
          id: "threshold-nic-utilization",
          severity: "Warning",
          component: "NIC",
          metricName: "Link Utilization",
          currentValue: `${nicUtil}%`,
          thresholdCrossed: nicUtilThresholdLabel("Warning"),
          description: `${primaryNic.name} link utilization at ${nicUtil}% — elevated load.`,
        })
      );
    }
  }

  const pcieArr = Array.isArray(lh.pcie) ? lh.pcie : [];
  pcieArr.forEach((d, i) => {
    const status = (d.health || {}).status;
    if (status !== "Critical" && status !== "Warning") return;
    const slot = d.slot || d.device || `pcie${i}`;
    faults.push(
      thresholdFault({
        id: `threshold-io-pcie-${slot}`,
        severity: status === "Critical" ? "Critical" : "Warning",
        component: "IO Control",
        metricName: "PCIe Link Health",
        currentValue: status,
        thresholdCrossed: status,
        description: `PCIe device ${slot} link health: ${status}.`,
      })
    );
  });
  const usbH = (lh.usb || {}).health || {};
  const usbErrors = Object.entries(usbH).filter(([, v]) => (v || 0) > 0);
  if (usbErrors.length > 0) {
    faults.push(
      thresholdFault({
        id: "threshold-io-usb-errors",
        severity: "Warning",
        component: "IO Control",
        metricName: "USB Errors",
        currentValue: String(usbErrors.reduce((s, [, v]) => s + v, 0)),
        thresholdCrossed: "> 0 (Warning)",
        description: `USB error counters elevated (${usbErrors.map(([k]) => k).join(", ")}).`,
      })
    );
  }
  const mb = lh.motherboard || {};
  if ((mb.pcie_errors?.critical_links || 0) > 0) {
    faults.push(
      thresholdFault({
        id: "threshold-io-mb-pcie-crit",
        severity: "Critical",
        component: "IO Control",
        metricName: "Motherboard PCIe Errors",
        currentValue: String(mb.pcie_errors.critical_links),
        thresholdCrossed: "> 0 (Critical)",
        description: `${mb.pcie_errors.critical_links} critical PCIe link error(s) on motherboard.`,
      })
    );
  }
  const mbWarn =
    (mb.pcie_errors?.warning_links || 0) +
    (mb.acpi_errors || 0) +
    (mb.thermal_zone_errors || 0) +
    (mb.power_faults || 0) +
    (mb.chipset_errors || 0);
  if (mbWarn > 0) {
    faults.push(
      thresholdFault({
        id: "threshold-io-mb-warnings",
        severity: "Warning",
        component: "IO Control",
        metricName: "Motherboard Errors",
        currentValue: String(mbWarn),
        thresholdCrossed: "> 0 (Warning)",
        description: "Motherboard reported warning-level platform errors.",
      })
    );
  }

  return faults;
}


function mergeFaultLogs(thresholdFaults, otherFaults) {
  const thresholdKeys = new Set(
    thresholdFaults.map((f) => `${f.component}:${f.metricName || f.faultDescription}`)
  );
  const merged = [...thresholdFaults];
  otherFaults.forEach((f) => {
    if (f.source === "kernel_event" && f.severity === "Resolved") {
      merged.push(f);
      return;
    }
    const key = `${f.component}:${f.metricName || f.faultDescription}`;
    if (f.source !== "kernel_event" && thresholdKeys.has(key)) return;
    merged.push(f);
  });
  return merged.sort((a, b) => {
    const sev = { Critical: 0, Warning: 1, Resolved: 2 };
    const sd = (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3);
    if (sd !== 0) return sd;
    return String(b.detected).localeCompare(String(a.detected));
  });
}

// ---------------------------------------------------------------------------
// Fault log
// ---------------------------------------------------------------------------

export function buildFaultLog(linkHealth, inventory, metrics) {
  const lh = linkHealth || {};
  const summary = lh.health_summary || {};
  const faults = [];
  let id = 0;

  (summary.critical_alerts || []).forEach((msg) => {
    if (isRemovedComponentEvent(msg)) return;
    const component = inferComponent(msg);
    if (!component) return;
    faults.push({
      id: `alert-crit-${id++}`,
      severity: "Critical",
      component,
      componentDot: COMPONENT_DOTS[component] || COLORS.critical,
      faultDescription: msg,
      affectedPath: AFFECTED_PATHS[component] || "Platform",
      detected: "Live",
      status: "Active",
      action: "View →",
      source: "link_health",
    });
  });

  (summary.warnings || []).forEach((msg) => {
    if (isRemovedComponentEvent(msg)) return;
    const component = inferComponent(msg);
    if (!component) return;
    faults.push({
      id: `alert-warn-${id++}`,
      severity: "Warning",
      component,
      componentDot: COMPONENT_DOTS[component] || COLORS.warning,
      faultDescription: msg,
      affectedPath: AFFECTED_PATHS[component] || "Platform",
      detected: "Live",
      status: "Monitor",
      action: "View →",
      source: "link_health",
    });
  });

  const events = lh.kernel_events || {};
  const allEvents = [];
  Object.keys(events).forEach((category) => {
    (events[category] || []).forEach((ev) => {
      allEvents.push({ ...ev, category });
    });
  });

  allEvents
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
    .slice(0, 100)
    .forEach((ev) => {
      if (isRemovedComponentEvent(ev.message, ev.category, ev.device)) return;
      const severity =
        ev.severity === "critical"
          ? "Critical"
          : ev.severity === "warning"
            ? "Warning"
            : "Resolved";
      const component = inferComponent(ev.message, ev.category, ev.device);
      if (!component) return;
      faults.push({
        id: `kernel-${id++}`,
        severity,
        component,
        componentDot: COMPONENT_DOTS[component] || COLORS.unknown,
        faultDescription: ev.message || "Kernel hardware event",
        affectedPath: ev.device
          ? `${component} → ${ev.device}`
          : AFFECTED_PATHS[component] || "Platform",
        detected: formatRelativeTime(ev.timestamp),
        status: severity === "Resolved" ? "Resolved" : severity === "Critical" ? "Active" : "Monitor",
        action: severity === "Resolved" ? "Log" : "View →",
        source: "kernel_event",
        kernelEvent: ev,
      });
    });

  const thresholdFaults = buildThresholdFaults(linkHealth, inventory, metrics);
  const enrichedThresholds = enrichThresholdFaultList(thresholdFaults, metrics, linkHealth, inventory);
  return mergeFaultLogs(enrichedThresholds, faults);
}

// ---------------------------------------------------------------------------
// Anomaly category cards
// ---------------------------------------------------------------------------

function anomalyRow(faultName, level, subtitle) {
  const dot =
    level === "critical"
      ? "#ff4444"
      : level === "warning"
        ? "#ff8c00"
        : "#00c853";
  return {
    dot,
    faultName,
    status: anomalyStatus(level),
    subtitle,
  };
}

export function buildAnomalyCategories(linkHealth, inventory, metrics) {
  const lh = linkHealth || {};
  const assessments = getMergedComponentAssessments(linkHealth, inventory, metrics);
  const cpuM = metrics?.cpu || {};
  const cpuUtil = num(cpuM.usage_percent);
  const memH = (lh.memory || {}).health || {};
  const cpuH = (lh.cpu || {}).health || {};
  const gpuM = getPrimaryGpu(metrics, inventory, lh);
  const nicEval = evaluateNicHealth(lh, metrics);
  const primaryNic = getPrimaryNicInterface(metrics);
  const nicUtil = num(primaryNic?.utilization_percent);
  const physicalNics = nicEval.physicalNics;
  const upNics = nicEval.upNics;
  const errNicsOnUp = interfacesWithErrors(nicEval.upNics);
  const upNames = new Set(upNics.map((n) => n.name));
  const nvmeArr = Array.isArray(lh.nvme) ? lh.nvme : [];
  const diskPerf = metrics?.disk?.performance || [];
  const maxBusy = diskPerf.reduce(
    (m, p) => (p.busy_percent != null ? Math.max(m, p.busy_percent) : m),
    0
  );
  const maxQueue = diskPerf.reduce(
    (m, p) => (p.queue_depth != null ? Math.max(m, p.queue_depth) : m),
    0
  );
  const maxLatency = diskPerf.reduce(
    (m, p) => (p.average_latency_ms != null ? Math.max(m, p.average_latency_ms) : m),
    0
  );
  const maxThroughput = diskPerf.reduce(
    (m, p) => (p.total_MB_per_sec != null ? Math.max(m, p.total_MB_per_sec) : m),
    0
  );
  const busyDevice = diskPerf.find((p) => p.busy_percent === maxBusy);

  const cards = [
    {
      component: "CPU",
      interfaceType: inventory?.cpu?.architecture || "x86_64",
      overallStatus: overallAnomalyStatus(assessments.CPU?.level),
      rows: [
        anomalyRow(
          "Thermal throttle",
          getCpuThrottlePollDelta() > 0 ? "warning" : "healthy",
          getCpuThrottlePollDelta() > 0
            ? `${getCpuThrottlePollDelta()} new event(s) this poll`
            : "No recent throttling"
        ),
        anomalyRow(
          "Machine-check errors",
          cpuH.fatal_errors > 0 ? "critical" : cpuH.corrected_errors > 0 ? "warning" : "healthy",
          cpuH.fatal_errors > 0
            ? `${cpuH.fatal_errors} fatal`
            : cpuH.corrected_errors > 0
              ? `${cpuH.corrected_errors} corrected`
              : "No MCE errors"
        ),
        anomalyRow(
          "Load saturation",
          cpuUtil != null && cpuUtil >= CPU_UTIL_THRESHOLDS.criticalMin
            ? "critical"
            : cpuUtil != null && cpuUtil >= CPU_UTIL_THRESHOLDS.warningMin
              ? "warning"
              : "healthy",
          cpuUtil != null
            ? `${cpuUtil}% · warn ≥${CPU_UTIL_THRESHOLDS.warningMin}% · crit ≥${CPU_UTIL_THRESHOLDS.criticalMin}%`
            : "—"
        ),
        anomalyRow(
          "Temperature",
          cpuM.temperature_celsius >= CPU_TEMP_THRESHOLDS.criticalC
            ? "critical"
            : cpuM.temperature_celsius >= CPU_TEMP_THRESHOLDS.warningC
              ? "warning"
              : "healthy",
          cpuM.temperature_celsius != null ? `${cpuM.temperature_celsius}°C` : "No sensor"
        ),
      ],
    },
    {
      component: "GPU",
      interfaceType: "PCIe x16",
      overallStatus: overallAnomalyStatus(assessments.GPU?.level),
      rows: [
        anomalyRow(
          "Temperature",
          gpuTemperatureLevel(gpuM?.temperature_celsius) || (gpuM ? "healthy" : "unknown"),
          gpuM?.temperature_celsius != null
            ? `${gpuM.temperature_celsius}°C`
            : gpuM
              ? "No temperature sensor"
              : "No GPU"
        ),
        anomalyRow(
          "GPU utilization",
          gpuUtilizationLevel(gpuM?.gpu_utilization_percent, gpuM?.temperature_celsius) ||
            (gpuM ? "healthy" : "unknown"),
          gpuM?.gpu_utilization_percent != null
            ? `${gpuM.gpu_utilization_percent}%`
            : "—"
        ),
        anomalyRow(
          "PCIe link health",
          sectionStatus("gpu", lh),
          (lh.gpu || [])[0]?.health?.link_status || "Nominal"
        ),
        anomalyRow(
          "VRAM pressure",
          gpuMemoryUtilizationLevel(gpuM?.memory_utilization_percent) || "healthy",
          gpuM?.memory_utilization_percent != null
            ? `${gpuM.memory_utilization_percent}% VRAM`
            : "—"
        ),
        anomalyRow(
          "Power draw",
          gpuPowerDrawLevel(gpuM?.power_draw_watts, gpuM?.power_limit_watts) || "healthy",
          gpuM?.power_draw_watts != null ? `${gpuM.power_draw_watts}W` : "—"
        ),
        anomalyRow(
          "Fan speed",
          gpuFanLevel(gpuM?.fan_speed_percent, gpuM?.temperature_celsius) || "healthy",
          gpuM?.fan_speed_percent != null ? `${gpuM.fan_speed_percent}%` : "—"
        ),
      ],
    },
    {
      component: "RAM",
      interfaceType: inventory?.memory?.dimms?.[0]?.type || "DDR",
      overallStatus: overallAnomalyStatus(assessments.RAM?.level),
      rows: [
        anomalyRow(
          "ECC uncorrectable",
          memH.uncorrectable_errors > 0 ? "critical" : "healthy",
          memH.uncorrectable_errors > 0 ? `${memH.uncorrectable_errors} error(s)` : "None detected"
        ),
        anomalyRow(
          "ECC correctable",
          memH.correctable_errors > 0 ? "warning" : "healthy",
          memH.correctable_errors > 0 ? `${memH.correctable_errors} corrected` : "None detected"
        ),
        anomalyRow(
          "Memory pressure",
          metrics?.memory?.usage_percent >= 90 ? "critical" : metrics?.memory?.usage_percent >= 80 ? "warning" : "healthy",
          metrics?.memory?.usage_percent != null ? `${metrics.memory.usage_percent}% used` : "—"
        ),
        anomalyRow(
          "Swap utilization",
          metrics?.memory?.swap_usage_percent >= 50 ? "warning" : "healthy",
          metrics?.memory?.swap_usage_percent != null
            ? `${metrics.memory.swap_usage_percent}% swap`
            : "No swap pressure"
        ),
      ],
    },
    {
      component: "DISK",
      interfaceType: (inventory?.disk || [])[0]?.transport || "NVMe/SATA",
      overallStatus: overallAnomalyStatus(assessments.DISK?.level),
      rows: [
        anomalyRow(
          "SMART health",
          Object.values(metrics?.disk?.smart || {}).some(
            (s) => s.health && s.health !== "PASSED" && s.health !== "OK"
          )
            ? "critical"
            : "healthy",
          Object.keys(metrics?.disk?.smart || {}).length > 0 ? "SMART monitored" : "No SMART data"
        ),
        anomalyRow(
          "NVMe media errors",
          nvmeArr.some((d) => (d.media_errors || 0) > 0) ? "critical" : "healthy",
          nvmeArr.length > 0 ? `${nvmeArr.length} NVMe device(s)` : "No NVMe"
        ),
        anomalyRow(
          "Capacity pressure",
          (metrics?.disk?.mounts || []).some((m) => m.usage_percent >= 90)
            ? "critical"
            : (metrics?.disk?.mounts || []).some((m) => m.usage_percent >= 80)
              ? "warning"
              : "healthy",
          `${(metrics?.disk?.mounts || []).length} mount(s)`
        ),
        anomalyRow(
          "NVMe wear",
          nvmeArr.some((d) => (d.percentage_used || 0) > 80) ? "warning" : "healthy",
          nvmeArr[0]?.percentage_used != null
            ? `${nvmeArr[0].percentage_used}% life used`
            : "—"
        ),
      ],
    },
    {
      component: "NIC",
      interfaceType: "PCIe",
      overallStatus: overallAnomalyStatus(assessments.NIC?.level),
      rows: [
        anomalyRow(
          "Overall NIC health",
          assessments.NIC?.level || "unknown",
          assessments.NIC?.status || "—"
        ),
        anomalyRow(
          "Interface availability",
          nicEval.upNics.length === 0 && physicalNics.length > 0 ? "critical" : "healthy",
          physicalNics.length > 0
            ? physicalNics.map((n) => `${n.name}: ${n.link_state || "?"}`).join(", ")
            : "—"
        ),
        anomalyRow(
          "Link health counters (active)",
          errNicsOnUp.length > 0 || nicLinkHealthHasErrors(lh, upNames) ? "warning" : "healthy",
          upNics.length > 0
            ? upNics
                .map((n) => {
                  const total = interfaceCounterTotal(n);
                  const level =
                    total > NIC_COUNTER_WARNING_THRESHOLD
                      ? "over threshold"
                      : total > 0
                        ? "nominal"
                        : "clean";
                  return `${n.name}: ${total} (${level})`;
                })
                .join("; ")
            : "No active interface"
        ),
        anomalyRow(
          "Link utilization",
          nicUtil != null && nicUtil >= NIC_UTIL_THRESHOLDS.criticalMin
            ? "critical"
            : nicUtil != null && nicUtil >= NIC_UTIL_THRESHOLDS.warningMin
              ? "warning"
              : "healthy",
          nicUtil != null && primaryNic
            ? `${primaryNic.name} ${nicUtil}% · warn ≥${NIC_UTIL_THRESHOLDS.warningMin}% · crit ≥${NIC_UTIL_THRESHOLDS.criticalMin}%`
            : "—"
        ),
        anomalyRow(
          "Connectivity",
          nicEval.upNics.length === 0
            ? "critical"
            : nicEval.connected === false
              ? "warning"
              : "healthy",
          nicEval.upNics.length === 0
            ? "No active interface"
            : nicEval.connected
              ? "Route / gateway reachable"
              : "Active interface(s) up, route check inconclusive"
        ),
      ],
    },
    {
      component: "IO Control",
      interfaceType: busyDevice?.transport || "Block I/O / DMI / PCIe",
      overallStatus: overallAnomalyStatus(assessments["IO Control"]?.level),
      rows: [
        anomalyRow(
          "I/O busy",
          maxBusy >= IO_BUSY_THRESHOLDS.criticalMin
            ? "critical"
            : maxBusy >= IO_BUSY_THRESHOLDS.warningMin
              ? "warning"
              : "healthy",
          maxBusy > 0
            ? `${busyDevice?.device || "device"} ${maxBusy}% · warn ≥${IO_BUSY_THRESHOLDS.warningMin}% · crit ≥${IO_BUSY_THRESHOLDS.criticalMin}%`
            : diskPerf.length > 0
              ? "No busy signal yet"
              : "—"
        ),
        anomalyRow(
          "Queue depth",
          maxQueue >= IO_QUEUE_THRESHOLDS.criticalMin
            ? "critical"
            : maxQueue >= IO_QUEUE_THRESHOLDS.warningMin
              ? "warning"
              : "healthy",
          maxQueue > 0
            ? `peak ${maxQueue} · warn ≥${IO_QUEUE_THRESHOLDS.warningMin} · crit ≥${IO_QUEUE_THRESHOLDS.criticalMin}`
            : diskPerf.length > 0
              ? "0"
              : "—"
        ),
        anomalyRow(
          "Average latency",
          maxLatency >= IO_LATENCY_THRESHOLDS.criticalMin
            ? "critical"
            : maxLatency >= IO_LATENCY_THRESHOLDS.warningMin
              ? "warning"
              : "healthy",
          maxLatency > 0
            ? `${maxLatency.toFixed(2)} ms · warn ≥${IO_LATENCY_THRESHOLDS.warningMin} · crit ≥${IO_LATENCY_THRESHOLDS.criticalMin}`
            : "—"
        ),
        anomalyRow(
          "Throughput",
          maxThroughput >= IO_THROUGHPUT_THRESHOLDS.criticalMin
            ? "critical"
            : maxThroughput >= IO_THROUGHPUT_THRESHOLDS.warningMin
              ? "warning"
              : "healthy",
          maxThroughput > 0
            ? `${maxThroughput.toFixed(1)} MB/s · warn ≥${IO_THROUGHPUT_THRESHOLDS.warningMin} · crit ≥${IO_THROUGHPUT_THRESHOLDS.criticalMin}`
            : "—"
        ),
        anomalyRow("PCIe link health", sectionStatus("pcie", lh), `${(lh.pcie || []).length} link(s)`),
        anomalyRow("USB errors", sectionStatus("usb", lh), `${(inventory?.io?.usb || []).length} device(s)`),
        anomalyRow(
          "Chipset errors",
          (lh.motherboard?.chipset_errors || 0) > 0 ? "warning" : "healthy",
          (lh.motherboard?.chipset_errors || 0) > 0 ? "Errors detected" : "Nominal"
        ),
        anomalyRow(
          "IOMMU",
          lh.iommu?.enabled ? "healthy" : "unknown",
          lh.iommu?.enabled ? "Enabled" : "Status unknown"
        ),
      ],
    },
  ];

  return cards;
}

export function buildAnomalyStats(anomalyCards) {
  let active = 0;
  let monitoring = 0;
  let clear = 0;

  anomalyCards.forEach((card) => {
    if (card.overallStatus === "CRITICAL") active += 1;
    else if (card.overallStatus === "WARNING") monitoring += 1;
    else clear += 1;
  });

  return { active, monitoring, clear, total: anomalyCards.length };
}

// ---------------------------------------------------------------------------
// Topology enrichment from live inventory
// ---------------------------------------------------------------------------

export function buildTopologyContext(inventory, metrics, linkHealth = null) {
  const cpu = inventory?.cpu || {};
  const gpu = getPrimaryGpu(metrics, inventory, linkHealth);
  const disks = inventory?.disk || [];
  const pciCount = inventory?.io?.pci?.length || 0;

  return {
    CPU: {
      subtitle: cpu.model || "Central Processing Unit",
      detail: `${cpu.physical_cores || "?"} cores · ${cpu.architecture || "—"}`,
    },
    GPU: {
      subtitle: gpu?.model || "Graphics Processing Unit",
      detail: gpu?.vendor ? `${gpu.vendor} · ${gpu.driver_version || "driver unknown"}` : "No GPU detected",
    },
    RAM: {
      subtitle: "Memory Module",
      detail: metrics?.memory
        ? `${metrics.memory.total_gb ?? "—"} GB · ${metrics.memory.usage_percent ?? 0}% used`
        : "—",
    },
    DISK: {
      subtitle: disks[0]?.type || "Storage",
      detail: disks[0]
        ? `${disks[0].model || disks[0].name} · ${disks[0].transport || "—"}`
        : `${(metrics?.disk?.mounts || []).length} mount(s)`,
    },
    NIC: {
      subtitle: "Network Interface Card",
      detail: (() => {
        const invNics = inventory?.nic || [];
        const metricNics = metrics?.nic || [];
        const evalResult = evaluateNicHealth(null, metrics);
        const active = evalResult.upNics.map((n) => n.name).join(", ") || "none";
        const total = invNics.length || metricNics.length;
        return total > 0
          ? `${total} interface(s) · ${active} active · ${statusLabel(evalResult.level)}`
          : "No interfaces";
      })(),
    },
    "IO Controller": {
      subtitle: "I/O Controller / Block I/O",
      detail: (() => {
        const io = buildIoTelemetryDetail(metrics);
        const base = `${pciCount} PCI · ${inventory?.io?.usb?.length || 0} USB`;
        if (!io) return base;
        const busy = io.busyPercent != null ? `${io.busyPercent}% busy` : null;
        const thr = io.totalMBps != null ? `${io.totalMBps.toFixed(1)} MB/s` : null;
        const extras = [io.device, busy, thr].filter(Boolean).join(" · ");
        return extras ? `${base} · ${extras}` : base;
      })(),
    },
  };
}

/**
 * Derive link health score from live component assessments and link_health sections.
 * Used when backend health_summary.score does not reflect PCIe/GPU degradation.
 */
function computeDerivedLinkHealthSummary(linkHealth, inventory, metrics) {
  const assessments = getMergedComponentAssessments(linkHealth, inventory, metrics);
  const levels = Object.values(assessments)
    .map((a) => a.level)
    .filter((l) => l !== "unknown");

  if (levels.length === 0) return null;

  let score = 100;
  levels.forEach((level) => {
    score -= LINK_HEALTH_SCORE_PENALTY[level] || 0;
  });

  const summary = linkHealth?.health_summary || {};
  score -= (summary.critical_alerts || []).length * 5;
  score -= (summary.warnings || []).length * 2;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const componentsWithErrors = levels.filter((l) => l === "critical").length;
  const componentsWithWarnings = levels.filter((l) => l === "warning").length;

  let overallHealth = "Healthy";
  if (levels.includes("critical")) overallHealth = "Critical";
  else if (levels.includes("warning")) overallHealth = "Warning";

  return {
    score,
    overallHealth,
    componentsWithErrors,
    componentsWithWarnings,
    componentsChecked: levels.length,
  };
}

export function getLinkHealthSummary(linkHealth, inventory = null, metrics = null) {
  const summary = linkHealth?.health_summary || {};
  const derived =
    linkHealth && (inventory || metrics)
      ? computeDerivedLinkHealthSummary(linkHealth, inventory, metrics)
      : null;

  const backendScore = summary.score ?? null;
  const score =
    derived?.score != null
      ? backendScore != null
        ? Math.min(backendScore, derived.score)
        : derived.score
      : backendScore;

  const overallHealth =
    derived?.overallHealth || summary.overall_health || null;

  return {
    overallHealth,
    score,
    componentsChecked: derived?.componentsChecked ?? summary.components_checked ?? 0,
    componentsWithWarnings: Math.max(
      derived?.componentsWithWarnings ?? 0,
      summary.components_with_warnings ?? 0
    ),
    componentsWithErrors: Math.max(
      derived?.componentsWithErrors ?? 0,
      summary.components_with_errors ?? 0
    ),
    criticalAlertCount: (summary.critical_alerts || []).length,
    warningCount: (summary.warnings || []).length,
    informationalCount: (summary.informational || []).length,
  };
}

export {
  CPU_UTIL_THRESHOLDS,
  CPU_TEMP_THRESHOLDS,
  GPU_TEMP_THRESHOLDS,
  GPU_UTIL_THRESHOLDS,
  gpuTemperatureLevel,
  gpuUtilizationLevel,
  computeGpuHealthLevel,
};
