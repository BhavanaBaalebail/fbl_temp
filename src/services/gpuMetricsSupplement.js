/**
 * Optional GPU metric enrichment from existing telemetry endpoints (no CM.py changes).
 * Fills util/temp on metrics.gpu when /metrics used lspci-only fallback but other
 * collectors captured nvidia-smi text output.
 */

function firstRegexMatch(text, patterns) {
  if (!text) return null;
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1] != null) {
      const n = Number(m[1]);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

const GPU_UTIL_PATTERNS = [
  /utilization\.gpu[^\d-]*(-?\d+(?:\.\d+)?)/i,
  /GPU Utilization[^\d-]*(-?\d+(?:\.\d+)?)/i,
  /Gpu\s*:\s*(-?\d+(?:\.\d+)?)\s*%/i,
];

const GPU_TEMP_PATTERNS = [
  /temperature\.gpu[^\d-]*(-?\d+(?:\.\d+)?)/i,
  /GPU Current Temp[^\d-]*(-?\d+(?:\.\d+)?)/i,
  /(?:GPU|Edge|Memory) Temperature[^\d-]*(-?\d+(?:\.\d+)?)/i,
];

function collectFunctionalBlockText(functionalBlocks) {
  const chunks = [];
  const gpuRoot = functionalBlocks?.GPU || functionalBlocks?.gpu;
  if (!gpuRoot || typeof gpuRoot !== "object") return chunks;

  Object.values(gpuRoot).forEach((section) => {
    (section?.commands || []).forEach((cmd) => {
      if (cmd?.output) chunks.push(String(cmd.output));
    });
  });
  return chunks.join("\n");
}

export function parseGpuMetricsFromFunctionalBlocks(functionalBlocks) {
  const text = collectFunctionalBlockText(functionalBlocks);
  if (!text.trim()) return { gpu_utilization_percent: null, temperature_celsius: null };

  return {
    gpu_utilization_percent: firstRegexMatch(text, GPU_UTIL_PATTERNS),
    temperature_celsius: firstRegexMatch(text, GPU_TEMP_PATTERNS),
  };
}

function coerceGpuArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return [value];
  return [];
}

/**
 * Mutates metrics.gpu[0] in place when supplemental fields are found.
 */
export function enrichMetricsGpu(metrics, inventory, linkHealth, functionalBlocks) {
  if (!metrics) return metrics;

  const list = coerceGpuArray(metrics.gpu);
  const inv = coerceGpuArray(inventory?.gpu);
  if (list.length === 0 && inv.length > 0) {
    metrics.gpu = inv.map((g) => ({ ...g }));
  } else if (list.length > 0) {
    metrics.gpu = list;
  } else {
    return metrics;
  }

  const gpu = metrics.gpu[0];
  if (!gpu) return metrics;

  const lhGpu = coerceGpuArray(linkHealth?.gpu)[0];
  const lhH = lhGpu?.health || {};

  const parsed = parseGpuMetricsFromFunctionalBlocks(functionalBlocks);

  if (gpu.gpu_utilization_percent == null) {
    gpu.gpu_utilization_percent =
      lhH.gpu_utilization_percent ?? parsed.gpu_utilization_percent ?? null;
  }
  if (gpu.temperature_celsius == null) {
    gpu.temperature_celsius =
      lhH.temperature_celsius ?? parsed.temperature_celsius ?? null;
  }
  if (gpu.memory_utilization_percent == null && lhH.memory_utilization_percent != null) {
    gpu.memory_utilization_percent = lhH.memory_utilization_percent;
  }
  if (gpu.power_draw_watts == null && lhH.power_draw_watts != null) {
    gpu.power_draw_watts = lhH.power_draw_watts;
  }

  return metrics;
}
