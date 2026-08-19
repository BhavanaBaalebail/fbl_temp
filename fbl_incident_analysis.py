"""
Incident Analysis Utilities — allowlisted diagnostic script runner.

Never executes frontend-supplied shell strings. Argv-only subprocess.
"""

from __future__ import annotations

import glob
import logging
import os
import re
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from flask import Flask, Response, jsonify, request, send_file

logger = logging.getLogger("fbl_incident_analysis")

try:
    import telemetry_db as _telemetry_db
except Exception:  # noqa: BLE001
    _telemetry_db = None  # type: ignore

_MODULE_DIR = Path(__file__).resolve().parent
_DEFAULT_SCRIPTS_DIR = _MODULE_DIR / "incident_scripts"
_OUTPUT_ROOT = Path(os.environ.get("INCIDENT_OUTPUT_DIR", "/tmp")).resolve()
_EXEC_LOCK = threading.Lock()
_IN_MEMORY: dict[str, dict[str, Any]] = {}

UTILITY_IDS = ("analyze", "health", "rca", "forensic", "stall", "pid500")

# CLI names → internal ids. Internal ids are also accepted.
CLI_ALIASES: dict[str, str] = {
    "analyze": "analyze",
    "health-assess": "health",
    "health": "health",
    "unified-rca": "rca",
    "rca": "rca",
    "forensic": "forensic",
    "stall-capture": "stall",
    "stall": "stall",
    "pid500": "pid500",
    "stall-analyze": "stall_analyze",
}

UTILITY_META: dict[str, dict[str, Any]] = {
    "analyze": {
        "id": "analyze",
        "script_name": "Analyze.sh",
        "label": "Analyze System Health",
        "purpose": "CPU, memory, top consumers, storage devices, disk latency, and filesystem analysis.",
        "env_key": "ANALYZE_SCRIPT",
        "timeout_sec": 120,
        "requires_root": False,
    },
    "health": {
        "id": "health",
        "script_name": "Health_Assess.sh",
        "label": "Comprehensive Health Assessment",
        "purpose": "CPU, memory, storage, filesystem, network, and application assessment with TXT + HTML reports.",
        "env_key": "HEALTH_ASSESS_SCRIPT",
        "timeout_sec": 180,
        "requires_root": False,
    },
    "rca": {
        "id": "rca",
        "script_name": "Unified_RCA.sh",
        "label": "Unified Root Cause Analysis",
        "purpose": "Correlate subsystem problems and identify the likely primary root cause from live evidence.",
        "env_key": "UNIFIED_RCA_SCRIPT",
        "timeout_sec": 120,
        "requires_root": False,
    },
    "forensic": {
        "id": "forensic",
        "script_name": "ForensicV1.sh",
        "label": "Forensic Process & Infrastructure Capture",
        "purpose": "Captures a point-in-time forensic snapshot of processes and infrastructure for post-incident investigation.",
        "env_key": "FORENSIC_SCRIPT",
        "timeout_sec": 180,
        "requires_root": False,
    },
    "stall": {
        "id": "stall",
        "script_name": "Stall_Capture_setup.sh",
        "label": "Stall Capture",
        "purpose": "Captures the state of the server during a stall and provides evidence that can help identify the cause of the stall.",
        "env_key": "STALL_CAPTURE_SCRIPT",
        "timeout_sec": 180,
        "requires_root": True,
        "companion_env": "ANALYZE_STALL_SCRIPT",
        "companion_name": "analyze_stall.sh",
        "companion_default": "/usr/local/bin/analyze_stall.sh",
    },
    "pid500": {
        "id": "pid500",
        "script_name": "Pid500.sh",
        "label": "High CPU Process Capture",
        "purpose": "Identify and record processes that exceed 500% CPU utilization.",
        "env_key": "PID500_SCRIPT",
        "timeout_sec": 90,
        "requires_root": False,
    },
    "stall_analyze": {
        "id": "stall_analyze",
        "script_name": "analyze_stall.sh",
        "label": "Stall Analyze",
        "purpose": "Analyze previously captured stall evidence (analyze_stall.sh).",
        "env_key": "ANALYZE_STALL_SCRIPT",
        "timeout_sec": 180,
        "requires_root": True,
        "cli_only": True,
    },
}

_PATH_RE = re.compile(r"(/tmp/[A-Za-z0-9._/\-]+)")
_PRIMARY_RCA_RE = re.compile(r"PRIMARY ROOT CAUSE:\s*(.+)", re.IGNORECASE)
_PID500_RE = re.compile(
    r"PID:\s*(\d+).*?(?:Process|CMD|Command):\s*(\S+).*?CPU:\s*([\d.]+)\s*%",
    re.IGNORECASE | re.DOTALL,
)
_PID500_ALT_RE = re.compile(
    r"(?:pid500[_\-](\d+)\.log)|PID\s+(\d+)\s+(\S+)\s+([\d.]+)%",
    re.IGNORECASE,
)

RAW_PREVIEW_LIMIT = 48_000
_get_demo_active: Optional[Callable[[], bool]] = None


def _utc_iso(ts: Optional[float] = None) -> str:
    return datetime.fromtimestamp(ts or time.time(), tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def _scripts_dir() -> Path:
    raw = os.environ.get("INCIDENT_SCRIPTS_DIR", "").strip()
    if raw:
        return Path(raw).expanduser()
    return _DEFAULT_SCRIPTS_DIR


def _demo_forced() -> bool:
    flag = os.environ.get("INCIDENT_ANALYSIS_DEMO", "").strip().lower()
    if flag in ("1", "true", "yes", "on"):
        return True
    if _get_demo_active is not None:
        try:
            return bool(_get_demo_active())
        except Exception:  # noqa: BLE001
            return False
    return False


def resolve_cli_name(name: str) -> str:
    key = (name or "").strip().lower()
    if key not in CLI_ALIASES:
        raise ValueError(f"Unknown utility '{name}'")
    return CLI_ALIASES[key]


def script_availability(utility_id: str) -> dict[str, Any]:
    """AVAILABLE / MISSING / NOT EXECUTABLE for a utility id."""
    if utility_id == "stall_analyze":
        path = resolve_analyze_stall() or resolve_script_path(utility_id)
    else:
        path = resolve_script_path(utility_id)
    if path is None:
        return {"status": "MISSING", "path": None, "executable": False}
    executable = os.access(path, os.X_OK)
    return {
        "status": "AVAILABLE" if executable else "NOT EXECUTABLE",
        "path": str(path),
        "executable": executable,
    }


def resolve_script_path(utility_id: str) -> Optional[Path]:
    meta = UTILITY_META[utility_id]
    env_path = os.environ.get(meta["env_key"], "").strip()
    candidates: list[Path] = []
    if env_path:
        candidates.append(Path(env_path).expanduser())
    candidates.append(_scripts_dir() / meta["script_name"])
    candidates.append(Path("/usr/local/fbl/incident") / meta["script_name"])
    candidates.append(Path("/usr/local/bin") / meta["script_name"])
    for path in candidates:
        try:
            if path.is_file() and os.access(path, os.X_OK):
                return path.resolve()
        except OSError:
            continue
    for path in candidates:
        try:
            if path.is_file():
                return path.resolve()
        except OSError:
            continue
    return None


def resolve_analyze_stall() -> Optional[Path]:
    env_path = os.environ.get("ANALYZE_STALL_SCRIPT", "").strip()
    candidates = []
    if env_path:
        candidates.append(Path(env_path).expanduser())
    candidates.append(Path("/usr/local/bin/analyze_stall.sh"))
    candidates.append(_scripts_dir() / "analyze_stall.sh")
    for path in candidates:
        try:
            if path.is_file():
                return path.resolve()
        except OSError:
            continue
    return None


def _new_execution_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"incident-analysis-{stamp}-{secrets.token_hex(2)}"


def _allowed_output_roots() -> list[Path]:
    roots = [_OUTPUT_ROOT, Path("/tmp")]
    extra = os.environ.get("INCIDENT_ALLOWED_OUTPUT_DIRS", "").strip()
    if extra:
        for part in extra.split(os.pathsep):
            if part.strip():
                roots.append(Path(part.strip()))
    seen: set[str] = set()
    out: list[Path] = []
    for root in roots:
        try:
            resolved = root.resolve()
        except OSError:
            continue
        key = str(resolved)
        if key not in seen:
            seen.add(key)
            out.append(resolved)
    return out


def is_safe_output_path(path: Path) -> bool:
    try:
        resolved = path.resolve()
    except OSError:
        return False
    resolved_s = str(resolved)
    for root in _allowed_output_roots():
        root_s = str(root)
        if resolved_s == root_s or resolved_s.startswith(root_s + os.sep):
            return True
    return False


def _exec_dir(execution_id: str) -> Path:
    directory = _OUTPUT_ROOT / "fbl_incident" / execution_id
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def persist_execution(record: dict[str, Any]) -> None:
    with _EXEC_LOCK:
        _IN_MEMORY[record["execution_id"]] = dict(record)
    if _telemetry_db is None:
        return
    try:
        _telemetry_db.upsert_incident_analysis_execution(
            {
                "execution_id": record.get("execution_id"),
                "incident_id": record.get("incident_id"),
                "utility_id": record.get("utility_id"),
                "started_at": record.get("started_at_epoch"),
                "completed_at": record.get("completed_at_epoch"),
                "status": record.get("status"),
                "exit_code": record.get("exit_code"),
                "output_location": record.get("output_location"),
                "html_report_location": record.get("html_report_location"),
                "summary": record.get("summary"),
                "payload": record,
            }
        )
    except Exception:  # noqa: BLE001
        logger.debug("incident analysis persist skipped", exc_info=True)


def load_execution(execution_id: str) -> Optional[dict[str, Any]]:
    with _EXEC_LOCK:
        cached = _IN_MEMORY.get(execution_id)
        if cached:
            return dict(cached)
    if _telemetry_db is None:
        return None
    try:
        row = _telemetry_db.get_incident_analysis_execution(execution_id)
    except Exception:  # noqa: BLE001
        return None
    if not row:
        return None
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else None
    return payload or {
        "execution_id": row.get("execution_id"),
        "incident_id": row.get("incident_id"),
        "utility_id": row.get("utility_id"),
        "status": row.get("status"),
        "exit_code": row.get("exit_code"),
        "output_location": row.get("output_location"),
        "html_report_location": row.get("html_report_location"),
        "summary": row.get("summary"),
        "started_at": _utc_iso(row.get("started_at")),
        "completed_at": _utc_iso(row.get("completed_at")) if row.get("completed_at") else None,
    }


def parse_rca(text: str) -> dict[str, Any]:
    primary = None
    match = _PRIMARY_RCA_RE.search(text or "")
    if match:
        primary = match.group(1).strip()
        primary = re.sub(r"\s*\(.*\)\s*$", "", primary).strip() or primary
    detected: list[str] = []
    subsystems: set[str] = set()
    contributing: list[str] = []
    for line in (text or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        upper = stripped.upper()
        if "DETECTED" in upper:
            detected.append(stripped)
        if "STORAGE" in upper or "BLOCK I/O" in upper or "XFS" in upper or "DISK" in upper:
            subsystems.add("Storage")
        if "GPU" in upper or "VRAM" in upper or "DRM" in upper:
            subsystems.add("GPU")
        if "KERNEL" in upper or "D-STATE" in upper or "STALL" in upper:
            subsystems.add("Kernel")
        if "APPLICATION" in upper or "JAVA" in upper:
            subsystems.add("Application")
        if "NETWORK" in upper or "NIC" in upper:
            subsystems.add("Network")
        if "MEMORY" in upper or "RAM" in upper:
            subsystems.add("Memory")
        if "CPU" in upper:
            subsystems.add("CPU")
        if "CONTRIBUT" in upper or "CAUSING" in upper:
            contributing.append(stripped)
    if not primary and detected:
        first = detected[0]
        if "(" in first:
            primary = first.split("(")[0].replace("DETECTED", "").replace("ISSUE", "").strip().title()
        else:
            primary = first
    evidence = detected[:]
    if not contributing and "stall" in (text or "").lower():
        contributing.append("Kernel stalls detected")
    if "d-state" in (text or "").lower() and "D-state processes present" not in contributing:
        contributing.append("D-state processes present")
    if "block i/o" in (text or "").lower() or "latency" in (text or "").lower():
        if "Block I/O latency detected" not in contributing:
            contributing.append("Block I/O latency detected")
    return {
        "primary_root_cause": primary,
        "contributing_factors": contributing,
        "affected_subsystems": sorted(subsystems),
        "evidence": evidence,
        "insufficient": not bool(primary or evidence),
    }


def parse_pid500(text: str, extra_files: Optional[list[str]] = None) -> dict[str, Any]:
    processes: list[dict[str, Any]] = []
    for match in _PID500_RE.finditer(text or ""):
        processes.append(
            {
                "pid": match.group(1),
                "process": match.group(2),
                "cpu_percent": match.group(3),
            }
        )
    if not processes:
        for line in (text or "").splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[0].isdigit():
                cpu = parts[1].rstrip("%")
                try:
                    cpu_val = float(cpu)
                except ValueError:
                    continue
                if cpu_val >= 500:
                    processes.append(
                        {
                            "pid": parts[0],
                            "process": parts[2],
                            "cpu_percent": str(cpu_val),
                        }
                    )
    files = list(extra_files or [])
    files.extend(re.findall(r"pid500[_-][A-Za-z0-9._\-]+\.log", text or "", re.IGNORECASE))
    return {
        "processes": processes,
        "occurrences": len(processes),
        "evidence_files": sorted(set(files)),
    }


def extract_mentioned_paths(text: str) -> list[str]:
    found = []
    for match in _PATH_RE.findall(text or ""):
        path = Path(match)
        if is_safe_output_path(path):
            found.append(str(path.resolve()) if path.exists() else str(path))
    return found


def detect_html_report(search_roots: list[Path], mentioned: list[str]) -> Optional[str]:
    candidates: list[Path] = []
    for raw in mentioned:
        path = Path(raw)
        if path.is_file() and path.suffix.lower() == ".html" and is_safe_output_path(path):
            candidates.append(path)
        elif path.is_dir() and is_safe_output_path(path):
            candidates.extend(Path(p) for p in glob.glob(str(path / "*.html")))
            candidates.extend(Path(p) for p in glob.glob(str(path / "**/*.html"), recursive=True))
    for root in search_roots:
        if not root.exists() or not is_safe_output_path(root):
            continue
        if root.is_file() and root.suffix.lower() == ".html":
            candidates.append(root)
            continue
        if root.is_dir():
            candidates.extend(Path(p) for p in glob.glob(str(root / "*.html")))
            candidates.extend(Path(p) for p in glob.glob(str(root / "**/*.html"), recursive=True))
            for pattern in ("/tmp/telecom_health_*", str(_OUTPUT_ROOT / "telecom_health_*")):
                for folder in glob.glob(pattern):
                    folder_p = Path(folder)
                    if is_safe_output_path(folder_p):
                        candidates.extend(Path(p) for p in glob.glob(str(folder_p / "*.html")))
    html_files = [p.resolve() for p in candidates if p.is_file() and p.suffix.lower() == ".html" and is_safe_output_path(p)]
    if not html_files:
        return None
    html_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return str(html_files[0])


def summarize_analyze(text: str) -> list[str]:
    findings = []
    for line in (text or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        upper = stripped.upper()
        if any(k in upper for k in ("WARN", "CRIT", "FAIL", "HIGH", "LATENCY", "FULL", "ERROR", "ISSUE")):
            findings.append(stripped[:240])
        if len(findings) >= 8:
            break
    return findings


def _operator_from_request() -> str:
    header = (request.headers.get("X-FBL-Operator") or "").strip()
    if header:
        return header[:80]
    body = request.get_json(silent=True) or {}
    op = str(body.get("operator") or "").strip()
    return op[:80] if op else "dashboard"


def _public_record(record: dict[str, Any], *, include_raw: bool = False) -> dict[str, Any]:
    raw = record.get("raw_output") or ""
    preview = raw[:RAW_PREVIEW_LIMIT]
    truncated = len(raw) > RAW_PREVIEW_LIMIT
    out = {
        "execution_id": record.get("execution_id"),
        "incident_id": record.get("incident_id"),
        "utility_id": record.get("utility_id"),
        "utility": UTILITY_META.get(record.get("utility_id") or "", {}).get("label"),
        "script_name": UTILITY_META.get(record.get("utility_id") or "", {}).get("script_name"),
        "status": record.get("status"),
        "exit_code": record.get("exit_code"),
        "started_at": record.get("started_at"),
        "completed_at": record.get("completed_at"),
        "output_location": record.get("output_location"),
        "html_report_location": record.get("html_report_location"),
        "html_report_available": bool(record.get("html_report_location")),
        "summary": record.get("summary"),
        "findings": record.get("findings") or [],
        "parsed": record.get("parsed") or {},
        "demo": bool(record.get("demo")),
        "error": record.get("error"),
        "recommended_action": record.get("recommended_action"),
        "raw_output_truncated": truncated,
        "raw_output_preview": preview if include_raw else None,
        "requires_root": UTILITY_META.get(record.get("utility_id") or "", {}).get("requires_root"),
    }
    if include_raw:
        out["raw_output"] = preview
        out["raw_output_bytes"] = len(raw.encode("utf-8", errors="replace"))
    return out


def _fail_reason(stderr: str, returncode: Optional[int], timeout: bool, missing: bool) -> tuple[str, str]:
    err = (stderr or "").lower()
    if missing:
        return (
            "Diagnostic script was not found on this server.",
            "Place the approved script in INCIDENT_SCRIPTS_DIR or set the corresponding *_SCRIPT environment variable.",
        )
    if timeout:
        return (
            "Diagnostic script timed out before completion.",
            "Increase INCIDENT_* timeout only if the host is healthy; otherwise inspect hung I/O on the target.",
        )
    if "permission denied" in err or returncode == 13:
        return (
            "Permission denied while executing diagnostic script.",
            "Verify script permissions and required privileges. Do not enable passwordless sudo for this service.",
        )
    if "sudo" in err and ("password" in err or "a terminal is required" in err or "not allowed" in err):
        return (
            "Privileged execution failed (sudo).",
            "Run Stall Capture with an operator-approved privilege model. Passwordless sudo is not configured by FBL.",
        )
    if "no space" in err or "disk quota" in err:
        return (
            "Unable to write diagnostic output (disk full or quota exceeded).",
            "Free space under /tmp or INCIDENT_OUTPUT_DIR and retry.",
        )
    if returncode not in (None, 0):
        return (
            f"Diagnostic script exited with code {returncode}.",
            "Open the raw output for details. Do not treat this as a confirmed root cause.",
        )
    return (
        "Analysis failed.",
        "Retry after confirming the Linux collector is reachable and the script is executable.",
    )


def _run_argv(argv: list[str], timeout: int, cwd: Optional[Path] = None) -> dict[str, Any]:
    import subprocess

    try:
        completed = subprocess.run(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
            cwd=str(cwd) if cwd else None,
            env={**os.environ, "FBL_INCIDENT_OUTPUT": str(_OUTPUT_ROOT)},
        )
        return {
            "timeout": False,
            "returncode": completed.returncode,
            "stdout": completed.stdout or "",
            "stderr": completed.stderr or "",
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "timeout": True,
            "returncode": None,
            "stdout": (exc.stdout or "") if isinstance(exc.stdout, str) else "",
            "stderr": (exc.stderr or "") if isinstance(exc.stderr, str) else "Command timed out",
        }
    except PermissionError as exc:
        return {"timeout": False, "returncode": 13, "stdout": "", "stderr": str(exc)}
    except FileNotFoundError:
        return {"timeout": False, "returncode": 127, "stdout": "", "stderr": "Script not found", "missing": True}
    except Exception as exc:  # noqa: BLE001
        logger.exception("incident utility subprocess failed")
        return {"timeout": False, "returncode": None, "stdout": "", "stderr": str(exc)}


def _write_demo_bundle(utility_id: str, execution_id: str, work: Path) -> dict[str, Any]:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    demo_note = "DEMO MODE\nSimulated diagnostic output. This is not live server evidence.\n\n"
    stdout = demo_note
    html_path = None
    extra_files: list[str] = []
    if utility_id == "analyze":
        stdout += (
            "CPU health: elevated wait (simulated)\n"
            "Memory: 78% used (simulated)\n"
            "Top memory consumers: java, node (simulated)\n"
            "Storage devices: sda latency HIGH (simulated)\n"
            "Disk latency: 240ms avg (simulated)\n"
            "Filesystem: XFS writeback delay (simulated)\n"
        )
    elif utility_id == "health":
        folder = Path("/tmp") / f"telecom_health_{stamp}"
        folder.mkdir(parents=True, exist_ok=True)
        txt = folder / "health_report.txt"
        html = folder / "health_report.html"
        body = (
            "DEMO MODE — Simulated Comprehensive Health Assessment\n"
            "CPU assessment: warning (simulated)\n"
            "Memory assessment: warning (simulated)\n"
            "Storage assessment: critical latency (simulated)\n"
            "Filesystem assessment: XFS pressure (simulated)\n"
            "Network assessment: nominal (simulated)\n"
            "Application assessment: Java load present (simulated)\n"
        )
        txt.write_text(demo_note + body, encoding="utf-8")
        html.write_text(
            "<html><body style='background:#0b1220;color:#e2e8f0;font-family:sans-serif;padding:24px'>"
            "<p style='color:#f59e0b;font-weight:700'>DEMO MODE — Simulated report</p>"
            "<h1>Health Assessment</h1><pre>"
            + body
            + "</pre></body></html>",
            encoding="utf-8",
        )
        stdout += f"Report directory: {folder}\n{txt}\nHTML: {html}\n{body}"
        html_path = str(html)
        extra_files.extend([str(folder), str(txt), str(html)])
    elif utility_id == "rca":
        stdout += (
            "STORAGE ISSUE DETECTED (XFS / DM / BLOCK I/O)\n"
            "GPU / VRAM ISSUE DETECTED (DRM/QXL)\n"
            "KERNEL STALL DETECTED (D-state processes)\n"
            "APPLICATION LOAD PRESENT (Java detected)\n"
            "PRIMARY ROOT CAUSE: STORAGE LATENCY (causing kernel stalls)\n"
        )
    elif utility_id == "forensic":
        stdout += (
            "Point-in-time forensic snapshot (simulated)\n"
            "PID CPU MEM STATE COMMAND\n"
            "1 0.1 0.2 S systemd\n"
            "4242 12.0 8.1 S java\n"
            "Infrastructure: simulated inventory only.\n"
        )
        snap = work / f"forensic_{stamp}.txt"
        snap.write_text(stdout, encoding="utf-8")
        extra_files.append(str(snap))
    elif utility_id in ("stall", "stall_analyze"):
        stdout += (
            "Stall Capture Setup completed (simulated)\n"
            "analyze_stall.sh findings (simulated):\n"
            "KERNEL STALL DETECTED\n"
            "Blocked I/O threads present (simulated)\n"
        )
    elif utility_id == "pid500":
        log = work / f"pid500_{stamp}.log"
        log.write_text("PID: 4242  Process: java  CPU: 632%  Detected: simulated\n", encoding="utf-8")
        stdout += f"High CPU Process Detected\nPID: 4242\nProcess: java\nCPU: 632%\nEvidence: {log.name}\n"
        extra_files.append(str(log))
    raw_path = work / "stdout.txt"
    raw_path.write_text(stdout, encoding="utf-8")
    return {
        "stdout": stdout,
        "stderr": "",
        "returncode": 0,
        "timeout": False,
        "html_path": html_path,
        "extra_files": extra_files,
        "output_location": str(raw_path),
        "demo": True,
    }


def _interpret(utility_id: str, combined: str, extra_files: list[str], html_hint: Optional[str]) -> dict[str, Any]:
    parsed: dict[str, Any] = {}
    findings: list[str] = []
    summary = "Completed"
    if utility_id == "rca":
        parsed = parse_rca(combined)
        if parsed.get("insufficient"):
            summary = "Insufficient evidence to determine primary root cause."
        else:
            summary = f"Primary root cause: {parsed.get('primary_root_cause')}"
        findings = parsed.get("evidence") or []
    elif utility_id == "pid500":
        parsed = parse_pid500(combined, extra_files)
        if parsed["occurrences"]:
            summary = f"{parsed['occurrences']} process capture(s) above 500% CPU."
        else:
            summary = "No processes above 500% CPU were present in the captured output."
        findings = [
            f"PID {p['pid']} {p['process']} {p['cpu_percent']}%" for p in parsed.get("processes", [])
        ]
    elif utility_id == "analyze":
        findings = summarize_analyze(combined)
        summary = "System health analysis completed." if findings else "Analysis completed; no highlighted warnings in output."
    elif utility_id == "health":
        findings = summarize_analyze(combined)
        summary = "Health assessment completed."
    elif utility_id == "forensic":
        summary = "Forensic snapshot captured. Raw process listing is retained on disk; UI shows a summary only."
        findings = [line.strip() for line in combined.splitlines() if line.strip()][:6]
    elif utility_id in ("stall", "stall_analyze"):
        parsed = parse_rca(combined)
        summary = parsed.get("primary_root_cause") or "Stall capture completed."
        findings = parsed.get("evidence") or summarize_analyze(combined)
    mentioned = extract_mentioned_paths(combined)
    roots = [Path(p) for p in extra_files if p]
    roots.append(_OUTPUT_ROOT)
    html = html_hint
    if not html:
        html = detect_html_report(roots, mentioned)
    return {"parsed": parsed, "findings": findings, "summary": summary, "html": html, "mentioned": mentioned}


def execute_utility(
    utility_id: str,
    *,
    incident_id: Optional[str],
    operator: str,
    force_demo: bool = False,
    wait: bool = False,
    allow_implicit_demo: bool = True,
    include_stall_analyze: Optional[bool] = None,
) -> dict[str, Any]:
    if utility_id not in UTILITY_META:
        raise ValueError("invalid utility")
    if include_stall_analyze is None:
        include_stall_analyze = utility_id == "stall"
    execution_id = _new_execution_id()
    started = time.time()
    record: dict[str, Any] = {
        "execution_id": execution_id,
        "incident_id": incident_id,
        "utility_id": utility_id,
        "operator": operator,
        "status": "QUEUED",
        "started_at": _utc_iso(started),
        "started_at_epoch": started,
        "completed_at": None,
        "completed_at_epoch": None,
        "exit_code": None,
        "output_location": None,
        "html_report_location": None,
        "summary": "Queued",
        "demo": False,
    }
    persist_execution(record)
    logger.info(
        "incident analysis start execution_id=%s utility=%s incident_id=%s operator=%s",
        execution_id,
        utility_id,
        incident_id,
        operator,
    )

    def _worker() -> None:
        record["status"] = "RUNNING"
        persist_execution(record)
        work = _exec_dir(execution_id)
        script = resolve_analyze_stall() if utility_id == "stall_analyze" else resolve_script_path(utility_id)
        implicit_demo = allow_implicit_demo and _demo_forced() and (
            script is None or not os.access(script, os.X_OK)
        )
        use_demo = bool(force_demo) or implicit_demo
        if script is None and not use_demo:
            reason, action = _fail_reason("", 127, False, True)
            record.update(
                {
                    "status": "FAILED",
                    "exit_code": 127,
                    "error": reason,
                    "recommended_action": action,
                    "summary": "FAILED\nScript not found",
                    "completed_at_epoch": time.time(),
                    "completed_at": _utc_iso(),
                }
            )
            persist_execution(record)
            logger.info(
                "incident analysis end execution_id=%s status=FAILED reason=missing_script",
                execution_id,
            )
            return

        result: dict[str, Any]
        if use_demo:
            result = _write_demo_bundle(utility_id, execution_id, work)
        else:
            argv = [str(script)]
            if script is not None and not os.access(script, os.X_OK):
                argv = ["bash", str(script)]
            if utility_id in ("stall", "stall_analyze") and os.environ.get(
                "INCIDENT_STALL_SUDO", ""
            ).strip().lower() in (
                "1",
                "true",
                "yes",
            ):
                argv = ["sudo", "-n", *argv]
            timeout = int(UTILITY_META[utility_id]["timeout_sec"])
            run = _run_argv(argv, timeout, cwd=work)
            stdout = run.get("stdout") or ""
            stderr = run.get("stderr") or ""
            if (
                include_stall_analyze
                and utility_id == "stall"
                and not run.get("timeout")
                and run.get("returncode") == 0
            ):
                companion = resolve_analyze_stall()
                if companion is not None:
                    companion_argv = [str(companion)]
                    if not os.access(companion, os.X_OK):
                        companion_argv = ["bash", str(companion)]
                    second = _run_argv(companion_argv, timeout, cwd=work)
                    stdout += "\n--- analyze_stall.sh ---\n" + (second.get("stdout") or "")
                    stderr += "\n" + (second.get("stderr") or "")
                    if second.get("timeout"):
                        run["timeout"] = True
                    elif second.get("returncode") not in (0, None):
                        run["returncode"] = second.get("returncode")
            combined_write = work / "stdout.txt"
            combined_write.write_text(stdout + ("\n" + stderr if stderr else ""), encoding="utf-8")
            result = {
                "stdout": stdout,
                "stderr": stderr,
                "returncode": run.get("returncode"),
                "timeout": bool(run.get("timeout")),
                "missing": bool(run.get("missing")),
                "html_path": None,
                "extra_files": [str(combined_write)],
                "output_location": str(combined_write),
                "demo": False,
            }

        combined = (result.get("stdout") or "") + "\n" + (result.get("stderr") or "")
        if result.get("timeout"):
            status = "TIMEOUT"
            reason, action = _fail_reason(result.get("stderr") or "", result.get("returncode"), True, False)
            record.update({"error": reason, "recommended_action": action, "summary": "Analysis Failed"})
            parsed_pack = {"parsed": {}, "findings": [], "summary": record["summary"], "html": None}
        elif result.get("returncode") not in (0, None) and not result.get("demo"):
            status = "FAILED"
            reason, action = _fail_reason(
                result.get("stderr") or "",
                result.get("returncode"),
                False,
                bool(result.get("missing")),
            )
            record.update({"error": reason, "recommended_action": action, "summary": "Analysis Failed"})
            parsed_pack = _interpret(utility_id, combined, result.get("extra_files") or [], result.get("html_path"))
        else:
            status = "COMPLETED"
            parsed_pack = _interpret(utility_id, combined, result.get("extra_files") or [], result.get("html_path"))
            record["summary"] = parsed_pack["summary"]

        ended = time.time()
        record.update(
            {
                "status": status,
                "exit_code": result.get("returncode"),
                "completed_at_epoch": ended,
                "completed_at": _utc_iso(ended),
                "output_location": result.get("output_location"),
                "html_report_location": parsed_pack.get("html") or result.get("html_path"),
                "findings": parsed_pack.get("findings") or [],
                "parsed": parsed_pack.get("parsed") or {},
                "raw_output": combined[-500_000:],
                "demo": bool(result.get("demo")),
            }
        )
        persist_execution(record)
        logger.info(
            "incident analysis end execution_id=%s utility=%s incident_id=%s operator=%s status=%s exit_code=%s output=%s",
            execution_id,
            utility_id,
            incident_id,
            operator,
            status,
            result.get("returncode"),
            record.get("output_location"),
        )

    if wait:
        _worker()
        return load_execution(execution_id) or record
    threading.Thread(target=_worker, name=f"ia-{execution_id}", daemon=True).start()
    return record


def incident_story(incident_id: str) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    if _telemetry_db is not None:
        try:
            rows = _telemetry_db.list_incident_analysis_executions(incident_id, limit=40)
        except Exception:  # noqa: BLE001
            rows = []
    if not rows:
        with _EXEC_LOCK:
            rows = [dict(v) for v in _IN_MEMORY.values() if v.get("incident_id") == incident_id]
    latest_by_util: dict[str, dict[str, Any]] = {}
    for row in rows:
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else row
        uid = payload.get("utility_id")
        if not uid:
            continue
        prev = latest_by_util.get(uid)
        ts = payload.get("started_at_epoch") or row.get("started_at") or 0
        prev_ts = (prev or {}).get("started_at_epoch") or 0
        if prev is None or ts >= prev_ts:
            latest_by_util[uid] = payload

    evidence_utils = []
    observed: list[str] = []
    subsystems: set[str] = set()
    primary = None
    for uid, payload in latest_by_util.items():
        if payload.get("status") != "COMPLETED":
            continue
        evidence_utils.append(UTILITY_META.get(uid, {}).get("script_name") or uid)
        parsed = payload.get("parsed") or {}
        if uid == "rca" and parsed.get("primary_root_cause"):
            primary = parsed.get("primary_root_cause")
            subsystems.update(parsed.get("affected_subsystems") or [])
            observed.extend(parsed.get("evidence") or [])
        observed.extend(payload.get("findings") or [])
        subsystems.update((parsed.get("affected_subsystems") or []))
    observed = list(dict.fromkeys([o for o in observed if o]))[:12]
    if not primary:
        message = "Insufficient evidence to determine primary root cause."
        what_failed = None
    else:
        message = None
        what_failed = (list(subsystems)[0] if subsystems else None) or primary
    return {
        "incident_id": incident_id,
        "what_failed": what_failed,
        "what_was_observed": observed,
        "what_was_affected": sorted(subsystems),
        "primary_root_cause": primary,
        "insufficient": primary is None,
        "message": message,
        "evidence": evidence_utils,
        "demo": any(bool((p or {}).get("demo")) for p in latest_by_util.values()),
    }


def register_incident_analysis_routes(
    app: Flask,
    *,
    get_demo_active: Optional[Callable[[], bool]] = None,
) -> None:
    global _get_demo_active
    _get_demo_active = get_demo_active

    @app.route("/incident-analysis/utilities", methods=["GET"])
    def incident_analysis_utilities():
        items = []
        for uid in UTILITY_IDS:
            meta = UTILITY_META[uid]
            path = resolve_script_path(uid)
            items.append(
                {
                    **{k: meta[k] for k in ("id", "script_name", "label", "purpose", "requires_root", "timeout_sec")},
                    "script_configured": path is not None,
                    "script_path": str(path) if path else None,
                    "demo_available": _demo_forced(),
                }
            )
        return jsonify(
            {
                "utilities": items,
                "demo_mode": _demo_forced(),
                "scripts_dir": str(_scripts_dir()),
                "output_root": str(_OUTPUT_ROOT),
            }
        )

    @app.route("/incident-analysis/run/<utility_id>", methods=["POST"])
    def incident_analysis_run(utility_id: str):
        uid = (utility_id or "").strip().lower()
        if uid in CLI_ALIASES:
            uid = CLI_ALIASES[uid]
        if uid not in UTILITY_META:
            return jsonify({"error": "Unknown utility. Request rejected.", "allowlist": list(UTILITY_IDS)}), 400
        body = request.get_json(silent=True) or {}
        incident_id = str(body.get("incident_id") or body.get("fault_id") or "").strip() or None
        operator = _operator_from_request()
        force_demo = bool(body.get("demo")) and _demo_forced()
        try:
            record = execute_utility(uid, incident_id=incident_id, operator=operator, force_demo=force_demo)
        except ValueError:
            return jsonify({"error": "Invalid utility"}), 400
        return jsonify(_public_record(record)), 202

    @app.route("/incident-analysis/status/<execution_id>", methods=["GET"])
    def incident_analysis_status(execution_id: str):
        record = load_execution(execution_id)
        if not record:
            return jsonify({"error": "Execution not found"}), 404
        return jsonify(_public_record(record))

    @app.route("/incident-analysis/result/<execution_id>", methods=["GET"])
    def incident_analysis_result(execution_id: str):
        record = load_execution(execution_id)
        if not record:
            return jsonify({"error": "Execution not found"}), 404
        include_raw = str(request.args.get("raw") or "").lower() in ("1", "true", "yes")
        return jsonify(_public_record(record, include_raw=include_raw))

    @app.route("/incident-analysis/report/<execution_id>", methods=["GET"])
    def incident_analysis_report(execution_id: str):
        record = load_execution(execution_id)
        if not record:
            return jsonify({"error": "Execution not found"}), 404
        html_path = record.get("html_report_location")
        if not html_path:
            return jsonify({"error": "No HTML report is registered for this execution."}), 404
        path = Path(html_path)
        if not is_safe_output_path(path) or not path.is_file():
            logger.warning("blocked incident report path execution_id=%s path=%s", execution_id, html_path)
            return jsonify({"error": "Report path is not allowed."}), 403
        return send_file(path, mimetype="text/html")

    @app.route("/incident-analysis/history", methods=["GET"])
    def incident_analysis_history():
        incident_id = (request.args.get("incident_id") or request.args.get("fault_id") or "").strip() or None
        rows = []
        if _telemetry_db is not None:
            try:
                rows = _telemetry_db.list_incident_analysis_executions(incident_id, limit=50)
            except Exception:  # noqa: BLE001
                rows = []
        if not rows:
            with _EXEC_LOCK:
                rows = list(_IN_MEMORY.values())
                if incident_id:
                    rows = [r for r in rows if r.get("incident_id") == incident_id]
        public = []
        for row in rows:
            payload = row.get("payload") if isinstance(row.get("payload"), dict) else row
            public.append(_public_record(payload))
        return jsonify({"history": public, "incident_id": incident_id})

    @app.route("/incident-analysis/summary/<incident_id>", methods=["GET"])
    def incident_analysis_summary(incident_id: str):
        return jsonify(incident_story(incident_id))

    @app.route("/incident-analysis/raw/<execution_id>", methods=["GET"])
    def incident_analysis_raw(execution_id: str):
        record = load_execution(execution_id)
        if not record:
            return jsonify({"error": "Execution not found"}), 404
        loc = record.get("output_location")
        if loc:
            path = Path(loc)
            if is_safe_output_path(path) and path.is_file():
                text = path.read_text(encoding="utf-8", errors="replace")[:RAW_PREVIEW_LIMIT]
                return Response(text, mimetype="text/plain; charset=utf-8")
        raw = record.get("raw_output") or record.get("raw_output_preview") or ""
        return Response(str(raw)[:RAW_PREVIEW_LIMIT], mimetype="text/plain; charset=utf-8")
