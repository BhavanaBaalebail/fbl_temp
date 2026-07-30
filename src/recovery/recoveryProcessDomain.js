/**
 * Map faults to /recovery/process_candidates domain and per-row execute actions.
 */

export function processCandidatesDomainForFault(fault) {
  if (!fault) return "cpu";
  if (fault.component === "GPU" || String(fault.id || "").includes("gpu")) return "gpu";
  const id = String(fault.id || "");
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
    return { pause: "gpu.pause_process", kill: "gpu.terminate_process" };
  }
  if (domain === "disk") {
    return {
      pause: "disk.pause_process",
      resume: "disk.resume_process",
      kill: "disk.terminate_process",
    };
  }
  return { pause: "cpu.pause_process", kill: "cpu.kill_process" };
}

export function faultShowsProcessCandidates(fault) {
  if (!fault) return false;
  const id = String(fault.id || "");
  const component = fault.component;
  if (component === "CPU" || component === "GPU" || component === "RAM") return true;
  if (component === "DISK" && processCandidatesDomainForFault(fault) === "disk") return true;
  if (/cpu|gpu|ram|usage|temperature|vram|memory/i.test(id)) return true;
  return false;
}

export function candidateCommandLine(candidate) {
  return candidate?.command || candidate?.process || "—";
}

export function candidateUsageLabel(candidate, domain) {
  const pct = candidate?.usage_percent;
  if (pct == null) return "—";
  if (domain === "gpu") return `${pct}% GPU`;
  if (domain === "disk") return `${pct} KB/s total I/O`;
  return `${pct}% CPU`;
}

export function processCandidatesMinPercent(domain) {
  if (domain === "disk") return 1;
  return 1;
}
