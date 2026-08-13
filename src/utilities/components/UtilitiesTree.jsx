/**
 * Left-side expand/collapse Utilities tree.
 */

import { useState } from "react";
import { HardwareIcon } from "../../components/ui/HardwareIcon";
import { UTILITIES_TREE } from "../tree";

export function UtilitiesTree({ selectedId, onSelect }) {
  const [expanded, setExpanded] = useState(() =>
    Object.fromEntries(UTILITIES_TREE.map((c) => [c.id, true]))
  );

  const toggle = (id) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <nav
      className="flex h-full w-full flex-col overflow-y-auto border-r px-2 py-3"
      style={{
        width: 260,
        minWidth: 240,
        background: "rgba(6, 10, 16, 0.92)",
        borderColor: "rgba(34, 211, 238, 0.1)",
      }}
    >
      <div className="mb-3 px-2">
        <div className="font-display text-xs font-semibold uppercase tracking-[0.16em] text-[#64748b]">
          Utilities
        </div>
      </div>

      {UTILITIES_TREE.map((cat) => {
        const open = expanded[cat.id] !== false;
        return (
          <div key={cat.id} className="mb-1">
            <button
              type="button"
              onClick={() => toggle(cat.id)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-medium text-[#94a3b8] hover:bg-white/5"
            >
              <span className="font-mono-metrics text-[10px] text-[#475569]">{open ? "▾" : "▸"}</span>
              <HardwareIcon name={cat.icon} size={14} />
              <span>{cat.label}</span>
            </button>
            {open && (
              <ul className="ml-2 space-y-0.5 border-l pl-2" style={{ borderColor: "rgba(34,211,238,0.08)" }}>
                {cat.children.map((item) => {
                  const active = selectedId === item.id;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(item.id)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors ${
                          active
                            ? "bg-[rgba(34,211,238,0.12)] text-[#f1f5f9]"
                            : "text-[#94a3b8] hover:bg-white/5 hover:text-[#e2e8f0]"
                        }`}
                        style={
                          active
                            ? { borderLeft: "2px solid #22d3ee" }
                            : { borderLeft: "2px solid transparent" }
                        }
                      >
                        <HardwareIcon name={item.icon} size={13} style={{ opacity: active ? 1 : 0.65 }} />
                        <span className="leading-snug">{item.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
