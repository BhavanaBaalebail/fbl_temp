/**
 * Map faults to /recovery/process_candidates domain and per-row execute actions.
 */

export function processCandidatesDomainForFault(fault) {
  if (!fault) return "cpu";
  if (fault.component === "GPU" || String(fault.id || "").includes("gpu")) return "gpu";
  const id = String(fault.id || "");
  if (fault.component === "NIC" || id.includes("nic")) return "nic";
  if (
    fault.component === "DISK" &&
    (id.includes("disk-busy") ||
      id.includes("disk-queue") ||
      id.includes("disk-latency") ||
      id.includes("disk-throughput"))
  ) {
    return "disk";
  }
  return "cpu";
}

export function processActionKeysForDomain(domain) {
  if (domain === "gpu") {
    return {
      pause: "gpu.pause_process",
      resume: "gpu.resume_process",
      kill: "gpu.terminate_process",
    };
  }
  if (domain === "disk") {
    return {
      pause: "disk.pause_process",
      resume: "disk.resume_process",
      kill: "disk.terminate_process",
    };
  }
  if (domain === "nic") {
    return {
      pause: "nic.pause_process",
      resume: "nic.resume_process",
      kill: "nic.terminate_process",
    };
  }
  return { pause: "cpu.pause_process", kill: "cpu.kill_process" };
}

export function faultShowsProcessCandidates(fault) {
  if (!fault) return false;
  const id = String(fault.id || "");
  const component = fault.component;
  if (id === "threshold-gpu-pcie-link") return false;
  if (component === "CPU" || component === "GPU" || component === "RAM") return true;
  if (component === "NIC" || id.includes("nic")) return true;
  if (component === "DISK" && processCandidatesDomainForFault(fault) === "disk") return true;
  if (/cpu|gpu|ram|usage|temperature|vram|memory/i.test(id)) return true;
  return false;
}

export function candidateCommandLine(candidate) {
  return candidate?.command || candidate?.process || "—";
}

export function candidateUsageLabel(candidate, domain) {
  if (domain === "nic") {
    if (candidate?.total_mbps != null) return `${Number(candidate.total_mbps).toFixed(1)} Mbps`;
    const kbps = candidate?.total_kbps ?? candidate?.usage_percent;
    if (kbps != null) return `${((Number(kbps) * 8) / 1000).toFixed(1)} Mbps`;
    return "—";
  }
  const pct = candidate?.usage_percent;
  if (pct == null) return "—";
  if (domain === "gpu") {
    if (candidate?.gpu_memory_mb != null && (candidate?.gpu_compute_percent == null)) {
      return `${candidate.gpu_memory_mb} MB VRAM`;
    }
    return `${pct}% GPU`;
  }
  if (domain === "disk") return `${pct} KB/s total I/O`;
  return `${pct}% CPU`;
}

export function processCandidatesMinPercent(domain) {
  if (domain === "disk") return 1;
  if (domain === "gpu") return 1;
  if (domain === "nic") return 1;
  return 1;
}
