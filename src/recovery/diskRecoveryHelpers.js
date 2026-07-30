/**
 * Shared helpers for Disk autonomous recovery (evidence, RCA, targets).
 */

const DISK_FAULT_DEVICE_PREFIXES = [
  "threshold-disk-busy-",
  "threshold-disk-queue-",
  "threshold-disk-latency-",
  "threshold-disk-throughput-",
  "threshold-disk-smart-",
  "threshold-disk-nvme-errors-",
  "threshold-disk-nvme-wear-",
  "threshold-disk-sata-",
];

export function deviceFromDiskFaultId(id) {
  if (!id || typeof id !== "string") return null;
  for (const prefix of DISK_FAULT_DEVICE_PREFIXES) {
    if (id.startsWith(prefix)) return id.slice(prefix.length);
  }
  if (id.startsWith("threshold-disk-capacity-")) {
    return id.slice("threshold-disk-capacity-".length);
  }
  return null;
}

export function isDiskWorkloadFault(fault) {
  const id = fault?.id || "";
  return (
    id.startsWith("threshold-disk-busy-") ||
    id.startsWith("threshold-disk-queue-") ||
    id.startsWith("threshold-disk-latency-") ||
    id.startsWith("threshold-disk-throughput-")
  );
}

export function isDiskHardwareFault(fault) {
  const id = fault?.id || "";
  return (
    id.startsWith("threshold-disk-smart-") ||
    id.startsWith("threshold-disk-nvme-errors-") ||
    id.startsWith("threshold-disk-nvme-wear-") ||
    id.startsWith("threshold-disk-sata-")
  );
}

export function diskPerformanceForFault(fault, metrics) {
  const device = deviceFromDiskFaultId(fault?.id);
  const perfList = metrics?.disk?.performance || [];
  if (device) {
    const match = perfList.find((p) => p.device === device);
    if (match) return match;
  }
  if (perfList.length === 0) return null;
  return perfList.reduce((best, p) => {
    const score = (p.busy_percent || 0) + (p.queue_depth || 0) + (p.total_MB_per_sec || 0);
    const bestScore = (best?.busy_percent || 0) + (best?.queue_depth || 0) + (best?.total_MB_per_sec || 0);
    return score >= bestScore ? p : best;
  }, perfList[0]);
}

export function nvmeHealthForDevice(device, linkHealth) {
  const nvmeArr = Array.isArray(linkHealth?.nvme) ? linkHealth.nvme : [];
  if (!device) return nvmeArr[0] || null;
  return (
    nvmeArr.find((d) => {
      const name = d.device || d.name || "";
      return name.includes(device) || device.includes(String(name).replace("/dev/", ""));
    }) || nvmeArr[0] ||
    null
  );
}

export function smartForDevice(device, metrics) {
  const smart = metrics?.disk?.smart || {};
  if (device && smart[device]) return smart[device];
  const keys = Object.keys(smart);
  return keys.length ? smart[keys[0]] : null;
}

export function mountForFault(fault, metrics) {
  const id = fault?.id || "";
  if (id.startsWith("threshold-disk-capacity-")) {
    const mp = id.replace("threshold-disk-capacity-", "");
    return (metrics?.disk?.mounts || []).find(
      (m) => (m.mountpoint || m.mount) === mp
    );
  }
  return null;
}
