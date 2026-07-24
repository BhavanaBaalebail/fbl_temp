/**
 * Recovery Evidence — extracts live telemetry fields for fault analysis.
 * Uses only /inventory, /metrics, /link_health data shapes.
 */

import { getPrimaryGpu } from "../services/linkHealthService";

function fmt(value, suffix = "") {
  if (value === null || value === undefined) return null;
  return `${value}${suffix}`;
}

function topProcess(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const p = list[0];
  return {
    pid: p.pid ?? p.PID ?? null,
    name: p.process ?? p.name ?? p.command ?? null,
    cpu: p.cpu_percent ?? p["CPU%"] ?? p.cpu ?? null,
    memory: p.memory_percent ?? p["MEM%"] ?? p.memory ?? null,
    gpuCompute: p.gpu_compute_percent ?? p["GPU%"] ?? null,
    gpuMemory: p.gpu_memory_percent ?? null,
  };
}

/**
 * @param {object} fault
 * @param {object} metrics
 * @returns {object|null}
 */
export function getTopProcessForFault(fault, metrics) {
  const id = fault?.id || "";
  const component = fault?.component || "";
  if (component === "GPU" || id.includes("gpu")) {
    return topProcess(metrics?.top_processes?.gpu);
  }
  if (component === "CPU" || id.includes("cpu")) {
    return topProcess(metrics?.top_processes?.cpu);
  }
  if (component === "RAM" || id.includes("ram")) {
    return topProcess(metrics?.top_processes?.cpu);
  }
  return topProcess(metrics?.top_processes?.cpu) || topProcess(metrics?.top_processes?.gpu);
}

/**
 * @param {object} fault
 * @param {object} metrics
 * @param {object} inventory
 * @returns {object|null}
 */
export function getRecoveryTarget(fault, metrics, inventory) {
  const id = fault?.id || "";
  const sys = metrics?.system || {};
  const target = { process: null, interface: null, mount: null, device: null, service: null };

  target.process = getTopProcessForFault(fault, metrics);

  if (fault.component === "NIC" || id.includes("nic")) {
    const nics = metrics?.nic || [];
    const def = sys.default_route_interface;
    const iface = def
      ? nics.find((n) => n.name === def)
      : nics.find((n) => String(n.link_state || "").toLowerCase() === "up");
    target.interface = iface?.name || nics[0]?.name || null;
  }

  if (id.startsWith("threshold-disk-capacity-")) {
    target.mount = id.replace("threshold-disk-capacity-", "");
  }

  if (id.includes("gpu-pcie") || id.includes("io-pcie")) {
    const gpuLh = (linkHealth?.gpu || [])[0];
    target.device = inventory?.gpu?.[0]?.pci_slot || gpuLh?.slot || gpuLh?.pci_slot || null;
    target.pcieSlot =
      target.device ||
      (linkHealth?.pcie || [])[0]?.slot ||
      (linkHealth?.pcie || [])[0]?.device ||
      null;
  }

  return target;
}

/**
 * @param {object} fault
 * @param {object} inventory
 * @param {object} metrics
 * @param {object} linkHealth
 * @returns {{ items: Array<{label:string, value:string|null}>, raw: object }}
 */
export function collectEvidence(fault, inventory, metrics, linkHealth) {
  const items = [];
  const raw = { fault, metrics, linkHealth, inventory: {} };
  const cpu = metrics?.cpu || {};
  const mem = metrics?.memory || {};
  const gpu = getPrimaryGpu(metrics, inventory, linkHealth);
  const gpuLh = (linkHealth?.gpu || [])[0];
  const cpuH = (linkHealth?.cpu || {})?.health || {};
  const memH = (linkHealth?.memory || {})?.health || {};
  const sys = metrics?.system || {};
  const nics = metrics?.nic || [];
  const topCpu = topProcess(metrics?.top_processes?.cpu);
  const topGpu = topProcess(metrics?.top_processes?.gpu);

  if (fault.metricName) {
    items.push({ label: fault.metricName, value: fault.currentValue || null });
  }
  if (fault.thresholdCrossed) {
    items.push({ label: "Threshold", value: fault.thresholdCrossed });
  }

  const component = fault.component;

  if (component === "GPU" || fault.id?.includes("gpu")) {
    if (gpu?.temperature_celsius != null) {
      items.push({ label: "GPU Temperature", value: fmt(gpu.temperature_celsius, "°C") });
    }
    if (gpu?.gpu_utilization_percent != null) {
      items.push({ label: "GPU Utilization", value: fmt(gpu.gpu_utilization_percent, "%") });
    }
    if (gpu?.memory_utilization_percent != null) {
      items.push({ label: "VRAM Usage", value: fmt(gpu.memory_utilization_percent, "%") });
    }
    if (gpu?.power_draw_watts != null) {
      items.push({ label: "Power Draw", value: fmt(gpu.power_draw_watts, "W") });
    }
    if (gpu?.power_limit_watts != null) {
      items.push({ label: "Power Limit", value: fmt(gpu.power_limit_watts, "W") });
    }
    if (gpuLh?.health?.link_status) {
      items.push({ label: "PCIe Link Status", value: gpuLh.health.link_status });
    }
    if (topGpu?.pid) {
      items.push({
        label: "Top GPU Process",
        value: `PID ${topGpu.pid} · ${topGpu.name || "unknown"}${topGpu.gpuCompute != null ? ` · ${topGpu.gpuCompute}% compute` : ""}`,
      });
    }
    raw.gpu = gpu;
  }

  if (component === "CPU" || fault.id?.includes("cpu")) {
    if (cpu.usage_percent != null) items.push({ label: "CPU Usage", value: fmt(cpu.usage_percent, "%") });
    if (cpu.temperature_celsius != null) {
      items.push({ label: "CPU Temperature", value: fmt(cpu.temperature_celsius, "°C") });
    }
    if (cpu.load_average?.["1min"] != null) {
      items.push({ label: "Load Average (1m)", value: String(cpu.load_average["1min"]) });
    }
    const throttle =
      (cpuH.thermal_throttling_total_core_count || 0) +
      (cpuH.thermal_throttling_total_package_count || 0);
    if (throttle > 0) items.push({ label: "Thermal Throttle Events", value: String(throttle) });
    if (cpuH.fatal_errors > 0) items.push({ label: "Fatal Errors", value: String(cpuH.fatal_errors) });
    if (cpuH.corrected_errors > 0) {
      items.push({ label: "Corrected Errors", value: String(cpuH.corrected_errors) });
    }
    if (topCpu?.pid) {
      items.push({
        label: "Top CPU Process",
        value: `PID ${topCpu.pid} · ${topCpu.name || "unknown"}${topCpu.cpu != null ? ` · ${topCpu.cpu}% CPU` : ""}`,
      });
    }
    raw.cpu = cpu;
  }

  if (component === "RAM" || fault.id?.includes("ram")) {
    if (mem.usage_percent != null) items.push({ label: "Memory Usage", value: fmt(mem.usage_percent, "%") });
    if (mem.swap_usage_percent != null) {
      items.push({ label: "Swap Usage", value: fmt(mem.swap_usage_percent, "%") });
    }
    if (mem.used_gb != null && mem.total_gb != null) {
      items.push({ label: "Memory Used", value: `${mem.used_gb} / ${mem.total_gb} GB` });
    }
    if (memH.uncorrectable_errors > 0) {
      items.push({ label: "ECC Uncorrectable", value: String(memH.uncorrectable_errors) });
    }
    if (memH.correctable_errors > 0) {
      items.push({ label: "ECC Correctable", value: String(memH.correctable_errors) });
    }
    if (topCpu?.pid && topCpu.memory != null) {
      items.push({
        label: "Top Memory Process",
        value: `PID ${topCpu.pid} · ${topCpu.name || "unknown"} · ${topCpu.memory}% MEM`,
      });
    }
    raw.memory = mem;
  }

  if (component === "DISK" || fault.id?.includes("disk")) {
    (metrics?.disk?.mounts || []).forEach((m) => {
      if (m.usage_percent != null) {
        items.push({
          label: `Mount ${m.mountpoint || m.mount}`,
          value: fmt(m.usage_percent, "%"),
        });
      }
    });
    Object.entries(metrics?.disk?.smart || {}).forEach(([dev, s]) => {
      if (s.health) items.push({ label: `SMART ${dev}`, value: s.health });
      if (s.temperature_celsius != null) {
        items.push({ label: `SMART Temp ${dev}`, value: fmt(s.temperature_celsius, "°C") });
      }
    });
    (linkHealth?.nvme || []).forEach((d, i) => {
      const name = d.device || d.name || `nvme${i}`;
      if (d.percentage_used != null) {
        items.push({ label: `NVMe Wear ${name}`, value: fmt(d.percentage_used, "%") });
      }
      if (d.media_errors > 0) items.push({ label: `NVMe Media Errors ${name}`, value: String(d.media_errors) });
    });
  }

  if (component === "NIC" || fault.id?.includes("nic")) {
    const up = nics.filter((n) => String(n.link_state || "").toLowerCase() === "up");
    items.push({ label: "Interfaces Up", value: `${up.length} / ${nics.length}` });
    const totalErr = nics.reduce((s, n) => s + (n.rx_errors || 0) + (n.tx_errors || 0), 0);
    items.push({ label: "RX/TX Errors", value: String(totalErr) });
    if (sys.network_connectivity != null) {
      items.push({ label: "Network Connectivity", value: sys.network_connectivity ? "Reachable" : "Unreachable" });
    }
    if (sys.default_route_interface) {
      items.push({ label: "Default Route", value: sys.default_route_interface });
    }
    up.slice(0, 3).forEach((n) => {
      items.push({ label: `Interface ${n.name}`, value: `${n.link_state || "?"} · RX ${n.rx_errors || 0} TX ${n.tx_errors || 0}` });
    });
  }

  if (component === "IO Control") {
    const pcie = linkHealth?.pcie || [];
    const crit = pcie.filter((d) => (d.health || {}).status === "Critical").length;
    const warn = pcie.filter((d) => (d.health || {}).status === "Warning").length;
    if (pcie.length) items.push({ label: "PCIe Links Monitored", value: String(pcie.length) });
    if (crit) items.push({ label: "PCIe Critical Links", value: String(crit) });
    if (warn) items.push({ label: "PCIe Warning Links", value: String(warn) });
  }

  if (linkHealth?.health_summary?.score != null) {
    items.push({ label: "Link Health Score", value: String(linkHealth.health_summary.score) });
  }

  const deduped = [];
  const seen = new Set();
  items.forEach((item) => {
    const key = `${item.label}:${item.value}`;
    if (item.value != null && !seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  });

  return { items: deduped, raw };
}

/**
 * Extract a numeric metric path for monitoring.
 * @param {string} path e.g. gpu.temperature_celsius
 */
export function readMetricValue(path, metrics, linkHealth, fault) {
  if (!path) return null;
  if (path === "disk.mount_usage") {
    const mp = fault?.id?.replace("threshold-disk-capacity-", "");
    const mount = (metrics?.disk?.mounts || []).find(
      (m) => (m.mountpoint || m.mount) === mp
    );
    return mount?.usage_percent ?? null;
  }
  if (path === "nic.total_errors") {
    return (metrics?.nic || []).reduce((s, n) => s + (n.rx_errors || 0) + (n.tx_errors || 0), 0);
  }
  if (path === "nic.up_count") {
    return (metrics?.nic || []).filter((n) => String(n.link_state || "").toLowerCase() === "up").length;
  }

  const parts = path.split(".");
  let cur = path.startsWith("gpu.") || path.startsWith("cpu.") || path.startsWith("memory.")
    ? metrics
    : metrics;
  if (path.startsWith("gpu.")) {
    cur = getPrimaryGpu(metrics, null, linkHealth) || {};
    parts.shift();
    parts[0] = parts[0] === "temperature_celsius" ? "temperature_celsius" : parts.join("_").replace("memory_", "memory_");
    if (path === "gpu.temperature_celsius") return cur.temperature_celsius ?? null;
    if (path === "gpu.memory_utilization_percent") return cur.memory_utilization_percent ?? null;
  }
  if (path === "cpu.usage_percent") return metrics?.cpu?.usage_percent ?? null;
  if (path === "cpu.temperature_celsius") return metrics?.cpu?.temperature_celsius ?? null;
  if (path === "memory.usage_percent") return metrics?.memory?.usage_percent ?? null;

  return null;
}

export function snapshotMetrics(metrics, linkHealth, inventory = null) {
  const gpu = getPrimaryGpu(metrics, inventory, linkHealth);
  return {
    cpu_usage: metrics?.cpu?.usage_percent ?? null,
    cpu_temp: metrics?.cpu?.temperature_celsius ?? null,
    mem_usage: metrics?.memory?.usage_percent ?? null,
    mem_swap: metrics?.memory?.swap_usage_percent ?? null,
    gpu_temp: gpu?.temperature_celsius ?? null,
    gpu_util: gpu?.gpu_utilization_percent ?? null,
    gpu_vram: gpu?.memory_utilization_percent ?? null,
    gpu_power: gpu?.power_draw_watts ?? null,
    nic_errors: (metrics?.nic || []).reduce((s, n) => s + (n.rx_errors || 0) + (n.tx_errors || 0), 0),
    nic_up: (metrics?.nic || []).filter((n) => String(n.link_state || "").toLowerCase() === "up").length,
    lh_score: linkHealth?.health_summary?.score ?? null,
    mounts: (metrics?.disk?.mounts || []).map((m) => ({
      mp: m.mountpoint || m.mount,
      pct: m.usage_percent ?? null,
    })),
  };
}
