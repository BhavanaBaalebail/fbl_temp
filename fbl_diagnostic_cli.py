#!/usr/bin/env python3
"""
fbl-diagnostic — CLI for Incident Analysis Utilities.

Uses the same fbl_incident_analysis.execute_utility() path as the FBL web UI.
Does not accept arbitrary shell commands.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import fbl_incident_analysis as ia

RULE = "────────────────────────────────────────────"
RULE_WIDE = "────────────────────────────────────────────────────────────"

CLI_ROWS = [
    ("analyze", "analyze", "Analyze.sh", "System health analysis"),
    ("health-assess", "health", "Health_Assess.sh", "System + network + application assessment"),
    ("unified-rca", "rca", "Unified_RCA.sh", "Root cause analysis"),
    ("forensic", "forensic", "ForensicV1.sh", "Process + infrastructure forensics"),
    ("stall-capture", "stall", "Stall_Capture_setup.sh", "Server stall investigation"),
    ("pid500", "pid500", "Pid500.sh", ">500% CPU process capture"),
]


def _operator() -> str:
    return (os.environ.get("USER") or os.environ.get("LOGNAME") or "cli")[:80]


def _duration_seconds(record: dict[str, Any]) -> Optional[float]:
    start = record.get("started_at_epoch")
    end = record.get("completed_at_epoch")
    if start and end:
        try:
            return max(0.0, float(end) - float(start))
        except (TypeError, ValueError):
            return None
    return None


def _fmt_local(iso_or_epoch: Any) -> str:
    if iso_or_epoch is None:
        return "—"
    if isinstance(iso_or_epoch, (int, float)):
        return datetime.fromtimestamp(float(iso_or_epoch)).strftime("%Y-%m-%d %H:%M:%S")
    text = str(iso_or_epoch)
    try:
        if text.endswith("Z"):
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
            return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S")
        return datetime.fromisoformat(text).strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return text


def _raw_text(record: dict[str, Any]) -> str:
    loc = record.get("output_location")
    if loc:
        path = Path(loc)
        if path.is_file() and ia.is_safe_output_path(path):
            return path.read_text(encoding="utf-8", errors="replace")
    return str(record.get("raw_output") or "")


def _tail_text(text: str, n: int) -> str:
    lines = text.splitlines()
    if n <= 0 or len(lines) <= n:
        return text
    return "\n".join(lines[-n:]) + "\n"


def cmd_list(_args: argparse.Namespace) -> int:
    print("FBL Incident Analysis Utilities")
    print(RULE)
    print()
    print(f"{'NAME':<16} {'SCRIPT':<26} {'PURPOSE'}")
    print()
    for cli_name, uid, script, purpose in CLI_ROWS:
        print(f"{cli_name:<16} {script:<26} {purpose}")
    print()
    print(f"{'NAME':<16} STATUS")
    print()
    for cli_name, uid, _script, _purpose in CLI_ROWS:
        avail = ia.script_availability(uid)
        print(f"{cli_name:<16} {avail['status']}")
        if avail.get("path"):
            print(f"{'':16} {avail['path']}")
    stall_a = ia.script_availability("stall_analyze")
    print()
    print("stall analyze     (analyze_stall.sh)")
    print(f"{'':16} {stall_a['status']}")
    if stall_a.get("path"):
        print(f"{'':16} {stall_a['path']}")
    print()
    print(f"Scripts directory: {ia._scripts_dir()}")
    return 0


def _print_rca_block(parsed: dict[str, Any], raw: str) -> None:
    print("UNIFIED ROOT CAUSE ANALYSIS")
    print(RULE)
    print()
    primary = parsed.get("primary_root_cause")
    if parsed.get("insufficient") or not primary:
        print("Primary Root Cause:")
        print("INSUFFICIENT EVIDENCE")
    else:
        print("Primary Root Cause:")
        print(primary)
    evidence = parsed.get("evidence") or []
    if evidence:
        print()
        print("Detected Conditions:")
        for item in evidence:
            print(f"✓ {item}")
    print()
    print("Raw Output:")
    print(raw.rstrip() or "(empty)")
    print()
    print(RULE)


def _print_health_paths(record: dict[str, Any], raw: str) -> None:
    html = record.get("html_report_location")
    mentioned = []
    loc = record.get("output_location")
    print("Health Assessment completed." if record.get("status") == "COMPLETED" else "Health Assessment ended.")
    print()
    txt = None
    for match in ia.extract_mentioned_paths(raw):
        mentioned.append(match)
        if match.endswith(".txt"):
            txt = match
        p = Path(match)
        if p.is_dir():
            for child in sorted(p.glob("health_report.txt")):
                txt = str(child)
    print("Text Report:")
    print(f" {txt or loc or 'None'}")
    print()
    print("HTML Report:")
    print(f" {html or 'None'}")


def cmd_run(args: argparse.Namespace) -> int:
    try:
        uid = ia.resolve_cli_name(args.utility)
    except ValueError as exc:
        print(f"FAILED\n{exc}", file=sys.stderr)
        print("Allowlist: analyze, health-assess, unified-rca, forensic, stall-capture, pid500", file=sys.stderr)
        return 2
    if uid == "stall_analyze":
        print("Use: fbl-diagnostic stall analyze", file=sys.stderr)
        return 2

    meta = ia.UTILITY_META[uid]
    avail = ia.script_availability(uid)
    print("FBL Incident Analysis")
    print(RULE)
    print()
    print("Utility:")
    print(meta["script_name"])
    print()
    print("Purpose:")
    print(meta["purpose"])
    print()
    if meta.get("requires_root"):
        print("This utility requires elevated privileges.")
        print("Please run using the approved administrator procedure.")
        print("FBL does not enable passwordless sudo.")
        print()
    if args.demo:
        print("DEMO MODE")
        print("Simulated output requested explicitly. This is not live server evidence.")
        print()
    elif avail["status"] == "MISSING":
        print("Status:")
        print("FAILED")
        print()
        print("FAILED")
        print("Script not found")
        print(f"Looked under: {ia._scripts_dir()}")
        return 1
    elif avail["status"] == "NOT EXECUTABLE":
        print("Note: script is NOT EXECUTABLE; will invoke via bash.")
        print()

    print("Status:")
    print("RUNNING")
    print()
    print(RULE)
    print()

    record = ia.execute_utility(
        uid,
        incident_id=args.incident,
        operator=_operator(),
        force_demo=bool(args.demo),
        wait=True,
        allow_implicit_demo=False,
        include_stall_analyze=False,
    )
    raw = _raw_text(record)
    status = record.get("status") or "FAILED"
    if record.get("demo"):
        print("DEMO MODE — simulated output\n")
    if uid == "rca":
        _print_rca_block(record.get("parsed") or {}, raw)
    elif uid == "health":
        print(raw.rstrip() or "(no stdout)")
        print()
        print(RULE)
        print()
        _print_health_paths(record, raw)
        print()
        print(RULE)
    else:
        print(raw.rstrip() or "(no stdout)")
        print()
        print(RULE)

    dur = _duration_seconds(record)
    print()
    print(f"Status: {status}")
    if record.get("error") and status != "COMPLETED":
        print(record["error"])
        if "permission denied" in str(record.get("error") or "").lower():
            print("FAILED")
            print("Permission denied")
    print(f"Exit Code: {record.get('exit_code')}")
    if dur is not None:
        print(f"Duration: {dur:.1f} seconds")
    print()
    print("Output:")
    print(f" {record.get('output_location') or 'None'}")
    print()
    print("Reports:")
    print(f" {record.get('html_report_location') or 'None'}")
    print()
    print("Execution ID:")
    print(f" {record.get('execution_id')}")
    if record.get("incident_id"):
        print()
        print("Incident ID:")
        print(f" {record.get('incident_id')}")
    return 0 if status == "COMPLETED" else 1


def cmd_stall(args: argparse.Namespace) -> int:
    if args.stall_action == "setup":
        ns = argparse.Namespace(utility="stall-capture", incident=args.incident, demo=args.demo)
        return cmd_run(ns)
    print("FBL Incident Analysis")
    print(RULE)
    print()
    print("Utility:")
    print("analyze_stall.sh")
    print()
    print("Purpose:")
    print("Analyze captured stall data (after setup).")
    print()
    print("setup  → prepares stall capture")
    print("analyze → analyzes captured stall data")
    print()
    if args.demo:
        print("DEMO MODE")
        print()
    avail = ia.script_availability("stall_analyze")
    if not args.demo and avail["status"] == "MISSING":
        print("FAILED")
        print("Script not found")
        print("Expected ANALYZE_STALL_SCRIPT, /usr/local/bin/analyze_stall.sh, or incident_scripts/analyze_stall.sh")
        return 1
    print("Status:")
    print("RUNNING")
    print()
    print(RULE)
    print()
    record = ia.execute_utility(
        "stall_analyze",
        incident_id=args.incident,
        operator=_operator(),
        force_demo=bool(args.demo),
        wait=True,
        allow_implicit_demo=False,
        include_stall_analyze=False,
    )
    print(_raw_text(record).rstrip() or "(no stdout)")
    print()
    print(RULE)
    print()
    print(f"Status: {record.get('status')}")
    print(f"Exit Code: {record.get('exit_code')}")
    dur = _duration_seconds(record)
    if dur is not None:
        print(f"Duration: {dur:.1f} seconds")
    print()
    print("Execution ID:")
    print(f" {record.get('execution_id')}")
    return 0 if record.get("status") == "COMPLETED" else 1


def cmd_status(args: argparse.Namespace) -> int:
    record = ia.load_execution(args.execution_id)
    if not record:
        print("FAILED")
        print("Execution not found")
        return 1
    meta = ia.UTILITY_META.get(record.get("utility_id") or "", {})
    print("Execution Details")
    print(RULE)
    print()
    print("Execution ID:")
    print(record.get("execution_id"))
    print()
    print("Utility:")
    print(meta.get("label") or record.get("utility_id"))
    print()
    print("Status:")
    print(record.get("status"))
    print()
    print("Started:")
    print(_fmt_local(record.get("started_at") or record.get("started_at_epoch")))
    print()
    print("Completed:")
    print(_fmt_local(record.get("completed_at") or record.get("completed_at_epoch")))
    print()
    print("Exit Code:")
    print(record.get("exit_code"))
    print()
    dur = _duration_seconds(record)
    print("Duration:")
    print(f"{dur:.1f} seconds" if dur is not None else "—")
    print()
    print("Output:")
    print(f" {record.get('output_location') or 'None'}")
    print()
    print("HTML:")
    print(f" {record.get('html_report_location') or 'None'}")
    if record.get("incident_id"):
        print()
        print("Incident ID:")
        print(record.get("incident_id"))
    if record.get("demo"):
        print()
        print("DEMO MODE — this execution was simulated.")
    return 0


def cmd_output(args: argparse.Namespace) -> int:
    record = ia.load_execution(args.execution_id)
    if not record:
        print("FAILED")
        print("Execution not found")
        return 1
    loc = record.get("output_location")
    path = Path(loc) if loc else None
    if path and path.is_file() and ia.is_safe_output_path(path) and args.tail:
        try:
            size = path.stat().st_size
            # Read only a trailing window for large files.
            with path.open("rb") as handle:
                if size > 256_000:
                    handle.seek(max(0, size - 256_000))
                    handle.readline()
                text = handle.read().decode("utf-8", errors="replace")
            print(_tail_text(text, args.tail), end="" if text.endswith("\n") else "\n")
            return 0
        except OSError as exc:
            print(f"FAILED\n{exc}", file=sys.stderr)
            return 1
    text = _raw_text(record)
    if args.tail:
        text = _tail_text(text, args.tail)
    print(text, end="" if text.endswith("\n") else "\n")
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    record = ia.load_execution(args.execution_id)
    if not record:
        print("FAILED")
        print("Execution not found")
        return 1
    html = record.get("html_report_location")
    if not html:
        print("No HTML report is registered for this execution.")
        loc = record.get("output_location")
        if loc:
            print(f"Output: {loc}")
        return 1
    path = Path(html)
    if not ia.is_safe_output_path(path):
        print("FAILED")
        print("Report path is not allowed.")
        return 1
    print("HTML Report Found")
    print()
    print("Execution:")
    print(record.get("execution_id"))
    print()
    print("Report:")
    print(f" {path}")
    if args.open:
        opener = shutil.which("xdg-open") or shutil.which("open")
        if not opener or not os.environ.get("DISPLAY") and sys.platform != "darwin":
            print()
            print("Browser open skipped (no GUI / xdg-open). Use the path above.")
            return 0
        try:
            subprocess.run([opener, str(path)], check=False, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            print()
            print("Could not open a browser. Use the path above.")
    return 0


def cmd_history(args: argparse.Namespace) -> int:
    rows: list[dict[str, Any]] = []
    if ia._telemetry_db is not None:
        try:
            rows = ia._telemetry_db.list_incident_analysis_executions(args.incident, limit=args.limit)
        except Exception:  # noqa: BLE001
            rows = []
    if not rows:
        with ia._EXEC_LOCK:
            rows = list(ia._IN_MEMORY.values())
            if args.incident:
                rows = [r for r in rows if r.get("incident_id") == args.incident]
        rows.sort(key=lambda r: r.get("started_at_epoch") or 0, reverse=True)
        rows = rows[: args.limit]
    print("FBL Incident Analysis History")
    print(RULE_WIDE)
    print()
    print(f"{'TIME':<18} {'UTILITY':<16} {'STATUS':<12} {'DURATION'}")
    print()
    if not rows:
        print("(no executions recorded)")
        return 0
    for row in rows:
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else row
        uid = payload.get("utility_id") or row.get("utility_id")
        cli = next((c for c, i, *_ in CLI_ROWS if i == uid), uid)
        started = payload.get("started_at") or row.get("started_at")
        clock = _fmt_local(payload.get("started_at_epoch") or started)
        time_part = clock.split(" ")[-1] if " " in clock else clock
        dur = _duration_seconds(payload) if payload.get("completed_at_epoch") else _duration_seconds(row)
        dur_s = f"{dur:.1f}s" if dur is not None else "—"
        print(f"{time_part:<18} {str(cli)[:16]:<16} {str(payload.get('status') or row.get('status') or '—'):<12} {dur_s}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fbl-diagnostic",
        description="FBL Diagnostic CLI — allowlisted Incident Analysis utilities (same service as the web UI).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Commands:\n"
            "  list                     List available diagnostic utilities\n"
            "  run <utility>            Execute a diagnostic utility\n"
            "  stall setup|analyze      Stall capture workflow\n"
            "  status <execution_id>    Show execution status\n"
            "  output <execution_id>    Show raw execution output\n"
            "  report <execution_id>    Show generated reports\n"
            "  history                  Show previous executions\n"
            "\n"
            "Utilities:\n"
            "  analyze\n"
            "  health-assess\n"
            "  unified-rca\n"
            "  forensic\n"
            "  stall-capture\n"
            "  pid500\n"
            "\n"
            "Simulated output is only used with --demo. Failures are not faked as COMPLETED."
        ),
    )
    sub = parser.add_subparsers(dest="command")

    p_list = sub.add_parser("list", help="List available diagnostic utilities")
    p_list.set_defaults(func=cmd_list)

    p_run = sub.add_parser("run", help="Execute a diagnostic utility")
    p_run.add_argument(
        "utility",
        help="analyze | health-assess | unified-rca | forensic | stall-capture | pid500",
    )
    p_run.add_argument("--incident", help="Existing Active Fault / incident id")
    p_run.add_argument(
        "--demo",
        action="store_true",
        help="Explicit simulated output (labeled DEMO MODE). Never mixed with a live run.",
    )
    p_run.set_defaults(func=cmd_run)

    p_stall = sub.add_parser("stall", help="Stall capture: setup or analyze")
    p_stall.add_argument(
        "stall_action",
        choices=("setup", "analyze"),
        help="setup → prepares stall capture; analyze → analyzes captured stall data",
    )
    p_stall.add_argument("--incident", help="Existing Active Fault / incident id")
    p_stall.add_argument("--demo", action="store_true")
    p_stall.set_defaults(func=cmd_stall)

    p_status = sub.add_parser("status", help="Show execution status")
    p_status.add_argument("execution_id")
    p_status.set_defaults(func=cmd_status)

    p_out = sub.add_parser("output", help="Show raw execution output")
    p_out.add_argument("execution_id")
    p_out.add_argument("--tail", type=int, default=0, metavar="N", help="Show last N lines")
    p_out.set_defaults(func=cmd_output)

    p_rep = sub.add_parser("report", help="Show generated HTML report path")
    p_rep.add_argument("execution_id")
    p_rep.add_argument("--open", action="store_true", help="Open in a browser if a GUI is available")
    p_rep.set_defaults(func=cmd_report)

    p_hist = sub.add_parser("history", help="Show previous executions")
    p_hist.add_argument("--limit", type=int, default=20)
    p_hist.add_argument("--incident", help="Filter by Active Fault / incident id")
    p_hist.set_defaults(func=cmd_history)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return 0
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
