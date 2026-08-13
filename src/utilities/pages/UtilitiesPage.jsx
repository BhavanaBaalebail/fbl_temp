/**
 * Utilities tab — left tree + selected utility workspace.
 */

import { useState } from "react";
import { HardwareIcon } from "../../components/ui/HardwareIcon";
import { UtilitiesTree } from "../components/UtilitiesTree";
import { UtilityWorkspace } from "./UtilityWorkspace";
import { findUtilityMeta } from "../tree";

export function UtilitiesPage({ onOpenReports }) {
  const [selectedId, setSelectedId] = useState("server-uptime");
  const meta = findUtilityMeta(selectedId);

  return (
    <div className="relative flex h-full min-h-0 w-full overflow-hidden">
      <UtilitiesTree selectedId={selectedId} onSelect={setSelectedId} />

      <div className="min-w-0 flex-1 overflow-auto">
        <div className="p-3 sm:p-4 lg:p-5">
          <header className="mb-2.5 flex items-center gap-2.5">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
              style={{
                background: "rgba(34, 211, 238, 0.08)",
                border: "1px solid rgba(34, 211, 238, 0.15)",
              }}
            >
              <HardwareIcon name={meta?.icon || "diagnostics"} size={16} />
            </div>
            <div className="min-w-0">
              <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
                Utilities{meta?.category ? ` · ${meta.category}` : ""}
              </p>
              <h1 className="font-display text-base font-bold leading-tight text-[#f1f5f9]">
                {meta?.label || "Utilities"}
              </h1>
            </div>
          </header>

          <UtilityWorkspace utilityId={selectedId} onOpenReports={onOpenReports} />
        </div>
      </div>
    </div>
  );
}
