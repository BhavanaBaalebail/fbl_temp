/**
 * Main App Component
 * Enterprise hardware monitoring shell with PCB-inspired layout
 */

import { useState } from "react";
import { Header } from "./components/layout/Header";
import { Sidebar } from "./components/layout/Sidebar";
import { MetricCard } from "./components/dashboard/MetricCard";
import { SeverityChart } from "./components/dashboard/SeverityChart";
import { ComponentHealthStatus } from "./components/dashboard/ComponentHealth";
import { FaultDetectionTab } from "./components/faults/FaultDetection";
import { ReportsPage } from "./components/reports/ReportsPage";
import { TopologyCanvas } from "./components/connectivity/TopologyCanvas";
import { ChatWidget } from "./components/chatbot/ChatWidget";
import { PcbBackground } from "./components/ui/PcbBackground";
import { BusConnector, StatusBadge } from "./components/ui/HardwareModule";
import { HardwareIcon } from "./components/ui/HardwareIcon";
import { theme } from "./utils/theme";
import {
  statusPillTone,
  cardStatusTone,
  getMapName,
  getMapSubtitle,
  buildComponentHealthMap,
} from "./utils/helpers";
import { useTelemetry } from "./hooks/useTelemetry";
import { useTopology } from "./hooks/useTopology";
import { useFaults } from "./hooks/useFaults";

const tabs = ["Dashboard", "Connectivity", "Fault Detection", "Reports"];

function Dashboard({
  metrics,
  health,
  severity,
  stats,
  connected,
  loading,
  lastUpdated,
  hostname,
  error,
  linkHealthSummary,
}) {
  const updatedLabel = lastUpdated
    ? lastUpdated.toLocaleTimeString()
    : loading
      ? "Loading…"
      : "—";

  return (
    <div className="relative space-y-5">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <div
            className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-xl sm:flex"
            style={{
              background: "rgba(34, 211, 238, 0.08)",
              border: "1px solid rgba(34, 211, 238, 0.15)",
            }}
          >
            <HardwareIcon name="server" size={24} />
          </div>
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-[#f1f5f9]">
              Infrastructure Overview
            </h1>
            {hostname && (
              <p className="mt-1 font-mono-metrics text-xs text-[#64748b]">
                {hostname}
                {linkHealthSummary?.overallHealth
                  ? ` · ${linkHealthSummary.overallHealth}`
                  : ""}
                {linkHealthSummary?.score != null
                  ? ` · score ${linkHealthSummary.score}`
                  : ""}
                {" · "}poll 5s
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <StatusBadge
            status={connected ? "healthy" : "critical"}
            label={connected ? "Telemetry Connected" : "Disconnected"}
          />
          <p className="font-mono-metrics text-xs text-[#64748b]">
            Last sync: {updatedLabel}
            {error ? ` · ${error}` : ""}
          </p>
          <a
            href="http://localhost:8000/"
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-[#38bdf8] transition-colors hover:text-[#22d3ee]"
          >
            Open Hardware Monitor ↗
          </a>
        </div>
      </header>

      <BusConnector />

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-4">
        {metrics.map((metric) => (
          <MetricCard key={metric.label} {...metric} />
        ))}
      </section>

      <BusConnector />

      <section className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <SeverityChart data={severity} />
        <ComponentHealthStatus healthRows={health} stats={stats} />
      </section>
    </div>
  );
}

function Connectivity({ topology, health, connected }) {
  const componentHealth = buildComponentHealthMap(health);

  const mapNameText = getMapName({
    showingManagement: topology.showingManagement,
    showingIOCTRL: topology.showingIOCTRL,
    showingNIC: topology.showingNIC,
    showingPSU: topology.showingPSU,
    showingDISK: topology.showingDISK,
    showingRAM: topology.showingRAM,
    showingGPU: topology.showingGPU,
  });

  const mapSubtitleText = getMapSubtitle({
    showingManagement: topology.showingManagement,
    showingIOCTRL: topology.showingIOCTRL,
    showingNIC: topology.showingNIC,
    showingPSU: topology.showingPSU,
    showingDISK: topology.showingDISK,
    showingRAM: topology.showingRAM,
    showingGPU: topology.showingGPU,
  });

  return (
    <div className="relative">
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
            style={{
              background: "rgba(34, 211, 238, 0.08)",
              border: "1px solid rgba(34, 211, 238, 0.15)",
            }}
          >
            <HardwareIcon name="connectivity" size={20} />
          </div>
          <div>
            <h1 className="font-display text-xl font-bold tracking-wide text-[#f1f5f9]">
              {mapNameText}
              <span className="ml-2 text-sm font-normal text-[#64748b]">
                Physical Connectivity Map
              </span>
            </h1>
            <p className="mt-1 text-xs text-[#64748b]">{mapSubtitleText}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <StatusBadge
            status={connected ? "healthy" : "critical"}
            label={connected ? "Telemetry Online" : "Offline"}
          />
          <span
            className="status-badge status-badge-info font-mono-metrics"
          >
            {topology.links.length} links
          </span>
          {topology.centerNode?.detail && (
            <span
              className="rounded-full border px-3 py-1 text-[10px] font-medium text-[#94a3b8]"
              style={{ borderColor: "rgba(34,211,238,0.12)" }}
            >
              {topology.centerNode.detail}
            </span>
          )}
        </div>
      </header>

      <TopologyCanvas
        mapName={mapNameText}
        mapSubtitle={mapSubtitleText}
        centerNode={topology.centerNode}
        links={topology.links}
        showingCPU={topology.showingCPU}
        componentHealth={componentHealth}
      />
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState("Dashboard");
  const telemetry = useTelemetry();
  const topology = useTopology(telemetry.topologyContext);
  const faults = useFaults(telemetry.faults);

  const dashboard = {
    metrics: telemetry.metrics,
    health: telemetry.health,
    severity: telemetry.severity,
    stats: telemetry.stats,
    connected: telemetry.connected,
    loading: telemetry.loading,
    lastUpdated: telemetry.lastUpdated,
    hostname: telemetry.hostname,
    error: telemetry.error,
    linkHealthSummary: telemetry.linkHealthSummary,
  };

  return (
    <div
      className="relative h-screen w-screen overflow-hidden antialiased"
      style={{ backgroundColor: theme.void, fontFamily: theme.fonts?.sans || "IBM Plex Sans, sans-serif" }}
    >
      <PcbBackground />

      <div className="relative z-10 flex h-full flex-col">
        <Header activeTab={activeTab} setActiveTab={setActiveTab} tabs={tabs} />

        <div className="flex min-h-0 flex-1">
          {activeTab === "Connectivity" && (
            <Sidebar
              activeComponent={topology.activeComponent}
              setActiveComponent={topology.setActiveComponent}
            />
          )}

          <main
            className={`relative flex-1 ${
              activeTab === "Reports"
                ? "flex min-h-0 flex-col overflow-hidden p-4 lg:p-5"
                : activeTab === "Fault Detection"
                  ? "overflow-auto px-5 pb-5 pt-3"
                  : "overflow-auto p-6 lg:p-8"
            }`}
          >
            {activeTab === "Dashboard" && <Dashboard {...dashboard} />}
            {activeTab === "Connectivity" && (
              <Connectivity
                topology={topology}
                health={dashboard.health}
                connected={telemetry.connected}
              />
            )}
            {activeTab === "Fault Detection" && (
              <FaultDetectionTab
                faults={faults}
                anomalyCategories={telemetry.anomalyCategories}
                anomalyStats={telemetry.anomalyStats}
                connected={telemetry.connected}
                lastUpdated={telemetry.lastUpdated}
                linkHealthSummary={telemetry.linkHealthSummary}
                statusPillTone={statusPillTone}
                cardStatusTone={cardStatusTone}
              />
            )}
            {activeTab === "Reports" && (
              <ReportsPage connected={telemetry.connected} loading={telemetry.loading} />
            )}
          </main>
        </div>
      </div>

      <ChatWidget />
    </div>
  );
}

export default App;
