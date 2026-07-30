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
  "IO Control": "IO Control → DMI/PCIe → CPU",
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
      const throttle =
        (h.thermal_throttling_total_core_count || 0) +
        (h.thermal_throttling_total_package_count || 0);
      if ((h.fatal_errors || 0) > 0) return "critical";
      if ((h.corrected_errors || 0) > 0 || throttle > 0) return "warning";
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
  const cpuThrottle =
    (cpuH.thermal_throttling_total_core_count || 0) +
    (cpuH.thermal_throttling_total_package_count || 0);
  let cpuLevel = sectionStatus("cpu", lh);
  if (cpuM.temperature_celsius >= 85 || cpuM.usage_percent >= 90) cpuLevel = worstLevel(cpuLevel, "critical");
  else if (cpuM.temperature_celsius >= 75 || cpuM.usage_percent >= 70) cpuLevel = worstLevel(cpuLevel, "warning");

  const cpuParts = [];
  if (cpuH.fatal_errors > 0) cpuParts.push(`${cpuH.fatal_errors} fatal error(s)`);
  if (cpuH.corrected_errors > 0) cpuParts.push(`${cpuH.corrected_errors} corrected error(s)`);
  if (cpuThrottle > 0) cpuParts.push(`thermal throttle ×${cpuThrottle}`);
  if (cpuM.usage_percent != null) cpuParts.push(`${cpuM.usage_percent}% usage`);
  if (cpuM.temperature_celsius != null) cpuParts.push(`${cpuM.temperature_celsius}°C`);

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

  // IO Control
  const pcieLevel = sectionStatus("pcie", lh);
  const usbLevel = sectionStatus("usb", lh);
  const ioLevel = worstLevel(pcieLevel, usbLevel);
  const pciCount = inventory?.io?.pci?.length || 0;
  const usbCount = inventory?.io?.usb?.length || 0;
  const mbLevel = sectionStatus("motherboard", lh);
  const finalIoLevel = worstLevel(ioLevel, mbLevel);

  assessments["IO Control"] = {
    level: pciCount > 0 ? finalIoLevel : "unknown",
    status:
      pciCount > 0
        ? `${statusLabel(finalIoLevel)} — ${pciCount} PCI, ${usbCount} USB device(s)`
        : "No PCI devices reported",
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

export function enrichThresholdFaultWithTelemetry(fault, metrics) {
  if (!fault || fault.source !== "threshold") return fault;

  const timestamp = metrics?.timestamp || new Date().toISOString();
  const device = deviceFromDiskThresholdId(fault.id);
  const perf =
    device != null
      ? (metrics?.disk?.performance || []).find((p) => p.device === device)
      : null;

  if (perf) {
    return {
      ...fault,
      telemetryDetail: {
        type: "disk_performance",
        device: perf.device ?? device,
        busy_percent: perf.busy_percent,
        queue_depth: perf.queue_depth,
        average_latency_ms: perf.average_latency_ms,
        total_MB_per_sec: perf.total_MB_per_sec,
        read_IOPS: perf.read_IOPS,
        write_IOPS: perf.write_IOPS,
        timestamp,
        thresholdCrossed: fault.thresholdCrossed,
        metricName: fault.metricName,
        currentValue: fault.currentValue,
        status: fault.status,
        severity: fault.severity,
      },
    };
  }

  return {
    ...fault,
    telemetryDetail: {
      type: "threshold",
      metricName: fault.metricName,
      currentValue: fault.currentValue,
      thresholdCrossed: fault.thresholdCrossed,
      timestamp,
      status: fault.status,
      severity: fault.severity,
    },
  };
}

function enrichThresholdFaultList(faults, metrics) {
  return (faults || []).map((f) =>
    f.source === "threshold" ? enrichThresholdFaultWithTelemetry(f, metrics) : f
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

  const cpuThrottle =
    (cpuH.thermal_throttling_total_core_count || 0) +
    (cpuH.thermal_throttling_total_package_count || 0);

  if ((cpuH.fatal_errors || 0) > 0) {
    faults.push(
      thresholdFault({
        id: "threshold-cpu-fatal-errors",
        severity: "Critical",
        component: "CPU",
        metricName: "Fatal Errors",
        currentValue: String(cpuH.fatal_errors),
        thresholdCrossed: "> 0 (Critical)",
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
        thresholdCrossed: "> 0 (Warning)",
        description: `${cpuH.corrected_errors} corrected machine-check error(s) on CPU.`,
      })
    );
  }
  if (cpuThrottle > 0) {
    faults.push(
      thresholdFault({
        id: "threshold-cpu-thermal-throttle",
        severity: "Warning",
        component: "CPU",
        metricName: "Thermal Throttling",
        currentValue: String(cpuThrottle),
        thresholdCrossed: "> 0 (Warning)",
        description: `CPU thermal throttling active (${cpuThrottle} event(s)).`,
      })
    );
  }
  if (cpuM.temperature_celsius != null) {
    if (cpuM.temperature_celsius >= 85) {
      faults.push(
        thresholdFault({
          id: "threshold-cpu-temperature",
          severity: "Critical",
          component: "CPU",
          metricName: "Temperature",
          currentValue: `${cpuM.temperature_celsius}°C`,
          thresholdCrossed: "≥ 85°C (Critical)",
          description: `CPU temperature ${cpuM.temperature_celsius}°C exceeds critical threshold.`,
        })
      );
    } else if (cpuM.temperature_celsius >= 75) {
      faults.push(
        thresholdFault({
          id: "threshold-cpu-temperature",
          severity: "Warning",
          component: "CPU",
          metricName: "Temperature",
          currentValue: `${cpuM.temperature_celsius}°C`,
          thresholdCrossed: "≥ 75°C (Warning)",
          description: `CPU temperature ${cpuM.temperature_celsius}°C exceeds warning threshold.`,
        })
      );
    }
  }
  if (cpuM.usage_percent != null) {
    if (cpuM.usage_percent >= 90) {
      faults.push(
        thresholdFault({
          id: "threshold-cpu-usage",
          severity: "Critical",
          component: "CPU",
          metricName: "Usage",
          currentValue: `${cpuM.usage_percent}%`,
          thresholdCrossed: "≥ 90% (Critical)",
          description: `CPU utilization at ${cpuM.usage_percent}% — saturation risk.`,
        })
      );
    } else if (cpuM.usage_percent >= 70) {
      faults.push(
        thresholdFault({
          id: "threshold-cpu-usage",
          severity: "Warning",
          component: "CPU",
          metricName: "Usage",
          currentValue: `${cpuM.usage_percent}%`,
          thresholdCrossed: "≥ 70% (Warning)",
          description: `CPU utilization at ${cpuM.usage_percent}% — elevated load.`,
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
  perf.forEach((p, i) => {
    const dev = p.device || p.name || `disk${i}`;
  
    // -----------------------------
    // Disk Busy %
    // -----------------------------
    if (p.busy_percent != null) {
      if (p.busy_percent >= 80) {
        faults.push(
          thresholdFault({
            id: `threshold-disk-busy-${dev}`,
            severity: "Critical",
            component: "DISK",
            metricName: "Disk Busy",
            currentValue: `${p.busy_percent}%`,
            thresholdCrossed: "≥ 80% (Critical)",
            description: `${dev} disk busy at ${p.busy_percent}%.`,
          })
        );
      } else if (p.busy_percent >= 70) {
        faults.push(
          thresholdFault({
            id: `threshold-disk-busy-${dev}`,
            severity: "Warning",
            component: "DISK",
            metricName: "Disk Busy",
            currentValue: `${p.busy_percent}%`,
            thresholdCrossed: "≥ 70% (Warning)",
            description: `${dev} disk busy at ${p.busy_percent}%.`,
          })
        );
      }
    }
  
    // -----------------------------
    // Queue Depth
    // -----------------------------
    if (p.queue_depth != null) {
      if (p.queue_depth >= 32) {
        faults.push(
          thresholdFault({
            id: `threshold-disk-queue-${dev}`,
            severity: "Critical",
            component: "DISK",
            metricName: "Queue Depth",
            currentValue: String(p.queue_depth),
            thresholdCrossed: "≥ 32 (Critical)",
            description: `${dev} queue depth is ${p.queue_depth}.`,
          })
        );
      } else if (p.queue_depth >= 16) {
        faults.push(
          thresholdFault({
            id: `threshold-disk-queue-${dev}`,
            severity: "Warning",
            component: "DISK",
            metricName: "Queue Depth",
            currentValue: String(p.queue_depth),
            thresholdCrossed: "≥ 16 (Warning)",
            description: `${dev} queue depth is ${p.queue_depth}.`,
          })
        );
      }
    }
  
    // -----------------------------
    // Average Latency
    // -----------------------------
    if (p.average_latency_ms != null) {
      if (p.average_latency_ms >= 100) {
        faults.push(
          thresholdFault({
            id: `threshold-disk-latency-${dev}`,
            severity: "Critical",
            component: "DISK",
            metricName: "Average Latency",
            currentValue: `${p.average_latency_ms.toFixed(2)} ms`,
            thresholdCrossed: "≥ 100 ms (Critical)",
            description: `${dev} average latency is ${p.average_latency_ms.toFixed(2)} ms.`,
          })
        );
      } else if (p.average_latency_ms >= 20) {
        faults.push(
          thresholdFault({
            id: `threshold-disk-latency-${dev}`,
            severity: "Warning",
            component: "DISK",
            metricName: "Average Latency",
            currentValue: `${p.average_latency_ms.toFixed(2)} ms`,
            thresholdCrossed: "≥ 20 ms (Warning)",
            description: `${dev} average latency is ${p.average_latency_ms.toFixed(2)} ms.`,
          })
        );
      }
    }
  
    // -----------------------------
    // Optional: Throughput
    // -----------------------------
    if (p.total_MB_per_sec != null) {
      if (p.total_MB_per_sec >= 3500) {
        faults.push(
          thresholdFault({
            id: `threshold-disk-throughput-${dev}`,
            severity: "Critical",
            component: "DISK",
            metricName: "Disk Throughput",
            currentValue: `${p.total_MB_per_sec.toFixed(1)} MB/s`,
            thresholdCrossed: "≥ 3500 MB/s (Critical)",
            description: `${dev} throughput is ${p.total_MB_per_sec.toFixed(1)} MB/s.`,
          })
        );
      } else if (p.total_MB_per_sec >= 2000) {
        faults.push(
          thresholdFault({
            id: `threshold-disk-throughput-${dev}`,
            severity: "Warning",
            component: "DISK",
            metricName: "Disk Throughput",
            currentValue: `${p.total_MB_per_sec.toFixed(1)} MB/s`,
            thresholdCrossed: "≥ 2000 MB/s (Warning)",
            description: `${dev} throughput is ${p.total_MB_per_sec.toFixed(1)} MB/s.`,
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
  const enrichedThresholds = enrichThresholdFaultList(thresholdFaults, metrics);
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
  const memH = (lh.memory || {}).health || {};
  const cpuH = (lh.cpu || {}).health || {};
  const gpuM = getPrimaryGpu(metrics, inventory, lh);
  const nicEval = evaluateNicHealth(lh, metrics);
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
          cpuH.thermal_throttling_total_package_count > 0 ? "warning" : "healthy",
          cpuH.thermal_throttling_total_package_count > 0
            ? `Package throttle ×${cpuH.thermal_throttling_total_package_count}`
            : "No throttling"
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
          cpuM.usage_percent >= 90 ? "critical" : cpuM.usage_percent >= 70 ? "warning" : "healthy",
          cpuM.usage_percent != null ? `${cpuM.usage_percent}% utilization` : "—"
        ),
        anomalyRow(
          "Temperature",
          cpuM.temperature_celsius >= 85 ? "critical" : cpuM.temperature_celsius >= 75 ? "warning" : "healthy",
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
        anomalyRow(
          "Disk busy",
          maxBusy >= 80 ? "critical" : maxBusy >= 70 ? "warning" : "healthy",
          maxBusy > 0
            ? `${busyDevice?.device || "disk"} ${maxBusy}% busy`
            : diskPerf.length > 0
              ? "No busy signal yet"
              : "—"
        ),
        anomalyRow(
          "Queue depth",
          maxQueue >= 32 ? "critical" : maxQueue >= 16 ? "warning" : "healthy",
          maxQueue > 0 ? `peak ${maxQueue}` : diskPerf.length > 0 ? "0" : "—"
        ),
        anomalyRow(
          "Average latency",
          maxLatency >= 100 ? "critical" : maxLatency >= 20 ? "warning" : "healthy",
          maxLatency > 0 ? `${maxLatency.toFixed(2)} ms peak` : "—"
        ),
        anomalyRow(
          "Throughput",
          maxThroughput >= 3500 ? "critical" : maxThroughput >= 2000 ? "warning" : "healthy",
          maxThroughput > 0 ? `${maxThroughput.toFixed(1)} MB/s peak` : "—"
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
      interfaceType: "DMI / PCIe",
      overallStatus: overallAnomalyStatus(assessments["IO Control"]?.level),
      rows: [
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
      subtitle: "Platform Controller Hub",
      detail: `${pciCount} PCI device(s) · ${inventory?.io?.usb?.length || 0} USB`,
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
  GPU_TEMP_THRESHOLDS,
  GPU_UTIL_THRESHOLDS,
  gpuTemperatureLevel,
  gpuUtilizationLevel,
  computeGpuHealthLevel,
};
