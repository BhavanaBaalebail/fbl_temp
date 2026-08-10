/**
 * Anomaly Data Module
 * Contains anomaly category cards and status information for the Fault Detection tab
 */

export const anomalyCategoryCards = [
  {
    component: "GPU",
    interfaceType: "PCIe x16",
    overallStatus: "WARNING",
    rows: [
      { dot: "#ff4444", faultName: "Thermal throttle", status: "ACTIVE", subtitle: "Junction temp 89°C" },
      { dot: "#ff8c00", faultName: "PCIe link degrade", status: "MONITOR", subtitle: "x16 stable" },
      { dot: "#00c853", faultName: "VRAM ECC errors", status: "CLEAR", subtitle: "No errors" },
      { dot: "#00c853", faultName: "Power draw spike", status: "CLEAR", subtitle: "Normal range" },
    ],
  },
  {
    component: "RAM",
    interfaceType: "DDR5 Bus",
    overallStatus: "RESOLVED",
    rows: [
      { dot: "#00c853", faultName: "ECC bit errors", status: "CLEAR", subtitle: "1 corrected, stable" },
      { dot: "#00c853", faultName: "Channel training", status: "CLEAR", subtitle: "4800 MT/s locked" },
      { dot: "#00c853", faultName: "Bandwidth saturation", status: "CLEAR", subtitle: "42% utilization" },
      { dot: "#00c853", faultName: "DIMM degradation", status: "CLEAR", subtitle: "Health normal" },
    ],
  },
  {
    component: "DISK",
    interfaceType: "NVMe",
    overallStatus: "CRITICAL",
    rows: [
      { dot: "#ff4444", faultName: "SMART failure", status: "ACTIVE", subtitle: "Sectors reallocated" },
      { dot: "#ff8c00", faultName: "NVMe link errors", status: "MONITOR", subtitle: "CRC count rising" },
      { dot: "#ff4444", faultName: "Latency anomaly", status: "ACTIVE", subtitle: "P99 > 12ms" },
      { dot: "#00c853", faultName: "Thermal throttle", status: "CLEAR", subtitle: "48°C nominal" },
    ],
  },

  {
    component: "NIC",
    interfaceType: "PCIe x8",
    overallStatus: "CLEAR",
    rows: [
      { dot: "#00c853", faultName: "Link flap", status: "CLEAR", subtitle: "Recovered 3h ago" },
      { dot: "#00c853", faultName: "PHY sync loss", status: "CLEAR", subtitle: "Locked 25GbE" },
      { dot: "#00c853", faultName: "CRC / frame err", status: "CLEAR", subtitle: "0 errors/min" },
      { dot: "#00c853", faultName: "Bandwidth anomaly", status: "CLEAR", subtitle: "12% utilization" },
    ],
  },
  {
    component: "IO Control",
    interfaceType: "DMI 4.0",
    overallStatus: "CLEAR",
    rows: [
      { dot: "#00c853", faultName: "DMI saturation", status: "CLEAR", subtitle: "28% bandwidth" },
      { dot: "#00c853", faultName: "Packet retransmit", status: "CLEAR", subtitle: "0 retransmits" },
      { dot: "#00c853", faultName: "Peripheral enum fail", status: "CLEAR", subtitle: "All devices OK" },
      { dot: "#ff8c00", faultName: "Latency injection", status: "MONITOR", subtitle: "Spike +0.3ms" },
    ],
  },

];
