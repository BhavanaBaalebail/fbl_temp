"""
SQLite persistence for CM.py / cm16.py telemetry, faults, recovery, and
digital-twin simulation history.

Additive storage layer — does not replace in-memory globals or JSONL files.
Uses Python's built-in sqlite3 only (no SQLAlchemy).

Database path defaults to ./telemetry_history.db next to this module.
Override with env TELEMETRY_DB_PATH (e.g. /home/rvu/telemetry_history.db).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("hardware-monitor.telemetry_db")

_DEFAULT_DB = Path(__file__).resolve().parent / "telemetry_history.db"
TELEMETRY_DB_PATH = Path(os.environ.get("TELEMETRY_DB_PATH", str(_DEFAULT_DB))).expanduser()

RETENTION_SECONDS = 30 * 24 * 60 * 60  # 30 days
CLEANUP_INTERVAL_SECONDS = 60 * 60  # run prune at most once per hour

RANGE_SECONDS = {
    "15m": 15 * 60,
    "1h": 1 * 60 * 60,
    "6h": 6 * 60 * 60,
    "24h": 24 * 60 * 60,
    "7d": 7 * 24 * 60 * 60,
    "30d": 30 * 24 * 60 * 60,
    "snapshot": 15 * 60,
}

# Aggregation bucket sizes (seconds) for /reports/data
AGGREGATION_BUCKETS = {
    "15m": 30,  # 30 seconds
    "snapshot": 30,
    "1h": 60,  # 1 minute
    "6h": 5 * 60,  # 5 minutes
    "24h": 15 * 60,  # 15 minutes
    "7d": 60 * 60,  # 1 hour
    "30d": 4 * 60 * 60,  # 4 hours
}

_db_lock = threading.Lock()
_seen_fault_ids: set[str] = set()
_seen_faults_loaded = False
_last_cleanup_at = 0.0

_ALERT_RE = re.compile(r"^\[([^\]]+)\]\s*(.+)$")


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

TELEMETRY_SAMPLES_DDL = """
CREATE TABLE IF NOT EXISTS telemetry_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collected_at REAL NOT NULL,
    timestamp TEXT,
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
    nic_utilization_percent REAL,
    nic_rx_mbps REAL,
    nic_tx_mbps REAL,
    io_device TEXT,
    io_busy_percent REAL,
    io_read_iops REAL,
    io_write_iops REAL,
    io_total_iops REAL,
    io_read_mb_per_sec REAL,
    io_write_mb_per_sec REAL,
    io_total_mb_per_sec REAL,
    io_queue_depth REAL,
    io_avg_latency_ms REAL,
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
    payload TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    inventory_json TEXT,
    link_health_summary_json TEXT
);
"""

FAULT_EVENTS_DDL = """
CREATE TABLE IF NOT EXISTS fault_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fault_id TEXT NOT NULL UNIQUE,
    timestamp REAL NOT NULL,
    first_seen_at REAL NOT NULL,
    last_seen_at REAL NOT NULL,
    severity TEXT NOT NULL,
    component TEXT,
    metric_name TEXT,
    current_value TEXT,
    threshold_crossed TEXT,
    message TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT,
    source TEXT DEFAULT 'health_summary',
    payload TEXT
);
"""

RECOVERY_EXECUTIONS_DDL = """
CREATE TABLE IF NOT EXISTS recovery_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    collected_at REAL,
    component TEXT,
    action TEXT,
    pid INTEGER,
    process TEXT,
    result TEXT,
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
    payload TEXT NOT NULL,
    entry_json TEXT NOT NULL
);
"""

DIGITAL_TWIN_DDL = """
CREATE TABLE IF NOT EXISTS digital_twin_simulations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    collected_at REAL NOT NULL,
    component TEXT,
    fault TEXT,
    action TEXT,
    pid INTEGER,
    target_process TEXT,
    before_state TEXT,
    predicted_state TEXT,
    risk TEXT,
    confidence REAL,
    prediction_basis TEXT,
    approved INTEGER DEFAULT 0,
    executed INTEGER DEFAULT 0,
    actual_state TEXT,
    prediction_accuracy TEXT,
    result TEXT,
    payload TEXT
);
"""

# Columns that may be missing on older DBs — added via ALTER TABLE.
_TELEMETRY_EXTRA_COLUMNS = [
    ("timestamp", "TEXT"),
    ("nic_utilization_percent", "REAL"),
    ("nic_rx_mbps", "REAL"),
    ("nic_tx_mbps", "REAL"),
    ("io_device", "TEXT"),
    ("io_busy_percent", "REAL"),
    ("io_read_iops", "REAL"),
    ("io_write_iops", "REAL"),
    ("io_total_iops", "REAL"),
    ("io_read_mb_per_sec", "REAL"),
    ("io_write_mb_per_sec", "REAL"),
    ("io_total_mb_per_sec", "REAL"),
    ("io_queue_depth", "REAL"),
    ("io_avg_latency_ms", "REAL"),
    ("payload", "TEXT"),
]

_FAULT_EXTRA_COLUMNS = [
    ("timestamp", "REAL"),
    ("message", "TEXT"),
    ("payload", "TEXT"),
]

_RECOVERY_EXTRA_COLUMNS = [
    ("collected_at", "REAL"),
    ("component", "TEXT"),
    ("pid", "INTEGER"),
    ("process", "TEXT"),
    ("result", "TEXT"),
    ("payload", "TEXT"),
]


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(TELEMETRY_DB_PATH), timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {row["name"] for row in rows}


def _ensure_columns(conn: sqlite3.Connection, table: str, columns: list[tuple[str, str]]) -> None:
    existing = _table_columns(conn, table)
    for name, col_type in columns:
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {col_type}")


def init_db() -> None:
    """Create database file, enable WAL, ensure tables/indexes/columns exist."""
    global _last_cleanup_at
    TELEMETRY_DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    with _db_lock:
        conn = _connect()
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute(TELEMETRY_SAMPLES_DDL)
            conn.execute(FAULT_EVENTS_DDL)
            conn.execute(RECOVERY_EXECUTIONS_DDL)
            conn.execute(DIGITAL_TWIN_DDL)

            _ensure_columns(conn, "telemetry_samples", _TELEMETRY_EXTRA_COLUMNS)
            _ensure_columns(conn, "fault_events", _FAULT_EXTRA_COLUMNS)
            _ensure_columns(conn, "recovery_executions", _RECOVERY_EXTRA_COLUMNS)

            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_telemetry_collected_at "
                "ON telemetry_samples(collected_at)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp "
                "ON telemetry_samples(timestamp)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_fault_timestamp "
                "ON fault_events(timestamp)"
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
                "CREATE INDEX IF NOT EXISTS idx_fault_component "
                "ON fault_events(component)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_recovery_timestamp "
                "ON recovery_executions(timestamp)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_recovery_collected_at "
                "ON recovery_executions(collected_at)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_dt_collected_at "
                "ON digital_twin_simulations(collected_at)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_dt_timestamp "
                "ON digital_twin_simulations(timestamp)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_dt_component "
                "ON digital_twin_simulations(component)"
            )
            conn.commit()
            _load_seen_fault_ids(conn)
            _last_cleanup_at = 0.0
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _utc_iso(ts: Optional[float] = None) -> str:
    when = datetime.fromtimestamp(ts if ts is not None else time.time(), tz=timezone.utc)
    return when.isoformat().replace("+00:00", "Z")


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


def _primary_nic(metrics: dict[str, Any]) -> dict[str, Any]:
    nics = metrics.get("nic") or []
    if not isinstance(nics, list):
        return {}
    sys_m = metrics.get("system") or {}
    default_iface = sys_m.get("default_route_interface")
    up = [
        n for n in nics
        if isinstance(n, dict) and str(n.get("link_state") or "").lower() == "up"
    ]
    if default_iface:
        match = next((n for n in up if n.get("name") == default_iface), None)
        if match:
            return match
    return up[0] if up else (nics[0] if nics and isinstance(nics[0], dict) else {})


def _peak_io_device(metrics: dict[str, Any]) -> dict[str, Any]:
    disk = metrics.get("disk") or {}
    perf = disk.get("performance") or []
    if not isinstance(perf, list) or not perf:
        return {}
    best = None
    best_score = -1.0
    for entry in perf:
        if not isinstance(entry, dict):
            continue
        score = (
            (_num(entry.get("busy_percent")) or 0.0)
            + (_num(entry.get("total_MB_per_sec")) or 0.0)
            + (_num(entry.get("queue_depth")) or 0.0)
        )
        if score >= best_score:
            best_score = score
            best = entry
    return best or {}


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
    nic = _primary_nic(metrics)
    nics = metrics.get("nic") or []
    disk = metrics.get("disk") or {}
    io_dev = _peak_io_device(metrics)
    lh = (link_health or {}).get("health_summary") or {}

    up_nics = [
        n for n in nics
        if isinstance(n, dict) and str(n.get("link_state") or "").lower() == "up"
    ]
    nic_errors = 0
    for n in nics:
        if not isinstance(n, dict):
            continue
        nic_errors += (n.get("rx_errors") or 0) + (n.get("tx_errors") or 0)

    inv_sys = (inventory or {}).get("system") or {}
    io = (inventory or {}).get("io") or {}
    pci = io.get("pci") if isinstance(io, dict) else None
    usb = io.get("usb") if isinstance(io, dict) else None

    mounts = disk.get("mounts") or []
    disk_mounts = [
        {
            "mp": m.get("mountpoint") or m.get("mount"),
            "pct": m.get("usage_percent"),
            "filesystem": m.get("filesystem"),
            "size_gb": m.get("size_gb"),
            "used_gb": m.get("used_gb"),
            "free_gb": m.get("free_gb"),
        }
        for m in mounts
        if isinstance(m, dict)
    ]

    load = cpu.get("load_average") or {}
    payload = json.dumps(metrics, default=str)
    ts_iso = metrics.get("timestamp") or _utc_iso(collected_at)

    return {
        "collected_at": collected_at,
        "timestamp": ts_iso,
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
        "nic_total_count": len(nics) if isinstance(nics, list) else 0,
        "nic_error_count": nic_errors,
        "nic_utilization_percent": _num(nic.get("utilization_percent")),
        "nic_rx_mbps": _num(nic.get("rx_mbps")),
        "nic_tx_mbps": _num(nic.get("tx_mbps")),
        "io_device": io_dev.get("device"),
        "io_busy_percent": _num(io_dev.get("busy_percent")),
        "io_read_iops": _num(io_dev.get("read_IOPS") if io_dev.get("read_IOPS") is not None else io_dev.get("reads_per_sec")),
        "io_write_iops": _num(io_dev.get("write_IOPS") if io_dev.get("write_IOPS") is not None else io_dev.get("writes_per_sec")),
        "io_total_iops": _num(io_dev.get("total_IOPS")),
        "io_read_mb_per_sec": _num(io_dev.get("read_MB_per_sec")),
        "io_write_mb_per_sec": _num(io_dev.get("write_MB_per_sec")),
        "io_total_mb_per_sec": _num(io_dev.get("total_MB_per_sec")),
        "io_queue_depth": _num(io_dev.get("queue_depth")),
        "io_avg_latency_ms": _num(io_dev.get("average_latency_ms")),
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
        "payload": payload,
        "metrics_json": payload,
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
    payload = {
        "component": component,
        "severity": sev_label,
        "description": description,
        "raw": text,
        "source": "health_summary",
    }
    return {
        "fault_id": _fault_id(component, sev_label, description),
        "timestamp": seen_at,
        "first_seen_at": seen_at,
        "last_seen_at": seen_at,
        "severity": sev_label,
        "component": component,
        "metric_name": None,
        "current_value": None,
        "threshold_crossed": None,
        "message": description,
        "description": description,
        "status": "Active",
        "source": "health_summary",
        "payload": json.dumps(payload, default=str),
    }


def _extract_fault_rows(link_health: Optional[dict[str, Any]], seen_at: float) -> list[dict[str, Any]]:
    lh = (link_health or {}).get("health_summary") or {}
    rows: list[dict[str, Any]] = []
    for alert in lh.get("critical_alerts") or []:
        rows.append(_parse_health_alert(alert, "critical", seen_at))
    for alert in lh.get("warnings") or []:
        rows.append(_parse_health_alert(alert, "warning", seen_at))
    return rows


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

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
                    collected_at, timestamp, metrics_timestamp, hostname,
                    cpu_usage_percent, cpu_idle_percent, cpu_user_percent,
                    cpu_system_percent, cpu_iowait_percent, cpu_temperature_celsius,
                    cpu_load_1min, cpu_load_5min, cpu_load_15min, cpu_current_mhz,
                    memory_usage_percent, memory_swap_usage_percent,
                    memory_used_gb, memory_total_gb, memory_available_gb,
                    gpu_temperature_celsius, gpu_utilization_percent,
                    gpu_memory_utilization_percent, gpu_power_draw_watts, gpu_model,
                    uptime_seconds, nic_up_count, nic_total_count, nic_error_count,
                    nic_utilization_percent, nic_rx_mbps, nic_tx_mbps,
                    io_device, io_busy_percent, io_read_iops, io_write_iops, io_total_iops,
                    io_read_mb_per_sec, io_write_mb_per_sec, io_total_mb_per_sec,
                    io_queue_depth, io_avg_latency_ms,
                    lh_score, lh_overall_health, lh_critical_alert_count, lh_warning_count,
                    lh_components_checked, lh_components_with_errors,
                    lh_components_with_warnings, pci_count, usb_count,
                    disk_mounts_json, payload, metrics_json, inventory_json,
                    link_health_summary_json
                ) VALUES (
                    :collected_at, :timestamp, :metrics_timestamp, :hostname,
                    :cpu_usage_percent, :cpu_idle_percent, :cpu_user_percent,
                    :cpu_system_percent, :cpu_iowait_percent, :cpu_temperature_celsius,
                    :cpu_load_1min, :cpu_load_5min, :cpu_load_15min, :cpu_current_mhz,
                    :memory_usage_percent, :memory_swap_usage_percent,
                    :memory_used_gb, :memory_total_gb, :memory_available_gb,
                    :gpu_temperature_celsius, :gpu_utilization_percent,
                    :gpu_memory_utilization_percent, :gpu_power_draw_watts, :gpu_model,
                    :uptime_seconds, :nic_up_count, :nic_total_count, :nic_error_count,
                    :nic_utilization_percent, :nic_rx_mbps, :nic_tx_mbps,
                    :io_device, :io_busy_percent, :io_read_iops, :io_write_iops, :io_total_iops,
                    :io_read_mb_per_sec, :io_write_mb_per_sec, :io_total_mb_per_sec,
                    :io_queue_depth, :io_avg_latency_ms,
                    :lh_score, :lh_overall_health, :lh_critical_alert_count, :lh_warning_count,
                    :lh_components_checked, :lh_components_with_errors,
                    :lh_components_with_warnings, :pci_count, :usb_count,
                    :disk_mounts_json, :payload, :metrics_json, :inventory_json,
                    :link_health_summary_json
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
                        SET last_seen_at = ?, timestamp = ?, status = 'Active'
                        WHERE fault_id = ?
                        """,
                        (collected_at, collected_at, fault_id),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO fault_events (
                            fault_id, timestamp, first_seen_at, last_seen_at, severity,
                            component, metric_name, current_value, threshold_crossed,
                            message, description, status, source, payload
                        ) VALUES (
                            :fault_id, :timestamp, :first_seen_at, :last_seen_at, :severity,
                            :component, :metric_name, :current_value, :threshold_crossed,
                            :message, :description, :status, :source, :payload
                        )
                        """,
                        fault,
                    )
                    _seen_fault_ids.add(fault_id)

            conn.commit()
        finally:
            conn.close()

    maybe_cleanup()


def insert_recovery_execution(entry: dict[str, Any]) -> None:
    """Persist one recovery audit record. Does not change recovery behavior."""
    payload = dict(entry)
    collected_at = time.time()
    timestamp = payload.get("timestamp") or _utc_iso(collected_at)
    params = payload.get("params") or {}
    fault = payload.get("fault") or {}
    pid = params.get("pid") if isinstance(params, dict) else None
    process = None
    if isinstance(params, dict):
        process = params.get("process") or params.get("processName") or params.get("name")
    if process is None and isinstance(fault, dict):
        process = fault.get("process") or fault.get("processName")

    component = None
    if isinstance(fault, dict):
        component = fault.get("component")
    if not component and payload.get("action"):
        component = str(payload.get("action")).split(".", 1)[0].upper()

    success = payload.get("success")
    result = "success" if success else "failed" if success is not None else None
    entry_json = json.dumps(payload, default=str)

    with _db_lock:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO recovery_executions (
                    timestamp, collected_at, component, action, pid, process, result,
                    success, message, command, stdout, stderr, returncode, duration_seconds,
                    params_json, fault_json, confirmation_json, before_metrics_json,
                    after_metrics_json, payload, entry_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    timestamp,
                    collected_at,
                    component,
                    payload.get("action"),
                    _int(pid),
                    process,
                    result,
                    1 if success else 0 if success is not None else None,
                    payload.get("message"),
                    payload.get("command"),
                    payload.get("stdout"),
                    payload.get("stderr"),
                    payload.get("returncode"),
                    payload.get("duration_seconds"),
                    json.dumps(params, default=str) if params is not None else None,
                    json.dumps(fault, default=str) if fault is not None else None,
                    json.dumps(payload.get("confirmation"), default=str)
                    if payload.get("confirmation") is not None
                    else None,
                    json.dumps(payload.get("before_metrics"), default=str)
                    if payload.get("before_metrics") is not None
                    else None,
                    json.dumps(payload.get("after_metrics"), default=str)
                    if payload.get("after_metrics") is not None
                    else None,
                    entry_json,
                    entry_json,
                ),
            )
            conn.commit()
        finally:
            conn.close()


def record_digital_twin_simulation(record: dict[str, Any]) -> int:
    """Insert a side-effect-free digital twin simulation record. Returns row id."""
    collected_at = time.time()
    timestamp = record.get("timestamp") or _utc_iso(collected_at)
    payload = dict(record)
    payload.setdefault("collected_at", collected_at)
    payload.setdefault("timestamp", timestamp)

    with _db_lock:
        conn = _connect()
        try:
            cur = conn.execute(
                """
                INSERT INTO digital_twin_simulations (
                    timestamp, collected_at, component, fault, action, pid, target_process,
                    before_state, predicted_state, risk, confidence, prediction_basis,
                    approved, executed, actual_state, prediction_accuracy, result, payload
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    timestamp,
                    collected_at,
                    record.get("component"),
                    record.get("fault"),
                    record.get("action"),
                    _int(record.get("pid")),
                    record.get("target_process"),
                    json.dumps(record.get("before_state"), default=str)
                    if record.get("before_state") is not None
                    else None,
                    json.dumps(record.get("predicted_state"), default=str)
                    if record.get("predicted_state") is not None
                    else None,
                    record.get("risk"),
                    _num(record.get("confidence")),
                    record.get("prediction_basis"),
                    1 if record.get("approved") else 0,
                    1 if record.get("executed") else 0,
                    json.dumps(record.get("actual_state"), default=str)
                    if record.get("actual_state") is not None
                    else None,
                    record.get("prediction_accuracy"),
                    record.get("result"),
                    json.dumps(payload, default=str),
                ),
            )
            conn.commit()
            return int(cur.lastrowid)
        finally:
            conn.close()


def update_digital_twin_simulation(simulation_id: int, updates: dict[str, Any]) -> bool:
    """Associate a later real recovery outcome with a prior simulation."""
    allowed = {
        "approved",
        "executed",
        "actual_state",
        "prediction_accuracy",
        "result",
        "payload",
    }
    fields = []
    values: list[Any] = []
    for key, value in updates.items():
        if key not in allowed:
            continue
        if key in ("approved", "executed"):
            fields.append(f"{key} = ?")
            values.append(1 if value else 0)
        elif key in ("actual_state", "payload") and not isinstance(value, str):
            fields.append(f"{key} = ?")
            values.append(json.dumps(value, default=str))
        else:
            fields.append(f"{key} = ?")
            values.append(value)
    if not fields:
        return False
    values.append(simulation_id)

    with _db_lock:
        conn = _connect()
        try:
            cur = conn.execute(
                f"UPDATE digital_twin_simulations SET {', '.join(fields)} WHERE id = ?",
                values,
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------

def prune_older_than(retention_seconds: int = RETENTION_SECONDS) -> dict[str, int]:
    """Delete rows older than retention window. Safe to call periodically."""
    cutoff = time.time() - retention_seconds
    deleted = {
        "telemetry_samples": 0,
        "fault_events": 0,
        "recovery_executions": 0,
        "digital_twin_simulations": 0,
    }

    with _db_lock:
        conn = _connect()
        try:
            cur = conn.execute(
                "DELETE FROM telemetry_samples WHERE collected_at < ?", (cutoff,)
            )
            deleted["telemetry_samples"] = cur.rowcount

            cur = conn.execute(
                "DELETE FROM fault_events WHERE last_seen_at < ?", (cutoff,)
            )
            deleted["fault_events"] = cur.rowcount

            # recovery timestamps are ISO text; also use collected_at when present
            cur = conn.execute(
                """
                DELETE FROM recovery_executions
                WHERE (collected_at IS NOT NULL AND collected_at < ?)
                   OR (collected_at IS NULL AND timestamp < ?)
                """,
                (cutoff, _utc_iso(cutoff)),
            )
            deleted["recovery_executions"] = cur.rowcount

            cur = conn.execute(
                "DELETE FROM digital_twin_simulations WHERE collected_at < ?",
                (cutoff,),
            )
            deleted["digital_twin_simulations"] = cur.rowcount

            conn.commit()
            # reclaim space occasionally after large deletes
            if sum(deleted.values()) > 1000:
                conn.execute("PRAGMA optimize")
        finally:
            conn.close()

    if sum(deleted.values()) > 0:
        logger.info("Telemetry retention prune: %s (cutoff=%s)", deleted, _utc_iso(cutoff))
    return deleted


def maybe_cleanup() -> None:
    """Run retention prune at most once per CLEANUP_INTERVAL_SECONDS."""
    global _last_cleanup_at
    now = time.time()
    if now - _last_cleanup_at < CLEANUP_INTERVAL_SECONDS:
        return
    _last_cleanup_at = now
    try:
        prune_older_than(RETENTION_SECONDS)
    except Exception:
        logger.exception("Telemetry retention cleanup failed")


# ---------------------------------------------------------------------------
# Query helpers
# ---------------------------------------------------------------------------

def _parse_ts_param(value: Optional[str]) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        numeric = float(value)
        if numeric > 1e12:  # ms epoch
            return numeric / 1000.0
        return numeric
    except ValueError:
        pass
    try:
        normalized = value.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized).timestamp()
    except ValueError:
        return None


def resolve_time_window(
    start: Optional[str] = None,
    end: Optional[str] = None,
    range_key: Optional[str] = None,
) -> tuple[Optional[float], Optional[float], Optional[str]]:
    """Return (start_ts, end_ts, normalized_range_key). Prefer explicit start/end."""
    end_ts = _parse_ts_param(end) if end is not None else time.time()
    start_ts = _parse_ts_param(start) if start is not None else None
    key = (range_key or "").strip().lower() or None

    if start_ts is None and key in RANGE_SECONDS:
        start_ts = end_ts - RANGE_SECONDS[key]
    elif start_ts is None and key is None:
        # default: last 1 hour
        key = "1h"
        start_ts = end_ts - RANGE_SECONDS["1h"]

    return start_ts, end_ts, key


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def query_telemetry_history(
    start: Optional[str] = None,
    end: Optional[str] = None,
    range_key: Optional[str] = None,
    limit: int = 5000,
) -> list[dict[str, Any]]:
    start_ts, end_ts, _ = resolve_time_window(start, end, range_key)
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
    range_key: Optional[str] = None,
    limit: int = 5000,
) -> list[dict[str, Any]]:
    start_ts, end_ts, _ = resolve_time_window(start, end, range_key)
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


def query_recovery_history_full(
    start: Optional[str] = None,
    end: Optional[str] = None,
    range_key: Optional[str] = None,
    limit: int = 10000,
) -> list[dict[str, Any]]:
    start_ts, end_ts, _ = resolve_time_window(start, end, range_key) if (start or end or range_key) else (None, None, None)
    limit = max(1, min(limit, 100000))

    clauses: list[str] = []
    params: list[Any] = []
    if start_ts is not None:
        clauses.append("(collected_at IS NULL OR collected_at >= ?)")
        params.append(start_ts)
    if end_ts is not None:
        clauses.append("(collected_at IS NULL OR collected_at <= ?)")
        params.append(end_ts)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    sql = (
        f"SELECT entry_json, payload FROM recovery_executions {where} "
        f"ORDER BY id ASC LIMIT ?"
    )
    params.append(limit)

    with _db_lock:
        conn = _connect()
        try:
            rows = conn.execute(sql, params).fetchall()
            results: list[dict[str, Any]] = []
            for row in rows:
                raw = row["entry_json"] or row["payload"]
                try:
                    results.append(json.loads(raw))
                except (TypeError, json.JSONDecodeError):
                    results.append({"entry_json": raw})
            return results
        finally:
            conn.close()


def get_digital_twin_history(
    start: Optional[str] = None,
    end: Optional[str] = None,
    range_key: Optional[str] = None,
    limit: int = 5000,
) -> list[dict[str, Any]]:
    start_ts, end_ts, _ = resolve_time_window(start, end, range_key) if (start or end or range_key) else (None, None, None)
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
        f"SELECT * FROM digital_twin_simulations {where} "
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


def _avg(values: list[float]) -> Optional[float]:
    if not values:
        return None
    return round(sum(values) / len(values), 4)


def _aggregate_samples(samples: list[dict[str, Any]], bucket_seconds: int) -> list[dict[str, Any]]:
    if not samples or bucket_seconds <= 0:
        return samples

    buckets: dict[int, list[dict[str, Any]]] = {}
    for sample in samples:
        ts = sample.get("collected_at")
        if ts is None:
            continue
        key = int(ts // bucket_seconds) * bucket_seconds
        buckets.setdefault(key, []).append(sample)

    aggregated: list[dict[str, Any]] = []
    metric_keys = [
        "cpu_usage_percent",
        "cpu_temperature_celsius",
        "cpu_load_1min",
        "memory_usage_percent",
        "memory_swap_usage_percent",
        "memory_available_gb",
        "gpu_utilization_percent",
        "gpu_memory_utilization_percent",
        "gpu_temperature_celsius",
        "nic_utilization_percent",
        "nic_rx_mbps",
        "nic_tx_mbps",
        "nic_error_count",
        "io_busy_percent",
        "io_read_iops",
        "io_write_iops",
        "io_total_iops",
        "io_read_mb_per_sec",
        "io_write_mb_per_sec",
        "io_total_mb_per_sec",
        "io_queue_depth",
        "io_avg_latency_ms",
        "lh_score",
    ]

    for key in sorted(buckets.keys()):
        group = buckets[key]
        mid = group[len(group) // 2]
        out = {
            "collected_at": key,
            "timestamp": _utc_iso(key),
            "sample_count": len(group),
            "aggregated": True,
            "bucket_seconds": bucket_seconds,
            "hostname": mid.get("hostname"),
            "io_device": mid.get("io_device"),
            "gpu_model": mid.get("gpu_model"),
            "lh_overall_health": mid.get("lh_overall_health"),
        }
        for mk in metric_keys:
            vals = [float(s[mk]) for s in group if s.get(mk) is not None]
            out[mk] = _avg(vals)
        # Keep a representative payload from the mid sample for detail views
        out["payload"] = mid.get("payload") or mid.get("metrics_json")
        aggregated.append(out)
    return aggregated


def _coverage_block(
    requested_start: Optional[float],
    requested_end: Optional[float],
    samples: list[dict[str, Any]],
    fault_count: int,
    recovery_count: int,
    digital_twin_count: int,
    db_stats: dict[str, Any],
) -> dict[str, Any]:
    """Compute requested vs available historical coverage (no fabricated fill)."""
    req_start = requested_start
    req_end = requested_end if requested_end is not None else time.time()
    requested_seconds = max(0.0, (req_end - req_start)) if req_start is not None else None

    sample_times = [
        float(s["collected_at"])
        for s in samples
        if s.get("collected_at") is not None
    ]
    available_start = min(sample_times) if sample_times else None
    available_end = max(sample_times) if sample_times else None
    available_seconds = (
        max(0.0, available_end - available_start)
        if available_start is not None and available_end is not None
        else 0.0
    )

    db_min = (db_stats.get("telemetry_samples") or {}).get("min_collected_at")
    db_max = (db_stats.get("telemetry_samples") or {}).get("max_collected_at")

    coverage_pct = None
    missing_seconds = None
    if requested_seconds and requested_seconds > 0:
        # Coverage is the overlap of available samples with the requested window.
        coverage_pct = round(min(100.0, (available_seconds / requested_seconds) * 100.0), 2)
        missing_seconds = max(0.0, requested_seconds - available_seconds)

    if not sample_times:
        status = "EMPTY"
        notice = (
            "No historical telemetry is available in the database for the "
            "requested reporting period."
        )
    elif (
        requested_seconds
        and available_seconds + 60 < requested_seconds  # allow ~1 minute slack
    ):
        status = "PARTIAL"
        notice = (
            f"Historical telemetry is available from {_utc_iso(available_start)} onward. "
            "No telemetry was available in the database for the earlier portion "
            "of the requested reporting period."
        )
    else:
        status = "COMPLETE"
        notice = "Historical telemetry fully covers the requested reporting period."

    return {
        "requestedStart": req_start,
        "requestedEnd": req_end,
        "requestedStartIso": _utc_iso(req_start) if req_start is not None else None,
        "requestedEndIso": _utc_iso(req_end) if req_end is not None else None,
        "availableStart": available_start,
        "availableEnd": available_end,
        "availableStartIso": _utc_iso(available_start) if available_start is not None else None,
        "availableEndIso": _utc_iso(available_end) if available_end is not None else None,
        "databaseStart": db_min,
        "databaseEnd": db_max,
        "databaseStartIso": _utc_iso(db_min) if db_min is not None else None,
        "databaseEndIso": _utc_iso(db_max) if db_max is not None else None,
        "requestedSeconds": requested_seconds,
        "availableSeconds": available_seconds,
        "missingSeconds": missing_seconds,
        "coveragePercent": coverage_pct,
        "status": status,
        "notice": notice,
        "telemetrySampleCount": len(samples),
        "faultEventCount": fault_count,
        "recoveryEventCount": recovery_count,
        "digitalTwinCount": digital_twin_count,
        "retentionDays": RETENTION_SECONDS / (24 * 60 * 60),
    }


def query_report_data(
    start: Optional[str] = None,
    end: Optional[str] = None,
    range_key: Optional[str] = None,
    aggregate: bool = True,
    limit: int = 20000,
) -> dict[str, Any]:
    """Bundle telemetry + faults + recovery (+ digital twin) for report generation."""
    start_ts, end_ts, key = resolve_time_window(start, end, range_key)
    # Snapshot reports use a short recent window from SQLite (not live /metrics).
    if key == "snapshot":
        start_ts, end_ts, key = resolve_time_window(None, None, "snapshot")

    samples = query_telemetry_history(
        start=str(start_ts) if start_ts is not None else None,
        end=str(end_ts) if end_ts is not None else None,
        limit=limit,
    )
    bucket = AGGREGATION_BUCKETS.get(key or "", 0) if aggregate else 0
    telemetry = _aggregate_samples(samples, bucket) if bucket else samples

    faults = query_fault_history(
        start=str(start_ts) if start_ts is not None else None,
        end=str(end_ts) if end_ts is not None else None,
        limit=limit,
    )
    recovery = query_recovery_history_full(
        start=str(start_ts) if start_ts is not None else None,
        end=str(end_ts) if end_ts is not None else None,
        limit=limit,
    )
    digital_twin = get_digital_twin_history(
        start=str(start_ts) if start_ts is not None else None,
        end=str(end_ts) if end_ts is not None else None,
        limit=limit,
    )

    db_stats = get_database_stats()
    coverage = _coverage_block(
        start_ts,
        end_ts,
        samples,
        len(faults),
        len(recovery),
        len(digital_twin),
        db_stats,
    )

    return {
        "start": start_ts,
        "end": end_ts,
        "range": key,
        "reportPeriod": {
            "range": key,
            "requestedStart": start_ts,
            "requestedEnd": end_ts,
            "requestedStartIso": coverage["requestedStartIso"],
            "requestedEndIso": coverage["requestedEndIso"],
        },
        "dataCoverage": coverage,
        "aggregated": bool(bucket),
        "bucket_seconds": bucket or None,
        "telemetry": telemetry,
        "telemetry_raw_count": len(samples),
        "telemetry_count": len(telemetry),
        "faults": faults,
        "fault_count": len(faults),
        "recovery_history": recovery,
        "recovery_count": len(recovery),
        "digital_twin_simulations": digital_twin,
        "digital_twin_count": len(digital_twin),
        "generated_at": _utc_iso(),
        "database": str(TELEMETRY_DB_PATH),
        "databaseStats": db_stats,
    }


def get_database_stats() -> dict[str, Any]:
    with _db_lock:
        conn = _connect()
        try:
            stats: dict[str, Any] = {"path": str(TELEMETRY_DB_PATH)}
            for table in (
                "telemetry_samples",
                "fault_events",
                "recovery_executions",
                "digital_twin_simulations",
            ):
                count = conn.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"]
                stats[table] = {"count": count}
            row = conn.execute(
                "SELECT MIN(collected_at) AS mn, MAX(collected_at) AS mx FROM telemetry_samples"
            ).fetchone()
            stats["telemetry_samples"]["min_collected_at"] = row["mn"]
            stats["telemetry_samples"]["max_collected_at"] = row["mx"]
            if row["mn"] is not None:
                stats["telemetry_samples"]["min_timestamp"] = _utc_iso(row["mn"])
            if row["mx"] is not None:
                stats["telemetry_samples"]["max_timestamp"] = _utc_iso(row["mx"])
            return stats
        finally:
            conn.close()
