/**
 * Topology Data Module
 * Symmetric star/snowflake layout for Physical Connectivity maps.
 * Five peripherals are evenly spaced (72°) on a ring; the active component
 * sits at the center hub. Only nodeX/nodeY/ifaceX/ifaceY are computed.
 */

export const TOPOLOGY_CENTER = { x: 600, y: 380 };
/** Default outer radius; each spoke may extend to canvas max when needed */
export const TOPOLOGY_RADIUS = 330;

export const CENTER_NODE_HALF_W = 120;
export const CENTER_NODE_HALF_H = 55;
export const PERIPHERAL_HALF_W = 95;
export const PERIPHERAL_HALF_H = 42;
export const INTERFACE_HALF_W = 105;
export const INTERFACE_HALF_H = 30;

const CANVAS_BOUNDS = { width: 1200, height: 700 };
// Preserve overall canvas size. Reduce horizontal margins to allow radial
// spokes to extend farther toward the canvas edges while keeping a larger
// top margin so the top peripheral doesn't collide with the page header.
const CANVAS_MARGIN = { left: 40, right: 40, top: 40, bottom: 70 };
// Increased branch gap to ensure interface cards don't avoid touching peripheral cards
// and to provide consistent spacing across branches.
const BRANCH_GAP = 44;

export const COMPONENT_IDS = ["CPU", "RAM", "GPU", "DISK", "NIC", "IO Controller"];

/**
 * We use a fixed 5-position radial template (center plus five spokes).
 * Positions (index order): Top, Upper-left, Lower-left, Upper-right, Lower-right
 */
const SPOKE_COUNT = 5;
const START_ANGLE = -Math.PI / 2;

/* Explicit angles for the five spoke positions to create the requested layout */
const POS_ANGLES = [
  -Math.PI / 2, // Top (-90°)
  -170 * (Math.PI / 180), // Upper-left (-150°)
  150 * (Math.PI / 180), // Lower-left (150°)
  -10 * (Math.PI / 180), // Upper-right (-30°)
  30 * (Math.PI / 180), // Lower-right (30°)
];

const COMPONENT_META = {
  CPU: { title: "CPU", subtitle: "Processor", color: "#ff4444" },
  RAM: { title: "RAM", subtitle: "Memory Module", color: "#00ff88" },
  GPU: { title: "GPU", subtitle: "Graphics Unit", color: "#ffd700" },
  DISK: { title: "DISK", subtitle: "Storage", color: "#ff8c00" },
  NIC: { title: "NIC", subtitle: "Network Card", color: "#00bfff" },
  "IO Controller": {
    title: "IO Controller",
    subtitle: "I/O Controller",
    color: "#00ffff",
  },
};

const CONNECTION_PATHS = {
  CPU: {
    RAM: {
      ifaceLabel: "DDR5 Memory Bus",
      ifaceSubtitle: "Multi-Channel Direct",
    },
    GPU: {
      ifaceLabel: "PCIe x16 Gen5",
      ifaceSubtitle: "Direct Lanes",
    },
    DISK: {
      ifaceLabel: "PCIe / NVMe",
      ifaceSubtitle: "Direct + DMI→PCH→SATA",
    },
    NIC: {
      ifaceLabel: "PCIe x8/x16",
      ifaceSubtitle: "Direct or via PCH",
    },
    "IO Controller": {
      ifaceLabel: "DMI / PCIe",
      ifaceSubtitle: "Via Platform Controller Hub",
    },
  },
  GPU: {
    CPU: {
      ifaceLabel: "PCIe x16 Gen5",
      ifaceSubtitle1: "Direct Lanes",
      ifaceSubtitle2: "PCIe BAR0 (x16)",
    },
    RAM: {
      ifaceLabel: "PCIe DMA",
      ifaceSubtitle1: "Host Memory Access",
      ifaceSubtitle2: "BAR0 / BAR1 MMIO",
    },
    DISK: {
      ifaceLabel: "PCIe → NVMe",
      ifaceSubtitle1: "GPUDirect Storage",
      ifaceSubtitle2: "GDS / PCIe P2P",
    },
    NIC: {
      ifaceLabel: "PCIe P2P / RDMA",
      ifaceSubtitle1: "GPUDirect RDMA",
      ifaceSubtitle2: "GDR Port",
    },
    "I/O": {
      ifaceLabel: "Block I/O Path",
      ifaceSubtitle1: "Storage Queues",
      ifaceSubtitle2: "NVMe / SATA",
    },
    "IO Controller": {
      ifaceLabel: "PCIe Switch",
      ifaceSubtitle1: "Multi-GPU Fabric",
      ifaceSubtitle2: "NVLink / NV Switch",
    },
  },
  RAM: {
    CPU: {
      ifaceLabel: "DDR5 Memory Bus",
      ifaceSubtitle1: "Multi-Channel Direct",
      ifaceSubtitle2: "DIMM Slots A1-D2",
    },
    GPU: {
      ifaceLabel: "PCIe DMA",
      ifaceSubtitle1: "Host Device Transfer",
      ifaceSubtitle2: "BAR MMIO Region",
    },
    DISK: {
      ifaceLabel: "DMA / Page Cache",
      ifaceSubtitle1: "Buffer Cache I/O",
      ifaceSubtitle2: "Kernel Page Pool",
    },
    NIC: {
      ifaceLabel: "DMA Ring Buffers",
      ifaceSubtitle1: "Packet Buffer Memory",
      ifaceSubtitle2: "RX/TX Descriptor Rings",
    },
    "I/O": {
      ifaceLabel: "Block I/O Path",
      ifaceSubtitle1: "Storage Queues",
      ifaceSubtitle2: "NVMe / SATA",
    },
    "IO Controller": {
      ifaceLabel: "MMIO Mapping",
      ifaceSubtitle1: "Device Register Access",
      ifaceSubtitle2: "Memory-Mapped I/O",
    },
  },
  DISK: {
    CPU: {
      ifaceLabel: "PCIe / NVMe Direct",
      ifaceSubtitle1: "NVMe Command Queue",
      ifaceSubtitle2: "M.2 / U.2 Slot",
    },
    RAM: {
      ifaceLabel: "DMA Transfers",
      ifaceSubtitle1: "Page Cache Buffers",
      ifaceSubtitle2: "DMA Channel",
    },
    GPU: {
      ifaceLabel: "GPUDirect Storage",
      ifaceSubtitle1: "PCIe P2P Bypass",
      ifaceSubtitle2: "GDS API Path",
    },
    NIC: {
      ifaceLabel: "iSCSI / NFS / NVMeoF",
      ifaceSubtitle1: "Network Storage Proto",
      ifaceSubtitle2: "Port 3260 / 2049",
    },
    "I/O": {
      ifaceLabel: "Block I/O Path",
      ifaceSubtitle1: "Device Queues",
      ifaceSubtitle2: "Busy / Latency / IOPS",
    },
    "IO Controller": {
      ifaceLabel: "SATA / SAS via PCH",
      ifaceSubtitle1: "AHCI / HBA Controller",
      ifaceSubtitle2: "SATA Port 0-7 / SAS 0-3",
    },
  },
  NIC: {
    CPU: {
      ifaceLabel: "PCIe x8/x16",
      ifaceSubtitle1: "Direct or via PCH",
      ifaceSubtitle2: "PCIe Slot 2-4",
    },
    RAM: {
      ifaceLabel: "DMA Ring Buffers",
      ifaceSubtitle1: "Packet RX/TX Queues",
      ifaceSubtitle2: "MSI-X Vectors 0-63",
    },
    GPU: {
      ifaceLabel: "GPUDirect RDMA",
      ifaceSubtitle1: "PCIe P2P Transfer",
      ifaceSubtitle2: "GDR / RoCEv2",
    },
    DISK: {
      ifaceLabel: "iSCSI / NVMe-oF",
      ifaceSubtitle1: "Network Storage",
      ifaceSubtitle2: "Port 3260 / 4420",
    },
    "IO Controller": {
      ifaceLabel: "PCIe via PCH",
      ifaceSubtitle1: "Chipset Bridge",
      ifaceSubtitle2: "DMI 3.0 / 4.0",
    },
  },
  "IO Controller": {
    CPU: {
      ifaceLabel: "DMI 4.0 / PCIe",
      ifaceSubtitle1: "CPU-PCH Uplink",
      ifaceSubtitle2: "DMI x8 Gen4",
    },
    GPU: {
      ifaceLabel: "PCIe Switch Fabric",
      ifaceSubtitle1: "Multi-GPU / Riser",
      ifaceSubtitle2: "PCIe x16 Slots",
    },
    RAM: {
      ifaceLabel: "MMIO via DMI",
      ifaceSubtitle1: "Device Memory Map",
      ifaceSubtitle2: "MMIO BAR Range",
    },
    DISK: {
      ifaceLabel: "SATA / SAS Ports",
      ifaceSubtitle1: "AHCI / HBA Controller",
      ifaceSubtitle2: "SATA 0-7 / SAS 0-3",
    },
    NIC: {
      ifaceLabel: "PCIe Lanes",
      ifaceSubtitle1: "Onboard / Add-in NIC",
      ifaceSubtitle2: "PCIe x4/x8 Port",
    },
  },
};

const PERIPHERAL_SUBTITLES = {
  RAM: {
    GPU: "System Memory",
    DISK: "System Memory",
    NIC: "System Memory",
    "IO Controller": "System Memory",
  },
};

export function spokeAngle(spokeIndex) {
  return POS_ANGLES[spokeIndex % SPOKE_COUNT];
}

// Compute distance from a rectangle center to its border along a unit ray
// specified by (nx, ny). This returns the distance (in pixels) you must
// travel from the rectangle center in that direction to reach the rectangle
// edge. For an axis-aligned rectangle this is:
//   inset = min(halfW/|nx|, halfH/|ny|)
// with proper handling for near-zero components. This math is identical to
// the approach used by `centerEdgeToward` and is the single source-of-truth
// for rectangle/ray intersection used throughout the topology layout.
export function rectInsetAlongRay(halfW, halfH, nx, ny) {
  const EPS = 1e-9;
  const absNx = Math.abs(nx);
  const absNy = Math.abs(ny);
  const tX = absNx > EPS ? halfW / absNx : Infinity;
  const tY = absNy > EPS ? halfH / absNy : Infinity;
  return Math.min(tX, tY);
}

function spokeUnitVectorByIndex(spokeIndex) {
  const angle = spokeAngle(spokeIndex);
  return { nx: Math.cos(angle), ny: Math.sin(angle), angle };
}

export function radialPositionByIndex(
  spokeIndex,
  radius,
  center = TOPOLOGY_CENTER
) {
  const { nx, ny } = spokeUnitVectorByIndex(spokeIndex);
  return {
    x: Math.round(center.x + radius * nx),
    y: Math.round(center.y + radius * ny),
  };
}

/** Max radius along a spoke before peripheral cards clip the canvas. */
export function maxRadiusForSpokeByIndex(spokeIndex, center = TOPOLOGY_CENTER) {
  const { nx, ny } = spokeUnitVectorByIndex(spokeIndex);

  const limits = [];
  // Ensure the peripheral rectangle (axis-aligned) remains inside the canvas
  // by subtracting the half-width/half-height on the corresponding axis.
  if (nx > 0.01) limits.push((CANVAS_BOUNDS.width - CANVAS_MARGIN.right - center.x - PERIPHERAL_HALF_W) / nx);
  if (nx < -0.01) limits.push((center.x - CANVAS_MARGIN.left - PERIPHERAL_HALF_W) / -nx);
  if (ny > 0.01) limits.push((CANVAS_BOUNDS.height - CANVAS_MARGIN.bottom - center.y - PERIPHERAL_HALF_H) / ny);
  if (ny < -0.01) limits.push((center.y - CANVAS_MARGIN.top - PERIPHERAL_HALF_H) / -ny);

  if (!limits.length) return TOPOLOGY_RADIUS;
  return Math.floor(Math.min(...limits));
}

function chordBetweenEdges(nodeX, nodeY, center = TOPOLOGY_CENTER) {
  const hubEdge = centerEdgeToward(nodeX, nodeY, center);
  const periphEdge = peripheralEdgeTowardCenter(nodeX, nodeY, center);
  const dx = periphEdge.x - hubEdge.x;
  const dy = periphEdge.y - hubEdge.y;
  const length = Math.hypot(dx, dy);
  return { hubEdge, periphEdge, dx, dy, length };
}

function minRadiusForBranchClearanceByIndex(spokeIndex, center = TOPOLOGY_CENTER) {
  const { nx, ny } = spokeUnitVectorByIndex(spokeIndex);
  const ifaceHalf = rectInsetAlongRay(INTERFACE_HALF_W, INTERFACE_HALF_H, nx, ny);
  const required = 2 * ifaceHalf + 2 * BRANCH_GAP;
  let lo = TOPOLOGY_RADIUS;
  let hi = maxRadiusForSpokeByIndex(spokeIndex, center);

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const { x, y } = radialPositionByIndex(spokeIndex, mid, center);
    const { length } = chordBetweenEdges(x, y, center);
    if (length >= required) hi = mid - 1;
    else lo = mid;
  }

  return lo;
}

export function radiusForSpokeByIndex(spokeIndex, center = TOPOLOGY_CENTER) {
  const canvasMax = maxRadiusForSpokeByIndex(spokeIndex, center);
  const clearanceMin = minRadiusForBranchClearanceByIndex(spokeIndex, center);
  return Math.min(canvasMax, Math.max(TOPOLOGY_RADIUS, clearanceMin));
}

export function slotPositionByIndex(
  spokeIndex,
  center = TOPOLOGY_CENTER,
  radius = radiusForSpokeByIndex(spokeIndex, center)
) {
  const { x, y } = radialPositionByIndex(spokeIndex, radius, center);
  return { nodeX: x, nodeY: y };
}

/** Inner edge of peripheral card facing the center hub. */
export function peripheralEdgeTowardCenter(
  peripheralX,
  peripheralY,
  center = TOPOLOGY_CENTER
) {
  const dx = center.x - peripheralX;
  const dy = center.y - peripheralY;
  const dist = Math.hypot(dx, dy);
  if (!dist) return { x: peripheralX, y: peripheralY };

  const nx = dx / dist;
  const ny = dy / dist;
  const inset = rectInsetAlongRay(PERIPHERAL_HALF_W, PERIPHERAL_HALF_H, nx, ny);

  return {
    x: Math.round(peripheralX + nx * inset),
    y: Math.round(peripheralY + ny * inset),
  };
}

/**
 * Place interface at the chord midpoint between hub and peripheral inner edges.
 * Equal spacing: hub → gap → iface → gap → peripheral on every branch.
 */
export function interfacePosition(
  peripheralX,
  peripheralY,
  center = TOPOLOGY_CENTER
) {
  const { hubEdge, periphEdge, dx, dy, length } = chordBetweenEdges(
    peripheralX,
    peripheralY,
    center
  );

  if (!length) {
    return { ifaceX: center.x, ifaceY: center.y };
  }

  const nx = dx / length;
  const ny = dy / length;
  // distance from interface center to its edge along the chord direction
  const ifaceHalf = rectInsetAlongRay(INTERFACE_HALF_W, INTERFACE_HALF_H, nx, ny);
  const halfT = ifaceHalf / length;
  const margin = BRANCH_GAP / length;

  // Place the interface exactly at the midpoint of the usable free segment
  // (equal spacing before/after). Enforce a minimum visible segment so the
  // interface sits at least 40-60px away from both ends; if the chord is too
  // short, radiusForSpokeByIndex will increase the radius to achieve clearance.
  const desiredT = 0.5;
  const MIN_VISIBLE_SEG = 50; // pixels (keeps spacing within 40-60px range)
  const minT = halfT + margin;
  const maxT = 1 - halfT - margin;
  const minTBySeg = MIN_VISIBLE_SEG / length;
  const maxTBySeg = 1 - minTBySeg;

  let t;
  if (minT <= maxT) {
    const lo = Math.max(minT, minTBySeg);
    const hi = Math.min(maxT, maxTBySeg);
    if (lo <= hi) t = Math.max(lo, Math.min(desiredT, hi));
    else t = 0.5;
  } else {
    t = 0.5;
  }

  // If the chord length is still very small (edges collapsed), synthesize
  // temporary hub/peripheral edge points that guarantee visible segments
  // while keeping the actual node positions unchanged.
  const MIN_TOTAL_CHORD = MIN_VISIBLE_SEG * 2 + ifaceHalf * 2;
  if (length < MIN_TOTAL_CHORD) {
    const cx = center.x;
    const cy = center.y;
    const nxFull = (peripheralX - cx) / Math.hypot(peripheralX - cx, peripheralY - cy);
    const nyFull = (peripheralY - cy) / Math.hypot(peripheralX - cx, peripheralY - cy);
    const hubInset = CENTER_NODE_HALF_W + MIN_VISIBLE_SEG / 2;
    const periphInset = rectInsetAlongRay(PERIPHERAL_HALF_W, PERIPHERAL_HALF_H, nxFull, nyFull) + MIN_VISIBLE_SEG / 2;

    const synthHub = { x: Math.round(cx + nxFull * hubInset), y: Math.round(cy + nyFull * hubInset) };
    const synthPeriph = { x: Math.round(peripheralX - nxFull * periphInset), y: Math.round(peripheralY - nyFull * periphInset) };
    const sdx = synthPeriph.x - synthHub.x;
    const sdy = synthPeriph.y - synthHub.y;
    const slen = Math.hypot(sdx, sdy) || 1;
    const minSt = MIN_VISIBLE_SEG / slen;
    const maxSt = 1 - minSt;
    let st;
    if (minSt <= maxSt) st = Math.max(minSt, Math.min(desiredT, maxSt));
    else st = 0.5;
    return {
      ifaceX: Math.round(synthHub.x + sdx * st),
      ifaceY: Math.round(synthHub.y + sdy * st),
    };
  }
  return {
    ifaceX: Math.round(hubEdge.x + dx * t),
    ifaceY: Math.round(hubEdge.y + dy * t),
  };
}

/** Point on the center hub border toward a peripheral (line termination). */
export function centerEdgeToward(targetX, targetY, center = TOPOLOGY_CENTER) {
  const dx = targetX - center.x;
  const dy = targetY - center.y;
  const dist = Math.hypot(dx, dy);
  if (!dist) return { x: center.x, y: center.y };

  const nx = dx / dist;
  const ny = dy / dist;
  const tX = nx !== 0 ? CENTER_NODE_HALF_W / Math.abs(nx) : Infinity;
  const tY = ny !== 0 ? CENTER_NODE_HALF_H / Math.abs(ny) : Infinity;
  const inset = Math.min(tX, tY);

  return {
    x: Math.round(center.x + nx * inset),
    y: Math.round(center.y + ny * inset),
  };
}

function resolvePeripheralSubtitle(peripheralId, centerId) {
  const meta = COMPONENT_META[peripheralId];
  return PERIPHERAL_SUBTITLES[peripheralId]?.[centerId] || meta.subtitle;
}

/**
 * Build radial spokes for the star topology centered on centerId.
 * Peripherals are sorted by spoke index for stable render order.
 */
export function buildStarTopologyLinks(centerId) {
  const paths = CONNECTION_PATHS[centerId];
  if (!paths) return [];

  // Fixed assignment: take the canonical COMPONENT_IDS order, remove the center,
  // and place the remaining peripherals in fixed spoke positions.
  const peripherals = COMPONENT_IDS.filter((id) => id !== centerId);

  // Build each spoke using the clearance-aware `radiusForSpokeByIndex` so
  // every branch guarantees CPU → gap → interface → gap → peripheral spacing
  // without overlapping. Do NOT use `maxRadiusForSpokeByIndex` here.
  return peripherals.map((peripheralId, idx) => {
    const meta = COMPONENT_META[peripheralId];
    const path = paths[peripheralId] || {};
    const spokeIndex = idx % SPOKE_COUNT; // 0..4
    // Keep the top spoke visually as-is; extend the four diagonal spokes to
    // be noticeably longer (30-50%) while capping at each spoke's canvas max.
    // Multipliers are symmetric to preserve the star layout.
    const multipliers = [1.0, 1.8, 1.8, 1.8, 1.8];
    const baseRadius = radiusForSpokeByIndex(spokeIndex);
    const canvasMax = maxRadiusForSpokeByIndex(spokeIndex);
    const desired = Math.min(canvasMax, Math.round(baseRadius * (multipliers[spokeIndex] || 1)));
    const radius = Math.max(baseRadius, desired);
    const { nodeX, nodeY } = slotPositionByIndex(spokeIndex, TOPOLOGY_CENTER, radius);
    const { ifaceX, ifaceY } = interfacePosition(nodeX, nodeY);

    return {
      id: peripheralId,
      title: meta.title,
      subtitle: resolvePeripheralSubtitle(peripheralId, centerId),
      color: meta.color,
      nodeX,
      nodeY,
      ifaceX,
      ifaceY,
      ...path,
    };
  });
}

export const cpuLinks = buildStarTopologyLinks("CPU");
export const gpuLinks = buildStarTopologyLinks("GPU");
export const ramLinks = buildStarTopologyLinks("RAM");
export const diskLinks = buildStarTopologyLinks("DISK");
export const nicLinks = buildStarTopologyLinks("NIC");
export const ioCtrlLinks = buildStarTopologyLinks("IO Controller");
