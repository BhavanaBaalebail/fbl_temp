/**
 * Sidebar Component — hardware component bus navigator
 */

import { sidebarComponents } from "../../data/sidebarData";
import { HardwareIcon, getComponentIcon } from "../ui/HardwareIcon";
import { HardwareModule } from "../ui/HardwareModule";
import { LinkStatusLegend } from "../ui/LinkStatusIndicator";
import { theme } from "../../utils/theme";

export function Sidebar({ activeComponent, setActiveComponent }) {
  return (
    <aside
      className="relative z-10 flex w-[248px] flex-col border-r px-3 py-4"
      style={{
        background: theme.sidebarGradient,
        borderRightColor: "rgba(34, 211, 238, 0.1)",
        backdropFilter: "blur(8px)",
      }}
    >
      <div
        className="pointer-events-none absolute inset-y-0 right-0 w-px"
        style={{
          background: "linear-gradient(180deg, transparent, rgba(34,211,238,0.2), transparent)",
        }}
      />

      <div className="mb-4 flex items-center gap-2 px-2">
        <HardwareIcon name="PCIe" size={16} />
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#64748b]">
          Component Bus
        </span>
      </div>

      <div className="space-y-0.5">
        {sidebarComponents.map((component) => {
          const isActive = component.id === activeComponent;
          const statusColor =
            component.status === "amber" ? theme.warning : theme.healthy;

          return (
            <button
              key={component.id}
              type="button"
              onClick={() => setActiveComponent(component.id)}
              className={`component-row flex w-full items-center justify-between px-3 py-2.5 text-sm ${
                isActive ? "component-row-active" : ""
              }`}
            >
              <span className="flex items-center gap-2.5">
                <HardwareIcon
                  name={getComponentIcon(component.id)}
                  size={16}
                  style={{ opacity: isActive ? 1 : 0.55 }}
                />
                <span
                  className={
                    isActive
                      ? "font-semibold text-[#f1f5f9]"
                      : "font-medium text-[#94a3b8]"
                  }
                >
                  {component.label}
                </span>
              </span>

              <span
                className="status-dot inline-block h-2 w-2 rounded-full"
                style={{
                  backgroundColor: statusColor,
                  boxShadow: `0 0 8px ${statusColor}`,
                }}
              />
            </button>
          );
        })}
      </div>

      <div className="mt-auto pt-4">
        <HardwareModule className="!p-3" icon="busStatus" title="Bus Status" noPadding>
          <div className="mt-2 space-y-2 text-[11px] font-medium">
            <LinkStatusLegend level="healthy" label="PCIe lanes nominal" compact />
            <div className="flex items-center gap-2 text-[#64748b]">
              <HardwareIcon name="connectivity" size={14} style={{ color: theme.unknown, opacity: 0.7 }} />
              6 components mapped
            </div>
          </div>
        </HardwareModule>
      </div>
    </aside>
  );
}
