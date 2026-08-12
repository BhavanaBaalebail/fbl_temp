/**
 * Report thresholds — same sources used by the live fault engine.
 * Do not invent separate report-only thresholds.
 */

import {
  CPU_UTIL_THRESHOLDS,
  CPU_TEMP_THRESHOLDS,
  GPU_UTIL_THRESHOLDS,
  GPU_TEMP_THRESHOLDS,
  NIC_UTIL_THRESHOLDS,
  IO_BUSY_THRESHOLDS,
  IO_QUEUE_THRESHOLDS,
  IO_LATENCY_THRESHOLDS,
  IO_THROUGHPUT_THRESHOLDS,
} from "../linkHealthService";

/** Memory thresholds match linkHealthService fault logic (80 / 90). */
export const MEM_UTIL_THRESHOLDS = {
  warningMin: 80,
  criticalMin: 90,
};

export const MEM_SWAP_THRESHOLDS = {
  warningMin: 50,
  criticalMin: 80,
};

export const REPORT_THRESHOLDS = {
  CPU: {
    utilization: CPU_UTIL_THRESHOLDS,
    temperature: CPU_TEMP_THRESHOLDS,
  },
  GPU: {
    utilization: GPU_UTIL_THRESHOLDS,
    temperature: GPU_TEMP_THRESHOLDS,
  },
  RAM: {
    utilization: MEM_UTIL_THRESHOLDS,
    swap: MEM_SWAP_THRESHOLDS,
  },
  DISK: {
    busy: IO_BUSY_THRESHOLDS,
    queue: IO_QUEUE_THRESHOLDS,
    latency: IO_LATENCY_THRESHOLDS,
    throughput: IO_THROUGHPUT_THRESHOLDS,
  },
  NIC: {
    utilization: NIC_UTIL_THRESHOLDS,
  },
  IO: {
    busy: IO_BUSY_THRESHOLDS,
    queue: IO_QUEUE_THRESHOLDS,
    latency: IO_LATENCY_THRESHOLDS,
    throughput: IO_THROUGHPUT_THRESHOLDS,
  },
};

export function thresholdPair(obj) {
  if (!obj) return null;
  const warn = obj.warningMin ?? obj.warningC ?? null;
  const crit = obj.criticalMin ?? obj.criticalC ?? null;
  if (warn == null && crit == null) return null;
  return { warning: warn, critical: crit };
}
