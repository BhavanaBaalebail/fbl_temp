/**
 * Header Component — enterprise hardware monitoring navigation
 */

import { HardwareIcon } from "../ui/HardwareIcon";
import { theme } from "../../utils/theme";

const TAB_ICONS = {
  Dashboard: "dashboard",
  Connectivity: "connectivity",
  "Fault Detection": "fault",
  Utilities: "diagnostics",
  Reports: "report",
};

export function Header({ activeTab, setActiveTab, tabs }) {
  return (
    <header
      className="relative z-20 flex h-[56px] items-center justify-between border-b px-6"
      style={{
        background: theme.headerGradient,
        borderBottomColor: "rgba(34, 211, 238, 0.12)",
        backdropFilter: "blur(12px)",
      }}
    >
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px"
        style={{
          background: `linear-gradient(90deg, transparent, ${theme.cyan} 40%, ${theme.blue} 60%, transparent)`,
          opacity: 0.6,
        }}
      />

      <div className="flex items-center gap-3">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-lg"
          style={{
            background: "rgba(34, 211, 238, 0.1)",
            border: "1px solid rgba(34, 211, 238, 0.25)",
            boxShadow: "0 0 16px rgba(34, 211, 238, 0.12)",
          }}
        >
          <HardwareIcon name="motherboard" size={18} />
        </div>
        <div>
          <div className="font-display text-sm font-bold tracking-[0.08em] text-[#f1f5f9]">
            FRAMEWORK BLOCK LEDGER
          </div>
          <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-[#64748b]">
            AI Hardware Monitoring Platform
          </div>
        </div>
      </div>

      <nav className="flex items-center gap-1">
        {tabs.map((tab) => {
          const isActive = tab === activeTab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`hw-nav-tab flex items-center gap-2 px-4 ${isActive ? "hw-nav-tab-active" : ""}`}
            >
              <HardwareIcon name={TAB_ICONS[tab] || "diagnostics"} size={14} style={{ opacity: isActive ? 1 : 0.6 }} />
              {tab}
            </button>
          );
        })}
      </nav>

      <div className="flex items-center gap-3">
        <div className="hidden items-center gap-2 sm:flex">
          <span className="status-dot-glow status-dot-glow-healthy" />
          <span className="text-[11px] font-medium uppercase tracking-wider text-[#64748b]">
            System Online
          </span>
        </div>
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/5"
        >
          <span
            className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold text-[#f1f5f9]"
            style={{
              background: "linear-gradient(145deg, rgba(8,145,178,0.6), rgba(34,211,238,0.3))",
              border: "1px solid rgba(34, 211, 238, 0.3)",
            }}
          >
            AD
          </span>
          <span className="text-xs font-medium text-[#94a3b8]">Admin</span>
        </button>
      </div>
    </header>
  );
}
