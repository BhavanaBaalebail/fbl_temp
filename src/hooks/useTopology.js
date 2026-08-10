/**
 * useTopology Hook
 * Manages topology/connectivity data and component selection.
 * Enriches center node labels with live inventory when available.
 */

import { useState, useMemo } from "react";
import { buildStarTopologyLinks } from "../data/topologyData";

const DEFAULT_CENTER_NODES = {
  CPU: { label: "CPU", subtitle: "Central Processing Unit" },
  GPU: { label: "GPU", subtitle: "Graphics Processing Unit" },
  RAM: { label: "RAM", subtitle: "DDR5 / DDR4 Memory" },
  DISK: { label: "DISK", subtitle: "Storage SSD / NVMe / HDD" },
  NIC: { label: "NIC", subtitle: "Network Interface Card" },
  "IO Controller": { label: "IO Controller", subtitle: "Platform Controller Hub" },
};

export function useTopology(topologyContext = null) {
  const [activeComponent, setActiveComponent] = useState("CPU");

  const showingIOCTRL = activeComponent === "IO Controller";
  const showingNIC = activeComponent === "NIC";
  const showingDISK = activeComponent === "DISK";
  const showingRAM = activeComponent === "RAM";
  const showingGPU = activeComponent === "GPU";
  const showingCPU =
    !showingIOCTRL &&
    !showingNIC &&
    !showingDISK &&
    !showingRAM &&
    !showingGPU;

  const links = useMemo(
    () => buildStarTopologyLinks(activeComponent),
    [activeComponent]
  );

  const centerNode = useMemo(() => {
    const defaults = DEFAULT_CENTER_NODES[activeComponent] || DEFAULT_CENTER_NODES.CPU;
    const live = topologyContext?.[activeComponent];

    if (!live) return defaults;

    return {
      label: defaults.label,
      subtitle: live.subtitle || defaults.subtitle,
      detail: live.detail,
    };
  }, [activeComponent, topologyContext]);

  return {
    activeComponent,
    setActiveComponent,
    showingIOCTRL,
    showingNIC,
    showingDISK,
    showingRAM,
    showingGPU,
    showingCPU,
    links,
    centerNode,
  };
}
