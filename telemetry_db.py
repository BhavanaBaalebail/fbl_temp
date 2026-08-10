"""
SQLite persistence for CM.py telemetry, fault, and recovery history.

Additive storage layer — does not replace in-memory globals or JSONL files.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("hardware-monitor.telemetry_db")

TELEMETRY_DB_PATH = Path(__file__).resolve().parent / "telemetry_history.db"

_db_lock = threading.Lock()
_seen_fault_ids: set[str] = set()
_seen_faults_loaded = False

_ALERT_RE = re.compile(r"^\[([^\]]+)\]\s*(.+)$")

TELEMETRY_SAMPLES_DDL = """
CREATE TABLE IF NOT EXISTS telemetry_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collected_at REAL NOT NULL,
    metrics_timestamp TEXT,
    hostname TEXT,
    cpu_usage_percent REAL,
    cpu_idle_percent REAL,
    cpu_user_percent REAL,
    cpu_system_percent REAL,
    cpu_iowait_percent REAL,
    cpu_temperature_celsius REAL,
    cpu_load_1min REAL,
    cpu_load_5min REAL,
    cpu_load_15min REAL,
    cpu_current_mhz REAL,
    memory_usage_percent REAL,
    memory_swap_usage_percent REAL,
    memory_used_gb REAL,
    memory_total_gb REAL,
    memory_available_gb REAL,
    gpu_temperature_celsius REAL,
    gpu_utilization_percent REAL,
    gpu_memory_utilization_percent REAL,
    gpu_power_draw_watts REAL,
    gpu_model TEXT,
    uptime_seconds INTEGER,
    nic_up_count INTEGER,
    nic_total_count INTEGER,
    nic_error_count INTEGER,
    lh_score INTEGER,
    lh_overall_health TEXT,
    lh_critical_alert_count INTEGER,
    lh_warning_count INTEGER,
    lh_components_checked INTEGER,
    lh_components_with_errors INTEGER,
    lh_components_with_warnings INTEGER,
    pci_count INTEGER,
    usb_count INTEGER,
    disk_mounts_json TEXT,
    metrics_json TEXT NOT NULL,
    inventory_json TEXT,
    link_health_summary_json TEXT
);
"""

FAULT_EVENTS_DDL = """
CREATE TABLE IF NOT EXISTS fault_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fault_id TEXT NOT NULL UNIQUE,
    first_seen_at REAL NOT NULL,
    last_seen_at REAL NOT NULL,
    severity TEXT NOT NULL,
    component TEXT,
    metric_name TEXT,
    current_value TEXT,
    threshold_crossed TEXT,
    description TEXT NOT NULL,
    status TEXT,
    source TEXT DEFAULT 'health_summary'
);
"""

RECOVERY_EXECUTIONS_DDL = """
CREATE TABLE IF NOT EXISTS recovery_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    action TEXT,
    success INTEGER,
    message TEXT,
    command TEXT,
    stdout TEXT,
    stderr TEXT,
    returncode INTEGER,
    duration_seconds REAL,
    params_json TEXT,
    fault_json TEXT,
    confirmation_json TEXT,
    before_metrics_json TEXT,
    after_metrics_json TEXT,
    entry_json TEXT NOT NULL
);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(TELEMETRY_DB_PATH), timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Create database file, enable WAL mode, and ensure tables exist."""
    with _db_lock:
        conn = _connect()
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute(TELEMETRY_SAMPLES_DDL)
            conn.execute(FAULT_EVENTS_DDL)
            conn.execute(RECOVERY_EXECUTIONS_DDL)
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_telemetry_collected_at "
                "ON telemetry_samples(collected_at)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_fault_first_seen_at "
                "ON fault_events(first_seen_at)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_fault_last_seen_at "
                "ON fault_events(last_seen_at)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_recovery_timestamp "
                "ON recovery_executions(timestamp)"
            )
            conn.commit()
            _load_seen_fault_ids(conn)
            logger.info("Telemetry database ready at %s", TELEMETRY_DB_PATH)
        finally:
            conn.close()


def _load_seen_fault_ids(conn: sqlite3.Connection) -> None:
    global _seen_fault_ids, _seen_faults_loaded
    if _seen_faults_loaded:
        return
    try:
        rows = conn.execute("SELECT fault_id FROM fault_events").fetchall()
        _seen_fault_ids = {row["fault_id"] for row in rows}
        _seen_faults_loaded = True
    except sqlite3.Error:
        logger.exception("Failed to load existing fault ids from database")


def _num(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        num = float(value)
        if num != num:  # NaN
            return None
        return num
    except (TypeError, ValueError):
        return None


def _int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _primary_gpu(metrics: dict[str, Any]) -> dict[str, Any]:
    gpu = metrics.get("gpu")
    if isinstance(gpu, list) and gpu:
        first = gpu[0]
        return first if isinstance(first, dict) else {}
    if isinstance(gpu, dict):
        return gpu
    return {}


def _build_telemetry_row(
    metrics: dict[str, Any],
    inventory: Optional[dict[str, Any]],
    link_health: Optional[dict[str, Any]],
    collected_at: float,
) -> dict[str, Any]:
    cpu = metrics.get("cpu") or {}
    mem = metrics.get("memory") or {}
    sys_m = metrics.get("system") or {}
    gpu = _primary_gpu(metrics)
    nics = metrics.get("nic") or []
    disk = metrics.get("disk") or {}
    lh = (link_health or {}).get("health_summary") or {}

    up_nics = [
        n for n in nics
        if isinstance(n, dict) and str(n.get("link_state") or "").lower() == "up"
    ]
    nic_errors = 0
    for nic in nics:
        if not isinstance(nic, dict):
            continue
        nic_errors += (nic.get("rx_errors") or 0) + (nic.get("tx_errors") or 0)

    inv_sys = (inventory or {}).get("system") or {}
    io = (inventory or {}).get("io") or {}
    pci = io.get("pci") if isinstance(io, dict) else None
    usb = io.get("usb") if isinstance(io, dict) else None

    mounts = disk.get("mounts") or []
    disk_mounts = [
        {"mp": m.get("mountpoint") or m.get("mount"), "pct": m.get("usage_percent")}
        for m in mounts
        if isinstance(m, dict)
    ]

    load = cpu.get("load_average") or {}

    return {
        "collected_at": collected_at,
        "metrics_timestamp": metrics.get("timestamp"),
        "hostname": inv_sys.get("hostname"),
        "cpu_usage_percent": _num(cpu.get("usage_percent")),
        "cpu_idle_percent": _num(cpu.get("idle_percent")),
        "cpu_user_percent": _num(cpu.get("user_percent")),
        "cpu_system_percent": _num(cpu.get("system_percent")),
        "cpu_iowait_percent": _num(cpu.get("iowait_percent")),
        "cpu_temperature_celsius": _num(cpu.get("temperature_celsius")),
        "cpu_load_1min": _num(load.get("1min")),
        "cpu_load_5min": _num(load.get("5min")),
        "cpu_load_15min": _num(load.get("15min")),
        "cpu_current_mhz": _num(cpu.get("current_mhz")),
        "memory_usage_percent": _num(mem.get("usage_percent")),
        "memory_swap_usage_percent": _num(mem.get("swap_usage_percent")),
        "memory_used_gb": _num(mem.get("used_gb")),
        "memory_total_gb": _num(mem.get("total_gb")),
        "memory_available_gb": _num(mem.get("available_gb")),
        "gpu_temperature_celsius": _num(gpu.get("temperature_celsius")),
        "gpu_utilization_percent": _num(gpu.get("gpu_utilization_percent")),
        "gpu_memory_utilization_percent": _num(gpu.get("memory_utilization_percent")),
        "gpu_power_draw_watts": _num(gpu.get("power_draw_watts")),
        "gpu_model": gpu.get("model"),
        "uptime_seconds": _int(sys_m.get("uptime_seconds")),
        "nic_up_count": len(up_nics),
        "nic_total_count": len(nics),
        "nic_error_count": nic_errors,
        "lh_score": _int(lh.get("score")),
        "lh_overall_health": lh.get("overall_health"),
        "lh_critical_alert_count": len(lh.get("critical_alerts") or []),
        "lh_warning_count": len(lh.get("warnings") or []),
        "lh_components_checked": _int(lh.get("components_checked")),
        "lh_components_with_errors": _int(lh.get("components_with_errors")),
        "lh_components_with_warnings": _int(lh.get("components_with_warnings")),
        "pci_count": len(pci) if isinstance(pci, list) else None,
        "usb_count": len(usb) if isinstance(usb, list) else None,
        "disk_mounts_json": json.dumps(disk_mounts, default=str),
        "metrics_json": json.dumps(metrics, default=str),
        "inventory_json": json.dumps(inventory, default=str) if inventory else None,
        "link_health_summary_json": json.dumps(lh, default=str) if lh else None,
    }


def _fault_id(component: str, severity: str, description: str) -> str:
    key = f"{component}|{severity}|{description}"
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
    return f"cm-{digest}"


def _parse_health_alert(alert: str, severity: str, seen_at: float) -> dict[str, Any]:
    text = str(alert or "").strip()
    match = _ALERT_RE.match(text)
    if match:
        component = match.group(1).strip()
        description = match.group(2).strip()
    else:
        component = "unknown"
        description = text

    sev_label = "Critical" if severity == "critical" else "Warning"
    return {
        "fault_id": _fault_id(component, sev_label, description),
        "first_seen_at": seen_at,
        "last_seen_at": seen_at,
        "severity": sev_label,
        "component": component,
        "metric_name": None,
        "current_value": None,
        "threshold_crossed": None,
        "description": description,
        "status": "Active",
        "source": "health_summary",
    }


def _extract_fault_rows(link_health: Optional[dict[str, Any]], seen_at: float) -> list[dict[str, Any]]:
    lh = (link_health or {}).get("health_summary") or {}
    rows: list[dict[str, Any]] = []
    for alert in lh.get("critical_alerts") or []:
        rows.append(_parse_health_alert(alert, "critical", seen_at))
    for alert in lh.get("warnings") or []:
        rows.append(_parse_health_alert(alert, "warning", seen_at))
    return rows


def persist_poll_cycle(
    metrics: dict[str, Any],
    inventory: Optional[dict[str, Any]],
    link_health: Optional[dict[str, Any]],
) -> None:
    """Insert one telemetry sample and upsert any active health-summary faults."""
    collected_at = time.time()
    row = _build_telemetry_row(metrics, inventory, link_health, collected_at)
    fault_rows = _extract_fault_rows(link_health, collected_at)

    with _db_lock:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO telemetry_samples (
                    collected_at, metrics_timestamp, hostname,
                    cpu_usage_percent, cpu_idle_percent, cpu_user_percent,
                    cpu_system_percent, cpu_iowait_percent, cpu_temperature_celsius,
                    cpu_load_1min, cpu_load_5min, cpu_load_15min, cpu_current_mhz,
                    memory_usage_percent, memory_swap_usage_percent,
                    memory_used_gb, memory_total_gb, memory_available_gb,
                    gpu_temperature_celsius, gpu_utilization_percent,
                    gpu_memory_utilization_percent, gpu_power_draw_watts, gpu_model,
                    uptime_seconds, nic_up_count, nic_total_count, nic_error_count,
                    lh_score, lh_overall_health, lh_critical_alert_count, lh_warning_count,
                    lh_components_checked, lh_components_with_errors,
                    lh_components_with_warnings, pci_count, usb_count,
                    disk_mounts_json, metrics_json, inventory_json, link_health_summary_json
                ) VALUES (
                    :collected_at, :metrics_timestamp, :hostname,
                    :cpu_usage_percent, :cpu_idle_percent, :cpu_user_percent,
                    :cpu_system_percent, :cpu_iowait_percent, :cpu_temperature_celsius,
                    :cpu_load_1min, :cpu_load_5min, :cpu_load_15min, :cpu_current_mhz,
                    :memory_usage_percent, :memory_swap_usage_percent,
                    :memory_used_gb, :memory_total_gb, :memory_available_gb,
                    :gpu_temperature_celsius, :gpu_utilization_percent,
                    :gpu_memory_utilization_percent, :gpu_power_draw_watts, :gpu_model,
                    :uptime_seconds, :nic_up_count, :nic_total_count, :nic_error_count,
                    :lh_score, :lh_overall_health, :lh_critical_alert_count, :lh_warning_count,
                    :lh_components_checked, :lh_components_with_errors,
                    :lh_components_with_warnings, :pci_count, :usb_count,
                    :disk_mounts_json, :metrics_json, :inventory_json, :link_health_summary_json
                )
                """,
                row,
            )

            for fault in fault_rows:
                fault_id = fault["fault_id"]
                if fault_id in _seen_fault_ids:
                    conn.execute(
                        """
                        UPDATE fault_events
                        SET last_seen_at = ?, status = 'Active'
                        WHERE fault_id = ?
                        """,
                        (collected_at, fault_id),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO fault_events (
                            fault_id, first_seen_at, last_seen_at, severity, component,
                            metric_name, current_value, threshold_crossed,
                            description, status, source
                        ) VALUES (
                            :fault_id, :first_seen_at, :last_seen_at, :severity, :component,
                            :metric_name, :current_value, :threshold_crossed,
                            :description, :status, :source
                        )
                        """,
                        fault,
                    )
                    _seen_fault_ids.add(fault_id)

            conn.commit()
        finally:
            conn.close()


def insert_recovery_execution(entry: dict[str, Any]) -> None:
    """Persist one recovery audit record matching recovery_history.jsonl schema."""
    payload = dict(entry)
    timestamp = payload.get("timestamp") or datetime.now(timezone.utc).isoformat()

    with _db_lock:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO recovery_executions (
                    timestamp, action, success, message, command, stdout, stderr,
                    returncode, duration_seconds, params_json, fault_json,
                    confirmation_json, before_metrics_json, after_metrics_json, entry_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    timestamp,
                    payload.get("action"),
                    1 if payload.get("success") else 0 if payload.get("success") is not None else None,
                    payload.get("message"),
                    payload.get("command"),
                    payload.get("stdout"),
                    payload.get("stderr"),
                    payload.get("returncode"),
                    payload.get("duration_seconds"),
                    json.dumps(payload.get("params"), default=str) if payload.get("params") is not None else None,
                    json.dumps(payload.get("fault"), default=str) if payload.get("fault") is not None else None,
                    json.dumps(payload.get("confirmation"), default=str)
                    if payload.get("confirmation") is not None
                    else None,
                    json.dumps(payload.get("before_metrics"), default=str)
                    if payload.get("before_metrics") is not None
                    else None,
                    json.dumps(payload.get("after_metrics"), default=str)
                    if payload.get("after_metrics") is not None
                    else None,
                    json.dumps(payload, default=str),
                ),
            )
            conn.commit()
        finally:
            conn.close()


def _parse_ts_param(value: Optional[str]) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        numeric = float(value)
        if numeric > 1e12:
            return numeric / 1000.0
        return numeric
    except ValueError:
        pass
    try:
        normalized = value.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized).timestamp()
    except ValueError:
        return None


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def query_telemetry_history(
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 5000,
) -> list[dict[str, Any]]:
    start_ts = _parse_ts_param(start)
    end_ts = _parse_ts_param(end)
    limit = max(1, min(limit, 50000))

    clauses: list[str] = []
    params: list[Any] = []
    if start_ts is not None:
        clauses.append("collected_at >= ?")
        params.append(start_ts)
    if end_ts is not None:
        clauses.append("collected_at <= ?")
        params.append(end_ts)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    sql = (
        f"SELECT * FROM telemetry_samples {where} "
        f"ORDER BY collected_at ASC LIMIT ?"
    )
    params.append(limit)

    with _db_lock:
        conn = _connect()
        try:
            rows = conn.execute(sql, params).fetchall()
            return [_row_to_dict(row) for row in rows]
        finally:
            conn.close()


def query_fault_history(
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 5000,
) -> list[dict[str, Any]]:
    start_ts = _parse_ts_param(start)
    end_ts = _parse_ts_param(end)
    limit = max(1, min(limit, 50000))

    clauses: list[str] = []
    params: list[Any] = []
    if start_ts is not None:
        clauses.append("last_seen_at >= ?")
        params.append(start_ts)
    if end_ts is not None:
        clauses.append("first_seen_at <= ?")
        params.append(end_ts)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    sql = (
        f"SELECT * FROM fault_events {where} "
        f"ORDER BY last_seen_at ASC LIMIT ?"
    )
    params.append(limit)

    with _db_lock:
        conn = _connect()
        try:
            rows = conn.execute(sql, params).fetchall()
            return [_row_to_dict(row) for row in rows]
        finally:
            conn.close()


def query_recovery_history_full(limit: int = 10000) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 100000))

    with _db_lock:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT entry_json FROM recovery_executions
                ORDER BY id ASC LIMIT ?
                """,
                (limit,),
            ).fetchall()
            results: list[dict[str, Any]] = []
            for row in rows:
                try:
                    results.append(json.loads(row["entry_json"]))
                except json.JSONDecodeError:
                    results.append({"entry_json": row["entry_json"]})
            return results
        finally:
            conn.close()
