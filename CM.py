#!/usr/bin/env python3
"""
collect_metrics_final.py
=========================

Production-ready Ubuntu hardware monitoring agent.

Continuously collects hardware inventory, live performance metrics, and
interconnect/link health data from a Linux (Ubuntu) host and exposes them
through a small Flask REST API consumed by a vanilla HTML/CSS/JS dashboard.

This build adds an INTERNAL FUNCTIONAL BLOCK LEDGER on top of the existing
component health engine: every named functional block in the hardware
architecture (CPU, RAM, GPU, IO Controller, MGMT, NIC, PSU, Disk) is mapped
to the real Linux/Ubuntu command(s) that inspect it, and the raw diagnostic
text is captured every collection cycle alongside the quantitative counters
(AER errors, ECC counts, SMART fields, GPU XID/ECC, etc).

Design note on scope: the ledger is ADDITIVE, not a replacement for the
counter-based health engine. The block-mapped commands (lspci -vv | grep ...,
sensors, i2cdetect, etc.) return free-form text, not structured counters, so
they cannot reliably drive Critical/Warning scoring on their own -- doing so
would trade a validated, counter-based health engine for a noisy grep-based
one and would be a regression, not an upgrade. Instead the ledger is
attached as its own top-level section (with a conservative "ok"/"warning"/
"unavailable"/"not_queryable" per-block status) and its own list of
diagnostic_notes in the health summary, while the existing PCIe AER / ECC /
SMART / GPU XID engine remains authoritative for overall_health and score.

Trial2 changes (additive only -- nothing from Trial1 was removed):
  * New top-level collectors: get_chassis_inventory() (DMI type 3 --
    chassis type/asset tag/boot-up state/power state/thermal state/
    security status), get_voltage_probes() (DMI type 26 -- SMBIOS-reported
    voltage rail probes, a real motherboard-level source for Vcore/12V/5V/
    3.3V that doesn't depend on a Super-I/O hwmon driver being bound),
    get_cooling_devices() (DMI type 27 -- SMBIOS fan/cooling device probes
    incl. nominal speed when the board reports it), get_battery_health()
    and get_power_supply_status() (/sys/class/power_supply -- battery/AC
    status, harmless no-op on desktops with no battery).
  * get_hwmon_health() extended (additively) to also capture fan*_input
    RPM readings per chip, alongside the existing temperature/voltage
    readings.
  * BLOCK_REGISTRY: existing blocks that were previously "no_data" on
    boards without a bound Super-I/O sensor chip (CPU Vcore VRM, EPS 12V,
    ATX12V, Standby 5VSB, eSPI Bus) now also try the DMI voltage-probe /
    hwmon-sysfs / journalctl fallbacks above, and new blocks (Voltage
    Probes (DMI), Cooling Device (DMI), Chassis State) were added under
    PSU/MGMT so the SMBIOS-level data has a ledger entry too.
  * New report keys in collect_link_health(): "chassis", "voltage_probes",
    "cooling_devices", "battery", "power_supply".
  * compute_health_summary() gained light, conservative checks for chassis
    thermal/power-supply state and low battery, surfaced as
    warnings/informational the same way the rest of the engine already
    works -- never overriding the existing counter-based verdicts.

Trial3 changes (additive only -- nothing from Trial1/Trial2 was removed):
  * BLOCK_REGISTRY entries for blocks that were flagged "present but no
    telemetry" or "pending" in the Trial2 coverage audit (CPU Vcore VRM,
    EPS 12V, ATX12V, eSPI Bus, NVMe Command Queue, GPU 12VHPWR Power,
    GPU PCIe DMA, SAS Controller, PMBus / PMBus Alerts, Dedicated IPMI
    Port, PCIe Slot, BMC Shared NIC, Standby 5VSB) each gained one or more
    EXTRA diagnostic commands appended to their existing command list, to
    squeeze out additional real telemetry or a cleaner absence signal
    where the underlying hardware genuinely doesn't expose more. No
    existing tuple in any block's command list was removed or reordered;
    all additions are appended at the end of each block's list so prior
    output keys/order are preserved.

Trial4 changes (additive only -- nothing from Trial1/Trial2/Trial3 was
removed):
  * Recovery action handlers for cpu.kill_process, ram.terminate_process,
    and gpu.terminate_process now use an unconditional `kill -9` (SIGKILL)
    rather than the earlier SIGKILL/SIGTERM-via-signal-module path, with
    explicit before/after /proc existence checks and dedicated logging.
    This was originally shipped as an out-of-band monkeypatch module; it
    is now integrated directly into the Recovery Action Registry below so
    there is a single, readable implementation instead of a runtime patch.

Trial5 changes (additive only -- nothing from Trial1/Trial2/Trial3/Trial4
was removed):
  * NIC LIVE THROUGHPUT/UTILIZATION/LOSS-RATE METRICS: get_nic_metrics()
    now additionally computes, per interface, rx/tx bytes-per-second,
    rx/tx MB-per-second, rx/tx packets-per-second, rx/tx utilization
    percent (via negotiated link speed from ethtool), and rx/tx drop-rate
    / error-rate percent -- all derived from deltas between successive
    polls of the same cumulative /proc/net/dev counters this file
    already collected.
  * DISK / IO LIVE PERFORMANCE METRICS: get_disk_performance_metrics()
    reads live per-device throughput/IOPS/busy%/latency/queue depth from
    /sys/block/<dev>/stat; output is attached as "performance" inside
    get_disk_metrics() alongside existing "mounts" and "smart" keys.
  * Previous-cycle sample caches (_PREV_NIC_STATS, _PREV_DISK_STATS)
    guarded by _metrics_delta_lock; first sample returns null rates.

Trial6 changes (additive only -- nothing from Trial1/Trial2/Trial3/Trial4/
Trial5 was removed):
  * NIC PROCESS ATTRIBUTION + NIC SELF-HEALING: get_top_nic_processes()
    ranks whatever process is actually pushing the most bytes through the
    NIC right now (sent+received KB/s), using `nethogs -t -c 1` for
    per-process bandwidth attribution -- the NIC-domain equivalent of the
    existing get_top_cpu_processes()/get_top_disk_io_processes(). It is
    deliberately tool-agnostic: it doesn't special-case iperf3 (or any
    other traffic generator/offender) -- it ranks by observed bandwidth,
    so it self-heals ANY NIC-saturating process, not just one specific
    tool. get_recovery_process_candidates() gained a "nic" domain that
    reuses this ranking (mirroring the existing cpu/gpu/disk domains) so
    the frontend can list every meaningful network consumer, not just the
    single biggest one.
  * Four new whitelisted recovery actions -- nic.pause_process (SIGSTOP),
    nic.resume_process (SIGCONT), nic.terminate_process (SIGTERM, verified
    gone), nic.kill_process (unconditional kill -9, verified gone) -- are
    registered in RECOVERY_ACTIONS alongside the existing interface-level
    NIC actions (nic.restart_interface, nic.renew_dhcp,
    nic.restart_network_manager, nic.reload_driver). Together this gives
    NIC recovery the same two tiers CPU/GPU/RAM/Disk already have:
    process-level (pause/resume/terminate/kill the offending PID) and
    subsystem-level (restart/renew/reload the interface itself). All four
    go through the exact same validate_pid()/_recovery_signal()/
    _recovery_force_kill() machinery already used by cpu.*/ram.*/gpu.*/
    disk.* -- no new validation or execution code paths were introduced.
  * collect_metrics()'s "top_processes" block gained a "nic" key
    (get_top_nic_processes(limit=20)), matching the existing cpu/gpu/disk
    keys, and /recovery/process_candidates now accepts domain=nic.

Run:
    pip install -r requirements.txt
    python3 collect_metrics2_Trial2.py

Then open:
    http://localhost:5000
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import logging
import os
import platform
import re
import shutil
import signal
import socket
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from flask import Flask, jsonify, request
from flask_cors import CORS

import telemetry_db

try:
    import fbl_utilities
except Exception:  # noqa: BLE001
    fbl_utilities = None  # type: ignore

try:
    import fbl_chatbot
except Exception:  # noqa: BLE001
    fbl_chatbot = None  # type: ignore

try:
    import fbl_email
except Exception:  # noqa: BLE001
    fbl_email = None  # type: ignore

try:
    import fbl_incident_analysis
except Exception:  # noqa: BLE001
    fbl_incident_analysis = None  # type: ignore



# --------------------------------------------------------------------------
# Configuration & Logging
# --------------------------------------------------------------------------

INVENTORY_FILE = "inventory.json"

DEFAULT_TIMEOUT = 10
LONG_TIMEOUT = 30
MAX_KERNEL_EVENTS_PER_CATEGORY = 25

PCI_DEVICES_PATH = Path("/sys/bus/pci/devices")
IOMMU_GROUPS_PATH = Path("/sys/kernel/iommu_groups")
ATA_LINK_CLASS_PATH = Path("/sys/class/ata_link")
ATA_PORT_CLASS_PATH = Path("/sys/class/ata_port")
USB_DEVICES_PATH = Path("/sys/bus/usb/devices")
NVME_CLASS_PATH = Path("/sys/class/nvme")
NET_CLASS_PATH = Path("/sys/class/net")
EDAC_MC_PATH = Path("/sys/devices/system/edac/mc")
POWERCAP_PATH = Path("/sys/class/powercap")
THERMAL_CLASS_PATH = Path("/sys/class/thermal")
HWMON_CLASS_PATH = Path("/sys/class/hwmon")
CPUFREQ_PATH = Path("/sys/devices/system/cpu")
EFI_PATH = Path("/sys/firmware/efi")
POWER_SUPPLY_CLASS_PATH = Path("/sys/class/power_supply")
BLOCK_CLASS_PATH = Path("/sys/block")

_AER_FILES = ["aer_dev_correctable", "aer_dev_nonfatal", "aer_dev_fatal"]

INSTALL_HINT = (
    "sudo apt install dmidecode lm-sensors ipmitool smartmontools nvme-cli "
    "lsscsi ethtool pciutils i2c-tools rdma-core tpm2-tools lshw hdparm fwupd "
    "msr-tools nethogs"
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("hardware-monitor")

# Global cache, guarded by a lock since the background thread writes
# to it while Flask request threads read from it.
_state_lock = threading.Lock()
LATEST_INVENTORY: dict[str, Any] = {}
LATEST_METRICS: dict[str, Any] = {}
LATEST_LINK_HEALTH: dict[str, Any] = {}
# Per-collection-cycle command cache so repeated identical subprocess calls
# within a single collect_* pass (e.g. multiple callers needing `lscpu` or
# `lspci -vv`) are only shelled out once. Cleared at the start of every
# updater_loop() tick (see below) so live metrics/link-health data never
# goes stale between cycles.
_CMD_CACHE: dict[tuple, str] = {}

# Trial5: previous-sample state for delta-based live performance metrics
_metrics_delta_lock = threading.Lock()
_PREV_NIC_STATS: dict[str, dict[str, Any]] = {}
_LATEST_NIC_METRICS: list[dict[str, Any]] = []
_PREV_DISK_STATS: dict[str, dict[str, Any]] = {}


# ============================================================================
# DEMO: MANUAL SYNTHETIC FAULT INJECTION (RAM / DISK / NIC / IO Controller)
# ----------------------------------------------------------------------------
# Inlined from fault_injector.py so the whole thing runs as ONE file/process.
# Severity is set manually via the /demo/<component>/<severity> routes near
# the bottom of this file. Values ramp toward the target over RAMP_SECONDS
# rather than jumping instantly. CPU/GPU are never touched -- drive those
# with real load. Injection only ever writes to fields that already exist
# in the JSON schema; no keys are added or removed.
# ============================================================================


VALID_COMPONENTS = ("ram", "disk", "nic", "io_controller")
VALID_SEVERITIES = ("healthy", "warning", "critical")

RAMP_SECONDS = 60.0  # time to go from healthy baseline to full target severity

# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------

_state: dict[str, dict[str, Any]] = {
    c: {"severity": "healthy", "since": time.time()} for c in VALID_COMPONENTS
}


def set_severity(component: str, severity: str) -> tuple[bool, str]:
    component = (component or "").lower()
    severity = (severity or "").lower()
    if component not in VALID_COMPONENTS:
        return False, f"unknown component '{component}', expected one of {VALID_COMPONENTS}"
    if severity not in VALID_SEVERITIES:
        return False, f"unknown severity '{severity}', expected one of {VALID_SEVERITIES}"
    if _state[component]["severity"] != severity:
        _state[component] = {"severity": severity, "since": time.time()}
    return True, "ok"


def get_state() -> dict[str, Any]:
    now = time.time()
    return {
        c: {
            "severity": s["severity"],
            "elapsed_seconds": round(now - s["since"], 1),
            "ramp_progress": round(min((now - s["since"]) / RAMP_SECONDS, 1.0), 2),
        }
        for c, s in _state.items()
    }


def reset_all() -> None:
    now = time.time()
    for c in VALID_COMPONENTS:
        _state[c] = {"severity": "healthy", "since": now}


def _progress(component: str) -> float:
    """0.0 (just switched) -> 1.0 (fully ramped in) for the given component."""
    s = _state[component]
    if s["severity"] == "healthy":
        return 0.0
    return min((time.time() - s["since"]) / RAMP_SECONDS, 1.0)


def _lerp(lo: float, hi: float, t: float) -> float:
    return lo + (hi - lo) * t


def _lerp_int(lo: int, hi: int, t: float) -> int:
    return int(round(_lerp(lo, hi, t)))


# --------------------------------------------------------------------------
# RAM
# --------------------------------------------------------------------------

def _inject_ram(report: dict[str, Any]) -> None:
    severity = _state["ram"]["severity"]
    t = _progress("ram")
    mem_health = ((report.get("memory") or {}).get("health")) or {}
    controllers = mem_health.get("controllers") or []
    if not controllers:
        return

    if severity == "healthy":
        return

    if severity == "warning":
        ce = _lerp_int(0, 50, t)
        mem_health["correctable_errors"] = ce
        mem_health["uncorrectable_errors"] = 0
        mem_health["memory_controller_errors"] = 0
        controllers[0]["correctable_errors"] = ce
        controllers[0]["uncorrectable_errors"] = 0
        controllers[0]["dimm_failures"] = (
            [{"row": "csrow0", "correctable_errors": ce, "uncorrectable_errors": 0}] if ce > 0 else []
        )

    elif severity == "critical":
        ce = 50
        ue = _lerp_int(0, 3, t)
        mem_health["correctable_errors"] = ce
        mem_health["uncorrectable_errors"] = ue
        mem_health["memory_controller_errors"] = ue
        controllers[0]["correctable_errors"] = ce
        controllers[0]["uncorrectable_errors"] = ue
        controllers[0]["dimm_failures"] = [
            {"row": "csrow0", "correctable_errors": ce, "uncorrectable_errors": ue}
        ]


def _inject_ram_metrics(metrics: dict[str, Any]) -> None:
    severity = _state["ram"]["severity"]
    t = _progress("ram")
    mem = metrics.get("memory") or {}
    if not mem or severity == "healthy":
        return

    total_gb = mem.get("total_gb") or 15.25
    if severity == "warning":
        usage_pct = _lerp(30.0, 88.0, t)
        swap_pct = _lerp(0.0, 30.0, t)
    else:  # critical
        usage_pct = _lerp(30.0, 97.0, t)
        swap_pct = _lerp(0.0, 75.0, t)

    used_gb = round(total_gb * usage_pct / 100.0, 2)
    mem["usage_percent"] = round(usage_pct, 2)
    mem["used_gb"] = used_gb
    mem["available_gb"] = round(max(total_gb - used_gb, 0.05), 2)
    mem["free_gb"] = round(max(total_gb - used_gb - mem.get("cached_gb", 0) - mem.get("buffers_gb", 0), 0.02), 2)
    swap_total = mem.get("swap_total_gb") or 4.0
    mem["swap_usage_percent"] = round(swap_pct, 2)
    mem["swap_used_gb"] = round(swap_total * swap_pct / 100.0, 2)
    mem["swap_free_gb"] = round(max(swap_total - mem["swap_used_gb"], 0), 2)


# --------------------------------------------------------------------------
# DISK (NVMe)
# --------------------------------------------------------------------------

def _inject_disk(report: dict[str, Any]) -> None:
    severity = _state["disk"]["severity"]
    t = _progress("disk")
    nvme_list = report.get("nvme") or []
    if not nvme_list or severity == "healthy":
        return

    dev = nvme_list[0]

    if severity == "warning":
        dev["percentage_used"] = _lerp_int(50, 95, t)
        dev["available_spare"] = _lerp_int(100, 25, t)
        dev["temperature"] = _lerp_int(30, 78, t)
        dev["warning_temp_time"] = _lerp_int(0, 300, t)
        dev["num_err_log_entries"] = _lerp_int(0, 5, t)
        dev["critical_warning"] = 0
        dev["media_errors"] = 0
        dev["smart_status_passed"] = True

    elif severity == "critical":
        dev["percentage_used"] = _lerp_int(95, 100, t)
        dev["available_spare"] = _lerp_int(25, 6, t)
        dev["temperature"] = _lerp_int(78, 85, t)
        dev["warning_temp_time"] = 300
        dev["critical_comp_time"] = _lerp_int(0, 10, t)
        dev["num_err_log_entries"] = _lerp_int(5, 12, t)
        dev["media_errors"] = _lerp_int(0, 3, t)
        dev["critical_warning"] = 4 if t >= 1.0 else (1 if t >= 0.5 else 0)
        dev["smart_status_passed"] = t < 0.7  # flips to False once well into Critical


def _inject_disk_metrics(metrics: dict[str, Any]) -> None:
    severity = _state["disk"]["severity"]
    t = _progress("disk")
    disk = metrics.get("disk") or {}
    smart = ((disk.get("smart") or {}).get("nvme0n1")) or None
    if not smart or severity == "healthy":
        return

    if severity == "warning":
        smart["temperature_celsius"] = _lerp_int(30, 78, t)
        smart["health"] = "PASSED"
    elif severity == "critical":
        smart["temperature_celsius"] = _lerp_int(78, 85, t)
        smart["health"] = "FAILED" if t >= 0.7 else "PASSED"


# --------------------------------------------------------------------------
# NIC
# --------------------------------------------------------------------------

def _inject_nic(report: dict[str, Any]) -> None:
    severity = _state["nic"]["severity"]
    t = _progress("nic")
    nic_list = report.get("nic") or []
    primary = next((n for n in nic_list if n.get("interface") not in (None, "wlp3s0")), None)
    if primary is None or severity == "healthy":
        return

    h = primary.setdefault("health", {})
    if severity == "warning":
        h["rx_crc_errors"] = _lerp_int(0, 200, t)
        h["rx_errors"] = _lerp_int(0, 100, t)
        h["rx_dropped"] = _lerp_int(0, 500, t)
        h["tx_dropped"] = _lerp_int(0, 50, t)
        h["tx_errors"] = _lerp_int(0, 40, t)
        h["tx_carrier_errors"] = 0
        h["collisions"] = 0

    elif severity == "critical":
        h["rx_crc_errors"] = _lerp_int(200, 2000, t)
        h["rx_errors"] = _lerp_int(100, 1500, t)
        h["rx_dropped"] = _lerp_int(500, 5000, t)
        h["tx_dropped"] = _lerp_int(50, 800, t)
        h["tx_errors"] = _lerp_int(40, 600, t)
        h["tx_carrier_errors"] = _lerp_int(0, 5, t)
        h["collisions"] = _lerp_int(0, 20, t)


def _inject_nic_metrics(metrics: dict[str, Any]) -> None:
    severity = _state["nic"]["severity"]
    t = _progress("nic")
    nic_list = metrics.get("nic") or []
    primary = next((n for n in nic_list if n.get("name") not in (None, "wlp3s0")), None)
    if primary is None or severity == "healthy":
        return

    if severity == "warning":
        primary["rx_errors"] = _lerp_int(0, 100, t)
        primary["rx_dropped"] = _lerp_int(0, 500, t)
        primary["tx_dropped"] = _lerp_int(0, 50, t)
        primary["tx_errors"] = _lerp_int(0, 40, t)
        primary["duplex"] = "Full"
        demo_speed = "100Mb/s" if t > 0.5 else primary.get("speed_str") or primary.get("speed")
        primary["speed_str"] = demo_speed if isinstance(demo_speed, str) else primary.get("speed_str")
        primary["speed_mbps"] = _parse_link_speed_to_mbps(primary.get("speed_str")) or primary.get("speed_mbps")
        primary["speed"] = primary["speed_mbps"] if primary.get("speed_mbps") is not None else demo_speed
        primary["link_state"] = "up"

    elif severity == "critical":
        primary["rx_errors"] = _lerp_int(100, 1500, t)
        primary["rx_dropped"] = _lerp_int(500, 5000, t)
        primary["tx_dropped"] = _lerp_int(50, 800, t)
        primary["tx_errors"] = _lerp_int(40, 600, t)
        primary["duplex"] = "Half"
        primary["speed_str"] = "10Mb/s"
        primary["speed_mbps"] = 10.0
        primary["speed"] = 10.0
        primary["link_state"] = "down" if t >= 0.85 else "up"


# --------------------------------------------------------------------------
# IO CONTROLLER (PCH / chipset)
# --------------------------------------------------------------------------

# Pick the onboard SATA controller as the device we degrade -- it's a real
# chipset-owned device already present in every sample payload.
_IO_TARGET_SLOT = "0000:00:17.0"


def _inject_io_controller(report: dict[str, Any]) -> None:
    severity = _state["io_controller"]["severity"]
    t = _progress("io_controller")
    pcie_list = report.get("pcie") or []
    motherboard = report.get("motherboard") or {}
    target = next((d for d in pcie_list if d.get("slot") == _IO_TARGET_SLOT), None)
    if target is None or severity == "healthy":
        return

    aer = target.setdefault("aer", {})
    health = target.setdefault("health", {})

    if severity == "warning":
        aer["total_errors"] = _lerp_int(0, 20, t)
        health["status"] = "Warning" if aer["total_errors"] > 0 else "Healthy"
        motherboard["acpi_errors"] = _lerp_int(0, 5, t)
        motherboard["chipset_errors"] = _lerp_int(0, 5, t)
        motherboard["thermal_zone_errors"] = _lerp_int(0, 3, t)
        motherboard["power_faults"] = 0
        motherboard["pcie_errors"] = {
            "critical_links": 0,
            "warning_links": 1 if aer["total_errors"] > 0 else 0,
        }

    elif severity == "critical":
        aer["total_errors"] = _lerp_int(20, 80, t)
        health["status"] = "Critical"
        target["link_current_speed_gts"] = 2.5
        target["link_speed_below_max"] = True
        motherboard["acpi_errors"] = _lerp_int(5, 12, t)
        motherboard["chipset_errors"] = _lerp_int(5, 15, t)
        motherboard["thermal_zone_errors"] = _lerp_int(3, 7, t)
        motherboard["power_faults"] = _lerp_int(0, 3, t)
        motherboard["pcie_errors"] = {"critical_links": 1, "warning_links": 0}

    report["motherboard"] = motherboard


# --------------------------------------------------------------------------
# Public entry points -- call these from collect_metrics4.py
# --------------------------------------------------------------------------

def inject_link_health(report: dict[str, Any]) -> dict[str, Any]:
    """Mutate the link_health report IN PLACE. Must be called BEFORE
    report["health_summary"] = compute_health_summary(report) so the
    injected counters actually drive overall_health/score."""
    _inject_ram(report)
    _inject_disk(report)
    _inject_nic(report)
    _inject_io_controller(report)
    return report


def inject_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
    """Mutate the /metrics snapshot IN PLACE so the live gauges agree with
    whatever link_health is currently reporting."""
    _inject_ram_metrics(metrics)
    _inject_disk_metrics(metrics)
    _inject_nic_metrics(metrics)
    return metrics


# --------------------------------------------------------------------------
# Generic Helper Functions
# --------------------------------------------------------------------------

def is_root() -> bool:
    try:
        return os.geteuid() == 0
    except AttributeError:
        return False


def command_exists(name: str) -> bool:
    """Return True if a Linux utility is available on PATH."""
    return shutil.which(name) is not None


def run(cmd: list[str], timeout: int = DEFAULT_TIMEOUT, use_cache: bool = True) -> str:
    """Safely execute a command and return its stdout.

    Never raises. Returns an empty string on any failure (missing
    binary, non-zero exit, timeout, permission error, etc). Results are
    cached per exact argv within a single collection cycle so repeated
    calls (e.g. `lspci -vv` needed by both the PCIe and NVMe collectors)
    don't re-shell out; the cache is cleared every updater tick.
    """
    key = tuple(cmd)
    if use_cache and key in _CMD_CACHE:
        return _CMD_CACHE[key]

    if not command_exists(cmd[0]):
        if use_cache:
            _CMD_CACHE[key] = ""
        return ""

    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout,
            check=False,
        )
        out = result.stdout or ""
    except Exception as exc:  # noqa: BLE001 - intentional broad catch
        logger.debug("Command failed %s: %s", cmd, exc)
        out = ""

    if use_cache:
        _CMD_CACHE[key] = out
    return out


def read_file(path) -> str:
    """Read a file's full text content. Accepts a str or Path. Never raises."""
    try:
        return Path(path).read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


def read_stripped(path) -> Optional[str]:
    text = read_file(path)
    return text.strip() if text.strip() else None


def safe_int(value: Any, default: Optional[int] = None) -> Optional[int]:
    try:
        return int(str(value).strip().replace(",", ""))
    except (TypeError, ValueError):
        return default


def safe_float(value: Any, default: Optional[float] = None) -> Optional[float]:
    try:
        s = str(value).strip().replace(",", "")
        if s.endswith("%"):
            s = s[:-1].strip()
        if s.lower() in ("n/a", "[n/a]", "na", "not supported", "[not supported]", "-", ""):
            return default
        return float(s)
    except (TypeError, ValueError):
        return default


def _nvidia_smi_csv_rows(output: str) -> list[list[str]]:
    """Parse nvidia-smi CSV, including quoted GPU names that contain commas."""
    rows = []
    for row in csv.reader(io.StringIO(output or "")):
        fields = [f.strip() for f in row]
        if fields:
            rows.append(fields)
    return rows


def bytes_to_kb(n: Any) -> Optional[float]:
    v = safe_float(n)
    return round(v / 1024, 2) if v is not None else None


def bytes_to_mb(n: Any) -> Optional[float]:
    v = safe_float(n)
    return round(v / (1024 ** 2), 2) if v is not None else None


def bytes_to_gb(n: Any) -> Optional[float]:
    v = safe_float(n)
    return round(v / (1024 ** 3), 2) if v is not None else None


def bytes_to_tb(n: Any) -> Optional[float]:
    v = safe_float(n)
    return round(v / (1024 ** 4), 2) if v is not None else None


def get_value(pattern: str, text: str, flags: int = re.MULTILINE) -> Optional[str]:
    """Regex helper: return the first capture group, or None."""
    if not text:
        return None
    m = re.search(pattern, text, flags)
    return m.group(1).strip() if m else None


def parse_key_value(text: str, sep: str = ":") -> dict[str, str]:
    """Parse simple 'Key: Value' formatted text into a dict."""
    result: dict[str, str] = {}
    if not text:
        return result
    for line in text.splitlines():
        if sep in line:
            key, _, value = line.partition(sep)
            key = key.strip()
            value = value.strip()
            if key:
                result[key] = value
    return result


def resolve_driver(device_dir: Path) -> Optional[str]:
    driver_link = device_dir / "driver"
    try:
        if driver_link.exists():
            return os.path.basename(os.path.realpath(str(driver_link)))
    except OSError:
        pass
    return None


def null_if_empty(value: Any) -> Any:
    if value in ("", None, "Unknown", "Not Specified", "To Be Filled By O.E.M."):
        return None
    return value


def safe_collect(name: str, fallback: Any = None) -> Callable:
    """Decorator: guarantees a collector NEVER raises. Logs and returns the
    fallback value (default None) on any exception, matching the "never
    crash, return null" requirement."""
    def decorator(func: Callable) -> Callable:
        def wrapper(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Collector '%s' failed safely: %s", name, exc)
                return fallback
        wrapper.__name__ = func.__name__
        return wrapper
    return decorator


def _is_empty(value: Any) -> bool:
    """True for None, "", [], {} -- but NOT for 0, 0.0, or False."""
    if value is None:
        return True
    if isinstance(value, (str, list, dict, tuple)) and len(value) == 0:
        return True
    return False


def prune_json(data: Any) -> Any:
    """
    Recursively remove keys/list-items whose value is None, "", [], or {}.
    Numbers (including 0) and booleans (including False) are always kept,
    since a confirmed-zero error counter is a real health signal.
    """
    if isinstance(data, dict):
        cleaned = {}
        for key, value in data.items():
            pruned_value = prune_json(value)
            if not _is_empty(pruned_value):
                cleaned[key] = pruned_value
        return cleaned
    if isinstance(data, list):
        cleaned_list = [prune_json(item) for item in data]
        return [item for item in cleaned_list if not _is_empty(item)]
    return data


# --------------------------------------------------------------------------
# 1. SYSTEM
# --------------------------------------------------------------------------

def get_system_inventory() -> dict[str, Any]:
    dmi = parse_key_value(run(["sudo", "-n", "dmidecode", "-t", "system"]))

    uname = run(["uname", "-a"]).strip()

    return {
        "hostname": socket.gethostname(),
        "os": platform.system(),
        "os_release": _get_os_pretty_name(),
        "kernel": platform.release(),
        "architecture": platform.machine(),
        "platform": platform.platform(),
        "uname": uname or None,
        "manufacturer": null_if_empty(dmi.get("Manufacturer")),
        "model": null_if_empty(dmi.get("Product Name")),
        "serial_number": null_if_empty(dmi.get("Serial Number")),
        "uuid": null_if_empty(dmi.get("UUID")),
        "timezone": _get_timezone(),
    }


def _get_os_pretty_name() -> Optional[str]:
    content = read_file("/etc/os-release")
    kv = {}
    for line in content.splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            kv[k.strip()] = v.strip().strip('"')
    return kv.get("PRETTY_NAME")


def _get_timezone() -> Optional[str]:
    out = run(["timedatectl"]) or read_file("/etc/timezone")
    tz = get_value(r"Time zone:\s+(\S+)", out)
    if tz:
        return tz
    return out.strip() or None


def get_system_metrics() -> dict[str, Any]:
    uptime_seconds = None
    raw = read_file("/proc/uptime")
    if raw:
        uptime_seconds = safe_int(raw.split()[0])

    return {
        "uptime_seconds": uptime_seconds,
        "current_time": datetime.now(timezone.utc).isoformat(),
    }


# --------------------------------------------------------------------------
# 2. CPU
# --------------------------------------------------------------------------

def get_cpu_inventory() -> dict[str, Any]:
    lscpu = run(["lscpu"])

    instruction_sets = []
    flags_line = get_value(r"^Flags:\s+(.*)$", lscpu)
    if flags_line:
        wanted = {"sse", "sse2", "sse4_1", "sse4_2", "avx", "avx2", "avx512f"}
        instruction_sets = sorted(set(flags_line.split()) & wanted)

    return {
        "vendor": get_value(r"Vendor ID:\s+(.*)", lscpu),
        "model": get_value(r"Model name:\s+(.*)", lscpu),
        "architecture": get_value(r"Architecture:\s+(.*)", lscpu),
        "sockets": safe_int(get_value(r"Socket\(s\):\s+(.*)", lscpu)),
        "physical_cores": safe_int(get_value(r"Core\(s\) per socket:\s+(.*)", lscpu)),
        "logical_processors": safe_int(get_value(r"^CPU\(s\):\s+(.*)$", lscpu)),
        "threads_per_core": safe_int(get_value(r"Thread\(s\) per core:\s+(.*)", lscpu)),
        "numa_nodes": safe_int(get_value(r"NUMA node\(s\):\s+(.*)", lscpu)),
        "max_mhz": safe_float(get_value(r"CPU max MHz:\s+(.*)", lscpu)),
        "min_mhz": safe_float(get_value(r"CPU min MHz:\s+(.*)", lscpu)),
        "cache_l1d": get_value(r"L1d cache:\s+(.*)", lscpu),
        "cache_l1i": get_value(r"L1i cache:\s+(.*)", lscpu),
        "cache_l2": get_value(r"L2 cache:\s+(.*)", lscpu),
        "cache_l3": get_value(r"L3 cache:\s+(.*)", lscpu),
        "virtualization": get_value(r"Virtualization:\s+(.*)", lscpu),
        "instruction_sets": instruction_sets,
    }


def _get_cpu_temperature() -> Optional[float]:
    if not command_exists("sensors"):
        return None
    out = run(["sensors", "-A"])
    for pattern in (r"Package id 0:\s*\+?(-?\d+\.\d+)", r"Tctl:\s*\+?(-?\d+\.\d+)", r"Core 0:\s*\+?(-?\d+\.\d+)"):
        val = get_value(pattern, out)
        if val:
            return safe_float(val)
    return None


def _get_cpu_current_mhz() -> Optional[float]:
    out = run(["lscpu"])
    val = get_value(r"CPU MHz:\s+(.*)", out)
    if val:
        return safe_float(val)
    return None


def get_cpu_metrics() -> dict[str, Any]:
    user = system = idle = iowait = None

    if command_exists("mpstat"):
        mpstat = run(["mpstat", "1", "1"])
        for line in mpstat.splitlines():
            if line.strip().startswith("Average:") and "%idle" not in line:
                parts = line.split()
                if len(parts) >= 12:
                    user = safe_float(parts[2])
                    system = safe_float(parts[4])
                    iowait = safe_float(parts[5])
                    idle = safe_float(parts[-1])

    if idle is None:
        # Fallback via /proc/stat sampling
        idle, user, system = _cpu_from_proc_stat()

    usage_percent = None
    if idle is not None:
        usage_percent = round(100 - idle, 2)

    load_average = None
    loadavg_raw = read_file("/proc/loadavg")
    if loadavg_raw:
        parts = loadavg_raw.split()
        if len(parts) >= 3:
            load_average = {
                "1min": safe_float(parts[0]),
                "5min": safe_float(parts[1]),
                "15min": safe_float(parts[2]),
            }

    interrupts = None
    stat_raw = read_file("/proc/stat")
    intr_val = get_value(r"^intr\s+(\d+)", stat_raw)
    if intr_val:
        interrupts = safe_int(intr_val)

    return {
        "usage_percent": usage_percent,
        "idle_percent": idle,
        "user_percent": user,
        "system_percent": system,
        "iowait_percent": iowait,
        "interrupts": interrupts,
        "load_average": load_average,
        "current_mhz": _get_cpu_current_mhz(),
        "temperature_celsius": _get_cpu_temperature(),
    }


def _cpu_from_proc_stat(sample_delay: float = 0.2) -> tuple[Optional[float], Optional[float], Optional[float]]:
    """Fallback CPU usage calculation using two /proc/stat samples."""
    def read_cpu_line() -> Optional[list[int]]:
        raw = read_file("/proc/stat")
        for line in raw.splitlines():
            if line.startswith("cpu "):
                return [int(x) for x in line.split()[1:]]
        return None

    first = read_cpu_line()
    if not first:
        return None, None, None
    time.sleep(sample_delay)
    second = read_cpu_line()
    if not second:
        return None, None, None

    fields = ["user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal"]
    deltas = {fields[i]: second[i] - first[i] for i in range(min(len(fields), len(first)))}
    total = sum(deltas.values())
    if total <= 0:
        return None, None, None

    idle_pct = round(deltas.get("idle", 0) / total * 100, 2)
    user_pct = round(deltas.get("user", 0) / total * 100, 2)
    system_pct = round(deltas.get("system", 0) / total * 100, 2)
    return idle_pct, user_pct, system_pct


# --------------------------------------------------------------------------
# 3. MEMORY
# --------------------------------------------------------------------------

def get_memory_inventory() -> dict[str, Any]:
    if not command_exists("dmidecode"):
        return {"dimms": [], "note": "dmidecode not available"}

    dmi = run(["sudo", "-n", "dmidecode", "-t", "memory"])
    if not dmi:
        return {"dimms": [], "note": "dmidecode requires elevated privileges"}

    dimms = []
    for block in dmi.split("Memory Device"):
        size = get_value(r"^\s*Size:\s+(.*)$", block)
        if not size or "No Module Installed" in block:
            continue
        dimms.append({
            "locator": null_if_empty(get_value(r"Locator:\s+(.*)", block)),
            "size": null_if_empty(size),
            "type": null_if_empty(get_value(r"^\s*Type:\s+(.*)$", block)),
            "speed": null_if_empty(get_value(r"^\s*Speed:\s+(.*)$", block)),
            "configured_speed": null_if_empty(get_value(r"Configured Memory Speed:\s+(.*)", block)),
            "configured_voltage": null_if_empty(get_value(r"Configured Voltage:\s+(.*)", block)),
            "manufacturer": null_if_empty(get_value(r"Manufacturer:\s+(.*)", block)),
            "part_number": null_if_empty(get_value(r"Part Number:\s+(.*)", block)),
            "serial": null_if_empty(get_value(r"Serial Number:\s+(.*)", block)),
        })

    ecc = "Multi-bit ECC" if "Multi-bit ECC" in dmi else ("ECC" if "ECC" in dmi else None)

    return {"dimms": dimms, "ecc": ecc}


def get_memory_metrics() -> dict[str, Any]:
    meminfo = parse_key_value(read_file("/proc/meminfo"))

    def kb(key: str) -> Optional[int]:
        val = meminfo.get(key)
        if not val:
            return None
        return safe_int(val.split()[0])

    total = kb("MemTotal")
    free = kb("MemFree")
    available = kb("MemAvailable")
    buffers = kb("Buffers")
    cached = kb("Cached")
    swap_total = kb("SwapTotal")
    swap_free = kb("SwapFree")

    used = None
    usage_percent = None
    if total is not None and available is not None:
        used = total - available
        usage_percent = round(used / total * 100, 2) if total else None

    swap_used = None
    swap_usage_percent = None
    if swap_total is not None and swap_free is not None:
        swap_used = swap_total - swap_free
        swap_usage_percent = round(swap_used / swap_total * 100, 2) if swap_total else None

    return {
        "total_gb": bytes_to_gb((total or 0) * 1024) if total is not None else None,
        "used_gb": bytes_to_gb((used or 0) * 1024) if used is not None else None,
        "free_gb": bytes_to_gb((free or 0) * 1024) if free is not None else None,
        "available_gb": bytes_to_gb((available or 0) * 1024) if available is not None else None,
        "buffers_gb": bytes_to_gb((buffers or 0) * 1024) if buffers is not None else None,
        "cached_gb": bytes_to_gb((cached or 0) * 1024) if cached is not None else None,
        "usage_percent": usage_percent,
        "swap_total_gb": bytes_to_gb((swap_total or 0) * 1024) if swap_total is not None else None,
        "swap_used_gb": bytes_to_gb((swap_used or 0) * 1024) if swap_used is not None else None,
        "swap_free_gb": bytes_to_gb((swap_free or 0) * 1024) if swap_free is not None else None,
        "swap_usage_percent": swap_usage_percent,
    }


# --------------------------------------------------------------------------
# 4. DISK
# --------------------------------------------------------------------------

def _lsblk_json() -> list[dict[str, Any]]:
    if not command_exists("lsblk"):
        return []
    out = run([
        "lsblk", "-J", "-O",
    ])
    if not out:
        out = run(["lsblk", "-J", "-b", "-o",
                    "NAME,MODEL,SERIAL,WWN,VENDOR,TRAN,ROTA,LOG-SEC,PHY-SEC,FSTYPE,MOUNTPOINT,SIZE,TYPE"])
    try:
        data = json.loads(out)
        return data.get("blockdevices", [])
    except Exception:
        return []


def get_disk_inventory() -> list[dict[str, Any]]:
    devices = _lsblk_json()
    results = []

    for dev in devices:
        if dev.get("type") != "disk":
            continue

        name = dev.get("name")
        dev_path = f"/dev/{name}"

        smart = {}
        if command_exists("smartctl"):
            smart_out = run(["sudo", "-n", "smartctl", "-i", dev_path])
            smart = {
                "model_smart": null_if_empty(get_value(r"Device Model:\s+(.*)", smart_out)),
                "serial_smart": null_if_empty(get_value(r"Serial Number:\s+(.*)", smart_out)),
            }

        partitions = []
        for child in dev.get("children", []) or []:
            partitions.append({
                "name": child.get("name"),
                "size": child.get("size"),
                "fstype": null_if_empty(child.get("fstype")),
                "mountpoint": null_if_empty(child.get("mountpoint")),
            })

        rota = dev.get("rota")
        is_ssd = None
        if rota is not None:
            is_ssd = not bool(rota) if isinstance(rota, bool) else rota in (False, "0", 0)

        results.append({
            "name": name,
            "model": null_if_empty(dev.get("model")) or smart.get("model_smart"),
            "serial": null_if_empty(dev.get("serial")) or smart.get("serial_smart"),
            "wwn": null_if_empty(dev.get("wwn")),
            "vendor": null_if_empty(dev.get("vendor")),
            "transport": null_if_empty(dev.get("tran")),
            "type": "SSD" if is_ssd else ("HDD" if is_ssd is False else None),
            "logical_sector_size": dev.get("log-sec"),
            "physical_sector_size": dev.get("phy-sec"),
            "size": dev.get("size"),
            "partitions": partitions,
        })

    return results


# --------------------------------------------------------------------------
# Trial5: DISK / IO LIVE PERFORMANCE METRICS
# --------------------------------------------------------------------------

_DISKSTATS_SECTOR_SIZE = 512
_DISK_SKIP_PREFIXES = ("loop", "ram", "dm-", "md", "sr", "zram")


def _get_disk_transport(name: str) -> str:
    if name.startswith("nvme"):
        return "nvme"
    try:
        real = os.path.realpath(str(BLOCK_CLASS_PATH / name))
    except Exception:
        return "unknown"
    if "/usb" in real:
        return "usb"
    if "/virtio" in real:
        return "virtio"
    if re.search(r"/ata\d+/", real):
        return "sata"
    if "/nvme" in real:
        return "nvme"
    return "other"


@safe_collect("disk_performance_metrics", fallback=[])
def get_disk_performance_metrics() -> list[dict[str, Any]]:
    if not BLOCK_CLASS_PATH.exists():
        return []

    now = time.time()
    results: list[dict[str, Any]] = []

    with _metrics_delta_lock:
        for name in sorted(os.listdir(BLOCK_CLASS_PATH)):
            if name.startswith(_DISK_SKIP_PREFIXES):
                continue

            stat_text = read_stripped(BLOCK_CLASS_PATH / name / "stat")
            if not stat_text:
                continue

            fields = [safe_int(x) for x in stat_text.split()]
            if len(fields) < 11:
                continue

            (reads_completed, _reads_merged, sectors_read, ms_reading,
             writes_completed, _writes_merged, sectors_written, ms_writing,
             ios_in_progress, ms_doing_io, weighted_ms_doing_io) = fields[:11]

            removable = read_stripped(BLOCK_CLASS_PATH / name / "removable")
            is_removable = removable == "1"

            current = {
                "reads_completed": reads_completed,
                "sectors_read": sectors_read,
                "ms_reading": ms_reading,
                "writes_completed": writes_completed,
                "sectors_written": sectors_written,
                "ms_writing": ms_writing,
                "ms_doing_io": ms_doing_io,
                "weighted_ms_doing_io": weighted_ms_doing_io,
                "timestamp": now,
            }

            prev = _PREV_DISK_STATS.get(name)

            entry: dict[str, Any] = {
                "device": name,
                "transport": _get_disk_transport(name),
                "removable": is_removable,
                "read_bytes_per_sec": None,
                "write_bytes_per_sec": None,
                "read_MB_per_sec": None,
                "write_MB_per_sec": None,
                "total_bytes_per_sec": None,
                "total_MB_per_sec": None,
                "read_IOPS": None,
                "write_IOPS": None,
                "total_IOPS": None,
                "reads_per_sec": None,
                "writes_per_sec": None,
                "busy_percent": None,
                "average_read_latency_ms": None,
                "average_write_latency_ms": None,
                "average_latency_ms": None,
                "queue_depth": ios_in_progress,
            }

            if prev is not None:
                dt = now - prev.get("timestamp", now)
                if dt > 0:
                    d_reads = max(reads_completed - prev["reads_completed"], 0)
                    d_writes = max(writes_completed - prev["writes_completed"], 0)
                    d_sectors_read = max(sectors_read - prev["sectors_read"], 0)
                    d_sectors_written = max(sectors_written - prev["sectors_written"], 0)
                    d_ms_reading = max(ms_reading - prev["ms_reading"], 0)
                    d_ms_writing = max(ms_writing - prev["ms_writing"], 0)
                    d_ms_doing_io = max(ms_doing_io - prev["ms_doing_io"], 0)

                    read_bytes_per_sec = (d_sectors_read * _DISKSTATS_SECTOR_SIZE) / dt
                    write_bytes_per_sec = (d_sectors_written * _DISKSTATS_SECTOR_SIZE) / dt
                    total_bytes_per_sec = read_bytes_per_sec + write_bytes_per_sec

                    entry["read_bytes_per_sec"] = round(read_bytes_per_sec, 2)
                    entry["write_bytes_per_sec"] = round(write_bytes_per_sec, 2)
                    entry["read_MB_per_sec"] = round(read_bytes_per_sec / (1024 ** 2), 3)
                    entry["write_MB_per_sec"] = round(write_bytes_per_sec / (1024 ** 2), 3)
                    entry["total_bytes_per_sec"] = round(total_bytes_per_sec, 2)
                    entry["total_MB_per_sec"] = round(total_bytes_per_sec / (1024 ** 2), 3)
                    entry["read_IOPS"] = round(d_reads / dt, 2)
                    entry["write_IOPS"] = round(d_writes / dt, 2)
                    entry["total_IOPS"] = round((d_reads + d_writes) / dt, 2)
                    entry["reads_per_sec"] = entry["read_IOPS"]
                    entry["writes_per_sec"] = entry["write_IOPS"]
                    entry["busy_percent"] = round(min(d_ms_doing_io / (dt * 1000) * 100, 100.0), 2)
                    entry["average_read_latency_ms"] = round(d_ms_reading / d_reads, 3) if d_reads > 0 else 0.0
                    entry["average_write_latency_ms"] = round(d_ms_writing / d_writes, 3) if d_writes > 0 else 0.0
                    total_ops = d_reads + d_writes
                    if total_ops > 0:
                        entry["average_latency_ms"] = round(
                            (d_ms_reading + d_ms_writing) / total_ops, 3
                        )

            _PREV_DISK_STATS[name] = current
            results.append(entry)

    return results


def get_disk_metrics() -> dict[str, Any]:
    df_out = run(["df", "-B1", "--output=source,target,fstype,size,used,avail,pcent"])
    results = []

    lines = df_out.splitlines()[1:] if df_out else []
    for line in lines:
        parts = line.split()
        if len(parts) < 7:
            continue
        source, target, fstype, size, used, avail, pcent = parts[:7]
        if not source.startswith("/dev/"):
            continue

        results.append({
            "source": source,
            "mountpoint": target,
            "filesystem": fstype,
            "size_gb": bytes_to_gb(size),
            "used_gb": bytes_to_gb(used),
            "free_gb": bytes_to_gb(avail),
            "usage_percent": safe_float(pcent.replace("%", "")),
        })

    # SMART health per physical disk
    smart_health = {}
    if command_exists("smartctl"):
        for dev in _lsblk_json():
            if dev.get("type") != "disk":
                continue
            name = dev.get("name")
            dev_path = f"/dev/{name}"
            smart_out = run(["sudo", "-n", "smartctl", "-A", "-H", dev_path])
            if not smart_out:
                continue

            health = get_value(r"SMART overall-health self-assessment test result:\s+(\w+)", smart_out)
            temp = get_value(r"Temperature_Celsius.*\s(\d+)\s*$", smart_out) or \
                get_value(r"Temperature:\s+(\d+)\s*Celsius", smart_out)
            power_on = get_value(r"Power_On_Hours.*\s(\d+)\s*$", smart_out)
            realloc = get_value(r"Reallocated_Sector_Ct.*\s(\d+)\s*$", smart_out)
            pending = get_value(r"Current_Pending_Sector.*\s(\d+)\s*$", smart_out)

            smart_health[name] = {
                "health": null_if_empty(health),
                "temperature_celsius": safe_int(temp),
                "power_on_hours": safe_int(power_on),
                "reallocated_sectors": safe_int(realloc),
                "pending_sectors": safe_int(pending),
            }

    return {
        "mounts": results,
        "smart": smart_health,
        "performance": get_disk_performance_metrics(),
    }


# --------------------------------------------------------------------------
# 5. GPU
# --------------------------------------------------------------------------

def get_gpu_inventory_and_metrics() -> Optional[list[dict[str, Any]]]:
    if command_exists("nvidia-smi"):
        query = (
            "name,driver_version,pci.bus_id,memory.total,memory.used,memory.free,"
            "utilization.gpu,utilization.memory,power.draw,power.limit,"
            "temperature.gpu,fan.speed,clocks.gr,clocks.mem"
        )
        out = run(["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"])
        if out.strip():
            gpus = []
            for fields in _nvidia_smi_csv_rows(out):
                if len(fields) < 14:
                    continue
                (name, driver, pci_bus, mem_total, mem_used, mem_free,
                 util_gpu, util_mem, power_draw, power_limit,
                 temp, fan, clock_gr, clock_mem) = fields[:14]

                cuda_out = run(["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"])
                cuda_version = get_value(r"CUDA Version:\s+([\d.]+)", run(["nvidia-smi"]))

                gpus.append({
                    "vendor": "NVIDIA",
                    "model": name,
                    "driver_version": driver,
                    "cuda_version": cuda_version,
                    "pci_bus_id": pci_bus,
                    "vram_total_mb": safe_float(mem_total),
                    "memory_used_mb": safe_float(mem_used),
                    "memory_free_mb": safe_float(mem_free),
                    "gpu_utilization_percent": safe_float(util_gpu),
                    "memory_utilization_percent": safe_float(util_mem),
                    "power_draw_watts": safe_float(power_draw),
                    "power_limit_watts": safe_float(power_limit),
                    "temperature_celsius": safe_float(temp),
                    "fan_speed_percent": safe_float(fan),
                    "graphics_clock_mhz": safe_float(clock_gr),
                    "memory_clock_mhz": safe_float(clock_mem),
                })
            if gpus:
                return gpus

    # Fallback: lspci detection only (no live metrics available)
    if command_exists("lspci"):
        lspci_out = run(["lspci"])
        gpu_lines = [l for l in lspci_out.splitlines() if "VGA" in l or "3D controller" in l]
        if gpu_lines:
            gpus = []
            for line in gpu_lines:
                desc = line.split(": ", 1)[-1] if ": " in line else line
                gpus.append({
                    "vendor": null_if_empty(desc.split()[0]) if desc else None,
                    "model": desc,
                    "driver_version": None,
                    "cuda_version": None,
                    "pci_bus_id": line.split()[0] if line else None,
                    "vram_total_mb": None,
                    "memory_used_mb": None,
                    "memory_free_mb": None,
                    "gpu_utilization_percent": None,
                    "memory_utilization_percent": None,
                    "power_draw_watts": None,
                    "power_limit_watts": None,
                    "temperature_celsius": None,
                    "fan_speed_percent": None,
                    "graphics_clock_mhz": None,
                    "memory_clock_mhz": None,
                })
            return gpus

    return None


# --------------------------------------------------------------------------
# 6. NIC
# --------------------------------------------------------------------------

def _list_interfaces() -> list[str]:
    out = run(["ip", "-o", "link", "show"])
    names = []
    for line in out.splitlines():
        m = re.match(r"\d+:\s+([^:@]+)", line)
        if m:
            iface = m.group(1).strip()
            if iface != "lo":
                names.append(iface)
    return names


def get_nic_inventory() -> list[dict[str, Any]]:
    interfaces = []
    for iface in _list_interfaces():
        addr_out = run(["ip", "-o", "link", "show", iface])
        mac = get_value(r"link/ether\s+([0-9a-f:]+)", addr_out)

        ethtool_out = run(["sudo", "-n", "ethtool", iface]) if command_exists("ethtool") else ""
        driver_out = run(["sudo", "-n", "ethtool", "-i", iface]) if command_exists("ethtool") else ""

        mtu = get_value(r"mtu (\d+)", addr_out)

        supported_speeds = []
        supported_match = re.findall(r"(\d+base\S+)", ethtool_out)
        if supported_match:
            supported_speeds = sorted(set(supported_match))

        bus_info = get_value(r"bus-info:\s+(\S+)", driver_out)

        interfaces.append({
            "name": iface,
            "mac": null_if_empty(mac),
            "driver": null_if_empty(get_value(r"driver:\s+(\S+)", driver_out)),
            "firmware_version": null_if_empty(get_value(r"firmware-version:\s+(.*)", driver_out)),
            "supported_speeds": supported_speeds,
            "negotiated_speed": null_if_empty(get_value(r"Speed:\s+(\S+)", ethtool_out)),
            "mtu": safe_int(mtu),
            "pci_slot": null_if_empty(bus_info),
        })
    return interfaces


# --------------------------------------------------------------------------
# Trial5: NIC LIVE THROUGHPUT / UTILIZATION / LOSS-RATE METRICS
# --------------------------------------------------------------------------

def _parse_link_speed_to_bps(speed_str: Optional[str]) -> Optional[float]:
    if not speed_str:
        return None
    m = re.match(r"(\d+(?:\.\d+)?)\s*([A-Za-z]+)/s", speed_str.strip())
    if not m:
        return None
    value = safe_float(m.group(1))
    unit = m.group(2).lower()
    if value is None:
        return None
    multipliers = {"mb": 1_000_000, "gb": 1_000_000_000, "kb": 1_000, "tb": 1_000_000_000_000}
    mult = multipliers.get(unit)
    if mult is None:
        return None
    return value * mult


def _parse_link_speed_to_mbps(speed_str: Optional[str]) -> Optional[float]:
    bps = _parse_link_speed_to_bps(speed_str)
    if bps is None:
        return None
    return round(bps / 1_000_000, 3)


def _is_wireless_interface(iface: str) -> bool:
    if not iface:
        return False
    if (NET_CLASS_PATH / iface / "wireless").exists():
        return True
    lower = iface.lower()
    return lower.startswith(("wl", "wlan", "wifi"))


def _read_sysfs_link_speed_mbps(iface: str) -> Optional[float]:
    raw = read_stripped(NET_CLASS_PATH / iface / "speed")
    if not raw:
        return None
    value = safe_int(raw)
    if value is None or value <= 0:
        return None
    return float(value)


def _get_wifi_link_speed_mbps(iface: str) -> Optional[float]:
    """Resolve Wi-Fi negotiated bitrate via iw, then iwconfig."""
    if command_exists("iw"):
        out = run(["iw", "dev", iface, "link"], use_cache=False)
        if out.strip():
            for pattern in (
                r"tx bitrate:\s*([\d.]+)\s*MBit/s",
                r"rx bitrate:\s*([\d.]+)\s*MBit/s",
                r"bitrate:\s*([\d.]+)\s*MBit/s",
            ):
                m = re.search(pattern, out, re.IGNORECASE)
                if m:
                    value = safe_float(m.group(1))
                    if value is not None and value > 0:
                        return round(value, 3)

    if command_exists("iwconfig"):
        out = run(["iwconfig", iface], use_cache=False)
        if out.strip():
            m = re.search(r"Bit Rate[=:\s]+([\d.]+)\s*Mb/?s", out, re.IGNORECASE)
            if m:
                value = safe_float(m.group(1))
                if value is not None and value > 0:
                    return round(value, 3)

    return None


def _resolve_nic_link_speed(
    iface: str,
    ethtool_speed_str: Optional[str],
) -> tuple[Optional[float], Optional[str], Optional[float]]:
    """Return (link_speed_bps, speed_display_str, speed_mbps).

    Ethernet: ethtool → sysfs.  Wi-Fi: ethtool → sysfs → iw → iwconfig.
    """
    speed_str = ethtool_speed_str
    speed_mbps = _parse_link_speed_to_mbps(speed_str)

    if speed_mbps is None:
        speed_mbps = _read_sysfs_link_speed_mbps(iface)
        if speed_mbps is not None and not speed_str:
            speed_str = f"{speed_mbps:g}Mb/s"

    if speed_mbps is None and _is_wireless_interface(iface):
        speed_mbps = _get_wifi_link_speed_mbps(iface)
        if speed_mbps is not None:
            speed_str = speed_str or f"{speed_mbps:g}Mb/s"

    if speed_mbps is None:
        return None, speed_str, None

    return speed_mbps * 1_000_000, speed_str, speed_mbps


def _clamp_utilization_percent(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    return round(max(0.0, min(100.0, value)), 3)


NIC_UTILIZATION_WARNING_PERCENT = 10.0  # TESTING ONLY — revert to 70.0 for production
NIC_UTILIZATION_CRITICAL_PERCENT = 20.0  # TESTING ONLY — revert to 80.0 for production


def _kbps_to_mbps(kbps: float) -> float:
    return round((kbps or 0.0) * 8 / 1000.0, 2)


def _nic_utilization_threshold_fields(util_pct: Optional[float]) -> dict[str, Any]:
    if util_pct is None:
        return {
            "utilization_threshold_status": None,
            "utilization_threshold_severity": None,
            "utilization_threshold_crossed": None,
        }
    if util_pct >= NIC_UTILIZATION_CRITICAL_PERCENT:
        return {
            "utilization_threshold_status": "critical",
            "utilization_threshold_severity": "Critical",
            "utilization_threshold_crossed": f"≥ {NIC_UTILIZATION_CRITICAL_PERCENT:g}% (Critical)",
        }
    if util_pct >= NIC_UTILIZATION_WARNING_PERCENT:
        return {
            "utilization_threshold_status": "warning",
            "utilization_threshold_severity": "Warning",
            "utilization_threshold_crossed": f"≥ {NIC_UTILIZATION_WARNING_PERCENT:g}% (Warning)",
        }
    return {
        "utilization_threshold_status": "healthy",
        "utilization_threshold_severity": None,
        "utilization_threshold_crossed": None,
    }


@safe_collect("nic_delta_metrics", fallback={})
def _compute_nic_delta_metrics(
    iface: str,
    current: dict[str, Any],
    link_speed_bps: Optional[float],
    now: float,
) -> dict[str, Any]:
    fields = (
        "rx_bytes", "tx_bytes", "rx_packets", "tx_packets",
        "rx_errors", "tx_errors", "rx_dropped", "tx_dropped",
    )

    result: dict[str, Any] = {
        "rx_bytes_per_sec": None,
        "tx_bytes_per_sec": None,
        "rx_MB_per_sec": None,
        "tx_MB_per_sec": None,
        "rx_mbps": None,
        "tx_mbps": None,
        "rx_packets_per_sec": None,
        "tx_packets_per_sec": None,
        "rx_utilization_percent": None,
        "tx_utilization_percent": None,
        "utilization_percent": None,
        "rx_drop_rate_percent": None,
        "tx_drop_rate_percent": None,
        "rx_error_rate_percent": None,
        "tx_error_rate_percent": None,
    }

    with _metrics_delta_lock:
        prev = _PREV_NIC_STATS.get(iface)
        snapshot = {f: current.get(f) for f in fields}
        snapshot["timestamp"] = now
        _PREV_NIC_STATS[iface] = snapshot

        if prev is None:
            return result

        dt = now - prev.get("timestamp", now)
        if dt <= 0:
            return result

        def delta(name: str) -> Optional[int]:
            a, b = current.get(name), prev.get(name)
            if a is None or b is None:
                return None
            d = a - b
            return d if d >= 0 else None

        d_rx_bytes = delta("rx_bytes")
        d_tx_bytes = delta("tx_bytes")
        d_rx_packets = delta("rx_packets")
        d_tx_packets = delta("tx_packets")
        d_rx_errors = delta("rx_errors")
        d_tx_errors = delta("tx_errors")
        d_rx_dropped = delta("rx_dropped")
        d_tx_dropped = delta("tx_dropped")

        if d_rx_bytes is not None:
            rx_bps = d_rx_bytes / dt
            result["rx_bytes_per_sec"] = round(rx_bps, 2)
            result["rx_MB_per_sec"] = round(rx_bps / (1024 ** 2), 4)
            result["rx_mbps"] = round((result["rx_MB_per_sec"] or 0) * 8, 3)
            if link_speed_bps:
                result["rx_utilization_percent"] = _clamp_utilization_percent(
                    (rx_bps * 8) / link_speed_bps * 100
                )

        if d_tx_bytes is not None:
            tx_bps = d_tx_bytes / dt
            result["tx_bytes_per_sec"] = round(tx_bps, 2)
            result["tx_MB_per_sec"] = round(tx_bps / (1024 ** 2), 4)
            result["tx_mbps"] = round((result["tx_MB_per_sec"] or 0) * 8, 3)
            if link_speed_bps:
                result["tx_utilization_percent"] = _clamp_utilization_percent(
                    (tx_bps * 8) / link_speed_bps * 100
                )

        if link_speed_bps and (result["rx_MB_per_sec"] is not None or result["tx_MB_per_sec"] is not None):
            total_mb_per_sec = (result["rx_MB_per_sec"] or 0) + (result["tx_MB_per_sec"] or 0)
            total_mbps = total_mb_per_sec * 8
            result["utilization_percent"] = _clamp_utilization_percent(
                (total_mbps * 1_000_000) / link_speed_bps * 100
            )

        if d_rx_packets is not None:
            result["rx_packets_per_sec"] = round(d_rx_packets / dt, 2)
        if d_tx_packets is not None:
            result["tx_packets_per_sec"] = round(d_tx_packets / dt, 2)

        if d_rx_dropped is not None and d_rx_packets is not None:
            denom = d_rx_packets + d_rx_dropped
            result["rx_drop_rate_percent"] = round((d_rx_dropped / denom) * 100, 4) if denom > 0 else 0.0
        if d_tx_dropped is not None and d_tx_packets is not None:
            denom = d_tx_packets + d_tx_dropped
            result["tx_drop_rate_percent"] = round((d_tx_dropped / denom) * 100, 4) if denom > 0 else 0.0

        if d_rx_errors is not None and d_rx_packets is not None:
            denom = d_rx_packets + d_rx_errors
            result["rx_error_rate_percent"] = round((d_rx_errors / denom) * 100, 4) if denom > 0 else 0.0
        if d_tx_errors is not None and d_tx_packets is not None:
            denom = d_tx_packets + d_tx_errors
            result["tx_error_rate_percent"] = round((d_tx_errors / denom) * 100, 4) if denom > 0 else 0.0

    return result


def get_nic_metrics() -> list[dict[str, Any]]:
    results = []

    net_dev = read_file("/proc/net/dev")
    stats = {}

    for line in net_dev.splitlines()[2:]:
        if ":" not in line:
            continue

        name, data = line.split(":", 1)
        name = name.strip()
        parts = data.split()

        if len(parts) < 16:
            continue

        stats[name] = {
            "rx_bytes": safe_int(parts[0]),
            "rx_packets": safe_int(parts[1]),
            "rx_errors": safe_int(parts[2]),
            "rx_dropped": safe_int(parts[3]),
            "tx_bytes": safe_int(parts[8]),
            "tx_packets": safe_int(parts[9]),
            "tx_errors": safe_int(parts[10]),
            "tx_dropped": safe_int(parts[11]),
        }

    for iface in _list_interfaces():
        ethtool_out = ""
        if command_exists("ethtool"):
            ethtool_out = run(["sudo", "-n", "ethtool", iface])

        # SAFE LINK DETECTION
        detected = get_value(r"Link detected:\s+(\w+)", ethtool_out)

        if detected:
            link_state = "up" if detected.lower() == "yes" else "down"
        else:
            ip_out = run(["ip", "-br", "link", "show", iface])
            link_state = "up" if "UP" in ip_out else "down"

        s = stats.get(iface, {})
        speed_str = get_value(r"Speed:\s+(\S+)", ethtool_out)
        link_speed_bps, resolved_speed_str, speed_mbps = _resolve_nic_link_speed(iface, speed_str)

        entry = {
            "name": iface,
            "link_state": link_state,
            "speed": speed_mbps if speed_mbps is not None else speed_str,
            "speed_str": resolved_speed_str or speed_str,
            "speed_mbps": speed_mbps,
            "duplex": get_value(r"Duplex:\s+(\S+)", ethtool_out),
            "rx_bytes": s.get("rx_bytes"),
            "tx_bytes": s.get("tx_bytes"),
            "rx_packets": s.get("rx_packets"),
            "tx_packets": s.get("tx_packets"),
            "rx_errors": s.get("rx_errors"),
            "tx_errors": s.get("tx_errors"),
            "rx_dropped": s.get("rx_dropped"),
            "tx_dropped": s.get("tx_dropped"),
            "wireless": _is_wireless_interface(iface),
        }

        entry.update(_compute_nic_delta_metrics(iface, s, link_speed_bps, time.time()))
        entry.update(_nic_utilization_threshold_fields(entry.get("utilization_percent")))
        results.append(entry)

    global _LATEST_NIC_METRICS
    _LATEST_NIC_METRICS = results
    return results


# --------------------------------------------------------------------------
# 7. PSU
# --------------------------------------------------------------------------

def get_psu_metrics() -> Optional[list[dict[str, Any]]]:
    psus = []

    if command_exists("ipmitool"):
        out = run(["sudo", "-n", "ipmitool", "sdr", "type", "Power Supply"])
        if out.strip():
            for line in out.strip().splitlines():
                fields = [f.strip() for f in line.split("|")]
                if len(fields) >= 3:
                    psus.append({
                        "name": fields[0],
                        "status": fields[2] if len(fields) > 2 else None,
                        "reading": fields[1] if len(fields) > 1 else None,
                        "source": "ipmitool",
                    })

    if not psus and command_exists("sensors"):
        out = run(["sensors"])
        power_lines = [l for l in out.splitlines() if re.search(r"power\d*:", l, re.IGNORECASE)]
        if power_lines:
            for line in power_lines:
                psus.append({
                    "name": line.split(":")[0].strip(),
                    "reading": line.split(":", 1)[1].strip() if ":" in line else None,
                    "status": None,
                    "source": "lm-sensors",
                })

    return psus or None


# --------------------------------------------------------------------------
# 8. IO DEVICES
# --------------------------------------------------------------------------

def get_io_devices() -> dict[str, Any]:
    pci_devices = []
    if command_exists("lspci"):
        out = run(["lspci", "-mm"])
        for line in out.splitlines():
            # Format: "Slot" "Class" "Vendor" "Device" ...
            matches = re.findall(r'"((?:[^"\\]|\\.)*)"', line)
            if len(matches) >= 4:
                slot = line.split()[0]
                pci_devices.append({
                    "slot": slot,
                    "class": matches[0],
                    "vendor": matches[1],
                    "device": matches[2],
                    "description": f"{matches[1]} {matches[2]}",
                })

    usb_devices = []
    if command_exists("lsusb"):
        out = run(["lsusb"])
        for line in out.splitlines():
            m = re.match(r"Bus (\d+) Device (\d+): ID (\w{4}):(\w{4})\s*(.*)", line)
            if m:
                bus, device, vendor_id, device_id, desc = m.groups()
                usb_devices.append({
                    "bus": bus,
                    "device": device,
                    "vendor_id": vendor_id,
                    "device_id": device_id,
                    "description": desc.strip() or None,
                })

    return {"pci": pci_devices, "usb": usb_devices}


# --------------------------------------------------------------------------
# 9. MANAGEMENT
# --------------------------------------------------------------------------

def get_management_info() -> dict[str, Any]:
    bios = parse_key_value(run(["sudo", "-n", "dmidecode", "-t", "bios"]))
    system = parse_key_value(run(["sudo", "-n", "dmidecode", "-t", "system"]))
    chassis = parse_key_value(run(["sudo", "-n", "dmidecode", "-t", "chassis"]))

    bmc_info = {"firmware": None, "ip": None}
    if command_exists("ipmitool"):
        mc_out = run(["sudo", "-n", "ipmitool", "mc", "info"])
        bmc_info["firmware"] = null_if_empty(get_value(r"Firmware Revision\s+:\s+(.*)", mc_out))

        lan_out = run(["sudo", "-n", "ipmitool", "lan", "print"])
        bmc_info["ip"] = null_if_empty(get_value(r"IP Address\s+:\s+(.*)", lan_out))

    return {
        "bios_vendor": null_if_empty(bios.get("Vendor")),
        "bios_version": null_if_empty(bios.get("Version")),
        "bios_date": null_if_empty(bios.get("Release Date")),
        "system_manufacturer": null_if_empty(system.get("Manufacturer")),
        "system_product": null_if_empty(system.get("Product Name")),
        "system_uuid": null_if_empty(system.get("UUID")),
        "serial_number": null_if_empty(system.get("Serial Number")),
        "asset_tag": null_if_empty(chassis.get("Asset Tag")),
        "chassis_type": null_if_empty(chassis.get("Type")),
        "chassis_manufacturer": null_if_empty(chassis.get("Manufacturer")),
        "bmc_firmware": bmc_info["firmware"],
        "bmc_ip": bmc_info["ip"],
    }


# --------------------------------------------------------------------------
# Top-level inventory / metrics collectors
# --------------------------------------------------------------------------

def collect_inventory() -> dict[str, Any]:
    """Collect mostly-static hardware description data."""
    return {
        "system": get_system_inventory(),
        "cpu": get_cpu_inventory(),
        "memory": get_memory_inventory(),
        "disk": get_disk_inventory(),
        "gpu": get_gpu_inventory_and_metrics(),  # static fields reused; metrics refreshed separately
        "nic": get_nic_inventory(),
        "io": get_io_devices(),
        "management": get_management_info(),
    }

# ============================================================================
# PROCESS ATTRIBUTION
# ============================================================================

@safe_collect("top_cpu_processes", fallback=[])
def get_top_cpu_processes(limit: int = 10) -> list[dict[str, Any]]:
    """
    Top CPU consuming processes.
    """
    out = run([
        "ps",
        "-eo",
        "pid,user,%cpu,%mem,etime,comm,args",
        "--sort=-%cpu"
    ])

    results = []

    for line in out.splitlines()[1:limit + 1]:
        parts = line.split(None, 6)

        if len(parts) < 7:
            continue

        results.append({
            "pid": safe_int(parts[0]),
            "user": parts[1],
            "cpu_percent": safe_float(parts[2]),
            "memory_percent": safe_float(parts[3]),
            "elapsed": parts[4],
            "process": parts[5],
            "command": parts[6],
        })

    return results


@safe_collect("top_disk_io_processes", fallback=[])
def get_top_disk_io_processes(limit: int = 50) -> list[dict[str, Any]]:
    """Top disk I/O consumers ranked by combined read+write KB/s.

    Prefers `pidstat -d` when available; falls back to a short /proc/pid/io
    delta sample so the list is always based on live kernel counters.
    """
    if command_exists("pidstat"):
        out = run(["pidstat", "-d", "-h", "-p", "ALL", "1", "1"], timeout=20)
        parsed: list[dict[str, Any]] = []
        for line in out.splitlines():
            if not line.startswith("Average:") or "PID" in line or "kB_rd/s" in line:
                continue
            parts = line.split()
            if len(parts) < 7:
                continue
            try:
                pid = int(parts[1])
            except (TypeError, ValueError):
                continue
            read_kbps = safe_float(parts[2]) or 0.0
            write_kbps = safe_float(parts[3]) or 0.0
            command = " ".join(parts[6:])
            parsed.append({
                "pid": pid,
                "read_kbps": round(read_kbps, 2),
                "write_kbps": round(write_kbps, 2),
                "io_total_kbps": round(read_kbps + write_kbps, 2),
                "command": command,
                "process": command.split()[0] if command else None,
                "source": "pidstat",
            })
        if parsed:
            parsed.sort(key=lambda p: p.get("io_total_kbps") or 0.0, reverse=True)
            return _enrich_disk_io_process_meta(parsed[:limit])

    def _sample_proc_io() -> dict[int, tuple[int, int]]:
        snap: dict[int, tuple[int, int]] = {}
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            pid = int(entry.name)
            io_path = entry / "io"
            if not io_path.is_file():
                continue
            text = read_file(io_path)
            rb = safe_int(get_value(r"^read_bytes:\s+(\d+)", text)) or 0
            wb = safe_int(get_value(r"^write_bytes:\s+(\d+)", text)) or 0
            snap[pid] = (rb, wb)
        return snap

    ps_out = run(["ps", "-eo", "pid,user,%cpu,%mem,comm,args", "--sort=-%cpu"])
    ps_meta: dict[int, dict[str, Any]] = {}
    for line in ps_out.splitlines()[1:]:
        parts = line.split(None, 6)
        if len(parts) < 7:
            continue
        pid = safe_int(parts[0])
        if pid is None:
            continue
        ps_meta[pid] = {
            "pid": pid,
            "user": parts[1],
            "cpu_percent": safe_float(parts[2]),
            "memory_percent": safe_float(parts[3]),
            "process": parts[5],
            "command": parts[6],
        }

    first = _sample_proc_io()
    time.sleep(0.35)
    second = _sample_proc_io()
    dt = 0.35
    results: list[dict[str, Any]] = []
    for pid, (rb1, wb1) in first.items():
        rb2, wb2 = second.get(pid, (None, None))
        if rb2 is None or wb2 is None:
            continue
        read_kbps = max(rb2 - rb1, 0) / 1024.0 / dt
        write_kbps = max(wb2 - wb1, 0) / 1024.0 / dt
        total = read_kbps + write_kbps
        if total <= 0:
            continue
        meta = ps_meta.get(pid, {})
        results.append({
            "pid": pid,
            "user": meta.get("user"),
            "cpu_percent": meta.get("cpu_percent"),
            "memory_percent": meta.get("memory_percent"),
            "process": meta.get("process"),
            "command": meta.get("command"),
            "read_kbps": round(read_kbps, 2),
            "write_kbps": round(write_kbps, 2),
            "io_total_kbps": round(total, 2),
            "source": "proc_io",
        })

    results.sort(key=lambda p: p.get("io_total_kbps") or 0.0, reverse=True)
    return results[:limit]


def _enrich_disk_io_process_meta(processes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Attach ps user/cpu/mem fields to pidstat/nethogs rows when missing."""
    if not processes:
        return processes
    pids = {p["pid"] for p in processes if p.get("pid") is not None}
    if not pids:
        return processes
    ps_out = run(["ps", "-eo", "pid,user,%cpu,%mem,comm,args"])
    meta: dict[int, dict[str, Any]] = {}
    for line in ps_out.splitlines()[1:]:
        parts = line.split(None, 6)
        if len(parts) < 7:
            continue
        pid = safe_int(parts[0])
        if pid is None or pid not in pids:
            continue
        meta[pid] = {
            "user": parts[1],
            "cpu_percent": safe_float(parts[2]),
            "memory_percent": safe_float(parts[3]),
            "process": parts[5],
            "command": parts[6],
        }
    enriched = []
    for proc in processes:
        pid = proc.get("pid")
        m = meta.get(pid, {})
        enriched.append({
            **proc,
            "user": proc.get("user") or m.get("user"),
            "cpu_percent": proc.get("cpu_percent") if proc.get("cpu_percent") is not None else m.get("cpu_percent"),
            "memory_percent": proc.get("memory_percent") if proc.get("memory_percent") is not None else m.get("memory_percent"),
            "process": proc.get("process") or m.get("process"),
            "command": proc.get("command") or m.get("command"),
        })
    return enriched


def _enrich_gpu_process_meta(processes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Attach ps user/cpu/mem fields to nvidia-smi process rows when missing."""
    if not processes:
        return processes
    pids = {p["pid"] for p in processes if p.get("pid") is not None}
    if not pids:
        return processes
    ps_out = run(["ps", "-eo", "pid,user,%cpu,%mem,comm,args"])
    meta: dict[int, dict[str, Any]] = {}
    for line in ps_out.splitlines()[1:]:
        parts = line.split(None, 6)
        if len(parts) < 7:
            continue
        pid = safe_int(parts[0])
        if pid is None or pid not in pids:
            continue
        meta[pid] = {
            "user": parts[1],
            "cpu_percent": safe_float(parts[2]),
            "memory_percent": safe_float(parts[3]),
            "process": parts[5],
            "command": parts[6],
        }
    enriched: list[dict[str, Any]] = []
    for proc in processes:
        pid = proc.get("pid")
        m = meta.get(pid, {})
        enriched.append({
            **proc,
            "user": proc.get("user") or m.get("user"),
            "cpu_percent": proc.get("cpu_percent") if proc.get("cpu_percent") is not None else m.get("cpu_percent"),
            "memory_percent": proc.get("memory_percent") if proc.get("memory_percent") is not None else m.get("memory_percent"),
            "process": proc.get("process") or m.get("process"),
            "command": proc.get("command") or m.get("command"),
        })
    return enriched


@safe_collect("gpu_processes", fallback=[])
def get_gpu_processes() -> list[dict[str, Any]]:
    """
    Per-process GPU utilization.

    Priority:
        1. nvidia-smi pmon (GPU utilization)
        2. compute-apps (GPU memory only)
    """

    if not command_exists("nvidia-smi"):
        return []

    processes = []

    # ---------------------------------------------------
    # STEP 1 : Try PMON (per-process utilization)
    # ---------------------------------------------------

    pmon = run([
        "nvidia-smi",
        "pmon",
        "-s",
        "um",
        "-c",
        "1"
    ])

    if pmon:

        memory_lookup = {}

        query = run([
            "nvidia-smi",
            "--query-compute-apps=pid,used_gpu_memory",
            "--format=csv,noheader,nounits"
        ])

        for line in query.splitlines():
            fields = [x.strip() for x in line.split(",")]
            if len(fields) != 2:
                continue

            memory_lookup[safe_int(fields[0])] = safe_int(fields[1])

        for line in pmon.splitlines():

            if line.startswith("#"):
                continue

            parts = line.split()

            if len(parts) < 11:
                continue

            gpu = safe_int(parts[0])
            pid = safe_int(parts[1])

            if pid is None:
                continue

            proc_type = parts[2]

            def parse(v):
                if v == "-":
                    return None
                return safe_float(v)

            sm = parse(parts[3])
            mem = parse(parts[4])
            enc = parse(parts[5])
            dec = parse(parts[6])

            command = " ".join(parts[10:])

            processes.append({
                "gpu": gpu,
                "pid": pid,
                "process": command,
                "type": proc_type,
                "gpu_compute_percent": sm,
                "gpu_memory_percent": mem,
                "encoder_percent": enc,
                "decoder_percent": dec,
                "gpu_memory_mb": memory_lookup.get(pid),
            })

        if processes:
            return _enrich_gpu_process_meta(processes)

    # ---------------------------------------------------
    # STEP 2 : Fallback
    # ---------------------------------------------------

    out = run([
        "nvidia-smi",
        "--query-compute-apps=pid,process_name,used_gpu_memory",
        "--format=csv,noheader,nounits"
    ])

    for line in out.splitlines():

        fields = [x.strip() for x in line.split(",")]

        if len(fields) != 3:
            continue

        processes.append({
            "gpu": 0,
            "pid": safe_int(fields[0]),
            "process": fields[1],
            "type": "C",
            "gpu_compute_percent": None,
            "gpu_memory_percent": None,
            "encoder_percent": None,
            "decoder_percent": None,
            "gpu_memory_mb": safe_int(fields[2]),
        })

    return _enrich_gpu_process_meta(processes)


# --------------------------------------------------------------------------
# Trial6: NIC PROCESS ATTRIBUTION (top per-process network consumers)
# --------------------------------------------------------------------------

_NIC_PROC_LINE_RE = re.compile(
    r"^(?P<program>.+)/(?P<pid>\d+)/(?P<uid>\d+)\s+(?P<sent>[\d.]+)\s+(?P<recv>[\d.]+)"
)


@safe_collect("top_nic_processes", fallback=[])
def get_top_nic_processes(limit: int = 50) -> list[dict[str, Any]]:
    """Top per-process network bandwidth consumers, ranked by combined
    sent+received KB/s -- the NIC-domain equivalent of
    get_top_cpu_processes()/get_top_disk_io_processes().

    Primary source: nethogs (live KB/s per PID). When nethogs is
    unavailable, falls back to pgrep/ss socket-owner discovery so recovery
    can still target the workload PID (rates may read 0 until nethogs works).
    """
    results: list[dict[str, Any]] = []

    if command_exists("nethogs"):
        out = run(["sudo", "-n", "nethogs", "-t", "-c", "2"], timeout=LONG_TIMEOUT, use_cache=False)
        if out.strip():
            for line in out.splitlines():
                line = line.strip()
                if not line or line.lower().startswith(("refreshing", "nethogs")):
                    continue
                m = _NIC_PROC_LINE_RE.match(line)
                if not m:
                    continue

                pid = safe_int(m.group("pid"))
                if pid is None or pid == 0:
                    continue

                sent_kbps = safe_float(m.group("sent")) or 0.0
                recv_kbps = safe_float(m.group("recv")) or 0.0
                program = m.group("program").strip()

                results.append({
                    "pid": pid,
                    "program": program,
                    "process": program.rsplit("/", 1)[-1] if program else None,
                    "sent_kbps": round(sent_kbps, 2),
                    "received_kbps": round(recv_kbps, 2),
                    "total_kbps": round(sent_kbps + recv_kbps, 2),
                    "rx_mbps": _kbps_to_mbps(recv_kbps),
                    "tx_mbps": _kbps_to_mbps(sent_kbps),
                    "total_mbps": _kbps_to_mbps(sent_kbps + recv_kbps),
                    "source": "nethogs",
                })

    if results:
        by_pid: dict[int, dict[str, Any]] = {}
        for entry in results:
            existing = by_pid.get(entry["pid"])
            if existing is None or entry["total_kbps"] > existing["total_kbps"]:
                by_pid[entry["pid"]] = entry
        merged = sorted(by_pid.values(), key=lambda p: p["total_kbps"], reverse=True)
        return _enrich_disk_io_process_meta(merged[:limit])

    return _nic_processes_pid_fallback(limit)

# ============================================================================
# TRIAL 7 PATCH -- paste this whole block into collect_metrics_final.py
# right after the existing "Trial6: NIC PROCESS ATTRIBUTION" section
# (i.e. right before `def collect_metrics() -> dict[str, Any]:`).
#
# It depends only on things that already exist earlier in that file:
#   run(), safe_int(), safe_float(), read_file(), read_stripped(),
#   command_exists(), logger, safe_collect, NET_CLASS_PATH, LONG_TIMEOUT,
#   get_top_nic_processes(), get_nic_metrics(), _get_kernel_log(),
#   _nic_kill_process/_nic_restart_interface/_nic_reload_driver/
#   _nic_renew_dhcp/_nic_restart_network_manager, validate_pid(),
#   validate_interface(), record_recovery_history()
#
# See the bottom of this file for the 3 small edits needed elsewhere in
# collect_metrics_final.py to wire this in.
# ============================================================================

# ----------------------------------------------------------------------------
# Part 1: process-agnostic NIC process attribution (nethogs -> ss -tpn ->
# lsof -i -> /proc/<pid>/fd + /proc/net -> netstat -p)
# ----------------------------------------------------------------------------

def _network_process_entry(pid: int, user, process, command,
                            rx_mbps: float = None, tx_mbps: float = None) -> dict:
    rx = round(rx_mbps, 2) if rx_mbps is not None else 0.0
    tx = round(tx_mbps, 2) if tx_mbps is not None else 0.0
    return {
        "pid": pid,
        "user": user,
        "process": process,
        "command": command,
        "rx_mbps": rx,
        "tx_mbps": tx,
        "total_mbps": round(rx + tx, 2),
    }


def _network_processes_via_nethogs(limit: int) -> list:
    """Source 1 (highest priority): nethogs gives real per-PID KB/s, which
    we convert to the spec's Mb/s. Reuses the existing Trial6 collector
    instead of shelling out to nethogs a second time."""
    nic_procs = get_top_nic_processes(limit=limit)
    if not nic_procs:
        return []
    results = []
    for p in nic_procs:
        rx_mbps = (p.get("received_kbps") or 0.0) * 8 / 1000.0
        tx_mbps = (p.get("sent_kbps") or 0.0) * 8 / 1000.0
        results.append(_network_process_entry(
            pid=p.get("pid"), user=p.get("user"), process=p.get("process"),
            command=p.get("command"), rx_mbps=rx_mbps, tx_mbps=tx_mbps,
        ))
    return results


_SS_PID_RE = re.compile(r'users:\(\("(?P<proc>[^"]+)",pid=(?P<pid>\d+)')


def _network_processes_via_ss(limit: int) -> list:
    """Source 2: `ss -tpn` identifies the owning PID of each TCP socket.
    No live byte rate is available this way, so rx_mbps/tx_mbps come back
    as 0.0 -- still enough to know a dominant process exists."""
    if not command_exists("ss"):
        return []
    out = run(["ss", "-tpn"], use_cache=False)
    if not out.strip():
        return []
    pid_to_proc = {}
    for line in out.splitlines():
        m = _SS_PID_RE.search(line)
        if not m:
            continue
        pid = safe_int(m.group("pid"))
        if pid:
            pid_to_proc[pid] = m.group("proc")
    return _enrich_network_pids(pid_to_proc, limit) if pid_to_proc else []


_LSOF_PID_RE = re.compile(r"^(?P<proc>\S+)\s+(?P<pid>\d+)\s")


def _network_processes_via_lsof(limit: int) -> list:
    """Source 3: `lsof -i` -- same PID-only limitation as ss."""
    if not command_exists("lsof"):
        return []
    out = run(["sudo", "-n", "lsof", "-i", "-n", "-P"], use_cache=False, timeout=LONG_TIMEOUT)
    if not out.strip():
        return []
    pid_to_proc = {}
    for line in out.splitlines()[1:]:  # skip header row
        m = _LSOF_PID_RE.match(line)
        if not m:
            continue
        pid = safe_int(m.group("pid"))
        if pid:
            pid_to_proc[pid] = m.group("proc")
    return _enrich_network_pids(pid_to_proc, limit) if pid_to_proc else []


def _network_processes_via_proc_net(limit: int) -> list:
    """Source 4: cross-reference /proc/net/{tcp,udp,tcp6,udp6} socket
    inodes against every process's /proc/<pid>/fd symlinks
    ("socket:[<inode>]"). Needs no external tool at all, so it's the
    last resort that's always available on any Linux box."""
    inode_files = ("/proc/net/tcp", "/proc/net/tcp6", "/proc/net/udp", "/proc/net/udp6")
    active_inodes = set()
    for f in inode_files:
        for line in read_file(f).splitlines()[1:]:
            parts = line.split()
            if len(parts) > 9 and parts[9] not in ("", "0"):
                active_inodes.add(parts[9])
    if not active_inodes:
        return []

    pid_to_proc = {}
    try:
        pid_dirs = [d for d in os.listdir("/proc") if d.isdigit()]
    except Exception:
        return []

    for pid_str in pid_dirs:
        fd_dir = Path(f"/proc/{pid_str}/fd")
        try:
            fds = os.listdir(fd_dir)
        except Exception:
            continue
        for fd in fds:
            try:
                target = os.readlink(fd_dir / fd)
            except Exception:
                continue
            m = re.match(r"socket:\[(\d+)\]", target)
            if m and m.group(1) in active_inodes:
                pid = safe_int(pid_str)
                if pid:
                    pid_to_proc[pid] = read_stripped(f"/proc/{pid_str}/comm")
                break

    return _enrich_network_pids(pid_to_proc, limit) if pid_to_proc else []


_NETSTAT_PID_RE = re.compile(r"(?P<pid>\d+)/(?P<proc>\S+)\s*$")


def _network_processes_via_netstat(limit: int) -> list:
    """Source 5 (last resort): `netstat -p`."""
    if not command_exists("netstat"):
        return []
    out = run(["sudo", "-n", "netstat", "-tpn"], use_cache=False)
    if not out.strip():
        return []
    pid_to_proc = {}
    for line in out.splitlines():
        m = _NETSTAT_PID_RE.search(line)
        if not m:
            continue
        pid = safe_int(m.group("pid"))
        if pid:
            pid_to_proc[pid] = m.group("proc")
    return _enrich_network_pids(pid_to_proc, limit) if pid_to_proc else []


def _enrich_network_pids(pid_to_proc: dict, limit: int) -> list:
    """Turn a bare {pid: process_name} map (sources 2-5, none of which
    give a live rate) into entries matching get_top_network_processes()'s
    schema, filling in user/command from `ps`."""
    ps_out = run(["ps", "-eo", "pid,user,args"])
    meta = {}
    for line in ps_out.splitlines()[1:]:
        parts = line.split(None, 2)
        if len(parts) < 2:
            continue
        pid = safe_int(parts[0])
        if pid is None or pid not in pid_to_proc:
            continue
        meta[pid] = {"user": parts[1], "command": parts[2] if len(parts) > 2 else None}

    results = []
    for pid, proc_name in pid_to_proc.items():
        m = meta.get(pid, {})
        results.append(_network_process_entry(
            pid=pid, user=m.get("user"), process=proc_name,
            command=m.get("command") or proc_name,
        ))
    return results[:limit]


def _nic_processes_pid_fallback(limit: int) -> list[dict[str, Any]]:
    """Discover network workload PIDs when nethogs cannot attribute rates.

    Uses pgrep -a (e.g. iperf3) and ss -tpn socket owners. Rates are 0
    until nethogs is available, but PID/command are real for recovery actions.
    """
    by_pid: dict[int, dict[str, Any]] = {}

    def _add(pid: Optional[int], process: Optional[str], command: Optional[str], source: str) -> None:
        if pid is None or pid <= 0:
            return
        proc_name = (process or "").rsplit("/", 1)[-1] if process else None
        by_pid[pid] = {
            "pid": pid,
            "program": process or proc_name,
            "process": proc_name or process,
            "command": command or process or proc_name,
            "sent_kbps": 0.0,
            "received_kbps": 0.0,
            "total_kbps": 0.0,
            "rx_mbps": 0.0,
            "tx_mbps": 0.0,
            "total_mbps": 0.0,
            "source": source,
        }

    if command_exists("pgrep"):
        for name in ("iperf3", "iperf", "curl", "wget", "rsync", "scp", "ssh"):
            out = run(["pgrep", "-a", name], use_cache=False)
            for line in out.splitlines():
                line = line.strip()
                if not line:
                    continue
                parts = line.split(None, 1)
                pid = safe_int(parts[0])
                cmd = parts[1].strip() if len(parts) > 1 else name
                _add(pid, name, cmd, "pgrep")

    if command_exists("ss"):
        out = run(["ss", "-tpn"], use_cache=False)
        for line in out.splitlines():
            m = _SS_PID_RE.search(line)
            if not m:
                continue
            pid = safe_int(m.group("pid"))
            if pid and pid not in by_pid:
                _add(pid, m.group("proc"), None, "ss")

    if not by_pid:
        return []

    pgrep_entries = [p for p in by_pid.values() if p.get("source") == "pgrep"]
    if pgrep_entries:
        merged = sorted(pgrep_entries, key=lambda p: p.get("pid") or 0)
        return _enrich_disk_io_process_meta(merged[:limit])

    ss_entries = [p for p in by_pid.values() if p.get("source") == "ss"]
    merged = sorted(ss_entries, key=lambda p: p.get("pid") or 0)
    return _enrich_disk_io_process_meta(merged[:limit])


def _network_processes_have_rates(results: list) -> bool:
    return any((p.get("total_mbps") or 0) > 0 for p in results)


@safe_collect("top_network_processes", fallback=[])
def get_top_network_processes(limit: int = 50) -> list:
    """Part 1 of the NIC self-healing upgrade spec: process-agnostic
    network-bandwidth attribution. Tries, in order:
        nethogs -> ss -tpn -> lsof -i -> /proc/<pid>/fd + /proc/net ->
        netstat -p
    and returns the first source that yields data with live rates when
    available. Returns [] (never raises) if none are available.

    Deliberately a *sibling* to get_top_nic_processes() (Trial6), not a
    replacement -- that function's KB/s schema stays exactly as-is for
    its existing callers (the "nic" recovery-candidates domain, the
    nic.pause/resume/terminate/kill_process actions). This one implements
    the fallback chain and rx_mbps/tx_mbps schema the spec asks for, and
    backs both the new top_processes["network"] key and the automated
    decision engine below.
    """
    for source_fn in (
        _network_processes_via_nethogs,
        _network_processes_via_ss,
        _network_processes_via_lsof,
        _network_processes_via_proc_net,
        _network_processes_via_netstat,
    ):
        try:
            results = source_fn(limit)
        except Exception as exc:  # noqa: BLE001
            logger.debug("network process source %s failed: %s", source_fn.__name__, exc)
            continue
        if not results:
            continue
        if source_fn is _network_processes_via_nethogs or _network_processes_have_rates(results):
            return sorted(results, key=lambda p: p.get("total_mbps") or 0, reverse=True)
    return []


# ----------------------------------------------------------------------------
# Parts 3-6: automated NIC self-healing decision engine
# ----------------------------------------------------------------------------

# Configurable thresholds (Part 6: nothing here is hardcoded to a
# particular tool -- these are pure numeric knobs).
NIC_DOMINANT_PROCESS_PERCENT = 60.0       # % of total attributed Mb/s owned by one PID
NIC_WATCHDOG_LOG_PATTERN = re.compile(r"NETDEV WATCHDOG|Transmit timeout", re.IGNORECASE)
NIC_ESCALATION_SETTLE_SECONDS = 2.0


def _nic_primary_metrics(iface: str) -> dict:
    for entry in get_nic_metrics():
        if entry.get("name") == iface:
            return entry
    return {}


def _nic_has_ip_address(iface: str) -> bool:
    out = run(["ip", "-4", "addr", "show", "dev", iface], use_cache=False)
    return "inet " in out


def _nic_kernel_log_has_watchdog_event(kernel_log: str) -> bool:
    return bool(kernel_log) and bool(NIC_WATCHDOG_LOG_PATTERN.search(kernel_log))


def _nic_report(component: str, action: str, result: str, **extra) -> dict:
    """Part 5: recovery report shape, matching the spec's examples
    (component/action/.../result/verification)."""
    report = {"component": component, "action": action, "result": result}
    report.update(extra)
    return report


def evaluate_and_heal_nic(iface: str = None, confirmation: dict = None, fault: dict = None) -> dict:
    stages: list[dict[str, Any]] = []

    def stage(message: str, detail: str = None) -> None:
        stages.append({
            "message": message,
            "detail": detail,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    stage("Collecting telemetry...")
    before_metrics = _safe_collect_metrics()

    if iface is None:
        sys_metrics = before_metrics.get("system") or {}
        iface = sys_metrics.get("default_route_interface")
        if not iface:
            up = [
                n.get("name")
                for n in (before_metrics.get("nic") or [])
                if str(n.get("link_state") or "").lower() == "up"
            ]
            iface = up[0] if up else None
        if not iface:
            candidates = [n.get("name") for n in get_nic_inventory() if n.get("mac")]
            iface = candidates[0] if candidates else ((_list_interfaces() or [None])[0])

    if not iface:
        stage("Failed", "No usable network interface found")
        return {"result": "failed", "stages": stages, "message": "no usable interface found"}

    ok, reason, iface = validate_interface(iface)
    if not ok:
        stage("Failed", reason)
        return {"result": "failed", "stages": stages, "interface": iface, "message": reason}

    stage("Analysing interface...", iface)
    before = _nic_primary_metrics(iface)
    before_dropped = (before.get("rx_dropped") or 0) + (before.get("tx_dropped") or 0)
    before_util = max(
        before.get("utilization_percent") or 0.0,
        before.get("rx_utilization_percent") or 0.0,
        before.get("tx_utilization_percent") or 0.0,
    )

    action_result: dict = {}
    fault_context = {"interface": iface, "reason": None, **(fault or {})}

    link_state = (before.get("link_state") or "").lower()
    if link_state != "up":
        fault_context["reason"] = "link_down"
        stage("Restarting interface...", iface)
        raw = _nic_restart_interface({"interface": iface})
        after_link = _nic_primary_metrics(iface)
        link_back = (after_link.get("link_state") or "").lower() == "up"
        action_result = _nic_report(
            "NIC", "Restart Interface",
            "success" if raw.get("success") and link_back else "failed",
            interface=iface,
            verification="link up" if link_back else "link still down",
            message=raw.get("message", ""),
        )
    else:
        kernel_log = _get_kernel_log()

        if _nic_kernel_log_has_watchdog_event(kernel_log):
            fault_context["reason"] = "netdev_watchdog_or_tx_timeout"
            stage("Reloading driver...", iface)
            raw = _nic_reload_driver({"interface": iface})
            action_result = _nic_report(
                "NIC", "Reload Driver", "success" if raw.get("success") else "failed",
                interface=iface, message=raw.get("message", ""),
            )
        elif not _nic_has_ip_address(iface):
            fault_context["reason"] = "missing_ip_address"
            stage("Renewing DHCP...", iface)
            raw = _nic_renew_dhcp({"interface": iface})
            if not raw.get("success"):
                stage("Restarting NetworkManager...")
                raw = _nic_restart_network_manager({})
            action_result = _nic_report(
                "NIC", "Renew DHCP", "success" if raw.get("success") else "failed",
                interface=iface, message=raw.get("message", ""),
            )
        else:
            rx_util = before.get("rx_utilization_percent") or 0.0
            tx_util = before.get("tx_utilization_percent") or 0.0
            total_util = before.get("utilization_percent") or max(rx_util, tx_util)
            high_utilization = total_util >= NIC_UTILIZATION_CRITICAL_PERCENT
            total_errors = (before.get("rx_errors") or 0) + (before.get("tx_errors") or 0)
            has_fault_signal = high_utilization or total_errors > 0 or fault is not None

            if not has_fault_signal:
                stage("Verified", "Utilization and error counters nominal — no action required")
                return {
                    "result": "success",
                    "stages": stages,
                    "interface": iface,
                    "before_utilization": round(before_util, 2),
                    "after_utilization": round(before_util, 2),
                    "message": "utilization below threshold, no action needed",
                }

            fault_context["reason"] = "high_utilization" if high_utilization else "interface_errors"
            stage("Finding offending process...")
            top_procs = get_top_nic_processes(limit=20)
            total_kbps = sum(p.get("total_kbps") or 0.0 for p in top_procs) or 0.0
            dominant = top_procs[0] if top_procs else None
            dominant_share = (
                (dominant.get("total_kbps") or 0.0) / total_kbps * 100
                if dominant and total_kbps > 0 else 0.0
            )

            if dominant and dominant_share >= NIC_DOMINANT_PROCESS_PERCENT:
                ok_pid, reason_pid, pid = validate_pid(dominant.get("pid"))
                if ok_pid:
                    stage("Pausing process...", f"PID {pid} · {dominant.get('process') or dominant.get('command')}")
                    pause_raw = _nic_pause_process({"pid": pid})
                    if pause_raw.get("success"):
                        action_result = _nic_report(
                            "NIC", "Pause Process", "success",
                            pid=pid, process=dominant.get("process"),
                            message=pause_raw.get("message", ""),
                        )
                    else:
                        stage("Terminating process...", f"PID {pid}")
                        raw = _nic_terminate_process({"pid": pid})
                        after_probe = _nic_primary_metrics(iface)
                        after_util = max(
                            after_probe.get("utilization_percent") or 0.0,
                            after_probe.get("rx_utilization_percent") or 0.0,
                            after_probe.get("tx_utilization_percent") or 0.0,
                        )
                        action_result = _nic_report(
                            "NIC", "Terminate Process",
                            "success" if raw.get("success") else "failed",
                            pid=pid, process=dominant.get("process"),
                            before_utilization=round(before_util, 2),
                            after_utilization=round(after_util, 2),
                            message=raw.get("message", ""),
                        )
                else:
                    stage("Restarting interface...", f"PID not recoverable: {reason_pid}")
                    raw = _nic_restart_interface({"interface": iface})
                    action_result = _nic_report(
                        "NIC", "Restart Interface", "success" if raw.get("success") else "failed",
                        interface=iface,
                        message=raw.get("message", ""),
                        note=f"dominant pid not recoverable ({reason_pid})",
                    )
            else:
                stage("Restarting interface...", "No single dominant process — resetting link")
                raw = _nic_restart_interface({"interface": iface})
                action_result = _nic_report(
                    "NIC", "Restart Interface", "success" if raw.get("success") else "failed",
                    interface=iface, message=raw.get("message", ""),
                )
                after_kernel_log = _get_kernel_log()
                if _nic_kernel_log_has_watchdog_event(after_kernel_log):
                    stage("Reloading driver...", "Driver errors persist after interface restart")
                    reload_raw = _nic_reload_driver({"interface": iface})
                    action_result = _nic_report(
                        "NIC", "Reload Driver", "success" if reload_raw.get("success") else "failed",
                        interface=iface, message=reload_raw.get("message", ""),
                    )

    stage("Verifying recovery...")
    time.sleep(NIC_ESCALATION_SETTLE_SECONDS)
    after = _nic_primary_metrics(iface)
    after_dropped = (after.get("rx_dropped") or 0) + (after.get("tx_dropped") or 0)
    after_metrics = _safe_collect_metrics()

    if after_dropped > before_dropped and action_result.get("result") == "success":
        action_result["result"] = "escalated"
        action_result["message"] = (
            f"{action_result.get('message', '')} — RX/TX dropped packets still rising "
            f"({before_dropped} -> {after_dropped})"
        ).strip()
        stage("Escalated", action_result["message"])
    elif action_result.get("result") == "success":
        stage("Recovered", action_result.get("message") or "NIC metrics improved")
    else:
        stage("Failed", action_result.get("message") or "Recovery action did not succeed")

    record_recovery_history(
        action=f"nic.auto_heal.{fault_context.get('reason') or 'unknown'}",
        params={"interface": iface},
        fault=fault_context,
        confirmation=confirmation or {"userAcknowledged": True, "level": "auto"},
        command=action_result.get("action", "nic.auto_heal"),
        success=action_result.get("result") == "success",
        message=action_result.get("message", action_result.get("verification", "")),
        stdout="", stderr="", returncode=None,
        before_metrics=before_metrics,
        after_metrics=after_metrics,
        duration_seconds=None,
    )

    return {
        **action_result,
        "stages": stages,
        "interface": iface,
        "beforeMetrics": before_metrics,
        "afterMetrics": after_metrics,
    }




def collect_metrics() -> dict[str, Any]:
    """Collect live, changing performance metrics."""
    metrics = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "system": get_system_metrics(),
        "cpu": get_cpu_metrics(),
        "memory": get_memory_metrics(),
        "disk": get_disk_metrics(),
        "gpu": get_gpu_inventory_and_metrics(),
        "nic": get_nic_metrics(),
        "psu": get_psu_metrics(),
        "top_processes": {
            "cpu": get_top_cpu_processes(),
            "gpu": get_gpu_processes(),
            "disk": get_top_disk_io_processes(limit=20),
            "nic": get_top_nic_processes(limit=20),
            "network": get_top_network_processes(limit=20),
        },
    }
    # DEMO: overwrite RAM/DISK/NIC fields per whatever severity is currently
    # set via /demo/<component>/<severity>. No-op while everything is
    # "healthy". CPU/GPU are never touched here.
    inject_metrics(metrics)
    return metrics


# ============================================================================
# 10. CPU HEALTH (link/interconnect health agent)
# ============================================================================


@safe_collect("cpu_inventory_extra", fallback={})
def get_cpu_inventory_extra() -> dict[str, Any]:
    lscpu = run(["lscpu"])
    cpuinfo = read_file("/proc/cpuinfo")

    microcode = get_value(r"^microcode\s*:\s*(\S+)", cpuinfo)
    cur_mhz = safe_float(get_value(r"CPU MHz:\s+(.*)", lscpu))
    max_mhz = safe_float(get_value(r"CPU max MHz:\s+(.*)", lscpu))
    min_mhz = safe_float(get_value(r"CPU min MHz:\s+(.*)", lscpu))

    # C-state: report the deepest idle state name/latency if cpuidle exposes it
    cstate = None
    cpuidle_root = CPUFREQ_PATH / "cpu0" / "cpuidle"
    if cpuidle_root.exists():
        states = sorted(p.name for p in cpuidle_root.iterdir() if p.name.startswith("state"))
        if states:
            deepest = states[-1]
            name = read_stripped(cpuidle_root / deepest / "name")
            latency = read_stripped(cpuidle_root / deepest / "latency")
            cstate = {"deepest_state": name, "exit_latency_us": safe_int(latency)}

    return {
        "microcode_version": null_if_empty(microcode),
        "current_mhz": cur_mhz,
        "max_mhz": max_mhz,
        "min_mhz": min_mhz,
        "deepest_cstate": cstate,
    }


@safe_collect("cpu_thermal_throttling", fallback=None)
def _get_cpu_thermal_throttling() -> Optional[dict[str, Any]]:
    counts = {}
    cpu_dirs = sorted(p for p in CPUFREQ_PATH.iterdir() if re.match(r"^cpu\d+$", p.name))
    for cpu_dir in cpu_dirs:
        throttle_dir = cpu_dir / "thermal_throttle"
        if not throttle_dir.exists():
            continue
        core_count = safe_int(read_stripped(throttle_dir / "core_throttle_count"))
        pkg_count = safe_int(read_stripped(throttle_dir / "package_throttle_count"))
        if core_count is not None or pkg_count is not None:
            counts[cpu_dir.name] = {
                "core_throttle_count": core_count,
                "package_throttle_count": pkg_count,
            }
    return counts or None


@safe_collect("cpu_mce", fallback={})
def _get_cpu_mce_counts(kernel_log: str) -> dict[str, Any]:
    """Count Machine Check Exception related lines in the cached kernel log."""
    if not kernel_log:
        return {"mce_error_count": None, "corrected_hardware_errors": None, "fatal_cpu_errors": None}

    mce_count = len(re.findall(r"mce:|Machine check", kernel_log, re.IGNORECASE))
    corrected = len(re.findall(r"Corrected error|CE memory read", kernel_log, re.IGNORECASE))
    fatal = len(re.findall(r"Kernel panic|Fatal machine check|Machine check events logged", kernel_log, re.IGNORECASE))

    return {
        "mce_error_count": mce_count,
        "corrected_hardware_errors": corrected,
        "fatal_cpu_errors": fatal,
    }


@safe_collect("rapl_power", fallback=None)
def get_rapl_power() -> Optional[list[dict[str, Any]]]:
    """Sample Intel RAPL energy counters twice to derive instantaneous
    package/DRAM power in watts. Returns None entirely if RAPL isn't
    exposed (non-Intel or unsupported platform)."""
    if not POWERCAP_PATH.exists():
        return None

    domains = [p for p in POWERCAP_PATH.iterdir() if p.name.startswith("intel-rapl")]
    if not domains:
        return None

    def sample() -> dict[str, tuple[Optional[int], Optional[int]]]:
        snap = {}
        for d in domains:
            name = read_stripped(d / "name")
            energy = safe_int(read_stripped(d / "energy_uj"))
            max_range = safe_int(read_stripped(d / "max_energy_range_uj"))
            snap[d.name] = (name, energy, max_range)
        return snap

    first = sample()
    t0 = time.time()
    time.sleep(0.2)
    t1 = time.time()
    dt = t1 - t0
    if dt <= 0:
        return None

    results = []
    for domain_id, (name, e1, max_range) in first.items():
        if e1 is None:
            continue
        d = POWERCAP_PATH / domain_id
        e2 = safe_int(read_stripped(d / "energy_uj"))
        if e2 is None:
            continue
        delta = e2 - e1
        if delta < 0 and max_range:  # counter wrapped
            delta += max_range
        watts = round((delta / 1_000_000) / dt, 2) if delta >= 0 else None
        results.append({"domain": name or domain_id, "power_watts": watts})

    return results or None


@safe_collect("cpu_health", fallback={})
def get_cpu_health(kernel_log: str) -> dict[str, Any]:
    mce = _get_cpu_mce_counts(kernel_log)
    throttling = _get_cpu_thermal_throttling()
    total_core_throttle = sum(
        (v.get("core_throttle_count") or 0) for v in (throttling or {}).values()
    )
    total_package_throttle = sum(
        (v.get("package_throttle_count") or 0) for v in (throttling or {}).values()
    )
    return {
        "mce_errors": mce.get("mce_error_count"),
        "corrected_errors": mce.get("corrected_hardware_errors"),
        "fatal_errors": mce.get("fatal_cpu_errors"),
        "thermal_throttling": throttling,
        "thermal_throttling_total_core_count": total_core_throttle,
        "thermal_throttling_total_package_count": total_package_throttle,
        "rapl_power": get_rapl_power(),
    }


# ============================================================================
# 11. MEMORY HEALTH -- EDAC
# ============================================================================


@safe_collect("memory_health", fallback=None)
def get_memory_health() -> Optional[dict[str, Any]]:
    """Prefer sysfs EDAC counters (no extra tooling required). Falls back to
    ras-mc-ctl / edac-util text output only to fill in what sysfs can't."""
    if not EDAC_MC_PATH.exists():
        return {"supported": False}

    mc_dirs = sorted(p for p in EDAC_MC_PATH.iterdir() if re.match(r"^mc\d+$", p.name))
    if not mc_dirs:
        return {"supported": False}

    controllers = []
    total_ce = 0
    total_ue = 0
    for mc_dir in mc_dirs:
        ce = safe_int(read_stripped(mc_dir / "ce_count"))
        ue = safe_int(read_stripped(mc_dir / "ue_count"))
        ce_noinfo = safe_int(read_stripped(mc_dir / "ce_noinfo_count"))
        ue_noinfo = safe_int(read_stripped(mc_dir / "ue_noinfo_count"))

        dimm_failures = []
        for csrow_dir in sorted(mc_dir.glob("csrow*")):
            row_ce = safe_int(read_stripped(csrow_dir / "ce_count"))
            row_ue = safe_int(read_stripped(csrow_dir / "ue_count"))
            if (row_ue or 0) > 0 or (row_ce or 0) > 0:
                dimm_failures.append({
                    "row": csrow_dir.name,
                    "correctable_errors": row_ce,
                    "uncorrectable_errors": row_ue,
                })

        if ce is not None:
            total_ce += ce
        if ue is not None:
            total_ue += ue

        controllers.append({
            "controller": mc_dir.name,
            "correctable_errors": ce,
            "uncorrectable_errors": ue,
            "correctable_errors_no_dimm_info": ce_noinfo,
            "uncorrectable_errors_no_dimm_info": ue_noinfo,
            "dimm_failures": dimm_failures,
        })

    return {
        "supported": True,
        "correctable_errors": total_ce,
        "uncorrectable_errors": total_ue,
        "memory_controller_errors": total_ue,  # UEs are controller-level failures
        "controllers": controllers,
    }


@safe_collect("memory_inventory_extra", fallback=[])
def get_memory_inventory_extra() -> list[dict[str, Any]]:
    """Extra DIMM-level inventory fields via dmidecode, keyed the same way
    your existing DIMM collector reports (locator).

    Note: deliberately does NOT gate on is_root() -- that checks whether
    this Python process itself is running as root, not whether `sudo -n`
    will succeed. A non-root user with passwordless sudo configured for
    dmidecode would be wrongly skipped, leaving this permanently empty
    even though `sudo dmidecode -t memory` works fine interactively.
    run() already fails safely (empty string) if sudo -n can't
    authenticate, so we just let it try."""
    if not command_exists("dmidecode"):
        return []
    dmi = run(["sudo", "-n", "dmidecode", "-t", "memory"], timeout=LONG_TIMEOUT)
    if not dmi:
        return []

    dimms = []
    for block in dmi.split("Memory Device"):
        size = get_value(r"^\s*Size:\s+(.*)$", block)
        if not size or "No Module Installed" in block:
            continue
        dimms.append({
            "locator": null_if_empty(get_value(r"Locator:\s+(.*)", block)),
            "size": null_if_empty(size),
            "manufacturer": null_if_empty(get_value(r"Manufacturer:\s+(.*)", block)),
            "serial": null_if_empty(get_value(r"Serial Number:\s+(.*)", block)),
            "part_number": null_if_empty(get_value(r"Part Number:\s+(.*)", block)),
            "configured_speed": null_if_empty(get_value(r"Configured Memory Speed:\s+(.*)", block)),
            "max_speed": null_if_empty(get_value(r"^\s*Speed:\s+(.*)$", block)),
            "rank": null_if_empty(get_value(r"Rank:\s+(.*)", block)),
            "ecc_supported": "ECC" in dmi,
        })
    return dimms


# ============================================================================
# 12. GPU HEALTH
# ============================================================================


def _classify_gpu_link_health(
    gen_current: Optional[int],
    gen_max: Optional[int],
    width_current: Optional[int],
    width_max: Optional[int],
    replay_errors: Optional[int],
    xid_errors: Optional[int],
    ecc_uncorrected: Optional[int],
    ecc_corrected: Optional[int],
) -> str:
    """
    Healthy / Power Saving / Warning / Critical for a GPU's PCIe link + ECC
    state. An idle GPU negotiating a lower PCIe generation while still at
    full link width, with zero replay/ECC errors, is normal ASPM power
    management -- NOT a fault.
    """
    if (xid_errors or 0) > 0 or (ecc_uncorrected or 0) > 0:
        return "Critical"

    width_degraded = (
        width_current is not None and width_max is not None and width_current < width_max
    )
    gen_degraded = (
        gen_current is not None and gen_max is not None and gen_current < gen_max
    )

    if width_degraded or (replay_errors or 0) > 0 or (ecc_corrected or 0) > 0:
        return "Warning"

    if gen_degraded and not width_degraded:
        return "Power Saving"

    return "Healthy"


@safe_collect("gpu_health", fallback=None)
def get_gpu_health(kernel_log: str) -> Optional[list[dict[str, Any]]]:
    if not command_exists("nvidia-smi"):
        return None

    query = (
        "name,driver_version,pci.bus_id,temperature.gpu,utilization.gpu,"
        "utilization.memory,power.draw,power.limit,fan.speed,"
        "ecc.errors.corrected.aggregate.total,ecc.errors.uncorrected.aggregate.total,"
        "retired_pages.sbe,retired_pages.dbe,"
        "pcie.link.gen.current,pcie.link.gen.max,"
        "pcie.link.width.current,pcie.link.width.max"
    )
    out = run(["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"])
    if not out.strip():
        return None

    # XID errors and GPU reset events only show up in the kernel log.
    xid_events = re.findall(r"NVRM: Xid.*?:\s*(\d+),", kernel_log or "")
    reset_count = len(re.findall(r"NVRM: GPU.*?resetting|falling back to blacklist", kernel_log or "", re.IGNORECASE))
    replay_errors = len(re.findall(r"NVRM:.*?PCIe.*?replay", kernel_log or "", re.IGNORECASE))

    gpus = []
    for idx, fields in enumerate(_nvidia_smi_csv_rows(out)):
        if len(fields) < 17:
            continue
        (name, driver, pci_bus, temp, util_gpu, util_mem, power_draw, power_limit,
         fan, ecc_corr, ecc_uncorr, sbe, dbe, gen_cur, gen_max, width_cur, width_max) = fields[:17]

        throttle_out = run(["nvidia-smi", "-i", str(idx), "-q", "-d", "PERFORMANCE"])
        throttle_reasons = {}
        for reason_line in re.findall(r"^\s+(\w[\w .]*)\s*:\s*(Active|Not Active)\s*$", throttle_out, re.MULTILINE):
            label, state = reason_line
            if "throttle" in label.lower() or "slowdown" in label.lower():
                throttle_reasons[label.strip()] = state == "Active"

        gen_cur_i = safe_int(gen_cur)
        gen_max_i = safe_int(gen_max)
        width_cur_i = safe_int(width_cur)
        width_max_i = safe_int(width_max)
        ecc_corr_i = safe_int(ecc_corr)
        ecc_uncorr_i = safe_int(ecc_uncorr)
        xid_count = len(xid_events)

        link_status = _classify_gpu_link_health(
            gen_cur_i, gen_max_i, width_cur_i, width_max_i,
            replay_errors, xid_count, ecc_uncorr_i, ecc_corr_i,
        )

        gpus.append({
            "index": idx,
            "model": name,
            "pci_bus_id": pci_bus,
            "health": {
                "temperature_celsius": safe_float(temp),
                "gpu_utilization_percent": safe_float(util_gpu),
                "memory_utilization_percent": safe_float(util_mem),
                "power_draw_watts": safe_float(power_draw),
                "power_limit_watts": safe_float(power_limit),
                "fan_speed_percent": safe_float(fan),
                "ecc_corrected": ecc_corr_i,
                "ecc_uncorrected": ecc_uncorr_i,
                "retired_pages_single_bit": safe_int(sbe),
                "retired_pages_double_bit": safe_int(dbe),
                "xid_errors": xid_count,
                "reset_count": reset_count,
                "replay_errors": replay_errors,
                "pcie_generation_current": gen_cur_i,
                "pcie_generation_max": gen_max_i,
                "pcie_width_current": width_cur_i,
                "pcie_width_max": width_max_i,
                "throttle_reasons": throttle_reasons or None,
                "link_status": link_status,
            },
        })

    return gpus or None


# ============================================================================
# 13 & 14. PCIe LINK STATE, AER, AND HEALTH EVALUATION
# ============================================================================


def _speed_to_gts(speed_str: Optional[str]) -> Optional[float]:
    if not speed_str:
        return None
    m = re.search(r"([\d.]+)\s*GT/s", speed_str)
    return float(m.group(1)) if m else None


def _width_to_int(width_str: Optional[str]) -> Optional[int]:
    if not width_str:
        return None
    m = re.search(r"(\d+)", width_str)
    return int(m.group(1)) if m else None


def _pci_descriptions() -> dict[str, str]:
    out = run(["lspci", "-D", "-mm"])
    desc_map: dict[str, str] = {}
    for line in out.splitlines():
        matches = re.findall(r'"((?:[^"\\]|\\.)*)"', line)
        if len(matches) >= 4:
            slot = line.split()[0]
            desc_map[slot] = f"{matches[1]} {matches[2]}"
    return desc_map


def _read_aer_counters(device_dir: Path) -> dict[str, Any]:
    """Real AER error counters from sysfs. total_errors is always included
    (even 0) since confirmed-zero is itself a meaningful signal."""
    breakdown: dict[str, Any] = {}
    total = 0
    any_file_readable = False

    for fname in _AER_FILES:
        text = read_file(device_dir / fname)
        if not text:
            continue
        any_file_readable = True
        counters: dict[str, int] = {}
        for line in text.splitlines():
            parts = line.split()
            if len(parts) == 2:
                val = safe_int(parts[1])
                if val is not None:
                    total += val
                    if val > 0:
                        counters[parts[0]] = val
        if counters:
            breakdown[fname.replace("aer_dev_", "")] = counters

    if not any_file_readable:
        return {}

    breakdown["total_errors"] = total
    return breakdown


# lspci -vv AER flag-register lines look like:
#   UESta:  DLP- SDES- TLP- FCP- CmpltTO- CmpltAbrt- UnxCmplt- RxOF- MalfTLP- ECRC- UnsupReq- ACSViol-
# A '+' after a flag name means that error condition is currently latched/set.
def _parse_flag_register(line: Optional[str]) -> dict[str, bool]:
    if not line:
        return {}
    flags = {}
    for name, sign in re.findall(r"(\w+)([+-])", line):
        flags[name] = sign == "+"
    return flags


# Friendly-name maps for AER correctable / uncorrectable flag registers, used
# both to expose human-readable error names in JSON and to drive health
# classification (Replay Timeout, Receiver Overflow, Bad DLLP, etc).
_CORRECTABLE_AER_FLAG_NAMES = {
    "RxErr": "Receiver Error",
    "BadTLP": "Bad TLP",
    "BadDLLP": "Bad DLLP",
    "Rollover": "Replay Counter",
    "Timeout": "Replay Timeout",
    "NonFatalErr": "Advisory Non-Fatal Error",
    "AdvNonFatalErr": "Advisory Non-Fatal Error",
    "CorrIntErr": "Corrected Internal Error",
    "HeaderOF": "Header Log Overflow",
}

_UNCORRECTABLE_AER_FLAG_NAMES = {
    "DLP": "Data Link Protocol Error",
    "SDES": "Surprise Down Error",
    "TLP": "Poisoned TLP",
    "FCP": "Flow Control Protocol Error",
    "CmpltTO": "Completion Timeout",
    "CmpltAbrt": "Completion Abort",
    "UnxCmplt": "Unexpected Completion",
    "RxOF": "Receiver Overflow",
    "MalfTLP": "Malformed TLP",
    "ECRC": "ECRC Error",
    "UnsupReq": "Unsupported Request",
    "ACSViol": "ACS Violation",
    "UncorrIntErr": "Uncorrectable Internal Error",
    "BlockedTLP": "Blocked TLP",
    "AtomicOpBlocked": "AtomicOp Blocked",
    "TLPBlockedErr": "TLP Blocked Error",
}


def _extract_lspci_block(device_text: str, header_prefix: str) -> Optional[str]:
    """Pull the lines belonging to a given 'Capabilities: [xx] <Header>' block
    out of a single device's lspci -vv text chunk."""
    lines = device_text.splitlines()
    capturing = False
    block_lines = []
    for line in lines:
        if re.match(r"^\s*Capabilities:.*" + re.escape(header_prefix), line):
            capturing = True
            block_lines.append(line)
            continue
        if capturing:
            if re.match(r"^\s*Capabilities:", line) or re.match(r"^\S", line):
                break
            block_lines.append(line)
    return "\n".join(block_lines) if block_lines else None


@safe_collect("pcie_extended_health", fallback={})
def _get_pcie_extended_health(slot: str, lspci_vv_full: str) -> dict[str, Any]:
    """Parse per-device AER status/severity flags and link training state
    out of `lspci -vv` for one device (identified by its slot/BDF)."""
    # Isolate this device's text chunk (from its header line to the next device header)
    pattern = re.compile(
        r"^" + re.escape(slot) + r".*?(?=^\S|\Z)", re.MULTILINE | re.DOTALL
    )
    m = pattern.search(lspci_vv_full)
    if not m:
        return {}
    chunk = m.group(0)

    aer_block = _extract_lspci_block(chunk, "Advanced Error Reporting")
    express_block = _extract_lspci_block(chunk, "Express")

    uncorrectable_status = _parse_flag_register(get_value(r"UESta:\s*(.*)", aer_block or ""))
    correctable_status = _parse_flag_register(get_value(r"CESta:\s*(.*)", aer_block or ""))
    severity = _parse_flag_register(get_value(r"UESvrt:\s*(.*)", aer_block or ""))

    lnkctl = get_value(r"LnkCtl:\s*(.*)", express_block or "")
    lnksta = get_value(r"LnkSta:\s*(.*)", express_block or "")

    aspm = get_value(r"ASPM\s+([A-Za-z0-9+ ]+?)(?:,|\s{2}|$)", lnkctl or "")
    data_link_active = "DLActive+" in (lnksta or "")
    l0s_enabled = bool(lnkctl) and "L0s+" in (lnkctl or "") or "ASPM L0s" in (lnkctl or "")
    l1_enabled = bool(lnkctl) and "L1+" in (lnkctl or "")

    fatal_flags = {k: v for k, v in uncorrectable_status.items() if v and severity.get(k)}
    non_fatal_flags = {k: v for k, v in uncorrectable_status.items() if v and not severity.get(k)}
    correctable_flags = {k: v for k, v in correctable_status.items() if v}

    fatal_errors_friendly = [_UNCORRECTABLE_AER_FLAG_NAMES.get(k, k) for k in fatal_flags]
    non_fatal_errors_friendly = [_UNCORRECTABLE_AER_FLAG_NAMES.get(k, k) for k in non_fatal_flags]
    correctable_errors_friendly = [_CORRECTABLE_AER_FLAG_NAMES.get(k, k) for k in correctable_flags]
    uncorrectable_errors_friendly = [
        _UNCORRECTABLE_AER_FLAG_NAMES.get(k, k) for k, v in uncorrectable_status.items() if v
    ]

    # Specific, individually addressable AER condition flags -- used for both
    # JSON exposure and health-engine classification.
    aer_flags = {
        "replay_timeout": bool(correctable_status.get("Timeout")),
        "replay_counter": bool(correctable_status.get("Rollover")),
        "receiver_overflow": bool(uncorrectable_status.get("RxOF")),
        "bad_dllp": bool(correctable_status.get("BadDLLP")),
        "bad_tlp": bool(correctable_status.get("BadTLP")),
        "malformed_tlp": bool(uncorrectable_status.get("MalfTLP")),
        "poisoned_tlp": bool(uncorrectable_status.get("TLP")),
        "unsupported_request": bool(uncorrectable_status.get("UnsupReq")),
        "completion_timeout": bool(uncorrectable_status.get("CmpltTO")),
        "completion_abort": bool(uncorrectable_status.get("CmpltAbrt")),
        "unexpected_completion": bool(uncorrectable_status.get("UnxCmplt")),
        "flow_control_protocol_error": bool(uncorrectable_status.get("FCP")),
        "ecrc_error": bool(uncorrectable_status.get("ECRC")),
    }

    return {
        "correctable_error_status": correctable_errors_friendly or None,
        "uncorrectable_error_status": uncorrectable_errors_friendly or None,
        "fatal_errors": fatal_errors_friendly or None,
        "non_fatal_errors": non_fatal_errors_friendly or None,
        "aer_flags": aer_flags,
        "aspm_state": aspm,
        "data_link_layer_active": data_link_active if lnksta else None,
        "l0s_enabled": l0s_enabled if lnkctl else None,
        "l1_enabled": l1_enabled if lnkctl else None,
        "idle_power_management": bool(aspm),
    }


def _classify_pcie_health(
    speed_degraded: bool, width_degraded: bool, aer: dict[str, Any], extended: dict[str, Any]
) -> str:
    """
    Healthy / Power Saving / Warning / Critical.

    CRITICAL only for fatal AER / fatal PCIe / fatal uncorrectable errors.
    WARNING for correctable AER errors, replay timeouts/counters, receiver
    overflow, bad DLLP/TLP, malformed/poisoned TLP, unsupported request,
    completion timeout/abort, or link width below maximum.
    POWER SAVING only when current speed < max speed, width == max width,
    zero AER/replay errors, no fatal/correctable errors, and ASPM/L0s/L1
    indicates active power management -- e.g. an idle NVIDIA GPU that has
    negotiated Gen1 while idle is Power Saving, never Warning.
    Everything else is Healthy.
    """
    aer = aer or {}
    extended = extended or {}

    fatal_sysfs = aer.get("fatal") or {}
    nonfatal_sysfs = aer.get("nonfatal") or {}
    correctable_sysfs = aer.get("correctable") or {}

    fatal_sysfs_total = sum(fatal_sysfs.values()) if isinstance(fatal_sysfs, dict) else 0
    nonfatal_sysfs_total = sum(nonfatal_sysfs.values()) if isinstance(nonfatal_sysfs, dict) else 0
    correctable_sysfs_total = sum(correctable_sysfs.values()) if isinstance(correctable_sysfs, dict) else 0

    total_aer_errors = aer.get("total_errors") or 0

    fatal_flags = extended.get("fatal_errors")
    non_fatal_flags = extended.get("non_fatal_errors")
    correctable_flags = extended.get("correctable_error_status")
    aer_flags = extended.get("aer_flags") or {}

    # ---- CRITICAL ----
    if fatal_flags or fatal_sysfs_total > 0:
        return "Critical"

    # ---- WARNING ----
    if (
        correctable_flags
        or non_fatal_flags
        or nonfatal_sysfs_total > 0
        or correctable_sysfs_total > 0
        or total_aer_errors > 0
        or aer_flags.get("replay_timeout")
        or aer_flags.get("replay_counter")
        or aer_flags.get("receiver_overflow")
        or aer_flags.get("bad_dllp")
        or aer_flags.get("bad_tlp")
        or aer_flags.get("malformed_tlp")
        or aer_flags.get("poisoned_tlp")
        or aer_flags.get("unsupported_request")
        or aer_flags.get("completion_timeout")
        or aer_flags.get("completion_abort")
    ):
        return "Warning"

    # ---- POWER SAVING ----
    if speed_degraded and not width_degraded and total_aer_errors == 0:
        if extended.get("idle_power_management"):
            return "Power Saving"
        return "Healthy"

    return "Healthy"


@safe_collect("pcie_link_health", fallback=[])
def get_pcie_link_health() -> list[dict[str, Any]]:
    devices: list[dict[str, Any]] = []
    if not PCI_DEVICES_PATH.exists():
        return devices

    desc_map = _pci_descriptions()
    # Deliberately uses `sudo -n lspci -vv` rather than gating on is_root():
    # is_root() only checks if this Python process itself is UID 0, so a
    # non-root user with passwordless sudo configured for lspci was being
    # wrongly skipped, leaving ASPM state / correctable-error-status /
    # fatal-error flags permanently absent from every PCIe device's health
    # block even though the same command works fine interactively. sudo -n
    # is a no-op prefix when already root, and run() fails safely (empty
    # string) if elevation isn't available, so this is safe either way.
    lspci_vv_full = run(["sudo", "-n", "lspci", "-vv"], timeout=LONG_TIMEOUT)

    for device_dir in sorted(PCI_DEVICES_PATH.iterdir()):
        addr = device_dir.name

        cur_speed_raw = read_stripped(device_dir / "current_link_speed")
        cur_width_raw = read_stripped(device_dir / "current_link_width")
        max_speed_raw = read_stripped(device_dir / "max_link_speed")
        max_width_raw = read_stripped(device_dir / "max_link_width")

        if not any([cur_speed_raw, cur_width_raw, max_speed_raw, max_width_raw]):
            continue

        cur_speed = _speed_to_gts(cur_speed_raw)
        max_speed = _speed_to_gts(max_speed_raw)
        cur_width = _width_to_int(cur_width_raw)
        max_width = _width_to_int(max_width_raw)

        speed_degraded = cur_speed is not None and max_speed is not None and cur_speed < max_speed
        width_degraded = cur_width is not None and max_width is not None and cur_width < max_width

        aer = _read_aer_counters(device_dir)
        extended = _get_pcie_extended_health(addr, lspci_vv_full) if lspci_vv_full else {}
        status = _classify_pcie_health(speed_degraded, width_degraded, aer, extended)

        devices.append({
            "slot": addr,
            "description": desc_map.get(addr),
            "kernel_driver": resolve_driver(device_dir),
            "link_current_speed_gts": cur_speed,
            "link_max_speed_gts": max_speed,
            "link_current_width": cur_width,
            "link_max_width": max_width,
            "link_speed_below_max": speed_degraded,
            "link_width_below_max": width_degraded,
            "aer": aer,
            "health": {**extended, "status": status},
        })

    return devices


# ============================================================================
# 15. NVMe HEALTH
# ============================================================================


_NVME_SMARTCTL_FIELD_MAP = {
    "critical_warning": "critical_warning",
    "temperature": "temperature",
    "available_spare": "available_spare",
    "available_spare_threshold": "available_spare_threshold",
    "percentage_used": "percentage_used",
    "data_units_read": "data_units_read",
    "data_units_written": "data_units_written",
    "host_reads": "host_reads",
    "host_writes": "host_writes",
    "controller_busy_time": "controller_busy_time",
    "power_cycles": "power_cycles",
    "power_on_hours": "power_on_hours",
    "unsafe_shutdowns": "unsafe_shutdowns",
    "media_errors": "media_errors",
    "num_err_log_entries": "num_err_log_entries",
    "warning_temp_time": "warning_temp_time",
    "critical_comp_time": "critical_comp_time",
}


@safe_collect("nvme_device_health", fallback={})
def _get_nvme_device_health(dev_path: str) -> dict[str, Any]:
    entry: dict[str, Any] = {"device": dev_path}

    if command_exists("smartctl"):
        # sudo -n: reading NVMe SMART pages requires elevated privileges on
        # most distros. Without it, this call silently returns empty output
        # for a non-root user even when smartctl itself is installed.
        out = run(["sudo", "-n", "smartctl", "-x", "-j", dev_path], timeout=LONG_TIMEOUT)
        parsed = None
        if out.strip():
            try:
                parsed = json.loads(out)
            except json.JSONDecodeError:
                parsed = None

        if parsed:
            log = parsed.get("nvme_smart_health_information_log", {})
            for src_key, dst_key in _NVME_SMARTCTL_FIELD_MAP.items():
                value = log.get(src_key)
                if isinstance(value, dict):
                    value = value.get("celsius") if "celsius" in value else value
                entry[dst_key] = value
            entry["smart_status_passed"] = (parsed.get("smart_status", {}) or {}).get("passed")
            entry["firmware_version"] = null_if_empty((parsed.get("firmware_version")))
            entry["temperature"] = (
                (parsed.get("temperature", {}) or {}).get("current") or entry.get("temperature")
            )
            return entry

    # Fallback: nvme-cli
    if command_exists("nvme"):
        json_out = run(["sudo", "-n", "nvme", "smart-log", dev_path, "-o", "json"])
        try:
            parsed = json.loads(json_out) if json_out.strip() else {}
        except json.JSONDecodeError:
            parsed = {}
        for _, dst_key in _NVME_SMARTCTL_FIELD_MAP.items():
            entry.setdefault(dst_key, parsed.get(dst_key))

    return entry


@safe_collect("nvme_health", fallback=[])
def get_nvme_health() -> list[dict[str, Any]]:
    if not NVME_CLASS_PATH.exists():
        return []
    results = []
    for name in sorted(os.listdir(NVME_CLASS_PATH)):
        if re.match(r"^nvme\d+$", name):
            results.append(_get_nvme_device_health(f"/dev/{name}"))
    return results


# ============================================================================
# 16. SATA HEALTH
# ============================================================================


_SATA_UNKNOWN_SPEED_VALUES = {"", "<unknown>", "unknown", "none"}


@safe_collect("sata_health", fallback=[])
def get_sata_health() -> list[dict[str, Any]]:
    if not ATA_LINK_CLASS_PATH.exists():
        return []

    results = []
    for name in sorted(os.listdir(ATA_LINK_CLASS_PATH)):
        link_dir = ATA_LINK_CLASS_PATH / name
        speed = read_stripped(link_dir / "sata_spd")
        speed_max = read_stripped(link_dir / "sata_spd_max")

        # Skip empty ports: no negotiated speed (or an explicit "<unknown>"
        # placeholder) means no drive is actually connected.
        if not speed or speed.strip().lower() in _SATA_UNKNOWN_SPEED_VALUES:
            continue

        port_name = name.split(".")[0]
        port_dir = ATA_PORT_CLASS_PATH / port_name
        reset_count = safe_int(read_stripped(port_dir / "nr_pmp_links")) if port_dir.exists() else None

        results.append({
            "link": name,
            "negotiated_speed": speed,
            "max_supported_speed": speed_max,
            "link_degraded": bool(speed_max and speed != speed_max),
            "link_reset_count": reset_count,
        })
    return results


# ============================================================================
# 17. USB HEALTH (journalctl -k pattern counting)
# ============================================================================


_USB_EVENT_PATTERNS = {
    "disconnect_events": r"USB disconnect",
    "reset_events": r"reset (high-speed|full-speed|low-speed|SuperSpeed).*USB device",
    "enumeration_failures": r"device not accepting address|unable to enumerate",
    "descriptor_read_failures": r"device descriptor read/(64|8), error",
    "over_current_events": r"over-current",
    "hub_errors": r"hub \d+-\d+:.*(error|problem)",
    "port_reset_failures": r"port reset failed|cannot reset",
}


@safe_collect("usb_health", fallback={})
def get_usb_health(kernel_log: str) -> dict[str, Any]:
    if not kernel_log:
        return {}
    return {
        field: len(re.findall(pattern, kernel_log, re.IGNORECASE))
        for field, pattern in _USB_EVENT_PATTERNS.items()
    }


@safe_collect("usb_inventory_health", fallback=[])
def get_usb_link_health() -> list[dict[str, Any]]:
    if not USB_DEVICES_PATH.exists():
        return []
    results = []
    for name in sorted(os.listdir(USB_DEVICES_PATH)):
        dev_dir = USB_DEVICES_PATH / name
        speed = read_stripped(dev_dir / "speed")
        version = read_stripped(dev_dir / "version")
        product = read_stripped(dev_dir / "product")
        if not speed:
            continue
        results.append({
            "device": name,
            "product": product,
            "usb_version": version,
            "negotiated_speed_mbps": safe_int(speed),
        })
    return results


# ============================================================================
# 18. NIC HEALTH (ethtool -S)
# ============================================================================


_NIC_HEALTH_KEYWORDS = [
    "crc", "align", "frame", "symbol", "phy", "fifo", "missed",
    "overrun", "carrier", "buffer", "pause", "rx_queue", "tx_queue",
    "collision",
]


@safe_collect("nic_health_stats", fallback={})
def _get_nic_ethtool_stats(iface: str) -> dict[str, int]:
    out = run(["ethtool", "-S", iface])
    if not out:
        return {}
    stats = {}
    for line in out.splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        val = safe_int(value.strip())
        if val is None:
            continue
        if any(kw in key.lower() for kw in _NIC_HEALTH_KEYWORDS):
            stats[key] = val
    return stats


@safe_collect("nic_health", fallback=[])
def get_nic_health() -> list[dict[str, Any]]:
    if not NET_CLASS_PATH.exists():
        return []
    results = []
    for name in sorted(os.listdir(NET_CLASS_PATH)):
        if name == "lo":
            continue
        stats_dir = NET_CLASS_PATH / name / "statistics"
        if not stats_dir.exists():
            continue

        basic_errors = {
            f: safe_int(read_stripped(stats_dir / f))
            for f in ("rx_errors", "tx_errors", "rx_dropped", "tx_dropped", "collisions")
        }
        results.append({
            "interface": name,
            "health": {**basic_errors, **_get_nic_ethtool_stats(name)},
        })
    return results


# ============================================================================
# 19. SYSTEM / KERNEL HARDWARE EVENTS
# ============================================================================


_KERNEL_EVENT_PATTERNS = {
    "machine_check_exception": r"mce:|Machine check",
    "pcie_bus_error": r"PCIe Bus Error",
    "pcie_aer": r"AER:",
    "edac": r"EDAC",
    "corrected_hardware_error": r"Corrected error",
    "uncorrectable_hardware_error": r"Uncorrectable Error",
    "fatal_hardware_error": r"Fatal.*(error|hardware)",
    "thermal_event": r"thermal.*(throttl|critical|trip)",
    "nvme_error": r"nvme.*\berror\b|NVMe Error|NVMe.*Media Error",
    "gpu_xid": r"NVRM: Xid|GPU XID",
    "usb_reset": r"reset.*USB device",
    "usb_disconnect": r"USB disconnect",
    "sata_link_reset": r"ata\d+: (soft|hard)?\s*reset|SATA Reset",
    "acpi_error": r"ACPI Error",
    "iommu_fault": r"DMAR:.*fault|IOMMU.*fault|IOMMU Fault",
    "hardware_failure": r"Hardware Error|hardware failure",
    "replay_timeout": r"Replay Timeout",
    "receiver_overflow": r"Receiver Overflow",
    "malformed_tlp": r"Malformed TLP",
    "poisoned_tlp": r"Poisoned TLP",
    "unsupported_request_error": r"Unsupported Request",
    "usb_enumeration_failure": r"USB Enumeration Failure|unable to enumerate|device not accepting address",
    "usb_reset_failure": r"USB Reset Failure|port reset failed|cannot reset",
    "edac_corrected": r"EDAC.*Corrected Error|EDAC Corrected",
    "edac_uncorrectable": r"EDAC.*Uncorrectable Error|EDAC Uncorrectable",
}

# Boot-time / informational noise that must never surface as a hardware
# warning (device registration, driver init, IRQ assignment, etc).
_KERNEL_EVENT_IGNORE_SUBSTRINGS = [
    "enabled",
    "registered",
    "version",
    "giving out device",
    "mapping bar",
    "irq",
    "default domain",
    "mc:",
    "aer enabled",
]


def _is_ignorable_kernel_line(line: str) -> bool:
    lower = line.lower()
    return any(substr in lower for substr in _KERNEL_EVENT_IGNORE_SUBSTRINGS)


_TIMESTAMP_RE = re.compile(r"^(\S+\s+\S+\s+\S+|\S+T\S+)")

# Narrow, specific leading-timestamp matcher used only to strip the
# timestamp before device-pattern matching (ISO8601 "2026-07-02T10:00:02" or
# syslog "Jul  2 10:00:02"). Deliberately stricter than _TIMESTAMP_RE (which
# is kept as-is for the existing "timestamp" field) so it can't accidentally
# swallow the rest of the line and hide a real device identifier.
_LEADING_TIMESTAMP_STRIP_RE = re.compile(
    r"^(?:\d{4}-\d{2}-\d{2}T\S+|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s*"
)


def extract_device(line):
    # Strip any leading timestamp first so timestamp text is never mistaken
    # for a device identifier (e.g. an ISO date fragment matching a pattern).
    search_text = line
    ts_match = _LEADING_TIMESTAMP_STRIP_RE.match(line)
    if ts_match:
        search_text = line[ts_match.end():]

    patterns = [
        r"([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9])",   # PCI, e.g. 0000:01:00.0
        r"(nvme\d+n?\d*)",                                  # nvme0, nvme0n1
        r"(sd[a-z]+\d*)",                                   # sda, sdb1
        r"(ata\d+)",                                        # ata2
        r"(usb\d+)",                                        # usb1
        r"(enp\w+|eno\d+|eth\d+|wlp\w+)",                   # eno1, wlp3s0, enp2s0
        r"(CPU\d+)",                                        # CPU0
    ]

    for p in patterns:
        m = re.search(p, search_text, re.IGNORECASE)
        if m:
            return m.group(1)

    return None


@safe_collect("kernel_events", fallback={})
def get_kernel_events(kernel_log: str) -> dict[str, Any]:
    if not kernel_log:
        return {}

    events: dict[str, list[dict[str, Any]]] = {}
    lines = kernel_log.splitlines()

    for category, pattern in _KERNEL_EVENT_PATTERNS.items():
        matches = []
        regex = re.compile(pattern, re.IGNORECASE)
        for line in lines:
            if _is_ignorable_kernel_line(line):
                continue
            if regex.search(line):
                ts_match = _TIMESTAMP_RE.match(line)
                severity = "critical" if re.search(r"fatal|panic|critical", line, re.IGNORECASE) else "warning"
                matches.append({
                    "timestamp": ts_match.group(1) if ts_match else None,
                    "severity": severity,
                    "device": extract_device(line),
                    "message": line.strip()[:300],
                })
                if len(matches) >= MAX_KERNEL_EVENTS_PER_CATEGORY:
                    break
        if matches:
            events[category] = matches

    return events


def _get_kernel_log() -> str:
    """One cached fetch of kernel messages for MCE/USB/kernel-event/GPU-XID
    parsing, reused across every collector that needs it."""
    if command_exists("journalctl"):
        out = run(["journalctl", "-k", "--no-pager", "-o", "short-iso"], timeout=LONG_TIMEOUT)
        if out.strip():
            return out
    return run(["dmesg", "-T"], timeout=LONG_TIMEOUT)


# ============================================================================
# 20. MOTHERBOARD HEALTH
# ============================================================================


@safe_collect("motherboard_health", fallback={})
def get_motherboard_health(kernel_events: dict[str, Any], pcie_devices: list[dict[str, Any]]) -> dict[str, Any]:
    pcie_fatal = sum(1 for d in pcie_devices if (d.get("health") or {}).get("status") == "Critical")
    pcie_warning = sum(1 for d in pcie_devices if (d.get("health") or {}).get("status") == "Warning")

    return {
        "acpi_errors": len(kernel_events.get("acpi_error", [])),
        "thermal_zone_errors": len(kernel_events.get("thermal_event", [])),
        "power_faults": len(re.findall(
            r"power fault|voltage.*(fault|error)", "\n".join(
                e.get("message", "") for cat in kernel_events.values() for e in cat
            ), re.IGNORECASE
        )) if kernel_events else 0,
        "pcie_errors": {"critical_links": pcie_fatal, "warning_links": pcie_warning},
        "chipset_errors": len(re.findall(
            r"chipset.*error", "\n".join(
                e.get("message", "") for cat in kernel_events.values() for e in cat
            ), re.IGNORECASE
        )) if kernel_events else 0,
    }


# ============================================================================
# 21. BIOS HEALTH
# ============================================================================


@safe_collect("bios_health", fallback={})
def get_bios_health() -> dict[str, Any]:
    # Deliberately does NOT gate on is_root() -- that checks whether this
    # Python process itself is running as root, not whether `sudo -n` will
    # succeed. A non-root user with passwordless sudo configured for
    # dmidecode would be wrongly skipped, leaving these fields permanently
    # null even though `sudo dmidecode -t bios` works fine interactively.
    # run() already fails safely (empty string) if sudo -n can't
    # authenticate, so we just let it try.
    bios = {}
    if command_exists("dmidecode"):
        bios = parse_key_value(run(["sudo", "-n", "dmidecode", "-t", "bios"], timeout=LONG_TIMEOUT))

    secure_boot = None
    if command_exists("mokutil"):
        mok_out = run(["mokutil", "--sb-state"])
        if "enabled" in mok_out.lower():
            secure_boot = True
        elif "disabled" in mok_out.lower():
            secure_boot = False

    return {
        "firmware_revision": null_if_empty(bios.get("Firmware Revision")),
        "bios_version": null_if_empty(bios.get("Version")),
        "bios_release_date": null_if_empty(bios.get("Release Date")),
        "uefi_mode": EFI_PATH.exists(),
        "secure_boot_enabled": secure_boot,
    }


# ============================================================================
# 22. OPTIONAL PLATFORM HEALTH -- IPMI, hwmon
# ============================================================================


@safe_collect("ipmi_health", fallback={"supported": False})
def get_ipmi_health() -> dict[str, Any]:
    if not command_exists("ipmitool"):
        return {"supported": False}

    sensors_out = run(["sudo", "-n", "ipmitool", "sdr", "elist"], timeout=LONG_TIMEOUT)
    if not sensors_out.strip():
        return {"supported": False}

    fans, temps, voltages, psus = [], [], [], []
    for line in sensors_out.splitlines():
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 5:
            continue
        name, _, status = parts[0], parts[2], parts[3]
        reading = parts[4] if len(parts) > 4 else None
        entry = {"name": name, "status": status, "reading": reading}
        lname = name.lower()
        if "fan" in lname:
            fans.append(entry)
        elif "temp" in lname:
            temps.append(entry)
        elif any(k in lname for k in ("volt", "vcc", "vbat", "12v", "5v", "3.3v")):
            voltages.append(entry)
        elif "psu" in lname or "power supply" in lname:
            psus.append(entry)

    sel_out = run(["sudo", "-n", "ipmitool", "sel", "elist"], timeout=LONG_TIMEOUT)
    sel_entries = [l.strip() for l in sel_out.splitlines() if l.strip()][:MAX_KERNEL_EVENTS_PER_CATEGORY]

    return {
        "supported": True,
        "fan_status": fans or None,
        "temperature_sensors": temps or None,
        "voltage_rails": voltages or None,
        "psu_status": psus or None,
        "sel_entries": sel_entries or None,
        "sel_entry_count": len(sel_out.splitlines()) if sel_out else 0,
    }


@safe_collect("hwmon_health", fallback=[])
def get_hwmon_health() -> list[dict[str, Any]]:
    if not HWMON_CLASS_PATH.exists():
        return []

    chips = []
    for hwmon_dir in sorted(HWMON_CLASS_PATH.iterdir()):
        chip_name = read_stripped(hwmon_dir / "name")
        if not chip_name:
            continue

        temps, voltages, fans = [], [], []
        for f in sorted(hwmon_dir.glob("temp*_input")):
            idx = re.match(r"temp(\d+)_input", f.name).group(1)
            label = read_stripped(hwmon_dir / f"temp{idx}_label") or f"temp{idx}"
            value = safe_int(read_stripped(f))
            if value is not None:
                temps.append({"label": label, "celsius": round(value / 1000, 1)})

        for f in sorted(hwmon_dir.glob("in*_input")):
            idx = re.match(r"in(\d+)_input", f.name).group(1)
            label = read_stripped(hwmon_dir / f"in{idx}_label") or f"in{idx}"
            value = safe_int(read_stripped(f))
            if value is not None:
                voltages.append({"label": label, "millivolts": value})

        # Fan tachometer readings (RPM). Additive vs. Trial1: on boards with
        # a bound Super-I/O chip (nct6775, it87, etc.) or a GPU/NVMe fan
        # exposing fan*_input, this surfaces real spindle speed; on systems
        # without one it's simply absent, same as the temp/voltage globs
        # above already handled.
        for f in sorted(hwmon_dir.glob("fan*_input")):
            idx = re.match(r"fan(\d+)_input", f.name).group(1)
            label = read_stripped(hwmon_dir / f"fan{idx}_label") or f"fan{idx}"
            value = safe_int(read_stripped(f))
            if value is not None:
                fans.append({"label": label, "rpm": value})

        if temps or voltages or fans:
            chips.append({
                "chip": chip_name,
                "temperatures": temps or None,
                "voltages": voltages or None,
                "fans": fans or None,
            })

    return chips


# ============================================================================
# 22b. TRIAL2 ADDITIONS -- DMI CHASSIS / VOLTAGE PROBES / COOLING DEVICES /
#      BATTERY / AC POWER SUPPLY
# ============================================================================
#
# All additive: none of this replaces or removes anything collected above.
# The DMI (SMBIOS) collectors below give a motherboard-reported view of
# rails and fans that doesn't depend on a Super-I/O hwmon driver being
# bound -- useful precisely on the boards where CPU Vcore VRM / EPS 12V /
# ATX12V / Standby 5VSB show up as "no_data" in the functional block ledger
# because no in-kernel sensor chip driver claimed the hardware.


@safe_collect("chassis_inventory", fallback={})
def get_chassis_inventory() -> dict[str, Any]:
    """DMI type 3 -- System Enclosure/Chassis. Reports chassis type, asset
    tag, and (when the board populates them) boot-up/power-supply/thermal/
    security state -- fields that are genuinely new vs. anything in Trial1,
    not a re-derivation of the BIOS/system blocks already collected."""
    if not command_exists("dmidecode"):
        return {}
    out = run(["sudo", "-n", "dmidecode", "-t", "chassis"], timeout=LONG_TIMEOUT)
    if not out:
        return {}
    kv = parse_key_value(out)
    return {
        "manufacturer": null_if_empty(kv.get("Manufacturer")),
        "chassis_type": null_if_empty(kv.get("Type")),
        "asset_tag": null_if_empty(kv.get("Asset Tag")),
        "serial_number": null_if_empty(kv.get("Serial Number")),
        "boot_up_state": null_if_empty(kv.get("Boot-up State")),
        "power_supply_state": null_if_empty(kv.get("Power Supply State")),
        "thermal_state": null_if_empty(kv.get("Thermal State")),
        "security_status": null_if_empty(kv.get("Security Status")),
        "height": null_if_empty(kv.get("Height")),
        "number_of_power_cords": null_if_empty(kv.get("Number Of Power Cords")),
    }


@safe_collect("voltage_probes", fallback=[])
def get_voltage_probes() -> list[dict[str, Any]]:
    """DMI type 26 -- Voltage Probe. SMBIOS-level rail descriptors (often
    labeled things like "VCORE", "+12V", "+5V", "+3.3V", "VBAT"). Many
    consumer boards report these as "Unknown"/"Unavailable" if the BIOS
    never wired the probe up, in which case this is correctly empty --
    but on boards that do populate it, this is real rail data that the
    hwmon-only path (no bound Super-I/O driver) can't otherwise surface."""
    if not command_exists("dmidecode"):
        return []
    out = run(["sudo", "-n", "dmidecode", "-t", "26"], timeout=LONG_TIMEOUT)
    if not out:
        return []
    probes = []
    for block in out.split("Voltage Probe"):
        if "Description" not in block and "Location" not in block:
            continue
        status = null_if_empty(get_value(r"Status:\s+(.*)", block))
        if status is None:
            continue
        probes.append({
            "description": null_if_empty(get_value(r"Description:\s+(.*)", block)),
            "location": null_if_empty(get_value(r"Location:\s+(.*)", block)),
            "status": status,
            "nominal_value": null_if_empty(get_value(r"Nominal Value:\s+(.*)", block)),
            "max_value": null_if_empty(get_value(r"Maximum Value:\s+(.*)", block)),
            "min_value": null_if_empty(get_value(r"Minimum Value:\s+(.*)", block)),
        })
    return probes


@safe_collect("cooling_devices", fallback=[])
def get_cooling_devices() -> list[dict[str, Any]]:
    """DMI type 27 -- Cooling Device. SMBIOS-level fan/cooling probes,
    including nominal RPM when the board reports it. Complements (not a
    duplicate of) the hwmon fan*_input readings in get_hwmon_health(),
    since boards frequently expose one but not the other."""
    if not command_exists("dmidecode"):
        return []
    out = run(["sudo", "-n", "dmidecode", "-t", "27"], timeout=LONG_TIMEOUT)
    if not out:
        return []
    devices = []
    for block in out.split("Cooling Device"):
        if "Type" not in block and "Status" not in block:
            continue
        status = null_if_empty(get_value(r"Status:\s+(.*)", block))
        if status is None:
            continue
        devices.append({
            "description": null_if_empty(get_value(r"Description:\s+(.*)", block)),
            "device_type": null_if_empty(get_value(r"^\s*Type:\s+(.*)$", block)),
            "status": status,
            "nominal_speed_rpm": null_if_empty(get_value(r"Nominal Speed:\s+(.*)", block)),
        })
    return devices


@safe_collect("battery_health", fallback={"present": False})
def get_battery_health() -> dict[str, Any]:
    """/sys/class/power_supply BAT* -- battery presence/charge/health.
    A correct no-op ({"present": False}) on desktops/workstations with no
    battery; genuinely new data on laptops."""
    if not POWER_SUPPLY_CLASS_PATH.exists():
        return {"present": False}
    batteries = []
    for name in sorted(os.listdir(POWER_SUPPLY_CLASS_PATH)):
        if not name.upper().startswith("BAT"):
            continue
        d = POWER_SUPPLY_CLASS_PATH / name
        batteries.append({
            "name": name,
            "status": read_stripped(d / "status"),
            "capacity_percent": safe_int(read_stripped(d / "capacity")),
            "health": read_stripped(d / "health") or read_stripped(d / "capacity_level"),
            "cycle_count": safe_int(read_stripped(d / "cycle_count")),
            "technology": read_stripped(d / "technology"),
            "voltage_now_mv": bytes_to_kb(read_stripped(d / "voltage_now")) if read_stripped(d / "voltage_now") else None,
            "manufacturer": read_stripped(d / "manufacturer"),
            "model_name": read_stripped(d / "model_name"),
        })
    if not batteries:
        return {"present": False}
    return {"present": True, "batteries": batteries}


@safe_collect("power_supply_status", fallback={})
def get_power_supply_status() -> dict[str, Any]:
    """/sys/class/power_supply Mains/ADP*/AC* -- AC adapter online state.
    Distinct from get_battery_health(): this is the wall-power side, not
    the cell. Empty dict (pruned away) on systems with neither node."""
    if not POWER_SUPPLY_CLASS_PATH.exists():
        return {}
    adapters = []
    for name in sorted(os.listdir(POWER_SUPPLY_CLASS_PATH)):
        d = POWER_SUPPLY_CLASS_PATH / name
        ptype = read_stripped(d / "type")
        if ptype not in ("Mains", "USB", "Wireless") and not name.upper().startswith(("AC", "ADP")):
            continue
        adapters.append({
            "name": name,
            "type": ptype,
            "online": read_stripped(d / "online"),
        })
    return {"adapters": adapters} if adapters else {}


# ============================================================================
# IOMMU
# ============================================================================


@safe_collect("iommu_summary", fallback={"enabled": False})
def get_iommu_summary() -> dict[str, Any]:
    if not IOMMU_GROUPS_PATH.exists():
        return {"enabled": False}
    groups = [g for g in os.listdir(IOMMU_GROUPS_PATH) if g.isdigit()]
    total_devices = 0
    for g in groups:
        dev_dir = IOMMU_GROUPS_PATH / g / "devices"
        if dev_dir.exists():
            total_devices += len(os.listdir(dev_dir))
    return {"enabled": True, "group_count": len(groups), "device_count": total_devices}


# ============================================================================
# 23. INTERNAL FUNCTIONAL BLOCK LEDGER
# ============================================================================
#
# Every named "Internal Functional Block" from the hardware component table
# (CPU, RAM, GPU, IO_Controller, MGMT, NIC, PSU, Disk) mapped to the real
# Linux/Ubuntu command(s) that inspect it. Purely physical wiring blocks
# (Molex, 12VHPWR, PCIe slot power pins, etc.) have no OS-visible interface
# and are marked NOT_QUERYABLE instead of faking a reading.
#
# This ledger is collected fresh every link-health cycle via the same
# cached/safe `run()` helper used everywhere else in this file, so it never
# raises and never adds an unbounded subprocess per request.

NOT_QUERYABLE = "NOT OS-QUERYABLE (physical connector/rail -- no software interface exists)"

BLOCK_REGISTRY: dict[str, dict[str, list[tuple[str, Any]]]] = {
    "CPU": {
        "DDR5 Memory Bus": [("dmidecode memory type/speed", ["sudo", "-n", "dmidecode", "-t", "memory"])],
        "Multi-Channel Memory Controller": [("memory channel layout", ["sudo", "-n", "dmidecode", "-t", "16"])],
        "PCIe Gen5 x16": [("PCIe link speed/width (CPU root port)", ["bash", "-c", "sudo -n lspci -vv 2>/dev/null | grep -B5 -A15 -i 'VGA\\|3D controller' | grep -i 'LnkCap\\|LnkSta'"])],
        "PCIe x8/x16": [("PCIe link speed/width (all devices)", ["bash", "-c", "sudo -n lspci -vv 2>/dev/null | grep -i 'LnkCap\\|LnkSta'"])],
        "PCIe/NVMe Interface": [("NVMe devices over PCIe", ["bash", "-c", "lspci | grep -i nvme"])],
        "DMI (Direct Media Interface)": [("PCI topology / chipset link", ["lspci", "-tv"])],
        "VRM Power Rail": [("voltage rails via sensors", ["sensors"])],
        "CPU Vcore VRM": [
            ("CPU core voltage", ["bash", "-c", "sensors | grep -i vcore"]),
            ("hwmon voltage inputs (Vcore fallback)", ["bash", "-c",
                "for f in /sys/class/hwmon/*/in*_input; do d=$(dirname $f); i=$(basename $f _input); "
                "l=$(cat $d/${i}_label 2>/dev/null || echo $i); echo \"$l: $(cat $f 2>/dev/null) mV\"; done"]),
            ("SMBIOS voltage probe (DMI type 26)", ["sudo", "-n", "dmidecode", "-t", "26"]),
            ("Intel MSR core voltage -- IA32_PERF_STATUS bits 47:32, 1/8192 V units (requires msr-tools + msr module)",
                ["bash", "-c", "sudo -n modprobe msr 2>/dev/null; sudo -n rdmsr -p 0 -f 47:32 -d 0x198 2>/dev/null"]),
        ],
        "EPS 12V": [
            ("12V rail via sensors/IPMI", ["bash", "-c", "sensors | grep -i 12v; sudo -n ipmitool sensor 2>/dev/null | grep -i 12v"]),
            ("SMBIOS voltage probe (DMI type 26)", ["sudo", "-n", "dmidecode", "-t", "26"]),
            ("System Power Supply record cross-reference (DMI type 39 -- links to the Input Voltage Probe Handle feeding this rail)",
                ["sudo", "-n", "dmidecode", "-t", "39"]),
        ],
        "SMBus": [("SMBus controller/adapters", ["bash", "-c", "lspci | grep -i smbus; i2cdetect -l"])],
        "LPC Bus": [("LPC/ISA bridge", ["bash", "-c", "lspci -nn | grep -i 'isa bridge\\|lpc'"])],
        "eSPI Bus": [
            ("eSPI (rarely OS-visible)", ["bash", "-c", "sudo -n dmesg 2>/dev/null | grep -i espi"]),
            ("eSPI in kernel ring buffer (journalctl fallback)", ["bash", "-c", "journalctl -k --no-pager 2>/dev/null | grep -i espi"]),
            ("LPC/ISA bridge fallback -- pre-eSPI/legacy platforms surface the same low-pin-count bus as an ISA bridge device",
                ["bash", "-c", "lspci -nn 2>/dev/null | grep -i 'isa bridge\\|lpc\\|espi'"]),
        ],
    },
    "Disk": {
        "PCIe/NVMe Interface": [("NVMe controllers", ["nvme", "list"])],
        "NVMe Command Queue": [
            ("NVMe queue count/depth", ["bash", "-c", "for d in /dev/nvme*n1; do [ -e $d ] && sudo -n nvme id-ctrl $d 2>/dev/null | grep -i 'sqes\\|cqes\\|maxcmd'; done"]),
            ("sysfs queue depth (nr_requests) fallback", ["bash", "-c", "for f in /sys/block/nvme*/queue/nr_requests; do echo \"$f: $(cat $f 2>/dev/null)\"; done"]),
            ("controller register queue capabilities -- CAP.MQES (max queue entries supported)",
                ["bash", "-c", "for d in /dev/nvme[0-9]*; do case \"$d\" in *n1) continue;; esac; [ -e \"$d\" ] && echo == $d == && sudo -n nvme show-regs $d 2>/dev/null; done"]),
        ],
        "GPU Direct Storage (GDS)": [("nvidia-fs kernel module", ["bash", "-c", "lsmod | grep -i nvidia_fs; cat /proc/driver/nvidia-fs/stats 2>/dev/null"])],
        "DMA Engine": [("legacy DMA channels", ["cat", "/proc/dma"])],
        "DMA Transfers": [("block device I/O stats", ["bash", "-c", "iostat -x 2>/dev/null || cat /proc/diskstats"])],
        "SATA Controller": [("SATA/AHCI controller", ["bash", "-c", "lspci -nnk | grep -i sata"])],
        "SAS Controller": [("SAS HBA controller", ["bash", "-c", "lspci -nnk | grep -i sas"])],
        "SATA Port": [("ATA port list", ["bash", "-c", "ls /sys/class/ata_port/ 2>/dev/null"])],
        "SAS Port": [("SAS device list", ["lsscsi"])],
        "SATA Power": [("drive power/standby state", ["bash", "-c", "for d in /dev/sd?; do echo $d:; sudo -n hdparm -C $d 2>/dev/null; done"])],
        "Molex Power": [("physical connector", NOT_QUERYABLE)],
        "SMART Interface": [("SMART-capable devices", ["smartctl", "--scan"])],
    },
    "GPU": {
        "PCIe Gen5 x16": [("GPU link speed/width", ["bash", "-c", "lspci -vv -d ::0300 2>/dev/null; lspci -vv -d ::0302 2>/dev/null"])],
        "PCIe Switch Fabric": [("PCIe topology tree", ["lspci", "-tv"])],
        "PCIe Power (6-pin/8-pin)": [("physical connector", NOT_QUERYABLE)],
        "12VHPWR Power": [
            ("draw only, not connector type", ["bash", "-c", "nvidia-smi -q -d POWER 2>/dev/null"]),
            ("direct instantaneous/average power draw query (bypasses the full -q dump)",
                ["nvidia-smi", "--query-gpu=power.draw,power.draw.average,power.draw.instant,power.limit", "--format=csv,noheader"]),
        ],
        "GPU Direct Storage (GDS)": [("nvidia-fs module", ["bash", "-c", "lsmod | grep -i nvidia_fs"])],
        "PCIe DMA": [
            ("DMA capability in PCIe config space", ["bash", "-c", "lspci -vv -d ::0300 2>/dev/null | grep -i dma"]),
            ("IOMMU/DMAR fault or remapping log entries referencing the GPU's PCI bus address",
                ["bash", "-c", "gpu_bdf=$(lspci -d ::0300 2>/dev/null | awk 'NR==1{print $1}'); [ -n \"$gpu_bdf\" ] && journalctl -k --no-pager 2>/dev/null | grep -i \"$gpu_bdf\\|dmar\\|iommu\""]),
        ],
        "BAR Registers (MMIO BAR)": [("PCI BAR memory regions", ["bash", "-c", "lspci -vv -d ::0300 2>/dev/null | grep -i 'region\\|memory at'"])],
        "RDMA": [("RDMA devices", ["bash", "-c", "which ibv_devices >/dev/null 2>&1 && ibv_devices; rdma link 2>/dev/null"])],
        "GPU Direct RDMA": [("nvidia_peermem module", ["bash", "-c", "lsmod | grep -i peermem"])],
        "I2C Bus": [("I2C adapters", ["i2cdetect", "-l"])],
        "Thermal Sensors": [("GPU temperature", ["bash", "-c", "nvidia-smi -q -d TEMPERATURE 2>/dev/null; sensors"])],
        "TPM Interface": [("TPM device node", ["bash", "-c", "ls -l /dev/tpm* 2>/dev/null"])],
    },
    "IO_Controller": {
        "PCIe Switch Fabric": [("PCIe topology tree", ["lspci", "-tv"])],
        "PCIe Lanes": [("link width/speed per device", ["bash", "-c", "sudo -n lspci -vv 2>/dev/null | grep -i 'lnkcap\\|lnksta'"])],
        "MMIO Mapping": [("system memory-mapped I/O map", ["cat", "/proc/iomem"])],
        "BAR Registers (MMIO BAR)": [("all device BARs", ["bash", "-c", "lspci -vv | grep -i 'memory at'"])],
        "DMI (Direct Media Interface)": [("chipset/root complex link", ["lspci", "-tv"])],
        "SATA Controller": [("SATA controller in chipset", ["bash", "-c", "lspci -nnk | grep -i sata"])],
        "SAS Controller": [
            ("SAS controller", ["bash", "-c", "lspci -nnk | grep -i sas"]),
            ("SAS HBA via PCI class code 0107 (cleaner detection than name grep -- catches HBAs whose string ID omits 'SAS')",
                ["bash", "-c", "lspci -d ::0107 2>/dev/null"]),
        ],
        "Chipset Power Rail": [
            ("chipset voltage via sensors (if exposed)", ["sensors"]),
            ("SMBIOS voltage probe (DMI type 26)", ["sudo", "-n", "dmidecode", "-t", "26"]),
        ],
        "eSPI Bus": [
            ("eSPI trace in kernel log", ["bash", "-c", "sudo -n dmesg 2>/dev/null | grep -i espi"]),
            ("eSPI in kernel ring buffer (journalctl fallback)", ["bash", "-c", "journalctl -k --no-pager 2>/dev/null | grep -i espi"]),
            ("LPC/ISA bridge fallback -- pre-eSPI/legacy platforms surface the same low-pin-count bus as an ISA bridge device",
                ["bash", "-c", "lspci -nn 2>/dev/null | grep -i 'isa bridge\\|lpc\\|espi'"]),
        ],
        "BIOS Region": [("BIOS/firmware info", ["sudo", "-n", "dmidecode", "-t", "bios"])],
        "Chassis State (DMI)": [("chassis boot-up/power/thermal state", ["sudo", "-n", "dmidecode", "-t", "3"])],
    },
    "MGMT": {
        "SMBus": [("SMBus/I2C adapters", ["i2cdetect", "-l"])],
        "SPI Flash": [("SPI bus devices", ["bash", "-c", "ls /sys/bus/spi/devices 2>/dev/null; dmesg | grep -i spi"])],
        "I2C Bus": [("I2C adapters", ["i2cdetect", "-l"])],
        "I2C Thermal Bus": [("sensors over I2C", ["sensors"])],
        "LPC Bus": [("LPC/ISA bridge", ["bash", "-c", "lspci -nn | grep -i 'isa bridge'"])],
        "PMBus": [
            ("PMBus devices via I2C / IPMI", ["bash", "-c", "i2cdetect -l; sudo -n ipmitool sensor 2>/dev/null"]),
            ("bound pmbus kernel driver check -- confirms whether any device is actually claimed by the pmbus hwmon driver",
                ["bash", "-c", "ls /sys/bus/i2c/drivers/pmbus/ 2>/dev/null"]),
        ],
        "Thermal Sensors": [("all thermal sensors", ["bash", "-c", "sensors; sudo -n ipmitool sensor 2>/dev/null | grep -i temp"])],
        "TPM Sensor": [("TPM presence/capabilities", ["bash", "-c", "ls -l /dev/tpm* 2>/dev/null; tpm2_getcap properties-fixed 2>/dev/null"])],
        "Dedicated IPMI Port": [
            ("BMC LAN configuration", ["sudo", "-n", "ipmitool", "lan", "print"]),
            ("IPMI device presence per SMBIOS (DMI type 38) regardless of driver binding -- confirms hardware absence vs. just no driver",
                ["sudo", "-n", "dmidecode", "-t", "38"]),
        ],
        "Firmware Flash": [("firmware/BIOS info + updatable devices", ["bash", "-c", "sudo -n dmidecode -t bios; fwupdmgr get-devices 2>/dev/null"])],
        "Chassis State (DMI)": [("chassis boot-up/power/thermal/security state", ["sudo", "-n", "dmidecode", "-t", "3"])],
        "Cooling Device (DMI)": [("SMBIOS fan/cooling probes incl. nominal RPM", ["sudo", "-n", "dmidecode", "-t", "27"])],
    },
    "NIC": {
        "PCIe x8/x16": [("NIC link speed/width", ["bash", "-c",
            "sudo -n lspci -vv 2>/dev/null | awk 'BEGIN{RS=\"\"} tolower($0) ~ /ethernet|network controller|wireless|802\\.11/ {print}' | grep -i 'lnkcap\\|lnksta'"])],
        "PCIe Lanes": [("same as above, all NICs", ["bash", "-c",
            "sudo -n lspci -vv 2>/dev/null | awk 'BEGIN{RS=\"\"} tolower($0) ~ /ethernet|network controller|wireless|802\\.11/ {print}' | grep -i lnk"])],
        "PCIe Slot": [
            ("physical slot ID for NIC (matched by PCI bus address, not name)", ["bash", "-c",
                "for id in $(lspci -D 2>/dev/null | grep -iE 'ethernet|network controller|wireless|802\\.11' | cut -d' ' -f1); do "
                "sudo -n dmidecode -t 9 2>/dev/null | awk -v RS='' -v addr=\"$id\" '$0 ~ addr {print; found=1} END{exit !found}' && echo '---'; "
                "done"]),
            ("physical slot reported directly by the device's own PCIe capability (lspci 'Physical Slot' field) -- works even for on-package/soldered NICs absent from the DMI slot table",
                ["bash", "-c",
                    "sudo -n lspci -vv 2>/dev/null | awk 'BEGIN{RS=\"\"} tolower($0) ~ /ethernet|network controller|wireless|802\\.11/ {print}' | grep -i 'physical slot'"]),
        ],
        "PCIe Slot Power": [("slot power budget (dmidecode)", ["sudo", "-n", "dmidecode", "-t", "slot"])],
        "DMA Ring Buffers": [("NIC ring buffer sizes (per interface)", ["bash", "-c", "for i in $(ls /sys/class/net | grep -v lo); do echo == $i ==; ethtool -g $i 2>/dev/null; done"])],
        "RDMA": [("RDMA-capable NICs", ["bash", "-c", "which ibv_devices >/dev/null 2>&1 && ibv_devices; rdma link 2>/dev/null"])],
        "GPU Direct RDMA": [("peermem module for GPUDirect", ["bash", "-c", "lsmod | grep -i peermem"])],
        "BMC Shared NIC": [
            ("check if a NIC is shared with BMC", ["sudo", "-n", "ipmitool", "lan", "print"]),
            ("IPMI/BMC presence per SMBIOS (DMI type 38) + LAN channel config -- confirms hardware absence vs. just no driver/no BMC configured",
                ["bash", "-c", "sudo -n dmidecode -t 38 2>/dev/null; sudo -n ipmitool lan print 2>/dev/null"]),
        ],
        "Dedicated IPMI Port": [
            ("dedicated mgmt interface", ["bash", "-c", "sudo -n ipmitool lan print; ip link show"]),
            ("IPMI device presence per SMBIOS (DMI type 38) regardless of driver binding -- confirms hardware absence vs. just no driver",
                ["sudo", "-n", "dmidecode", "-t", "38"]),
        ],
    },
    "PSU": {
        "PCIe Slot Power": [("max power per slot", ["sudo", "-n", "dmidecode", "-t", "slot"])],
        "12VHPWR Power": [
            ("draw only, not wiring", ["bash", "-c", "nvidia-smi -q -d POWER 2>/dev/null"]),
            ("direct instantaneous/average power draw query (bypasses the full -q dump)",
                ["nvidia-smi", "--query-gpu=power.draw,power.draw.average,power.draw.instant,power.limit", "--format=csv,noheader"]),
        ],
        "Molex Power": [("physical connector", NOT_QUERYABLE)],
        "EPS 12V": [
            ("12V rail via sensors/IPMI", ["bash", "-c", "sensors | grep -i 12v; sudo -n ipmitool sensor 2>/dev/null | grep -i 12v"]),
            ("SMBIOS voltage probe (DMI type 26)", ["sudo", "-n", "dmidecode", "-t", "26"]),
            ("System Power Supply record cross-reference (DMI type 39 -- links to the Input Voltage Probe Handle feeding this rail)",
                ["sudo", "-n", "dmidecode", "-t", "39"]),
        ],
        "ATX12V": [
            ("12V rail via sensors/IPMI", ["bash", "-c", "sensors | grep -i 12v"]),
            ("SMBIOS voltage probe (DMI type 26)", ["sudo", "-n", "dmidecode", "-t", "26"]),
            ("System Power Supply record cross-reference (DMI type 39 -- links to the Input Voltage Probe Handle feeding this rail)",
                ["sudo", "-n", "dmidecode", "-t", "39"]),
        ],
        "Motherboard 24-pin ATX": [("system power supply info", ["sudo", "-n", "dmidecode", "-t", "39"])],
        "Standby 5VSB": [
            ("5V standby rail", ["bash", "-c", "sensors | grep -i 5v"]),
            ("AC adapter / mains online state (laptop 5VSB proxy)", ["bash", "-c",
                "for f in /sys/class/power_supply/*/online; do [ -e $f ] || continue; echo $f: $(cat $f 2>/dev/null); done"]),
            ("ACPI sleep-state / wake-source support as an indirect standby-rail activity indicator (desktops without a dedicated 5VSB sensor)",
                ["bash", "-c", "cat /sys/power/mem_sleep 2>/dev/null; cat /proc/acpi/wakeup 2>/dev/null | head -20"]),
        ],
        "PMBus": [
            ("PMBus devices", ["bash", "-c", "i2cdetect -l; sudo -n ipmitool sensor 2>/dev/null"]),
            ("bound pmbus kernel driver check -- confirms whether any device is actually claimed by the pmbus hwmon driver",
                ["bash", "-c", "ls /sys/bus/i2c/drivers/pmbus/ 2>/dev/null"]),
        ],
        "PMBus Alerts": [
            ("power-related events in system event log", ["sudo", "-n", "ipmitool", "sel", "list"]),
            ("PMBus fault/alarm flags directly from a bound pmbus hwmon device, if one exists",
                ["bash", "-c",
                    "for d in /sys/bus/i2c/drivers/pmbus/*/hwmon/hwmon*/; do [ -d \"$d\" ] || continue; echo == $d ==; cat $d*_alarm 2>/dev/null; done"]),
        ],
        "Voltage Probes (DMI)": [("SMBIOS voltage rail probes", ["sudo", "-n", "dmidecode", "-t", "26"])],
        "Cooling Device (DMI)": [("SMBIOS fan/cooling probes incl. nominal RPM", ["sudo", "-n", "dmidecode", "-t", "27"])],
        "Battery": [("battery presence/charge/health (/sys/class/power_supply)", ["bash", "-c",
            "for d in /sys/class/power_supply/BAT*; do [ -d $d ] && echo == $(basename $d) == && cat $d/status $d/capacity $d/health 2>/dev/null; done"])],
    },
    "RAM": {
        "DDR5 Memory Bus": [("memory type/speed", ["sudo", "-n", "dmidecode", "-t", "memory"])],
        "NVMe BAR Region": [("NVMe device memory regions", ["bash", "-c", "lspci -vv | grep -B5 -i nvme | grep -i 'memory at'"])],
        "DMA Engine": [("legacy DMA channels", ["cat", "/proc/dma"])],
        "DMA Ring Buffers": [("NIC ring buffers (memory-backed)", ["bash", "-c", "for i in $(ls /sys/class/net | grep -v lo); do ethtool -g $i 2>/dev/null; done"])],
        "MMIO Mapping": [("system memory map", ["cat", "/proc/iomem"])],
        "BAR0/BAR1/BAR2 Mapping": [("device BAR mappings", ["bash", "-c", "lspci -vv | grep -i 'region '"])],
        "VRM Power Rail": [("voltage rails", ["sensors"])],
        "SPI / I2C": [("I2C adapters (SPD bus)", ["i2cdetect", "-l"])],
        "SPD EEPROM": [("module manufacturer/part/serial from SPD", ["bash", "-c", "sudo -n dmidecode -t memory | grep -i 'manufacturer\\|part number\\|serial'"])],
    },
}


_BLOCK_WARNING_KEYWORDS = re.compile(
    r"\b(error|errors|fault|faults|failed|failure|critical|uncorrectable|"
    r"over-current|overcurrent|degraded|reset failed|timeout)\b",
    re.IGNORECASE,
)
# Strips both confirmed-zero statements ("0 errors") AND dmidecode/lspci
# schema *labels* that happen to contain the word "Error" as part of their
# field name rather than as a reported fault (e.g. "Error Correction Type:
# None" or "Error Information Handle: Not Provided" from `dmidecode -t
# memory`/`-t bios`). Without this, DDR5/BIOS blocks get spuriously flagged
# "warning" on every run just because the DMI spec names a field that way.
_BLOCK_BENIGN_ZERO_RE = re.compile(
    r"\b(0|none|no)\s+(errors?|faults?|failures?)\b"
    r"|Error Correction Type:\s*\S+"
    r"|Error Information Handle:\s*\S[\S ]*",
    re.IGNORECASE,
)


def _classify_block_output(output: str) -> Optional[str]:
    """Conservative heuristic classification for raw diagnostic ledger text.
    Returns 'warning' if a warning-ish keyword is present outside a
    confirmed-zero statement, else None. Deliberately never returns
    'critical' on its own -- these commands emit free-form text, not
    structured counters, so severity is left to the quantitative health
    engine above; this is a "worth a look" flag, not a fault verdict."""
    if not output:
        return None
    stripped = _BLOCK_BENIGN_ZERO_RE.sub("", output)
    return "warning" if _BLOCK_WARNING_KEYWORDS.search(stripped) else None


def _block_cmd_timeout(cmd) -> int:
    joined = " ".join(cmd) if isinstance(cmd, list) else str(cmd)
    if "-vv" in joined or "smartctl" in joined or "id-ctrl" in joined or "iostat" in joined:
        return LONG_TIMEOUT
    return DEFAULT_TIMEOUT


@safe_collect("functional_block_entry", fallback=None)
def _run_functional_block_command(label: str, cmd: Any) -> dict[str, Any]:
    if cmd == NOT_QUERYABLE:
        return {"label": label, "status": "not_queryable", "output": None, "note": NOT_QUERYABLE}

    binary = cmd[0]
    if binary != "bash" and not command_exists(binary):
        return {
            "label": label,
            "status": "unavailable",
            "output": None,
            "note": f"'{binary}' not installed. Install with:\n    {INSTALL_HINT}",
        }

    output = run(cmd, timeout=_block_cmd_timeout(cmd), use_cache=True).strip()
    if not output:
        return {"label": label, "status": "no_data", "output": None, "note": None}

    return {
        "label": label,
        "status": _classify_block_output(output) or "ok",
        "output": output[:1500],
        "note": None,
    }


@safe_collect("functional_blocks", fallback={})
def collect_functional_blocks() -> dict[str, Any]:
    """
    Internal Functional Block Ledger.

    Walks BLOCK_REGISTRY (CPU / RAM / GPU / IO_Controller / MGMT / NIC / PSU
    / Disk) and, for every named internal functional block, runs every
    mapped diagnostic command through the shared `run()` cache/timeout/
    safe-exec helper -- so results from commands shared with the
    quantitative collectors above (lspci -vv, dmidecode -t memory, sensors,
    etc.) are reused rather than re-executed within the same cycle.

    Additive to, not a replacement for, the counter-based health engine:
    this ledger gives raw human-readable per-block diagnostic text for
    deeper inspection, with a conservative 'ok' / 'warning' heuristic
    layered on top; it never overrides overall_health or score.
    """
    ledger: dict[str, Any] = {}
    for category, blocks in BLOCK_REGISTRY.items():
        category_result: dict[str, Any] = {}
        for block_name, cmd_list in blocks.items():
            entries = []
            for label, cmd in cmd_list:
                entry = _run_functional_block_command(label, cmd)
                if entry:
                    entries.append(entry)
            if not entries:
                continue

            statuses = {e["status"] for e in entries}
            if "warning" in statuses:
                block_status = "warning"
            elif "ok" in statuses:
                block_status = "ok"
            elif statuses == {"not_queryable"}:
                block_status = "not_queryable"
            else:
                block_status = "unavailable"

            category_result[block_name] = {"status": block_status, "commands": entries}

        if category_result:
            ledger[category] = category_result
    return ledger


# ============================================================================
# 24. HEALTH ENGINE
# ============================================================================


def _flatten_messages(kernel_events: dict[str, Any]) -> list[str]:
    return [e.get("message", "") for cat in kernel_events.values() for e in cat]


@safe_collect("health_summary", fallback={})
def compute_health_summary(report: dict[str, Any]) -> dict[str, Any]:
    critical_alerts: list[str] = []
    warnings: list[str] = []
    informational: list[str] = []
    diagnostic_notes: list[str] = []
    components_checked = 0
    components_with_warnings = 0
    components_with_errors = 0

    def flag(component: str, condition: bool, severity: str, message: str):
        nonlocal components_with_warnings, components_with_errors
        if not condition:
            return
        if severity == "critical":
            critical_alerts.append(f"[{component}] {message}")
        else:
            warnings.append(f"[{component}] {message}")

    # --- PCIe ---
    for dev in report.get("pcie", []) or []:
        components_checked += 1
        health = dev.get("health") or {}
        status = health.get("status")
        slot = dev.get("slot")
        aer_flags = health.get("aer_flags") or {}
        width_degraded = dev.get("link_width_below_max")

        if status == "Critical":
            components_with_errors += 1
            flag("pcie", True, "critical", f"{slot} fatal PCIe error")
        elif status == "Warning":
            components_with_warnings += 1
            if aer_flags.get("replay_timeout"):
                flag("pcie", True, "warning", f"{slot} Replay Timeout detected")
            elif aer_flags.get("receiver_overflow"):
                flag("pcie", True, "warning", f"{slot} Receiver Overflow detected")
            elif aer_flags.get("malformed_tlp"):
                flag("pcie", True, "warning", f"{slot} Malformed TLP detected")
            elif aer_flags.get("poisoned_tlp"):
                flag("pcie", True, "warning", f"{slot} Poisoned TLP detected")
            elif aer_flags.get("unsupported_request"):
                flag("pcie", True, "warning", f"{slot} Unsupported Request detected")
            elif aer_flags.get("bad_dllp"):
                flag("pcie", True, "warning", f"{slot} Bad DLLP detected")
            elif aer_flags.get("bad_tlp"):
                flag("pcie", True, "warning", f"{slot} Bad TLP detected")
            elif width_degraded:
                flag("pcie", True, "warning", f"{slot} PCIe Link Width reduced")
            else:
                flag("pcie", True, "warning", f"{slot} PCIe correctable/replay errors present")
        elif status == "Power Saving":
            informational.append(f"[pcie] {slot} operating in ASPM power saving state")

    # --- NVMe ---
    for dev in report.get("nvme", []) or []:
        components_checked += 1
        device_name = dev.get("device")

        cw = dev.get("critical_warning")
        if cw not in (None, 0, "0", "0x00"):
            components_with_errors += 1
            flag("nvme", True, "critical", f"{device_name} SSD Critical Warning flag set")

        if (dev.get("media_errors") or 0) not in (None, 0):
            components_with_errors += 1
            flag("nvme", True, "critical", f"{device_name} NVMe Media Errors detected")

        wear = safe_float(dev.get("percentage_used"))
        if wear is not None and wear > 80:
            components_with_warnings += 1
            flag("nvme", True, "warning", f"{device_name} SSD Wear exceeded threshold ({wear}% used)")

        if (dev.get("unsafe_shutdowns") or 0) not in (None, 0):
            informational.append(f"[nvme] {device_name} unsafe shutdowns recorded")

    # --- Memory / EDAC ---
    mem = report.get("memory", {}).get("health") or {}
    if mem.get("supported"):
        components_checked += 1
        if (mem.get("uncorrectable_errors") or 0) > 0:
            components_with_errors += 1
            flag("memory", True, "critical", "Uncorrectable ECC detected")
        if (mem.get("correctable_errors") or 0) > 0:
            components_with_warnings += 1
            flag("memory", True, "warning", "Correctable ECC detected")

    # --- GPU ---
    for gpu in report.get("gpu", []) or []:
        components_checked += 1
        h = gpu.get("health") or {}
        idx = gpu.get("index")

        if (h.get("xid_errors") or 0) > 0:
            components_with_errors += 1
            flag("gpu", True, "critical", f"GPU {idx} XID errors detected")
        if (h.get("ecc_uncorrected") or 0) > 0:
            components_with_errors += 1
            flag("gpu", True, "critical", f"GPU {idx} uncorrectable ECC errors detected")
        if (h.get("replay_errors") or 0) > 0:
            components_with_warnings += 1
            flag("gpu", True, "warning", f"GPU {idx} PCIe replay errors detected")
        if h.get("link_status") == "Power Saving":
            informational.append(f"[gpu] GPU {idx} operating in ASPM power saving state")

    # --- CPU ---
    cpu_health = report.get("cpu", {}).get("health") or {}
    components_checked += 1
    if (cpu_health.get("fatal_errors") or 0) > 0:
        components_with_errors += 1
        flag("cpu", True, "critical", "CPU Machine Check Exception detected")
    if (cpu_health.get("corrected_errors") or 0) > 0:
        components_with_warnings += 1
        flag("cpu", True, "warning", "CPU corrected hardware errors detected")

    # --- NIC ---
    for nic in report.get("nic", []) or []:
        components_checked += 1
        h = nic.get("health") or {}
        crc_like = sum(v for k, v in h.items() if "crc" in k.lower() and isinstance(v, int))
        if crc_like > 0:
            components_with_warnings += 1
            flag("nic", True, "warning", f"{nic.get('interface')} CRC/frame errors detected")

    for nic_metric in _LATEST_NIC_METRICS:
        if str(nic_metric.get("link_state") or "").lower() != "up":
            continue
        util = nic_metric.get("utilization_percent")
        if util is None:
            continue
        iface_name = nic_metric.get("name") or "unknown"
        if util >= NIC_UTILIZATION_CRITICAL_PERCENT:
            components_checked += 1
            components_with_errors += 1
            flag(
                "nic", True, "critical",
                f"{iface_name} link utilization {util}% exceeds {NIC_UTILIZATION_CRITICAL_PERCENT:g}% critical threshold",
            )
        elif util >= NIC_UTILIZATION_WARNING_PERCENT:
            components_checked += 1
            components_with_warnings += 1
            flag(
                "nic", True, "warning",
                f"{iface_name} link utilization {util}% exceeds {NIC_UTILIZATION_WARNING_PERCENT:g}% warning threshold",
            )

    # --- USB ---
    usb_health = report.get("usb", {}).get("health") or {}
    if usb_health:
        components_checked += 1
        if (usb_health.get("over_current_events") or 0) > 0:
            components_with_warnings += 1
            flag("usb", True, "warning", "USB over-current events detected")

    # --- Trial2: Chassis / Battery / AC power-supply (light, additive) ---
    # Conservative on purpose: chassis/battery state is surfaced as
    # warnings/informational only, never critical, matching the same
    # "worth a look" philosophy as the functional block ledger below --
    # it never influences overall_health or score computed further down
    # from the pre-existing PCIe/NVMe/memory/GPU/CPU/NIC/USB counters.
    chassis = report.get("chassis") or {}
    if chassis:
        components_checked += 1
        thermal_state = (chassis.get("thermal_state") or "").lower()
        if thermal_state and thermal_state not in ("safe", "unknown", ""):
            components_with_warnings += 1
            flag("chassis", True, "warning", f"Chassis thermal state reported as '{chassis.get('thermal_state')}'")
        power_state = (chassis.get("power_supply_state") or "").lower()
        if power_state and power_state not in ("safe", "unknown", ""):
            components_with_warnings += 1
            flag("chassis", True, "warning", f"Chassis power supply state reported as '{chassis.get('power_supply_state')}'")

    battery = report.get("battery") or {}
    if battery.get("present"):
        components_checked += 1
        for bat in battery.get("batteries", []) or []:
            health = (bat.get("health") or "").lower()
            if health and health not in ("good", "normal", "unknown", ""):
                components_with_warnings += 1
                flag("battery", True, "warning", f"{bat.get('name')} health reported as '{bat.get('health')}'")
            capacity = bat.get("capacity_percent")
            if isinstance(capacity, (int, float)) and capacity <= 5 and (bat.get("status") or "").lower() != "charging":
                components_with_warnings += 1
                flag("battery", True, "warning", f"{bat.get('name')} critically low ({capacity}%) and not charging")

    # --- Functional Block Ledger (informational only; heuristic-based) ---
    # These are surfaced separately from warnings/critical_alerts and never
    # affect the score, since the underlying commands return free-form text
    # rather than structured counters -- see collect_functional_blocks().
    for category, blocks in (report.get("functional_blocks") or {}).items():
        for block_name, block in blocks.items():
            if block.get("status") == "warning":
                diagnostic_notes.append(
                    f"[{category}/{block_name}] diagnostic output matched a warning keyword -- review raw output"
                )

    overall = "Healthy"
    if critical_alerts:
        overall = "Critical"
    elif warnings:
        overall = "Warning"

    score = max(0, 100 - 10 * len(critical_alerts) - 3 * len(warnings))

    return {
        "overall_health": overall,
        "score": score,
        "warnings": warnings,
        "critical_alerts": critical_alerts,
        "informational": informational,
        "diagnostic_notes": diagnostic_notes,
        "components_checked": components_checked,
        "components_with_warnings": components_with_warnings,
        "components_with_errors": components_with_errors,
    }


# --------------------------------------------------------------------------
# Top-level link-health collector
# --------------------------------------------------------------------------

def collect_link_health() -> dict[str, Any]:
    kernel_log = _get_kernel_log()

    pcie = get_pcie_link_health()
    kernel_events = get_kernel_events(kernel_log)

    report: dict[str, Any] = {
        "cpu": {
            "inventory": get_cpu_inventory_extra(),
            "health": get_cpu_health(kernel_log),
        },
        "memory": {
            "inventory": get_memory_inventory_extra(),
            "health": get_memory_health(),
        },
        "gpu": get_gpu_health(kernel_log),
        "pcie": pcie,
        "nvme": get_nvme_health(),
        "sata": get_sata_health(),
        "usb": {
            "devices": get_usb_link_health(),
            "health": get_usb_health(kernel_log),
        },
        "nic": get_nic_health(),
        "iommu": get_iommu_summary(),
        "motherboard": get_motherboard_health(kernel_events, pcie),
        "bios": get_bios_health(),
        "ipmi": get_ipmi_health(),
        "hwmon": get_hwmon_health(),
        "kernel_events": kernel_events,
        "functional_blocks": collect_functional_blocks(),
        # --- Trial2 additions (additive; nothing above was removed) ---
        "chassis": get_chassis_inventory(),
        "voltage_probes": get_voltage_probes(),
        "cooling_devices": get_cooling_devices(),
        "battery": get_battery_health(),
        "power_supply": get_power_supply_status(),
    }

    # DEMO: overwrite RAM/DISK/NIC/IO_Controller fields per whatever severity
    # is currently set via /demo/<component>/<severity>. Must run before
    # compute_health_summary() so overall_health/score/warnings reflect the
    # injected values, not just the raw hardware. No-op while "healthy".
    inject_link_health(report)

    report["health_summary"] = compute_health_summary(report)
    return report


# ============================================================================
# Recovery Action Registry
# ============================================================================
# Everything below (through Recovery History) is ADDITIVE: it reuses the
# telemetry helpers already defined above (command_exists, is_root,
# safe_int, collect_metrics) instead of duplicating them, and it never
# touches any of the collection/health code above this line.
#
# The frontend can only ever send an action KEY (e.g. "cpu.pause_process")
# and a params dict. It never sends a command. Every action key maps here
# to one internal Python handler -- there is no code path that runs a
# string the frontend supplied.

def _recovery_run(cmd: list[str], timeout: int = 15) -> dict[str, Any]:
    """Execute a fixed argv list for a MUTATING recovery action.

    Deliberately separate from the telemetry run() helper above: that
    helper caches per-cycle and discards stderr/returncode, which is
    correct for read-only telemetry polling but wrong here -- a recovery
    action must always actually execute (never served from cache) and
    callers need stderr + returncode to report success/failure honestly.
    """
    started = time.monotonic()
    if not command_exists(cmd[0]):
        return {
            "success": False, "command": " ".join(cmd), "stdout": "",
            "stderr": f"command not found: {cmd[0]}", "returncode": None,
            "duration_seconds": 0.0,
        }
    try:
        result = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=timeout, check=False,
        )
        return {
            "success": result.returncode == 0,
            "command": " ".join(cmd),
            "stdout": (result.stdout or "").strip(),
            "stderr": (result.stderr or "").strip(),
            "returncode": result.returncode,
            "duration_seconds": round(time.monotonic() - started, 3),
        }
    except subprocess.TimeoutExpired:
        return {
            "success": False, "command": " ".join(cmd), "stdout": "",
            "stderr": f"timed out after {timeout}s", "returncode": None,
            "duration_seconds": round(time.monotonic() - started, 3),
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "success": False, "command": " ".join(cmd), "stdout": "",
            "stderr": str(exc), "returncode": None,
            "duration_seconds": round(time.monotonic() - started, 3),
        }


_RECOVERY_SIGNAL_NAMES = {
    signal.SIGSTOP: "STOP",
    signal.SIGCONT: "CONT",
    signal.SIGTERM: "TERM",
    signal.SIGKILL: "KILL",
}


def _recovery_process_state(pid: int) -> Optional[str]:
    """Read the single-character process state (R/S/D/T/Z/...) straight
    from /proc/<pid>/stat. Returns None if the process no longer exists.
    Used to VERIFY a signal actually took effect, rather than trusting a
    zero exit code alone.
    """
    try:
        raw = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="ignore")
        # Format: "<pid> (<comm>) <state> ..." -- comm can itself contain
        # spaces or parentheses, so split on the LAST ')' rather than on
        # whitespace, then take the token right after it.
        after_comm = raw.rsplit(")", 1)[-1].split()
        return after_comm[0] if after_comm else None
    except (FileNotFoundError, ProcessLookupError):
        return None
    except Exception:
        return None


def _recovery_signal(pid: int, sig: int, *, verify_stopped: Optional[bool] = None, verify_gone: bool = False) -> dict[str, Any]:
    """Send a real Linux signal via the `kill` command -- e.g. `kill -STOP
    <pid>`, `kill -TERM <pid>` -- exactly what an engineer would run by
    hand, executed as a fixed argv (no shell string, no injection
    surface). Then VERIFY the effect from /proc so the response reflects
    what the kernel actually did, not just that the syscall returned 0:

      * verify_stopped=True   -> after SIGSTOP, confirm state == 'T'
      * verify_stopped=False  -> after SIGCONT, confirm state != 'T'
      * verify_gone=True      -> after SIGTERM/SIGKILL, confirm the pid
                                  no longer exists (its CPU/memory/GPU/NIC
                                  handles have actually been released)
    """
    sig_name = _RECOVERY_SIGNAL_NAMES.get(sig, str(int(sig)))
    res = _recovery_run(["kill", f"-{sig_name}", str(pid)])

    if not res["success"]:
        res["verified"] = False
        res["verification"] = res.get("stderr") or "signal delivery failed"
        return res

    # Let the kernel apply the scheduling-state change before we inspect
    # it -- SIGSTOP/SIGCONT/SIGTERM take effect on the next scheduling
    # tick, not synchronously with kill() returning.
    time.sleep(0.2)

    if verify_gone:
        # SIGTERM gives the process a chance to exit gracefully; if it's
        # still around after our settle window, retry once more with a
        # slightly longer wait before declaring it unverified (SIGKILL
        # should be near-instant; SIGTERM can take a moment). A 'Z'
        # (zombie) state counts as terminated: the kernel has already
        # reclaimed its CPU/memory/GPU/NIC resources, it's just an
        # exit-code placeholder sitting in the process table until its
        # parent calls wait() -- that's a bookkeeping detail, not the
        # process still consuming anything.
        def _is_gone(pid_to_check: int) -> bool:
            state = _recovery_process_state(pid_to_check)
            return state is None or state == "Z"

        gone = _is_gone(pid)
        if not gone:
            time.sleep(0.5)
            gone = _is_gone(pid)
        res["verified"] = gone
        res["verification"] = (
            f"pid {pid} confirmed terminated -- its CPU/memory/GPU/NIC footprint has been released"
            if gone
            else f"pid {pid} still present and running after signal (may be trapping/ignoring it)"
        )
    elif verify_stopped is not None:
        state = _recovery_process_state(pid)
        is_stopped = state == "T"
        ok = is_stopped if verify_stopped else (not is_stopped and state is not None)
        res["verified"] = ok
        res["verification"] = (
            f"pid {pid} confirmed state={state}"
            if ok
            else f"pid {pid} state={state!r} did not match the expected effect"
        )
    else:
        res["verified"] = True
        res["verification"] = "signal delivered"

    return res


def _has_nvidia_gpu() -> bool:
    return command_exists("nvidia-smi")


def _recovery_root_check(binary: Optional[str] = None):
    def check():
        if binary and not command_exists(binary):
            return False, f"'{binary}' not installed"
        if not is_root():
            return False, "requires root privileges"
        return True, ""
    return check


def _recovery_binary_check(binary: str):
    def check():
        if not command_exists(binary):
            return False, f"'{binary}' not installed"
        return True, ""
    return check


def _recovery_gpu_check():
    if not _has_nvidia_gpu():
        return False, "no NVIDIA GPU / nvidia-smi detected"
    return True, ""


def _recovery_always_supported():
    return True, ""


# ---- Force-kill primitive --------------------------------------------------
# Shared by cpu.kill_process, ram.terminate_process, gpu.terminate_process,
# and nic.kill_process below. All four send an unconditional `kill ` (i.e.
# SIGKILL) rather than the scheduling-signal path used elsewhere
# (_recovery_signal), and verify the pid is actually gone from /proc
# afterward instead of trusting a zero exit code alone. This intentionally
# skips the graceful-SIGTERM-first approach: these actions exist
# specifically for "this is stuck / unresponsive and needs to die now"
# situations, so they go straight to SIGKILL.

def _recovery_force_kill(pid: int, action_label: str) -> dict[str, Any]:
    """Send SIGTERM (`kill <pid>`), verify /proc, report honest success."""
    cmd = ["kill", str(pid)]
    cmd_str = f"kill {pid}"
    logger.info("recovery %s: sending %s", action_label, cmd_str)

    state_before = _recovery_process_state(pid)
    if state_before is None:
        msg = f"pid {pid} does not exist -- no process to kill"
        logger.warning("recovery %s: %s", action_label, msg)
        return {
            "success": False,
            "message": msg,
            "command": cmd_str,
            "stdout": "",
            "stderr": "no such process",
            "returncode": 1,
            "verified": False,
            "verification": "process already gone before kill",
            "process_state_before": None,
            "process_state_after": None,
        }

    res = _recovery_run(cmd)
    time.sleep(0.2)
    state_after = _recovery_process_state(pid)
    still_alive = state_after is not None and state_after != "Z"
    gone = not still_alive
    logger.info(
        "recovery %s: pid=%s returncode=%s still_alive=%s verified=%s",
        action_label, pid, res.get("returncode"), still_alive, gone,
    )

    res["process_state_before"] = state_before
    res["process_state_after"] = state_after
    res["verified"] = gone
    if still_alive:
        res["success"] = False
        res["message"] = f"Process {pid} is still running after kill."
        res["verification"] = f"pid {pid} still present (state={state_after!r})"
    elif res.get("returncode") == 0:
        res["success"] = True
        res["message"] = f"Process {pid} terminated."
        res["verification"] = f"pid {pid} confirmed terminated -- no longer in /proc"
    else:
        res["success"] = gone
        res["message"] = (
            res.get("stderr")
            or f"kill failed for pid {pid} (exit {res.get('returncode')})"
            if not gone
            else f"Process {pid} terminated."
        )
        res["verification"] = (
            f"pid {pid} confirmed terminated -- no longer in /proc"
            if gone
            else f"pid {pid} still present (state={state_after!r})"
        )
    return res


# ---- CPU handlers ----------------------------------------------------------

def _cpu_renice(p):
    res = _recovery_run(["renice", "-n", str(p["nice_value"]), "-p", str(p["pid"])])
    res["message"] = f"Process {p['pid']} renice'd to {p['nice_value']}." if res["success"] else "Renice failed."
    return res

def _cpu_pause_process(p):
    res = _recovery_signal(p["pid"], signal.SIGSTOP, verify_stopped=True)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"Process {p['pid']} paused (SIGSTOP) -- {res['verification']}, freeing its CPU share immediately."
        if res["success"] else (res.get("verification") or res.get("stderr") or "pause failed")
    )
    return res

def _cpu_resume_process(p):
    res = _recovery_signal(p["pid"], signal.SIGCONT, verify_stopped=False)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"Process {p['pid']} resumed (SIGCONT) -- {res['verification']}."
        if res["success"] else (res.get("verification") or res.get("stderr") or "resume failed")
    )
    return res

def _cpu_terminate_process(p):
    res = _recovery_signal(p["pid"], signal.SIGTERM, verify_gone=True)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"Process {p['pid']} terminated (SIGTERM) -- {res['verification']}."
        if res["success"] else (res.get("verification") or res.get("stderr") or "terminate failed")
    )
    return res

def _cpu_kill_process(p):
    logger.info("cpu.kill_process: backend received pid=%s", p.get("pid"))
    return _recovery_force_kill(p["pid"], "cpu.kill_process")

def _restart_service(p):
    res = _recovery_run(["systemctl", "restart", p["unit"]], timeout=60)
    res["message"] = f"Service {p['unit']} restarted." if res["success"] else f"Failed to restart {p['unit']}."
    return res


# ---- GPU handlers ----------------------------------------------------------

def _gpu_restart_persistence_daemon(p):
    res = _recovery_run(["systemctl", "restart", "nvidia-persistenced"], timeout=60)
    res["message"] = "nvidia-persistenced restarted." if res["success"] else "Failed to restart nvidia-persistenced."
    return res

def _gpu_reset(p):
    gpu_id = str(p.get("gpu_id", "0"))
    res = _recovery_run(["nvidia-smi", "--gpu-reset", "-i", gpu_id], timeout=60)
    res["message"] = f"GPU {gpu_id} reset." if res["success"] else f"GPU {gpu_id} reset failed (often requires no active clients)."
    return res

def _gpu_pause_process(p):
    res = _recovery_signal(p["pid"], signal.SIGSTOP, verify_stopped=True)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"GPU-using process {p['pid']} paused (SIGSTOP) -- {res['verification']}, halting further GPU submissions from it."
        if res["success"] else (res.get("verification") or res.get("stderr") or "pause failed")
    )
    return res

def _gpu_resume_process(p):
    res = _recovery_signal(p["pid"], signal.SIGCONT, verify_stopped=False)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"GPU-using process {p['pid']} resumed (SIGCONT) -- {res['verification']}."
        if res["success"] else (res.get("verification") or res.get("stderr") or "resume failed")
    )
    return res

def _gpu_terminate_process(p):
    logger.info("gpu.terminate_process: backend received pid=%s", p.get("pid"))
    res = _recovery_signal(p["pid"], signal.SIGTERM, verify_gone=True)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"GPU-using process {p['pid']} terminated (SIGTERM) -- {res['verification']}."
        if res["success"] else (res.get("verification") or res.get("stderr") or "terminate failed")
    )
    return res


# ---- RAM handlers -----------------------------------------------------------

def _ram_drop_caches(p):
    sync_res = _recovery_run(["sync"])
    try:
        with open("/proc/sys/vm/drop_caches", "w", encoding="utf-8") as f:
            f.write("3\n")
        return {"success": True, "message": "Page cache, dentries, and inodes dropped.",
                "command": "sync; echo 3 > /proc/sys/vm/drop_caches",
                "stdout": sync_res.get("stdout", ""), "stderr": "", "returncode": 0}
    except PermissionError:
        return {"success": False, "message": "insufficient privileges to drop caches (requires root)",
                "command": "echo 3 > /proc/sys/vm/drop_caches", "stdout": "", "stderr": "permission denied", "returncode": None}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "message": str(exc), "command": "echo 3 > /proc/sys/vm/drop_caches",
                "stdout": "", "stderr": str(exc), "returncode": None}

def _ram_pause_process(p):
    res = _recovery_signal(p["pid"], signal.SIGSTOP, verify_stopped=True)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"Process {p['pid']} paused (SIGSTOP) -- {res['verification']}, its memory working set stops growing while stopped."
        if res["success"] else (res.get("verification") or res.get("stderr") or "pause failed")
    )
    return res

def _ram_terminate_process(p):
    logger.info("ram.terminate_process: backend received pid=%s", p.get("pid"))
    return _recovery_force_kill(p["pid"], "ram.terminate_process")


# ---- Disk handlers ----------------------------------------------------------

_RECOVERY_SAFE_TEMP_ROOTS = (Path("/tmp"), Path("/var/tmp"))

def _disk_clean_temp_files(p):
    try:
        min_age_hours = float(p.get("min_age_hours", 24))
    except (TypeError, ValueError):
        min_age_hours = 24.0
    cutoff = time.time() - (min_age_hours * 3600)
    removed, errors = [], []
    for root in _RECOVERY_SAFE_TEMP_ROOTS:
        if not root.exists():
            continue
        try:
            for entry in root.iterdir():
                try:
                    if entry.is_file() and not entry.is_symlink() and entry.stat().st_mtime < cutoff:
                        entry.unlink()
                        removed.append(str(entry))
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"{entry}: {exc}")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{root}: {exc}")
    return {"success": True, "message": f"Removed {len(removed)} temp file(s) older than {min_age_hours}h.",
            "command": f"find /tmp /var/tmp -maxdepth 1 -type f -mmin +{int(min_age_hours * 60)} -delete",
            "stdout": "\n".join(removed[:200]), "stderr": "\n".join(errors[:50]), "returncode": 0}

def _disk_vacuum_journal(p):
    size = p.get("max_size", "200M")
    if not isinstance(size, str) or not size or not size[:-1].isdigit() or size[-1] not in "KMG":
        size = "200M"
    res = _recovery_run(["journalctl", f"--vacuum-size={size}"], timeout=60)
    res["message"] = f"Journal vacuumed to {size}." if res["success"] else "Journal vacuum failed."
    return res

def _disk_identify_large_directories(p):
    path = p.get("path", "/var/log")
    if not isinstance(path, str) or ".." in path or not path.startswith("/"):
        path = "/var/log"
    res = _recovery_run(["du", "-h", "--max-depth=1", path], timeout=60)
    res["message"] = f"Directory sizes under {path}." if res["success"] else f"Could not scan {path}."
    return res


def _disk_pause_process(p):
    res = _recovery_signal(p["pid"], signal.SIGSTOP, verify_stopped=True)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"Process {p['pid']} paused (SIGSTOP) -- {res['verification']}, reducing further disk I/O from this workload."
        if res["success"] else (res.get("verification") or res.get("stderr") or "pause failed")
    )
    return res


def _disk_resume_process(p):
    res = _recovery_signal(p["pid"], signal.SIGCONT, verify_stopped=False)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"Process {p['pid']} resumed (SIGCONT) -- {res['verification']}."
        if res["success"] else (res.get("verification") or res.get("stderr") or "resume failed")
    )
    return res


def _disk_terminate_process(p):
    logger.info("disk.terminate_process: backend received pid=%s", p.get("pid"))
    res = _recovery_signal(p["pid"], signal.SIGTERM, verify_gone=True)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"Process {p['pid']} terminated (SIGTERM) -- {res['verification']}."
        if res["success"] else (res.get("verification") or res.get("stderr") or "terminate failed")
    )
    return res


# ---- NIC handlers ------------------------------------------------------------
# Two tiers, mirroring cpu/gpu/ram/disk:
#   * process-level: pause/resume/terminate/kill whatever PID is actually
#     saturating the NIC right now (identified via get_top_nic_processes(),
#     which ranks ANY process by observed bandwidth -- an iperf3 test is
#     just one example of what could show up here, not a special case).
#   * subsystem-level (pre-existing): restart_interface / renew_dhcp /
#     restart_network_manager / reload_driver act on the interface itself,
#     for faults that aren't a single process's fault (bad driver state,
#     stale DHCP lease, flapping link, etc).

def _nic_pause_process(p):
    res = _recovery_signal(p["pid"], signal.SIGSTOP, verify_stopped=True)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"Network-heavy process {p['pid']} paused (SIGSTOP) -- {res['verification']}, halting further NIC traffic from it."
        if res["success"] else (res.get("verification") or res.get("stderr") or "pause failed")
    )
    return res

def _nic_resume_process(p):
    res = _recovery_signal(p["pid"], signal.SIGCONT, verify_stopped=False)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"Network-heavy process {p['pid']} resumed (SIGCONT) -- {res['verification']}."
        if res["success"] else (res.get("verification") or res.get("stderr") or "resume failed")
    )
    return res

def _nic_terminate_process(p):
    logger.info("nic.terminate_process: backend received pid=%s", p.get("pid"))
    res = _recovery_signal(p["pid"], signal.SIGTERM, verify_gone=True)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"Network-heavy process {p['pid']} terminated (SIGTERM) -- {res['verification']}."
        if res["success"] else (res.get("verification") or res.get("stderr") or "terminate failed")
    )
    return res

def _nic_kill_process(p):
    logger.info("nic.kill_process: backend received pid=%s", p.get("pid"))
    return _recovery_force_kill(p["pid"], "nic.kill_process")

def _nic_restart_interface(p):
    iface = p["interface"]
    down = _recovery_run(["ip", "link", "set", iface, "down"])
    up = _recovery_run(["ip", "link", "set", iface, "up"])
    success = down["success"] and up["success"]
    return {"success": success, "message": f"Interface {iface} restarted." if success else f"Failed to restart {iface}.",
            "command": f"ip link set {iface} down && ip link set {iface} up",
            "stdout": (down["stdout"] + "\n" + up["stdout"]).strip(),
            "stderr": (down["stderr"] + "\n" + up["stderr"]).strip(), "returncode": up["returncode"]}

def _nic_renew_dhcp(p):
    iface = p["interface"]
    release = _recovery_run(["dhclient", "-r", iface], timeout=60)
    renew = _recovery_run(["dhclient", iface], timeout=60)
    return {"success": renew["success"], "message": f"DHCP lease renewed on {iface}." if renew["success"] else f"DHCP renewal failed on {iface}.",
            "command": f"dhclient -r {iface} && dhclient {iface}",
            "stdout": (release["stdout"] + "\n" + renew["stdout"]).strip(),
            "stderr": (release["stderr"] + "\n" + renew["stderr"]).strip(), "returncode": renew["returncode"]}

def _nic_restart_network_manager(p):
    res = _recovery_run(["systemctl", "restart", "NetworkManager"], timeout=60)
    res["message"] = "NetworkManager restarted." if res["success"] else "Failed to restart NetworkManager."
    return res

def _nic_reload_driver(p):
    iface = p["interface"]
    try:
        driver = Path(f"/sys/class/net/{iface}/device/driver").resolve().name
    except Exception:
        driver = None
    if not driver:
        return {"success": False, "message": f"could not determine driver module for {iface}",
                "command": f"ethtool -i {iface}", "stdout": "", "stderr": "driver not found", "returncode": None}
    unload = _recovery_run(["modprobe", "-r", driver], timeout=60)
    load = _recovery_run(["modprobe", driver], timeout=60)
    return {"success": load["success"], "message": f"Driver {driver} reloaded for {iface}." if load["success"] else f"Failed to reload driver {driver}.",
            "command": f"modprobe -r {driver} && modprobe {driver}",
            "stdout": (unload["stdout"] + "\n" + load["stdout"]).strip(),
            "stderr": (unload["stderr"] + "\n" + load["stderr"]).strip(), "returncode": load["returncode"]}


# ---- PCIe handlers ------------------------------------------------------------

def _pcie_rescan(p):
    try:
        with open("/sys/bus/pci/rescan", "w", encoding="utf-8") as f:
            f.write("1\n")
        return {"success": True, "message": "PCI bus rescanned.", "command": "echo 1 > /sys/bus/pci/rescan",
                "stdout": "", "stderr": "", "returncode": 0}
    except PermissionError:
        return {"success": False, "message": "insufficient privileges to rescan the PCI bus (requires root)",
                "command": "echo 1 > /sys/bus/pci/rescan", "stdout": "", "stderr": "permission denied", "returncode": None}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "message": str(exc), "command": "echo 1 > /sys/bus/pci/rescan",
                "stdout": "", "stderr": str(exc), "returncode": None}

def _pcie_reload_driver(p):
    slot = p["slot"]
    try:
        driver = Path(f"/sys/bus/pci/devices/{slot}/driver").resolve().name
    except Exception:
        driver = None
    if not driver:
        return {"success": False, "message": f"no driver currently bound to {slot}",
                "command": f"cat /sys/bus/pci/devices/{slot}/driver", "stdout": "", "stderr": "no driver bound", "returncode": None}
    try:
        Path(f"/sys/bus/pci/drivers/{driver}/unbind").write_text(slot)
        time.sleep(0.5)
        Path(f"/sys/bus/pci/drivers/{driver}/bind").write_text(slot)
        return {"success": True, "message": f"Driver {driver} reloaded for {slot}.",
                "command": f"echo {slot} > .../{driver}/unbind; echo {slot} > .../{driver}/bind",
                "stdout": "", "stderr": "", "returncode": 0}
    except PermissionError:
        return {"success": False, "message": "insufficient privileges to unbind/bind the PCI driver (requires root)",
                "command": f"reload driver {driver} for {slot}", "stdout": "", "stderr": "permission denied", "returncode": None}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "message": str(exc), "command": f"reload driver {driver} for {slot}",
                "stdout": "", "stderr": str(exc), "returncode": None}


# ---- The whitelist itself ---------------------------------------------------
# Confirmation levels: 1 = low risk, 2 = medium (pause/restart), 3 = high
# (terminate/kill/driver reload/PCI rescan/GPU reset).

RECOVERY_ACTIONS: dict[str, dict[str, Any]] = {
    "cpu.renice": {"handler": _cpu_renice, "level": 1, "domain": "cpu",
                   "required_params": ["pid", "nice_value"], "supported_check": _recovery_binary_check("renice"),
                   "description": "Change a process's scheduling priority."},
    "cpu.pause_process": {"handler": _cpu_pause_process, "level": 2, "domain": "cpu",
                           "required_params": ["pid"], "supported_check": _recovery_always_supported,
                           "description": "Suspend a process (SIGSTOP)."},
    "cpu.resume_process": {"handler": _cpu_resume_process, "level": 1, "domain": "cpu",
                            "required_params": ["pid"], "supported_check": _recovery_always_supported,
                            "description": "Resume a suspended process (SIGCONT)."},
    "cpu.terminate_process": {"handler": _cpu_terminate_process, "level": 3, "domain": "cpu",
                               "required_params": ["pid"], "supported_check": _recovery_always_supported,
                               "description": "Gracefully terminate a process (SIGTERM)."},
    "cpu.kill_process": {"handler": _cpu_kill_process, "level": 3, "domain": "cpu",
                          "required_params": ["pid"], "supported_check": _recovery_always_supported,
                          "description": "Force-kill a process (kill -9 / SIGKILL)."},
    "cpu.restart_service": {"handler": _restart_service, "level": 2, "domain": "cpu",
                             "required_params": ["unit"], "supported_check": _recovery_root_check("systemctl"),
                             "description": "Restart a misbehaving systemd service."},

    "gpu.restart_persistence_daemon": {"handler": _gpu_restart_persistence_daemon, "level": 2, "domain": "gpu",
                                        "required_params": [], "supported_check": _recovery_gpu_check,
                                        "description": "Restart nvidia-persistenced."},
    "gpu.reset": {"handler": _gpu_reset, "level": 3, "domain": "gpu",
                  "required_params": [], "supported_check": _recovery_gpu_check,
                  "description": "Reset a GPU (requires no active compute clients)."},
    "gpu.pause_process": {"handler": _gpu_pause_process, "level": 2, "domain": "gpu",
                           "required_params": ["pid"], "supported_check": _recovery_gpu_check,
                           "description": "Suspend a GPU-using process."},
    "gpu.resume_process": {"handler": _gpu_resume_process, "level": 1, "domain": "gpu",
                            "required_params": ["pid"], "supported_check": _recovery_gpu_check,
                            "description": "Resume a paused GPU-using process (SIGCONT)."},
    "gpu.terminate_process": {"handler": _gpu_terminate_process, "level": 3, "domain": "gpu",
                               "required_params": ["pid"], "supported_check": _recovery_gpu_check,
                               "description": "Gracefully terminate a GPU-using process (SIGTERM)."},

    "ram.restart_service": {"handler": _restart_service, "level": 2, "domain": "ram",
                             "required_params": ["unit"], "supported_check": _recovery_root_check("systemctl"),
                             "description": "Restart a service that is leaking / hogging memory."},
    "ram.drop_caches": {"handler": _ram_drop_caches, "level": 1, "domain": "ram",
                         "required_params": [], "supported_check": _recovery_root_check(),
                         "description": "Drop the page cache, dentries, and inodes."},
    "ram.pause_process": {"handler": _ram_pause_process, "level": 2, "domain": "ram",
                           "required_params": ["pid"], "supported_check": _recovery_always_supported,
                           "description": "Suspend a memory-hogging process."},
    "ram.terminate_process": {"handler": _ram_terminate_process, "level": 3, "domain": "ram",
                               "required_params": ["pid"], "supported_check": _recovery_always_supported,
                               "description": "Force-kill a memory-hogging process (kill -9 / SIGKILL)."},

    "disk.clean_temp_files": {"handler": _disk_clean_temp_files, "level": 1, "domain": "disk",
                               "required_params": [], "supported_check": _recovery_always_supported,
                               "description": "Remove old files under /tmp and /var/tmp."},
    "disk.vacuum_journal": {"handler": _disk_vacuum_journal, "level": 1, "domain": "disk",
                             "required_params": [], "supported_check": _recovery_binary_check("journalctl"),
                             "description": "Shrink the systemd journal to a target size."},
    "disk.identify_large_directories": {"handler": _disk_identify_large_directories, "level": 1, "domain": "disk",
                                         "required_params": [], "supported_check": _recovery_binary_check("du"),
                                         "description": "Read-only scan of directory sizes."},
    "disk.pause_process": {"handler": _disk_pause_process, "level": 2, "domain": "disk",
                            "required_params": ["pid"], "supported_check": _recovery_always_supported,
                            "description": "Suspend a disk I/O-heavy process (SIGSTOP)."},
    "disk.resume_process": {"handler": _disk_resume_process, "level": 1, "domain": "disk",
                             "required_params": ["pid"], "supported_check": _recovery_always_supported,
                             "description": "Resume a paused process (SIGCONT)."},
    "disk.terminate_process": {"handler": _disk_terminate_process, "level": 3, "domain": "disk",
                                "required_params": ["pid"], "supported_check": _recovery_always_supported,
                                "description": "Gracefully terminate a disk I/O-heavy process (SIGTERM)."},

    # --- NIC: process-level (Trial6) ---
    "nic.pause_process": {"handler": _nic_pause_process, "level": 2, "domain": "nic",
                           "required_params": ["pid"], "supported_check": _recovery_always_supported,
                           "description": "Suspend a network-bandwidth-heavy process (SIGSTOP) -- e.g. an iperf3 "
                                          "test, a runaway rsync/scp, or any other process saturating the NIC."},
    "nic.resume_process": {"handler": _nic_resume_process, "level": 1, "domain": "nic",
                            "required_params": ["pid"], "supported_check": _recovery_always_supported,
                            "description": "Resume a paused network-bandwidth-heavy process (SIGCONT)."},
    "nic.terminate_process": {"handler": _nic_terminate_process, "level": 3, "domain": "nic",
                               "required_params": ["pid"], "supported_check": _recovery_always_supported,
                               "description": "Gracefully terminate a network-bandwidth-heavy process (SIGTERM)."},
    "nic.kill_process": {"handler": _nic_kill_process, "level": 3, "domain": "nic",
                          "required_params": ["pid"], "supported_check": _recovery_always_supported,
                          "description": "Force-kill a network-bandwidth-heavy process (kill -9 / SIGKILL)."},

    # --- NIC: subsystem/interface-level (pre-existing) ---
    "nic.restart_interface": {"handler": _nic_restart_interface, "level": 2, "domain": "nic",
                               "required_params": ["interface"], "supported_check": _recovery_root_check("ip"),
                               "description": "Bring a network interface down and back up."},
    "nic.renew_dhcp": {"handler": _nic_renew_dhcp, "level": 2, "domain": "nic",
                        "required_params": ["interface"], "supported_check": _recovery_root_check("dhclient"),
                        "description": "Release and renew a DHCP lease."},
    "nic.restart_network_manager": {"handler": _nic_restart_network_manager, "level": 2, "domain": "nic",
                                     "required_params": [], "supported_check": _recovery_root_check("systemctl"),
                                     "description": "Restart the NetworkManager service."},
    "nic.reload_driver": {"handler": _nic_reload_driver, "level": 3, "domain": "nic",
                           "required_params": ["interface"], "supported_check": _recovery_root_check("modprobe"),
                           "description": "Unload and reload the NIC's kernel driver module."},

    "pcie.rescan": {"handler": _pcie_rescan, "level": 3, "domain": "pcie",
                     "required_params": [], "supported_check": _recovery_root_check(),
                     "description": "Trigger a full PCI bus rescan."},
    "pcie.reload_driver": {"handler": _pcie_reload_driver, "level": 3, "domain": "pcie",
                            "required_params": ["slot"], "supported_check": _recovery_root_check(),
                            "description": "Unbind and rebind the driver for a specific PCI device."},
}


# ============================================================================
# Recovery Validation
# ============================================================================
# Single choke point for "is this PID/service/interface/slot safe to touch".
# Every handler above only ever receives values that already passed here.

RECOVERY_PROTECTED_PIDS: set[int] = {1}

RECOVERY_PROTECTED_PROCESS_NAMES: set[str] = {
    "systemd", "init", "kthreadd", "sshd", "ssh", "dbus-daemon",
    "systemd-journald", "systemd-logind", "systemd-udevd", "udevd",
    "NetworkManager", "containerd", "dockerd", "cron", "crond",
}

# So a recovery action can never target this Flask/telemetry process itself.
TELEMETRY_PROCESS_NAME_HINTS = ("collect_metrics", "hardware-monitor")

RECOVERY_PROTECTED_SERVICES: set[str] = {
    "ssh", "sshd", "systemd-journald", "systemd-logind", "systemd-networkd",
    "systemd-resolved", "systemd-udevd", "dbus", "cron", "udev",
    "networking", "network-manager", "networkmanager",
}

_RECOVERY_SERVICE_NAME_RE = re.compile(r"^[a-zA-Z0-9@._-]{1,128}$")
_RECOVERY_IFACE_NAME_RE = re.compile(r"^[a-zA-Z0-9._-]{1,15}$")
_RECOVERY_PCI_SLOT_RE = re.compile(r"^[0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-9a-fA-F]$")


def _recovery_pid_exists(pid: int) -> bool:
    return Path(f"/proc/{pid}").is_dir()


def validate_pid(pid) -> tuple[bool, str, Optional[int]]:
    try:
        pid_int = int(pid)
    except (TypeError, ValueError):
        return False, "pid must be an integer", None
    if pid_int <= 0:
        return False, "pid must be a positive integer", None
    if not _recovery_pid_exists(pid_int):
        return False, f"pid {pid_int} does not exist", pid_int
    if pid_int in RECOVERY_PROTECTED_PIDS:
        return False, f"pid {pid_int} is protected (init/systemd)", pid_int
    if pid_int == os.getpid():
        return False, "refusing to target the telemetry/recovery backend itself", pid_int

    comm = read_stripped(f"/proc/{pid_int}/comm") or ""
    if comm in RECOVERY_PROTECTED_PROCESS_NAMES:
        return False, f"pid {pid_int} ({comm}) is a protected system process", pid_int

    cmdline = read_file(f"/proc/{pid_int}/cmdline").replace("\x00", " ")
    if any(hint in cmdline for hint in TELEMETRY_PROCESS_NAME_HINTS):
        return False, f"pid {pid_int} looks like the telemetry backend itself", pid_int

    status = read_file(f"/proc/{pid_int}/status")
    m = re.search(r"^PPid:\s*(\d+)", status, re.MULTILINE)
    if m and int(m.group(1)) == 2:
        return False, f"pid {pid_int} is a kernel thread", pid_int

    return True, "ok", pid_int


def validate_service_name(name) -> tuple[bool, str, Optional[str]]:
    if not name or not isinstance(name, str):
        return False, "service name is required", None
    name = name.strip()
    if not _RECOVERY_SERVICE_NAME_RE.match(name):
        return False, "service name contains invalid characters", None
    base = name[:-8] if name.endswith(".service") else name
    if base.lower() in RECOVERY_PROTECTED_SERVICES:
        return False, f"service '{base}' is protected and cannot be restarted via this action", None
    return True, "ok", name if name.endswith(".service") else f"{name}.service"


def validate_interface(name) -> tuple[bool, str, Optional[str]]:
    if not name or not isinstance(name, str):
        return False, "interface name is required", None
    name = name.strip()
    if not _RECOVERY_IFACE_NAME_RE.match(name):
        return False, "interface name contains invalid characters", None
    if name == "lo":
        return False, "the loopback interface cannot be recovery-targeted", None
    if not NET_CLASS_PATH.joinpath(name).exists():
        return False, f"interface '{name}' does not exist on this host", None
    return True, "ok", name


def validate_nice_value(value) -> tuple[bool, str, Optional[int]]:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return False, "nice_value must be an integer", None
    if n < -20 or n > 19:
        return False, "nice_value must be between -20 and 19", None
    return True, "ok", n


def validate_pci_slot(slot) -> tuple[bool, str, Optional[str]]:
    if not slot or not isinstance(slot, str):
        return False, "slot is required", None
    slot = slot.strip()
    if not _RECOVERY_PCI_SLOT_RE.match(slot):
        return False, "slot must look like 0000:01:00.0", None
    if not PCI_DEVICES_PATH.joinpath(slot).exists():
        return False, f"PCI device {slot} not found", None
    return True, "ok", slot


def validate_confirmation(confirmation, required_level: int) -> tuple[bool, str]:
    if not isinstance(confirmation, dict):
        return False, "confirmation object is required"
    if not confirmation.get("userAcknowledged"):
        return False, "user confirmation is required before executing a recovery action"
    try:
        level = int(confirmation.get("level"))
    except (TypeError, ValueError):
        return False, "confirmation.level must be an integer"
    if level < required_level:
        return False, f"this action requires confirmation level {required_level} or higher"
    return True, "ok"


class RecoveryRequestError(Exception):
    """Any validation failure -- caught by the /recovery/execute route and
    turned into a 400, never allowed to crash Flask."""


def _resolve_recovery_params(action_key: str, raw: dict) -> dict[str, Any]:
    raw = raw or {}
    resolved: dict[str, Any] = {}

    if action_key.endswith(("pause_process", "resume_process", "terminate_process", "kill_process")):
        ok, reason, pid = validate_pid(raw.get("pid"))
        if not ok:
            raise RecoveryRequestError(reason)
        resolved["pid"] = pid

    elif action_key == "cpu.renice":
        ok, reason, pid = validate_pid(raw.get("pid"))
        if not ok:
            raise RecoveryRequestError(reason)
        ok2, reason2, nice_value = validate_nice_value(raw.get("nice_value"))
        if not ok2:
            raise RecoveryRequestError(reason2)
        resolved["pid"], resolved["nice_value"] = pid, nice_value

    elif action_key in ("cpu.restart_service", "ram.restart_service"):
        ok, reason, unit = validate_service_name(raw.get("unit") or raw.get("service"))
        if not ok:
            raise RecoveryRequestError(reason)
        resolved["unit"] = unit

    elif action_key == "disk.clean_temp_files":
        if "min_age_hours" in raw:
            resolved["min_age_hours"] = raw["min_age_hours"]

    elif action_key == "disk.vacuum_journal":
        if "max_size" in raw:
            resolved["max_size"] = raw["max_size"]

    elif action_key == "disk.identify_large_directories":
        if "path" in raw:
            resolved["path"] = raw["path"]

    elif action_key in ("nic.restart_interface", "nic.renew_dhcp", "nic.reload_driver"):
        ok, reason, iface = validate_interface(raw.get("interface"))
        if not ok:
            raise RecoveryRequestError(reason)
        resolved["interface"] = iface

    elif action_key == "gpu.reset":
        if "gpu_id" in raw:
            resolved["gpu_id"] = raw["gpu_id"]

    elif action_key == "pcie.reload_driver":
        ok, reason, slot = validate_pci_slot(raw.get("slot"))
        if not ok:
            raise RecoveryRequestError(reason)
        resolved["slot"] = slot

    return resolved


# ============================================================================
# Recovery Verification
# ============================================================================
# Capture telemetry before execution, run the whitelisted action, refresh
# telemetry, and return before/after so the frontend can confirm recovery
# actually worked. Reuses collect_metrics() -- the same function the
# background updater loop calls -- rather than duplicating collection logic.

RECOVERY_SETTLE_SECONDS = {
    "nic.restart_interface": 3.0, "nic.renew_dhcp": 3.0, "nic.restart_network_manager": 3.0,
    "nic.reload_driver": 3.0, "cpu.restart_service": 2.0, "ram.restart_service": 2.0,
    "gpu.restart_persistence_daemon": 2.0, "pcie.rescan": 2.0, "pcie.reload_driver": 2.0,
}
_RECOVERY_DEFAULT_SETTLE = 1.0


def build_recovery_capabilities_report() -> dict[str, Any]:
    report = []
    for key, meta in RECOVERY_ACTIONS.items():
        try:
            supported, reason = meta["supported_check"]()
        except Exception as exc:  # noqa: BLE001
            supported, reason = False, f"capability check failed: {exc}"
        entry = {
            "key": key, "domain": meta["domain"], "level": meta["level"],
            "required_params": meta["required_params"], "description": meta["description"],
            "supported": bool(supported),
        }
        if not supported:
            entry["reason"] = reason or "not supported on this host"
        report.append(entry)
    return {"actions": report}


def get_recovery_process_candidates(domain: str = "cpu", min_percent: float = 1.0, limit: int = 50) -> list[dict[str, Any]]:
    """All processes consuming at least `min_percent` of the given domain's
    resource, sorted highest-first -- not just the single top offender.

    This exists because a workload like `stress-ng --cpu 12` spreads load
    across many small/medium processes rather than one dominant one (and,
    for the "nic" domain, a workload like `iperf3 -c ... -P 8` spawns
    several parallel streams the same way); a "top 1" view hides the other
    candidates a user might want to pause or kill. Re-fetches process data
    itself (fresh `ps`/`nvidia-smi`/`nethogs`, not the last cached
    /metrics tick) so the list reflects what's true right now, and each
    entry is pre-checked against the same protected-process rules
    recovery/execute enforces, so the frontend can grey out unkillable
    entries (init, sshd, this backend itself, etc.) without a round trip.

    domain="nic" is intentionally not tied to any specific traffic tool
    (iperf3, rsync, curl, a P2P client, ...): it ranks whatever process
    nethogs attributes the most sent+received KB/s to, so it self-heals
    ANY NIC-saturating process, not just one specific one.
    """
    candidates: list[dict[str, Any]] = []

    if domain == "gpu":
        for proc in get_gpu_processes():
            compute = proc.get("gpu_compute_percent") or 0.0
            mem_pct = proc.get("gpu_memory_percent") or 0.0
            mem_mb = proc.get("gpu_memory_mb") or 0
            usage = max(float(compute), float(mem_pct))
            if usage < min_percent and mem_mb < 64:
                continue
            pid = proc.get("pid")
            ok, reason, _ = validate_pid(pid) if pid is not None else (False, "invalid pid", None)
            candidates.append({
                **proc,
                "usage_percent": usage if usage > 0 else mem_mb,
                "recoverable": ok,
                "reason": None if ok else reason,
            })
    elif domain == "disk":
        for proc in get_top_disk_io_processes(limit=max(limit, 50)):
            kbps = proc.get("io_total_kbps") or 0.0
            if kbps < min_percent:
                continue
            pid = proc.get("pid")
            ok, reason, _ = validate_pid(pid) if pid is not None else (False, "invalid pid", None)
            candidates.append({
                **proc,
                "usage_percent": kbps,
                "recoverable": ok,
                "reason": None if ok else reason,
            })
    elif domain == "nic":
        # min_percent is interpreted as a total_kbps (sent+received)
        # threshold here, mirroring the "disk" domain's kbps semantics
        # above -- NIC bandwidth, like disk I/O, isn't a 0-100 percent
        # quantity.
        for proc in get_top_nic_processes(limit=max(limit, 50)):
            kbps = proc.get("total_kbps") or 0.0
            source = proc.get("source") or ""
            if kbps < min_percent and source not in ("pgrep", "ss"):
                continue
            pid = proc.get("pid")
            ok, reason, _ = validate_pid(pid) if pid is not None else (False, "invalid pid", None)
            rx_mbps = proc.get("rx_mbps")
            tx_mbps = proc.get("tx_mbps")
            total_mbps = proc.get("total_mbps")
            if total_mbps is None and kbps:
                total_mbps = _kbps_to_mbps(kbps)
            if rx_mbps is None and proc.get("received_kbps") is not None:
                rx_mbps = _kbps_to_mbps(proc.get("received_kbps"))
            if tx_mbps is None and proc.get("sent_kbps") is not None:
                tx_mbps = _kbps_to_mbps(proc.get("sent_kbps"))
            candidates.append({
                **proc,
                "rx_mbps": rx_mbps,
                "tx_mbps": tx_mbps,
                "total_mbps": total_mbps,
                "usage_percent": kbps,
                "recoverable": ok,
                "reason": None if ok else reason,
            })
    else:
        # Pull considerably more rows than the /metrics "top 10" snapshot
        # so small-but-numerous consumers (e.g. a dozen stress-ng workers)
        # aren't truncated out before the threshold filter even runs.
        for proc in get_top_cpu_processes(limit=max(limit, 50)):
            pct = proc.get("cpu_percent") or 0.0
            if pct < min_percent:
                continue
            pid = proc.get("pid")
            ok, reason, _ = validate_pid(pid) if pid is not None else (False, "invalid pid", None)
            candidates.append({
                **proc,
                "usage_percent": pct,
                "recoverable": ok,
                "reason": None if ok else reason,
            })

    candidates.sort(key=lambda c: c.get("usage_percent") or 0.0, reverse=True)
    return candidates[:limit]


def execute_recovery_action(action_key: str, raw_params: dict, confirmation: dict) -> dict[str, Any]:
    if action_key not in RECOVERY_ACTIONS:
        raise RecoveryRequestError(f"unknown recovery action '{action_key}'")

    meta = RECOVERY_ACTIONS[action_key]

    ok, reason = validate_confirmation(confirmation or {}, meta["level"])
    if not ok:
        raise RecoveryRequestError(reason)

    supported, unsupported_reason = meta["supported_check"]()
    if not supported:
        raise RecoveryRequestError(f"action '{action_key}' is not supported on this host: {unsupported_reason}")

    for required in meta["required_params"]:
        if (raw_params or {}).get(required) in (None, ""):
            raise RecoveryRequestError(f"missing required parameter '{required}'")

    resolved_params = _resolve_recovery_params(action_key, raw_params or {})
    result = meta["handler"](resolved_params)
    result.setdefault("message", "")
    return result


def run_recovery_action(action_key: str, params: dict, fault: Optional[dict], confirmation: dict) -> dict[str, Any]:
    """Full lifecycle: before metrics -> execute -> settle -> after metrics
    -> log -> structured response. This is what the /recovery/execute
    route calls.

    `success` means the *action* succeeded (signal delivered and process
    state verified where applicable). It does NOT mean the original fault
    has recovered — the UI/workflow must re-check telemetry for that.
    """
    before_metrics = _safe_collect_metrics()

    pid_raw = (params or {}).get("pid")
    process_state_before = None
    try:
        if pid_raw is not None and str(pid_raw).strip() != "":
            process_state_before = _recovery_process_state(int(pid_raw))
    except (TypeError, ValueError):
        process_state_before = None

    started = time.monotonic()
    result = execute_recovery_action(action_key, params, confirmation)
    duration = round(time.monotonic() - started, 3)

    time.sleep(RECOVERY_SETTLE_SECONDS.get(action_key, _RECOVERY_DEFAULT_SETTLE))

    after_metrics = _safe_collect_metrics()

    process_state_after = result.get("process_state_after")
    if process_state_after is None and pid_raw is not None:
        try:
            process_state_after = _recovery_process_state(int(pid_raw))
        except (TypeError, ValueError):
            process_state_after = None

    # Prefer handler-provided process verification; fall back to presence check.
    verified = result.get("verified")
    verification = result.get("verification")
    if verified is None and pid_raw is not None:
        is_kill = action_key.endswith(("kill_process", "terminate_process"))
        is_pause = action_key.endswith("pause_process")
        is_resume = action_key.endswith("resume_process")
        if is_kill:
            verified = process_state_after is None or process_state_after == "Z"
            verification = (
                f"pid {pid_raw} confirmed terminated"
                if verified
                else f"pid {pid_raw} still present (state={process_state_after!r})"
            )
        elif is_pause:
            verified = process_state_after == "T"
            verification = f"pid {pid_raw} state={process_state_after}"
        elif is_resume:
            verified = process_state_after is not None and process_state_after != "T"
            verification = f"pid {pid_raw} state={process_state_after}"

    action_success = bool(result.get("success"))
    if verified is False:
        action_success = False
    elif action_key.endswith(("kill_process", "terminate_process")) and verified is True:
        action_success = True
    # actionStatus is command/process verification only — never fault recovery.
    action_status = "ACTION_SUCCESS" if action_success else "ACTION_FAILED"

    record_recovery_history(
        action=action_key, params=params or {}, fault=fault, confirmation=confirmation or {},
        command=result.get("command", ""), success=action_success,
        message=result.get("message", ""), stdout=result.get("stdout", ""), stderr=result.get("stderr", ""),
        returncode=result.get("returncode"), before_metrics=before_metrics, after_metrics=after_metrics,
        duration_seconds=duration,
        verified=verified,
        verification=verification,
        process_state_before=process_state_before if result.get("process_state_before") is None else result.get("process_state_before"),
        process_state_after=process_state_after,
        action_status=action_status,
        # Fault-level recovery is determined by the frontend against live thresholds.
        recovery_status=None,
    )

    return {
        "success": action_success,
        "message": result.get("message", ""),
        "command": result.get("command", ""),
        "output": result.get("stdout", ""),
        "stderr": result.get("stderr", ""),
        "returncode": result.get("returncode"),
        "beforeMetrics": before_metrics,
        "afterMetrics": after_metrics,
        "durationSeconds": duration,
        "verified": verified,
        "verification": verification,
        "processStateBefore": (
            process_state_before
            if result.get("process_state_before") is None
            else result.get("process_state_before")
        ),
        "processStateAfter": process_state_after,
        "actionStatus": action_status,
        # Explicitly not RECOVERED — callers must verify the fault condition.
        "recoveryStatus": None,
    }


def _safe_collect_metrics() -> dict:
    try:
        return collect_metrics() or {}
    except Exception:
        return {}


# ============================================================================
# Recovery History
# ============================================================================
# Lightweight audit log: bounded in-memory list for fast reads, plus an
# append-only JSONL file so history survives a process restart.

RECOVERY_HISTORY_FILE = Path("recovery_history.jsonl")
RECOVERY_HISTORY_MAX_IN_MEMORY = 500
_recovery_history_lock = threading.Lock()
RECOVERY_HISTORY: list[dict[str, Any]] = []


def _load_recovery_history() -> None:
    if not RECOVERY_HISTORY_FILE.exists():
        return
    try:
        lines = RECOVERY_HISTORY_FILE.read_text(encoding="utf-8").splitlines()
        for line in lines[-RECOVERY_HISTORY_MAX_IN_MEMORY:]:
            try:
                RECOVERY_HISTORY.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    except Exception:
        pass


_load_recovery_history()


def record_recovery_history(**entry_fields) -> dict[str, Any]:
    entry = {"timestamp": datetime.now(timezone.utc).isoformat(), **entry_fields}
    with _recovery_history_lock:
        RECOVERY_HISTORY.append(entry)
        if len(RECOVERY_HISTORY) > RECOVERY_HISTORY_MAX_IN_MEMORY:
            del RECOVERY_HISTORY[: len(RECOVERY_HISTORY) - RECOVERY_HISTORY_MAX_IN_MEMORY]
        try:
            with open(RECOVERY_HISTORY_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, default=str) + "\n")
        except Exception:
            pass
    try:
        telemetry_db.insert_recovery_execution(entry)
    except Exception:
        logger.exception("Failed to persist recovery execution to telemetry database")
    return entry


def get_recovery_history(limit: int = 100) -> list[dict[str, Any]]:
    with _recovery_history_lock:
        return list(reversed(RECOVERY_HISTORY[-limit:]))


# --------------------------------------------------------------------------
# Background updater thread
# --------------------------------------------------------------------------

def updater_loop() -> None:
    """Background daemon loop with independent refresh intervals."""
    global LATEST_INVENTORY, LATEST_METRICS, LATEST_LINK_HEALTH

    last_inventory = 0
    last_link_health = 0

    while True:
        try:
            # Clear the per-cycle subprocess cache so this tick's data is
            # always freshly collected, while calls repeated within the
            # same tick (e.g. multiple callers needing `lscpu` or the
            # functional-block ledger sharing commands with the health
            # engine) still dedupe.
            _CMD_CACHE.clear()

            now = time.time()

            # --------------------------------------------------
            # Metrics every 5 seconds
            # --------------------------------------------------
            metrics = collect_metrics()

            with _state_lock:
                LATEST_METRICS = metrics

            # --------------------------------------------------
            # Inventory every 30 seconds
            # --------------------------------------------------
            if now - last_inventory >= 30:
                inventory = collect_inventory()

                with _state_lock:
                    LATEST_INVENTORY = inventory

                last_inventory = now

            # --------------------------------------------------
            # Link Health (incl. Functional Block Ledger) every 30 seconds
            # --------------------------------------------------
            if now - last_link_health >= 30:
                link_health = collect_link_health()

                with _state_lock:
                    LATEST_LINK_HEALTH = link_health

                last_link_health = now

            # --------------------------------------------------
            # Write snapshot
            # --------------------------------------------------
            with _state_lock:
                snapshot = {
                    "inventory": LATEST_INVENTORY,
                    "metrics": LATEST_METRICS,
                    "link_health": LATEST_LINK_HEALTH,
                }

            snapshot = prune_json(snapshot)

            with open(INVENTORY_FILE, "w", encoding="utf-8") as f:
                json.dump(snapshot, f, indent=2, default=str)

            try:
                with _state_lock:
                    db_metrics = LATEST_METRICS
                    db_inventory = LATEST_INVENTORY
                    db_link_health = LATEST_LINK_HEALTH
                poll_result = telemetry_db.persist_poll_cycle(
                    db_metrics, db_inventory, db_link_health
                )
                if fbl_email is not None and isinstance(poll_result, dict):
                    try:
                        fbl_email.handle_poll_alert_faults(
                            poll_result.get("alert_faults")
                            or poll_result.get("critical_faults")
                            or [],
                            hostname=poll_result.get("hostname"),
                        )
                    except Exception:
                        logger.exception(
                            "Email notification hook failed (telemetry unaffected)"
                        )
            except Exception:
                logger.exception("Failed to persist telemetry poll cycle to database")

        except Exception as exc:
            logger.exception("Unhandled error in updater loop: %s", exc)

        time.sleep(5)


# --------------------------------------------------------------------------
# Flask application
# --------------------------------------------------------------------------

app = Flask(__name__)
CORS(app)

# On-demand FBL utilities (safe collectors; reuse LATEST_* caches where possible)
if fbl_utilities is not None:
    def _utilities_latest():
        with _state_lock:
            return (
                dict(LATEST_METRICS or {}),
                dict(LATEST_INVENTORY or {}),
                dict(LATEST_LINK_HEALTH or {}),
            )

    try:
        fbl_utilities.register_utilities_routes(app, get_latest=_utilities_latest)
    except Exception:
        logger.exception("Failed to register FBL utilities routes")

if fbl_chatbot is not None:
    def _chatbot_latest():
        with _state_lock:
            return (
                dict(LATEST_METRICS or {}),
                dict(LATEST_INVENTORY or {}),
                dict(LATEST_LINK_HEALTH or {}),
            )

    try:
        fbl_chatbot.register_chatbot_routes(app, get_latest=_chatbot_latest)
    except Exception:
        logger.exception("Failed to register FBL chatbot routes")

if fbl_email is not None:
    def _email_latest():
        with _state_lock:
            return (
                dict(LATEST_METRICS or {}),
                dict(LATEST_INVENTORY or {}),
                dict(LATEST_LINK_HEALTH or {}),
            )

    try:
        fbl_email.register_email_routes(app, get_latest=_email_latest)
    except Exception:
        logger.exception("Failed to register FBL email notification routes")

if fbl_incident_analysis is not None:
    def _incident_demo_active():
        try:
            return any(
                str((info or {}).get("severity") or "healthy").lower() not in ("healthy", "")
                for info in get_state().values()
            )
        except Exception:
            return False

    try:
        fbl_incident_analysis.register_incident_analysis_routes(
            app, get_demo_active=_incident_demo_active
        )
    except Exception:
        logger.exception("Failed to register FBL incident analysis routes")


@app.route("/inventory")
def inventory_endpoint():
    with _state_lock:
        data = LATEST_INVENTORY
    return jsonify(data)


@app.route("/metrics")
def metrics_endpoint():
    with _state_lock:
        data = LATEST_METRICS
    return jsonify(data)


@app.route("/link_health")
def api_link_health():
    with _state_lock:
        return jsonify(LATEST_LINK_HEALTH)


@app.route("/functional_blocks")
def api_functional_blocks():
    """Direct access to just the Internal Functional Block Ledger, without
    having to pull the full link_health payload."""
    with _state_lock:
        data = (LATEST_LINK_HEALTH or {}).get("functional_blocks", {})
    return jsonify(data)


@app.route("/platform_extras")
def api_platform_extras():
    """Trial2 addition: direct access to the chassis/voltage-probe/cooling-
    device/battery/power-supply data without pulling the full link_health
    payload, mirroring the existing /functional_blocks convenience route."""
    with _state_lock:
        data = LATEST_LINK_HEALTH or {}
    return jsonify({
        "chassis": data.get("chassis", {}),
        "voltage_probes": data.get("voltage_probes", []),
        "cooling_devices": data.get("cooling_devices", []),
        "battery": data.get("battery", {}),
        "power_supply": data.get("power_supply", {}),
    })


@app.route("/health")
def health_endpoint():
    return jsonify({"status": "ok", "time": datetime.now(timezone.utc).isoformat()})


# ============================================================================
# Digital Twin APIs  (simulation, ranking, approval-gated execution bridge)
# ============================================================================
# Read-only simulation lives in digital_twin.py. Real execution reuses the
# existing RECOVERY_ACTIONS handlers via run_recovery_action() below.
# Nothing here bypasses validate_pid() / validate_confirmation().

import digital_twin as dt_engine  # noqa: E402
import digital_twin_learning as dt_learning  # noqa: E402

_DIGITAL_TWIN_SETTLE_SECONDS = 1.5

_DIGITAL_TWIN_ACTION_MAP: dict[tuple[str, str], str] = {
    (dt_engine.DOMAIN_CPU, "pause"): "cpu.pause_process",
    (dt_engine.DOMAIN_CPU, "terminate"): "cpu.terminate_process",
    (dt_engine.DOMAIN_CPU, "kill"): "cpu.kill_process",
    (dt_engine.DOMAIN_RAM, "pause"): "ram.pause_process",
    (dt_engine.DOMAIN_RAM, "terminate"): "ram.terminate_process",
    (dt_engine.DOMAIN_RAM, "kill"): "ram.kill_process",
    ("process", "pause"): "cpu.pause_process",
    ("process", "terminate"): "cpu.terminate_process",
    ("process", "kill"): "cpu.kill_process",
    (dt_engine.DOMAIN_NIC, "restart_interface"): "nic.restart_interface",
    (dt_engine.DOMAIN_NIC, "restart_network_service"): "nic.restart_network_manager",
    (dt_engine.DOMAIN_NIC, "reduce_offending_workload"): "nic.terminate_process",
    (dt_engine.DOMAIN_IO_CONTROLLER, "reduce_offending_workload"): "disk.pause_process",
    (dt_engine.DOMAIN_GPU, "terminate_gpu_workload"): "gpu.terminate_process",
    (dt_engine.DOMAIN_GPU, "pause_gpu_workload"): "gpu.pause_process",
    (dt_engine.DOMAIN_DISK, "recommend_clean_temp"): "disk.clean_temp_files",
    (dt_engine.DOMAIN_DISK, "recommend_vacuum_journal"): "disk.vacuum_journal",
}


def _nic_attributed_pids_from_cm() -> dict[str, int]:
    """Best-effort per-interface PID attribution via nethogs (when available)."""
    mapping: dict[str, int] = {}
    for proc in get_top_nic_processes(limit=5):
        pid = proc.get("pid")
        iface = proc.get("interface") or proc.get("device")
        if pid is not None and iface:
            mapping[str(iface)] = int(pid)
    return mapping


def _map_digital_twin_simulation_to_recovery_key(sim: dict[str, Any]) -> Optional[str]:
    domain = sim.get("domain") or "process"
    action = sim.get("action") or ""
    return _DIGITAL_TWIN_ACTION_MAP.get((domain, action))


def _simulate_from_payload(body: dict[str, Any]) -> dt_engine.SimulationResult:
    domain = body.get("domain", "process")
    action = body.get("action")
    if not action:
        raise RecoveryRequestError("'action' is required")

    state = None
    if body.get("use_cached_state"):
        state = dt_engine._resolve_state(None)

    if domain in (dt_engine.DOMAIN_CPU, dt_engine.DOMAIN_RAM, "process"):
        pid = body.get("pid")
        if pid is None:
            raise RecoveryRequestError("'pid' is required for process simulations")
        return dt_engine.simulate_action(action, int(pid), state)

    if domain == dt_engine.DOMAIN_NIC:
        iface = body.get("interface") or body.get("target_name")
        if not iface:
            raise RecoveryRequestError("'interface' is required for NIC simulations")
        return dt_engine.simulate_nic_action(
            action, str(iface), state, offending_pid=body.get("pid"),
        )

    if domain == dt_engine.DOMAIN_IO_CONTROLLER:
        device = body.get("device") or body.get("target_name")
        pid = body.get("pid")
        if not device or pid is None:
            raise RecoveryRequestError("'device' and 'pid' are required for I/O controller simulations")
        return dt_engine.simulate_io_controller_action(action, str(device), int(pid), state)

    if domain == dt_engine.DOMAIN_GPU:
        return dt_engine.simulate_gpu_action(
            action, state, gpu_index=int(body.get("gpu_index", 0)), pid=body.get("pid"),
        )

    raise RecoveryRequestError(f"unsupported simulation domain '{domain}'")


def _record_digital_twin_outcome(
    sim_dict: dict[str, Any],
    *,
    approved: bool,
    executed: bool,
    actual_state: Optional[dict[str, Any]] = None,
    result_message: str = "",
    simulation_id: Optional[int] = None,
) -> Optional[int]:
    predicted = sim_dict.get("predicted_state") or {}
    signed_error = dt_engine.compare_prediction_vs_actual(predicted, actual_state or {})
    accuracy = (
        "matched" if signed_error and all(abs(v) < 2.0 for v in signed_error.values())
        else ("partial" if signed_error else "unknown")
    )

    if simulation_id is not None:
        telemetry_db.update_digital_twin_simulation(simulation_id, {
            "approved": approved,
            "executed": executed,
            "actual_state": actual_state,
            "prediction_accuracy": accuracy,
            "result": result_message,
        })
        return simulation_id

    return telemetry_db.record_digital_twin_simulation({
        "component": sim_dict.get("domain"),
        "action": sim_dict.get("action"),
        "pid": sim_dict.get("target_pid"),
        "target_process": sim_dict.get("target_process"),
        "before_state": sim_dict.get("current_state"),
        "predicted_state": predicted,
        "risk": sim_dict.get("risk"),
        "confidence": sim_dict.get("confidence_percent"),
        "prediction_basis": sim_dict.get("explanation"),
        "approved": approved,
        "executed": executed,
        "actual_state": actual_state,
        "prediction_accuracy": accuracy,
        "result": result_message,
        "payload": sim_dict,
    })


@app.route("/digital_twin/measure")
def digital_twin_measure_endpoint():
    """MEASURE: collect a fresh DigitalTwinState snapshot."""
    interval = request.args.get("interval", default=1.0, type=float)
    interval = max(0.1, min(interval, 5.0))
    try:
        state = dt_engine.collect_current_state(sample_interval=interval)
        return jsonify({"success": True, "state": dt_engine.state_to_dict(state)})
    except Exception as exc:  # noqa: BLE001
        logger.exception("Digital Twin measure failed")
        return jsonify({"success": False, "message": str(exc)}), 500


@app.route("/digital_twin/pressure")
def digital_twin_pressure_endpoint():
    """DETECT PROBLEM: per-domain pressure report."""
    try:
        state = dt_engine.collect_current_state(sample_interval=0.5)
        pressure = dt_engine.detect_pressure(state)
        return jsonify({
            "success": True,
            "state_summary": state.summary_dict(),
            "pressure": pressure,
        })
    except Exception as exc:  # noqa: BLE001
        logger.exception("Digital Twin pressure detection failed")
        return jsonify({"success": False, "message": str(exc)}), 500


@app.route("/digital_twin/candidates")
def digital_twin_candidates_endpoint():
    """GENERATE + RANK domain-aware recovery candidates."""
    top_n = request.args.get("top_n", default=5, type=int)
    top_n = max(1, min(top_n, 20))
    interval = request.args.get("interval", default=1.0, type=float)
    interval = max(0.1, min(interval, 5.0))
    try:
        state = dt_engine.collect_current_state(sample_interval=interval)
        report = dt_engine.generate_recovery_candidates(
            state,
            top_n_processes=top_n,
            nic_attributed_pids=_nic_attributed_pids_from_cm(),
        )
        sim_rows = []
        for sim in report["ranked"]:
            sim_dict = sim.to_dict()
            sim_id = telemetry_db.record_digital_twin_simulation({
                "component": sim.domain,
                "action": sim.action,
                "pid": sim.target_pid,
                "target_process": sim.target_process,
                "before_state": sim.current_state,
                "predicted_state": sim.predicted_state,
                "risk": sim.risk,
                "confidence": sim.confidence_percent,
                "prediction_basis": sim.explanation,
                "approved": 0,
                "executed": 0,
                "payload": sim_dict,
            })
            sim_dict["simulation_id"] = sim_id
            sim_rows.append(sim_dict)

        return jsonify({
            "success": True,
            "pressure": report["pressure"],
            "pressured_domains": report["pressured_domains"],
            "candidates": sim_rows,
            "count": len(sim_rows),
            "message": report["message"],
        })
    except Exception as exc:  # noqa: BLE001
        logger.exception("Digital Twin candidate generation failed")
        return jsonify({"success": False, "message": str(exc)}), 500


@app.route("/digital_twin/simulate", methods=["POST"])
def digital_twin_simulate_endpoint():
    """SIMULATE one action (read-only). Body: {domain, action, pid?, interface?, device?}."""
    body = request.get_json(silent=True) or {}
    try:
        sim = _simulate_from_payload(body)
        sim_dict = sim.to_dict()
        sim_id = telemetry_db.record_digital_twin_simulation({
            "component": sim.domain,
            "action": sim.action,
            "pid": sim.target_pid,
            "target_process": sim.target_process,
            "before_state": sim.current_state,
            "predicted_state": sim.predicted_state,
            "risk": sim.risk,
            "confidence": sim.confidence_percent,
            "prediction_basis": sim.explanation,
            "approved": 0,
            "executed": 0,
            "payload": sim_dict,
        })
        sim_dict["simulation_id"] = sim_id
        return jsonify({"success": True, "simulation": sim_dict})
    except RecoveryRequestError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400
    except ValueError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        logger.exception("Digital Twin simulate failed")
        return jsonify({"success": False, "message": str(exc)}), 500


@app.route("/digital_twin/execute", methods=["POST"])
def digital_twin_execute_endpoint():
    """RE-VERIFY + EXECUTE (requires human approval) + MEASURE ACTUAL + LEARN."""
    body = request.get_json(silent=True) or {}
    confirmation = body.get("confirmation") or {}
    simulation = body.get("simulation") or {}
    simulation_id = body.get("simulation_id")

    if not simulation:
        return jsonify({"success": False, "message": "'simulation' object is required"}), 400

    if simulation.get("requires_approval") and not confirmation.get("userAcknowledged"):
        return jsonify({"success": False, "message": "human approval (confirmation.userAcknowledged) is required"}), 400

    recovery_key = _map_digital_twin_simulation_to_recovery_key(simulation)
    if recovery_key is None:
        msg = simulation.get("explanation") or f"unsupported — cannot safely execute action '{simulation.get('action')}'"
        if simulation.get("action") == "throttle_recommendation":
            msg = "unsupported — cannot safely execute GPU throttle from this simulator"
        _record_digital_twin_outcome(simulation, approved=True, executed=False, result_message=msg,
                                     simulation_id=simulation_id)
        return jsonify({"success": False, "message": msg, "executable": False}), 409

    params: dict[str, Any] = {}
    if simulation.get("target_pid") is not None:
        params["pid"] = simulation["target_pid"]
    if simulation.get("target_name") and simulation.get("domain") == dt_engine.DOMAIN_NIC:
        params["interface"] = simulation["target_name"]

    try:
        before_state = dt_engine.collect_current_state(sample_interval=0.3).summary_dict()
        exec_result = run_recovery_action(recovery_key, params, body.get("fault"), confirmation)
        time.sleep(_DIGITAL_TWIN_SETTLE_SECONDS)
        after_state = dt_engine.collect_current_state(sample_interval=0.3).summary_dict()

        predicted = simulation.get("predicted_state") or {}
        dt_learning.record_prediction(
            action=simulation.get("action") or recovery_key,
            domain=simulation.get("domain") or "process",
            predicted_metrics=predicted,
            actual_metrics=after_state,
            pid=simulation.get("target_pid"),
            process_name=simulation.get("target_process"),
            notes=f"recovery_key={recovery_key}",
        )

        outcome_id = _record_digital_twin_outcome(
            simulation,
            approved=True,
            executed=bool(exec_result.get("success")),
            actual_state=after_state,
            result_message=exec_result.get("message", ""),
            simulation_id=simulation_id,
        )

        signed_error = dt_engine.compare_prediction_vs_actual(predicted, after_state)
        return jsonify({
            "success": bool(exec_result.get("success")),
            "recovery_key": recovery_key,
            "execution": exec_result,
            "before_state": before_state,
            "after_state": after_state,
            "predicted_state": predicted,
            "signed_error": signed_error,
            "simulation_id": outcome_id,
        }), 200 if exec_result.get("success") else 409
    except RecoveryRequestError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        logger.exception("Digital Twin execute failed")
        return jsonify({"success": False, "message": str(exc)}), 500


@app.route("/digital_twin/pipeline")
def digital_twin_pipeline_endpoint():
    """End-to-end read-only pipeline: measure -> detect -> candidates -> rank."""
    top_n = request.args.get("top_n", default=5, type=int)
    top_n = max(1, min(top_n, 20))
    try:
        payload = dt_engine.run_digital_twin_pipeline(
            top_n_processes=top_n,
            nic_attributed_pids=_nic_attributed_pids_from_cm(),
        )
        return jsonify({"success": True, **payload})
    except Exception as exc:  # noqa: BLE001
        logger.exception("Digital Twin pipeline failed")
        return jsonify({"success": False, "message": str(exc)}), 500


# ============================================================================
# Recovery APIs
# ============================================================================
# GET  /recovery/capabilities  -- which recovery actions are supported here
# POST /recovery/execute       -- run one whitelisted action
# GET  /recovery/history       -- recent recovery attempts (audit log)
#
# The frontend only ever sends an action KEY + params over these routes.
# The actual command that runs for each key is fixed in RECOVERY_ACTIONS
# above (Recovery Action Registry) -- nothing here accepts or executes a
# command string from the request.

@app.route("/recovery/capabilities")
def recovery_capabilities_endpoint():
    return jsonify(build_recovery_capabilities_report())


@app.route("/recovery/process_candidates")
def recovery_process_candidates_endpoint():
    """All processes above a usage threshold, descending, each flagged
    recoverable/not -- lets the frontend show every meaningful consumer
    (e.g. all 12 stress-ng workers, or all 8 parallel iperf3 -P streams)
    instead of just the single biggest one, so the user can pick which to
    pause/kill and which to leave.

        GET /recovery/process_candidates?domain=cpu&min_percent=1&limit=50
        GET /recovery/process_candidates?domain=nic&min_percent=50&limit=50
    """
    domain = request.args.get("domain", default="cpu")
    if domain not in ("cpu", "gpu", "disk", "nic"):
        return jsonify({"success": False, "message": "domain must be 'cpu', 'gpu', 'disk', or 'nic'"}), 400

    min_percent = request.args.get("min_percent", default=1.0, type=float)
    limit = request.args.get("limit", default=50, type=int)
    limit = max(1, min(limit, 200))

    candidates = get_recovery_process_candidates(domain=domain, min_percent=min_percent, limit=limit)
    return jsonify({"domain": domain, "min_percent": min_percent, "count": len(candidates), "candidates": candidates})


@app.route("/recovery/execute", methods=["POST"])
def recovery_execute_endpoint():
    body = request.get_json(silent=True) or {}

    action_key = body.get("action")
    if not action_key or not isinstance(action_key, str):
        return jsonify({"success": False, "message": "'action' is required"}), 400

    params = body.get("params") or {}
    fault = body.get("fault")
    confirmation = body.get("confirmation") or {}

    try:
        result = run_recovery_action(action_key, params, fault, confirmation)
    except RecoveryRequestError as exc:
        return jsonify({"success": False, "message": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001 - never let a bad action crash Flask
        logging.exception("Unhandled error executing recovery action %s", action_key)
        return jsonify({"success": False, "message": f"internal error: {exc}"}), 500

    status = 200 if result.get("success") else 409
    return jsonify(result), status

@app.route("/recovery/nic/auto_heal", methods=["POST"])
def recovery_nic_auto_heal_endpoint():
    body = request.get_json(silent=True) or {}
    iface = body.get("interface")

    try:
        result = evaluate_and_heal_nic(
            iface=iface,
            confirmation=body.get("confirmation"),
            fault=body.get("fault"),
        )
    except Exception as exc:
        logging.exception("Unhandled error in evaluate_and_heal_nic")
        return jsonify({"success": False, "result": "failed", "message": f"internal error: {exc}"}), 500

    result["success"] = result.get("result") == "success"
    status = 200 if result.get("result") == "success" else (
        409 if result.get("result") == "escalated" else 400
    )
    return jsonify(result), status

@app.route("/recovery/history")
def recovery_history_endpoint():
    limit = request.args.get("limit", default=100, type=int)
    limit = max(1, min(limit, 500))
    return jsonify({"history": get_recovery_history(limit=limit)})


@app.route("/db/telemetry_history")
def db_telemetry_history_endpoint():
    """Historical telemetry from SQLite.

    Query params:
      start, end  — Unix epoch seconds/ms or ISO-8601 UTC
      range       — 1h | 6h | 24h | 7d | 30d  (used when start omitted)
      limit       — max rows (default 5000)
    """
    start = request.args.get("start")
    end = request.args.get("end")
    range_key = request.args.get("range")
    limit = request.args.get("limit", default=5000, type=int)
    try:
        samples = telemetry_db.query_telemetry_history(
            start=start, end=end, range_key=range_key, limit=limit
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to query telemetry history from database")
        return jsonify({"error": str(exc), "samples": [], "count": 0}), 500
    return jsonify({"samples": samples, "count": len(samples)})


@app.route("/db/fault_history")
def db_fault_history_endpoint():
    start = request.args.get("start")
    end = request.args.get("end")
    range_key = request.args.get("range")
    limit = request.args.get("limit", default=5000, type=int)
    try:
        faults = telemetry_db.query_fault_history(
            start=start, end=end, range_key=range_key, limit=limit
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to query fault history from database")
        return jsonify({"error": str(exc), "faults": [], "count": 0}), 500
    return jsonify({"faults": faults, "count": len(faults)})


@app.route("/db/recovery_history_full")
def db_recovery_history_full_endpoint():
    start = request.args.get("start")
    end = request.args.get("end")
    range_key = request.args.get("range")
    limit = request.args.get("limit", default=10000, type=int)
    try:
        history = telemetry_db.query_recovery_history_full(
            start=start, end=end, range_key=range_key, limit=limit
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to query full recovery history from database")
        return jsonify({"error": str(exc), "history": [], "count": 0}), 500
    return jsonify({"history": history, "count": len(history)})


@app.route("/db/digital_twin_history")
def db_digital_twin_history_endpoint():
    start = request.args.get("start")
    end = request.args.get("end")
    range_key = request.args.get("range")
    limit = request.args.get("limit", default=5000, type=int)
    try:
        history = telemetry_db.get_digital_twin_history(
            start=start, end=end, range_key=range_key, limit=limit
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to query digital twin history from database")
        return jsonify({"error": str(exc), "history": [], "count": 0}), 500
    return jsonify({"history": history, "count": len(history)})


@app.route("/db/utility_history")
def db_utility_history_endpoint():
    start = request.args.get("start")
    end = request.args.get("end")
    range_key = request.args.get("range")
    utility_id = request.args.get("utility_id")
    limit = request.args.get("limit", default=5000, type=int)
    try:
        history = telemetry_db.query_utility_history(
            start=start,
            end=end,
            range_key=range_key,
            utility_id=utility_id,
            limit=limit,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to query utility history from database")
        return jsonify({"error": str(exc), "history": [], "count": 0}), 500
    return jsonify({"history": history, "count": len(history)})


@app.route("/db/stats")
def db_stats_endpoint():
    try:
        return jsonify(telemetry_db.get_database_stats())
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to read telemetry database stats")
        return jsonify({"error": str(exc)}), 500


@app.route("/reports/data")
def reports_data_endpoint():
    """Report Generation data from SQLite (not browser sessionStorage).

    Query params:
      start, end  — Unix epoch seconds/ms or ISO-8601 UTC
      range       — 1h | 6h | 24h | 7d | 30d
      aggregate   — 1/true (default) to downsample for the UI; 0 for raw samples
      limit       — max raw samples scanned before aggregation
    """
    start = request.args.get("start")
    end = request.args.get("end")
    range_key = request.args.get("range")
    aggregate_raw = str(request.args.get("aggregate", "1")).lower()
    aggregate = aggregate_raw not in ("0", "false", "no")
    limit = request.args.get("limit", default=20000, type=int)
    try:
        data = telemetry_db.query_report_data(
            start=start,
            end=end,
            range_key=range_key,
            aggregate=aggregate,
            limit=limit,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to build report data from telemetry database")
        return jsonify({"error": str(exc)}), 500
    return jsonify(data)


# --------------------------------------------------------------------------
# DEMO fault-injection control (manual)
# --------------------------------------------------------------------------
# component: ram | disk | nic | io_controller
# severity:  healthy | warning | critical
#
#   curl -X POST http://<server>:5000/demo/disk/critical
#   curl -X POST http://<server>:5000/demo/reset
#   curl http://<server>:5000/demo/state
#
# Values ramp gradually toward the target severity over
# RAMP_SECONDS (60s by default) rather than jumping
# instantly -- see the DEMO section near the top of this file.
#
# Tip for exercising the new NIC self-healing path end-to-end: generate
# real NIC load with iperf3 (any traffic generator works the same way,
# since get_top_nic_processes() ranks by observed bandwidth, not by tool
# name) --
#     iperf3 -s                                   # on the target host
#     iperf3 -c <linux-ip> -P 8 -t 300             # from a client
# -- then either let `pkill -f iperf3` clean it up manually, or drive it
# through the API instead: GET /recovery/process_candidates?domain=nic
# to find the iperf3 PID(s), then POST /recovery/execute with
# {"action": "nic.pause_process"|"nic.terminate_process"|"nic.kill_process",
#  "params": {"pid": <pid>}, "confirmation": {"userAcknowledged": true,
#  "level": 2 or 3}}.

@app.route("/demo/state")
def demo_state():
    return jsonify(get_state())


@app.route("/demo/reset", methods=["GET", "POST"])
def demo_reset():
    reset_all()
    return jsonify(get_state())


@app.route("/demo/<component>/<severity>", methods=["GET", "POST"])
def demo_set(component, severity):
    ok, message = set_severity(component, severity)
    if not ok:
        return jsonify({"error": message}), 400
    return jsonify(get_state())


# ===========================
# IO CONTROLLER
# ===========================
# Standalone, self-contained I/O controller for per-process disk I/O
# monitoring and recovery, built independently of the existing CPU / GPU /
# RAM / Disk / NIC controllers and the RECOVERY_ACTIONS registry above.
#
# Nothing in this section is wired into the main recovery workflow -- it
# has its own routes so it can be exercised and tested completely on its
# own. It reuses a few existing GENERIC safety/signal helpers purely by
# CALLING them (validate_pid, validate_confirmation, _recovery_signal) --
# none of those functions, or anything else above this marker, is modified.
#
# Not integrated into RECOVERY_ACTIONS / execute_recovery_action /
# run_recovery_action / recovery history on purpose, per requirements.

import psutil  # noqa: E402  -- imported here to keep this section self-contained

_IO_MIN_MB_PER_SEC = 0.05          # candidates below this combined rate are noise, not real I/O
_IO_SAMPLE_INTERVAL_SECONDS = 1.0  # ~1 second between the two io_counters() samples


def _io_sample_all_process_counters() -> dict[int, tuple[int, int, Optional[str], Optional[str]]]:
    """One pass over every running process: pid -> (read_bytes, write_bytes,
    name, username). Processes that terminate mid-scan or deny access to
    io_counters() (permissions, zombie, etc.) are simply skipped, per spec."""
    snapshot: dict[int, tuple[int, int, Optional[str], Optional[str]]] = {}
    for proc in psutil.process_iter(attrs=["pid", "name", "username"]):
        try:
            io = proc.io_counters()
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
        except Exception:
            # psutil can raise platform-specific errors (e.g. unsupported
            # counters on some kernels) -- never let one bad process abort
            # the whole scan.
            continue
        snapshot[proc.pid] = (
            io.read_bytes,
            io.write_bytes,
            proc.info.get("name"),
            proc.info.get("username"),
        )
    return snapshot


@safe_collect("io_process_candidates", fallback=[])
def get_io_process_candidates(
    min_mb_per_sec: float = _IO_MIN_MB_PER_SEC, limit: int = 50
) -> list[dict[str, Any]]:
    """Sample every process's io_counters() twice ~1 second apart and derive
    live read/write/total MB/s per process, sorted highest total first.

    Any process present in the first sample but gone (or access-denied) by
    the second sample is dropped rather than reported with a stale rate.
    """
    first = _io_sample_all_process_counters()
    time.sleep(_IO_SAMPLE_INTERVAL_SECONDS)
    second = _io_sample_all_process_counters()

    candidates: list[dict[str, Any]] = []
    for pid, (rb2, wb2, name, username) in second.items():
        prev = first.get(pid)
        if prev is None:
            continue
        rb1, wb1, _, _ = prev

        d_read = max(rb2 - rb1, 0)
        d_write = max(wb2 - wb1, 0)

        read_mb_per_sec = round((d_read / (1024 ** 2)) / _IO_SAMPLE_INTERVAL_SECONDS, 3)
        write_mb_per_sec = round((d_write / (1024 ** 2)) / _IO_SAMPLE_INTERVAL_SECONDS, 3)
        total_mb_per_sec = round(read_mb_per_sec + write_mb_per_sec, 3)

        if total_mb_per_sec < min_mb_per_sec:
            continue

        recoverable, _reason, _ = validate_pid(pid)

        candidates.append({
            "pid": pid,
            "process": name,
            "user": username,
            "read_MB_per_sec": read_mb_per_sec,
            "write_MB_per_sec": write_mb_per_sec,
            "total_MB_per_sec": total_mb_per_sec,
            "recoverable": recoverable,
        })

    candidates.sort(key=lambda c: c.get("total_MB_per_sec") or 0.0, reverse=True)
    return candidates[:limit]


# ---- IO recovery handlers ---------------------------------------------------
# Deliberately NOT added to RECOVERY_ACTIONS -- these are only reachable via
# the standalone /recovery/io/* routes below, per the "do not integrate yet"
# requirement. Each one reuses _recovery_signal() (defined above, untouched)
# for the actual kill(1)-based signal + /proc verification.

def _io_pause_process(pid: int) -> dict[str, Any]:
    res= _recovery_signal(pid, signal.SIGSTOP, verify_stopped=True)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"Process {pid} paused (SIGSTOP) -- {res['verification']}."
        if res["success"] else (res.get("verification") or res.get("stderr") or "pause failed")
    )
    return res


def _io_resume_process(pid: int) -> dict[str, Any]:
    res = _recovery_signal(pid, signal.SIGCONT, verify_stopped=False)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"Process {pid} resumed (SIGCONT) -- {res['verification']}."
        if res["success"] else (res.get("verification") or res.get("stderr") or "resume failed")
    )
    return res


def _io_terminate_process(pid: int) -> dict[str, Any]:
    res = _recovery_signal(pid, signal.SIGTERM, verify_gone=True)
    res["success"] = res["success"] and res["verified"]
    res["message"] = (
        f"Process {pid} terminated (SIGTERM) -- {res['verification']}."
        if res["success"] else (res.get("verification") or res.get("stderr") or "terminate failed")
    )
    return res


# Confirmation levels mirror the existing pause=2 / resume=1 / terminate=3
# convention used by RECOVERY_ACTIONS above (see "Confirmation levels" note
# near that registry), reusing validate_confirmation() as-is.
_IO_ACTION_LEVELS = {"pause": 2, "resume": 1, "terminate": 3}
_IO_ACTION_HANDLERS = {
    "pause": _io_pause_process,
    "resume": _io_resume_process,
    "terminate": _io_terminate_process,
}


def _io_handle_recovery_request(action: str):
    """Shared body for the three /recovery/io/<action> POST routes below.
    Expects JSON: {"pid": <pid>, "confirmation": {"userAcknowledged": true,
    "level": <int>}}. Reuses validate_pid() and validate_confirmation() from
    the existing Recovery Validation section as-is (calls only, no edits)."""
    body = request.get_json(silent=True) or {}

    ok, reason, pid = validate_pid(body.get("pid"))
    if not ok:
        return jsonify({"success": False, "message": reason}), 400

    confirmation = body.get("confirmation") or {}
    ok, reason = validate_confirmation(confirmation, _IO_ACTION_LEVELS[action])
    if not ok:
        return jsonify({"success": False, "message": reason}), 400

    result = _IO_ACTION_HANDLERS[action](pid)
    status = 200 if result.get("success") else 409
    return jsonify(result), status


# ---- IO controller routes (all under /recovery/io/*, fully isolated) -------

@app.route("/recovery/io/process_candidates")
def io_process_candidates_endpoint():
    """
        GET /recovery/io/process_candidates?min_mb_per_sec=0.05&limit=50

    Returns every process whose combined read+write throughput over the
    last ~1 second is at or above min_mb_per_sec, sorted by total_MB_per_sec
    descending -- e.g. a `dd ... oflag=direct` run shows up here while it's
    actively writing.
    """
    min_mb = request.args.get("min_mb_per_sec", default=_IO_MIN_MB_PER_SEC, type=float)
    limit = request.args.get("limit", default=50, type=int)
    limit = max(1, min(limit, 200))
    candidates = get_io_process_candidates(min_mb_per_sec=min_mb, limit=limit)
    return jsonify({"count": len(candidates), "candidates": candidates})


@app.route("/recovery/io/pause", methods=["POST"])
def io_pause_endpoint():
    """POST /recovery/io/pause  body: {"pid": <pid>, "confirmation": {"userAcknowledged": true, "level": 2}}"""
    return _io_handle_recovery_request("pause")


@app.route("/recovery/io/resume", methods=["POST"])
def io_resume_endpoint():
    """POST /recovery/io/resume  body: {"pid": <pid>, "confirmation": {"userAcknowledged": true, "level": 1}}"""
    return _io_handle_recovery_request("resume")


@app.route("/recovery/io/terminate", methods=["POST"])
def io_terminate_endpoint():
    """POST /recovery/io/terminate  body: {"pid": <pid>, "confirmation": {"userAcknowledged": true, "level": 3}}"""
    return _io_handle_recovery_request("terminate")


def main() -> None:
    global LATEST_INVENTORY, LATEST_METRICS, LATEST_LINK_HEALTH

    # --- DEMO: apply startup fault severities BEFORE the first collection,
    # so the very first /inventory, /metrics, /link_health response already
    # reflects them. No separate API call needed during the demo itself. ---
    parser = argparse.ArgumentParser(description="Hardware monitoring agent")
    parser.add_argument("--ram", choices=VALID_SEVERITIES, default="healthy")
    parser.add_argument("--disk", choices=VALID_SEVERITIES, default="healthy")
    parser.add_argument("--nic", choices=VALID_SEVERITIES, default="healthy")
    parser.add_argument("--io-controller", choices=VALID_SEVERITIES, default="healthy")
    args = parser.parse_args()

    for component, severity in [
        ("ram", args.ram),
        ("disk", args.disk),
        ("nic", args.nic),
        ("io_controller", args.io_controller),
    ]:
        set_severity(component, severity)
        if severity != "healthy":
            logger.info("DEMO: %s starting in '%s' state", component, severity)

    try:
        telemetry_db.init_db()
        logger.info("Telemetry history database: %s", telemetry_db.TELEMETRY_DB_PATH)
    except Exception:
        logger.exception("Telemetry database initialization failed; continuing without DB persistence")

    logger.info("Performing initial collection...")
    try:
        LATEST_INVENTORY = collect_inventory()
        LATEST_METRICS = collect_metrics()
        LATEST_LINK_HEALTH = collect_link_health()
    except Exception:
        logger.exception("Initial collection failed; continuing with empty cache")
        LATEST_INVENTORY = {}
        LATEST_METRICS = {}
        LATEST_LINK_HEALTH = {}

    # Persist the first sample so telemetry_history.db is non-empty after startup,
    # without waiting for the first updater_loop tick.
    try:
        if LATEST_METRICS:
            telemetry_db.persist_poll_cycle(
                LATEST_METRICS, LATEST_INVENTORY, LATEST_LINK_HEALTH
            )
    except Exception:
        logger.exception("Failed to persist initial telemetry sample to database")

    thread = threading.Thread(target=updater_loop, daemon=True)
    thread.start()

    logger.info("Server starting on http://0.0.0.0:5000")
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()


