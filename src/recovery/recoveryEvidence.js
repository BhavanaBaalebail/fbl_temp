/**
 * Recovery Evidence — extracts live telemetry fields for fault analysis.
 * Uses only /inventory, /metrics, /link_health data shapes.
 */

import { getPrimaryGpu } from "../services/linkHealthService";
import {
  deviceFromDiskFaultId,
  diskPerformanceForFault,
  mountForFault,
  nvmeHealthForDevice,
  smartForDevice,
} from "./diskRecoveryHelpers";

function fmt(value, suffix = "") {
  if (value === null || value === undefined) return null;
  return `${value}${suffix}`;
}

function topDiskProcess(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const p = list[0];
  return {
    pid: p.pid ?? null,
    name: p.process ?? p.command ?? null,
    cpu: p.cpu_percent ?? null,
    memory: p.memory_percent ?? null,
    readKbps: p.read_kbps ?? null,
    writeKbps: p.write_kbps ?? null,
    ioTotalKbps: p.io_total_kbps ?? null,
  };
}

function topNicProcess(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const p = list[0];
  return {
    pid: p.pid ?? null,
    name: p.process ?? p.program ?? p.command ?? null,
    process: p.process ?? p.program ?? null,
    cpu: p.cpu_percent ?? null,
    memory: p.memory_percent ?? null,
    rxKbps: p.received_kbps ?? null,
    txKbps: p.sent_kbps ?? null,
    totalKbps: p.total_kbps ?? null,
    rx_mbps: p.rx_mbps ?? null,
    tx_mbps: p.tx_mbps ?? null,
    total_mbps: p.total_mbps ?? null,
  };
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
  if (component === "DISK" && /disk-busy|disk-queue|disk-latency|disk-throughput/.test(id)) {
    return topDiskProcess(metrics?.top_processes?.disk);
  }
  if (component === "NIC" || id.includes("nic")) {
    const withRate = (list) =>
      (list || []).find((p) => (p.total_mbps || 0) > 0 || (p.total_kbps || 0) > 0);
    const withPid = (list) => (list || []).find((p) => p.pid);
    const fromNetwork =
      withRate(metrics?.top_processes?.network) ||
      withRate(metrics?.top_processes?.nic) ||
      withPid(metrics?.top_processes?.nic) ||
      withPid(metrics?.top_processes?.network);
    return fromNetwork ? topNicProcess([fromNetwork]) : null;
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
 * @param {object} [linkHealth]
 * @returns {object|null}
 */
export function getRecoveryTarget(fault, metrics, inventory, linkHealth = null) {
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
    const mountRow = mountForFault(fault, metrics);
    target.mount =
      mountRow?.mountpoint || mountRow?.mount || id.replace("threshold-disk-capacity-", "");
  }

  const diskDev = deviceFromDiskFaultId(id);
  if (diskDev) {
    target.device = diskDev;
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
    const thresholdLabel =
      fault.id === "threshold-cpu-usage" ? "Utilization Threshold" : "Threshold";
    items.push({ label: thresholdLabel, value: fault.thresholdCrossed });
  }

  const component = fault.component;

  if (component === "GPU" || fault.id?.includes("gpu")) {
    if (metrics?.timestamp) {
      items.push({ label: "Metrics Timestamp", value: metrics.timestamp });
    }
    if (gpu?.model) items.push({ label: "GPU Model", value: gpu.model });
    if (gpu?.vendor) items.push({ label: "Vendor", value: gpu.vendor });
    if (gpu?.pci_bus_id) items.push({ label: "PCI Bus ID", value: gpu.pci_bus_id });
    if (gpu?.driver_version) items.push({ label: "Driver", value: gpu.driver_version });
    if (gpu?.cuda_version) items.push({ label: "CUDA", value: gpu.cuda_version });
    if (gpu?.temperature_celsius != null) {
      items.push({ label: "GPU Temperature", value: fmt(gpu.temperature_celsius, "°C") });
    }
    if (gpu?.gpu_utilization_percent != null) {
      items.push({ label: "GPU Utilization", value: fmt(gpu.gpu_utilization_percent, "%") });
    }
    if (gpu?.memory_utilization_percent != null) {
      items.push({ label: "VRAM Usage", value: fmt(gpu.memory_utilization_percent, "%") });
    }
    if (gpu?.memory_used_mb != null && gpu?.vram_total_mb != null) {
      items.push({
        label: "VRAM Allocated",
        value: `${gpu.memory_used_mb} / ${gpu.vram_total_mb} MB`,
      });
    } else if (gpu?.memory_used_mb != null) {
      items.push({ label: "VRAM Used", value: `${gpu.memory_used_mb} MB` });
    }
    if (gpu?.power_draw_watts != null) {
      items.push({ label: "Power Draw", value: fmt(gpu.power_draw_watts, "W") });
    }
    if (gpu?.power_limit_watts != null) {
      items.push({ label: "Power Limit", value: fmt(gpu.power_limit_watts, "W") });
    }
    if (gpu?.fan_speed_percent != null) {
      items.push({ label: "Fan Speed", value: fmt(gpu.fan_speed_percent, "%") });
    }
    if (gpu?.graphics_clock_mhz != null) {
      items.push({ label: "Graphics Clock", value: fmt(gpu.graphics_clock_mhz, " MHz") });
    }
    if (gpu?.memory_clock_mhz != null) {
      items.push({ label: "Memory Clock", value: fmt(gpu.memory_clock_mhz, " MHz") });
    }
    if (gpu?.link_status) {
      items.push({ label: "PCIe Link Status", value: gpu.link_status });
    }
    if (gpuLh?.health?.link_status) {
      items.push({ label: "Link Health Status", value: gpuLh.health.link_status });
    }
    if (topGpu?.pid) {
      const parts = [`PID ${topGpu.pid}`, topGpu.name || "unknown"];
      if (topGpu.gpuCompute != null) parts.push(`${topGpu.gpuCompute}% compute`);
      if (topGpu.gpuMemory != null) parts.push(`${topGpu.gpuMemory}% VRAM`);
      items.push({ label: "Top GPU Process", value: parts.join(" · ") });
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
    const device = deviceFromDiskFaultId(fault.id) || null;
    const perf = diskPerformanceForFault(fault, metrics);
    const mount = mountForFault(fault, metrics);
    const smart = smartForDevice(device, metrics);
    const nvme = nvmeHealthForDevice(device, linkHealth);
    const invDisk = (inventory?.disk || []).find(
      (d) => d.name === device || (device && d.name && device.startsWith(d.name))
    );

    if (metrics?.timestamp) {
      items.push({ label: "Metrics Timestamp", value: metrics.timestamp });
    }
    if (device) items.push({ label: "Device", value: device });
    if (perf?.transport) items.push({ label: "Transport", value: perf.transport });
    if (invDisk?.type) items.push({ label: "Disk Type", value: invDisk.type });
    if (invDisk?.model) items.push({ label: "Model", value: invDisk.model });

    if (perf?.busy_percent != null) {
      items.push({ label: "Busy %", value: fmt(perf.busy_percent, "%") });
    }
    if (perf?.queue_depth != null) {
      items.push({ label: "Queue Depth", value: String(perf.queue_depth) });
    }
    if (perf?.average_latency_ms != null) {
      items.push({ label: "Average Latency", value: fmt(perf.average_latency_ms, " ms") });
    }
    if (perf?.read_IOPS != null) items.push({ label: "Read IOPS", value: String(perf.read_IOPS) });
    if (perf?.write_IOPS != null) items.push({ label: "Write IOPS", value: String(perf.write_IOPS) });
    if (perf?.read_MB_per_sec != null) {
      items.push({ label: "Read Throughput", value: fmt(perf.read_MB_per_sec, " MB/s") });
    }
    if (perf?.write_MB_per_sec != null) {
      items.push({ label: "Write Throughput", value: fmt(perf.write_MB_per_sec, " MB/s") });
    }
    if (perf?.total_MB_per_sec != null) {
      items.push({ label: "Total Throughput", value: fmt(perf.total_MB_per_sec, " MB/s") });
    }

    if (mount) {
      items.push({
        label: "Mount Point",
        value: mount.mountpoint || mount.mount || "—",
      });
      if (mount.filesystem) items.push({ label: "Filesystem", value: mount.filesystem });
      if (mount.usage_percent != null) {
        items.push({ label: "Capacity Used", value: fmt(mount.usage_percent, "%") });
      }
      if (mount.used_gb != null && mount.size_gb != null) {
        items.push({ label: "Capacity", value: `${mount.used_gb} / ${mount.size_gb} GB` });
      }
    } else {
      (metrics?.disk?.mounts || []).forEach((m) => {
        if (m.usage_percent != null) {
          items.push({
            label: `Mount ${m.mountpoint || m.mount}`,
            value: fmt(m.usage_percent, "%"),
          });
        }
      });
    }

    if (smart) {
      if (smart.health) items.push({ label: "SMART Health", value: smart.health });
      if (smart.temperature_celsius != null) {
        items.push({ label: "SMART Temperature", value: fmt(smart.temperature_celsius, "°C") });
      }
      if (smart.reallocated_sectors != null) {
        items.push({ label: "Reallocated Sectors", value: String(smart.reallocated_sectors) });
      }
      if (smart.pending_sectors != null) {
        items.push({ label: "Pending Sectors", value: String(smart.pending_sectors) });
      }
      if (smart.power_on_hours != null) {
        items.push({ label: "Power-On Hours", value: String(smart.power_on_hours) });
      }
    }

    if (nvme) {
      if (nvme.percentage_used != null) {
        items.push({ label: "NVMe Wear", value: fmt(nvme.percentage_used, "%") });
      }
      if (nvme.media_errors > 0) {
        items.push({ label: "NVMe Media Errors", value: String(nvme.media_errors) });
      }
      if (nvme.critical_warning != null && nvme.critical_warning !== 0) {
        items.push({ label: "NVMe Critical Warning", value: String(nvme.critical_warning) });
      }
      if (nvme.available_spare != null) {
        items.push({ label: "NVMe Available Spare", value: fmt(nvme.available_spare, "%") });
      }
      if (nvme.temperature != null) {
        items.push({ label: "NVMe Temperature", value: fmt(nvme.temperature, "°C") });
      }
    }

    const sataArr = Array.isArray(linkHealth?.sata) ? linkHealth.sata : [];
    sataArr.forEach((s, i) => {
      if (s.link_degraded) {
        items.push({
          label: `SATA Link ${s.link || i}`,
          value: `${s.negotiated_speed || "?"} (degraded)`,
        });
      }
    });

    const topDisk = topDiskProcess(metrics?.top_processes?.disk);
    if (topDisk?.pid) {
      items.push({
        label: "Top Disk I/O Process",
        value: `PID ${topDisk.pid} · ${topDisk.name || "unknown"} · ${topDisk.ioTotalKbps ?? "—"} KB/s total`,
      });
    }

    raw.disk = { perf, smart, nvme, mount, device };
  }

  if (component === "NIC" || fault.id?.includes("nic")) {
    const sys = metrics?.system || {};
    const defIface = sys.default_route_interface;
    const primary =
      (defIface ? nics.find((n) => n.name === defIface) : null) ||
      nics.find((n) => String(n.link_state || "").toLowerCase() === "up") ||
      nics[0];
    const up = nics.filter((n) => String(n.link_state || "").toLowerCase() === "up");
    items.push({ label: "Interfaces Up", value: `${up.length} / ${nics.length}` });
    const totalErr = nics.reduce((s, n) => s + (n.rx_errors || 0) + (n.tx_errors || 0), 0);
    items.push({ label: "RX/TX Errors", value: String(totalErr) });
    const totalDropped = nics.reduce((s, n) => s + (n.rx_dropped || 0) + (n.tx_dropped || 0), 0);
    if (totalDropped > 0) {
      items.push({ label: "RX/TX Dropped", value: String(totalDropped) });
    }
    if (sys.network_connectivity != null) {
      items.push({
        label: "Network Connectivity",
        value: sys.network_connectivity ? "Reachable" : "Unreachable",
      });
    }
    if (sys.default_route_interface) {
      items.push({ label: "Default Route", value: sys.default_route_interface });
    }
    if (primary) {
      items.push({
        label: `Primary Interface ${primary.name}`,
        value: `${primary.link_state || "?"} · ${primary.speed || "—"} · RX err ${primary.rx_errors || 0} TX err ${primary.tx_errors || 0}`,
      });
      if (primary.rx_mbps != null || primary.tx_mbps != null) {
        items.push({
          label: "Live Throughput",
          value: `RX ${primary.rx_mbps ?? "—"} Mbps · TX ${primary.tx_mbps ?? "—"} Mbps`,
        });
      }
      if (primary.utilization_percent != null) {
        items.push({
          label: "Link Utilization",
          value: `${primary.utilization_percent}%`,
        });
      } else if (primary.rx_utilization_percent != null || primary.tx_utilization_percent != null) {
        items.push({
          label: "Link Utilization",
          value: `RX ${primary.rx_utilization_percent ?? "—"}% · TX ${primary.tx_utilization_percent ?? "—"}%`,
        });
      }
    }
    const topNet = (metrics?.top_processes?.network || []).find((p) => (p.total_mbps || 0) > 0);
    const topNic = topNet || topNicProcess(metrics?.top_processes?.nic);
    if (topNic?.pid) {
      const parts = [`PID ${topNic.pid}`, topNic.name || topNic.process || "unknown"];
      if (topNic.total_mbps != null) parts.push(`${topNic.total_mbps} Mbps total`);
      else if (topNic.totalKbps != null) parts.push(`${topNic.totalKbps} KB/s total`);
      if (topNic.rx_mbps != null || topNic.tx_mbps != null) {
        parts.push(`RX ${topNic.rx_mbps ?? "—"} · TX ${topNic.tx_mbps ?? "—"} Mbps`);
      } else if (topNic.rxKbps != null || topNic.txKbps != null) {
        parts.push(`RX ${topNic.rxKbps ?? "—"} · TX ${topNic.txKbps ?? "—"} KB/s`);
      }
      items.push({ label: "Top Network Process", value: parts.join(" · ") });
    }
    raw.nic = { primary, nics };
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
  if (path === "disk.busy_percent") {
    const perf = diskPerformanceForFault(fault, metrics);
    return perf?.busy_percent ?? null;
  }
  if (path === "disk.queue_depth") {
    const perf = diskPerformanceForFault(fault, metrics);
    return perf?.queue_depth ?? null;
  }
  if (path === "disk.average_latency_ms") {
    const perf = diskPerformanceForFault(fault, metrics);
    return perf?.average_latency_ms ?? null;
  }
  if (path === "disk.total_MB_per_sec") {
    const perf = diskPerformanceForFault(fault, metrics);
    return perf?.total_MB_per_sec ?? null;
  }
  if (path === "nic.utilization_percent") {
    const sys = metrics?.system || {};
    const nics = metrics?.nic || [];
    const defIface = sys.default_route_interface;
    const primary =
      (defIface ? nics.find((n) => n.name === defIface) : null) ||
      nics.find((n) => String(n.link_state || "").toLowerCase() === "up") ||
      nics[0];
    return primary?.utilization_percent ?? null;
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
    if (path === "gpu.gpu_utilization_percent") return cur.gpu_utilization_percent ?? null;
    if (path === "gpu.memory_utilization_percent") return cur.memory_utilization_percent ?? null;
    if (path === "gpu.power_draw_watts") return cur.power_draw_watts ?? null;
  }
  if (path === "cpu.usage_percent") return metrics?.cpu?.usage_percent ?? null;
  if (path === "cpu.temperature_celsius") return metrics?.cpu?.temperature_celsius ?? null;
  if (path === "memory.usage_percent") return metrics?.memory?.usage_percent ?? null;

  return null;
}

export function snapshotMetrics(metrics, linkHealth, inventory = null) {
  const gpu = getPrimaryGpu(metrics, inventory, linkHealth);
  const diskPerf = metrics?.disk?.performance || [];
  const peakPerf =
    diskPerf.length > 0
      ? diskPerf.reduce((best, p) =>
          (p.busy_percent || 0) >= (best?.busy_percent || 0) ? p : best
        )
      : null;
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
    disk_busy: peakPerf?.busy_percent ?? null,
    disk_queue: peakPerf?.queue_depth ?? null,
    disk_latency: peakPerf?.average_latency_ms ?? null,
    disk_throughput: peakPerf?.total_MB_per_sec ?? null,
    mounts: (metrics?.disk?.mounts || []).map((m) => ({
      mp: m.mountpoint || m.mount,
      pct: m.usage_percent ?? null,
    })),
  };
}
