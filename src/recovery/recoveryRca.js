/**
 * Evidence-based Root Cause Analysis — no invented diagnoses.
 */

import { getPrimaryGpu } from "../services/linkHealthService";
import {
  deviceFromDiskFaultId,
  diskPerformanceForFault,
  isDiskHardwareFault,
  isDiskWorkloadFault,
  mountForFault,
  nvmeHealthForDevice,
  smartForDevice,
} from "./diskRecoveryHelpers";

/**
 * @param {object} fault
 * @param {{ items: Array<{label:string,value:string}> }} evidence
 * @param {object} metrics
 * @param {object} linkHealth
 * @returns {string[]}
 */
export function generateRootCauseAnalysis(fault, evidence, metrics, linkHealth) {
  const causes = [];
  const items = evidence.items || [];
  const byLabel = Object.fromEntries(items.map((i) => [i.label, i.value]));
  const id = fault.id || "";
  const gpu = getPrimaryGpu(metrics, null, linkHealth);
  const cpu = metrics?.cpu || {};
  const mem = metrics?.memory || {};

  if (id.includes("gpu-temperature")) {
    if (gpu?.gpu_utilization_percent >= 70) {
      causes.push(`Sustained GPU workload detected (${gpu.gpu_utilization_percent}% utilization).`);
    }
    if (gpu?.power_draw_watts != null && gpu?.power_limit_watts != null) {
      if (gpu.power_draw_watts >= gpu.power_limit_watts * 0.9) {
        causes.push(`GPU power draw near limit (${gpu.power_draw_watts}W of ${gpu.power_limit_watts}W).`);
      }
    }
    const link = (linkHealth?.gpu || [])[0]?.health?.link_status;
    if (link && link !== "Healthy" && link !== "Nominal") {
      causes.push(`GPU PCIe link health reported as ${link}.`);
    }
    if (byLabel["Top GPU Process"]) {
      causes.push(`Primary GPU consumer: ${byLabel["Top GPU Process"]}.`);
    }
    if (causes.length === 0 && gpu?.temperature_celsius != null) {
      causes.push(`GPU temperature elevated to ${gpu.temperature_celsius}°C per live sensor telemetry.`);
    }
  }

  if (id.includes("gpu-utilization") && gpu?.gpu_utilization_percent != null) {
    causes.push(`GPU compute utilization at ${gpu.gpu_utilization_percent}% per live nvidia-smi telemetry.`);
    if (byLabel["Top GPU Process"]) {
      causes.push(`Primary GPU consumer: ${byLabel["Top GPU Process"]}.`);
    }
    if (gpu.temperature_celsius != null && gpu.temperature_celsius >= 80) {
      causes.push(`GPU temperature elevated to ${gpu.temperature_celsius}°C alongside high utilization.`);
    }
  }

  if (id.includes("gpu-power") && gpu?.power_draw_watts != null) {
    causes.push(
      `GPU power draw at ${gpu.power_draw_watts}W${gpu.power_limit_watts != null ? ` of ${gpu.power_limit_watts}W limit` : ""}.`
    );
    if (gpu.gpu_utilization_percent != null && gpu.gpu_utilization_percent >= 90) {
      causes.push(`Sustained workload at ${gpu.gpu_utilization_percent}% utilization driving power consumption.`);
    }
    if (byLabel["Top GPU Process"]) {
      causes.push(`Likely contributor: ${byLabel["Top GPU Process"]}.`);
    }
  }

  if (id.includes("gpu-vram") && gpu?.memory_utilization_percent != null) {
    causes.push(`GPU VRAM utilization at ${gpu.memory_utilization_percent}%.`);
    if (byLabel["Top GPU Process"]) causes.push(`Primary GPU memory consumer: ${byLabel["Top GPU Process"]}.`);
  }

  if (id.includes("cpu-usage") && cpu.usage_percent != null) {
    causes.push(`High CPU utilization measured at ${cpu.usage_percent}%.`);
    if (byLabel["Top CPU Process"]) causes.push(`Primary CPU consumer: ${byLabel["Top CPU Process"]}.`);
  }

  if (id.includes("cpu-thermal")) {
    if (cpu.usage_percent >= 80) causes.push(`Elevated CPU usage (${cpu.usage_percent}%) contributing to thermal load.`);
    const cpuH = (linkHealth?.cpu || {})?.health || {};
    const throttle =
      (cpuH.thermal_throttling_total_core_count || 0) +
      (cpuH.thermal_throttling_total_package_count || 0);
    if (throttle > 0) causes.push(`CPU thermal throttling active (${throttle} event(s) from link_health).`);
    if (cpu.temperature_celsius != null) {
      causes.push(`CPU temperature at ${cpu.temperature_celsius}°C per live sensor.`);
    }
  }

  if (id.includes("cpu-thermal-throttle")) {
    causes.push("CPU thermal throttling counters non-zero in link_health telemetry.");
  }

  if (id.includes("ram-usage") || id.includes("ram-swap")) {
    if (mem.usage_percent != null) causes.push(`Memory usage at ${mem.usage_percent}%.`);
    if (mem.swap_usage_percent != null && mem.swap_usage_percent >= 50) {
      causes.push(`Swap usage elevated to ${mem.swap_usage_percent}%, indicating memory pressure.`);
    }
    if (byLabel["Top Memory Process"]) causes.push(`Primary memory consumer: ${byLabel["Top Memory Process"]}.`);
  }

  if (id.includes("ram-uncorrectable") || id.includes("ram-correctable")) {
    causes.push("Memory ECC errors reported in link_health — hardware intervention required.");
  }

  if (id.includes("disk-capacity")) {
    const mount = mountForFault(fault, metrics);
    if (mount?.usage_percent != null) {
      causes.push(
        `Mount ${mount.mountpoint || mount.mount} at ${mount.usage_percent}% capacity — storage exhaustion risk.`
      );
      if (mount.used_gb != null && mount.free_gb != null) {
        causes.push(`Only ${mount.free_gb} GB free of ${mount.size_gb ?? "—"} GB on this filesystem.`);
      }
    }
  }

  if (id.includes("io-busy") || id.includes("disk-busy")) {
    const perf = diskPerformanceForFault(fault, metrics);
    if (perf?.busy_percent != null) {
      causes.push(
        `High I/O utilization — block device ${perf.device || deviceFromDiskFaultId(id)} is ${perf.busy_percent}% busy (I/O workload saturation).`
      );
    }
    const topProc = byLabel["Top I/O Process"] || byLabel["Top Disk I/O Process"];
    if (topProc) {
      causes.push(`Highest I/O process identified: ${topProc}.`);
    } else if (causes.length === 0) {
      causes.push("I/O busy threshold exceeded — workload or background I/O is saturating the device.");
    }
  }

  if (id.includes("io-queue") || id.includes("disk-queue")) {
    const perf = diskPerformanceForFault(fault, metrics);
    if (perf?.queue_depth != null) {
      causes.push(
        `High queue depth on ${perf.device || deviceFromDiskFaultId(id)} is ${perf.queue_depth} — storage congestion.`
      );
    }
    const topProc = byLabel["Top I/O Process"] || byLabel["Top Disk I/O Process"];
    if (topProc) {
      causes.push(`Likely contributor: ${topProc}.`);
    }
  }

  if (id.includes("io-latency") || id.includes("disk-latency")) {
    const perf = diskPerformanceForFault(fault, metrics);
    if (perf?.average_latency_ms != null) {
      causes.push(
        `High latency on ${perf.device || deviceFromDiskFaultId(id)} — average ${perf.average_latency_ms} ms (I/O contention/congestion).`
      );
    }
    if (perf?.busy_percent != null && perf.busy_percent >= 25) {
      causes.push(`Device busy at ${perf.busy_percent}%, which commonly increases service time.`);
    }
  }

  if (id.includes("io-throughput") || id.includes("disk-throughput")) {
    const perf = diskPerformanceForFault(fault, metrics);
    if (perf?.total_MB_per_sec != null) {
      causes.push(
        `Combined throughput on ${perf.device || deviceFromDiskFaultId(id)} is ${perf.total_MB_per_sec} MB/s — elevated I/O load.`
      );
    }
    if (perf?.write_MB_per_sec != null && perf.write_MB_per_sec > (perf.read_MB_per_sec || 0)) {
      causes.push(
        `Write-heavy workload detected — Write ${perf.write_MB_per_sec} MB/s · Read ${perf.read_MB_per_sec ?? "—"} MB/s.`
      );
    } else if (perf?.read_MB_per_sec != null || perf?.write_MB_per_sec != null) {
      causes.push(
        `Read-heavy workload detected — Read ${perf.read_MB_per_sec ?? "—"} MB/s · Write ${perf.write_MB_per_sec ?? "—"} MB/s.`
      );
    }
  }

  if (id.includes("disk-smart")) {
    const dev = deviceFromDiskFaultId(id);
    const smart = smartForDevice(dev, metrics);
    if (smart?.health) {
      causes.push(`SMART health for ${dev || "disk"} reports ${smart.health} — potential hardware degradation.`);
    }
    if (smart?.reallocated_sectors > 0) {
      causes.push(`${smart.reallocated_sectors} reallocated sector(s) recorded by SMART.`);
    }
    if (smart?.pending_sectors > 0) {
      causes.push(`${smart.pending_sectors} pending sector(s) — imminent failure risk.`);
    }
    if (causes.length === 0) {
      causes.push("SMART health status not PASSED/OK — drive reliability compromised.");
    }
  }

  if (id.includes("disk-nvme-errors")) {
    const dev = deviceFromDiskFaultId(id);
    const nvme = nvmeHealthForDevice(dev, linkHealth);
    if (nvme?.media_errors > 0) {
      causes.push(`NVMe ${dev || nvme.device || "device"} reports ${nvme.media_errors} media error(s) — physical storage failure signal.`);
    }
    if (nvme?.critical_warning) {
      causes.push(`NVMe critical warning flag set (${nvme.critical_warning}).`);
    }
  }

  if (id.includes("disk-nvme-wear")) {
    const dev = deviceFromDiskFaultId(id);
    const nvme = nvmeHealthForDevice(dev, linkHealth);
    if (nvme?.percentage_used != null) {
      causes.push(`NVMe endurance at ${nvme.percentage_used}% — wear threshold exceeded.`);
    }
    if (nvme?.available_spare != null) {
      causes.push(`Available spare blocks: ${nvme.available_spare}%.`);
    }
  }

  if (id.includes("disk-sata")) {
    const dev = deviceFromDiskFaultId(id);
    const sata = (linkHealth?.sata || []).find((s) => (s.link || "").includes(dev || ""));
    if (sata?.link_degraded) {
      causes.push(`SATA link ${sata.link || dev} negotiated below maximum speed (${sata.negotiated_speed}).`);
    } else {
      causes.push(`SATA device ${dev || "unknown"} link degraded per link_health telemetry.`);
    }
  }

  if (isDiskHardwareFault(fault) && causes.length <= 1) {
    causes.push("Hardware-level disk fault — automated workload throttling cannot repair media degradation; plan backup and replacement.");
  }

  const topIoLabel = byLabel["Top I/O Process"] || byLabel["Top Disk I/O Process"];
  if (
    isDiskWorkloadFault(fault) &&
    topIoLabel &&
    !causes.some((c) => c.includes("I/O consumer") || c.includes("I/O process") || c.includes("Highest I/O"))
  ) {
    causes.push(`Highest I/O process identified: ${topIoLabel}.`);
  }

  if (id.includes("nic-utilization")) {
    const sys = metrics?.system || {};
    const nics = metrics?.nic || [];
    const defIface = sys.default_route_interface;
    const primary =
      (defIface ? nics.find((n) => n.name === defIface) : null) ||
      nics.find((n) => String(n.link_state || "").toLowerCase() === "up") ||
      nics[0];
    if (primary?.utilization_percent != null) {
      causes.push(
        `NIC link utilization at ${primary.utilization_percent}% exceeds combined RX+TX threshold.`
      );
    }
    const topNet =
      (metrics?.top_processes?.network || []).find((p) => (p.total_mbps || 0) > 0) ||
      (metrics?.top_processes?.nic || [])[0];
    if (topNet?.pid) {
      const rate =
        topNet.total_mbps != null
          ? `${topNet.total_mbps} Mbps total`
          : `${topNet.total_kbps ?? "—"} KB/s total`;
      causes.push(
        `Top bandwidth consumer: PID ${topNet.pid} · ${topNet.process || topNet.program || "unknown"} · ${rate}.`
      );
    }
  }

  if (id.includes("nic-error") || id.includes("nic-lh")) {
    causes.push("Network interface error counters elevated in live metrics or link_health.");
    const topNic = (metrics?.top_processes?.nic || [])[0];
    if (topNic?.pid) {
      causes.push(
        `Top bandwidth consumer: PID ${topNic.pid} · ${topNic.process || topNic.program || "unknown"} · ${topNic.total_kbps ?? "—"} KB/s total.`
      );
    }
  }

  if (id.includes("nic-connectivity") || id.includes("nic-link-down")) {
    causes.push("Network connectivity or link state degraded per live interface telemetry.");
    const sys = metrics?.system || {};
    if (sys.network_connectivity === false) {
      causes.push("Host reports network connectivity unreachable (gateway/internet probe failed).");
    }
    const down = (metrics?.nic || []).filter((n) => String(n.link_state || "").toLowerCase() !== "up");
    if (down.length > 0) {
      causes.push(`Interface(s) down: ${down.map((n) => n.name).join(", ")}.`);
    }
  }

  if (id.includes("gpu-pcie")) {
    causes.push(`GPU PCIe link health: ${(linkHealth?.gpu || [])[0]?.health?.link_status || "degraded"}.`);
  }

  if (fault.source === "kernel_event" && fault.kernelEvent?.message) {
    causes.push(`Kernel event: ${fault.kernelEvent.message}`);
  }

  if (fault.source === "link_health" && fault.faultDescription) {
    causes.push(`Link health alert: ${fault.faultDescription}`);
  }

  if (causes.length === 0 && fault.faultDescription) {
    causes.push(fault.faultDescription);
  }

  return [...new Set(causes)];
}
