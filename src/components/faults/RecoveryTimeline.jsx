/**
 * Recovery Timeline — event log for incident response workflow.
 */

const PANEL = {
  inner: "rgba(8, 12, 18, 0.8)",
  border: "rgba(34, 211, 238, 0.15)",
};

function eventIcon(type) {
  if (type.includes("success") || type === "verification_complete" || type === "command_executed") {
    return "✓";
  }
  if (type.includes("failed") || type === "command_failed") return "✗";
  if (type.includes("confirmed") || type === "user_selected") return "→";
  return "•";
}

export function RecoveryTimeline({ events = [], emptyMessage = "No recovery events yet." }) {
  if (!events.length) {
    return <p className="text-sm text-[#64748b]">{emptyMessage}</p>;
  }

  return (
    <div className="space-y-0">
      {events.map((ev, idx) => (
        <div key={`${ev.timestamp}-${idx}`} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span className="font-mono-metrics text-xs text-[#38bdf8]">{ev.timeLabel || "—"}</span>
            <div className="my-1 h-full w-px flex-1 bg-[#1e293b]" />
          </div>
          <div
            className="mb-3 flex-1 rounded-lg border px-3 py-2"
            style={{ background: PANEL.inner, borderColor: PANEL.border }}
          >
            <div className="flex items-start gap-2">
              <span className="text-[#94a3b8]">{eventIcon(ev.type)}</span>
              <div>
                <p className="text-sm text-[#e2e8f0]">{ev.message}</p>
                {ev.detail && (
                  <p className="mt-1 font-mono-metrics text-[10px] text-[#64748b]">{ev.detail}</p>
                )}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
