/**
 * Digital Twin panel — detection, candidates, and simulation preview
 * inside the Self Healing (Recovery Console) flow. Execution is disabled
 * during this integration phase.
 */

import { useState } from "react";
import { StatusBadge } from "../ui/HardwareModule";
import {
  buildSimulatePayload,
  formatDigitalTwinDomain,
  listPressuredDomains,
  simulateDigitalTwinAction,
} from "../../recovery/digitalTwinApiService";

const PANEL = {
  bg: "rgba(12, 18, 28, 0.95)",
  border: "rgba(34, 211, 238, 0.15)",
  inner: "rgba(8, 12, 18, 0.8)",
  predict: "rgba(168, 85, 247, 0.12)",
  predictBorder: "rgba(168, 85, 247, 0.35)",
};

function SectionHeader({ title, subtitle }) {
  return (
    <div className="mb-3">
      <h3 className="font-display text-sm font-semibold uppercase tracking-[0.12em] text-[#94a3b8]">
        {title}
      </h3>
      {subtitle && <p className="mt-0.5 text-xs text-[#64748b]">{subtitle}</p>}
    </div>
  );
}

function MetricCell({ label, value }) {
  return (
    <div
      className="rounded-lg border px-3 py-2"
      style={{ background: PANEL.inner, borderColor: PANEL.border }}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
        {label}
      </div>
      <div className="mt-1 break-words font-mono-metrics text-sm text-[#f1f5f9]">
        {value ?? "—"}
      </div>
    </div>
  );
}

function riskBadgeStatus(risk) {
  if (risk === "LOW") return "healthy";
  if (risk === "MEDIUM") return "warning";
  if (risk === "HIGH") return "critical";
  return "info";
}

function formatStateBlock(state, title) {
  if (!state || typeof state !== "object") return null;
  const entries = Object.entries(state).filter(
    ([key, val]) => key !== "label" && val != null && val !== ""
  );
  if (entries.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
        {title}
        {state.label ? ` (${state.label})` : ""}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {entries.map(([key, val]) => (
          <MetricCell key={key} label={key.replace(/_/g, " ")} value={String(val)} />
        ))}
      </div>
    </div>
  );
}

function formatTime(d) {
  if (!d) return "—";
  return d.toLocaleTimeString();
}

export function DigitalTwinPanel({
  pressure,
  stateSummary,
  candidates = [],
  candidateMessage,
  available,
  loading,
  error,
  lastUpdated,
}) {
  const [selectedId, setSelectedId] = useState(null);
  const [simulating, setSimulating] = useState(false);
  const [simulation, setSimulation] = useState(null);
  const [simulateError, setSimulateError] = useState(null);

  const pressured = listPressuredDomains(pressure);
  const primaryDomain = pressured[0];

  const handleSimulate = async (candidate, index) => {
    setSelectedId(index);
    setSimulating(true);
    setSimulateError(null);
    setSimulation(null);
    try {
      const payload = buildSimulatePayload(candidate);
      const result = await simulateDigitalTwinAction(payload);
      setSimulation(result);
    } catch (err) {
      setSimulateError(err.message || "Simulation failed");
    } finally {
      setSimulating(false);
    }
  };

  const statusBadge = !available
    ? { status: "critical", label: "Backend Unavailable" }
    : loading && !pressure
      ? { status: "info", label: "Connecting…" }
      : pressure?.has_problem
        ? { status: "warning", label: "Problem Detected" }
        : { status: "healthy", label: "Monitoring" };

  return (
    <section
      className="rounded-xl border p-4"
      style={{ background: PANEL.bg, borderColor: PANEL.border }}
    >
      <SectionHeader
        title="Digital Twin"
        subtitle="Live pressure detection & simulated recovery from Ubuntu CM.py · 5s refresh"
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusBadge status={statusBadge.status} label={statusBadge.label} />
        {available && lastUpdated && (
          <span className="font-mono-metrics text-[10px] text-[#64748b]">
            Updated {formatTime(lastUpdated)}
          </span>
        )}
      </div>

      {!available && (
        <p className="text-sm text-[#f59e0b]">
          {error || "Disconnected — Digital Twin backend unreachable. Self Healing continues normally."}
        </p>
      )}

      {available && loading && !pressure && (
        <p className="text-sm text-[#64748b]">Loading Digital Twin state…</p>
      )}

      {available && error && pressure && (
        <p className="mb-2 text-xs text-[#f59e0b]">{error}</p>
      )}

      {available && pressure && !pressure.has_problem && (
        <div className="space-y-2">
          <p className="text-sm text-[#94a3b8]">
            No domain pressure detected. Digital Twin is monitoring CPU, RAM, Disk, NIC, I/O Controller, and GPU.
          </p>
          {stateSummary && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {stateSummary.cpu_percent != null && (
                <MetricCell label="CPU" value={`${stateSummary.cpu_percent}%`} />
              )}
              {stateSummary.ram_percent != null && (
                <MetricCell label="RAM" value={`${stateSummary.ram_percent}%`} />
              )}
              {stateSummary.disk_percent != null && (
                <MetricCell label="Disk" value={`${stateSummary.disk_percent}%`} />
              )}
              {stateSummary.net_rx_mb_s != null && (
                <MetricCell label="Net RX" value={`${stateSummary.net_rx_mb_s} MB/s`} />
              )}
            </div>
          )}
        </div>
      )}

      {available && pressure?.has_problem && (
        <div className="space-y-4">
          <div
            className="rounded-lg border px-3 py-3"
            style={{ background: PANEL.inner, borderColor: "rgba(245, 158, 11, 0.25)" }}
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
              Status
            </div>
            <p className="mt-1 text-sm font-medium text-[#f59e0b]">Problem detected</p>
            {primaryDomain && (
              <>
                <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
                  Domain
                </div>
                <p className="text-sm text-[#e2e8f0]">{primaryDomain.label}</p>
                <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
                  Reason
                </div>
                <p className="text-sm leading-relaxed text-[#94a3b8]">{primaryDomain.reason}</p>
              </>
            )}
            {pressured.length > 1 && (
              <ul className="mt-2 space-y-1">
                {pressured.slice(1).map((d) => (
                  <li key={d.key} className="text-xs text-[#64748b]">
                    · {d.label}: {d.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">
              Recovery Candidates
            </div>
            {candidates.length === 0 ? (
              <p className="text-sm text-[#64748b]">
                {candidateMessage || "No simulated recovery candidates returned for the pressured domain(s)."}
              </p>
            ) : (
              <div className="space-y-2">
                {candidates.map((c, index) => {
                  const target = c.target_process || c.target_name || "—";
                  const isSelected = selectedId === index;
                  return (
                    <article
                      key={`${c.domain}-${c.action}-${c.target_pid ?? c.target_name ?? index}`}
                      className="rounded-lg border px-3 py-3"
                      style={{
                        background: PANEL.inner,
                        borderColor: isSelected ? "rgba(34, 211, 238, 0.35)" : PANEL.border,
                      }}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-[#e2e8f0]">
                              {c.action}
                            </span>
                            <StatusBadge
                              status="info"
                              label={formatDigitalTwinDomain(c.domain)}
                              showDot={false}
                            />
                            {c.risk && (
                              <StatusBadge
                                status={riskBadgeStatus(c.risk)}
                                label={`Risk ${c.risk}`}
                                showDot={false}
                              />
                            )}
                          </div>
                          <p className="mt-1 text-xs text-[#64748b]">
                            Target: {target}
                            {c.target_pid != null ? ` · PID ${c.target_pid}` : ""}
                          </p>
                          {c.explanation && (
                            <p className="mt-2 text-xs leading-relaxed text-[#94a3b8]">{c.explanation}</p>
                          )}
                          {Array.isArray(c.warnings) && c.warnings.length > 0 && (
                            <ul className="mt-1 space-y-0.5">
                              {c.warnings.map((w) => (
                                <li key={w} className="text-[10px] text-[#f59e0b]">
                                  · {w}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-2">
                          {c.confidence_percent != null && (
                            <span className="font-mono-metrics text-xs text-[#64748b]">
                              {c.confidence_percent}% conf.
                            </span>
                          )}
                          {c.expected_improvement_percent != null && (
                            <span className="font-mono-metrics text-[10px] text-[#64748b]">
                              Δ {c.expected_improvement_percent > 0 ? "+" : ""}
                              {c.expected_improvement_percent}%
                            </span>
                          )}
                          <button
                            type="button"
                            className="hw-btn-filter px-3 py-1 text-xs disabled:opacity-40"
                            disabled={simulating}
                            onClick={() => handleSimulate(c, index)}
                          >
                            {simulating && isSelected ? "Simulating…" : "Simulate"}
                          </button>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {c.reversible != null && (
                          <StatusBadge
                            status={c.reversible ? "healthy" : "warning"}
                            label={c.reversible ? "Reversible" : "Not reversible"}
                            showDot={false}
                          />
                        )}
                        {c.requires_approval && (
                          <StatusBadge status="warning" label="Requires approval" showDot={false} />
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {simulateError && (
        <p className="mt-3 text-sm text-[#ef4444]">{simulateError}</p>
      )}

      {simulation && (
        <div
          className="mt-4 rounded-lg border p-4"
          style={{ background: PANEL.predict, borderColor: PANEL.predictBorder }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status="info" label="SIMULATION / PREDICTION" showDot={false} />
            <span className="text-xs text-[#c4b5fd]">
              Not executed — hypothetical outcome only
            </span>
            {simulation.simulation_id != null && (
              <span className="font-mono-metrics text-[10px] text-[#64748b]">
                ID {simulation.simulation_id}
              </span>
            )}
          </div>
          {simulation.explanation && (
            <p className="mt-2 text-sm leading-relaxed text-[#cbd5e1]">{simulation.explanation}</p>
          )}
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {simulation.confidence_percent != null && (
              <MetricCell label="Confidence" value={`${simulation.confidence_percent}%`} />
            )}
            {simulation.expected_improvement_percent != null && (
              <MetricCell
                label="Expected improvement"
                value={`${simulation.expected_improvement_percent}%`}
              />
            )}
            {simulation.risk && <MetricCell label="Risk" value={simulation.risk} />}
            {simulation.reversible != null && (
              <MetricCell label="Reversible" value={simulation.reversible ? "Yes" : "No"} />
            )}
          </div>
          {formatStateBlock(simulation.current_state, "Current state")}
          {formatStateBlock(simulation.predicted_state, "Predicted state")}
          {Array.isArray(simulation.warnings) && simulation.warnings.length > 0 && (
            <ul className="mt-3 space-y-1">
              {simulation.warnings.map((w) => (
                <li key={w} className="text-xs text-[#f59e0b]">
                  · {w}
                </li>
              ))}
            </ul>
          )}
          {simulation.requires_approval && (
            <div className="mt-4 rounded-lg border px-3 py-2" style={{ borderColor: PANEL.border }}>
              <p className="text-xs text-[#64748b]">
                This action would require operator approval before real execution.
              </p>
              <button
                type="button"
                className="mt-2 hw-btn-primary px-4 py-2 text-sm opacity-40 cursor-not-allowed"
                disabled
                title="Real execution disabled during Digital Twin integration verification"
              >
                Execute Recovery (disabled)
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
