/**
 * In-browser fbl-diagnostic terminal.
 * Allowlisted commands only — not a Linux shell.
 */

import { useEffect, useRef, useState } from "react";
import { incidentAnalysisApi } from "../../services/incidentAnalysisApi";

const CLI_TO_ID = {
  analyze: "analyze",
  "health-assess": "health",
  health: "health",
  "unified-rca": "rca",
  rca: "rca",
  forensic: "forensic",
  "stall-capture": "stall",
  stall: "stall",
  pid500: "pid500",
};

const HELP = `FBL Diagnostic CLI (browser)

Not a Linux shell. Only allowlisted incident utilities.

Usage:
  fbl-diagnostic <command>

Commands:
  list                     List available diagnostic utilities
  run <utility>            Execute a diagnostic utility
  stall setup|analyze      Stall capture workflow
  status <execution_id>    Show execution status
  output <execution_id>    Show raw execution output
  history                  Show previous executions
  help                     This message
  clear                    Clear the terminal

Utilities:
  analyze
  health-assess
  unified-rca
  forensic
  stall-capture
  pid500

Examples:
  fbl-diagnostic list
  fbl-diagnostic run analyze
  fbl-diagnostic run unified-rca
  fbl-diagnostic stall setup`;

function tokenize(line) {
  return String(line || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function stripPrefix(tokens) {
  if (!tokens.length) return tokens;
  const first = tokens[0].replace(/^\.\//, "");
  if (first === "fbl-diagnostic") return tokens.slice(1);
  return tokens;
}

async function waitForDone(executionId) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const res = await incidentAnalysisApi.status(executionId);
    const status = res.data?.status;
    if (!res.ok) return res.data;
    if (status && !["QUEUED", "RUNNING"].includes(status)) {
      const full = await incidentAnalysisApi.result(executionId, true);
      return full.ok ? full.data : res.data;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return { status: "TIMEOUT", error: "Timed out waiting for the collector" };
}

function formatRun(record, raw) {
  const lines = [];
  if (record.demo) lines.push("DEMO MODE", "Simulated output. This is not live server evidence.", "");
  if (record.utility_id === "rca") {
    const parsed = record.parsed || {};
    lines.push("UNIFIED ROOT CAUSE ANALYSIS", "────────────────────────────────────────────", "");
    lines.push("Primary Root Cause:");
    lines.push(parsed.insufficient || !parsed.primary_root_cause ? "INSUFFICIENT EVIDENCE" : parsed.primary_root_cause);
    if ((parsed.evidence || []).length) {
      lines.push("", "Detected Conditions:");
      parsed.evidence.forEach((item) => lines.push(`✓ ${item}`));
    }
    lines.push("", "Raw Output:", raw || "(empty)", "", "────────────────────────────────────────────");
  } else {
    lines.push(raw || "(no stdout)", "", "────────────────────────────────────────────");
  }
  lines.push("", `Status: ${record.status || "FAILED"}`);
  if (record.error && record.status !== "COMPLETED") lines.push(record.error);
  lines.push(`Exit Code: ${record.exit_code ?? "—"}`);
  lines.push("", "Output:", ` ${record.output_location || "None"}`);
  lines.push("", "Reports:", ` ${record.html_report_location || "None"}`);
  lines.push("", "Execution ID:", ` ${record.execution_id || "—"}`);
  return lines.join("\n");
}

async function dispatch(tokens, incidentId) {
  const cmd = (tokens[0] || "").toLowerCase();
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return HELP;

  if (cmd === "list") {
    const res = await incidentAnalysisApi.utilities();
    if (!res.ok) return `FAILED\n${res.data?.error || "backend unavailable"}`;
    const rows = [
      "FBL Incident Analysis Utilities",
      "────────────────────────────────────────────",
      "",
      "NAME             SCRIPT                    STATUS",
      "",
    ];
    for (const u of res.data.utilities || []) {
      const name =
        Object.keys(CLI_TO_ID).find((k) => CLI_TO_ID[k] === u.id && k.includes("-")) ||
        Object.keys(CLI_TO_ID).find((k) => CLI_TO_ID[k] === u.id) ||
        u.id;
      const status = u.script_configured ? "AVAILABLE" : "MISSING";
      rows.push(`${String(name).padEnd(17)}${String(u.script_name).padEnd(26)}${status}`);
    }
    return rows.join("\n");
  }

  if (cmd === "run") {
    const alias = (tokens[1] || "").toLowerCase();
    const uid = CLI_TO_ID[alias];
    if (!uid) {
      return "FAILED\nUnknown utility. Allowlist: analyze, health-assess, unified-rca, forensic, stall-capture, pid500";
    }
    const started = await incidentAnalysisApi.run(uid, {
      incident_id: incidentId,
      fault_id: incidentId,
    });
    if (!started.ok) return `FAILED\n${started.data?.error || "Unable to start analysis"}`;
    const done = await waitForDone(started.data.execution_id);
    const raw = await incidentAnalysisApi.raw(done.execution_id);
    return formatRun(done, raw.text);
  }

  if (cmd === "stall") {
    const action = (tokens[1] || "").toLowerCase();
    if (action !== "setup" && action !== "analyze") {
      return "Usage:\n  fbl-diagnostic stall setup     # prepares stall capture\n  fbl-diagnostic stall analyze   # analyzes captured stall data";
    }
    const uid = action === "setup" ? "stall" : "stall_analyze";
    const started = await incidentAnalysisApi.run(uid, {
      incident_id: incidentId,
      fault_id: incidentId,
    });
    if (!started.ok) return `FAILED\n${started.data?.error || "Unable to start analysis"}`;
    const done = await waitForDone(started.data.execution_id);
    const raw = await incidentAnalysisApi.raw(done.execution_id);
    return formatRun(done, raw.text);
  }

  if (cmd === "status") {
    const id = tokens[1];
    if (!id) return "Usage: fbl-diagnostic status <execution_id>";
    const res = await incidentAnalysisApi.status(id);
    if (!res.ok) return `FAILED\n${res.data?.error || "Execution not found"}`;
    const d = res.data;
    return [
      "Execution Details",
      "────────────────────────────────────────",
      "",
      `Execution ID:\n${d.execution_id}`,
      "",
      `Utility:\n${d.utility || d.utility_id}`,
      "",
      `Status:\n${d.status}`,
      "",
      `Started:\n${d.started_at || "—"}`,
      "",
      `Completed:\n${d.completed_at || "—"}`,
      "",
      `Exit Code:\n${d.exit_code}`,
      "",
      `Output:\n ${d.output_location || "None"}`,
      "",
      `HTML:\n ${d.html_report_location || "None"}`,
    ].join("\n");
  }

  if (cmd === "output") {
    const id = tokens[1];
    if (!id) return "Usage: fbl-diagnostic output <execution_id> [--tail N]";
    const tailIdx = tokens.indexOf("--tail");
    const raw = await incidentAnalysisApi.raw(id);
    if (!raw.ok) return `FAILED\n${raw.text}`;
    let text = raw.text || "";
    if (tailIdx >= 0 && tokens[tailIdx + 1]) {
      const n = Number(tokens[tailIdx + 1]);
      if (Number.isFinite(n) && n > 0) {
        text = text.split("\n").slice(-n).join("\n");
      }
    }
    return text || "(empty)";
  }

  if (cmd === "history") {
    const res = await incidentAnalysisApi.history(incidentId);
    if (!res.ok) return `FAILED\n${res.data?.error || "backend unavailable"}`;
    const lines = [
      "FBL Incident Analysis History",
      "────────────────────────────────────────────────────────────",
      "",
      "TIME               UTILITY          STATUS",
      "",
    ];
    for (const row of res.data.history || []) {
      const t = row.started_at ? new Date(row.started_at).toLocaleTimeString() : "—";
      lines.push(`${String(t).padEnd(19)}${String(row.utility_id || "").padEnd(17)}${row.status || "—"}`);
    }
    if ((res.data.history || []).length === 0) lines.push("(no executions recorded)");
    return lines.join("\n");
  }

  if (cmd === "report") {
    const id = tokens[1];
    if (!id) return "Usage: fbl-diagnostic report <execution_id>";
    const res = await incidentAnalysisApi.status(id);
    if (!res.ok) return `FAILED\n${res.data?.error || "Execution not found"}`;
    if (!res.data.html_report_location) return "No HTML report is registered for this execution.";
    return `HTML Report Found\n\nExecution:\n${id}\n\nReport:\n ${res.data.html_report_location}\n\nOpen from the utility card: Open HTML Report`;
  }

  return `FAILED\nUnknown command '${cmd}'. Type help. This CLI cannot run arbitrary shell commands.`;
}

export function IncidentDiagnosticCli({ incidentId }) {
  const [lines, setLines] = useState([
    { type: "sys", text: "FBL Diagnostic CLI — test the six incident scripts from the UI." },
    { type: "sys", text: "This is not a Linux shell. Type help or list." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef(null);
  const field = useRef(null);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lines, busy]);

  const runLine = async (rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed || busy) return;
    if (trimmed === "clear") {
      setLines([]);
      setInput("");
      return;
    }
    const tokens = stripPrefix(tokenize(trimmed));
    setLines((prev) => [...prev, { type: "cmd", text: `$ ${trimmed}` }]);
    setInput("");
    setBusy(true);
    try {
      const out = await dispatch(tokens, incidentId);
      setLines((prev) => [...prev, { type: "out", text: out }]);
    } catch (err) {
      setLines((prev) => [...prev, { type: "err", text: String(err?.message || err) }]);
    } finally {
      setBusy(false);
      field.current?.focus();
    }
  };

  const chips = ["help", "list", "run analyze", "run health-assess", "run unified-rca", "stall setup"];

  return (
    <section
      className="overflow-hidden rounded-lg border"
      style={{
        background: "rgba(6, 10, 16, 0.96)",
        borderColor: "rgba(34, 211, 238, 0.22)",
      }}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: "rgba(34,211,238,0.12)" }}>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#67e8f9]">
            Diagnostic CLI
          </div>
          <p className="text-[11px] text-[#64748b]">
            In-browser fbl-diagnostic for script testing. Same allowlist as the cards below.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              disabled={busy}
              onClick={() => runLine(`fbl-diagnostic ${chip}`)}
              className="rounded border px-2 py-0.5 font-mono-metrics text-[10px] text-[#94a3b8] hover:text-[#67e8f9] disabled:opacity-40"
              style={{ borderColor: "rgba(34,211,238,0.2)" }}
            >
              {chip}
            </button>
          ))}
        </div>
      </header>
      <div
        ref={scroller}
        className="max-h-[280px] overflow-y-auto px-3 py-2 font-mono-metrics text-[11px] leading-relaxed"
        onClick={() => field.current?.focus()}
      >
        {lines.map((row, idx) => (
          <pre
            key={`${idx}-${row.type}`}
            className={`whitespace-pre-wrap break-words ${
              row.type === "cmd"
                ? "text-[#67e8f9]"
                : row.type === "err"
                  ? "text-[#f87171]"
                  : row.type === "sys"
                    ? "text-[#64748b]"
                    : "text-[#cbd5e1]"
            }`}
          >
            {row.text}
          </pre>
        ))}
        {busy ? <p className="text-[#fbbf24]">RUNNING…</p> : null}
      </div>
      <form
        className="flex items-center gap-2 border-t px-3 py-2"
        style={{ borderColor: "rgba(34,211,238,0.12)" }}
        onSubmit={(e) => {
          e.preventDefault();
          runLine(input);
        }}
      >
        <span className="shrink-0 text-[11px] text-[#67e8f9]">fbl-diagnostic $</span>
        <input
          ref={field}
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          placeholder="list   |   run analyze   |   help"
          className="min-w-0 flex-1 bg-transparent font-mono-metrics text-[12px] text-[#f1f5f9] outline-none placeholder:text-[#475569]"
          autoComplete="off"
          spellCheck={false}
        />
      </form>
    </section>
  );
}
