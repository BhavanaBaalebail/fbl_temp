/**
 * Evidence-based Root Cause Analysis — no invented diagnoses.
 */

import { getPrimaryGpu } from "../services/linkHealthService";

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

  if (id.includes("gpu-vram") && gpu?.memory_utilization_percent != null) {
    causes.push(`GPU VRAM utilization at ${gpu.memory_utilization_percent}%.`);
    if (byLabel["Top GPU Process"]) causes.push(`Primary GPU memory consumer: ${byLabel["Top GPU Process"]}.`);
  }

  if (id.includes("cpu-usage") && cpu.usage_percent != null) {
    causes.push(`High CPU utilization measured at ${cpu.usage_percent}%.`);
    if (byLabel["Top CPU Process"]) causes.push(`Primary CPU consumer: ${byLabel["Top CPU Process"]}.`);
  }

  if (id.includes("cpu-thermal")) {
    if (cpu.usage_percent >= 70) causes.push(`Elevated CPU usage (${cpu.usage_percent}%) contributing to thermal load.`);
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
    const mount = id.replace("threshold-disk-capacity-", "");
    const m = (metrics?.disk?.mounts || []).find((x) => (x.mountpoint || x.mount) === mount);
    if (m?.usage_percent != null) {
      causes.push(`Mount ${mount} at ${m.usage_percent}% capacity per live metrics.`);
    }
  }

  if (id.includes("disk-smart")) {
    causes.push("SMART health status not PASSED/OK — potential drive degradation.");
  }

  if (id.includes("nic-error") || id.includes("nic-lh")) {
    causes.push("Network interface error counters elevated in live metrics or link_health.");
  }

  if (id.includes("nic-connectivity") || id.includes("nic-link-down")) {
    causes.push("Network connectivity or link state degraded per live interface telemetry.");
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
