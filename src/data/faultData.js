/**
 * Fault Data Module
 * Contains fault log entries, action plans, and resolved fault information
 */

export const faultLogRows = [

  {
    severity: "Critical",
    component: "DISK",
    componentDot: "#ff8c00",
    faultDescription:
      "NVMe SSD SMART status: reallocated sector count exceeding threshold on M.2 Slot 1 (Gen4 x4). Media wear indicator at 94%. Predictive failure imminent.",
    affectedPath: "DISK → NVMe → CPU (PCIe)",
    detected: "8 min ago",
    status: "Active",
    action: "View →",
  },
  {
    severity: "Warning",
    component: "GPU",
    componentDot: "#ffd700",
    faultDescription:
      "GPU junction temperature exceeding 89°C under sustained compute load. Thermal throttling engaged, reducing clock speed by 15%. Fan RPM at 95% max.",
    affectedPath: "GPU → PCIe x16 → CPU",
    detected: "15 min ago",
    status: "Monitor",
    action: "View →",
  },
  {
    severity: "Resolved",
    component: "RAM",
    componentDot: "#00ff88",
    faultDescription:
      "Correctable ECC error detected on DIMM A2 (DDR5 Channel B) - single-bit error auto-corrected by ECC engine. No data loss. DIMM health normal.",
    affectedPath: "RAM → Ch.B → CPU (IMC)",
    detected: "1 hr ago",
    status: "Resolved",
    action: "Log",
  },
  {
    severity: "Resolved",
    component: "NIC",
    componentDot: "#00bfff",
    faultDescription:
      "Network link flap detected on Port 1 (25GbE SFP28). Auto-negotiation recovered after 2.3 seconds. PHY transceiver re-synced at full speed.",
    affectedPath: "NIC → PCIe x8 → CPU",
    detected: "3 hr ago",
    status: "Resolved",
    action: "Log",
  },
];

export const faultActionPlans = {

  DISK: {
    interfaceSubtitle: "NVMe",
    priority: "P1 - CRITICAL",
    priorityColor: "#ff4444",
    title: "SMART Threshold Exceeded - Reallocated sectors + 94% media wear",
    steps: [
      "Initiate immediate backup of critical data (rsync / dd / vendor tool)",
      "Run full SMART extended self-test: nvme smart-log /dev/nvme0n1",
      "Check RAID array status - if degraded, prevent further writes to failing drive",
      "Replace NVMe SSD in M.2 Slot 1 (Gen4 x4) - initiate RAID rebuild if applicable",
    ],
    estResolution: "30-60 min (backup + swap) | 2-8 hrs (RAID rebuild)",
    connectivity: "DISK → M.2 NVMe → CPU PCIe | DISK → DMA → RAM Page Cache",
    impact: "CPU (PCIe lane reallocation), RAM (page cache flush), IO Controller (NVMe queue)",
    impactTone: "#ff4444",
    selfHealingPhases: [
      {
        component: "DISK",
        interfaceLabel: "Phase 1 - Detection & Write Protection | NVMe Controller",
        status: "AUTO-HEALED",
        statusBg: "#00c853",
        borderColor: "#ff8c00",
        title: "SMART Threshold Breach Detected - Automatic write protection initiated",
        steps: [
          "NVMe controller detects reallocated sector count exceeding SMART threshold",
          "OS kernel marks drive as degraded - new writes redirected to healthy sectors",
          "Storage controller logs SMART event and triggers predictive failure alert",
          "Automatic snapshot initiated via storage manager before drive fully degrades",
        ],
        autoResolution: "< 1 sec (write protection) | 5-30 min (snapshot)",
        connectivity: "DISK → NVMe → CPU PCIe",
        impact: "RAM (page cache flush), CPU (PCIe reallocation)",
      },
      {
        component: "Storage Controller",
        interfaceLabel: "Phase 2 - RAID Rebuild & Data Protection | PCIe Bus",
        status: "FAILOVER",
        statusBg: "#0066ff",
        borderColor: "#0066ff",
        title: "Drive Failure Imminent - RAID degraded mode + rebuild sequence",
        steps: [
          "RAID controller switches array to degraded mode - read performance maintained",
          "Hot-spare drive activated automatically if configured in RAID group",
          "Full RAID rebuild initiated - progress logged to system event log every 60 seconds",
          "Admin notified via SNMP/email - physical drive replacement flagged urgent",
        ],
        autoResolution: "2-8 hrs (RAID rebuild) | Zero data loss if RAID-1/5/6",
        connectivity: "DISK → RAID Controller → IO CTRL | DISK → DMA → RAM",
        impact: "IO Controller (NVMe queue throttle), RAM (DMA buffer realloc)",
      },
    ],
  },
  GPU: {
    interfaceSubtitle: "PCIe x16",
    priority: "P2 - WARNING",
    priorityColor: "#ff8c00",
    title: "Thermal Throttling at 89°C - Clock speed reduced 15%",
    steps: [
      "Check GPU fan RPM curve and verify fans are operational via driver/sysfs interface",
      "Inspect chassis airflow - ensure no cable obstructions in GPU cooling path",
      "Clean heatsink fins and verify thermal paste condition (schedule if >2 years old)",
      "Reduce GPU workload or add supplemental cooling (spot cooler / fan upgrade)",
    ],
    estResolution: "10-15 min (fan fix) | 1-2 hrs (thermal paste reapply)",
    connectivity: "GPU → PCIe x16 → CPU",
    impact: "CPU (increased PCIe error rate at high temp)",
    impactTone: "#ff8c00",
    selfHealingPhases: [
      {
        component: "GPU",
        interfaceLabel: "Phase 1 - Detection & Thermal Throttle | PCIe Thermal Interface",
        status: "AUTO-HEALED",
        statusBg: "#00c853",
        borderColor: "#ffd700",
        title: "Junction Temp 89°C Detected - Automatic clock throttle engaged",
        steps: [
          "GPU thermal sensor detects junction temp exceeding 85°C TjMax threshold",
          "Driver reduces core clock by 15% and memory clock by 10% automatically",
          "Fan controller ramps all GPU fans to 95% RPM via PWM signal",
          "GPU driver logs thermal event to system log",
        ],
        autoResolution: "< 500ms (throttle) | 2-5 min (temp stabilization)",
        connectivity: "GPU → PCIe x16 → CPU",
        impact: "CPU (reduced PCIe throughput)",
      },
      {
        component: "Thermal Controller",
        interfaceLabel: "Phase 2 - Sustained Overheat | Cooling Subsystem",
        status: "FAILOVER",
        statusBg: "#0066ff",
        borderColor: "#0066ff",
        title: "Persistent Thermal Pressure - Workload migration + cooling escalation",
        steps: [
          "GPU scheduler migrates non-critical compute tasks to CPU or secondary GPU",
          "System controller escalates chassis fan curve - all system fans increase to maximum RPM",
          "If temp exceeds 95°C, GPU initiates emergency shutdown to prevent damage",
          "Maintenance alert generated - physical inspection and thermal paste replacement flagged",
        ],
        autoResolution: "10-30 sec (workload shift) | Manual thermal maintenance required",
        connectivity: "GPU → PCIe x16 → CPU",
        impact: "IO Controller (PCIe bandwidth drop)",
      },
    ],
  },
};

export const resolvedLogEntries = {
  RAM: {
    status: "RESOLVED",
    title: "ECC Correctable Error - DIMM A2",
    summary:
      "Correctable single-bit ECC error auto-corrected by memory controller. No data loss detected.",
    detected: "1 hr ago",
    details:
      "Channel B resumed stable operation after automatic correction. DIMM telemetry indicates normal thermals and no repeated fault pattern.",
  },
  NIC: {
    status: "RESOLVED",
    title: "Link Flap Recovery - Port 1",
    summary:
      "Transient link flap recovered by auto-negotiation and PHY re-synchronization at full 25GbE speed.",
    detected: "3 hr ago",
    details:
      "No further packet loss spikes observed. Interface remains stable with normal error counters and healthy optical metrics.",
  },
};
