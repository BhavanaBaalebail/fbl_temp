# ////#!/usr/bin/env python3
# """
# collect_metrics_final.py
# =========================

# Production-ready Ubuntu hardware monitoring agent.

# Continuously collects hardware inventory, live performance metrics, and
# interconnect/link health data from a Linux (Ubuntu) host and exposes them
# through a small Flask REST API consumed by a vanilla HTML/CSS/JS dashboard.

# This build adds an INTERNAL FUNCTIONAL BLOCK LEDGER on top of the existing
# component health engine: every named functional block in the hardware
# architecture (CPU, RAM, GPU, IO Controller, MGMT, NIC, PSU, Disk) is mapped
# to the real Linux/Ubuntu command(s) that inspect it, and the raw diagnostic
# text is captured every collection cycle alongside the quantitative counters
# (AER errors, ECC counts, SMART fields, GPU XID/ECC, etc).

# Design note on scope: the ledger is ADDITIVE, not a replacement for the
# counter-based health engine. The block-mapped commands (lspci -vv | grep ...,
# sensors, i2cdetect, etc.) return free-form text, not structured counters, so
# they cannot reliably drive Critical/Warning scoring on their own -- doing so
# would trade a validated, counter-based health engine for a noisy grep-based
# one and would be a regression, not an upgrade. Instead the ledger is
# attached as its own top-level section (with a conservative "ok"/"warning"/
# "unavailable"/"not_queryable" per-block status) and its own list of
# diagnostic_notes in the health summary, while the existing PCIe AER / ECC /
# SMART / GPU XID engine remains authoritative for overall_health and score.

# Trial2 changes (additive only -- nothing from Trial1 was removed):
#   * New top-level collectors: get_chassis_inventory() (DMI type 3 --
#     chassis type/asset tag/boot-up state/power state/thermal state/
#     security status), get_voltage_probes() (DMI type 26 -- SMBIOS-reported
#     voltage rail probes, a real motherboard-level source for Vcore/12V/5V/
#     3.3V that doesn't depend on a Super-I/O hwmon driver being bound),
#     get_cooling_devices() (DMI type 27 -- SMBIOS fan/cooling device probes
#     incl. nominal speed when the board reports it), get_battery_health()
#     and get_power_supply_status() (/sys/class/power_supply -- battery/AC
#     status, harmless no-op on desktops with no battery).
#   * get_hwmon_health() extended (additively) to also capture fan*_input
#     RPM readings per chip, alongside the existing temperature/voltage
#     readings.
#   * BLOCK_REGISTRY: existing blocks that were previously "no_data" on
#     boards without a bound Super-I/O sensor chip (CPU Vcore VRM, EPS 12V,
#     ATX12V, Standby 5VSB, eSPI Bus) now also try the DMI voltage-probe /
#     hwmon-sysfs / journalctl fallbacks above, and new blocks (Voltage
#     Probes (DMI), Cooling Device (DMI), Chassis State) were added under
#     PSU/MGMT so the SMBIOS-level data has a ledger entry too.
#   * New report keys in collect_link_health(): "chassis", "voltage_probes",
#     "cooling_devices", "battery", "power_supply".
#   * compute_health_summary() gained light, conservative checks for chassis
#     thermal/power-supply state and low battery, surfaced as
#     warnings/informational the same way the rest of the engine already
#     works -- never overriding the existing counter-based verdicts.

# Trial3 changes (additive only -- nothing from Trial1/Trial2 was removed):
#   * BLOCK_REGISTRY entries for blocks that were flagged "present but no
#     telemetry" or "pending" in the Trial2 coverage audit (CPU Vcore VRM,
#     EPS 12V, ATX12V, eSPI Bus, NVMe Command Queue, GPU 12VHPWR Power,
#     GPU PCIe DMA, SAS Controller, PMBus / PMBus Alerts, Dedicated IPMI
#     Port, PCIe Slot, BMC Shared NIC, Standby 5VSB) each gained one or more
#     EXTRA diagnostic commands appended to their existing command list, to
#     squeeze out additional real telemetry or a cleaner absence signal
#     where the underlying hardware genuinely doesn't expose more. No
#     existing tuple in any block's command list was removed or reordered;
#     all additions are appended at the end of each block's list so prior
#     output keys/order are preserved.

# Run:
#     pip install -r requirements.txt
#     python3 collect_metrics2_Trial2.py

# Then open:
#     http://localhost:5000
# """

#  from __future__ import annotations

# import argparse
# import json
# import logging
# import os
# import platform
# import re
# import shutil
# import signal
# import socket
# import subprocess
# import threading
# import time
# from datetime import datetime, timezone
# from pathlib import Path
# from typing import Any, Callable, Optional

# from flask import Flask, jsonify, request
# from flask_cors import CORS


# # --------------------------------------------------------------------------
# # Configuration & Logging
# # --------------------------------------------------------------------------

# INVENTORY_FILE = "inventory.json"

# DEFAULT_TIMEOUT = 10
# LONG_TIMEOUT = 30
# MAX_KERNEL_EVENTS_PER_CATEGORY = 25

# PCI_DEVICES_PATH = Path("/sys/bus/pci/devices")
# IOMMU_GROUPS_PATH = Path("/sys/kernel/iommu_groups")
# ATA_LINK_CLASS_PATH = Path("/sys/class/ata_link")
# ATA_PORT_CLASS_PATH = Path("/sys/class/ata_port")
# USB_DEVICES_PATH = Path("/sys/bus/usb/devices")
# NVME_CLASS_PATH = Path("/sys/class/nvme")
# NET_CLASS_PATH = Path("/sys/class/net")
# EDAC_MC_PATH = Path("/sys/devices/system/edac/mc")
# POWERCAP_PATH = Path("/sys/class/powercap")
# THERMAL_CLASS_PATH = Path("/sys/class/thermal")
# HWMON_CLASS_PATH = Path("/sys/class/hwmon")
# CPUFREQ_PATH = Path("/sys/devices/system/cpu")
# EFI_PATH = Path("/sys/firmware/efi")
# POWER_SUPPLY_CLASS_PATH = Path("/sys/class/power_supply")

# _AER_FILES = ["aer_dev_correctable", "aer_dev_nonfatal", "aer_dev_fatal"]

# INSTALL_HINT = (
#     "sudo apt install dmidecode lm-sensors ipmitool smartmontools nvme-cli "
#     "lsscsi ethtool pciutils i2c-tools rdma-core tpm2-tools lshw hdparm fwupd "
#     "msr-tools"
# )

# logging.basicConfig(
#     level=logging.INFO,
#     format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
# )
# logger = logging.getLogger("hardware-monitor")

# # Global cache, guarded by a lock since the background thread writes
# # to it while Flask request threads read from it.
# _state_lock = threading.Lock()
# LATEST_INVENTORY: dict[str, Any] = {}
# LATEST_METRICS: dict[str, Any] = {}
# LATEST_LINK_HEALTH: dict[str, Any] = {}

# # Per-collection-cycle command cache so repeated identical subprocess calls
# # within a single collect_* pass (e.g. multiple callers needing `lscpu` or
# # `lspci -vv`) are only shelled out once. Cleared at the start of every
# # updater_loop() tick (see below) so live metrics/link-health data never
# # goes stale between cycles.
# _CMD_CACHE: dict[tuple, str] = {}


# # ============================================================================
# # DEMO: MANUAL SYNTHETIC FAULT INJECTION (RAM / DISK / NIC / IO Controller)
# # ----------------------------------------------------------------------------
# # Inlined from fault_injector.py so the whole thing runs as ONE file/process.
# # Severity is set manually via the /demo/<component>/<severity> routes near
# # the bottom of this file. Values ramp toward the target over RAMP_SECONDS
# # rather than jumping instantly. CPU/GPU are never touched -- drive those
# # with real load. Injection only ever writes to fields that already exist
# # in the JSON schema; no keys are added or removed.
# # ============================================================================


# VALID_COMPONENTS = ("ram", "disk", "nic", "io_controller")
# VALID_SEVERITIES = ("healthy", "warning", "critical")

# RAMP_SECONDS = 60.0  # time to go from healthy baseline to full target severity

# # --------------------------------------------------------------------------
# # State
# # --------------------------------------------------------------------------

# _state: dict[str, dict[str, Any]] = {
#     c: {"severity": "healthy", "since": time.time()} for c in VALID_COMPONENTS
# }


# def set_severity(component: str, severity: str) -> tuple[bool, str]:
#     component = (component or "").lower()
#     severity = (severity or "").lower()
#     if component not in VALID_COMPONENTS:
#         return False, f"unknown component '{component}', expected one of {VALID_COMPONENTS}"
#     if severity not in VALID_SEVERITIES:
#         return False, f"unknown severity '{severity}', expected one of {VALID_SEVERITIES}"
#     if _state[component]["severity"] != severity:
#         _state[component] = {"severity": severity, "since": time.time()}
#     return True, "ok"


# def get_state() -> dict[str, Any]:
#     now = time.time()
#     return {
#         c: {
#             "severity": s["severity"],
#             "elapsed_seconds": round(now - s["since"], 1),
#             "ramp_progress": round(min((now - s["since"]) / RAMP_SECONDS, 1.0), 2),
#         }
#         for c, s in _state.items()
#     }


# def reset_all() -> None:
#     now = time.time()
#     for c in VALID_COMPONENTS:
#         _state[c] = {"severity": "healthy", "since": now}


# def _progress(component: str) -> float:
#     """0.0 (just switched) -> 1.0 (fully ramped in) for the given component."""
#     s = _state[component]
#     if s["severity"] == "healthy":
#         return 0.0
#     return min((time.time() - s["since"]) / RAMP_SECONDS, 1.0)


# def _lerp(lo: float, hi: float, t: float) -> float:
#     return lo + (hi - lo) * t


# def _lerp_int(lo: int, hi: int, t: float) -> int:
#     return int(round(_lerp(lo, hi, t)))


# # --------------------------------------------------------------------------
# # RAM
# # --------------------------------------------------------------------------

# def _inject_ram(report: dict[str, Any]) -> None:
#     severity = _state["ram"]["severity"]
#     t = _progress("ram")
#     mem_health = ((report.get("memory") or {}).get("health")) or {}
#     controllers = mem_health.get("controllers") or []
#     if not controllers:
#         return

#     if severity == "healthy":
#         return

#     if severity == "warning":
#         ce = _lerp_int(0, 50, t)
#         mem_health["correctable_errors"] = ce
#         mem_health["uncorrectable_errors"] = 0
#         mem_health["memory_controller_errors"] = 0
#         controllers[0]["correctable_errors"] = ce
#         controllers[0]["uncorrectable_errors"] = 0
#         controllers[0]["dimm_failures"] = (
#             [{"row": "csrow0", "correctable_errors": ce, "uncorrectable_errors": 0}] if ce > 0 else []
#         )

#     elif severity == "critical":
#         ce = 50
#         ue = _lerp_int(0, 3, t)
#         mem_health["correctable_errors"] = ce
#         mem_health["uncorrectable_errors"] = ue
#         mem_health["memory_controller_errors"] = ue
#         controllers[0]["correctable_errors"] = ce
#         controllers[0]["uncorrectable_errors"] = ue
#         controllers[0]["dimm_failures"] = [
#             {"row": "csrow0", "correctable_errors": ce, "uncorrectable_errors": ue}
#         ]


# def _inject_ram_metrics(metrics: dict[str, Any]) -> None:
#     severity = _state["ram"]["severity"]
#     t = _progress("ram")
#     mem = metrics.get("memory") or {}
#     if not mem or severity == "healthy":
#         return

#     total_gb = mem.get("total_gb") or 15.25
#     if severity == "warning":
#         usage_pct = _lerp(30.0, 88.0, t)
#         swap_pct = _lerp(0.0, 30.0, t)
#     else:  # critical
#         usage_pct = _lerp(30.0, 97.0, t)
#         swap_pct = _lerp(0.0, 75.0, t)

#     used_gb = round(total_gb * usage_pct / 100.0, 2)
#     mem["usage_percent"] = round(usage_pct, 2)
#     mem["used_gb"] = used_gb
#     mem["available_gb"] = round(max(total_gb - used_gb, 0.05), 2)
#     mem["free_gb"] = round(max(total_gb - used_gb - mem.get("cached_gb", 0) - mem.get("buffers_gb", 0), 0.02), 2)
#     swap_total = mem.get("swap_total_gb") or 4.0
#     mem["swap_usage_percent"] = round(swap_pct, 2)
#     mem["swap_used_gb"] = round(swap_total * swap_pct / 100.0, 2)
#     mem["swap_free_gb"] = round(max(swap_total - mem["swap_used_gb"], 0), 2)


# # --------------------------------------------------------------------------
# # DISK (NVMe)
# # --------------------------------------------------------------------------

# def _inject_disk(report: dict[str, Any]) -> None:
#     severity = _state["disk"]["severity"]
#     t = _progress("disk")
#     nvme_list = report.get("nvme") or []
#     if not nvme_list or severity == "healthy":
#         return

#     dev = nvme_list[0]

#     if severity == "warning":
#         dev["percentage_used"] = _lerp_int(50, 95, t)
#         dev["available_spare"] = _lerp_int(100, 25, t)
#         dev["temperature"] = _lerp_int(30, 78, t)
#         dev["warning_temp_time"] = _lerp_int(0, 300, t)
#         dev["num_err_log_entries"] = _lerp_int(0, 5, t)
#         dev["critical_warning"] = 0
#         dev["media_errors"] = 0
#         dev["smart_status_passed"] = True

#     elif severity == "critical":
#         dev["percentage_used"] = _lerp_int(95, 100, t)
#         dev["available_spare"] = _lerp_int(25, 6, t)
#         dev["temperature"] = _lerp_int(78, 85, t)
#         dev["warning_temp_time"] = 300
#         dev["critical_comp_time"] = _lerp_int(0, 10, t)
#         dev["num_err_log_entries"] = _lerp_int(5, 12, t)
#         dev["media_errors"] = _lerp_int(0, 3, t)
#         dev["critical_warning"] = 4 if t >= 1.0 else (1 if t >= 0.5 else 0)
#         dev["smart_status_passed"] = t < 0.7  # flips to False once well into Critical


# def _inject_disk_metrics(metrics: dict[str, Any]) -> None:
#     severity = _state["disk"]["severity"]
#     t = _progress("disk")
#     disk = metrics.get("disk") or {}
#     smart = ((disk.get("smart") or {}).get("nvme0n1")) or None
#     if not smart or severity == "healthy":
#         return

#     if severity == "warning":
#         smart["temperature_celsius"] = _lerp_int(30, 78, t)
#         smart["health"] = "PASSED"
#     elif severity == "critical":
#         smart["temperature_celsius"] = _lerp_int(78, 85, t)
#         smart["health"] = "FAILED" if t >= 0.7 else "PASSED"


# # --------------------------------------------------------------------------
# # NIC
# # --------------------------------------------------------------------------

# def _inject_nic(report: dict[str, Any]) -> None:
#     severity = _state["nic"]["severity"]
#     t = _progress("nic")
#     nic_list = report.get("nic") or []
#     primary = next((n for n in nic_list if n.get("interface") not in (None, "wlp3s0")), None)
#     if primary is None or severity == "healthy":
#         return

#     h = primary.setdefault("health", {})
#     if severity == "warning":
#         h["rx_crc_errors"] = _lerp_int(0, 200, t)
#         h["rx_errors"] = _lerp_int(0, 100, t)
#         h["rx_dropped"] = _lerp_int(0, 500, t)
#         h["tx_dropped"] = _lerp_int(0, 50, t)
#         h["tx_errors"] = _lerp_int(0, 40, t)
#         h["tx_carrier_errors"] = 0
#         h["collisions"] = 0

#     elif severity == "critical":
#         h["rx_crc_errors"] = _lerp_int(200, 2000, t)
#         h["rx_errors"] = _lerp_int(100, 1500, t)
#         h["rx_dropped"] = _lerp_int(500, 5000, t)
#         h["tx_dropped"] = _lerp_int(50, 800, t)
#         h["tx_errors"] = _lerp_int(40, 600, t)
#         h["tx_carrier_errors"] = _lerp_int(0, 5, t)
#         h["collisions"] = _lerp_int(0, 20, t)


# def _inject_nic_metrics(metrics: dict[str, Any]) -> None:
#     severity = _state["nic"]["severity"]
#     t = _progress("nic")
#     nic_list = metrics.get("nic") or []
#     primary = next((n for n in nic_list if n.get("name") not in (None, "wlp3s0")), None)
#     if primary is None or severity == "healthy":
#         return

#     if severity == "warning":
#         primary["rx_errors"] = _lerp_int(0, 100, t)
#         primary["rx_dropped"] = _lerp_int(0, 500, t)
#         primary["tx_dropped"] = _lerp_int(0, 50, t)
#         primary["tx_errors"] = _lerp_int(0, 40, t)
#         primary["duplex"] = "Full"
#         primary["speed"] = "100Mb/s" if t > 0.5 else primary.get("speed")
#         primary["link_state"] = "up"

#     elif severity == "critical":
#         primary["rx_errors"] = _lerp_int(100, 1500, t)
#         primary["rx_dropped"] = _lerp_int(500, 5000, t)
#         primary["tx_dropped"] = _lerp_int(50, 800, t)
#         primary["tx_errors"] = _lerp_int(40, 600, t)
#         primary["duplex"] = "Half"
#         primary["speed"] = "10Mb/s"
#         primary["link_state"] = "down" if t >= 0.85 else "up"


# # --------------------------------------------------------------------------
# # IO CONTROLLER (PCH / chipset)
# # --------------------------------------------------------------------------

# # Pick the onboard SATA controller as the device we degrade -- it's a real
# # chipset-owned device already present in every sample payload.
# _IO_TARGET_SLOT = "0000:00:17.0"


# def _inject_io_controller(report: dict[str, Any]) -> None:
#     severity = _state["io_controller"]["severity"]
#     t = _progress("io_controller")
#     pcie_list = report.get("pcie") or []
#     motherboard = report.get("motherboard") or {}
#     target = next((d for d in pcie_list if d.get("slot") == _IO_TARGET_SLOT), None)
#     if target is None or severity == "healthy":
#         return

#     aer = target.setdefault("aer", {})
#     health = target.setdefault("health", {})

#     if severity == "warning":
#         aer["total_errors"] = _lerp_int(0, 20, t)
#         health["status"] = "Warning" if aer["total_errors"] > 0 else "Healthy"
#         motherboard["acpi_errors"] = _lerp_int(0, 5, t)
#         motherboard["chipset_errors"] = _lerp_int(0, 5, t)
#         motherboard["thermal_zone_errors"] = _lerp_int(0, 3, t)
#         motherboard["power_faults"] = 0
#         motherboard["pcie_errors"] = {
#             "critical_links": 0,
#             "warning_links": 1 if aer["total_errors"] > 0 else 0,
#         }

#     elif severity == "critical":
#         aer["total_errors"] = _lerp_int(20, 80, t)
#         health["status"] = "Critical"
#         target["link_current_speed_gts"] = 2.5
#         target["link_speed_below_max"] = True
#         motherboard["acpi_errors"] = _lerp_int(5, 12, t)
#         motherboard["chipset_errors"] = _lerp_int(5, 15, t)
#         motherboard["thermal_zone_errors"] = _lerp_int(3, 7, t)
#         motherboard["power_faults"] = _lerp_int(0, 3, t)
#         motherboard["pcie_errors"] = {"critical_links": 1, "warning_links": 0}

#     report["motherboard"] = motherboard


# # --------------------------------------------------------------------------
# # Public entry points -- call these from collect_metrics4.py
# # --------------------------------------------------------------------------

# def inject_link_health(report: dict[str, Any]) -> dict[str, Any]:
#     """Mutate the link_health report IN PLACE. Must be called BEFORE
#     report["health_summary"] = compute_health_summary(report) so the
#     injected counters actually drive overall_health/score."""
#     _inject_ram(report)
#     _inject_disk(report)
#     _inject_nic(report)
#     _inject_io_controller(report)
#     return report


# def inject_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
#     """Mutate the /metrics snapshot IN PLACE so the live gauges agree with
#     whatever link_health is currently reporting."""
#     _inject_ram_metrics(metrics)
#     _inject_disk_metrics(metrics)
#     _inject_nic_metrics(metrics)
#     return metrics


# # --------------------------------------------------------------------------
# # Generic Helper Functions
# # --------------------------------------------------------------------------

# def is_root() -> bool:
#     try:
#         return os.geteuid() == 0
#     except AttributeError:
#         return False


# def command_exists(name: str) -> bool:
#     """Return True if a Linux utility is available on PATH."""
#     return shutil.which(name) is not None


# def run(cmd: list[str], timeout: int = DEFAULT_TIMEOUT, use_cache: bool = True) -> str:
#     """Safely execute a command and return its stdout.

#     Never raises. Returns an empty string on any failure (missing
#     binary, non-zero exit, timeout, permission error, etc). Results are
#     cached per exact argv within a single collection cycle so repeated
#     calls (e.g. `lspci -vv` needed by both the PCIe and NVMe collectors)
#     don't re-shell out; the cache is cleared every updater tick.
#     """
#     key = tuple(cmd)
#     if use_cache and key in _CMD_CACHE:
#         return _CMD_CACHE[key]

#     if not command_exists(cmd[0]):
#         if use_cache:
#             _CMD_CACHE[key] = ""
#         return ""

#     try:
#         result = subprocess.run(
#             cmd,
#             stdout=subprocess.PIPE,
#             stderr=subprocess.DEVNULL,
#             text=True,
#             timeout=timeout,
#             check=False,
#         )
#         out = result.stdout or ""
#     except Exception as exc:  # noqa: BLE001 - intentional broad catch
#         logger.debug("Command failed %s: %s", cmd, exc)
#         out = ""

#     if use_cache:
#         _CMD_CACHE[key] = out
#     return out


# def read_file(path) -> str:
#     """Read a file's full text content. Accepts a str or Path. Never raises."""
#     try:
#         return Path(path).read_text(encoding="utf-8", errors="ignore")
#     except Exception:
#         return ""


# def read_stripped(path) -> Optional[str]:
#     text = read_file(path)
#     return text.strip() if text.strip() else None


# def safe_int(value: Any, default: Optional[int] = None) -> Optional[int]:
#     try:
#         return int(str(value).strip().replace(",", ""))
#     except (TypeError, ValueError):
#         return default


# def safe_float(value: Any, default: Optional[float] = None) -> Optional[float]:
#     try:
#         return float(str(value).strip().replace(",", ""))
#     except (TypeError, ValueError):
#         return default


# def bytes_to_kb(n: Any) -> Optional[float]:
#     v = safe_float(n)
#     return round(v / 1024, 2) if v is not None else None


# def bytes_to_mb(n: Any) -> Optional[float]:
#     v = safe_float(n)
#     return round(v / (1024 ** 2), 2) if v is not None else None


# def bytes_to_gb(n: Any) -> Optional[float]:
#     v = safe_float(n)
#     return round(v / (1024 ** 3), 2) if v is not None else None


# def bytes_to_tb(n: Any) -> Optional[float]:
#     v = safe_float(n)
#     return round(v / (1024 ** 4), 2) if v is not None else None


# def get_value(pattern: str, text: str, flags: int = re.MULTILINE) -> Optional[str]:
#     """Regex helper: return the first capture group, or None."""
#     if not text:
#         return None
#     m = re.search(pattern, text, flags)
#     return m.group(1).strip() if m else None


# def parse_key_value(text: str, sep: str = ":") -> dict[str, str]:
#     """Parse simple 'Key: Value' formatted text into a dict."""
#     result: dict[str, str] = {}
#     if not text:
#         return result
#     for line in text.splitlines():
#         if sep in line:
#             key, _, value = line.partition(sep)
#             key = key.strip()
#             value = value.strip()
#             if key:
#                 result[key] = value
#     return result


# def resolve_driver(device_dir: Path) -> Optional[str]:
#     driver_link = device_dir / "driver"
#     try:
#         if driver_link.exists():
#             return os.path.basename(os.path.realpath(str(driver_link)))
#     except OSError:
#         pass
#     return None


# def null_if_empty(value: Any) -> Any:
#     if value in ("", None, "Unknown", "Not Specified", "To Be Filled By O.E.M."):
#         return None
#     return value


# def safe_collect(name: str, fallback: Any = None) -> Callable:
#     """Decorator: guarantees a collector NEVER raises. Logs and returns the
#     fallback value (default None) on any exception, matching the "never
#     crash, return null" requirement."""
#     def decorator(func: Callable) -> Callable:
#         def wrapper(*args, **kwargs):
#             try:
#                 return func(*args, **kwargs)
#             except Exception as exc:  # noqa: BLE001
#                 logger.warning("Collector '%s' failed safely: %s", name, exc)
#                 return fallback
#         wrapper.__name__ = func.__name__
#         return wrapper
#     return decorator


# def _is_empty(value: Any) -> bool:
#     """True for None, "", [], {} -- but NOT for 0, 0.0, or False."""
#     if value is None:
#         return True
#     if isinstance(value, (str, list, dict, tuple)) and len(value) == 0:
#         return True
#     return False


# def prune_json(data: Any) -> Any:
#     """
#     Recursively remove keys/list-items whose value is None, "", [], or {}.
#     Numbers (including 0) and booleans (including False) are always kept,
#     since a confirmed-zero error counter is a real health signal.
#     """
#     if isinstance(data, dict):
#         cleaned = {}
#         for key, value in data.items():
#             pruned_value = prune_json(value)
#             if not _is_empty(pruned_value):
#                 cleaned[key] = pruned_value
#         return cleaned
#     if isinstance(data, list):
#         cleaned_list = [prune_json(item) for item in data]
#         return [item for item in cleaned_list if not _is_empty(item)]
#     return data


# # --------------------------------------------------------------------------
# # 1. SYSTEM
# # --------------------------------------------------------------------------

# def get_system_inventory() -> dict[str, Any]:
#     dmi = parse_key_value(run(["sudo", "-n", "dmidecode", "-t", "system"]))

#     uname = run(["uname", "-a"]).strip()

#     return {
#         "hostname": socket.gethostname(),
#         "os": platform.system(),
#         "os_release": _get_os_pretty_name(),
#         "kernel": platform.release(),
#         "architecture": platform.machine(),
#         "platform": platform.platform(),
#         "uname": uname or None,
#         "manufacturer": null_if_empty(dmi.get("Manufacturer")),
#         "model": null_if_empty(dmi.get("Product Name")),
#         "serial_number": null_if_empty(dmi.get("Serial Number")),
#         "uuid": null_if_empty(dmi.get("UUID")),
#         "timezone": _get_timezone(),
#     }


# def _get_os_pretty_name() -> Optional[str]:
#     content = read_file("/etc/os-release")
#     kv = {}
#     for line in content.splitlines():
#         if "=" in line:
#             k, _, v = line.partition("=")
#             kv[k.strip()] = v.strip().strip('"')
#     return kv.get("PRETTY_NAME")


# def _get_timezone() -> Optional[str]:
#     out = run(["timedatectl"]) or read_file("/etc/timezone")
#     tz = get_value(r"Time zone:\s+(\S+)", out)
#     if tz:
#         return tz
#     return out.strip() or None


# def get_system_metrics() -> dict[str, Any]:
#     uptime_seconds = None
#     raw = read_file("/proc/uptime")
#     if raw:
#         uptime_seconds = safe_int(raw.split()[0])

#     return {
#         "uptime_seconds": uptime_seconds,
#         "current_time": datetime.now(timezone.utc).isoformat(),
#     }


# # --------------------------------------------------------------------------
# # 2. CPU
# # --------------------------------------------------------------------------

# def get_cpu_inventory() -> dict[str, Any]:
#     lscpu = run(["lscpu"])

#     instruction_sets = []
#     flags_line = get_value(r"^Flags:\s+(.*)$", lscpu)
#     if flags_line:
#         wanted = {"sse", "sse2", "sse4_1", "sse4_2", "avx", "avx2", "avx512f"}
#         instruction_sets = sorted(set(flags_line.split()) & wanted)

#     return {
#         "vendor": get_value(r"Vendor ID:\s+(.*)", lscpu),
#         "model": get_value(r"Model name:\s+(.*)", lscpu),
#         "architecture": get_value(r"Architecture:\s+(.*)", lscpu),
#         "sockets": safe_int(get_value(r"Socket\(s\):\s+(.*)", lscpu)),
#         "physical_cores": safe_int(get_value(r"Core\(s\) per socket:\s+(.*)", lscpu)),
#         "logical_processors": safe_int(get_value(r"^CPU\(s\):\s+(.*)$", lscpu)),
#         "threads_per_core": safe_int(get_value(r"Thread\(s\) per core:\s+(.*)", lscpu)),
#         "numa_nodes": safe_int(get_value(r"NUMA node\(s\):\s+(.*)", lscpu)),
#         "max_mhz": safe_float(get_value(r"CPU max MHz:\s+(.*)", lscpu)),
#         "min_mhz": safe_float(get_value(r"CPU min MHz:\s+(.*)", lscpu)),
#         "cache_l1d": get_value(r"L1d cache:\s+(.*)", lscpu),
#         "cache_l1i": get_value(r"L1i cache:\s+(.*)", lscpu),
#         "cache_l2": get_value(r"L2 cache:\s+(.*)", lscpu),
#         "cache_l3": get_value(r"L3 cache:\s+(.*)", lscpu),
#         "virtualization": get_value(r"Virtualization:\s+(.*)", lscpu),
#         "instruction_sets": instruction_sets,
#     }


# def _get_cpu_temperature() -> Optional[float]:
#     if not command_exists("sensors"):
#         return None
#     out = run(["sensors", "-A"])
#     for pattern in (r"Package id 0:\s*\+?(-?\d+\.\d+)", r"Tctl:\s*\+?(-?\d+\.\d+)", r"Core 0:\s*\+?(-?\d+\.\d+)"):
#         val = get_value(pattern, out)
#         if val:
#             return safe_float(val)
#     return None


# def _get_cpu_current_mhz() -> Optional[float]:
#     out = run(["lscpu"])
#     val = get_value(r"CPU MHz:\s+(.*)", out)
#     if val:
#         return safe_float(val)
#     return None


# def get_cpu_metrics() -> dict[str, Any]:
#     user = system = idle = iowait = None

#     if command_exists("mpstat"):
#         mpstat = run(["mpstat", "1", "1"])
#         for line in mpstat.splitlines():
#             if line.strip().startswith("Average:") and "%idle" not in line:
#                 parts = line.split()
#                 if len(parts) >= 12:
#                     user = safe_float(parts[2])
#                     system = safe_float(parts[4])
#                     iowait = safe_float(parts[5])
#                     idle = safe_float(parts[-1])

#     if idle is None:
#         # Fallback via /proc/stat sampling
#         idle, user, system = _cpu_from_proc_stat()

#     usage_percent = None
#     if idle is not None:
#         usage_percent = round(100 - idle, 2)

#     load_average = None
#     loadavg_raw = read_file("/proc/loadavg")
#     if loadavg_raw:
#         parts = loadavg_raw.split()
#         if len(parts) >= 3:
#             load_average = {
#                 "1min": safe_float(parts[0]),
#                 "5min": safe_float(parts[1]),
#                 "15min": safe_float(parts[2]),
#             }

#     interrupts = None
#     stat_raw = read_file("/proc/stat")
#     intr_val = get_value(r"^intr\s+(\d+)", stat_raw)
#     if intr_val:
#         interrupts = safe_int(intr_val)

#     return {
#         "usage_percent": usage_percent,
#         "idle_percent": idle,
#         "user_percent": user,
#         "system_percent": system,
#         "iowait_percent": iowait,
#         "interrupts": interrupts,
#         "load_average": load_average,
#         "current_mhz": _get_cpu_current_mhz(),
#         "temperature_celsius": _get_cpu_temperature(),
#     }


# def _cpu_from_proc_stat(sample_delay: float = 0.2) -> tuple[Optional[float], Optional[float], Optional[float]]:
#     """Fallback CPU usage calculation using two /proc/stat samples."""
#     def read_cpu_line() -> Optional[list[int]]:
#         raw = read_file("/proc/stat")
#         for line in raw.splitlines():
#             if line.startswith("cpu "):
#                 return [int(x) for x in line.split()[1:]]
#         return None

#     first = read_cpu_line()
#     if not first:
#         return None, None, None
#     time.sleep(sample_delay)
#     second = read_cpu_line()
#     if not second:
#         return None, None, None

#     fields = ["user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal"]
#     deltas = {fields[i]: second[i] - first[i] for i in range(min(len(fields), len(first)))}
#     total = sum(deltas.values())
#     if total <= 0:
#         return None, None, None

#     idle_pct = round(deltas.get("idle", 0) / total * 100, 2)
#     user_pct = round(deltas.get("user", 0) / total * 100, 2)
#     system_pct = round(deltas.get("system", 0) / total * 100, 2)
#     return idle_pct, user_pct, system_pct


# # --------------------------------------------------------------------------
# # 3. MEMORY
# # --------------------------------------------------------------------------

# def get_memory_inventory() -> dict[str, Any]:
#     if not command_exists("dmidecode"):
#         return {"dimms": [], "note": "dmidecode not available"}

#     dmi = run(["sudo", "-n", "dmidecode", "-t", "memory"])
#     if not dmi:
#         return {"dimms": [], "note": "dmidecode requires elevated privileges"}

#     dimms = []
#     for block in dmi.split("Memory Device"):
#         size = get_value(r"^\s*Size:\s+(.*)$", block)
#         if not size or "No Module Installed" in block:
#             continue
#         dimms.append({
#             "locator": null_if_empty(get_value(r"Locator:\s+(.*)", block)),
#             "size": null_if_empty(size),
#             "type": null_if_empty(get_value(r"^\s*Type:\s+(.*)$", block)),
#             "speed": null_if_empty(get_value(r"^\s*Speed:\s+(.*)$", block)),
#             "configured_speed": null_if_empty(get_value(r"Configured Memory Speed:\s+(.*)", block)),
#             "configured_voltage": null_if_empty(get_value(r"Configured Voltage:\s+(.*)", block)),
#             "manufacturer": null_if_empty(get_value(r"Manufacturer:\s+(.*)", block)),
#             "part_number": null_if_empty(get_value(r"Part Number:\s+(.*)", block)),
#             "serial": null_if_empty(get_value(r"Serial Number:\s+(.*)", block)),
#         })

#     ecc = "Multi-bit ECC" if "Multi-bit ECC" in dmi else ("ECC" if "ECC" in dmi else None)

#     return {"dimms": dimms, "ecc": ecc}


# def get_memory_metrics() -> dict[str, Any]:
#     meminfo = parse_key_value(read_file("/proc/meminfo"))

#     def kb(key: str) -> Optional[int]:
#         val = meminfo.get(key)
#         if not val:
#             return None
#         return safe_int(val.split()[0])

#     total = kb("MemTotal")
#     free = kb("MemFree")
#     available = kb("MemAvailable")
#     buffers = kb("Buffers")
#     cached = kb("Cached")
#     swap_total = kb("SwapTotal")
#     swap_free = kb("SwapFree")

#     used = None
#     usage_percent = None
#     if total is not None and available is not None:
#         used = total - available
#         usage_percent = round(used / total * 100, 2) if total else None

#     swap_used = None
#     swap_usage_percent = None
#     if swap_total is not None and swap_free is not None:
#         swap_used = swap_total - swap_free
#         swap_usage_percent = round(swap_used / swap_total * 100, 2) if swap_total else None

#     return {
#         "total_gb": bytes_to_gb((total or 0) * 1024) if total is not None else None,
#         "used_gb": bytes_to_gb((used or 0) * 1024) if used is not None else None,
#         "free_gb": bytes_to_gb((free or 0) * 1024) if free is not None else None,
#         "available_gb": bytes_to_gb((available or 0) * 1024) if available is not None else None,
#         "buffers_gb": bytes_to_gb((buffers or 0) * 1024) if buffers is not None else None,
#         "cached_gb": bytes_to_gb((cached or 0) * 1024) if cached is not None else None,
#         "usage_percent": usage_percent,
#         "swap_total_gb": bytes_to_gb((swap_total or 0) * 1024) if swap_total is not None else None,
#         "swap_used_gb": bytes_to_gb((swap_used or 0) * 1024) if swap_used is not None else None,
#         "swap_free_gb": bytes_to_gb((swap_free or 0) * 1024) if swap_free is not None else None,
#         "swap_usage_percent": swap_usage_percent,
#     }


# # --------------------------------------------------------------------------
# # 4. DISK
# # --------------------------------------------------------------------------

# def _lsblk_json() -> list[dict[str, Any]]:
#     if not command_exists("lsblk"):
#         return []
#     out = run([
#         "lsblk", "-J", "-O",
#     ])
#     if not out:
#         out = run(["lsblk", "-J", "-b", "-o",
#                     "NAME,MODEL,SERIAL,WWN,VENDOR,TRAN,ROTA,LOG-SEC,PHY-SEC,FSTYPE,MOUNTPOINT,SIZE,TYPE"])
#     try:
#         data = json.loads(out)
#         return data.get("blockdevices", [])
#     except Exception:
#         return []


# def get_disk_inventory() -> list[dict[str, Any]]:
#     devices = _lsblk_json()
#     results = []

#     for dev in devices:
#         if dev.get("type") != "disk":
#             continue

#         name = dev.get("name")
#         dev_path = f"/dev/{name}"

#         smart = {}
#         if command_exists("smartctl"):
#             smart_out = run(["sudo", "-n", "smartctl", "-i", dev_path])
#             smart = {
#                 "model_smart": null_if_empty(get_value(r"Device Model:\s+(.*)", smart_out)),
#                 "serial_smart": null_if_empty(get_value(r"Serial Number:\s+(.*)", smart_out)),
#             }

#         partitions = []
#         for child in dev.get("children", []) or []:
#             partitions.append({
#                 "name": child.get("name"),
#                 "size": child.get("size"),
#                 "fstype": null_if_empty(child.get("fstype")),
#                 "mountpoint": null_if_empty(child.get("mountpoint")),
#             })

#         rota = dev.get("rota")
#         is_ssd = None
#         if rota is not None:
#             is_ssd = not bool(rota) if isinstance(rota, bool) else rota in (False, "0", 0)

#         results.append({
#             "name": name,
#             "model": null_if_empty(dev.get("model")) or smart.get("model_smart"),
#             "serial": null_if_empty(dev.get("serial")) or smart.get("serial_smart"),
#             "wwn": null_if_empty(dev.get("wwn")),
#             "vendor": null_if_empty(dev.get("vendor")),
#             "transport": null_if_empty(dev.get("tran")),
#             "type": "SSD" if is_ssd else ("HDD" if is_ssd is False else None),
#             "logical_sector_size": dev.get("log-sec"),
#             "physical_sector_size": dev.get("phy-sec"),
#             "size": dev.get("size"),
#             "partitions": partitions,
#         })

#     return results


# def get_disk_metrics() -> list[dict[str, Any]]:
#     df_out = run(["df", "-B1", "--output=source,target,fstype,size,used,avail,pcent"])
#     results = []

#     lines = df_out.splitlines()[1:] if df_out else []
#     for line in lines:
#         parts = line.split()
#         if len(parts) < 7:
#             continue
#         source, target, fstype, size, used, avail, pcent = parts[:7]
#         if not source.startswith("/dev/"):
#             continue

#         results.append({
#             "source": source,
#             "mountpoint": target,
#             "filesystem": fstype,
#             "size_gb": bytes_to_gb(size),
#             "used_gb": bytes_to_gb(used),
#             "free_gb": bytes_to_gb(avail),
#             "usage_percent": safe_float(pcent.replace("%", "")),
#         })

#     # SMART health per physical disk
#     smart_health = {}
#     if command_exists("smartctl"):
#         for dev in _lsblk_json():
#             if dev.get("type") != "disk":
#                 continue
#             name = dev.get("name")
#             dev_path = f"/dev/{name}"
#             smart_out = run(["sudo", "-n", "smartctl", "-A", "-H", dev_path])
#             if not smart_out:
#                 continue

#             health = get_value(r"SMART overall-health self-assessment test result:\s+(\w+)", smart_out)
#             temp = get_value(r"Temperature_Celsius.*\s(\d+)\s*$", smart_out) or \
#                 get_value(r"Temperature:\s+(\d+)\s*Celsius", smart_out)
#             power_on = get_value(r"Power_On_Hours.*\s(\d+)\s*$", smart_out)
#             realloc = get_value(r"Reallocated_Sector_Ct.*\s(\d+)\s*$", smart_out)
#             pending = get_value(r"Current_Pending_Sector.*\s(\d+)\s*$", smart_out)

#             smart_health[name] = {
#                 "health": null_if_empty(health),
#                 "temperature_celsius": safe_int(temp),
#                 "power_on_hours": safe_int(power_on),
#                 "reallocated_sectors": safe_int(realloc),
#                 "pending_sectors": safe_int(pending),
#             }

#     return {
#         "mounts": results,
#         "smart": smart_health,
#     }


# # --------------------------------------------------------------------------
# # 5. GPU
# # --------------------------------------------------------------------------

# def get_gpu_inventory_and_metrics() -> Optional[list[dict[str, Any]]]:
#     if command_exists("nvidia-smi"):
#         query = (
#             "name,driver_version,pci.bus_id,memory.total,memory.used,memory.free,"
#             "utilization.gpu,utilization.memory,power.draw,power.limit,"
#             "temperature.gpu,fan.speed,clocks.gr,clocks.mem"
#         )
#         out = run(["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"])
#         if out.strip():
#             gpus = []
#             for line in out.strip().splitlines():
#                 fields = [f.strip() for f in line.split(",")]
#                 if len(fields) < 14:
#                     continue
#                 (name, driver, pci_bus, mem_total, mem_used, mem_free,
#                  util_gpu, util_mem, power_draw, power_limit,
#                  temp, fan, clock_gr, clock_mem) = fields[:14]

#                 cuda_out = run(["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"])
#                 cuda_version = get_value(r"CUDA Version:\s+([\d.]+)", run(["nvidia-smi"]))

#                 gpus.append({
#                     "vendor": "NVIDIA",
#                     "model": name,
#                     "driver_version": driver,
#                     "cuda_version": cuda_version,
#                     "pci_bus_id": pci_bus,
#                     "vram_total_mb": safe_float(mem_total),
#                     "memory_used_mb": safe_float(mem_used),
#                     "memory_free_mb": safe_float(mem_free),
#                     "gpu_utilization_percent": safe_float(util_gpu),
#                     "memory_utilization_percent": safe_float(util_mem),
#                     "power_draw_watts": safe_float(power_draw),
#                     "power_limit_watts": safe_float(power_limit),
#                     "temperature_celsius": safe_float(temp),
#                     "fan_speed_percent": safe_float(fan),
#                     "graphics_clock_mhz": safe_float(clock_gr),
#                     "memory_clock_mhz": safe_float(clock_mem),
#                 })
#             if gpus:
#                 return gpus

#     # Fallback: lspci detection only (no live metrics available)
#     if command_exists("lspci"):
#         lspci_out = run(["lspci"])
#         gpu_lines = [l for l in lspci_out.splitlines() if "VGA" in l or "3D controller" in l]
#         if gpu_lines:
#             gpus = []
#             for line in gpu_lines:
#                 desc = line.split(": ", 1)[-1] if ": " in line else line
#                 gpus.append({
#                     "vendor": null_if_empty(desc.split()[0]) if desc else None,
#                     "model": desc,
#                     "driver_version": None,
#                     "cuda_version": None,
#                     "pci_bus_id": line.split()[0] if line else None,
#                     "vram_total_mb": None,
#                     "memory_used_mb": None,
#                     "memory_free_mb": None,
#                     "gpu_utilization_percent": None,
#                     "memory_utilization_percent": None,
#                     "power_draw_watts": None,
#                     "power_limit_watts": None,
#                     "temperature_celsius": None,
#                     "fan_speed_percent": None,
#                     "graphics_clock_mhz": None,
#                     "memory_clock_mhz": None,
#                 })
#             return gpus

#     return None


# # --------------------------------------------------------------------------
# # 6. NIC
# # --------------------------------------------------------------------------

# def _list_interfaces() -> list[str]:
#     out = run(["ip", "-o", "link", "show"])
#     names = []
#     for line in out.splitlines():
#         m = re.match(r"\d+:\s+([^:@]+)", line)
#         if m:
#             iface = m.group(1).strip()
#             if iface != "lo":
#                 names.append(iface)
#     return names


# def get_nic_inventory() -> list[dict[str, Any]]:
#     interfaces = []
#     for iface in _list_interfaces():
#         addr_out = run(["ip", "-o", "link", "show", iface])
#         mac = get_value(r"link/ether\s+([0-9a-f:]+)", addr_out)

#         ethtool_out = run(["sudo", "-n", "ethtool", iface]) if command_exists("ethtool") else ""
#         driver_out = run(["sudo", "-n", "ethtool", "-i", iface]) if command_exists("ethtool") else ""

#         mtu = get_value(r"mtu (\d+)", addr_out)

#         supported_speeds = []
#         supported_match = re.findall(r"(\d+base\S+)", ethtool_out)
#         if supported_match:
#             supported_speeds = sorted(set(supported_match))

#         bus_info = get_value(r"bus-info:\s+(\S+)", driver_out)

#         interfaces.append({
#             "name": iface,
#             "mac": null_if_empty(mac),
#             "driver": null_if_empty(get_value(r"driver:\s+(\S+)", driver_out)),
#             "firmware_version": null_if_empty(get_value(r"firmware-version:\s+(.*)", driver_out)),
#             "supported_speeds": supported_speeds,
#             "negotiated_speed": null_if_empty(get_value(r"Speed:\s+(\S+)", ethtool_out)),
#             "mtu": safe_int(mtu),
#             "pci_slot": null_if_empty(bus_info),
#         })
#     return interfaces


# def get_nic_metrics() -> list[dict[str, Any]]:
#     results = []

#     net_dev = read_file("/proc/net/dev")
#     stats = {}

#     for line in net_dev.splitlines()[2:]:
#         if ":" not in line:
#             continue

#         name, data = line.split(":", 1)
#         name = name.strip()
#         parts = data.split()

#         if len(parts) < 16:
#             continue

#         stats[name] = {
#             "rx_bytes": safe_int(parts[0]),
#             "rx_packets": safe_int(parts[1]),
#             "rx_errors": safe_int(parts[2]),
#             "rx_dropped": safe_int(parts[3]),
#             "tx_bytes": safe_int(parts[8]),
#             "tx_packets": safe_int(parts[9]),
#             "tx_errors": safe_int(parts[10]),
#             "tx_dropped": safe_int(parts[11]),
#         }

#     for iface in _list_interfaces():
#         ethtool_out = ""
#         if command_exists("ethtool"):
#             ethtool_out = run(["sudo", "-n", "ethtool", iface])

#         # SAFE LINK DETECTION
#         detected = get_value(r"Link detected:\s+(\w+)", ethtool_out)

#         if detected:
#             link_state = "up" if detected.lower() == "yes" else "down"
#         else:
#             ip_out = run(["ip", "-br", "link", "show", iface])
#             link_state = "up" if "UP" in ip_out else "down"

#         s = stats.get(iface, {})

#         results.append({
#             "name": iface,
#             "link_state": link_state,
#             "speed": get_value(r"Speed:\s+(\S+)", ethtool_out),
#             "duplex": get_value(r"Duplex:\s+(\S+)", ethtool_out),
#             "rx_bytes": s.get("rx_bytes"),
#             "tx_bytes": s.get("tx_bytes"),
#             "rx_packets": s.get("rx_packets"),
#             "tx_packets": s.get("tx_packets"),
#             "rx_errors": s.get("rx_errors"),
#             "tx_errors": s.get("tx_errors"),
#             "rx_dropped": s.get("rx_dropped"),
#             "tx_dropped": s.get("tx_dropped"),
#         })

#     return results


# # --------------------------------------------------------------------------
# # 7. PSU
# # --------------------------------------------------------------------------

# def get_psu_metrics() -> Optional[list[dict[str, Any]]]:
#     psus = []

#     if command_exists("ipmitool"):
#         out = run(["sudo", "-n", "ipmitool", "sdr", "type", "Power Supply"])
#         if out.strip():
#             for line in out.strip().splitlines():
#                 fields = [f.strip() for f in line.split("|")]
#                 if len(fields) >= 3:
#                     psus.append({
#                         "name": fields[0],
#                         "status": fields[2] if len(fields) > 2 else None,
#                         "reading": fields[1] if len(fields) > 1 else None,
#                         "source": "ipmitool",
#                     })

#     if not psus and command_exists("sensors"):
#         out = run(["sensors"])
#         power_lines = [l for l in out.splitlines() if re.search(r"power\d*:", l, re.IGNORECASE)]
#         if power_lines:
#             for line in power_lines:
#                 psus.append({
#                     "name": line.split(":")[0].strip(),
#                     "reading": line.split(":", 1)[1].strip() if ":" in line else None,
#                     "status": None,
#                     "source": "lm-sensors",
#                 })

#     return psus or None


# # --------------------------------------------------------------------------
# # 8. IO DEVICES
# # --------------------------------------------------------------------------

# def get_io_devices() -> dict[str, Any]:
#     pci_devices = []
#     if command_exists("lspci"):
#         out = run(["lspci", "-mm"])
#         for line in out.splitlines():
#             # Format: "Slot" "Class" "Vendor" "Device" ...
#             matches = re.findall(r'"((?:[^"\\]|\\.)*)"', line)
#             if len(matches) >= 4:
#                 slot = line.split()[0]
#                 pci_devices.append({
#                     "slot": slot,
#                     "class": matches[0],
#                     "vendor": matches[1],
#                     "device": matches[2],
#                     "description": f"{matches[1]} {matches[2]}",
#                 })

#     usb_devices = []
#     if command_exists("lsusb"):
#         out = run(["lsusb"])
#         for line in out.splitlines():
#             m = re.match(r"Bus (\d+) Device (\d+): ID (\w{4}):(\w{4})\s*(.*)", line)
#             if m:
#                 bus, device, vendor_id, device_id, desc = m.groups()
#                 usb_devices.append({
#                     "bus": bus,
#                     "device": device,
#                     "vendor_id": vendor_id,
#                     "device_id": device_id,
#                     "description": desc.strip() or None,
#                 })

#     return {"pci": pci_devices, "usb": usb_devices}


# # --------------------------------------------------------------------------
# # 9. MANAGEMENT
# # --------------------------------------------------------------------------

# def get_management_info() -> dict[str, Any]:
#     bios = parse_key_value(run(["sudo", "-n", "dmidecode", "-t", "bios"]))
#     system = parse_key_value(run(["sudo", "-n", "dmidecode", "-t", "system"]))
#     chassis = parse_key_value(run(["sudo", "-n", "dmidecode", "-t", "chassis"]))

#     bmc_info = {"firmware": None, "ip": None}
#     if command_exists("ipmitool"):
#         mc_out = run(["sudo", "-n", "ipmitool", "mc", "info"])
#         bmc_info["firmware"] = null_if_empty(get_value(r"Firmware Revision\s+:\s+(.*)", mc_out))

#         lan_out = run(["sudo", "-n", "ipmitool", "lan", "print"])
#         bmc_info["ip"] = null_if_empty(get_value(r"IP Address\s+:\s+(.*)", lan_out))

#     return {
#         "bios_vendor": null_if_empty(bios.get("Vendor")),
#         "bios_version": null_if_empty(bios.get("Version")),
#         "bios_date": null_if_empty(bios.get("Release Date")),
#         "system_manufacturer": null_if_empty(system.get("Manufacturer")),
#         "system_product": null_if_empty(system.get("Product Name")),
#         "system_uuid": null_if_empty(system.get("UUID")),
#         "serial_number": null_if_empty(system.get("Serial Number")),
#         "asset_tag": null_if_empty(chassis.get("Asset Tag")),
#         "chassis_type": null_if_empty(chassis.get("Type")),
#         "chassis_manufacturer": null_if_empty(chassis.get("Manufacturer")),
#         "bmc_firmware": bmc_info["firmware"],
#         "bmc_ip": bmc_info["ip"],
#     }


# # --------------------------------------------------------------------------
# # Top-level inventory / metrics collectors
# # --------------------------------------------------------------------------

# def collect_inventory() -> dict[str, Any]:
#     """Collect mostly-static hardware description data."""
#     return {
#         "system": get_system_inventory(),
#         "cpu": get_cpu_inventory(),
#         "memory": get_memory_inventory(),
#         "disk": get_disk_inventory(),
#         "gpu": get_gpu_inventory_and_metrics(),  # static fields reused; metrics refreshed separately
#         "nic": get_nic_inventory(),
#         "io": get_io_devices(),
#         "management": get_management_info(),
#     }

# # ============================================================================
# # PROCESS ATTRIBUTION
# # ============================================================================

# @safe_collect("top_cpu_processes", fallback=[])
# def get_top_cpu_processes(limit: int = 10) -> list[dict[str, Any]]:
#     """
#     Top CPU consuming processes.
#     """
#     out = run([
#         "ps",
#         "-eo",
#         "pid,user,%cpu,%mem,etime,comm,args",
#         "--sort=-%cpu"
#     ])

#     results = []

#     for line in out.splitlines()[1:limit + 1]:
#         parts = line.split(None, 6)

#         if len(parts) < 7:
#             continue

#         results.append({
#             "pid": safe_int(parts[0]),
#             "user": parts[1],
#             "cpu_percent": safe_float(parts[2]),
#             "memory_percent": safe_float(parts[3]),
#             "elapsed": parts[4],
#             "process": parts[5],
#             "command": parts[6],
#         })

#     return results
# @safe_collect("gpu_processes", fallback=[])
# def get_gpu_processes() -> list[dict[str, Any]]:
#     """
#     Per-process GPU utilization.

#     Priority:
#         1. nvidia-smi pmon (GPU utilization)
#         2. compute-apps (GPU memory only)
#     """

#     if not command_exists("nvidia-smi"):
#         return []

#     processes = []

#     # ---------------------------------------------------
#     # STEP 1 : Try PMON (per-process utilization)
#     # ---------------------------------------------------

#     pmon = run([
#         "nvidia-smi",
#         "pmon",
#         "-s",
#         "um",
#         "-c",
#         "1"
#     ])

#     if pmon:

#         memory_lookup = {}

#         query = run([
#             "nvidia-smi",
#             "--query-compute-apps=pid,used_gpu_memory",
#             "--format=csv,noheader,nounits"
#         ])

#         for line in query.splitlines():
#             fields = [x.strip() for x in line.split(",")]
#             if len(fields) != 2:
#                 continue

#             memory_lookup[safe_int(fields[0])] = safe_int(fields[1])

#         for line in pmon.splitlines():

#             if line.startswith("#"):
#                 continue

#             parts = line.split()

#             if len(parts) < 11:
#                 continue

#             gpu = safe_int(parts[0])
#             pid = safe_int(parts[1])

#             if pid is None:
#                 continue

#             proc_type = parts[2]

#             def parse(v):
#                 if v == "-":
#                     return None
#                 return safe_float(v)

#             sm = parse(parts[3])
#             mem = parse(parts[4])
#             enc = parse(parts[5])
#             dec = parse(parts[6])

#             command = " ".join(parts[10:])

#             processes.append({
#                 "gpu": gpu,
#                 "pid": pid,
#                 "process": command,
#                 "type": proc_type,
#                 "gpu_compute_percent": sm,
#                 "gpu_memory_percent": mem,
#                 "encoder_percent": enc,
#                 "decoder_percent": dec,
#                 "gpu_memory_mb": memory_lookup.get(pid),
#             })

#         if processes:
#             return processes

#     # ---------------------------------------------------
#     # STEP 2 : Fallback
#     # ---------------------------------------------------

#     out = run([
#         "nvidia-smi",
#         "--query-compute-apps=pid,process_name,used_gpu_memory",
#         "--format=csv,noheader,nounits"
#     ])

#     for line in out.splitlines():

#         fields = [x.strip() for x in line.split(",")]

#         if len(fields) != 3:
#             continue

#         processes.append({
#             "gpu": 0,
#             "pid": safe_int(fields[0]),
#             "process": fields[1],
#             "type": "C",
#             "gpu_compute_percent": None,
#             "gpu_memory_percent": None,
#             "encoder_percent": None,
#             "decoder_percent": None,
#             "gpu_memory_mb": safe_int(fields[2]),
#         })

#     return processes


# def collect_metrics() -> dict[str, Any]:
#     """Collect live, changing performance metrics."""
#     metrics = {
#         "timestamp": datetime.now(timezone.utc).isoformat(),
#         "system": get_system_metrics(),
#         "cpu": get_cpu_metrics(),
#         "memory": get_memory_metrics(),
#         "disk": get_disk_metrics(),
#         "gpu": get_gpu_inventory_and_metrics(),
#         "nic": get_nic_metrics(),
#         "psu": get_psu_metrics(),
#         "top_processes": {
#                 "cpu": get_top_cpu_processes(),
#                 "gpu": get_gpu_processes(),
#     },
#     }
#     # DEMO: overwrite RAM/DISK/NIC fields per whatever severity is currently
#     # set via /demo/<component>/<severity>. No-op while everything is
#     # "healthy". CPU/GPU are never touched here.
#     inject_metrics(metrics)
#     return metrics


# # ============================================================================
# # 10. CPU HEALTH (link/interconnect health agent)
# # ============================================================================


# @safe_collect("cpu_inventory_extra", fallback={})
# def get_cpu_inventory_extra() -> dict[str, Any]:
#     lscpu = run(["lscpu"])
#     cpuinfo = read_file("/proc/cpuinfo")

#     microcode = get_value(r"^microcode\s*:\s*(\S+)", cpuinfo)
#     cur_mhz = safe_float(get_value(r"CPU MHz:\s+(.*)", lscpu))
#     max_mhz = safe_float(get_value(r"CPU max MHz:\s+(.*)", lscpu))
#     min_mhz = safe_float(get_value(r"CPU min MHz:\s+(.*)", lscpu))

#     # C-state: report the deepest idle state name/latency if cpuidle exposes it
#     cstate = None
#     cpuidle_root = CPUFREQ_PATH / "cpu0" / "cpuidle"
#     if cpuidle_root.exists():
#         states = sorted(p.name for p in cpuidle_root.iterdir() if p.name.startswith("state"))
#         if states:
#             deepest = states[-1]
#             name = read_stripped(cpuidle_root / deepest / "name")
#             latency = read_stripped(cpuidle_root / deepest / "latency")
#             cstate = {"deepest_state": name, "exit_latency_us": safe_int(latency)}

#     return {
#         "microcode_version": null_if_empty(microcode),
#         "current_mhz": cur_mhz,
#         "max_mhz": max_mhz,
#         "min_mhz": min_mhz,
#         "deepest_cstate": cstate,
#     }


# @safe_collect("cpu_thermal_throttling", fallback=None)
# def _get_cpu_thermal_throttling() -> Optional[dict[str, Any]]:
#     counts = {}
#     cpu_dirs = sorted(p for p in CPUFREQ_PATH.iterdir() if re.match(r"^cpu\d+$", p.name))
#     for cpu_dir in cpu_dirs:
#         throttle_dir = cpu_dir / "thermal_throttle"
#         if not throttle_dir.exists():
#             continue
#         core_count = safe_int(read_stripped(throttle_dir / "core_throttle_count"))
#         pkg_count = safe_int(read_stripped(throttle_dir / "package_throttle_count"))
#         if core_count is not None or pkg_count is not None:
#             counts[cpu_dir.name] = {
#                 "core_throttle_count": core_count,
#                 "package_throttle_count": pkg_count,
#             }
#     return counts or None


# @safe_collect("cpu_mce", fallback={})
# def _get_cpu_mce_counts(kernel_log: str) -> dict[str, Any]:
#     """Count Machine Check Exception related lines in the cached kernel log."""
#     if not kernel_log:
#         return {"mce_error_count": None, "corrected_hardware_errors": None, "fatal_cpu_errors": None}

#     mce_count = len(re.findall(r"mce:|Machine check", kernel_log, re.IGNORECASE))
#     corrected = len(re.findall(r"Corrected error|CE memory read", kernel_log, re.IGNORECASE))
#     fatal = len(re.findall(r"Kernel panic|Fatal machine check|Machine check events logged", kernel_log, re.IGNORECASE))

#     return {
#         "mce_error_count": mce_count,
#         "corrected_hardware_errors": corrected,
#         "fatal_cpu_errors": fatal,
#     }


# @safe_collect("rapl_power", fallback=None)
# def get_rapl_power() -> Optional[list[dict[str, Any]]]:
#     """Sample Intel RAPL energy counters twice to derive instantaneous
#     package/DRAM power in watts. Returns None entirely if RAPL isn't
#     exposed (non-Intel or unsupported platform)."""
#     if not POWERCAP_PATH.exists():
#         return None

#     domains = [p for p in POWERCAP_PATH.iterdir() if p.name.startswith("intel-rapl")]
#     if not domains:
#         return None

#     def sample() -> dict[str, tuple[Optional[int], Optional[int]]]:
#         snap = {}
#         for d in domains:
#             name = read_stripped(d / "name")
#             energy = safe_int(read_stripped(d / "energy_uj"))
#             max_range = safe_int(read_stripped(d / "max_energy_range_uj"))
#             snap[d.name] = (name, energy, max_range)
#         return snap

#     first = sample()
#     t0 = time.time()
#     time.sleep(0.2)
#     t1 = time.time()
#     dt = t1 - t0
#     if dt <= 0:
#         return None

#     results = []
#     for domain_id, (name, e1, max_range) in first.items():
#         if e1 is None:
#             continue
#         d = POWERCAP_PATH / domain_id
#         e2 = safe_int(read_stripped(d / "energy_uj"))
#         if e2 is None:
#             continue
#         delta = e2 - e1
#         if delta < 0 and max_range:  # counter wrapped
#             delta += max_range
#         watts = round((delta / 1_000_000) / dt, 2) if delta >= 0 else None
#         results.append({"domain": name or domain_id, "power_watts": watts})

#     return results or None


# @safe_collect("cpu_health", fallback={})
# def get_cpu_health(kernel_log: str) -> dict[str, Any]:
#     mce = _get_cpu_mce_counts(kernel_log)
#     throttling = _get_cpu_thermal_throttling()
#     total_core_throttle = sum(
#         (v.get("core_throttle_count") or 0) for v in (throttling or {}).values()
#     )
#     total_package_throttle = sum(
#         (v.get("package_throttle_count") or 0) for v in (throttling or {}).values()
#     )
#     return {
#         "mce_errors": mce.get("mce_error_count"),
#         "corrected_errors": mce.get("corrected_hardware_errors"),
#         "fatal_errors": mce.get("fatal_cpu_errors"),
#         "thermal_throttling": throttling,
#         "thermal_throttling_total_core_count": total_core_throttle,
#         "thermal_throttling_total_package_count": total_package_throttle,
#         "rapl_power": get_rapl_power(),
#     }


# # ============================================================================
# # 11. MEMORY HEALTH -- EDAC
# # ============================================================================


# @safe_collect("memory_health", fallback=None)
# def get_memory_health() -> Optional[dict[str, Any]]:
#     """Prefer sysfs EDAC counters (no extra tooling required). Falls back to
#     ras-mc-ctl / edac-util text output only to fill in what sysfs can't."""
#     if not EDAC_MC_PATH.exists():
#         return {"supported": False}

#     mc_dirs = sorted(p for p in EDAC_MC_PATH.iterdir() if re.match(r"^mc\d+$", p.name))
#     if not mc_dirs:
#         return {"supported": False}

#     controllers = []
#     total_ce = 0
#     total_ue = 0
#     for mc_dir in mc_dirs:
#         ce = safe_int(read_stripped(mc_dir / "ce_count"))
#         ue = safe_int(read_stripped(mc_dir / "ue_count"))
#         ce_noinfo = safe_int(read_stripped(mc_dir / "ce_noinfo_count"))
#         ue_noinfo = safe_int(read_stripped(mc_dir / "ue_noinfo_count"))

#         dimm_failures = []
#         for csrow_dir in sorted(mc_dir.glob("csrow*")):
#             row_ce = safe_int(read_stripped(csrow_dir / "ce_count"))
#             row_ue = safe_int(read_stripped(csrow_dir / "ue_count"))
#             if (row_ue or 0) > 0 or (row_ce or 0) > 0:
#                 dimm_failures.append({
#                     "row": csrow_dir.name,
#                     "correctable_errors": row_ce,
#                     "uncorrectable_errors": row_ue,
#                 })

#         if ce is not None:
#             total_ce += ce
#         if ue is not None:
#             total_ue += ue

#         controllers.append({
#             "controller": mc_dir.name,
#             "correctable_errors": ce,
#             "uncorrectable_errors": ue,
#             "correctable_errors_no_dimm_info": ce_noinfo,
#             "uncorrectable_errors_no_dimm_info": ue_noinfo,
#             "dimm_failures": dimm_failures,
#         })

#     return {
#         "supported": True,
#         "correctable_errors": total_ce,
#         "uncorrectable_errors": total_ue,
#         "memory_controller_errors": total_ue,  # UEs are controller-level failures
#         "controllers": controllers,
#     }


# @safe_collect("memory_inventory_extra", fallback=[])
# def get_memory_inventory_extra() -> list[dict[str, Any]]:
#     """Extra DIMM-level inventory fields via dmidecode, keyed the same way
#     your existing DIMM collector reports (locator).

#     Note: deliberately does NOT gate on is_root() -- that checks whether
#     this Python process itself is running as root, not whether `sudo -n`
#     will succeed. A non-root user with passwordless sudo configured for
#     dmidecode would be wrongly skipped, leaving this permanently empty
#     even though `sudo dmidecode -t memory` works fine interactively.
#     run() already fails safely (empty string) if sudo -n can't
#     authenticate, so we just let it try."""
#     if not command_exists("dmidecode"):
#         return []
#     dmi = run(["sudo", "-n", "dmidecode", "-t", "memory"], timeout=LONG_TIMEOUT)
#     if not dmi:
#         return []

#     dimms = []
#     for block in dmi.split("Memory Device"):
#         size = get_value(r"^\s*Size:\s+(.*)$", block)
#         if not size or "No Module Installed" in block:
#             continue
#         dimms.append({
#             "locator": null_if_empty(get_value(r"Locator:\s+(.*)", block)),
#             "size": null_if_empty(size),
#             "manufacturer": null_if_empty(get_value(r"Manufacturer:\s+(.*)", block)),
#             "serial": null_if_empty(get_value(r"Serial Number:\s+(.*)", block)),
#             "part_number": null_if_empty(get_value(r"Part Number:\s+(.*)", block)),
#             "configured_speed": null_if_empty(get_value(r"Configured Memory Speed:\s+(.*)", block)),
#             "max_speed": null_if_empty(get_value(r"^\s*Speed:\s+(.*)$", block)),
#             "rank": null_if_empty(get_value(r"Rank:\s+(.*)", block)),
#             "ecc_supported": "ECC" in dmi,
#         })
#     return dimms


# # ============================================================================
# # 12. GPU HEALTH
# # ============================================================================


# def _classify_gpu_link_health(
#     gen_current: Optional[int],
#     gen_max: Optional[int],
#     width_current: Optional[int],
#     width_max: Optional[int],
#     replay_errors: Optional[int],
#     xid_errors: Optional[int],
#     ecc_uncorrected: Optional[int],
#     ecc_corrected: Optional[int],
# ) -> str:
#     """
#     Healthy / Power Saving / Warning / Critical for a GPU's PCIe link + ECC
#     state. An idle GPU negotiating a lower PCIe generation while still at
#     full link width, with zero replay/ECC errors, is normal ASPM power
#     management -- NOT a fault.
#     """
#     if (xid_errors or 0) > 0 or (ecc_uncorrected or 0) > 0:
#         return "Critical"

#     width_degraded = (
#         width_current is not None and width_max is not None and width_current < width_max
#     )
#     gen_degraded = (
#         gen_current is not None and gen_max is not None and gen_current < gen_max
#     )

#     if width_degraded or (replay_errors or 0) > 0 or (ecc_corrected or 0) > 0:
#         return "Warning"

#     if gen_degraded and not width_degraded:
#         return "Power Saving"

#     return "Healthy"


# @safe_collect("gpu_health", fallback=None)
# def get_gpu_health(kernel_log: str) -> Optional[list[dict[str, Any]]]:
#     if not command_exists("nvidia-smi"):
#         return None

#     query = (
#         "name,driver_version,pci.bus_id,temperature.gpu,utilization.gpu,"
#         "utilization.memory,power.draw,power.limit,fan.speed,"
#         "ecc.errors.corrected.aggregate.total,ecc.errors.uncorrected.aggregate.total,"
#         "retired_pages.sbe,retired_pages.dbe,"
#         "pcie.link.gen.current,pcie.link.gen.max,"
#         "pcie.link.width.current,pcie.link.width.max"
#     )
#     out = run(["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"])
#     if not out.strip():
#         return None

#     # XID errors and GPU reset events only show up in the kernel log.
#     xid_events = re.findall(r"NVRM: Xid.*?:\s*(\d+),", kernel_log or "")
#     reset_count = len(re.findall(r"NVRM: GPU.*?resetting|falling back to blacklist", kernel_log or "", re.IGNORECASE))
#     replay_errors = len(re.findall(r"NVRM:.*?PCIe.*?replay", kernel_log or "", re.IGNORECASE))

#     gpus = []
#     for idx, line in enumerate(out.strip().splitlines()):
#         fields = [f.strip() for f in line.split(",")]
#         if len(fields) < 17:
#             continue
#         (name, driver, pci_bus, temp, util_gpu, util_mem, power_draw, power_limit,
#          fan, ecc_corr, ecc_uncorr, sbe, dbe, gen_cur, gen_max, width_cur, width_max) = fields[:17]

#         throttle_out = run(["nvidia-smi", "-i", str(idx), "-q", "-d", "PERFORMANCE"])
#         throttle_reasons = {}
#         for reason_line in re.findall(r"^\s+(\w[\w .]*)\s*:\s*(Active|Not Active)\s*$", throttle_out, re.MULTILINE):
#             label, state = reason_line
#             if "throttle" in label.lower() or "slowdown" in label.lower():
#                 throttle_reasons[label.strip()] = state == "Active"

#         gen_cur_i = safe_int(gen_cur)
#         gen_max_i = safe_int(gen_max)
#         width_cur_i = safe_int(width_cur)
#         width_max_i = safe_int(width_max)
#         ecc_corr_i = safe_int(ecc_corr)
#         ecc_uncorr_i = safe_int(ecc_uncorr)
#         xid_count = len(xid_events)

#         link_status = _classify_gpu_link_health(
#             gen_cur_i, gen_max_i, width_cur_i, width_max_i,
#             replay_errors, xid_count, ecc_uncorr_i, ecc_corr_i,
#         )

#         gpus.append({
#             "index": idx,
#             "model": name,
#             "pci_bus_id": pci_bus,
#             "health": {
#                 "temperature_celsius": safe_float(temp),
#                 "gpu_utilization_percent": safe_float(util_gpu),
#                 "memory_utilization_percent": safe_float(util_mem),
#                 "power_draw_watts": safe_float(power_draw),
#                 "power_limit_watts": safe_float(power_limit),
#                 "fan_speed_percent": safe_float(fan),
#                 "ecc_corrected": ecc_corr_i,
#                 "ecc_uncorrected": ecc_uncorr_i,
#                 "retired_pages_single_bit": safe_int(sbe),
#                 "retired_pages_double_bit": safe_int(dbe),
#                 "xid_errors": xid_count,
#                 "reset_count": reset_count,
#                 "replay_errors": replay_errors,
#                 "pcie_generation_current": gen_cur_i,
#                 "pcie_generation_max": gen_max_i,
#                 "pcie_width_current": width_cur_i,
#                 "pcie_width_max": width_max_i,
#                 "throttle_reasons": throttle_reasons or None,
#                 "link_status": link_status,
#             },
#         })

#     return gpus or None


# # ============================================================================
# # 13 & 14. PCIe LINK STATE, AER, AND HEALTH EVALUATION
# # ============================================================================


# def _speed_to_gts(speed_str: Optional[str]) -> Optional[float]:
#     if not speed_str:
#         return None
#     m = re.search(r"([\d.]+)\s*GT/s", speed_str)
#     return float(m.group(1)) if m else None


# def _width_to_int(width_str: Optional[str]) -> Optional[int]:
#     if not width_str:
#         return None
#     m = re.search(r"(\d+)", width_str)
#     return int(m.group(1)) if m else None


# def _pci_descriptions() -> dict[str, str]:
#     out = run(["lspci", "-D", "-mm"])
#     desc_map: dict[str, str] = {}
#     for line in out.splitlines():
#         matches = re.findall(r'"((?:[^"\\]|\\.)*)"', line)
#         if len(matches) >= 4:
#             slot = line.split()[0]
#             desc_map[slot] = f"{matches[1]} {matches[2]}"
#     return desc_map


# def _read_aer_counters(device_dir: Path) -> dict[str, Any]:
#     """Real AER error counters from sysfs. total_errors is always included
#     (even 0) since confirmed-zero is itself a meaningful signal."""
#     breakdown: dict[str, Any] = {}
#     total = 0
#     any_file_readable = False

#     for fname in _AER_FILES:
#         text = read_file(device_dir / fname)
#         if not text:
#             continue
#         any_file_readable = True
#         counters: dict[str, int] = {}
#         for line in text.splitlines():
#             parts = line.split()
#             if len(parts) == 2:
#                 val = safe_int(parts[1])
#                 if val is not None:
#                     total += val
#                     if val > 0:
#                         counters[parts[0]] = val
#         if counters:
#             breakdown[fname.replace("aer_dev_", "")] = counters

#     if not any_file_readable:
#         return {}

#     breakdown["total_errors"] = total
#     return breakdown


# # lspci -vv AER flag-register lines look like:
# #   UESta:  DLP- SDES- TLP- FCP- CmpltTO- CmpltAbrt- UnxCmplt- RxOF- MalfTLP- ECRC- UnsupReq- ACSViol-
# # A '+' after a flag name means that error condition is currently latched/set.
# def _parse_flag_register(line: Optional[str]) -> dict[str, bool]:
#     if not line:
#         return {}
#     flags = {}
#     for name, sign in re.findall(r"(\w+)([+-])", line):
#         flags[name] = sign == "+"
#     return flags


# # Friendly-name maps for AER correctable / uncorrectable flag registers, used
# # both to expose human-readable error names in JSON and to drive health
# # classification (Replay Timeout, Receiver Overflow, Bad DLLP, etc).
# _CORRECTABLE_AER_FLAG_NAMES = {
#     "RxErr": "Receiver Error",
#     "BadTLP": "Bad TLP",
#     "BadDLLP": "Bad DLLP",
#     "Rollover": "Replay Counter",
#     "Timeout": "Replay Timeout",
#     "NonFatalErr": "Advisory Non-Fatal Error",
#     "AdvNonFatalErr": "Advisory Non-Fatal Error",
#     "CorrIntErr": "Corrected Internal Error",
#     "HeaderOF": "Header Log Overflow",
# }

# _UNCORRECTABLE_AER_FLAG_NAMES = {
#     "DLP": "Data Link Protocol Error",
#     "SDES": "Surprise Down Error",
#     "TLP": "Poisoned TLP",
#     "FCP": "Flow Control Protocol Error",
#     "CmpltTO": "Completion Timeout",
#     "CmpltAbrt": "Completion Abort",
#     "UnxCmplt": "Unexpected Completion",
#     "RxOF": "Receiver Overflow",
#     "MalfTLP": "Malformed TLP",
#     "ECRC": "ECRC Error",
#     "UnsupReq": "Unsupported Request",
#     "ACSViol": "ACS Violation",
#     "UncorrIntErr": "Uncorrectable Internal Error",
#     "BlockedTLP": "Blocked TLP",
#     "AtomicOpBlocked": "AtomicOp Blocked",
#     "TLPBlockedErr": "TLP Blocked Error",
# }


# def _extract_lspci_block(device_text: str, header_prefix: str) -> Optional[str]:
#     """Pull the lines belonging to a given 'Capabilities: [xx] <Header>' block
#     out of a single device's lspci -vv text chunk."""
#     lines = device_text.splitlines()
#     capturing = False
#     block_lines = []
#     for line in lines:
#         if re.match(r"^\s*Capabilities:.*" + re.escape(header_prefix), line):
#             capturing = True
#             block_lines.append(line)
#             continue
#         if capturing:
#             if re.match(r"^\s*Capabilities:", line) or re.match(r"^\S", line):
#                 break
#             block_lines.append(line)
#     return "\n".join(block_lines) if block_lines else None


# @safe_collect("pcie_extended_health", fallback={})
# def _get_pcie_extended_health(slot: str, lspci_vv_full: str) -> dict[str, Any]:
#     """Parse per-device AER status/severity flags and link training state
#     out of `lspci -vv` for one device (identified by its slot/BDF)."""
#     # Isolate this device's text chunk (from its header line to the next device header)
#     pattern = re.compile(
#         r"^" + re.escape(slot) + r".*?(?=^\S|\Z)", re.MULTILINE | re.DOTALL
#     )
#     m = pattern.search(lspci_vv_full)
#     if not m:
#         return {}
#     chunk = m.group(0)

#     aer_block = _extract_lspci_block(chunk, "Advanced Error Reporting")
#     express_block = _extract_lspci_block(chunk, "Express")

#     uncorrectable_status = _parse_flag_register(get_value(r"UESta:\s*(.*)", aer_block or ""))
#     correctable_status = _parse_flag_register(get_value(r"CESta:\s*(.*)", aer_block or ""))
#     severity = _parse_flag_register(get_value(r"UESvrt:\s*(.*)", aer_block or ""))

#     lnkctl = get_value(r"LnkCtl:\s*(.*)", express_block or "")
#     lnksta = get_value(r"LnkSta:\s*(.*)", express_block or "")

#     aspm = get_value(r"ASPM\s+([A-Za-z0-9+ ]+?)(?:,|\s{2}|$)", lnkctl or "")
#     data_link_active = "DLActive+" in (lnksta or "")
#     l0s_enabled = bool(lnkctl) and "L0s+" in (lnkctl or "") or "ASPM L0s" in (lnkctl or "")
#     l1_enabled = bool(lnkctl) and "L1+" in (lnkctl or "")

#     fatal_flags = {k: v for k, v in uncorrectable_status.items() if v and severity.get(k)}
#     non_fatal_flags = {k: v for k, v in uncorrectable_status.items() if v and not severity.get(k)}
#     correctable_flags = {k: v for k, v in correctable_status.items() if v}

#     fatal_errors_friendly = [_UNCORRECTABLE_AER_FLAG_NAMES.get(k, k) for k in fatal_flags]
#     non_fatal_errors_friendly = [_UNCORRECTABLE_AER_FLAG_NAMES.get(k, k) for k in non_fatal_flags]
#     correctable_errors_friendly = [_CORRECTABLE_AER_FLAG_NAMES.get(k, k) for k in correctable_flags]
#     uncorrectable_errors_friendly = [
#         _UNCORRECTABLE_AER_FLAG_NAMES.get(k, k) for k, v in uncorrectable_status.items() if v
#     ]

#     # Specific, individually addressable AER condition flags -- used for both
#     # JSON exposure and health-engine classification.
#     aer_flags = {
#         "replay_timeout": bool(correctable_status.get("Timeout")),
#         "replay_counter": bool(correctable_status.get("Rollover")),
#         "receiver_overflow": bool(uncorrectable_status.get("RxOF")),
#         "bad_dllp": bool(correctable_status.get("BadDLLP")),
#         "bad_tlp": bool(correctable_status.get("BadTLP")),
#         "malformed_tlp": bool(uncorrectable_status.get("MalfTLP")),
#         "poisoned_tlp": bool(uncorrectable_status.get("TLP")),
#         "unsupported_request": bool(uncorrectable_status.get("UnsupReq")),
#         "completion_timeout": bool(uncorrectable_status.get("CmpltTO")),
#         "completion_abort": bool(uncorrectable_status.get("CmpltAbrt")),
#         "unexpected_completion": bool(uncorrectable_status.get("UnxCmplt")),
#         "flow_control_protocol_error": bool(uncorrectable_status.get("FCP")),
#         "ecrc_error": bool(uncorrectable_status.get("ECRC")),
#     }

#     return {
#         "correctable_error_status": correctable_errors_friendly or None,
#         "uncorrectable_error_status": uncorrectable_errors_friendly or None,
#         "fatal_errors": fatal_errors_friendly or None,
#         "non_fatal_errors": non_fatal_errors_friendly or None,
#         "aer_flags": aer_flags,
#         "aspm_state": aspm,
#         "data_link_layer_active": data_link_active if lnksta else None,
#         "l0s_enabled": l0s_enabled if lnkctl else None,
#         "l1_enabled": l1_enabled if lnkctl else None,
#         "idle_power_management": bool(aspm),
#     }


# def _classify_pcie_health(
#     speed_degraded: bool, width_degraded: bool, aer: dict[str, Any], extended: dict[str, Any]
# ) -> str:
#     """
#     Healthy / Power Saving / Warning / Critical.

#     CRITICAL only for fatal AER / fatal PCIe / fatal uncorrectable errors.
#     WARNING for correctable AER errors, replay timeouts/counters, receiver
#     overflow, bad DLLP/TLP, malformed/poisoned TLP, unsupported request,
#     completion timeout/abort, or link width below maximum.
#     POWER SAVING only when current speed < max speed, width == max width,
#     zero AER/replay errors, no fatal/correctable errors, and ASPM/L0s/L1
#     indicates active power management -- e.g. an idle NVIDIA GPU that has
#     negotiated Gen1 while idle is Power Saving, never Warning.
#     Everything else is Healthy.
#     """
#     aer = aer or {}
#     extended = extended or {}

#     fatal_sysfs = aer.get("fatal") or {}
#     nonfatal_sysfs = aer.get("nonfatal") or {}
#     correctable_sysfs = aer.get("correctable") or {}

#     fatal_sysfs_total = sum(fatal_sysfs.values()) if isinstance(fatal_sysfs, dict) else 0
#     nonfatal_sysfs_total = sum(nonfatal_sysfs.values()) if isinstance(nonfatal_sysfs, dict) else 0
#     correctable_sysfs_total = sum(correctable_sysfs.values()) if isinstance(correctable_sysfs, dict) else 0

#     total_aer_errors = aer.get("total_errors") or 0

#     fatal_flags = extended.get("fatal_errors")
#     non_fatal_flags = extended.get("non_fatal_errors")
#     correctable_flags = extended.get("correctable_error_status")
#     aer_flags = extended.get("aer_flags") or {}

#     # ---- CRITICAL ----
#     if fatal_flags or fatal_sysfs_total > 0:
#         return "Critical"

#     # ---- WARNING ----
#     if (
#         correctable_flags
#         or non_fatal_flags
#         or nonfatal_sysfs_total > 0
#         or correctable_sysfs_total > 0
#         or total_aer_errors > 0
#         or aer_flags.get("replay_timeout")
#         or aer_flags.get("replay_counter")
#         or aer_flags.get("receiver_overflow")
#         or aer_flags.get("bad_dllp")
#         or aer_flags.get("bad_tlp")
#         or aer_flags.get("malformed_tlp")
#         or aer_flags.get("poisoned_tlp")
#         or aer_flags.get("unsupported_request")
#         or aer_flags.get("completion_timeout")
#         or aer_flags.get("completion_abort")
#     ):
#         return "Warning"

#     # ---- POWER SAVING ----
#     if speed_degraded and not width_degraded and total_aer_errors == 0:
#         if extended.get("idle_power_management"):
#             return "Power Saving"
#         return "Healthy"

#     return "Healthy"


# @safe_collect("pcie_link_health", fallback=[])
# def get_pcie_link_health() -> list[dict[str, Any]]:
#     devices: list[dict[str, Any]] = []
#     if not PCI_DEVICES_PATH.exists():
#         return devices

#     desc_map = _pci_descriptions()
#     # Deliberately uses `sudo -n lspci -vv` rather than gating on is_root():
#     # is_root() only checks if this Python process itself is UID 0, so a
#     # non-root user with passwordless sudo configured for lspci was being
#     # wrongly skipped, leaving ASPM state / correctable-error-status /
#     # fatal-error flags permanently absent from every PCIe device's health
#     # block even though the same command works fine interactively. sudo -n
#     # is a no-op prefix when already root, and run() fails safely (empty
#     # string) if elevation isn't available, so this is safe either way.
#     lspci_vv_full = run(["sudo", "-n", "lspci", "-vv"], timeout=LONG_TIMEOUT)

#     for device_dir in sorted(PCI_DEVICES_PATH.iterdir()):
#         addr = device_dir.name

#         cur_speed_raw = read_stripped(device_dir / "current_link_speed")
#         cur_width_raw = read_stripped(device_dir / "current_link_width")
#         max_speed_raw = read_stripped(device_dir / "max_link_speed")
#         max_width_raw = read_stripped(device_dir / "max_link_width")

#         if not any([cur_speed_raw, cur_width_raw, max_speed_raw, max_width_raw]):
#             continue

#         cur_speed = _speed_to_gts(cur_speed_raw)
#         max_speed = _speed_to_gts(max_speed_raw)
#         cur_width = _width_to_int(cur_width_raw)
#         max_width = _width_to_int(max_width_raw)

#         speed_degraded = cur_speed is not None and max_speed is not None and cur_speed < max_speed
#         width_degraded = cur_width is not None and max_width is not None and cur_width < max_width

#         aer = _read_aer_counters(device_dir)
#         extended = _get_pcie_extended_health(addr, lspci_vv_full) if lspci_vv_full else {}
#         status = _classify_pcie_health(speed_degraded, width_degraded, aer, extended)

#         devices.append({
#             "slot": addr,
#             "description": desc_map.get(addr),
#             "kernel_driver": resolve_driver(device_dir),
#             "link_current_speed_gts": cur_speed,
#             "link_max_speed_gts": max_speed,
#             "link_current_width": cur_width,
#             "link_max_width": max_width,
#             "link_speed_below_max": speed_degraded,
#             "link_width_below_max": width_degraded,
#             "aer": aer,
#             "health": {**extended, "status": status},
#         })

#     return devices


# # ============================================================================
# # 15. NVMe HEALTH
# # ============================================================================


# _NVME_SMARTCTL_FIELD_MAP = {
#     "critical_warning": "critical_warning",
#     "temperature": "temperature",
#     "available_spare": "available_spare",
#     "available_spare_threshold": "available_spare_threshold",
#     "percentage_used": "percentage_used",
#     "data_units_read": "data_units_read",
#     "data_units_written": "data_units_written",
#     "host_reads": "host_reads",
#     "host_writes": "host_writes",
#     "controller_busy_time": "controller_busy_time",
#     "power_cycles": "power_cycles",
#     "power_on_hours": "power_on_hours",
#     "unsafe_shutdowns": "unsafe_shutdowns",
#     "media_errors": "media_errors",
#     "num_err_log_entries": "num_err_log_entries",
#     "warning_temp_time": "warning_temp_time",
#     "critical_comp_time": "critical_comp_time",
# }


# @safe_collect("nvme_device_health", fallback={})
# def _get_nvme_device_health(dev_path: str) -> dict[str, Any]:
#     entry: dict[str, Any] = {"device": dev_path}

#     if command_exists("smartctl"):
#         # sudo -n: reading NVMe SMART pages requires elevated privileges on
#         # most distros. Without it, this call silently returns empty output
#         # for a non-root user even when smartctl itself is installed.
#         out = run(["sudo", "-n", "smartctl", "-x", "-j", dev_path], timeout=LONG_TIMEOUT)
#         parsed = None
#         if out.strip():
#             try:
#                 parsed = json.loads(out)
#             except json.JSONDecodeError:
#                 parsed = None

#         if parsed:
#             log = parsed.get("nvme_smart_health_information_log", {})
#             for src_key, dst_key in _NVME_SMARTCTL_FIELD_MAP.items():
#                 value = log.get(src_key)
#                 if isinstance(value, dict):
#                     value = value.get("celsius") if "celsius" in value else value
#                 entry[dst_key] = value
#             entry["smart_status_passed"] = (parsed.get("smart_status", {}) or {}).get("passed")
#             entry["firmware_version"] = null_if_empty((parsed.get("firmware_version")))
#             entry["temperature"] = (
#                 (parsed.get("temperature", {}) or {}).get("current") or entry.get("temperature")
#             )
#             return entry

#     # Fallback: nvme-cli
#     if command_exists("nvme"):
#         json_out = run(["sudo", "-n", "nvme", "smart-log", dev_path, "-o", "json"])
#         try:
#             parsed = json.loads(json_out) if json_out.strip() else {}
#         except json.JSONDecodeError:
#             parsed = {}
#         for _, dst_key in _NVME_SMARTCTL_FIELD_MAP.items():
#             entry.setdefault(dst_key, parsed.get(dst_key))

#     return entry


# @safe_collect("nvme_health", fallback=[])
# def get_nvme_health() -> list[dict[str, Any]]:
#     if not NVME_CLASS_PATH.exists():
#         return []
#     results = []
#     for name in sorted(os.listdir(NVME_CLASS_PATH)):
#         if re.match(r"^nvme\d+$", name):
#             results.append(_get_nvme_device_health(f"/dev/{name}"))
#     return results


# # ============================================================================
# # 16. SATA HEALTH
# # ============================================================================


# _SATA_UNKNOWN_SPEED_VALUES = {"", "<unknown>", "unknown", "none"}


# @safe_collect("sata_health", fallback=[])
# def get_sata_health() -> list[dict[str, Any]]:
#     if not ATA_LINK_CLASS_PATH.exists():
#         return []

#     results = []
#     for name in sorted(os.listdir(ATA_LINK_CLASS_PATH)):
#         link_dir = ATA_LINK_CLASS_PATH / name
#         speed = read_stripped(link_dir / "sata_spd")
#         speed_max = read_stripped(link_dir / "sata_spd_max")

#         # Skip empty ports: no negotiated speed (or an explicit "<unknown>"
#         # placeholder) means no drive is actually connected.
#         if not speed or speed.strip().lower() in _SATA_UNKNOWN_SPEED_VALUES:
#             continue

#         port_name = name.split(".")[0]
#         port_dir = ATA_PORT_CLASS_PATH / port_name
#         reset_count = safe_int(read_stripped(port_dir / "nr_pmp_links")) if port_dir.exists() else None

#         results.append({
#             "link": name,
#             "negotiated_speed": speed,
#             "max_supported_speed": speed_max,
#             "link_degraded": bool(speed_max and speed != speed_max),
#             "link_reset_count": reset_count,
#         })
#     return results


# # ============================================================================
# # 17. USB HEALTH (journalctl -k pattern counting)
# # ============================================================================


# _USB_EVENT_PATTERNS = {
#     "disconnect_events": r"USB disconnect",
#     "reset_events": r"reset (high-speed|full-speed|low-speed|SuperSpeed).*USB device",
#     "enumeration_failures": r"device not accepting address|unable to enumerate",
#     "descriptor_read_failures": r"device descriptor read/(64|8), error",
#     "over_current_events": r"over-current",
#     "hub_errors": r"hub \d+-\d+:.*(error|problem)",
#     "port_reset_failures": r"port reset failed|cannot reset",
# }


# @safe_collect("usb_health", fallback={})
# def get_usb_health(kernel_log: str) -> dict[str, Any]:
#     if not kernel_log:
#         return {}
#     return {
#         field: len(re.findall(pattern, kernel_log, re.IGNORECASE))
#         for field, pattern in _USB_EVENT_PATTERNS.items()
#     }


# @safe_collect("usb_inventory_health", fallback=[])
# def get_usb_link_health() -> list[dict[str, Any]]:
#     if not USB_DEVICES_PATH.exists():
#         return []
#     results = []
#     for name in sorted(os.listdir(USB_DEVICES_PATH)):
#         dev_dir = USB_DEVICES_PATH / name
#         speed = read_stripped(dev_dir / "speed")
#         version = read_stripped(dev_dir / "version")
#         product = read_stripped(dev_dir / "product")
#         if not speed:
#             continue
#         results.append({
#             "device": name,
#             "product": product,
#             "usb_version": version,
#             "negotiated_speed_mbps": safe_int(speed),
#         })
#     return results


# # ============================================================================
# # 18. NIC HEALTH (ethtool -S)
# # ============================================================================


# _NIC_HEALTH_KEYWORDS = [
#     "crc", "align", "frame", "symbol", "phy", "fifo", "missed",
#     "overrun", "carrier", "buffer", "pause", "rx_queue", "tx_queue",
#     "collision",
# ]


# @safe_collect("nic_health_stats", fallback={})
# def _get_nic_ethtool_stats(iface: str) -> dict[str, int]:
#     out = run(["ethtool", "-S", iface])
#     if not out:
#         return {}
#     stats = {}
#     for line in out.splitlines():
#         if ":" not in line:
#             continue
#         key, _, value = line.partition(":")
#         key = key.strip()
#         val = safe_int(value.strip())
#         if val is None:
#             continue
#         if any(kw in key.lower() for kw in _NIC_HEALTH_KEYWORDS):
#             stats[key] = val
#     return stats


# @safe_collect("nic_health", fallback=[])
# def get_nic_health() -> list[dict[str, Any]]:
#     if not NET_CLASS_PATH.exists():
#         return []
#     results = []
#     for name in sorted(os.listdir(NET_CLASS_PATH)):
#         if name == "lo":
#             continue
#         stats_dir = NET_CLASS_PATH / name / "statistics"
#         if not stats_dir.exists():
#             continue

#         basic_errors = {
#             f: safe_int(read_stripped(stats_dir / f))
#             for f in ("rx_errors", "tx_errors", "rx_dropped", "tx_dropped", "collisions")
#         }
#         results.append({
#             "interface": name,
#             "health": {**basic_errors, **_get_nic_ethtool_stats(name)},
#         })
#     return results


# # ============================================================================
# # 19. SYSTEM / KERNEL HARDWARE EVENTS
# # ============================================================================


# _KERNEL_EVENT_PATTERNS = {
#     "machine_check_exception": r"mce:|Machine check",
#     "pcie_bus_error": r"PCIe Bus Error",
#     "pcie_aer": r"AER:",
#     "edac": r"EDAC",
#     "corrected_hardware_error": r"Corrected error",
#     "uncorrectable_hardware_error": r"Uncorrectable Error",
#     "fatal_hardware_error": r"Fatal.*(error|hardware)",
#     "thermal_event": r"thermal.*(throttl|critical|trip)",
#     "nvme_error": r"nvme.*\berror\b|NVMe Error|NVMe.*Media Error",
#     "gpu_xid": r"NVRM: Xid|GPU XID",
#     "usb_reset": r"reset.*USB device",
#     "usb_disconnect": r"USB disconnect",
#     "sata_link_reset": r"ata\d+: (soft|hard)?\s*reset|SATA Reset",
#     "acpi_error": r"ACPI Error",
#     "iommu_fault": r"DMAR:.*fault|IOMMU.*fault|IOMMU Fault",
#     "hardware_failure": r"Hardware Error|hardware failure",
#     "replay_timeout": r"Replay Timeout",
#     "receiver_overflow": r"Receiver Overflow",
#     "malformed_tlp": r"Malformed TLP",
#     "poisoned_tlp": r"Poisoned TLP",
#     "unsupported_request_error": r"Unsupported Request",
#     "usb_enumeration_failure": r"USB Enumeration Failure|unable to enumerate|device not accepting address",
#     "usb_reset_failure": r"USB Reset Failure|port reset failed|cannot reset",
#     "edac_corrected": r"EDAC.*Corrected Error|EDAC Corrected",
#     "edac_uncorrectable": r"EDAC.*Uncorrectable Error|EDAC Uncorrectable",
# }

# # Boot-time / informational noise that must never surface as a hardware
# # warning (device registration, driver init, IRQ assignment, etc).
# _KERNEL_EVENT_IGNORE_SUBSTRINGS = [
#     "enabled",
#     "registered",
#     "version",
#     "giving out device",
#     "mapping bar",
#     "irq",
#     "default domain",
#     "mc:",
#     "aer enabled",
# ]


# def _is_ignorable_kernel_line(line: str) -> bool:
#     lower = line.lower()
#     return any(substr in lower for substr in _KERNEL_EVENT_IGNORE_SUBSTRINGS)


# _TIMESTAMP_RE = re.compile(r"^(\S+\s+\S+\s+\S+|\S+T\S+)")

# # Narrow, specific leading-timestamp matcher used only to strip the
# # timestamp before device-pattern matching (ISO8601 "2026-07-02T10:00:02" or
# # syslog "Jul  2 10:00:02"). Deliberately stricter than _TIMESTAMP_RE (which
# # is kept as-is for the existing "timestamp" field) so it can't accidentally
# # swallow the rest of the line and hide a real device identifier.
# _LEADING_TIMESTAMP_STRIP_RE = re.compile(
#     r"^(?:\d{4}-\d{2}-\d{2}T\S+|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s*"
# )


# def extract_device(line):
#     # Strip any leading timestamp first so timestamp text is never mistaken
#     # for a device identifier (e.g. an ISO date fragment matching a pattern).
#     search_text = line
#     ts_match = _LEADING_TIMESTAMP_STRIP_RE.match(line)
#     if ts_match:
#         search_text = line[ts_match.end():]

#     patterns = [
#         r"([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9])",   # PCI, e.g. 0000:01:00.0
#         r"(nvme\d+n?\d*)",                                  # nvme0, nvme0n1
#         r"(sd[a-z]+\d*)",                                   # sda, sdb1
#         r"(ata\d+)",                                        # ata2
#         r"(usb\d+)",                                        # usb1
#         r"(enp\w+|eno\d+|eth\d+|wlp\w+)",                   # eno1, wlp3s0, enp2s0
#         r"(CPU\d+)",                                        # CPU0
#     ]

#     for p in patterns:
#         m = re.search(p, search_text, re.IGNORECASE)
#         if m:
#             return m.group(1)

#     return None


# @safe_collect("kernel_events", fallback={})
# def get_kernel_events(kernel_log: str) -> dict[str, Any]:
#     if not kernel_log:
#         return {}

#     events: dict[str, list[dict[str, Any]]] = {}
#     lines = kernel_log.splitlines()

#     for category, pattern in _KERNEL_EVENT_PATTERNS.items():
#         matches = []
#         regex = re.compile(pattern, re.IGNORECASE)
#         for line in lines:
#             if _is_ignorable_kernel_line(line):
#                 continue
#             if regex.search(line):
#                 ts_match = _TIMESTAMP_RE.match(line)
#                 severity = "critical" if re.search(r"fatal|panic|critical", line, re.IGNORECASE) else "warning"
#                 matches.append({
#                     "timestamp": ts_match.group(1) if ts_match else None,
#                     "severity": severity,
#                     "device": extract_device(line),
#                     "message": line.strip()[:300],
#                 })
#                 if len(matches) >= MAX_KERNEL_EVENTS_PER_CATEGORY:
#                     break
#         if matches:
#             events[category] = matches

#     return events


# def _get_kernel_log() -> str:
#     """One cached fetch of kernel messages for MCE/USB/kernel-event/GPU-XID
#     parsing, reused across every collector that needs it."""
#     if command_exists("journalctl"):
#         out = run(["journalctl", "-k", "--no-pager", "-o", "short-iso"], timeout=LONG_TIMEOUT)
#         if out.strip():
#             return out
#     return run(["dmesg", "-T"], timeout=LONG_TIMEOUT)


# # ============================================================================
# # 20. MOTHERBOARD HEALTH
# # ============================================================================


# @safe_collect("motherboard_health", fallback={})
# def get_motherboard_health(kernel_events: dict[str, Any], pcie_devices: list[dict[str, Any]]) -> dict[str, Any]:
#     pcie_fatal = sum(1 for d in pcie_devices if (d.get("health") or {}).get("status") == "Critical")
#     pcie_warning = sum(1 for d in pcie_devices if (d.get("health") or {}).get("status") == "Warning")

#     return {
#         "acpi_errors": len(kernel_events.get("acpi_error", [])),
#         "thermal_zone_errors": len(kernel_events.get("thermal_event", [])),
#         "power_faults": len(re.findall(
#             r"power fault|voltage.*(fault|error)", "\n".join(
#                 e.get("message", "") for cat in kernel_events.values() for e in cat
#             ), re.IGNORECASE
#         )) if kernel_events else 0,
#         "pcie_errors": {"critical_links": pcie_fatal, "warning_links": pcie_warning},
#         "chipset_errors": len(re.findall(
#             r"chipset.*error", "\n".join(
#                 e.get("message", "") for cat in kernel_events.values() for e in cat
#             ), re.IGNORECASE
#         )) if kernel_events else 0,
#     }


# # ============================================================================
# # 21. BIOS HEALTH
# # ============================================================================


# @safe_collect("bios_health", fallback={})
# def get_bios_health() -> dict[str, Any]:
#     # Deliberately does NOT gate on is_root() -- that checks whether this
#     # Python process itself is running as root, not whether `sudo -n` will
#     # succeed. A non-root user with passwordless sudo configured for
#     # dmidecode would be wrongly skipped, leaving these fields permanently
#     # null even though `sudo dmidecode -t bios` works fine interactively.
#     # run() already fails safely (empty string) if sudo -n can't
#     # authenticate, so we just let it try.
#     bios = {}
#     if command_exists("dmidecode"):
#         bios = parse_key_value(run(["sudo", "-n", "dmidecode", "-t", "bios"], timeout=LONG_TIMEOUT))

#     secure_boot = None
#     if command_exists("mokutil"):
#         mok_out = run(["mokutil", "--sb-state"])
#         if "enabled" in mok_out.lower():
#             secure_boot = True
#         elif "disabled" in mok_out.lower():
#             secure_boot = False

#     return {
#         "firmware_revision": null_if_empty(bios.get("Firmware Revision")),
#         "bios_version": null_if_empty(bios.get("Version")),
#         "bios_release_date": null_if_empty(bios.get("Release Date")),
#         "uefi_mode": EFI_PATH.exists(),
#         "secure_boot_enabled": secure_boot,
#     }


# # ============================================================================
# # 22. OPTIONAL PLATFORM HEALTH -- IPMI, hwmon
# # ============================================================================


# @safe_collect("ipmi_health", fallback={"supported": False})
# def get_ipmi_health() -> dict[str, Any]:
#     if not command_exists("ipmitool"):
#         return {"supported": False}

#     sensors_out = run(["sudo", "-n", "ipmitool", "sdr", "elist"], timeout=LONG_TIMEOUT)
#     if not sensors_out.strip():
#         return {"supported": False}

#     fans, temps, voltages, psus = [], [], [], []
#     for line in sensors_out.splitlines():
#         parts = [p.strip() for p in line.split("|")]
#         if len(parts) < 5:
#             continue
#         name, _, status = parts[0], parts[2], parts[3]
#         reading = parts[4] if len(parts) > 4 else None
#         entry = {"name": name, "status": status, "reading": reading}
#         lname = name.lower()
#         if "fan" in lname:
#             fans.append(entry)
#         elif "temp" in lname:
#             temps.append(entry)
#         elif any(k in lname for k in ("volt", "vcc", "vbat", "12v", "5v", "3.3v")):
#             voltages.append(entry)
#         elif "psu" in lname or "power supply" in lname:
#             psus.append(entry)

#     sel_out = run(["sudo", "-n", "ipmitool", "sel", "elist"], timeout=LONG_TIMEOUT)
#     sel_entries = [l.strip() for l in sel_out.splitlines() if l.strip()][:MAX_KERNEL_EVENTS_PER_CATEGORY]

#     return {
#         "supported": True,
#         "fan_status": fans or None,
#         "temperature_sensors": temps or None,
#         "voltage_rails": voltages or None,
#         "psu_status": psus or None,
#         "sel_entries": sel_entries or None,
#         "sel_entry_count": len(sel_out.splitlines()) if sel_out else 0,
#     }


# @safe_collect("hwmon_health", fallback=[])
# def get_hwmon_health() -> list[dict[str, Any]]:
#     if not HWMON_CLASS_PATH.exists():
#         return []

#     chips = []
#     for hwmon_dir in sorted(HWMON_CLASS_PATH.iterdir()):
#         chip_name = read_stripped(hwmon_dir / "name")
#         if not chip_name:
#             continue

#         temps, voltages, fans = [], [], []
#         for f in sorted(hwmon_dir.glob("temp*_input")):
#             idx = re.match(r"temp(\d+)_input", f.name).group(1)
#             label = read_stripped(hwmon_dir / f"temp{idx}_label") or f"temp{idx}"
#             value = safe_int(read_stripped(f))
#             if value is not None:
#                 temps.append({"label": label, "celsius": round(value / 1000, 1)})

#         for f in sorted(hwmon_dir.glob("in*_input")):
#             idx = re.match(r"in(\d+)_input", f.name).group(1)
#             label = read_stripped(hwmon_dir / f"in{idx}_label") or f"in{idx}"
#             value = safe_int(read_stripped(f))
#             if value is not None:
#                 voltages.append({"label": label, "millivolts": value})

#         # Fan tachometer readings (RPM). Additive vs. Trial1: on boards with
#         # a bound Super-I/O chip (nct6775, it87, etc.) or a GPU/NVMe fan
#         # exposing fan*_input, this surfaces real spindle speed; on systems
#         # without one it's simply absent, same as the temp/voltage globs
#         # above already handled.
#         for f in sorted(hwmon_dir.glob("fan*_input")):
#             idx = re.match(r"fan(\d+)_input", f.name).group(1)
#             label = read_stripped(hwmon_dir / f"fan{idx}_label") or f"fan{idx}"
#             value = safe_int(read_stripped(f))
#             if value is not None:
#                 fans.append({"label": label, "rpm": value})

#         if temps or voltages or fans:
#             chips.append({
#                 "chip": chip_name,
#                 "temperatures": temps or None,
#                 "voltages": voltages or None,
#                 "fans": fans or None,
#             })

#     return chips


# # ============================================================================
# # 22b. TRIAL2 ADDITIONS -- DMI CHASSIS / VOLTAGE PROBES / COOLING DEVICES /
# #      BATTERY / AC POWER SUPPLY
# # ============================================================================
# #
# # All additive: none of this replaces or removes anything collected above.
# # The DMI (SMBIOS) collectors below give a motherboard-reported view of
# # rails and fans that doesn't depend on a Super-I/O hwmon driver being
# # bound -- useful precisely on the boards where CPU Vcore VRM / EPS 12V /
# # ATX12V / Standby 5VSB show up as "no_data" in the functional block ledger
# # because no in-kernel sensor chip driver claimed the hardware.


# @safe_collect("chassis_inventory", fallback={})
# def get_chassis_inventory() -> dict[str, Any]:
#     """DMI type 3 -- System Enclosure/Chassis. Reports chassis type, asset
#     tag, and (when the board populates them) boot-up/power-supply/thermal/
#     security state -- fields that are genuinely new vs. anything in Trial1,
#     not a re-derivation of the BIOS/system blocks already collected."""
#     if not command_exists("dmidecode"):
#         return {}
#     out = run(["sudo", "-n", "dmidecode", "-t", "chassis"], timeout=LONG_TIMEOUT)
#     if not out:
#         return {}
#     kv = parse_key_value(out)
#     return {
#         "manufacturer": null_if_empty(kv.get("Manufacturer")),
#         "chassis_type": null_if_empty(kv.get("Type")),
#         "asset_tag": null_if_empty(kv.get("Asset Tag")),
#         "serial_number": null_if_empty(kv.get("Serial Number")),
#         "boot_up_state": null_if_empty(kv.get("Boot-up State")),
#         "power_supply_state": null_if_empty(kv.get("Power Supply State")),
#         "thermal_state": null_if_empty(kv.get("Thermal State")),
#         "security_status": null_if_empty(kv.get("Security Status")),
#         "height": null_if_empty(kv.get("Height")),
#         "number_of_power_cords": null_if_empty(kv.get("Number Of Power Cords")),
#     }


# @safe_collect("voltage_probes", fallback=[])
# def get_voltage_probes() -> list[dict[str, Any]]:
#     """DMI type 26 -- Voltage Probe. SMBIOS-level rail descriptors (often
#     labeled things like "VCORE", "+12V", "+5V", "+3.3V", "VBAT"). Many
#     consumer boards report these as "Unknown"/"Unavailable" if the BIOS
#     never wired the probe up, in which case this is correctly empty --
#     but on boards that do populate it, this is real rail data that the
#     hwmon-only path (no bound Super-I/O driver) can't otherwise surface."""
#     if not command_exists("dmidecode"):
#         return []
#     out = run(["sudo", "-n", "dmidecode", "-t", "26"], timeout=LONG_TIMEOUT)
#     if not out:
#         return []
#     probes = []
#     for block in out.split("Voltage Probe"):
#         if "Description" not in block and "Location" not in block:
#             continue
#         status = null_if_empty(get_value(r"Status:\s+(.*)", block))
#         if status is None:
#             continue
#         probes.append({
#             "description": null_if_empty(get_value(r"Description:\s+(.*)", block)),
#             "location": null_if_empty(get_value(r"Location:\s+(.*)", block)),
#             "status": status,
#             "nominal_value": null_if_empty(get_value(r"Nominal Value:\s+(.*)", block)),
#             "max_value": null_if_empty(get_value(r"Maximum Value:\s+(.*)", block)),
#             "min_value": null_if_empty(get_value(r"Minimum Value:\s+(.*)", block)),
#         })
#     return probes


# @safe_collect("cooling_devices", fallback=[])
# def get_cooling_devices() -> list[dict[str, Any]]:
#     """DMI type 27 -- Cooling Device. SMBIOS-level fan/cooling probes,
#     including nominal RPM when the board reports it. Complements (not a
#     duplicate of) the hwmon fan*_input readings in get_hwmon_health(),
#     since boards frequently expose one but not the other."""
#     if not command_exists("dmidecode"):
#         return []
#     out = run(["sudo", "-n", "dmidecode", "-t", "27"], timeout=LONG_TIMEOUT)
#     if not out:
#         return []
#     devices = []
#     for block in out.split("Cooling Device"):
#         if "Type" not in block and "Status" not in block:
#             continue
#         status = null_if_empty(get_value(r"Status:\s+(.*)", block))
#         if status is None:
#             continue
#         devices.append({
#             "description": null_if_empty(get_value(r"Description:\s+(.*)", block)),
#             "device_type": null_if_empty(get_value(r"^\s*Type:\s+(.*)$", block)),
#             "status": status,
#             "nominal_speed_rpm": null_if_empty(get_value(r"Nominal Speed:\s+(.*)", block)),
#         })
#     return devices


# @safe_collect("battery_health", fallback={"present": False})
# def get_battery_health() -> dict[str, Any]:
#     """/sys/class/power_supply BAT* -- battery presence/charge/health.
#     A correct no-op ({"present": False}) on desktops/workstations with no
#     battery; genuinely new data on laptops."""
#     if not POWER_SUPPLY_CLASS_PATH.exists():
#         return {"present": False}
#     batteries = []
#     for name in sorted(os.listdir(POWER_SUPPLY_CLASS_PATH)):
#         if not name.upper().startswith("BAT"):
#             continue
#         d = POWER_SUPPLY_CLASS_PATH / name
#         batteries.append({
#             "name": name,
#             "status": read_stripped(d / "status"),
#             "capacity_percent": safe_int(read_stripped(d / "capacity")),
#             "health": read_stripped(d / "health") or read_stripped(d / "capacity_level"),
#             "cycle_count": safe_int(read_stripped(d / "cycle_count")),
#             "technology": read_stripped(d / "technology"),
#             "voltage_now_mv": bytes_to_kb(read_stripped(d / "voltage_now")) if read_stripped(d / "voltage_now") else None,
#             "manufacturer": read_stripped(d / "manufacturer"),
#             "model_name": read_stripped(d / "model_name"),
#         })
#     if not batteries:
#         return {"present": False}
#     return {"present": True, "batteries": batteries}


# @safe_collect("power_supply_status", fallback={})
# def get_power_supply_status() -> dict[str, Any]:
#     """/sys/class/power_supply Mains/ADP*/AC* -- AC adapter online state.
#     Distinct from get_battery_health(): this is the wall-power side, not
#     the cell. Empty dict (pruned away) on systems with neither node."""
#     if not POWER_SUPPLY_CLASS_PATH.exists():
#         return {}
#     adapters = []
#     for name in sorted(os.listdir(POWER_SUPPLY_CLASS_PATH)):
#         d = POWER_SUPPLY_CLASS_PATH / name
#         ptype = read_stripped(d / "type")
#         if ptype not in ("Mains", "USB", "Wireless") and not name.upper().startswith(("AC", "ADP")):
#             continue
#         adapters.append({
#             "name": name,
#             "type": ptype,
#             "online": read_stripped(d / "online"),
#         })
#     return {"adapters": adapters} if adapters else {}


# # ============================================================================
# # IOMMU
# # ============================================================================


# @safe_collect("iommu_summary", fallback={"enabled": False})
# def get_iommu_summary() -> dict[str, Any]:
#     if not IOMMU_GROUPS_PATH.exists():
#         return {"enabled": False}
#     groups = [g for g in os.listdir(IOMMU_GROUPS_PATH) if g.isdigit()]
#     total_devices = 0
#     for g in groups:
#         dev_dir = IOMMU_GROUPS_PATH / g / "devices"
#         if dev_dir.exists():
#             total_devices += len(os.listdir(dev_dir))
#     return {"enabled": True, "group_count": len(groups), "device_count": total_devices}


# # ============================================================================
# # 23. INTERNAL FUNCTIONAL BLOCK LEDGER
# # ============================================================================
# #
# # Every named "Internal Functional Block" from the hardware component table
# # (CPU, RAM, GPU, IO_Controller, MGMT, NIC, PSU, Disk) mapped to the real
# # Linux/Ubuntu command(s) that inspect it. Purely physical wiring blocks
# # (Molex, 12VHPWR, PCIe slot power pins, etc.) have no OS-visible interface
# # and are marked NOT_QUERYABLE instead of faking a reading.
# #
# # This ledger is collected fresh every link-health cycle via the same
# # cached/safe `run()` helper used everywhere else in this file, so it never
# # raises and never adds an unbounded subprocess per request.

# NOT_QUERYABLE = "NOT OS-QUERYABLE (physical connector/rail -- no software interface exists)"

# BLOCK_REGISTRY: dict[str, dict[str, list[tuple[str, Any]]]] = {
#     "CPU": {
#         "DDR5 Memory Bus": [("dmidecode memory type/speed", ["sudo", "-n", "dmidecode", "-t", "memory"])],
#         "Multi-Channel Memory Controller": [("memory channel layout", ["sudo", "-n", "dmidecode", "-t", "16"])],
#         "PCIe Gen5 x16": [("PCIe link speed/width (CPU root port)", ["bash", "-c", "sudo -n lspci -vv 2>/dev/null | grep -B5 -A15 -i 'VGA\\|3D controller' | grep -i 'LnkCap\\|LnkSta'"])],
#         "PCIe x8/x16": [("PCIe link speed/width (all devices)", ["bash", "-c", "sudo -n lspci -vv 2>/dev/null | grep -i 'LnkCap\\|LnkSta'"])],
#         "PCIe/NVMe Interface": [("NVMe devices over PCIe", ["bash", "-c", "lspci | grep -i nvme"])],
#         "DMI (Direct Media Interface)": [("PCI topology / chipset link", ["lspci", "-tv"])],
#         "VRM Power Rail": [("voltage rails via sensors", ["sensors"])],
#         "CPU Vcore VRM": [
#             ("CPU core voltage", ["bash", "-c", "sensors | grep -i vcore"]),
#             ("hwmon voltage inputs (Vcore fallback)", ["bash", "-c",
#                 "for f in /sys/class/hwmon/*/in*_input; do d=$(dirname $f); i=$(basename $f _input); "
#                 "l=$(cat $d/${i}_label 2>/dev/null || echo $i); echo \"$l: $(cat $f 2>/dev/null) mV\"; done"]),
#             ("SMBIOS voltage probe (DMI type 26)", ["sudo", "-n", "dmidecode", "-t", "26"]),
#             ("Intel MSR core voltage -- IA32_PERF_STATUS bits 47:32, 1/8192 V units (requires msr-tools + msr module)",
#                 ["bash", "-c", "sudo -n modprobe msr 2>/dev/null; sudo -n rdmsr -p 0 -f 47:32 -d 0x198 2>/dev/null"]),
#         ],
#         "EPS 12V": [
#             ("12V rail via sensors/IPMI", ["bash", "-c", "sensors | grep -i 12v; sudo -n ipmitool sensor 2>/dev/null | grep -i 12v"]),
#             ("SMBIOS voltage probe (DMI type 26)", ["sudo", "-n", "dmidecode", "-t", "26"]),
#             ("System Power Supply record cross-reference (DMI type 39 -- links to the Input Voltage Probe Handle feeding this rail)",
#                 ["sudo", "-n", "dmidecode", "-t", "39"]),
#         ],
#         "SMBus": [("SMBus controller/adapters", ["bash", "-c", "lspci | grep -i smbus; i2cdetect -l"])],
#         "LPC Bus": [("LPC/ISA bridge", ["bash", "-c", "lspci -nn | grep -i 'isa bridge\\|lpc'"])],
#         "eSPI Bus": [
#             ("eSPI (rarely OS-visible)", ["bash", "-c", "sudo -n dmesg 2>/dev/null | grep -i espi"]),
#             ("eSPI in kernel ring buffer (journalctl fallback)", ["bash", "-c", "journalctl -k --no-pager 2>/dev/null | grep -i espi"]),
#             ("LPC/ISA bridge fallback -- pre-eSPI/legacy platforms surface the same low-pin-count bus as an ISA bridge device",
#                 ["bash", "-c", "lspci -nn 2>/dev/null | grep -i 'isa bridge\\|lpc\\|espi'"]),
#         ],
#     },
#     "Disk": {
#         "PCIe/NVMe Interface": [("NVMe controllers", ["nvme", "list"])],
#         "NVMe Command Queue": [
#             ("NVMe queue count/depth", ["bash", "-c", "for d in /dev/nvme*n1; do [ -e $d ] && sudo -n nvme id-ctrl $d 2>/dev/null | grep -i 'sqes\\|cqes\\|maxcmd'; done"]),
#             ("sysfs queue depth (nr_requests) fallback", ["bash", "-c", "for f in /sys/block/nvme*/queue/nr_requests; do echo \"$f: $(cat $f 2>/dev/null)\"; done"]),
#             ("controller register queue capabilities -- CAP.MQES (max queue entries supported)",
#                 ["bash", "-c", "for d in /dev/nvme[0-9]*; do case \"$d\" in *n1) continue;; esac; [ -e \"$d\" ] && echo == $d == && sudo -n nvme show-regs $d 2>/dev/null; done"]),
#         ],
#         "GPU Direct Storage (GDS)": [("nvidia-fs kernel module", ["bash", "-c", "lsmod | grep -i nvidia_fs; cat /proc/driver/nvidia-fs/stats 2>/dev/null"])],
#         "DMA Engine": [("legacy DMA channels", ["cat", "/proc/dma"])],
#         "DMA Transfers": [("block device I/O stats", ["bash", "-c", "iostat -x 2>/dev/null || cat /proc/diskstats"])],
#         "SATA Controller": [("SATA/AHCI controller", ["bash", "-c", "lspci -nnk | grep -i sata"])],
#         "SAS Controller": [("SAS HBA controller", ["bash", "-c", "lspci -nnk | grep -i sas"])],
#         "SATA Port": [("ATA port list", ["bash", "-c", "ls /sys/class/ata_port/ 2>/dev/null"])],
#         "SAS Port": [("SAS device list", ["lsscsi"])],
#         "SATA Power": [("drive power/standby state", ["bash", "-c", "for d in /dev/sd?; do echo $d:; sudo -n hdparm -C $d 2>/dev/null; done"])],
#         "Molex Power": [("physical connector", NOT_QUERYABLE)],
#         "SMART Interface": [("SMART-capable devices", ["smartctl", "--scan"])],
#     },
#     "GPU": {
#         "PCIe Gen5 x16": [("GPU link speed/width", ["bash", "-c", "lspci -vv -d ::0300 2>/dev/null; lspci -vv -d ::0302 2>/dev/null"])],
#         "PCIe Switch Fabric": [("PCIe topology tree", ["lspci", "-tv"])],
#         "PCIe Power (6-pin/8-pin)": [("physical connector", NOT_QUERYABLE)],
#         "12VHPWR Power": [
#             ("draw only, not connector type", ["bash", "-c", "nvidia-smi -q -d POWER 2>/dev/null"]),
#             ("direct instantaneous/average power draw query (bypasses the full -q dump)",
#                 ["nvidia-smi", "--query-gpu=power.draw,power.draw.average,power.draw.instant,power.limit", "--format=csv,noheader"]),
#         ],
#         "GPU Direct Storage (GDS)": [("nvidia-fs module", ["bash", "-c", "lsmod | grep -i nvidia_fs"])],
#         "PCIe DMA": [
#             ("DMA capability in PCIe config space", ["bash", "-c", "lspci -vv -d ::0300 2>/dev/null | grep -i dma"]),
#             ("IOMMU/DMAR fault or remapping log entries referencing the GPU's PCI bus address",
#                 ["bash", "-c", "gpu_bdf=$(lspci -d ::0300 2>/dev/null | awk 'NR==1{print $1}'); [ -n \"$gpu_bdf\" ] && journalctl -k --no-pager 2>/dev/null | grep -i \"$gpu_bdf\\|dmar\\|iommu\""]),
#         ],
#         "BAR Registers (MMIO BAR)": [("PCI BAR memory regions", ["bash", "-c", "lspci -vv -d ::0300 2>/dev/null | grep -i 'region\\|memory at'"])],
#         "RDMA": [("RDMA devices", ["bash", "-c", "which ibv_devices >/dev/null 2>&1 && ibv_devices; rdma link 2>/dev/null"])],
#         "GPU Direct RDMA": [("nvidia_peermem module", ["bash", "-c", "lsmod | grep -i peermem"])],
#         "I2C Bus": [("I2C adapters", ["i2cdetect", "-l"])],
#         "Thermal Sensors": [("GPU temperature", ["bash", "-c", "nvidia-smi -q -d TEMPERATURE 2>/dev/null; sensors"])],
#         "TPM Interface": [("TPM device node", ["bash", "-c", "ls -l /dev/tpm* 2>/dev/null"])],
#     },
#     "IO_Controller": {
#         "PCIe Switch Fabric": [("PCIe topology tree", ["lspci", "-tv"])],
#         "PCIe Lanes": [("link width/speed per device", ["bash", "-c", "sudo -n lspci -vv 2>/dev/null | grep -i 'lnkcap\\|lnksta'"])],
#         "MMIO Mapping": [("system memory-mapped I/O map", ["cat", "/proc/iomem"])],
#         "BAR Registers (MMIO BAR)": [("all device BARs", ["bash", "-c", "lspci -vv | grep -i 'memory at'"])],
#         "DMI (Direct Media Interface)": [("chipset/root complex link", ["lspci", "-tv"])],
#         "SATA Controller": [("SATA controller in chipset", ["bash", "-c", "lspci -nnk | grep -i sata"])],
#         "SAS Controller": [
#             ("SAS controller", ["bash", "-c", "lspci -nnk | grep -i sas"]),
#             ("SAS HBA via PCI class code 0107 (cleaner detection than name grep -- catches HBAs whose string ID omits 'SAS')",
#                 ["bash", "-c", "lspci -d ::0107 2>/dev/null"]),
#         ],
#         "Chipset Power Rail": [
#             ("chipset voltage via sensors (if exposed)", ["sensors"]),
#             ("SMBIOS voltage probe (DMI type 26)", ["sudo", "-n", "dmidecode", "-t", "26"]),
#         ],
#         "eSPI Bus": [
#             ("eSPI trace in kernel log", ["bash", "-c", "sudo -n dmesg 2>/dev/null | grep -i espi"]),
#             ("eSPI in kernel ring buffer (journalctl fallback)", ["bash", "-c", "journalctl -k --no-pager 2>/dev/null | grep -i espi"]),
#             ("LPC/ISA bridge fallback -- pre-eSPI/legacy platforms surface the same low-pin-count bus as an ISA bridge device",
#                 ["bash", "-c", "lspci -nn 2>/dev/null | grep -i 'isa bridge\\|lpc\\|espi'"]),
#         ],
#         "BIOS Region": [("BIOS/firmware info", ["sudo", "-n", "dmidecode", "-t", "bios"])],
#         "Chassis State (DMI)": [("chassis boot-up/power/thermal state", ["sudo", "-n", "dmidecode", "-t", "3"])],
#     },
#     "MGMT": {
#         "SMBus": [("SMBus/I2C adapters", ["i2cdetect", "-l"])],
#         "SPI Flash": [("SPI bus devices", ["bash", "-c", "ls /sys/bus/spi/devices 2>/dev/null; dmesg | grep -i spi"])],
#         "I2C Bus": [("I2C adapters", ["i2cdetect", "-l"])],
#         "I2C Thermal Bus": [("sensors over I2C", ["sensors"])],
#         "LPC Bus": [("LPC/ISA bridge", ["bash", "-c", "lspci -nn | grep -i 'isa bridge'"])],
#         "PMBus": [
#             ("PMBus devices via I2C / IPMI", ["bash", "-c", "i2cdetect -l; sudo -n ipmitool sensor 2>/dev/null"]),
#             ("bound pmbus kernel driver check -- confirms whether any device is actually claimed by the pmbus hwmon driver",
#                 ["bash", "-c", "ls /sys/bus/i2c/drivers/pmbus/ 2>/dev/null"]),
#         ],
#         "Thermal Sensors": [("all thermal sensors", ["bash", "-c", "sensors; sudo -n ipmitool sensor 2>/dev/null | grep -i temp"])],
#         "TPM Sensor": [("TPM presence/capabilities", ["bash", "-c", "ls -l /dev/tpm* 2>/dev/null; tpm2_getcap properties-fixed 2>/dev/null"])],
#         "Dedicated IPMI Port": [
#             ("BMC LAN configuration", ["sudo", "-n", "ipmitool", "lan", "print"]),
#             ("IPMI device presence per SMBIOS (DMI type 38) regardless of driver binding -- confirms hardware absence vs. just no driver",
#                 ["sudo", "-n", "dmidecode", "-t", "38"]),
#         ],
#         "Firmware Flash": [("firmware/BIOS info + updatable devices", ["bash", "-c", "sudo -n dmidecode -t bios; fwupdmgr get-devices 2>/dev/null"])],
#         "Chassis State (DMI)": [("chassis boot-up/power/thermal/security state", ["sudo", "-n", "dmidecode", "-t", "3"])],
#         "Cooling Device (DMI)": [("SMBIOS fan/cooling probes incl. nominal RPM", ["sudo", "-n", "dmidecode", "-t", "27"])],
#     },
#     "NIC": {
#         "PCIe x8/x16": [("NIC link speed/width", ["bash", "-c",
#             "sudo -n lspci -vv 2>/dev/null | awk 'BEGIN{RS=\"\"} tolower($0) ~ /ethernet|network controller|wireless|802\\.11/ {print}' | grep -i 'lnkcap\\|lnksta'"])],
#         "PCIe Lanes": [("same as above, all NICs", ["bash", "-c",
#             "sudo -n lspci -vv 2>/dev/null | awk 'BEGIN{RS=\"\"} tolower($0) ~ /ethernet|network controller|wireless|802\\.11/ {print}' | grep -i lnk"])],
#         "PCIe Slot": [
#             ("physical slot ID for NIC (matched by PCI bus address, not name)", ["bash", "-c",
#                 "for id in $(lspci -D 2>/dev/null | grep -iE 'ethernet|network controller|wireless|802\\.11' | cut -d' ' -f1); do "
#                 "sudo -n dmidecode -t 9 2>/dev/null | awk -v RS='' -v addr=\"$id\" '$0 ~ addr {print; found=1} END{exit !found}' && echo '---'; "
#                 "done"]),
#             ("physical slot reported directly by the device's own PCIe capability (lspci 'Physical Slot' field) -- works even for on-package/soldered NICs absent from the DMI slot table",
#                 ["bash", "-c",
#                     "sudo -n lspci -vv 2>/dev/null | awk 'BEGIN{RS=\"\"} tolower($0) ~ /ethernet|network controller|wireless|802\\.11/ {print}' | grep -i 'physical slot'"]),
#         ],
#         "PCIe Slot Power": [("slot power budget (dmidecode)", ["sudo", "-n", "dmidecode", "-t", "slot"])],
#         "DMA Ring Buffers": [("NIC ring buffer sizes (per interface)", ["bash", "-c", "for i in $(ls /sys/class/net | grep -v lo); do echo == $i ==; ethtool -g $i 2>/dev/null; done"])],
#         "RDMA": [("RDMA-capable NICs", ["bash", "-c", "which ibv_devices >/dev/null 2>&1 && ibv_devices; rdma link 2>/dev/null"])],
#         "GPU Direct RDMA": [("peermem module for GPUDirect", ["bash", "-c", "lsmod | grep -i peermem"])],
#         "BMC Shared NIC": [
#             ("check if a NIC is shared with BMC", ["sudo", "-n", "ipmitool", "lan", "print"]),
#             ("IPMI/BMC presence per SMBIOS (DMI type 38) + LAN channel config -- confirms hardware absence vs. just no driver/no BMC configured",
#                 ["bash", "-c", "sudo -n dmidecode -t 38 2>/dev/null; sudo -n ipmitool lan print 2>/dev/null"]),
#         ],
#         "Dedicated IPMI Port": [
#             ("dedicated mgmt interface", ["bash", "-c", "sudo -n ipmitool lan print; ip link show"]),
#             ("IPMI device presence per SMBIOS (DMI type 38) regardless of driver binding -- confirms hardware absence vs. just no driver",
#                 ["sudo", "-n", "dmidecode", "-t", "38"]),
#         ],
#     },
#     "PSU": {
#         "PCIe Slot Power": [("max power per slot", ["sudo", "-n", "dmidecode", "-t", "slot"])],
#         "12VHPWR Power": [
#             ("draw only, not wiring", ["bash", "-c", "nvidia-smi -q -d POWER 2>/dev/null"]),
#             ("direct instantaneous/average power draw query (bypasses the full -q dump)",
#                 ["nvidia-smi", "--query-gpu=power.draw,power.draw.average,power.draw.instant,power.limit", "--format=csv,noheader"]),
#         ],
#         "Molex Power": [("physical connector", NOT_QUERYABLE)],
#         "EPS 12V": [
#             ("12V rail via sensors/IPMI", ["bash", "-c", "sensors | grep -i 12v; sudo -n ipmitool sensor 2>/dev/null | grep -i 12v"]),
#             ("SMBIOS voltage probe (DMI type 26)", ["sudo", "-n", "dmidecode", "-t", "26"]),
#             ("System Power Supply record cross-reference (DMI type 39 -- links to the Input Voltage Probe Handle feeding this rail)",
#                 ["sudo", "-n", "dmidecode", "-t", "39"]),
#         ],
#         "ATX12V": [
#             ("12V rail via sensors/IPMI", ["bash", "-c", "sensors | grep -i 12v"]),
#             ("SMBIOS voltage probe (DMI type 26)", ["sudo", "-n", "dmidecode", "-t", "26"]),
#             ("System Power Supply record cross-reference (DMI type 39 -- links to the Input Voltage Probe Handle feeding this rail)",
#                 ["sudo", "-n", "dmidecode", "-t", "39"]),
#         ],
#         "Motherboard 24-pin ATX": [("system power supply info", ["sudo", "-n", "dmidecode", "-t", "39"])],
#         "Standby 5VSB": [
#             ("5V standby rail", ["bash", "-c", "sensors | grep -i 5v"]),
#             ("AC adapter / mains online state (laptop 5VSB proxy)", ["bash", "-c",
#                 "for f in /sys/class/power_supply/*/online; do [ -e $f ] || continue; echo $f: $(cat $f 2>/dev/null); done"]),
#             ("ACPI sleep-state / wake-source support as an indirect standby-rail activity indicator (desktops without a dedicated 5VSB sensor)",
#                 ["bash", "-c", "cat /sys/power/mem_sleep 2>/dev/null; cat /proc/acpi/wakeup 2>/dev/null | head -20"]),
#         ],
#         "PMBus": [
#             ("PMBus devices", ["bash", "-c", "i2cdetect -l; sudo -n ipmitool sensor 2>/dev/null"]),
#             ("bound pmbus kernel driver check -- confirms whether any device is actually claimed by the pmbus hwmon driver",
#                 ["bash", "-c", "ls /sys/bus/i2c/drivers/pmbus/ 2>/dev/null"]),
#         ],
#         "PMBus Alerts": [
#             ("power-related events in system event log", ["sudo", "-n", "ipmitool", "sel", "list"]),
#             ("PMBus fault/alarm flags directly from a bound pmbus hwmon device, if one exists",
#                 ["bash", "-c",
#                     "for d in /sys/bus/i2c/drivers/pmbus/*/hwmon/hwmon*/; do [ -d \"$d\" ] || continue; echo == $d ==; cat $d*_alarm 2>/dev/null; done"]),
#         ],
#         "Voltage Probes (DMI)": [("SMBIOS voltage rail probes", ["sudo", "-n", "dmidecode", "-t", "26"])],
#         "Cooling Device (DMI)": [("SMBIOS fan/cooling probes incl. nominal RPM", ["sudo", "-n", "dmidecode", "-t", "27"])],
#         "Battery": [("battery presence/charge/health (/sys/class/power_supply)", ["bash", "-c",
#             "for d in /sys/class/power_supply/BAT*; do [ -d $d ] && echo == $(basename $d) == && cat $d/status $d/capacity $d/health 2>/dev/null; done"])],
#     },
#     "RAM": {
#         "DDR5 Memory Bus": [("memory type/speed", ["sudo", "-n", "dmidecode", "-t", "memory"])],
#         "NVMe BAR Region": [("NVMe device memory regions", ["bash", "-c", "lspci -vv | grep -B5 -i nvme | grep -i 'memory at'"])],
#         "DMA Engine": [("legacy DMA channels", ["cat", "/proc/dma"])],
#         "DMA Ring Buffers": [("NIC ring buffers (memory-backed)", ["bash", "-c", "for i in $(ls /sys/class/net | grep -v lo); do ethtool -g $i 2>/dev/null; done"])],
#         "MMIO Mapping": [("system memory map", ["cat", "/proc/iomem"])],
#         "BAR0/BAR1/BAR2 Mapping": [("device BAR mappings", ["bash", "-c", "lspci -vv | grep -i 'region '"])],
#         "VRM Power Rail": [("voltage rails", ["sensors"])],
#         "SPI / I2C": [("I2C adapters (SPD bus)", ["i2cdetect", "-l"])],
#         "SPD EEPROM": [("module manufacturer/part/serial from SPD", ["bash", "-c", "sudo -n dmidecode -t memory | grep -i 'manufacturer\\|part number\\|serial'"])],
#     },
# }


# _BLOCK_WARNING_KEYWORDS = re.compile(
#     r"\b(error|errors|fault|faults|failed|failure|critical|uncorrectable|"
#     r"over-current|overcurrent|degraded|reset failed|timeout)\b",
#     re.IGNORECASE,
# )
# # Strips both confirmed-zero statements ("0 errors") AND dmidecode/lspci
# # schema *labels* that happen to contain the word "Error" as part of their
# # field name rather than as a reported fault (e.g. "Error Correction Type:
# # None" or "Error Information Handle: Not Provided" from `dmidecode -t
# # memory`/`-t bios`). Without this, DDR5/BIOS blocks get spuriously flagged
# # "warning" on every run just because the DMI spec names a field that way.
# _BLOCK_BENIGN_ZERO_RE = re.compile(
#     r"\b(0|none|no)\s+(errors?|faults?|failures?)\b"
#     r"|Error Correction Type:\s*\S+"
#     r"|Error Information Handle:\s*\S[\S ]*",
#     re.IGNORECASE,
# )


# def _classify_block_output(output: str) -> Optional[str]:
#     """Conservative heuristic classification for raw diagnostic ledger text.
#     Returns 'warning' if a warning-ish keyword is present outside a
#     confirmed-zero statement, else None. Deliberately never returns
#     'critical' on its own -- these commands emit free-form text, not
#     structured counters, so severity is left to the quantitative health
#     engine above; this is a "worth a look" flag, not a fault verdict."""
#     if not output:
#         return None
#     stripped = _BLOCK_BENIGN_ZERO_RE.sub("", output)
#     return "warning" if _BLOCK_WARNING_KEYWORDS.search(stripped) else None


# def _block_cmd_timeout(cmd) -> int:
#     joined = " ".join(cmd) if isinstance(cmd, list) else str(cmd)
#     if "-vv" in joined or "smartctl" in joined or "id-ctrl" in joined or "iostat" in joined:
#         return LONG_TIMEOUT
#     return DEFAULT_TIMEOUT


# @safe_collect("functional_block_entry", fallback=None)
# def _run_functional_block_command(label: str, cmd: Any) -> dict[str, Any]:
#     if cmd == NOT_QUERYABLE:
#         return {"label": label, "status": "not_queryable", "output": None, "note": NOT_QUERYABLE}

#     binary = cmd[0]
#     if binary != "bash" and not command_exists(binary):
#         return {
#             "label": label,
#             "status": "unavailable",
#             "output": None,
#             "note": f"'{binary}' not installed. Install with:\n    {INSTALL_HINT}",
#         }

#     output = run(cmd, timeout=_block_cmd_timeout(cmd), use_cache=True).strip()
#     if not output:
#         return {"label": label, "status": "no_data", "output": None, "note": None}

#     return {
#         "label": label,
#         "status": _classify_block_output(output) or "ok",
#         "output": output[:1500],
#         "note": None,
#     }


# @safe_collect("functional_blocks", fallback={})
# def collect_functional_blocks() -> dict[str, Any]:
#     """
#     Internal Functional Block Ledger.

#     Walks BLOCK_REGISTRY (CPU / RAM / GPU / IO_Controller / MGMT / NIC / PSU
#     / Disk) and, for every named internal functional block, runs every
#     mapped diagnostic command through the shared `run()` cache/timeout/
#     safe-exec helper -- so results from commands shared with the
#     quantitative collectors above (lspci -vv, dmidecode -t memory, sensors,
#     etc.) are reused rather than re-executed within the same cycle.

#     Additive to, not a replacement for, the counter-based health engine:
#     this ledger gives raw human-readable per-block diagnostic text for
#     deeper inspection, with a conservative 'ok' / 'warning' heuristic
#     layered on top; it never overrides overall_health or score.
#     """
#     ledger: dict[str, Any] = {}
#     for category, blocks in BLOCK_REGISTRY.items():
#         category_result: dict[str, Any] = {}
#         for block_name, cmd_list in blocks.items():
#             entries = []
#             for label, cmd in cmd_list:
#                 entry = _run_functional_block_command(label, cmd)
#                 if entry:
#                     entries.append(entry)
#             if not entries:
#                 continue

#             statuses = {e["status"] for e in entries}
#             if "warning" in statuses:
#                 block_status = "warning"
#             elif "ok" in statuses:
#                 block_status = "ok"
#             elif statuses == {"not_queryable"}:
#                 block_status = "not_queryable"
#             else:
#                 block_status = "unavailable"

#             category_result[block_name] = {"status": block_status, "commands": entries}

#         if category_result:
#             ledger[category] = category_result
#     return ledger


# # ============================================================================
# # 24. HEALTH ENGINE
# # ============================================================================


# def _flatten_messages(kernel_events: dict[str, Any]) -> list[str]:
#     return [e.get("message", "") for cat in kernel_events.values() for e in cat]


# @safe_collect("health_summary", fallback={})
# def compute_health_summary(report: dict[str, Any]) -> dict[str, Any]:
#     critical_alerts: list[str] = []
#     warnings: list[str] = []
#     informational: list[str] = []
#     diagnostic_notes: list[str] = []
#     components_checked = 0
#     components_with_warnings = 0
#     components_with_errors = 0

#     def flag(component: str, condition: bool, severity: str, message: str):
#         nonlocal components_with_warnings, components_with_errors
#         if not condition:
#             return
#         if severity == "critical":
#             critical_alerts.append(f"[{component}] {message}")
#         else:
#             warnings.append(f"[{component}] {message}")

#     # --- PCIe ---
#     for dev in report.get("pcie", []) or []:
#         components_checked += 1
#         health = dev.get("health") or {}
#         status = health.get("status")
#         slot = dev.get("slot")
#         aer_flags = health.get("aer_flags") or {}
#         width_degraded = dev.get("link_width_below_max")

#         if status == "Critical":
#             components_with_errors += 1
#             flag("pcie", True, "critical", f"{slot} fatal PCIe error")
#         elif status == "Warning":
#             components_with_warnings += 1
#             if aer_flags.get("replay_timeout"):
#                 flag("pcie", True, "warning", f"{slot} Replay Timeout detected")
#             elif aer_flags.get("receiver_overflow"):
#                 flag("pcie", True, "warning", f"{slot} Receiver Overflow detected")
#             elif aer_flags.get("malformed_tlp"):
#                 flag("pcie", True, "warning", f"{slot} Malformed TLP detected")
#             elif aer_flags.get("poisoned_tlp"):
#                 flag("pcie", True, "warning", f"{slot} Poisoned TLP detected")
#             elif aer_flags.get("unsupported_request"):
#                 flag("pcie", True, "warning", f"{slot} Unsupported Request detected")
#             elif aer_flags.get("bad_dllp"):
#                 flag("pcie", True, "warning", f"{slot} Bad DLLP detected")
#             elif aer_flags.get("bad_tlp"):
#                 flag("pcie", True, "warning", f"{slot} Bad TLP detected")
#             elif width_degraded:
#                 flag("pcie", True, "warning", f"{slot} PCIe Link Width reduced")
#             else:
#                 flag("pcie", True, "warning", f"{slot} PCIe correctable/replay errors present")
#         elif status == "Power Saving":
#             informational.append(f"[pcie] {slot} operating in ASPM power saving state")

#     # --- NVMe ---
#     for dev in report.get("nvme", []) or []:
#         components_checked += 1
#         device_name = dev.get("device")

#         cw = dev.get("critical_warning")
#         if cw not in (None, 0, "0", "0x00"):
#             components_with_errors += 1
#             flag("nvme", True, "critical", f"{device_name} SSD Critical Warning flag set")

#         if (dev.get("media_errors") or 0) not in (None, 0):
#             components_with_errors += 1
#             flag("nvme", True, "critical", f"{device_name} NVMe Media Errors detected")

#         wear = safe_float(dev.get("percentage_used"))
#         if wear is not None and wear > 80:
#             components_with_warnings += 1
#             flag("nvme", True, "warning", f"{device_name} SSD Wear exceeded threshold ({wear}% used)")

#         if (dev.get("unsafe_shutdowns") or 0) not in (None, 0):
#             informational.append(f"[nvme] {device_name} unsafe shutdowns recorded")

#     # --- Memory / EDAC ---
#     mem = report.get("memory", {}).get("health") or {}
#     if mem.get("supported"):
#         components_checked += 1
#         if (mem.get("uncorrectable_errors") or 0) > 0:
#             components_with_errors += 1
#             flag("memory", True, "critical", "Uncorrectable ECC detected")
#         if (mem.get("correctable_errors") or 0) > 0:
#             components_with_warnings += 1
#             flag("memory", True, "warning", "Correctable ECC detected")

#     # --- GPU ---
#     for gpu in report.get("gpu", []) or []:
#         components_checked += 1
#         h = gpu.get("health") or {}
#         idx = gpu.get("index")

#         if (h.get("xid_errors") or 0) > 0:
#             components_with_errors += 1
#             flag("gpu", True, "critical", f"GPU {idx} XID errors detected")
#         if (h.get("ecc_uncorrected") or 0) > 0:
#             components_with_errors += 1
#             flag("gpu", True, "critical", f"GPU {idx} uncorrectable ECC errors detected")
#         if (h.get("replay_errors") or 0) > 0:
#             components_with_warnings += 1
#             flag("gpu", True, "warning", f"GPU {idx} PCIe replay errors detected")
#         if h.get("link_status") == "Power Saving":
#             informational.append(f"[gpu] GPU {idx} operating in ASPM power saving state")

#     # --- CPU ---
#     cpu_health = report.get("cpu", {}).get("health") or {}
#     components_checked += 1
#     if (cpu_health.get("fatal_errors") or 0) > 0:
#         components_with_errors += 1
#         flag("cpu", True, "critical", "CPU Machine Check Exception detected")
#     if (cpu_health.get("corrected_errors") or 0) > 0:
#         components_with_warnings += 1
#         flag("cpu", True, "warning", "CPU corrected hardware errors detected")

#     total_throttle = (
#         (cpu_health.get("thermal_throttling_total_core_count") or 0)
#         + (cpu_health.get("thermal_throttling_total_package_count") or 0)
#     )
#     if total_throttle > 0:
#         components_with_warnings += 1
#         flag("cpu", True, "warning", "CPU thermal throttling events recorded")

#     # --- NIC ---
#     for nic in report.get("nic", []) or []:
#         components_checked += 1
#         h = nic.get("health") or {}
#         crc_like = sum(v for k, v in h.items() if "crc" in k.lower() and isinstance(v, int))
#         if crc_like > 0:
#             components_with_warnings += 1
#             flag("nic", True, "warning", f"{nic.get('interface')} CRC/frame errors detected")

#     # --- USB ---
#     usb_health = report.get("usb", {}).get("health") or {}
#     if usb_health:
#         components_checked += 1
#         if (usb_health.get("over_current_events") or 0) > 0:
#             components_with_warnings += 1
#             flag("usb", True, "warning", "USB over-current events detected")

#     # --- Trial2: Chassis / Battery / AC power-supply (light, additive) ---
#     # Conservative on purpose: chassis/battery state is surfaced as
#     # warnings/informational only, never critical, matching the same
#     # "worth a look" philosophy as the functional block ledger below --
#     # it never influences overall_health or score computed further down
#     # from the pre-existing PCIe/NVMe/memory/GPU/CPU/NIC/USB counters.
#     chassis = report.get("chassis") or {}
#     if chassis:
#         components_checked += 1
#         thermal_state = (chassis.get("thermal_state") or "").lower()
#         if thermal_state and thermal_state not in ("safe", "unknown", ""):
#             components_with_warnings += 1
#             flag("chassis", True, "warning", f"Chassis thermal state reported as '{chassis.get('thermal_state')}'")
#         power_state = (chassis.get("power_supply_state") or "").lower()
#         if power_state and power_state not in ("safe", "unknown", ""):
#             components_with_warnings += 1
#             flag("chassis", True, "warning", f"Chassis power supply state reported as '{chassis.get('power_supply_state')}'")

#     battery = report.get("battery") or {}
#     if battery.get("present"):
#         components_checked += 1
#         for bat in battery.get("batteries", []) or []:
#             health = (bat.get("health") or "").lower()
#             if health and health not in ("good", "normal", "unknown", ""):
#                 components_with_warnings += 1
#                 flag("battery", True, "warning", f"{bat.get('name')} health reported as '{bat.get('health')}'")
#             capacity = bat.get("capacity_percent")
#             if isinstance(capacity, (int, float)) and capacity <= 5 and (bat.get("status") or "").lower() != "charging":
#                 components_with_warnings += 1
#                 flag("battery", True, "warning", f"{bat.get('name')} critically low ({capacity}%) and not charging")

#     # --- Functional Block Ledger (informational only; heuristic-based) ---
#     # These are surfaced separately from warnings/critical_alerts and never
#     # affect the score, since the underlying commands return free-form text
#     # rather than structured counters -- see collect_functional_blocks().
#     for category, blocks in (report.get("functional_blocks") or {}).items():
#         for block_name, block in blocks.items():
#             if block.get("status") == "warning":
#                 diagnostic_notes.append(
#                     f"[{category}/{block_name}] diagnostic output matched a warning keyword -- review raw output"
#                 )

#     overall = "Healthy"
#     if critical_alerts:
#         overall = "Critical"
#     elif warnings:
#         overall = "Warning"

#     score = max(0, 100 - 10 * len(critical_alerts) - 3 * len(warnings))

#     return {
#         "overall_health": overall,
#         "score": score,
#         "warnings": warnings,
#         "critical_alerts": critical_alerts,
#         "informational": informational,
#         "diagnostic_notes": diagnostic_notes,
#         "components_checked": components_checked,
#         "components_with_warnings": components_with_warnings,
#         "components_with_errors": components_with_errors,
#     }


# # --------------------------------------------------------------------------
# # Top-level link-health collector
# # --------------------------------------------------------------------------

# def collect_link_health() -> dict[str, Any]:
#     kernel_log = _get_kernel_log()

#     pcie = get_pcie_link_health()
#     kernel_events = get_kernel_events(kernel_log)

#     report: dict[str, Any] = {
#         "cpu": {
#             "inventory": get_cpu_inventory_extra(),
#             "health": get_cpu_health(kernel_log),
#         },
#         "memory": {
#             "inventory": get_memory_inventory_extra(),
#             "health": get_memory_health(),
#         },
#         "gpu": get_gpu_health(kernel_log),
#         "pcie": pcie,
#         "nvme": get_nvme_health(),
#         "sata": get_sata_health(),
#         "usb": {
#             "devices": get_usb_link_health(),
#             "health": get_usb_health(kernel_log),
#         },
#         "nic": get_nic_health(),
#         "iommu": get_iommu_summary(),
#         "motherboard": get_motherboard_health(kernel_events, pcie),
#         "bios": get_bios_health(),
#         "ipmi": get_ipmi_health(),
#         "hwmon": get_hwmon_health(),
#         "kernel_events": kernel_events,
#         "functional_blocks": collect_functional_blocks(),
#         # --- Trial2 additions (additive; nothing above was removed) ---
#         "chassis": get_chassis_inventory(),
#         "voltage_probes": get_voltage_probes(),
#         "cooling_devices": get_cooling_devices(),
#         "battery": get_battery_health(),
#         "power_supply": get_power_supply_status(),
#     }

#     # DEMO: overwrite RAM/DISK/NIC/IO_Controller fields per whatever severity
#     # is currently set via /demo/<component>/<severity>. Must run before
#     # compute_health_summary() so overall_health/score/warnings reflect the
#     # injected values, not just the raw hardware. No-op while "healthy".
#     inject_link_health(report)

#     report["health_summary"] = compute_health_summary(report)
#     return report


# # --------------------------------------------------------------------------
# # Background updater thread
# # --------------------------------------------------------------------------

# def updater_loop() -> None:
#     """Background daemon loop with independent refresh intervals."""
#     global LATEST_INVENTORY, LATEST_METRICS, LATEST_LINK_HEALTH

#     last_inventory = 0
#     last_link_health = 0

#     while True:
#         try:
#             # Clear the per-cycle subprocess cache so this tick's data is
#             # always freshly collected, while calls repeated within the
#             # same tick (e.g. multiple callers needing `lscpu` or the
#             # functional-block ledger sharing commands with the health
#             # engine) still dedupe.
#             _CMD_CACHE.clear()

#             now = time.time()

#             # --------------------------------------------------
#             # Metrics every 5 seconds
#             # --------------------------------------------------
#             metrics = collect_metrics()

#             with _state_lock:
#                 LATEST_METRICS = metrics

#             # --------------------------------------------------
#             # Inventory every 30 seconds
#             # --------------------------------------------------
#             if now - last_inventory >= 30:
#                 inventory = collect_inventory()

#                 with _state_lock:
#                     LATEST_INVENTORY = inventory

#                 last_inventory = now

#             # --------------------------------------------------
#             # Link Health (incl. Functional Block Ledger) every 30 seconds
#             # --------------------------------------------------
#             if now - last_link_health >= 30:
#                 link_health = collect_link_health()

#                 with _state_lock:
#                     LATEST_LINK_HEALTH = link_health

#                 last_link_health = now

#             # --------------------------------------------------
#             # Write snapshot
#             # --------------------------------------------------
#             with _state_lock:
#                 snapshot = {
#                     "inventory": LATEST_INVENTORY,
#                     "metrics": LATEST_METRICS,
#                     "link_health": LATEST_LINK_HEALTH,
#                 }

#             snapshot = prune_json(snapshot)

#             with open(INVENTORY_FILE, "w", encoding="utf-8") as f:
#                 json.dump(snapshot, f, indent=2, default=str)

#         except Exception as exc:
#             logger.exception("Unhandled error in updater loop: %s", exc)

#         time.sleep(5)


# # ============================================================================
# # ============================================================================
# # RECOVERY ENGINE
# # ============================================================================
# # ============================================================================
# # Everything below extends this telemetry backend with a whitelisted,
# # validated Recovery Execution Engine. The frontend NEVER sends a shell
# # command -- only an action key + params. Every action is looked up in
# # RECOVERY_ACTIONS (a fixed whitelist below), validated, executed via a
# # fixed argv list (never shell=True, never string interpolation into a
# # command), and logged to the audit history.
# #
# # Nothing above this point is touched. Every telemetry function
# # (collect_metrics, run, command_exists, is_root, safe_int, etc.) is
# # reused as-is -- nothing telemetry-related is duplicated below.
# #
# # The actual Flask routes (GET /recovery/capabilities, POST
# # /recovery/execute, GET /recovery/history) are added further down inside
# # the existing "Flask application" section, right after your existing
# # /health route, since they need the `app` object created there.
# # ============================================================================

# RECOVERY_SELF_PID = os.getpid()  # this process can never target itself
# RECOVERY_DEFAULT_TIMEOUT = 15
# RECOVERY_LONG_TIMEOUT = 60


# # ----------------------------------------------------------------------------
# # Recovery Action Registry
# # ----------------------------------------------------------------------------
# # Handler functions below. Each receives an already-VALIDATED params dict
# # (validation happens in the Recovery Validation section, before a handler
# # is ever called) and returns a structured result dict:
# #     {success, message, command, stdout, stderr, returncode}
# # Handlers never raise -- failures come back as {"success": False, ...}.
# # Every command is a fixed argv list, never a shell string.

# def run_recovery_command(cmd: list[str], timeout: int = RECOVERY_DEFAULT_TIMEOUT) -> dict[str, Any]:
#     """Execute a fixed argv list for a recovery action.

#     Deliberately NOT cached (unlike telemetry's `run()`) -- these are
#     mutating actions, every call must actually execute.
#     """
#     started = time.monotonic()
#     try:
#         result = subprocess.run(
#             cmd,
#             stdout=subprocess.PIPE,
#             stderr=subprocess.PIPE,
#             text=True,
#             timeout=timeout,
#             check=False,
#         )
#         return {
#             "success": result.returncode == 0,
#             "command": " ".join(cmd),
#             "stdout": (result.stdout or "").strip(),
#             "stderr": (result.stderr or "").strip(),
#             "returncode": result.returncode,
#             "duration_seconds": round(time.monotonic() - started, 3),
#         }
#     except subprocess.TimeoutExpired:
#         return {"success": False, "command": " ".join(cmd), "stdout": "",
#                 "stderr": f"timed out after {timeout}s", "returncode": None,
#                 "duration_seconds": round(time.monotonic() - started, 3)}
#     except FileNotFoundError:
#         return {"success": False, "command": " ".join(cmd), "stdout": "",
#                 "stderr": f"command not found: {cmd[0]}", "returncode": None,
#                 "duration_seconds": round(time.monotonic() - started, 3)}
#     except Exception as exc:  # noqa: BLE001
#         return {"success": False, "command": " ".join(cmd), "stdout": "",
#                 "stderr": str(exc), "returncode": None,
#                 "duration_seconds": round(time.monotonic() - started, 3)}


# def _signal_process(pid: int, sig: int, label: str) -> dict[str, Any]:
#     cmd_str = f"kill -{int(sig)} {pid}"
#     try:
#         os.kill(pid, sig)
#         return {"success": True, "message": f"{label} sent to pid {pid}",
#                 "command": cmd_str, "stdout": "", "stderr": "", "returncode": 0}
#     except ProcessLookupError:
#         return {"success": False, "message": f"pid {pid} no longer exists",
#                 "command": cmd_str, "stdout": "", "stderr": "no such process", "returncode": None}
#     except PermissionError:
#         return {"success": False, "message": f"insufficient privileges to signal pid {pid}",
#                 "command": cmd_str, "stdout": "", "stderr": "permission denied", "returncode": None}
#     except Exception as exc:  # noqa: BLE001
#         return {"success": False, "message": str(exc), "command": cmd_str,
#                 "stdout": "", "stderr": str(exc), "returncode": None}


# # --- CPU -------------------------------------------------------------------

# def cpu_renice(params: dict) -> dict[str, Any]:
#     pid, nice_value = params["pid"], params["nice_value"]
#     res = run_recovery_command(["renice", "-n", str(nice_value), "-p", str(pid)])
#     res["message"] = f"Process {pid} renice'd to {nice_value}." if res["success"] else "Renice failed."
#     return res


# def cpu_pause_process(params: dict) -> dict[str, Any]:
#     return _signal_process(params["pid"], signal.SIGSTOP, "SIGSTOP")


# def cpu_resume_process(params: dict) -> dict[str, Any]:
#     return _signal_process(params["pid"], signal.SIGCONT, "SIGCONT")


# def cpu_terminate_process(params: dict) -> dict[str, Any]:
#     return _signal_process(params["pid"], signal.SIGTERM, "SIGTERM")


# def cpu_kill_process(params: dict) -> dict[str, Any]:
#     return _signal_process(params["pid"], signal.SIGKILL, "SIGKILL")


# def cpu_restart_service(params: dict) -> dict[str, Any]:
#     unit = params["unit"]
#     res = run_recovery_command(["systemctl", "restart", unit], timeout=RECOVERY_LONG_TIMEOUT)
#     res["message"] = f"Service {unit} restarted." if res["success"] else f"Failed to restart {unit}."
#     return res


# # --- GPU ---------------------------------------------------------------

# def gpu_restart_persistence_daemon(params: dict) -> dict[str, Any]:
#     res = run_recovery_command(["systemctl", "restart", "nvidia-persistenced"], timeout=RECOVERY_LONG_TIMEOUT)
#     res["message"] = "nvidia-persistenced restarted." if res["success"] else "Failed to restart nvidia-persistenced."
#     return res


# def gpu_reset(params: dict) -> dict[str, Any]:
#     gpu_id = str(params.get("gpu_id", "0"))
#     res = run_recovery_command(["nvidia-smi", "--gpu-reset", "-i", gpu_id], timeout=RECOVERY_LONG_TIMEOUT)
#     res["message"] = (f"GPU {gpu_id} reset." if res["success"]
#                        else f"GPU {gpu_id} reset failed (often requires no active clients / driver support).")
#     return res


# def gpu_pause_process(params: dict) -> dict[str, Any]:
#     return _signal_process(params["pid"], signal.SIGSTOP, "SIGSTOP")


# def gpu_terminate_process(params: dict) -> dict[str, Any]:
#     return _signal_process(params["pid"], signal.SIGTERM, "SIGTERM")


# # --- RAM ---------------------------------------------------------------

# def ram_restart_service(params: dict) -> dict[str, Any]:
#     unit = params["unit"]
#     res = run_recovery_command(["systemctl", "restart", unit], timeout=RECOVERY_LONG_TIMEOUT)
#     res["message"] = f"Service {unit} restarted." if res["success"] else f"Failed to restart {unit}."
#     return res


# def ram_drop_caches(params: dict) -> dict[str, Any]:
#     sync_res = run_recovery_command(["sync"])
#     try:
#         with open("/proc/sys/vm/drop_caches", "w", encoding="utf-8") as f:
#             f.write("3\n")
#         return {"success": True, "message": "Page cache, dentries, and inodes dropped.",
#                 "command": "sync; echo 3 > /proc/sys/vm/drop_caches",
#                 "stdout": sync_res.get("stdout", ""), "stderr": "", "returncode": 0}
#     except PermissionError:
#         return {"success": False, "message": "insufficient privileges to drop caches (requires root)",
#                 "command": "sync; echo 3 > /proc/sys/vm/drop_caches",
#                 "stdout": sync_res.get("stdout", ""), "stderr": "permission denied", "returncode": None}
#     except Exception as exc:  # noqa: BLE001
#         return {"success": False, "message": str(exc), "command": "echo 3 > /proc/sys/vm/drop_caches",
#                 "stdout": "", "stderr": str(exc), "returncode": None}


# def ram_pause_process(params: dict) -> dict[str, Any]:
#     return _signal_process(params["pid"], signal.SIGSTOP, "SIGSTOP")


# def ram_terminate_process(params: dict) -> dict[str, Any]:
#     return _signal_process(params["pid"], signal.SIGTERM, "SIGTERM")


# # --- DISK ----------------------------------------------------------------

# _RECOVERY_SAFE_TEMP_ROOTS = (Path("/tmp"), Path("/var/tmp"))


# def disk_clean_temp_files(params: dict) -> dict[str, Any]:
#     """Remove regular files under /tmp or /var/tmp older than min_age_hours.
#     Never recurses into subdirectories, never removes directories, never
#     touches anything outside these two well-known temp roots."""
#     min_age_hours = params.get("min_age_hours", 24)
#     try:
#         min_age_hours = float(min_age_hours)
#     except (TypeError, ValueError):
#         min_age_hours = 24.0

#     cutoff = time.time() - (min_age_hours * 3600)
#     removed, errors = [], []

#     for root in _RECOVERY_SAFE_TEMP_ROOTS:
#         if not root.exists():
#             continue
#         try:
#             for entry in root.iterdir():
#                 try:
#                     if entry.is_file() and not entry.is_symlink() and entry.stat().st_mtime < cutoff:
#                         entry.unlink()
#                         removed.append(str(entry))
#                 except Exception as exc:  # noqa: BLE001
#                     errors.append(f"{entry}: {exc}")
#         except Exception as exc:  # noqa: BLE001
#             errors.append(f"{root}: {exc}")

#     return {
#         "success": True,
#         "message": f"Removed {len(removed)} temp file(s) older than {min_age_hours}h.",
#         "command": f"find {' '.join(str(r) for r in _RECOVERY_SAFE_TEMP_ROOTS)} -maxdepth 1 -type f -mmin +{int(min_age_hours * 60)} -delete",
#         "stdout": "\n".join(removed[:200]),
#         "stderr": "\n".join(errors[:50]),
#         "returncode": 0,
#     }


# def disk_vacuum_journal(params: dict) -> dict[str, Any]:
#     size = params.get("max_size", "200M")
#     if not isinstance(size, str) or not size or not size[:-1].isdigit() or size[-1] not in "KMG":
#         size = "200M"
#     res = run_recovery_command(["journalctl", f"--vacuum-size={size}"], timeout=RECOVERY_LONG_TIMEOUT)
#     res["message"] = f"Journal vacuumed to {size}." if res["success"] else "Journal vacuum failed."
#     return res


# def disk_identify_large_directories(params: dict) -> dict[str, Any]:
#     """Read-only diagnostic: top-level directory sizes under a given path."""
#     path = params.get("path", "/var/log")
#     if not isinstance(path, str) or ".." in path or not path.startswith("/"):
#         path = "/var/log"
#     res = run_recovery_command(["du", "-h", "--max-depth=1", path], timeout=RECOVERY_LONG_TIMEOUT)
#     res["message"] = f"Directory sizes under {path}." if res["success"] else f"Could not scan {path}."
#     return res


# # --- NIC ---------------------------------------------------------------

# def nic_restart_interface(params: dict) -> dict[str, Any]:
#     iface = params["interface"]
#     down = run_recovery_command(["ip", "link", "set", iface, "down"])
#     up = run_recovery_command(["ip", "link", "set", iface, "up"])
#     success = down["success"] and up["success"]
#     return {"success": success,
#             "message": f"Interface {iface} restarted." if success else f"Failed to restart {iface}.",
#             "command": f"ip link set {iface} down && ip link set {iface} up",
#             "stdout": (down["stdout"] + "\n" + up["stdout"]).strip(),
#             "stderr": (down["stderr"] + "\n" + up["stderr"]).strip(),
#             "returncode": up["returncode"]}


# def nic_renew_dhcp(params: dict) -> dict[str, Any]:
#     iface = params["interface"]
#     release = run_recovery_command(["dhclient", "-r", iface], timeout=RECOVERY_LONG_TIMEOUT)
#     renew = run_recovery_command(["dhclient", iface], timeout=RECOVERY_LONG_TIMEOUT)
#     success = renew["success"]
#     return {"success": success,
#             "message": f"DHCP lease renewed on {iface}." if success else f"DHCP renewal failed on {iface}.",
#             "command": f"dhclient -r {iface} && dhclient {iface}",
#             "stdout": (release["stdout"] + "\n" + renew["stdout"]).strip(),
#             "stderr": (release["stderr"] + "\n" + renew["stderr"]).strip(),
#             "returncode": renew["returncode"]}


# def nic_restart_network_manager(params: dict) -> dict[str, Any]:
#     res = run_recovery_command(["systemctl", "restart", "NetworkManager"], timeout=RECOVERY_LONG_TIMEOUT)
#     res["message"] = "NetworkManager restarted." if res["success"] else "Failed to restart NetworkManager."
#     return res


# def nic_reload_driver(params: dict) -> dict[str, Any]:
#     iface = params["interface"]
#     try:
#         driver = Path(f"/sys/class/net/{iface}/device/driver").resolve().name
#     except Exception:
#         driver = None

#     if not driver:
#         return {"success": False, "message": f"could not determine driver module for {iface}",
#                 "command": f"ethtool -i {iface}", "stdout": "", "stderr": "driver not found", "returncode": None}

#     unload = run_recovery_command(["modprobe", "-r", driver], timeout=RECOVERY_LONG_TIMEOUT)
#     load = run_recovery_command(["modprobe", driver], timeout=RECOVERY_LONG_TIMEOUT)
#     success = load["success"]
#     return {"success": success,
#             "message": f"Driver {driver} reloaded for {iface}." if success else f"Failed to reload driver {driver}.",
#             "command": f"modprobe -r {driver} && modprobe {driver}",
#             "stdout": (unload["stdout"] + "\n" + load["stdout"]).strip(),
#             "stderr": (unload["stderr"] + "\n" + load["stderr"]).strip(),
#             "returncode": load["returncode"]}


# # --- PCIe --------------------------------------------------------------

# def pcie_rescan(params: dict) -> dict[str, Any]:
#     try:
#         with open("/sys/bus/pci/rescan", "w", encoding="utf-8") as f:
#             f.write("1\n")
#         return {"success": True, "message": "PCI bus rescanned.",
#                 "command": "echo 1 > /sys/bus/pci/rescan", "stdout": "", "stderr": "", "returncode": 0}
#     except PermissionError:
#         return {"success": False, "message": "insufficient privileges to rescan the PCI bus (requires root)",
#                 "command": "echo 1 > /sys/bus/pci/rescan", "stdout": "", "stderr": "permission denied", "returncode": None}
#     except Exception as exc:  # noqa: BLE001
#         return {"success": False, "message": str(exc), "command": "echo 1 > /sys/bus/pci/rescan",
#                 "stdout": "", "stderr": str(exc), "returncode": None}


# def pcie_reload_driver(params: dict) -> dict[str, Any]:
#     slot = params["slot"]
#     try:
#         driver = Path(f"/sys/bus/pci/devices/{slot}/driver").resolve().name
#     except Exception:
#         driver = None

#     if not driver:
#         return {"success": False, "message": f"no driver currently bound to {slot}",
#                 "command": f"cat /sys/bus/pci/devices/{slot}/driver", "stdout": "", "stderr": "no driver bound", "returncode": None}

#     unbind_path = Path(f"/sys/bus/pci/drivers/{driver}/unbind")
#     bind_path = Path(f"/sys/bus/pci/drivers/{driver}/bind")
#     try:
#         unbind_path.write_text(slot)
#         time.sleep(0.5)
#         bind_path.write_text(slot)
#         return {"success": True, "message": f"Driver {driver} reloaded for {slot}.",
#                 "command": f"echo {slot} > .../drivers/{driver}/unbind; echo {slot} > .../drivers/{driver}/bind",
#                 "stdout": "", "stderr": "", "returncode": 0}
#     except PermissionError:
#         return {"success": False, "message": "insufficient privileges to unbind/bind the PCI driver (requires root)",
#                 "command": f"echo {slot} > .../drivers/{driver}/unbind; echo {slot} > .../drivers/{driver}/bind",
#                 "stdout": "", "stderr": "permission denied", "returncode": None}
#     except Exception as exc:  # noqa: BLE001
#         return {"success": False, "message": str(exc), "command": f"reload driver {driver} for {slot}",
#                 "stdout": "", "stderr": str(exc), "returncode": None}


# # --- Capability / support detection helpers ---------------------------

# def _recovery_always() -> tuple[bool, str]:
#     return True, ""


# def _recovery_root_and(binary: Optional[str] = None):
#     def check() -> tuple[bool, str]:
#         if binary and not command_exists(binary):
#             return False, f"'{binary}' not installed"
#         if not is_root():
#             return False, "requires root privileges"
#         return True, ""
#     return check


# def _recovery_needs_binary(binary: str):
#     def check() -> tuple[bool, str]:
#         if not command_exists(binary):
#             return False, f"'{binary}' not installed"
#         return True, ""
#     return check


# def _recovery_needs_gpu() -> tuple[bool, str]:
#     if not command_exists("nvidia-smi"):
#         return False, "no NVIDIA GPU / nvidia-smi detected"
#     return True, ""


# # --- The whitelist itself -----------------------------------------------
# # The frontend can ONLY ever send one of these keys. Anything else, or
# # anything not in this dict, is rejected before any code runs.
# #
# #   handler          -> function(params) -> result dict
# #   level            -> confirmation level required (1=low, 2=medium, 3=high)
# #   domain           -> cpu | gpu | ram | disk | nic | pcie
# #   required_params  -> params the caller must supply
# #   supported_check  -> function() -> (bool supported, str reason)

# RECOVERY_ACTIONS: dict[str, dict[str, Any]] = {
#     # CPU
#     "cpu.renice": {"handler": cpu_renice, "level": 1, "domain": "cpu",
#                    "required_params": ["pid", "nice_value"], "supported_check": _recovery_needs_binary("renice"),
#                    "description": "Change a process's scheduling priority."},
#     "cpu.pause_process": {"handler": cpu_pause_process, "level": 2, "domain": "cpu",
#                            "required_params": ["pid"], "supported_check": _recovery_always,
#                            "description": "Suspend a process (SIGSTOP)."},
#     "cpu.resume_process": {"handler": cpu_resume_process, "level": 1, "domain": "cpu",
#                             "required_params": ["pid"], "supported_check": _recovery_always,
#                             "description": "Resume a suspended process (SIGCONT)."},
#     "cpu.terminate_process": {"handler": cpu_terminate_process, "level": 3, "domain": "cpu",
#                                "required_params": ["pid"], "supported_check": _recovery_always,
#                                "description": "Gracefully terminate a process (SIGTERM)."},
#     "cpu.kill_process": {"handler": cpu_kill_process, "level": 3, "domain": "cpu",
#                           "required_params": ["pid"], "supported_check": _recovery_always,
#                           "description": "Force-kill a process (SIGKILL)."},
#     "cpu.restart_service": {"handler": cpu_restart_service, "level": 2, "domain": "cpu",
#                              "required_params": ["unit"], "supported_check": _recovery_root_and("systemctl"),
#                              "description": "Restart a misbehaving systemd service."},
#     # GPU
#     "gpu.restart_persistence_daemon": {"handler": gpu_restart_persistence_daemon, "level": 2, "domain": "gpu",
#                                         "required_params": [], "supported_check": _recovery_needs_gpu,
#                                         "description": "Restart nvidia-persistenced."},
#     "gpu.reset": {"handler": gpu_reset, "level": 3, "domain": "gpu",
#                   "required_params": [], "supported_check": _recovery_needs_gpu,
#                   "description": "Reset a GPU (requires no active compute clients; often driver-dependent)."},
#     "gpu.pause_process": {"handler": gpu_pause_process, "level": 2, "domain": "gpu",
#                            "required_params": ["pid"], "supported_check": _recovery_needs_gpu,
#                            "description": "Suspend a GPU-using process."},
#     "gpu.terminate_process": {"handler": gpu_terminate_process, "level": 3, "domain": "gpu",
#                                "required_params": ["pid"], "supported_check": _recovery_needs_gpu,
#                                "description": "Terminate a GPU-using process."},
#     # RAM
#     "ram.restart_service": {"handler": ram_restart_service, "level": 2, "domain": "ram",
#                              "required_params": ["unit"], "supported_check": _recovery_root_and("systemctl"),
#                              "description": "Restart a service that is leaking / hogging memory."},
#     "ram.drop_caches": {"handler": ram_drop_caches, "level": 1, "domain": "ram",
#                          "required_params": [], "supported_check": _recovery_root_and(),
#                          "description": "Drop the page cache, dentries, and inodes."},
#     "ram.pause_process": {"handler": ram_pause_process, "level": 2, "domain": "ram",
#                            "required_params": ["pid"], "supported_check": _recovery_always,
#                            "description": "Suspend a memory-hogging process."},
#     "ram.terminate_process": {"handler": ram_terminate_process, "level": 3, "domain": "ram",
#                                "required_params": ["pid"], "supported_check": _recovery_always,
#                                "description": "Terminate a memory-hogging process."},
#     # DISK
#     "disk.clean_temp_files": {"handler": disk_clean_temp_files, "level": 1, "domain": "disk",
#                                "required_params": [], "supported_check": _recovery_always,
#                                "description": "Remove old files under /tmp and /var/tmp."},
#     "disk.vacuum_journal": {"handler": disk_vacuum_journal, "level": 1, "domain": "disk",
#                              "required_params": [], "supported_check": _recovery_needs_binary("journalctl"),
#                              "description": "Shrink the systemd journal to a target size."},
#     "disk.identify_large_directories": {"handler": disk_identify_large_directories, "level": 1, "domain": "disk",
#                                          "required_params": [], "supported_check": _recovery_needs_binary("du"),
#                                          "description": "Read-only scan of directory sizes."},
#     # NIC
#     "nic.restart_interface": {"handler": nic_restart_interface, "level": 2, "domain": "nic",
#                                "required_params": ["interface"], "supported_check": _recovery_root_and("ip"),
#                                "description": "Bring a network interface down and back up."},
#     "nic.renew_dhcp": {"handler": nic_renew_dhcp, "level": 2, "domain": "nic",
#                         "required_params": ["interface"], "supported_check": _recovery_root_and("dhclient"),
#                         "description": "Release and renew a DHCP lease."},
#     "nic.restart_network_manager": {"handler": nic_restart_network_manager, "level": 2, "domain": "nic",
#                                      "required_params": [], "supported_check": _recovery_root_and("systemctl"),
#                                      "description": "Restart the NetworkManager service."},
#     "nic.reload_driver": {"handler": nic_reload_driver, "level": 3, "domain": "nic",
#                            "required_params": ["interface"], "supported_check": _recovery_root_and("modprobe"),
#                            "description": "Unload and reload the NIC's kernel driver module."},
#     # PCIe
#     "pcie.rescan": {"handler": pcie_rescan, "level": 3, "domain": "pcie",
#                      "required_params": [], "supported_check": _recovery_root_and(),
#                      "description": "Trigger a full PCI bus rescan."},
#     "pcie.reload_driver": {"handler": pcie_reload_driver, "level": 3, "domain": "pcie",
#                             "required_params": ["slot"], "supported_check": _recovery_root_and(),
#                             "description": "Unbind and rebind the driver for a specific PCI device."},
# }


# def build_recovery_capabilities_report() -> dict[str, Any]:
#     """Backs GET /recovery/capabilities."""
#     report = []
#     for key, meta in RECOVERY_ACTIONS.items():
#         try:
#             supported, reason = meta["supported_check"]()
#         except Exception as exc:  # noqa: BLE001
#             supported, reason = False, f"capability check failed: {exc}"
#         entry = {
#             "key": key, "domain": meta["domain"], "level": meta["level"],
#             "required_params": meta["required_params"], "description": meta["description"],
#             "supported": bool(supported),
#         }
#         if not supported:
#             entry["reason"] = reason or "not supported on this host"
#         report.append(entry)
#     return {"actions": report}


# # ----------------------------------------------------------------------------
# # Recovery Validation
# # ----------------------------------------------------------------------------
# # PID validation, service validation, interface/PCI-slot validation, and
# # protected process/service checks. Nothing here executes a command --
# # it only decides whether a request is allowed to proceed.

# class RecoveryRequestError(Exception):
#     """Raised for any validation failure; caught by the /recovery/execute
#     route and turned into a structured 400 response instead of a crash."""


# RECOVERY_PROTECTED_PIDS: set[int] = {1}

# RECOVERY_PROTECTED_PROCESS_NAMES: set[str] = {
#     "systemd", "init", "kthreadd", "sshd", "ssh", "dbus-daemon",
#     "systemd-journald", "systemd-logind", "systemd-udevd", "udevd",
#     "NetworkManager", "containerd", "dockerd", "cron", "crond",
# }

# # In case the agent gets restarted under a new PID before this file is
# # reloaded, also protect anything whose cmdline matches this script.
# RECOVERY_TELEMETRY_NAME_HINTS = ("collect_metrics", "hardware-monitor")

# RECOVERY_PROTECTED_SERVICES: set[str] = {
#     "ssh", "sshd", "systemd-journald", "systemd-logind", "systemd-networkd",
#     "systemd-resolved", "systemd-udevd", "dbus", "cron", "udev",
#     "networking", "network-manager", "networkmanager",
# }

# _RECOVERY_SERVICE_NAME_RE = re.compile(r"^[a-zA-Z0-9@._-]{1,128}$")
# _RECOVERY_IFACE_NAME_RE = re.compile(r"^[a-zA-Z0-9._-]{1,15}$")
# _RECOVERY_PCI_SLOT_RE = re.compile(r"^[0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-9a-fA-F]$")


# def _recovery_pid_exists(pid: int) -> bool:
#     return Path(f"/proc/{pid}").is_dir()


# def _recovery_read_comm(pid: int) -> str:
#     try:
#         return Path(f"/proc/{pid}/comm").read_text(encoding="utf-8", errors="ignore").strip()
#     except Exception:
#         return ""


# def _recovery_read_cmdline(pid: int) -> str:
#     try:
#         raw = Path(f"/proc/{pid}/cmdline").read_bytes()
#         return raw.replace(b"\x00", b" ").decode("utf-8", errors="ignore").strip()
#     except Exception:
#         return ""


# def validate_recovery_pid(pid) -> tuple[bool, str, Optional[int]]:
#     try:
#         pid_int = int(pid)
#     except (TypeError, ValueError):
#         return False, "pid must be an integer", None
#     if pid_int <= 0:
#         return False, "pid must be a positive integer", None
#     if not _recovery_pid_exists(pid_int):
#         return False, f"pid {pid_int} does not exist", pid_int
#     if pid_int in RECOVERY_PROTECTED_PIDS:
#         return False, f"pid {pid_int} is protected (init/systemd)", pid_int
#     if pid_int == RECOVERY_SELF_PID:
#         return False, "refusing to target the telemetry/recovery backend itself", pid_int

#     comm = _recovery_read_comm(pid_int)
#     if comm and comm in RECOVERY_PROTECTED_PROCESS_NAMES:
#         return False, f"pid {pid_int} ({comm}) is a protected system process", pid_int

#     cmdline = _recovery_read_cmdline(pid_int)
#     if any(hint in cmdline for hint in RECOVERY_TELEMETRY_NAME_HINTS):
#         return False, f"pid {pid_int} looks like the telemetry backend itself", pid_int

#     try:
#         status = Path(f"/proc/{pid_int}/status").read_text(encoding="utf-8", errors="ignore")
#         m = re.search(r"^PPid:\s*(\d+)", status, re.MULTILINE)
#         if m and int(m.group(1)) == 2:  # parented by kthreadd
#             return False, f"pid {pid_int} is a kernel thread", pid_int
#     except Exception:
#         pass

#     return True, "ok", pid_int


# def validate_recovery_service(name: str, *, allow_network_manager: bool = False) -> tuple[bool, str, Optional[str]]:
#     if not name or not isinstance(name, str):
#         return False, "service name is required", None
#     name = name.strip()
#     if not _RECOVERY_SERVICE_NAME_RE.match(name):
#         return False, "service name contains invalid characters", None
#     base = name[:-8] if name.endswith(".service") else name
#     lowered = base.lower()
#     if lowered in RECOVERY_PROTECTED_SERVICES and not (allow_network_manager and lowered in ("network-manager", "networkmanager")):
#         return False, f"service '{base}' is protected and cannot be restarted via this action", None
#     unit = name if name.endswith(".service") else f"{name}.service"
#     return True, "ok", unit


# def validate_recovery_interface(name: str) -> tuple[bool, str, Optional[str]]:
#     if not name or not isinstance(name, str):
#         return False, "interface name is required", None
#     name = name.strip()
#     if not _RECOVERY_IFACE_NAME_RE.match(name):
#         return False, "interface name contains invalid characters", None
#     if name == "lo":
#         return False, "the loopback interface cannot be recovery-targeted", None
#     if not (NET_CLASS_PATH / name).exists():
#         return False, f"interface '{name}' does not exist on this host", None
#     return True, "ok", name


# def validate_recovery_pci_slot(slot: str) -> tuple[bool, str, Optional[str]]:
#     if not slot or not isinstance(slot, str):
#         return False, "slot is required", None
#     slot = slot.strip()
#     if not _RECOVERY_PCI_SLOT_RE.match(slot):
#         return False, "slot must look like 0000:01:00.0", None
#     if not (PCI_DEVICES_PATH / slot).exists():
#         return False, f"PCI device {slot} not found", None
#     return True, "ok", slot


# def validate_recovery_nice_value(value) -> tuple[bool, str, Optional[int]]:
#     try:
#         n = int(value)
#     except (TypeError, ValueError):
#         return False, "nice_value must be an integer", None
#     if n < -20 or n > 19:
#         return False, "nice_value must be between -20 and 19", None
#     return True, "ok", n


# def validate_recovery_confirmation(confirmation: dict, required_level: int) -> tuple[bool, str]:
#     if not isinstance(confirmation, dict):
#         return False, "confirmation object is required"
#     if not confirmation.get("userAcknowledged"):
#         return False, "user confirmation is required before executing a recovery action"
#     try:
#         level = int(confirmation.get("level"))
#     except (TypeError, ValueError):
#         return False, "confirmation.level must be an integer"
#     if level < required_level:
#         return False, f"this action requires confirmation level {required_level} or higher"
#     return True, "ok"


# def resolve_recovery_params(action_key: str, raw_params: dict) -> dict[str, Any]:
#     """Validate + normalize raw params for a given action key. Raises
#     RecoveryRequestError with a human-readable reason on any failure."""
#     raw_params = raw_params or {}
#     resolved: dict[str, Any] = {}

#     if action_key.endswith(("pause_process", "resume_process", "terminate_process", "kill_process")):
#         ok, reason, pid = validate_recovery_pid(raw_params.get("pid"))
#         if not ok:
#             raise RecoveryRequestError(reason)
#         resolved["pid"] = pid

#     elif action_key == "cpu.renice":
#         ok, reason, pid = validate_recovery_pid(raw_params.get("pid"))
#         if not ok:
#             raise RecoveryRequestError(reason)
#         ok2, reason2, nice_value = validate_recovery_nice_value(raw_params.get("nice_value"))
#         if not ok2:
#             raise RecoveryRequestError(reason2)
#         resolved["pid"], resolved["nice_value"] = pid, nice_value

#     elif action_key in ("cpu.restart_service", "ram.restart_service"):
#         ok, reason, unit = validate_recovery_service(raw_params.get("unit") or raw_params.get("service"))
#         if not ok:
#             raise RecoveryRequestError(reason)
#         resolved["unit"] = unit

#     elif action_key == "disk.clean_temp_files":
#         if "min_age_hours" in raw_params:
#             resolved["min_age_hours"] = raw_params["min_age_hours"]

#     elif action_key == "disk.vacuum_journal":
#         if "max_size" in raw_params:
#             resolved["max_size"] = raw_params["max_size"]

#     elif action_key == "disk.identify_large_directories":
#         if "path" in raw_params:
#             resolved["path"] = raw_params["path"]

#     elif action_key in ("nic.restart_interface", "nic.renew_dhcp", "nic.reload_driver"):
#         ok, reason, iface = validate_recovery_interface(raw_params.get("interface"))
#         if not ok:
#             raise RecoveryRequestError(reason)
#         resolved["interface"] = iface

#     elif action_key == "gpu.reset":
#         if "gpu_id" in raw_params:
#             resolved["gpu_id"] = raw_params["gpu_id"]

#     elif action_key == "pcie.reload_driver":
#         ok, reason, slot = validate_recovery_pci_slot(raw_params.get("slot"))
#         if not ok:
#             raise RecoveryRequestError(reason)
#         resolved["slot"] = slot

#     # ram.drop_caches, gpu.restart_persistence_daemon, nic.restart_network_manager,
#     # pcie.rescan take no params -- nothing to resolve.

#     return resolved


# # ----------------------------------------------------------------------------
# # Recovery History
# # ----------------------------------------------------------------------------
# # In-memory ring buffer (for fast API reads) plus an append-only JSONL
# # file on disk, so history survives a restart.

# RECOVERY_HISTORY_FILE = "recovery_history.jsonl"
# RECOVERY_HISTORY_MAX_IN_MEMORY = 500

# _recovery_history_lock = threading.Lock()
# _recovery_history: list[dict[str, Any]] = []


# def _load_recovery_history() -> None:
#     p = Path(RECOVERY_HISTORY_FILE)
#     if not p.exists():
#         return
#     try:
#         lines = p.read_text(encoding="utf-8").splitlines()
#         for line in lines[-RECOVERY_HISTORY_MAX_IN_MEMORY:]:
#             try:
#                 _recovery_history.append(json.loads(line))
#             except json.JSONDecodeError:
#                 continue
#     except Exception:
#         pass


# _load_recovery_history()


# def record_recovery_history(entry: dict[str, Any]) -> None:
#     with _recovery_history_lock:
#         _recovery_history.append(entry)
#         if len(_recovery_history) > RECOVERY_HISTORY_MAX_IN_MEMORY:
#             del _recovery_history[: len(_recovery_history) - RECOVERY_HISTORY_MAX_IN_MEMORY]
#         try:
#             with open(RECOVERY_HISTORY_FILE, "a", encoding="utf-8") as f:
#                 f.write(json.dumps(entry, default=str) + "\n")
#         except Exception:
#             pass


# def get_recovery_history(limit: int = 100) -> list[dict[str, Any]]:
#     with _recovery_history_lock:
#         return list(reversed(_recovery_history[-limit:]))


# # ----------------------------------------------------------------------------
# # Recovery Verification
# # ----------------------------------------------------------------------------
# # Capture telemetry before execution, execute the recovery action, refresh
# # telemetry, compare before vs after, log it, and return the result. This
# # is the single orchestration function called by POST /recovery/execute.

# # Actions that mutate live state get a short settle time before the
# # "after" snapshot, so telemetry reflects the change rather than a
# # mid-transition state (e.g. an interface still coming back up).
# RECOVERY_SETTLE_SECONDS = {
#     "nic.restart_interface": 3.0, "nic.renew_dhcp": 3.0, "nic.restart_network_manager": 3.0,
#     "nic.reload_driver": 3.0, "cpu.restart_service": 2.0, "ram.restart_service": 2.0,
#     "gpu.restart_persistence_daemon": 2.0, "pcie.rescan": 2.0, "pcie.reload_driver": 2.0,
# }
# RECOVERY_DEFAULT_SETTLE = 1.0


# def _recovery_metric_for_fault(fault: Optional[dict]) -> Optional[str]:
#     if not fault:
#         return None
#     fid = str(fault.get("id") or "")
#     if "cpu-usage" in fid:
#         return "cpu.usage_percent"
#     if "cpu-temperature" in fid:
#         return "cpu.temperature_celsius"
#     if "gpu-temperature" in fid:
#         return "gpu.temperature_celsius"
#     if "gpu-vram" in fid:
#         return "gpu.memory_utilization_percent"
#     if "ram" in fid:
#         return "memory.usage_percent"
#     if "disk-capacity" in fid:
#         return "disk.mount_usage"
#     return None


# def _recovery_read_metric(metrics: dict, key: Optional[str], fault: Optional[dict]) -> Optional[float]:
#     if not key or not metrics:
#         return None
#     if key == "cpu.usage_percent":
#         v = (metrics.get("cpu") or {}).get("usage_percent")
#     elif key == "cpu.temperature_celsius":
#         v = (metrics.get("cpu") or {}).get("temperature_celsius")
#     elif key == "gpu.temperature_celsius":
#         g = (metrics.get("gpu") or [None])[0] or {}
#         v = g.get("temperature_celsius")
#     elif key == "gpu.memory_utilization_percent":
#         g = (metrics.get("gpu") or [None])[0] or {}
#         v = g.get("memory_utilization_percent")
#     elif key == "memory.usage_percent":
#         v = (metrics.get("memory") or {}).get("usage_percent")
#     elif key == "disk.mount_usage":
#         mp = str((fault or {}).get("id") or "").replace("threshold-disk-capacity-", "")
#         mounts = (metrics.get("disk") or {}).get("mounts") or []
#         m = next((x for x in mounts if (x.get("mountpoint") or x.get("mount")) == mp), None)
#         v = m.get("usage_percent") if m else None
#     else:
#         v = None
#     try:
#         return float(v) if v is not None else None
#     except (TypeError, ValueError):
#         return None


# def _recovery_verification_status(
#     fault: Optional[dict], before_m: dict, after_m: dict, action_success: bool
# ) -> str:
#     """Compare before/after metrics when fault context is supplied."""
#     if not action_success:
#         return "failed"
#     metric_key = _recovery_metric_for_fault(fault)
#     if not metric_key:
#         return "success" if action_success else "failed"
#     before_v = _recovery_read_metric(before_m, metric_key, fault)
#     after_v = _recovery_read_metric(after_m, metric_key, fault)
#     if before_v is None or after_v is None:
#         return "success" if action_success else "unknown"
#     if after_v < before_v:
#         # Improved — caller may still want threshold check on frontend
#         threshold_hint = str((fault or {}).get("thresholdCrossed") or "")
#         if "Critical" in threshold_hint or "Warning" in threshold_hint:
#             return "partial" if after_v >= before_v * 0.95 else "success"
#         return "success"
#     if after_v >= before_v:
#         return "partial" if action_success else "failed"
#     return "success"


# def _recovery_safe_metrics() -> dict:
#     """Fresh telemetry snapshot via the existing collect_metrics() --
#     NOT the cached LATEST_METRICS -- so before/after actually differ."""
#     try:
#         return collect_metrics() or {}
#     except Exception:
#         return {}


# def run_recovery_action(action_key: str, raw_params: dict, fault: Optional[dict], confirmation: dict) -> dict[str, Any]:
#     """Full lifecycle for one recovery request: validate -> capture
#     before -> execute -> settle -> capture after -> log -> respond.
#     Raises RecoveryRequestError for validation failures (the route turns
#     those into a 400); handler-level failures are NOT exceptions, they
#     come back as success=False in the response.
#     """
#     if action_key not in RECOVERY_ACTIONS:
#         raise RecoveryRequestError(f"unknown recovery action '{action_key}'")

#     meta = RECOVERY_ACTIONS[action_key]

#     ok, reason = validate_recovery_confirmation(confirmation or {}, meta["level"])
#     if not ok:
#         raise RecoveryRequestError(reason)

#     supported, unsupported_reason = meta["supported_check"]()
#     if not supported:
#         raise RecoveryRequestError(f"action '{action_key}' is not supported on this host: {unsupported_reason}")

#     for required in meta["required_params"]:
#         if (raw_params or {}).get(required) in (None, ""):
#             raise RecoveryRequestError(f"missing required parameter '{required}'")

#     resolved_params = resolve_recovery_params(action_key, raw_params or {})

#     # 1. Capture telemetry before execution.
#     before_metrics = _recovery_safe_metrics()

#     # 2. Execute recovery.
#     started = time.monotonic()
#     result = meta["handler"](resolved_params)
#     duration = round(time.monotonic() - started, 3)

#     # 3. Wait briefly if necessary.
#     time.sleep(RECOVERY_SETTLE_SECONDS.get(action_key, RECOVERY_DEFAULT_SETTLE))

#     # 4/5. Refresh telemetry, capture again.
#     after_metrics = _recovery_safe_metrics()

#     # 6. Log and return before/after metrics.
#     verification_status = _recovery_verification_status(
#         fault, before_metrics, after_metrics, bool(result.get("success"))
#     )

#     record_recovery_history({
#         "timestamp": datetime.now(timezone.utc).isoformat(),
#         "action": action_key,
#         "params": raw_params or {},
#         "fault": fault,
#         "confirmation": confirmation or {},
#         "command": result.get("command", ""),
#         "success": bool(result.get("success")),
#         "message": result.get("message", ""),
#         "stdout": result.get("stdout", ""),
#         "stderr": result.get("stderr", ""),
#         "returncode": result.get("returncode"),
#         "duration_seconds": duration,
#         "verificationStatus": verification_status,
#         "before_metrics": before_metrics,
#         "after_metrics": after_metrics,
#     })

#     return {
#         "success": bool(result.get("success")),
#         "message": result.get("message", ""),
#         "command": result.get("command", ""),
#         "output": result.get("stdout", ""),
#         "stdout": result.get("stdout", ""),
#         "stderr": result.get("stderr", ""),
#         "returncode": result.get("returncode"),
#         "beforeMetrics": before_metrics,
#         "afterMetrics": after_metrics,
#         "durationSeconds": duration,
#         "verificationStatus": verification_status,
#     }


# # ============================================================================
# # END RECOVERY ENGINE (registry / validation / verification / history)
# # The routes that call run_recovery_action() and
# # build_recovery_capabilities_report() are added below, inside the
# # existing Flask application section, right after your /health route.
# # ============================================================================


# # --------------------------------------------------------------------------
# # Flask application
# # --------------------------------------------------------------------------

# app = Flask(__name__)
# CORS(app)


# @app.route("/inventory")
# def inventory_endpoint():
#     with _state_lock:
#         data = LATEST_INVENTORY
#     return jsonify(data)


# @app.route("/metrics")
# def metrics_endpoint():
#     with _state_lock:
#         data = LATEST_METRICS
#     return jsonify(data)


# @app.route("/link_health")
# def api_link_health():
#     with _state_lock:
#         return jsonify(LATEST_LINK_HEALTH)


# @app.route("/functional_blocks")
# def api_functional_blocks():
#     """Direct access to just the Internal Functional Block Ledger, without
#     having to pull the full link_health payload."""
#     with _state_lock:
#         data = (LATEST_LINK_HEALTH or {}).get("functional_blocks", {})
#     return jsonify(data)


# @app.route("/platform_extras")
# def api_platform_extras():
#     """Trial2 addition: direct access to the chassis/voltage-probe/cooling-
#     device/battery/power-supply data without pulling the full link_health
#     payload, mirroring the existing /functional_blocks convenience route."""
#     with _state_lock:
#         data = LATEST_LINK_HEALTH or {}
#     return jsonify({
#         "chassis": data.get("chassis", {}),
#         "voltage_probes": data.get("voltage_probes", []),
#         "cooling_devices": data.get("cooling_devices", []),
#         "battery": data.get("battery", {}),
#         "power_supply": data.get("power_supply", {}),
#     })


# @app.route("/health")
# def health_endpoint():
#     return jsonify({"status": "ok", "time": datetime.now(timezone.utc).isoformat()})


# # --------------------------------------------------------------------------
# # Recovery APIs
# # --------------------------------------------------------------------------
# # GET  /recovery/capabilities  -- which recovery actions are supported here
# # POST /recovery/execute       -- run one whitelisted action
# # GET  /recovery/history       -- recent recovery attempts (audit log)
# #
# # The frontend never sends a shell command -- only an action key + params.
# # See the RECOVERY ENGINE section above (registry / validation /
# # verification / history) for everything these routes delegate to.

# @app.route("/recovery/capabilities")
# def recovery_capabilities_endpoint():
#     return jsonify(build_recovery_capabilities_report())


# @app.route("/recovery/execute", methods=["POST"])
# def recovery_execute_endpoint():
#     body = request.get_json(silent=True) or {}

#     action_key = body.get("action")
#     if not action_key or not isinstance(action_key, str):
#         return jsonify({"success": False, "message": "'action' is required"}), 400

#     params = body.get("params") or {}
#     fault = body.get("fault")
#     confirmation = body.get("confirmation") or {}

#     try:
#         result = run_recovery_action(action_key, params, fault, confirmation)
#     except RecoveryRequestError as exc:
#         return jsonify({"success": False, "message": str(exc)}), 400
#     except Exception as exc:  # noqa: BLE001 - never let a bad action crash Flask
#         return jsonify({"success": False, "message": f"internal error: {exc}"}), 500

#     status = 200 if result.get("success") else 409
#     return jsonify(result), status


# @app.route("/recovery/history")
# def recovery_history_endpoint():
#     limit = request.args.get("limit", default=100, type=int)
#     limit = max(1, min(limit, 500))
#     return jsonify({"history": get_recovery_history(limit=limit)})


# # --------------------------------------------------------------------------
# # DEMO fault-injection control (manual)
# # --------------------------------------------------------------------------
# # component: ram | disk | nic | io_controller
# # severity:  healthy | warning | critical
# #
# #   curl -X POST http://<server>:5000/demo/disk/critical
# #   curl -X POST http://<server>:5000/demo/reset
# #   curl http://<server>:5000/demo/state
# #
# # Values ramp gradually toward the target severity over
# # RAMP_SECONDS (60s by default) rather than jumping
# # instantly -- see the DEMO section near the top of this file.

# @app.route("/demo/state")
# def demo_state():
#     return jsonify(get_state())


# @app.route("/demo/reset", methods=["GET", "POST"])
# def demo_reset():
#     reset_all()
#     return jsonify(get_state())


# @app.route("/demo/<component>/<severity>", methods=["GET", "POST"])
# def demo_set(component, severity):
#     ok, message = set_severity(component, severity)
#     if not ok:
#         return jsonify({"error": message}), 400
#     return jsonify(get_state())


# def main() -> None:
#     global LATEST_INVENTORY, LATEST_METRICS, LATEST_LINK_HEALTH

#     # --- DEMO: apply startup fault severities BEFORE the first collection,
#     # so the very first /inventory, /metrics, /link_health response already
#     # reflects them. No separate API call needed during the demo itself. ---
#     parser = argparse.ArgumentParser(description="Hardware monitoring agent")
#     parser.add_argument("--ram", choices=VALID_SEVERITIES, default="healthy")
#     parser.add_argument("--disk", choices=VALID_SEVERITIES, default="healthy")
#     parser.add_argument("--nic", choices=VALID_SEVERITIES, default="healthy")
#     parser.add_argument("--io-controller", choices=VALID_SEVERITIES, default="healthy")
#     args = parser.parse_args()

#     for component, severity in [
#         ("ram", args.ram),
#         ("disk", args.disk),
#         ("nic", args.nic),
#         ("io_controller", args.io_controller),
#     ]:
#         set_severity(component, severity)
#         if severity != "healthy":
#             logger.info("DEMO: %s starting in '%s' state", component, severity)

#     logger.info("Performing initial collection...")
#     try:
#         LATEST_INVENTORY = collect_inventory()
#         LATEST_METRICS = collect_metrics()
#         LATEST_LINK_HEALTH = collect_link_health()
#     except Exception:
#         logger.exception("Initial collection failed; continuing with empty cache")
#         LATEST_INVENTORY = {}
#         LATEST_METRICS = {}
#         LATEST_LINK_HEALTH = {}

#     thread = threading.Thread(target=updater_loop, daemon=True)
#     thread.start()

#     logger.info("Server starting on http://0.0.0.0:5000")
#     app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)


# if __name__ == "__main__":
#     main()