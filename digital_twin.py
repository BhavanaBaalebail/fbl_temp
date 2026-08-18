#!/usr/bin/env python3
"""
digital_twin.py
================

Digital Twin Auto-Heal SIMULATION engine for a Linux server recovery
project.

WHAT THIS FILE IS
------------------
A completely standalone, read-only "what-if" engine. It takes a real
snapshot of the current machine (via psutil), then mathematically
estimates what the system would look like if a given process were
killed / terminated / paused / resumed -- WITHOUT actually doing any of
those things.

WHAT THIS FILE IS NOT
-----------------------
* It does NOT execute any recovery action. No os.kill(), no signal.*,
  no subprocess call that mutates system state. Every "simulate_*"
  function only reads data and performs arithmetic on a COPY of that
  data.
* It does NOT use Flask. This is a pure Python module with a
  command-line entry point at the bottom.
* The real, live process identified by a simulated PID is left running
  untouched, no matter what the simulation predicts.

CURRENT vs PREDICTED
---------------------
Every SimulationResult carries two clearly labeled state snapshots:
    current_state["label"]   == "CURRENT"    (measured, real)
    predicted_state["label"] == "PREDICTED"  (estimated, hypothetical)
Nothing in this file ever writes predicted numbers back into the
"current" side, and no simulation result is ever presented as fact.

Run:
    python3 digital_twin.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Optional

try:
    import psutil
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "digital_twin.py requires the 'psutil' package.\n"
        "Install it with:  pip install psutil\n"
        "(or: pip install psutil --break-system-packages)"
    ) from exc


# ============================================================================
# Constants / tunables -- all documented so the model stays transparent.
# ============================================================================

RISK_LOW = "LOW"
RISK_MEDIUM = "MEDIUM"
RISK_HIGH = "HIGH"
_RISK_ORDER = {RISK_LOW: 0, RISK_MEDIUM: 1, RISK_HIGH: 2}

VALID_ACTIONS = ("kill", "terminate", "pause", "resume")

# Process names we treat as core-system / high blast-radius. Matched
# case-insensitively against the process name reported by psutil.
PROTECTED_PROCESS_NAMES = {
    "systemd", "init", "kthreadd", "sshd", "ssh", "dbus-daemon", "dbus",
    "networkmanager", "containerd", "dockerd", "docker", "cron", "crond",
    "xorg", "x", "gdm", "gdm3", "gnome-shell", "udevd", "systemd-journald",
    "systemd-logind", "systemd-udevd", "systemd-networkd",
    "systemd-resolved", "postgres", "postgresql", "mysqld", "mariadbd",
    "mongod", "redis-server", "nginx", "sudo", "polkitd", "wpa_supplicant",
}
# NOTE: this simulator's own process is protected precisely via the
# os.getpid() check in _assess_risk() below, not by blanket-flagging the
# interpreter name -- putting e.g. "python3" here would wrongly mark
# every unrelated Python script/service on the box as core-system-critical,
# which defeats the purpose of finding real runaway-script candidates.

# Weights used to build the CONFIDENCE score out of available evidence.
# Every weight is documented here rather than buried in code, and the
# score is a deterministic function of what data psutil actually gave us
# for that specific process -- never a random number.
CONFIDENCE_WEIGHTS = {
    "cpu_data_available": 0.35,
    "mem_data_available": 0.25,
    "io_data_available": 0.15,
    "system_stability": 0.15,   # system CPU wasn't ~0 (i.e. sample isn't just noise)
    "signal_strength": 0.10,    # the process's own footprint is non-trivial (>=1%)
}

# Weights used to build the single-number EXPECTED IMPROVEMENT score out
# of the three measured deltas. Documented so ranking is auditable.
IMPROVEMENT_WEIGHTS = {
    "cpu": 0.60,
    "ram": 0.30,
    "io": 0.10,   # io_delta_mb_s is capped at 100 before weighting, see below
}

DEFAULT_SAMPLE_INTERVAL_SECONDS = 1.0

# Explicit "we did not fabricate this" sentinel, used wherever a metric
# genuinely cannot be obtained on this system (missing sysfs node, no
# NVIDIA driver, permission denied, etc). Never silently substituted
# with 0 or a guess.
NOT_AVAILABLE = "not available on this system"
NO_SAFE_CANDIDATE_MSG = "no safe simulated recovery candidate available"

DOMAIN_CPU = "cpu"
DOMAIN_RAM = "ram"
DOMAIN_DISK = "disk"
DOMAIN_NIC = "nic"
DOMAIN_IO_CONTROLLER = "io_controller"
DOMAIN_GPU = "gpu"
VALID_DOMAINS = (DOMAIN_CPU, DOMAIN_RAM, DOMAIN_DISK, DOMAIN_NIC, DOMAIN_IO_CONTROLLER, DOMAIN_GPU)

# Pressure-detection thresholds. Deliberately simple/conservative and
# gathered in one place so they're easy to tune per-deployment rather
# than buried inline.
PRESSURE_THRESHOLDS = {
    "cpu_percent": 90.0,
    "load_avg_per_core": 1.5,
    "ram_percent": 90.0,
    "swap_percent": 50.0,
    "disk_percent": 90.0,
    "io_time_ms_delta": 800.0,      # per sample window, i.e. device close to saturated
    "nic_error_rate": 0.01,         # errors / (rx+tx packets-equivalent proxy); see detect_pressure
    "gpu_utilization_percent": 95.0,
    "gpu_memory_percent": 95.0,
}


# ============================================================================
# Data model
# ============================================================================

@dataclass
class ProcessSnapshot:
    pid: int
    name: Optional[str]
    username: Optional[str]
    status: Optional[str]
    cpu_percent: float                 # % of ALL cores, over the sample window
    memory_percent: float              # % of total system RAM
    memory_mb: float
    read_mb_s: Optional[float]         # None if io_counters() was unavailable
    write_mb_s: Optional[float]
    io_available: bool


@dataclass
class GPUSnapshot:
    index: int
    name: str
    utilization_percent: Optional[float]
    memory_used_mb: Optional[float]
    memory_total_mb: Optional[float]
    temperature_c: Optional[float]
    power_watts: Optional[float] = None
    processes: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class NICSnapshot:
    """One network interface, discovered dynamically -- never hardcoded.
    Any field psutil/the OS can't supply is left as the literal string
    "not available on this system" (or None for numeric-typed fields
    where a sentinel string would break arithmetic elsewhere -- see
    NOT_AVAILABLE / _na() below), never a fabricated number."""
    name: str
    is_up: Optional[bool]
    speed_mbps: Optional[float]
    duplex: Optional[str]
    mtu: Optional[int]
    addresses: list[str]
    rx_mb_s: Optional[float]
    tx_mb_s: Optional[float]
    rx_errors: Optional[int]
    tx_errors: Optional[int]
    rx_drops: Optional[int]
    tx_drops: Optional[int]


@dataclass
class IOControllerSnapshot:
    """One block device, read from /sys/block/<dev>/stat where available.
    Linux stat fields (see Documentation/admin-guide/iostats.rst):
    reads_completed, reads_merged, sectors_read, ms_reading,
    writes_completed, writes_merged, sectors_written, ms_writing,
    io_in_progress, ms_doing_io, weighted_ms_doing_io [, ...discard
    fields on newer kernels, ignored here]."""
    device: str
    reads_completed_delta: Optional[int]
    writes_completed_delta: Optional[int]
    sectors_read_delta: Optional[int]
    sectors_written_delta: Optional[int]
    io_in_progress: Optional[int]
    io_time_ms_delta: Optional[int]
    weighted_io_time_ms_delta: Optional[int]
    available: bool


@dataclass
class DigitalTwinState:
    timestamp: str
    sample_interval_seconds: float

    cpu_percent: float
    cpu_core_count: int
    cpu_percent_per_core: list[float] = field(default_factory=list)
    load_avg_1: Optional[float] = None
    load_avg_5: Optional[float] = None
    load_avg_15: Optional[float] = None

    ram_percent: float = 0.0
    ram_used_gb: float = 0.0
    ram_total_gb: float = 0.0
    ram_available_gb: Optional[float] = None
    ram_free_gb: Optional[float] = None
    ram_cached_gb: Optional[float] = None
    swap_percent: Optional[float] = None
    swap_used_gb: Optional[float] = None
    swap_total_gb: Optional[float] = None

    disk_percent: float = 0.0
    disk_used_gb: float = 0.0
    disk_total_gb: float = 0.0
    disk_read_mb_s: float = 0.0
    disk_write_mb_s: float = 0.0

    net_rx_mb_s: float = 0.0
    net_tx_mb_s: float = 0.0

    gpus: list[GPUSnapshot] = field(default_factory=list)
    processes: list[ProcessSnapshot] = field(default_factory=list)
    nics: list[NICSnapshot] = field(default_factory=list)
    io_controllers: list[IOControllerSnapshot] = field(default_factory=list)

    def find_process(self, pid: int) -> Optional[ProcessSnapshot]:
        for p in self.processes:
            if p.pid == pid:
                return p
        return None

    def find_nic(self, name: str) -> Optional[NICSnapshot]:
        for n in self.nics:
            if n.name == name:
                return n
        return None

    def find_io_controller(self, device: str) -> Optional[IOControllerSnapshot]:
        for d in self.io_controllers:
            if d.device == device:
                return d
        return None

    def top_by_cpu(self, n: int = 10) -> list[ProcessSnapshot]:
        return sorted(self.processes, key=lambda p: p.cpu_percent, reverse=True)[:n]

    def top_by_memory(self, n: int = 10) -> list[ProcessSnapshot]:
        return sorted(self.processes, key=lambda p: p.memory_percent, reverse=True)[:n]

    def top_by_io(self, n: int = 10) -> list[ProcessSnapshot]:
        """Top processes by combined read+write MB/s. Processes whose I/O
        wasn't measurable (io_available=False) are excluded rather than
        treated as 0, so they never crowd out real high-I/O processes."""
        measurable = [p for p in self.processes if p.io_available]
        return sorted(
            measurable,
            key=lambda p: (p.read_mb_s or 0.0) + (p.write_mb_s or 0.0),
            reverse=True,
        )[:n]

    def summary_dict(self) -> dict[str, Any]:
        """System-wide metrics only (no per-process list) -- used inside
        SimulationResult.current_state / predicted_state so those stay
        compact and clearly labeled."""
        return {
            "timestamp": self.timestamp,
            "cpu_percent": round(self.cpu_percent, 2),
            "load_avg_1": self.load_avg_1,
            "ram_percent": round(self.ram_percent, 2),
            "ram_used_gb": round(self.ram_used_gb, 2),
            "ram_available_gb": self.ram_available_gb,
            "swap_percent": self.swap_percent,
            "disk_percent": round(self.disk_percent, 2),
            "disk_read_mb_s": round(self.disk_read_mb_s, 3),
            "disk_write_mb_s": round(self.disk_write_mb_s, 3),
            "net_rx_mb_s": round(self.net_rx_mb_s, 3),
            "net_tx_mb_s": round(self.net_tx_mb_s, 3),
            "gpu_utilization_percent": (
                round(self.gpus[0].utilization_percent, 2)
                if self.gpus and self.gpus[0].utilization_percent is not None
                else None
            ),
        }


@dataclass
class SimulationResult:
    action: str
    target_pid: Optional[int]
    target_process: Optional[str]

    current_state: dict[str, Any]      # label == "CURRENT"
    predicted_state: dict[str, Any]    # label == "PREDICTED"

    cpu_delta_percent: float
    ram_delta_percent: float
    ram_delta_mb: float
    disk_io_delta_mb_s: float
    net_delta_mb_s: Optional[float]

    expected_improvement_percent: float
    risk: str
    confidence_percent: float
    reversible: bool
    requires_approval: bool

    explanation: str
    warnings: list[str] = field(default_factory=list)

    # Domain-awareness (added on top of the original CPU/RAM-centric
    # engine, kept at the end with defaults so existing positional/keyword
    # construction of SimulationResult stays backward compatible).
    domain: str = "process"
    """Which subsystem this simulation is about: one of VALID_DOMAINS, or
    the legacy value "process" for the original multi-domain (cpu+ram+
    disk) kill/terminate/pause/resume actions. Fields that don't apply to
    a given domain are left as None (numeric) rather than fabricated --
    see simulate_nic_action / simulate_io_controller_action /
    simulate_gpu_action for the single-domain engines."""
    target_name: Optional[str] = None
    """Non-PID target identifier for nic/io_controller/gpu domains, e.g.
    an interface name or block device name. None for process actions."""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# Module-level cache of the most recently collected state, so the
# convenience signatures simulate_kill_process(pid) etc. don't have to
# re-sample the whole machine (~1s of work) on every call. Anyone who
# wants a specific, reproducible state can still pass `state=` explicitly.
_LATEST_STATE: Optional[DigitalTwinState] = None


# ============================================================================
# 1. collect_current_state()
# ============================================================================

def _collect_gpu_snapshot() -> list[GPUSnapshot]:
    """Best-effort NVIDIA GPU read via nvidia-smi. Returns [] (not an
    error) on any machine without an NVIDIA GPU / driver -- GPU data is
    optional everywhere else in this file."""
    if not shutil.which("nvidia-smi"):
        return []
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
                "--format=csv,noheader,nounits",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
            check=False,
        ).stdout
    except Exception:
        return []

    gpus: list[GPUSnapshot] = []
    for line in out.strip().splitlines():
        fields = [f.strip() for f in line.split(",")]
        if len(fields) < 6:
            continue
        try:
            power = float(fields[6]) if len(fields) >= 7 and fields[6] not in ("", "N/A", "[N/A]") else None
            gpus.append(GPUSnapshot(
                index=int(fields[0]),
                name=fields[1],
                utilization_percent=float(fields[2]),
                memory_used_mb=float(fields[3]),
                memory_total_mb=float(fields[4]),
                temperature_c=float(fields[5]),
                power_watts=power,
            ))
        except ValueError:
            continue

    # Best-effort per-GPU process list. Failure here must never lose the
    # GPU utilization/memory data already collected above.
    try:
        proc_out = subprocess.run(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,used_memory,gpu_uuid",
                "--format=csv,noheader,nounits",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
            check=False,
        ).stdout
        for line in proc_out.strip().splitlines():
            pfields = [f.strip() for f in line.split(",")]
            if len(pfields) < 2:
                continue
            try:
                pid = int(pfields[0])
                used_mb = float(pfields[1])
            except ValueError:
                continue
            if gpus:
                gpus[0].processes.append({"pid": pid, "used_memory_mb": used_mb})
    except Exception:
        pass

    return gpus


def _collect_nic_snapshots(net_io_1: dict, net_io_2: dict, elapsed: float) -> list[NICSnapshot]:
    """Dynamic per-interface discovery -- NEVER hardcodes interface names.
    Uses psutil.net_if_stats() / net_if_addrs() / net_io_counters(pernic=True)
    exclusively. Any metric the OS doesn't expose for a given interface is
    left as None rather than fabricated."""
    nics: list[NICSnapshot] = []
    try:
        if_stats = psutil.net_if_stats()
    except Exception:
        if_stats = {}
    try:
        if_addrs = psutil.net_if_addrs()
    except Exception:
        if_addrs = {}

    all_names = set(if_stats.keys()) | set(if_addrs.keys()) | set(net_io_1.keys()) | set(net_io_2.keys())
    for name in sorted(all_names):
        stats = if_stats.get(name)
        addrs = if_addrs.get(name, [])
        io1 = net_io_1.get(name)
        io2 = net_io_2.get(name)

        is_up = stats.isup if stats is not None else None
        speed = float(stats.speed) if (stats is not None and stats.speed and stats.speed > 0) else None
        duplex = None
        if stats is not None:
            duplex_name = getattr(stats.duplex, "name", None)
            duplex = duplex_name if duplex_name else None
        mtu = stats.mtu if stats is not None else None

        addr_list = [a.address for a in addrs if getattr(a, "address", None)]

        rx_mb_s = tx_mb_s = None
        rx_err = tx_err = rx_drop = tx_drop = None
        if io1 is not None and io2 is not None and elapsed > 0:
            rx_mb_s = round(max(0, io2.bytes_recv - io1.bytes_recv) / (1024 ** 2) / elapsed, 4)
            tx_mb_s = round(max(0, io2.bytes_sent - io1.bytes_sent) / (1024 ** 2) / elapsed, 4)
            rx_err = max(0, io2.errin - io1.errin)
            tx_err = max(0, io2.errout - io1.errout)
            rx_drop = max(0, io2.dropin - io1.dropin)
            tx_drop = max(0, io2.dropout - io1.dropout)

        nics.append(NICSnapshot(
            name=name,
            is_up=is_up,
            speed_mbps=speed,
            duplex=duplex,
            mtu=mtu,
            addresses=addr_list,
            rx_mb_s=rx_mb_s,
            tx_mb_s=tx_mb_s,
            rx_errors=rx_err,
            tx_errors=tx_err,
            rx_drops=rx_drop,
            tx_drops=tx_drop,
        ))
    return nics


def _read_sysfs_block_stat(device: str) -> Optional[list[int]]:
    """Read /sys/block/<device>/stat and return the raw integer fields, or
    None if the node doesn't exist / isn't readable on this system."""
    path = f"/sys/block/{device}/stat"
    try:
        with open(path, "r") as fh:
            raw = fh.read().split()
        return [int(x) for x in raw]
    except (OSError, ValueError):
        return None


def _list_block_devices() -> list[str]:
    try:
        return sorted(
            d for d in os.listdir("/sys/block")
            if not d.startswith("loop") and not d.startswith("ram")
        )
    except OSError:
        return []


def _collect_io_controller_snapshots(stat_first: dict[str, Optional[list[int]]]) -> list[IOControllerSnapshot]:
    """Second sample of /sys/block/<dev>/stat, diffed against stat_first.
    Field layout (Documentation/admin-guide/iostats.rst), index:
      0 reads_completed, 3 ms_reading, 4 writes_completed, 7 ms_writing,
      2 sectors_read, 6 sectors_written, 8 io_in_progress, 9 ms_doing_io,
      10 weighted_ms_doing_io
    Anything missing/short is reported via available=False rather than a
    fabricated delta of 0."""
    snapshots: list[IOControllerSnapshot] = []
    for device, first in stat_first.items():
        second = _read_sysfs_block_stat(device)
        if first is None or second is None or len(first) < 11 or len(second) < 11:
            snapshots.append(IOControllerSnapshot(
                device=device,
                reads_completed_delta=None,
                writes_completed_delta=None,
                sectors_read_delta=None,
                sectors_written_delta=None,
                io_in_progress=None,
                io_time_ms_delta=None,
                weighted_io_time_ms_delta=None,
                available=False,
            ))
            continue
        snapshots.append(IOControllerSnapshot(
            device=device,
            reads_completed_delta=max(0, second[0] - first[0]),
            writes_completed_delta=max(0, second[4] - first[4]),
            sectors_read_delta=max(0, second[2] - first[2]),
            sectors_written_delta=max(0, second[6] - first[6]),
            io_in_progress=second[8],
            io_time_ms_delta=max(0, second[9] - first[9]),
            weighted_io_time_ms_delta=max(0, second[10] - first[10]),
            available=True,
        ))
    return snapshots


def collect_current_state(sample_interval: float = DEFAULT_SAMPLE_INTERVAL_SECONDS) -> DigitalTwinState:
    """
    Take a real, measured snapshot of the current machine.

    Two-sample method (mirrors how the CPU/IO controllers in the main
    project measure rates): prime all counters, sleep ~sample_interval
    seconds, sample again, and derive per-second rates from the delta.
    This is read-only -- it never modifies anything.
    """
    global _LATEST_STATE

    # ---- prime system-wide counters ----
    psutil.cpu_percent(interval=None)
    psutil.cpu_percent(interval=None, percpu=True)
    disk_io_1 = psutil.disk_io_counters()
    net_io_1 = psutil.net_io_counters()
    try:
        net_io_1_pernic = psutil.net_io_counters(pernic=True)
    except Exception:
        net_io_1_pernic = {}
    block_devices = _list_block_devices()
    io_stat_1 = {d: _read_sysfs_block_stat(d) for d in block_devices}

    # ---- prime per-process counters ----
    proc_handles: list[psutil.Process] = []
    io_first: dict[int, tuple[int, int]] = {}
    for p in psutil.process_iter(attrs=["pid", "name", "username", "status"]):
        try:
            p.cpu_percent(None)  # primes psutil's internal per-process timer
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
        proc_handles.append(p)
        try:
            io = p.io_counters()
            io_first[p.pid] = (io.read_bytes, io.write_bytes)
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, AttributeError):
            pass  # this process's I/O simply won't be measurable

    time.sleep(max(sample_interval, 0.1))

    # ---- second sample: system-wide ----
    cpu_percent = psutil.cpu_percent(interval=None)
    cpu_percent_per_core = psutil.cpu_percent(interval=None, percpu=True)
    disk_io_2 = psutil.disk_io_counters()
    net_io_2 = psutil.net_io_counters()
    try:
        net_io_2_pernic = psutil.net_io_counters(pernic=True)
    except Exception:
        net_io_2_pernic = {}
    vm = psutil.virtual_memory()
    sm = psutil.swap_memory()
    du = psutil.disk_usage("/")

    try:
        load1, load5, load15 = os.getloadavg()
    except (OSError, AttributeError):
        load1 = load5 = load15 = None

    nics = _collect_nic_snapshots(net_io_1_pernic, net_io_2_pernic, max(sample_interval, 0.1))
    io_controllers = _collect_io_controller_snapshots(io_stat_1)

    elapsed = max(sample_interval, 0.1)

    disk_read_mb_s = 0.0
    disk_write_mb_s = 0.0
    if disk_io_1 and disk_io_2:
        disk_read_mb_s = max(0.0, disk_io_2.read_bytes - disk_io_1.read_bytes) / (1024 ** 2) / elapsed
        disk_write_mb_s = max(0.0, disk_io_2.write_bytes - disk_io_1.write_bytes) / (1024 ** 2) / elapsed

    net_rx_mb_s = 0.0
    net_tx_mb_s = 0.0
    if net_io_1 and net_io_2:
        net_rx_mb_s = max(0.0, net_io_2.bytes_recv - net_io_1.bytes_recv) / (1024 ** 2) / elapsed
        net_tx_mb_s = max(0.0, net_io_2.bytes_sent - net_io_1.bytes_sent) / (1024 ** 2) / elapsed

    # ---- second sample: per-process ----
    processes: list[ProcessSnapshot] = []
    for p in proc_handles:
        try:
            cpu_pct = p.cpu_percent(None)
            mem_pct = p.memory_percent()
            mem_mb = p.memory_info().rss / (1024 ** 2)
            name = p.info.get("name") if p.info else None
            username = p.info.get("username") if p.info else None
            status = p.info.get("status") if p.info else None
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue  # process vanished between samples -- drop it, don't guess

        read_mb_s = write_mb_s = None
        io_available = False
        if p.pid in io_first:
            try:
                io2 = p.io_counters()
                d_read = max(0, io2.read_bytes - io_first[p.pid][0])
                d_write = max(0, io2.write_bytes - io_first[p.pid][1])
                read_mb_s = round(d_read / (1024 ** 2) / elapsed, 4)
                write_mb_s = round(d_write / (1024 ** 2) / elapsed, 4)
                io_available = True
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, AttributeError):
                pass

        processes.append(ProcessSnapshot(
            pid=p.pid,
            name=name,
            username=username,
            status=status,
            cpu_percent=round(cpu_pct, 2),
            memory_percent=round(mem_pct, 2),
            memory_mb=round(mem_mb, 2),
            read_mb_s=read_mb_s,
            write_mb_s=write_mb_s,
            io_available=io_available,
        ))

    state = DigitalTwinState(
        timestamp=datetime.now(timezone.utc).isoformat(),
        sample_interval_seconds=elapsed,
        cpu_percent=round(cpu_percent, 2),
        cpu_core_count=psutil.cpu_count(logical=True) or 1,
        cpu_percent_per_core=[round(c, 2) for c in cpu_percent_per_core],
        load_avg_1=round(load1, 2) if load1 is not None else None,
        load_avg_5=round(load5, 2) if load5 is not None else None,
        load_avg_15=round(load15, 2) if load15 is not None else None,
        ram_percent=round(vm.percent, 2),
        ram_used_gb=round(vm.used / (1024 ** 3), 3),
        ram_available_gb=round(vm.available / (1024 ** 3), 3),
        ram_free_gb=round(vm.free / (1024 ** 3), 3),
        ram_cached_gb=round(getattr(vm, "cached", 0) / (1024 ** 3), 3) if hasattr(vm, "cached") else None,
        swap_percent=round(sm.percent, 2),
        swap_used_gb=round(sm.used / (1024 ** 3), 3),
        swap_total_gb=round(sm.total / (1024 ** 3), 3),
        ram_total_gb=round(vm.total / (1024 ** 3), 3),
        disk_percent=round(du.percent, 2),
        disk_used_gb=round(du.used / (1024 ** 3), 3),
        disk_total_gb=round(du.total / (1024 ** 3), 3),
        disk_read_mb_s=round(disk_read_mb_s, 4),
        disk_write_mb_s=round(disk_write_mb_s, 4),
        net_rx_mb_s=round(net_rx_mb_s, 4),
        net_tx_mb_s=round(net_tx_mb_s, 4),
        gpus=_collect_gpu_snapshot(),
        processes=processes,
        nics=nics,
        io_controllers=io_controllers,
    )

    _LATEST_STATE = state
    return state


def _resolve_state(state: Optional[DigitalTwinState]) -> DigitalTwinState:
    """Shared helper: use the caller-supplied state, else the last
    collected one, else collect a fresh one now."""
    if state is not None:
        return state
    if _LATEST_STATE is not None:
        return _LATEST_STATE
    return collect_current_state()


# ============================================================================
# Risk / confidence / improvement scoring -- deterministic, documented.
# ============================================================================

def _assess_risk(proc: ProcessSnapshot, action: str, state: DigitalTwinState,
                  predicted_cpu: float) -> tuple[str, list[str]]:
    warnings: list[str] = []
    score = 0  # 0-1 -> LOW, 2 -> MEDIUM, >=3 -> HIGH

    name = (proc.name or "").lower()
    is_protected = name in PROTECTED_PROCESS_NAMES

    if proc.pid in (0, 1, 2):
        score += 3
        warnings.append("target is PID 0/1/2 (kernel/init) -- never a real recovery candidate")
    elif proc.pid == os.getpid():
        score += 3
        warnings.append("target is this simulator's own process")
    elif is_protected:
        score += 3
        warnings.append(f"'{proc.name}' matches a protected core-system process name")

    if action == "kill":
        score += 1  # SIGKILL: no cleanup, higher blast radius than SIGTERM
    elif action in ("pause", "resume"):
        score -= 1  # reversible actions are structurally safer

    if proc.memory_percent >= 40:
        score += 1
        warnings.append(f"process holds {proc.memory_percent:.1f}% of system RAM -- large blast radius")

    if action == "resume" and predicted_cpu >= 90:
        score += 2
        warnings.append(f"resuming would push predicted system CPU to {predicted_cpu:.1f}% -- overload risk")

    if (proc.username or "").lower() in ("root",):
        score += 1
        warnings.append("process is root-owned -- more likely to be a system/service process")

    if action in ("kill", "terminate") and (proc.status or "").lower() == "stopped":
        # Already stopped and now being killed: not inherently riskier by
        # itself, but flag it since it means an earlier pause was never
        # resumed/cleaned up -- a sign the caller's action sequence may be
        # stale/out of order.
        warnings.append("process is already in a STOPPED state -- verify this isn't a leftover pause before killing it")

    if action in ("kill", "terminate"):
        try:
            child_count = len(psutil.Process(proc.pid).children(recursive=True))
            if child_count > 0:
                score += 1
                warnings.append(
                    f"process has {child_count} child process(es) -- killing/terminating it may orphan or "
                    f"cascade-kill them depending on the process group; blast radius is larger than one PID"
                )
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass  # process may have exited since the state snapshot; don't fabricate a child count

    score = max(0, score)
    if score >= 3:
        risk = RISK_HIGH
    elif score == 2:
        risk = RISK_MEDIUM
    else:
        risk = RISK_LOW
    return risk, warnings


def _assess_confidence(
    proc: ProcessSnapshot,
    state: DigitalTwinState,
    *,
    domain: str = "process",
    action: str = "pause",
    apply_learning: bool = True,
) -> float:
    """Confidence is a weighted score built entirely from which pieces of
    real monitoring evidence were actually available for this process --
    never a random number. See CONFIDENCE_WEIGHTS above for the weights.
    Historical prediction error (digital_twin_learning) can only reduce it."""
    c_cpu = 1.0  # cpu_percent() always returns a real value once primed
    c_mem = 1.0  # memory_percent()/memory_info() always available if proc exists
    c_io = 1.0 if proc.io_available else 0.4
    c_stability = 1.0 if state.cpu_percent > 0.5 else 0.7  # near-zero system load = noisier %
    c_signal = 1.0 if (proc.cpu_percent >= 1.0 or proc.memory_percent >= 1.0) else 0.6

    score = (
        CONFIDENCE_WEIGHTS["cpu_data_available"] * c_cpu
        + CONFIDENCE_WEIGHTS["mem_data_available"] * c_mem
        + CONFIDENCE_WEIGHTS["io_data_available"] * c_io
        + CONFIDENCE_WEIGHTS["system_stability"] * c_stability
        + CONFIDENCE_WEIGHTS["signal_strength"] * c_signal
    )
    confidence = round(max(0.0, min(1.0, score)) * 100, 1)
    if apply_learning:
        confidence = _apply_learning_confidence(
            confidence,
            process_name=proc.name,
            action=action,
            domain=domain,
            metric="cpu_percent" if domain in (DOMAIN_CPU, "process") else "ram_percent",
        )
    return confidence


def _apply_learning_confidence(
    confidence_percent: float,
    *,
    process_name: Optional[str],
    action: str,
    domain: str,
    metric: str,
) -> float:
    """Apply historical error penalty from digital_twin_learning (never boosts above base)."""
    try:
        import digital_twin_learning as dtl
    except ImportError:
        return confidence_percent
    adj = dtl.confidence_adjustment(process_name, action, domain, metric)
    return round(max(0.0, min(100.0, confidence_percent * adj)), 1)


def _expected_improvement(cpu_delta: float, ram_delta_percent: float,
                           io_delta_mb_s: float, direction: int) -> float:
    """direction = +1 for freeing resources (kill/terminate/pause),
    -1 for resume (adding load back -> a negative 'improvement', i.e. a
    predicted degradation). io_delta is capped at 100 before weighting so
    one noisy high-throughput process can't dominate the score."""
    io_score = min(100.0, abs(io_delta_mb_s))
    raw = (
        IMPROVEMENT_WEIGHTS["cpu"] * abs(cpu_delta)
        + IMPROVEMENT_WEIGHTS["ram"] * abs(ram_delta_percent)
        + IMPROVEMENT_WEIGHTS["io"] * io_score
    )
    return round(direction * raw, 2)


def _clamp(value: float, lo: float, hi: float) -> float:
    """Keep a predicted value inside its physically valid range."""
    return max(lo, min(hi, value))


def _process_cpu_contribution(proc: ProcessSnapshot, state: DigitalTwinState) -> float:
    """
    Convert a psutil per-process cpu_percent() reading into its estimated
    contribution to TOTAL SYSTEM CPU utilization.

    Why this conversion is needed:
    psutil.Process.cpu_percent() is reported on a PER-CORE basis -- a
    single-threaded process fully busy on one core reports ~100%,
    regardless of how many logical CPUs the box has. psutil's SYSTEM-WIDE
    cpu_percent(), however, is normalized across ALL logical CPUs, where
    100% means every core is fully busy.

    These two numbers are on different scales and must never be
    subtracted from each other directly. On a 28-core box, a worker
    reporting 99.9% CPU (per-core basis) is only consuming roughly
    99.9 / 28 ~= 3.6 percentage points of the system's TOTAL CPU capacity
    -- not 99.9 points of it.

        contribution_to_system_percent = process_cpu_percent / logical_cpu_count

    The result is clamped to [0, 100] since a single process's
    contribution to total system utilization can never exceed 100% of
    system capacity, even in edge cases where cpu_percent() briefly
    overshoots (e.g. right after a core count change).
    """
    cores = max(state.cpu_core_count, 1)
    contribution = proc.cpu_percent / cores
    return round(_clamp(contribution, 0.0, 100.0), 4)


# ============================================================================
# 2-5. simulate_kill_process / simulate_pause_process /
#      simulate_resume_process / simulate_terminate_process
# 6. simulate_action -- shared dispatcher used by all four above
# ============================================================================

def simulate_action(action: str, pid: int, state: Optional[DigitalTwinState] = None) -> SimulationResult:
    """
    Core simulation dispatcher. NEVER executes anything -- it only reads
    `state` (a DigitalTwinState already collected from the real machine)
    and computes a hypothetical PREDICTED state.

    action: one of "kill", "terminate", "pause", "resume"
    """
    if action not in VALID_ACTIONS:
        raise ValueError(f"unknown action '{action}', expected one of {VALID_ACTIONS}")

    state = _resolve_state(state)
    proc = state.find_process(pid)
    if proc is None:
        raise ValueError(
            f"pid {pid} was not present in the collected DigitalTwinState "
            f"(it may have exited, or the state is stale -- call collect_current_state() again)"
        )

    warnings: list[str] = [
        "network delta is per-system only -- psutil cannot attribute RX/TX "
        "throughput to a single process on Linux without extra tooling "
        "(e.g. eBPF/nethogs), so net_delta_mb_s is reported as null for this action."
    ]

    proc_io = (proc.read_mb_s or 0.0) + (proc.write_mb_s or 0.0)

    # Per-core (psutil raw) -> total-system-percentage-points conversion.
    # See _process_cpu_contribution() docstring for why this division by
    # logical_cpus is required rather than subtracting proc.cpu_percent
    # from state.cpu_percent directly.
    cpu_contribution = _process_cpu_contribution(proc, state)
    contribution_note = (
        f"CPU contribution calculation: this process reports {proc.cpu_percent:.1f}% CPU on "
        f"psutil's per-core basis. With {state.cpu_core_count} logical CPUs, its estimated "
        f"contribution to TOTAL system CPU utilization is "
        f"{proc.cpu_percent:.1f} / {state.cpu_core_count} ~= {cpu_contribution:.2f} "
        f"percentage points (not {proc.cpu_percent:.1f} points)."
    )
    conservative_note = (
        "This estimate is intentionally conservative: it assumes the freed CPU capacity is "
        "not immediately reclaimed by other runnable processes (e.g. sibling stress-test "
        "workers). In practice the OS scheduler often redistributes freed capacity to other "
        "busy processes, so the actual drop in system-wide CPU may be smaller than predicted."
    )

    if action in ("kill", "terminate"):
        cpu_delta = cpu_contribution
        ram_delta_mb = proc.memory_mb
        ram_delta_percent = proc.memory_percent
        io_delta = proc_io
        reversible = False

        predicted_cpu = _clamp(state.cpu_percent - cpu_delta, 0.0, 100.0)
        predicted_ram_used_gb = _clamp(state.ram_used_gb - ram_delta_mb / 1024, 0.0, state.ram_total_gb)
        predicted_ram_percent = (
            _clamp(predicted_ram_used_gb / state.ram_total_gb * 100, 0.0, 100.0)
            if state.ram_total_gb else state.ram_percent
        )
        predicted_disk_read = _clamp(state.disk_read_mb_s - (proc.read_mb_s or 0.0), 0.0, float("inf"))
        predicted_disk_write = _clamp(state.disk_write_mb_s - (proc.write_mb_s or 0.0), 0.0, float("inf"))

        verb = "force-killed (SIGKILL)" if action == "kill" else "gracefully terminated (SIGTERM)"
        explanation = (
            f"If PID {pid} ({proc.name}) were {verb}, its {proc.memory_mb:.1f} MB RAM would be "
            f"released, and its estimated {cpu_delta:.2f} percentage points of total system CPU "
            f"would become free. Predicted system CPU: {state.cpu_percent:.1f}% -> "
            f"{predicted_cpu:.1f}%. {contribution_note} {conservative_note} This is a PREDICTION "
            f"based on the last measured sample, not a guarantee."
        )

    elif action == "pause":
        cpu_delta = cpu_contribution
        ram_delta_mb = 0.0        # a stopped process keeps its resident memory
        ram_delta_percent = 0.0
        io_delta = proc_io        # I/O halts while the process is stopped
        reversible = True

        predicted_cpu = _clamp(state.cpu_percent - cpu_delta, 0.0, 100.0)
        predicted_ram_used_gb = _clamp(state.ram_used_gb, 0.0, state.ram_total_gb)
        predicted_ram_percent = _clamp(state.ram_percent, 0.0, 100.0)
        predicted_disk_read = _clamp(state.disk_read_mb_s - (proc.read_mb_s or 0.0), 0.0, float("inf"))
        predicted_disk_write = _clamp(state.disk_write_mb_s - (proc.write_mb_s or 0.0), 0.0, float("inf"))

        explanation = (
            f"If PID {pid} ({proc.name}) were paused (SIGSTOP), its I/O activity would stop and "
            f"its estimated {cpu_delta:.2f} percentage points of total system CPU would become "
            f"free, but its {proc.memory_mb:.1f} MB resident memory would remain allocated (a "
            f"stopped process is not freed). Predicted system CPU: {state.cpu_percent:.1f}% -> "
            f"{predicted_cpu:.1f}%. {contribution_note} {conservative_note} Fully reversible via resume."
        )

    else:  # resume
        cpu_delta = -cpu_contribution
        ram_delta_mb = 0.0
        ram_delta_percent = 0.0
        io_delta = -proc_io
        reversible = True

        predicted_cpu = _clamp(state.cpu_percent + cpu_contribution, 0.0, 100.0)
        predicted_ram_used_gb = _clamp(state.ram_used_gb, 0.0, state.ram_total_gb)
        predicted_ram_percent = _clamp(state.ram_percent, 0.0, 100.0)
        predicted_disk_read = _clamp(state.disk_read_mb_s + (proc.read_mb_s or 0.0), 0.0, float("inf"))
        predicted_disk_write = _clamp(state.disk_write_mb_s + (proc.write_mb_s or 0.0), 0.0, float("inf"))

        explanation = (
            f"If PID {pid} ({proc.name}) were resumed (SIGCONT) from a stopped state, it would be "
            f"expected to reintroduce roughly its last-measured {cpu_contribution:.2f} percentage "
            f"points of total system CPU. Predicted system CPU: {state.cpu_percent:.1f}% -> "
            f"{predicted_cpu:.1f}%. {contribution_note} Note: this is a projected INCREASE in "
            f"load, not an improvement -- expected_improvement_percent below is negative to reflect that."
        )

    disk_io_delta_mb_s = round(
        (state.disk_read_mb_s + state.disk_write_mb_s)
        - (predicted_disk_read + predicted_disk_write),
        4,
    )

    risk, risk_warnings = _assess_risk(proc, action, state, predicted_cpu)
    confidence = _assess_confidence(proc, state, action=action)
    direction = -1 if action == "resume" else 1
    expected_improvement = _expected_improvement(cpu_delta, ram_delta_percent, io_delta, direction)

    requires_approval = (risk in (RISK_MEDIUM, RISK_HIGH)) or (action in ("kill", "terminate"))

    predicted_state_dict = state.summary_dict()
    predicted_state_dict.update({
        "label": "PREDICTED",
        "cpu_percent": round(predicted_cpu, 2),
        "ram_percent": round(predicted_ram_percent, 2),
        "ram_used_gb": round(predicted_ram_used_gb, 3),
        "disk_read_mb_s": round(predicted_disk_read, 4),
        "disk_write_mb_s": round(predicted_disk_write, 4),
    })
    current_state_dict = state.summary_dict()
    current_state_dict["label"] = "CURRENT"

    return SimulationResult(
        action=action,
        target_pid=pid,
        target_process=proc.name,
        domain="process",  # legacy multi-domain (cpu+ram+disk) action; see docstring on SimulationResult.domain
        target_name=None,
        current_state=current_state_dict,
        predicted_state=predicted_state_dict,
        cpu_delta_percent=round(cpu_delta, 2),
        ram_delta_percent=round(ram_delta_percent, 2),
        ram_delta_mb=round(ram_delta_mb, 2),
        disk_io_delta_mb_s=disk_io_delta_mb_s,
        net_delta_mb_s=None,  # never measurable per-process here -- see warnings
        expected_improvement_percent=expected_improvement,
        risk=risk,
        confidence_percent=confidence,
        reversible=reversible,
        requires_approval=requires_approval,
        explanation=explanation,
        warnings=warnings + risk_warnings,
    )


def _na_state_dict(label: str) -> dict[str, Any]:
    """A CURRENT/PREDICTED dict for single-domain simulations where most
    of the generic summary_dict() fields simply don't apply. Every field
    is explicitly None/"not applicable" rather than fabricated."""
    return {
        "label": label,
        "cpu_percent": None,
        "ram_percent": None,
        "ram_used_gb": None,
        "disk_percent": None,
        "disk_read_mb_s": None,
        "disk_write_mb_s": None,
        "net_rx_mb_s": None,
        "net_tx_mb_s": None,
        "gpu_utilization_percent": None,
    }


NIC_ACTIONS = ("restart_interface", "restart_network_service", "reduce_offending_workload")


def simulate_nic_action(action: str, interface: str, state: Optional[DigitalTwinState] = None,
                         offending_pid: Optional[int] = None) -> SimulationResult:
    """SIMULATION ONLY -- domain='nic'. Never touches the real interface.

    action:
      "restart_interface"        -- simulated ifdown/ifup style recovery
      "restart_network_service"  -- simulated restart of a network-managing
                                     service (e.g. NetworkManager/systemd-networkd)
      "reduce_offending_workload" -- simulated pause/kill of a process that
                                     IS attributable via offending_pid (system-wide
                                     RX/TX only -- per-process network is never
                                     invented; this path is only valid when the
                                     caller supplies a PID from other evidence,
                                     e.g. a connection-tracking tool)
    """
    if action not in NIC_ACTIONS:
        raise ValueError(f"unknown NIC action '{action}', expected one of {NIC_ACTIONS}")
    state = _resolve_state(state)
    nic = state.find_nic(interface)
    if nic is None:
        raise ValueError(f"interface '{interface}' was not present in the collected DigitalTwinState")

    warnings: list[str] = []
    quality_known = nic.rx_mb_s is not None and nic.tx_mb_s is not None
    if not quality_known:
        warnings.append(f"throughput for '{interface}' was {NOT_AVAILABLE} -- prediction quality is reduced")

    current = _na_state_dict("CURRENT")
    predicted = _na_state_dict("PREDICTED")

    if action == "reduce_offending_workload":
        if offending_pid is None:
            raise ValueError("reduce_offending_workload requires offending_pid (system cannot attribute NIC load to a PID on its own)")
        proc = state.find_process(offending_pid)
        if proc is None:
            raise ValueError(f"offending_pid {offending_pid} was not present in the collected state")
        warnings.append(
            "per-process network attribution is not measured by this simulator; the link between "
            f"PID {offending_pid} and interface '{interface}' traffic is an ASSUMPTION supplied by the caller, "
            "not a psutil measurement."
        )
        risk, risk_warnings = _assess_risk(proc, "terminate", state, state.cpu_percent)
        confidence = 30.0  # capped low: attribution is unverified by this module
        expected_improvement = 20.0 if nic.rx_errors or nic.tx_errors else 5.0
        reversible = False
        requires_approval = True
        explanation = (
            f"If the process assumed to be generating traffic on '{interface}' (PID {offending_pid}, "
            f"{proc.name}) were stopped, interface pressure would be expected to drop, but this simulator "
            f"cannot verify that PID is actually the cause -- confidence is capped accordingly."
        )
        target_pid = offending_pid
        target_process = proc.name
    else:
        risk = RISK_MEDIUM
        risk_warnings = [f"'{action}' on '{interface}' can briefly interrupt connectivity on that interface"]
        confidence = 55.0 if quality_known else 30.0
        error_pressure = (nic.rx_errors or 0) + (nic.tx_errors or 0) + (nic.rx_drops or 0) + (nic.tx_drops or 0)
        expected_improvement = 30.0 if error_pressure > 0 else 10.0
        reversible = True
        requires_approval = True
        explanation = (
            f"Simulated '{action}' on interface '{interface}'. This is a structural/service-level recovery "
            f"action, not a process action -- there are no CPU/RAM/disk deltas to predict for it. "
            f"Current error+drop counters observed this sample: {error_pressure}."
        )
        target_pid = None
        target_process = None

    return SimulationResult(
        action=action,
        target_pid=target_pid,
        target_process=target_process,
        current_state=current,
        predicted_state=predicted,
        cpu_delta_percent=0.0,
        ram_delta_percent=0.0,
        ram_delta_mb=0.0,
        disk_io_delta_mb_s=0.0,
        net_delta_mb_s=None,
        expected_improvement_percent=expected_improvement,
        risk=risk,
        confidence_percent=confidence,
        reversible=reversible,
        requires_approval=requires_approval,
        explanation=explanation,
        warnings=warnings + risk_warnings,
        domain=DOMAIN_NIC,
        target_name=interface,
    )


IO_CONTROLLER_ACTIONS = ("reduce_offending_workload",)


def simulate_io_controller_action(action: str, device: str, offending_pid: int,
                                   state: Optional[DigitalTwinState] = None) -> SimulationResult:
    """SIMULATION ONLY -- domain='io_controller'. Distinct from ordinary
    filesystem-capacity simulation: this is about block-device I/O load
    (queue depth / I/O time), not free disk space. Requires an
    offending_pid because /sys/block gives device-wide, not per-process,
    numbers -- per-process read_mb_s/write_mb_s (already measured in
    ProcessSnapshot) is the only legitimate process-level I/O evidence."""
    if action not in IO_CONTROLLER_ACTIONS:
        raise ValueError(f"unknown I/O controller action '{action}', expected one of {IO_CONTROLLER_ACTIONS}")
    state = _resolve_state(state)
    dev = state.find_io_controller(device)
    if dev is None:
        raise ValueError(f"block device '{device}' was not present in the collected DigitalTwinState")
    proc = state.find_process(offending_pid)
    if proc is None:
        raise ValueError(f"offending_pid {offending_pid} was not present in the collected DigitalTwinState")

    warnings: list[str] = []
    if not dev.available:
        warnings.append(f"/sys/block/{device}/stat was {NOT_AVAILABLE}")
    if not proc.io_available:
        warnings.append(f"per-process I/O counters for PID {offending_pid} were {NOT_AVAILABLE}")

    proc_io = (proc.read_mb_s or 0.0) + (proc.write_mb_s or 0.0)
    current = _na_state_dict("CURRENT")
    current["disk_read_mb_s"] = state.disk_read_mb_s
    current["disk_write_mb_s"] = state.disk_write_mb_s
    predicted = _na_state_dict("PREDICTED")
    predicted["disk_read_mb_s"] = _clamp(state.disk_read_mb_s - (proc.read_mb_s or 0.0), 0.0, float("inf"))
    predicted["disk_write_mb_s"] = _clamp(state.disk_write_mb_s - (proc.write_mb_s or 0.0), 0.0, float("inf"))

    risk, risk_warnings = _assess_risk(proc, "pause", state, state.cpu_percent)
    confidence = 65.0 if (dev.available and proc.io_available) else 35.0
    expected_improvement = min(100.0, proc_io * 2)  # same style of capping as _expected_improvement's io term
    reversible = True
    requires_approval = True
    explanation = (
        f"If PID {offending_pid} ({proc.name}), which is directly measured at "
        f"{proc_io:.3f} MB/s combined I/O, were paused, block device '{device}' I/O pressure would be "
        f"expected to ease by roughly that amount. Device-level in-flight I/O this sample: "
        f"{dev.io_in_progress if dev.available else NOT_AVAILABLE}."
    )

    return SimulationResult(
        action=action,
        target_pid=offending_pid,
        target_process=proc.name,
        current_state=current,
        predicted_state=predicted,
        cpu_delta_percent=0.0,
        ram_delta_percent=0.0,
        ram_delta_mb=0.0,
        disk_io_delta_mb_s=round(proc_io, 4),
        net_delta_mb_s=None,
        expected_improvement_percent=round(expected_improvement, 2),
        risk=risk,
        confidence_percent=confidence,
        reversible=reversible,
        requires_approval=requires_approval,
        explanation=explanation,
        warnings=warnings + risk_warnings,
        domain=DOMAIN_IO_CONTROLLER,
        target_name=device,
    )


GPU_ACTIONS = ("terminate_gpu_workload", "pause_gpu_workload", "throttle_recommendation")


def simulate_gpu_action(action: str, state: Optional[DigitalTwinState] = None,
                         gpu_index: int = 0, pid: Optional[int] = None) -> SimulationResult:
    """SIMULATION ONLY -- domain='gpu'. Uses nvidia-smi-derived data only;
    gracefully degrades (raises ValueError explaining why) when no NVIDIA
    GPU/driver is present rather than fabricating GPU numbers."""
    if action not in GPU_ACTIONS:
        raise ValueError(f"unknown GPU action '{action}', expected one of {GPU_ACTIONS}")
    state = _resolve_state(state)
    if not state.gpus:
        raise ValueError("no NVIDIA GPU detected on this system (nvidia-smi unavailable or returned nothing) -- GPU simulation is not applicable")
    if gpu_index >= len(state.gpus):
        raise ValueError(f"gpu_index {gpu_index} out of range (only {len(state.gpus)} GPU(s) detected)")
    gpu = state.gpus[gpu_index]

    warnings: list[str] = []
    proc = state.find_process(pid) if pid is not None else None
    if action in ("terminate_gpu_workload", "pause_gpu_workload") and proc is None:
        raise ValueError(f"{action} requires a valid pid present in the collected state")

    current = _na_state_dict("CURRENT")
    current["gpu_utilization_percent"] = gpu.utilization_percent
    predicted = _na_state_dict("PREDICTED")

    vram_pct = (
        (gpu.memory_used_mb / gpu.memory_total_mb * 100)
        if gpu.memory_used_mb is not None and gpu.memory_total_mb else None
    )
    gpu_proc_entry = next((p for p in gpu.processes if p.get("pid") == pid), None) if pid is not None else None
    freed_vram_mb = gpu_proc_entry["used_memory_mb"] if gpu_proc_entry else None
    if pid is not None and gpu_proc_entry is None:
        warnings.append(
            f"PID {pid} was not seen in nvidia-smi's compute-apps list for this GPU -- VRAM impact "
            f"of this action is {NOT_AVAILABLE} and is NOT estimated (left as None), not guessed."
        )

    if freed_vram_mb is not None and gpu.memory_used_mb:
        predicted_vram = _clamp(gpu.memory_used_mb - freed_vram_mb, 0.0, gpu.memory_total_mb or float("inf"))
        predicted["gpu_utilization_percent"] = gpu.utilization_percent  # nvidia-smi doesn't give per-proc util either
        expected_improvement = min(100.0, (freed_vram_mb / gpu.memory_total_mb * 100) if gpu.memory_total_mb else 10.0)
    else:
        expected_improvement = 5.0 if action != "throttle_recommendation" else 15.0

    reversible = action == "pause_gpu_workload"
    requires_approval = True
    risk = RISK_HIGH if action == "terminate_gpu_workload" else RISK_MEDIUM
    if action == "throttle_recommendation":
        risk = RISK_LOW

    if action == "throttle_recommendation":
        explanation = (
            f"GPU {gpu_index} ({gpu.name}) utilization is {_fmt_pct(gpu.utilization_percent)}, "
            f"VRAM {('%.1f%%' % vram_pct) if vram_pct is not None else NOT_AVAILABLE}. Recommendation-only: "
            f"this simulator does not claim throttling is executable -- see digital_twin_execution.py for "
            f"what is genuinely supported."
        )
        target_pid, target_process = None, None
    else:
        verb = "terminated" if action == "terminate_gpu_workload" else "paused"
        explanation = (
            f"If GPU workload PID {pid} ({proc.name}) on GPU {gpu_index} ({gpu.name}) were {verb}, "
            + (f"an estimated {freed_vram_mb:.0f} MB of VRAM would be freed. " if freed_vram_mb is not None else
               "VRAM impact could not be estimated from available telemetry. ")
            + "GPU compute utilization is system-wide per nvidia-smi and not attributable to a single "
              "process by this simulator."
        )
        target_pid, target_process = pid, proc.name if proc else None

    return SimulationResult(
        action=action,
        target_pid=target_pid,
        target_process=target_process,
        current_state=current,
        predicted_state=predicted,
        cpu_delta_percent=0.0,
        ram_delta_percent=0.0,
        ram_delta_mb=0.0,
        disk_io_delta_mb_s=0.0,
        net_delta_mb_s=None,
        expected_improvement_percent=round(expected_improvement, 2),
        risk=risk,
        confidence_percent=(60.0 if gpu_proc_entry is not None else 35.0) if action != "throttle_recommendation" else 50.0,
        reversible=reversible,
        requires_approval=requires_approval,
        explanation=explanation,
        warnings=warnings,
        domain=DOMAIN_GPU,
        target_name=gpu.name,
    )


# ============================================================================
# Problem detection -- decides whether a recovery workflow should even run.
# ============================================================================

def detect_pressure(state: Optional[DigitalTwinState] = None) -> dict[str, Any]:
    """Determine whether the server actually has a problem, per domain.
    Returns a dict:
        {
          "has_problem": bool,
          "domains": {domain: {"pressure": bool, "reason": str, ...}},
        }
    Uses PRESSURE_THRESHOLDS -- conservative, configurable, documented.
    This does NOT generate recovery candidates by itself; callers should
    only run generate_recovery_candidates() for domains flagged here.
    """
    state = _resolve_state(state)
    domains: dict[str, dict[str, Any]] = {}

    # --- CPU ---
    cores = max(state.cpu_core_count, 1)
    load_per_core = (state.load_avg_1 / cores) if state.load_avg_1 is not None else None
    cpu_pressure = state.cpu_percent >= PRESSURE_THRESHOLDS["cpu_percent"] or (
        load_per_core is not None and load_per_core >= PRESSURE_THRESHOLDS["load_avg_per_core"]
    )
    domains[DOMAIN_CPU] = {
        "pressure": cpu_pressure,
        "reason": (
            f"cpu_percent={state.cpu_percent:.1f}% (threshold {PRESSURE_THRESHOLDS['cpu_percent']}%), "
            f"load_avg_1/core={('%.2f' % load_per_core) if load_per_core is not None else NOT_AVAILABLE} "
            f"(threshold {PRESSURE_THRESHOLDS['load_avg_per_core']})"
        ),
    }

    # --- RAM / swap ---
    ram_pressure = state.ram_percent >= PRESSURE_THRESHOLDS["ram_percent"]
    swap_pressure = (state.swap_percent or 0.0) >= PRESSURE_THRESHOLDS["swap_percent"]
    domains[DOMAIN_RAM] = {
        "pressure": ram_pressure or swap_pressure,
        "reason": (
            f"ram_percent={state.ram_percent:.1f}% (threshold {PRESSURE_THRESHOLDS['ram_percent']}%), "
            f"swap_percent={state.swap_percent if state.swap_percent is not None else NOT_AVAILABLE} "
            f"(threshold {PRESSURE_THRESHOLDS['swap_percent']}%)"
        ),
    }

    # --- Disk (capacity) ---
    disk_pressure = state.disk_percent >= PRESSURE_THRESHOLDS["disk_percent"]
    domains[DOMAIN_DISK] = {
        "pressure": disk_pressure,
        "reason": f"disk_percent={state.disk_percent:.1f}% (threshold {PRESSURE_THRESHOLDS['disk_percent']}%)",
    }

    # --- NIC ---
    nic_pressure = False
    nic_reasons: list[str] = []
    for nic in state.nics:
        if _is_loopback_interface(nic.name):
            continue
        total_err = (nic.rx_errors or 0) + (nic.tx_errors or 0) + (nic.rx_drops or 0) + (nic.tx_drops or 0)
        if total_err > 0:
            nic_pressure = True
            nic_reasons.append(f"{nic.name}: {total_err} error/drop events")
        if nic.is_up is False:
            nic_pressure = True
            nic_reasons.append(f"{nic.name}: link down")
    domains[DOMAIN_NIC] = {
        "pressure": nic_pressure,
        "reason": "; ".join(nic_reasons) if nic_reasons else "no interface errors/drops/link-down observed",
    }

    # --- I/O controller ---
    io_pressure = False
    io_reasons: list[str] = []
    for dev in state.io_controllers:
        if not dev.available:
            continue
        if (dev.io_time_ms_delta or 0) >= PRESSURE_THRESHOLDS["io_time_ms_delta"]:
            io_pressure = True
            io_reasons.append(f"{dev.device}: io_time_ms_delta={dev.io_time_ms_delta}")
    domains[DOMAIN_IO_CONTROLLER] = {
        "pressure": io_pressure,
        "reason": "; ".join(io_reasons) if io_reasons else "no block device near saturation this sample",
    }

    # --- GPU ---
    gpu_pressure = False
    gpu_reasons: list[str] = []
    for gpu in state.gpus:
        if gpu.utilization_percent is not None and gpu.utilization_percent >= PRESSURE_THRESHOLDS["gpu_utilization_percent"]:
            gpu_pressure = True
            gpu_reasons.append(f"GPU {gpu.index}: util={gpu.utilization_percent:.1f}%")
        if gpu.memory_used_mb is not None and gpu.memory_total_mb:
            mem_pct = gpu.memory_used_mb / gpu.memory_total_mb * 100
            if mem_pct >= PRESSURE_THRESHOLDS["gpu_memory_percent"]:
                gpu_pressure = True
                gpu_reasons.append(f"GPU {gpu.index}: vram={mem_pct:.1f}%")
    domains[DOMAIN_GPU] = {
        "pressure": gpu_pressure,
        "reason": "; ".join(gpu_reasons) if gpu_reasons else ("no GPU detected" if not state.gpus else "GPU within normal range"),
    }

    has_problem = any(d["pressure"] for d in domains.values())
    return {"has_problem": has_problem, "domains": domains}


def simulate_kill_process(pid: int, state: Optional[DigitalTwinState] = None) -> SimulationResult:
    """SIMULATION ONLY. Does not call os.kill()/signal. See simulate_action()."""
    return simulate_action("kill", pid, state)


def simulate_terminate_process(pid: int, state: Optional[DigitalTwinState] = None) -> SimulationResult:
    """SIMULATION ONLY. Does not send SIGTERM. See simulate_action()."""
    return simulate_action("terminate", pid, state)


def simulate_pause_process(pid: int, state: Optional[DigitalTwinState] = None) -> SimulationResult:
    """SIMULATION ONLY. Does not send SIGSTOP. See simulate_action()."""
    return simulate_action("pause", pid, state)


def simulate_resume_process(pid: int, state: Optional[DigitalTwinState] = None) -> SimulationResult:
    """SIMULATION ONLY. Does not send SIGCONT. See simulate_action()."""
    return simulate_action("resume", pid, state)


# ============================================================================
# 7. rank_actions()
# ============================================================================

def rank_actions(actions: list[SimulationResult]) -> list[SimulationResult]:
    """
    Transparent ranking: safety first, then confidence, then expected
    improvement.

        sort key = (risk_rank ascending, confidence descending, expected_improvement descending)

    i.e. a LOW-risk option always outranks a MEDIUM/HIGH-risk one
    regardless of how much bigger its improvement looks; only within the
    same risk tier does confidence, then improvement, break the tie.
    """
    return sorted(
        actions,
        key=lambda r: (_RISK_ORDER.get(r.risk, 3), -r.confidence_percent, -r.expected_improvement_percent),
    )


# ============================================================================
# Candidate generation -- DOMAIN-AWARE (only pressured domains)
# ============================================================================

def _is_loopback_interface(name: str) -> bool:
    return name in ("lo", "lo0") or (name.startswith("lo") and len(name) > 2 and name[2:].isdigit())


def _nic_has_pressure(nic: NICSnapshot) -> bool:
    if _is_loopback_interface(nic.name):
        return False
    total_err = (nic.rx_errors or 0) + (nic.tx_errors or 0) + (nic.rx_drops or 0) + (nic.tx_drops or 0)
    return nic.is_up is False or total_err > 0


def _generate_cpu_candidates(
    state: DigitalTwinState,
    top_n: int,
    actions: tuple[str, ...],
) -> list[SimulationResult]:
    results: list[SimulationResult] = []
    for proc in state.top_by_cpu(top_n):
        for action in actions:
            try:
                sim = simulate_action(action, proc.pid, state)
                sim.domain = DOMAIN_CPU
                sim.confidence_percent = _assess_confidence(
                    proc, state, domain=DOMAIN_CPU, action=action,
                )
                results.append(sim)
            except ValueError:
                continue
    return results


def _generate_ram_candidates(
    state: DigitalTwinState,
    top_n: int,
    actions: tuple[str, ...],
) -> list[SimulationResult]:
    results: list[SimulationResult] = []
    for proc in state.top_by_memory(top_n):
        for action in actions:
            try:
                sim = simulate_action(action, proc.pid, state)
                sim.domain = DOMAIN_RAM
                sim.confidence_percent = _assess_confidence(
                    proc, state, domain=DOMAIN_RAM, action=action,
                )
                results.append(sim)
            except ValueError:
                continue
    return results


def _generate_nic_candidates(
    state: DigitalTwinState,
    nic_attributed_pids: Optional[dict[str, int]] = None,
) -> list[SimulationResult]:
    """NIC recovery only -- never unrelated process kill/pause candidates."""
    results: list[SimulationResult] = []
    for nic in state.nics:
        if not _nic_has_pressure(nic):
            continue
        for action in ("restart_interface", "restart_network_service"):
            try:
                results.append(simulate_nic_action(action, nic.name, state))
            except ValueError:
                continue
        attributed_pid = (nic_attributed_pids or {}).get(nic.name)
        if attributed_pid is not None:
            try:
                results.append(simulate_nic_action(
                    "reduce_offending_workload", nic.name, state, offending_pid=attributed_pid,
                ))
            except ValueError:
                continue
    return results


def _generate_io_controller_candidates(
    state: DigitalTwinState,
    top_n: int,
) -> list[SimulationResult]:
    results: list[SimulationResult] = []
    pressured_devices = [
        d for d in state.io_controllers
        if d.available and (d.io_time_ms_delta or 0) >= PRESSURE_THRESHOLDS["io_time_ms_delta"]
    ]
    if not pressured_devices:
        return results
    io_procs = state.top_by_io(top_n)
    for dev in pressured_devices:
        for proc in io_procs:
            try:
                results.append(simulate_io_controller_action(
                    "reduce_offending_workload", dev.device, proc.pid, state,
                ))
            except ValueError:
                continue
    return results


def _generate_gpu_candidates(state: DigitalTwinState) -> list[SimulationResult]:
    if not state.gpus:
        return []
    results: list[SimulationResult] = []
    gpu = state.gpus[0]
    for proc_entry in gpu.processes:
        pid = proc_entry.get("pid")
        if pid is None:
            continue
        if state.find_process(pid) is None:
            continue
        for action in ("pause_gpu_workload", "terminate_gpu_workload"):
            try:
                results.append(simulate_gpu_action(action, state, gpu_index=0, pid=pid))
            except ValueError:
                continue
    if not results:
        try:
            results.append(simulate_gpu_action("throttle_recommendation", state, gpu_index=0))
        except ValueError:
            pass
    return results


def _generate_disk_capacity_candidates(state: DigitalTwinState) -> list[SimulationResult]:
    """Disk *capacity* pressure gets cleanup recommendations, not process kills."""
    current = _na_state_dict("CURRENT")
    current["disk_percent"] = state.disk_percent
    predicted = _na_state_dict("PREDICTED")
    predicted["disk_percent"] = max(0.0, state.disk_percent - 5.0)  # conservative estimate only
    return [
        SimulationResult(
            action="recommend_clean_temp",
            target_pid=None,
            target_process=None,
            current_state=current,
            predicted_state=predicted,
            cpu_delta_percent=0.0,
            ram_delta_percent=0.0,
            ram_delta_mb=0.0,
            disk_io_delta_mb_s=0.0,
            net_delta_mb_s=None,
            expected_improvement_percent=5.0,
            risk=RISK_LOW,
            confidence_percent=40.0,
            reversible=True,
            requires_approval=True,
            explanation=(
                f"Disk capacity is at {state.disk_percent:.1f}% -- simulated cleanup of temp files "
                f"may reclaim space. This is a structural/cleanup action, not a process termination."
            ),
            warnings=["disk capacity recovery is not attributable to a single process"],
            domain=DOMAIN_DISK,
            target_name="/",
        ),
        SimulationResult(
            action="recommend_vacuum_journal",
            target_pid=None,
            target_process=None,
            current_state=current,
            predicted_state=predicted,
            cpu_delta_percent=0.0,
            ram_delta_percent=0.0,
            ram_delta_mb=0.0,
            disk_io_delta_mb_s=0.0,
            net_delta_mb_s=None,
            expected_improvement_percent=3.0,
            risk=RISK_LOW,
            confidence_percent=35.0,
            reversible=False,
            requires_approval=True,
            explanation=(
                f"Disk capacity is at {state.disk_percent:.1f}% -- simulated systemd journal vacuum "
                f"may reclaim space. Distinct from disk throughput / I/O controller pressure."
            ),
            warnings=["requires root/systemd journal access to execute for real"],
            domain=DOMAIN_DISK,
            target_name="/",
        ),
    ]


def generate_recovery_candidates(
    state: Optional[DigitalTwinState] = None,
    top_n_processes: int = 5,
    actions: tuple[str, ...] = ("pause", "terminate", "kill"),
    pressure: Optional[dict[str, Any]] = None,
    nic_attributed_pids: Optional[dict[str, int]] = None,
) -> dict[str, Any]:
    """Domain-aware candidate generation.

    Only domains flagged by detect_pressure() produce candidates. Healthy
    CPU/RAM will never yield process-termination candidates when the only
    problem is, e.g., a NIC link-down.

    Returns:
        {
          "pressure": {...},
          "candidates": [SimulationResult, ...],
          "ranked": [SimulationResult, ...],
          "message": str | None,
        }
    """
    state = _resolve_state(state)
    pressure = pressure or detect_pressure(state)
    domain_info = pressure.get("domains") or {}
    pressured_domains = [d for d, info in domain_info.items() if info.get("pressure")]

    results: list[SimulationResult] = []
    if DOMAIN_CPU in pressured_domains:
        results.extend(_generate_cpu_candidates(state, top_n_processes, actions))
    if DOMAIN_RAM in pressured_domains:
        results.extend(_generate_ram_candidates(state, top_n_processes, actions))
    if DOMAIN_NIC in pressured_domains:
        results.extend(_generate_nic_candidates(state, nic_attributed_pids))
    if DOMAIN_IO_CONTROLLER in pressured_domains:
        results.extend(_generate_io_controller_candidates(state, top_n_processes))
    if DOMAIN_GPU in pressured_domains:
        results.extend(_generate_gpu_candidates(state))
    if DOMAIN_DISK in pressured_domains:
        results.extend(_generate_disk_capacity_candidates(state))

    ranked = rank_actions(results)
    message = None
    if pressure.get("has_problem") and not ranked:
        message = NO_SAFE_CANDIDATE_MSG
    elif not pressure.get("has_problem"):
        message = (
            "No domain pressure detected -- no recovery candidates generated "
            "(healthy domains do not produce unrelated recovery actions)."
        )

    return {
        "pressure": pressure,
        "candidates": results,
        "ranked": ranked,
        "pressured_domains": pressured_domains,
        "message": message,
    }


def run_digital_twin_pipeline(
    sample_interval: float = DEFAULT_SAMPLE_INTERVAL_SECONDS,
    top_n_processes: int = 5,
    nic_attributed_pids: Optional[dict[str, int]] = None,
) -> dict[str, Any]:
    """Full read-only pipeline: MEASURE -> DETECT -> GENERATE -> RANK."""
    state = collect_current_state(sample_interval=sample_interval)
    candidate_report = generate_recovery_candidates(
        state,
        top_n_processes=top_n_processes,
        nic_attributed_pids=nic_attributed_pids,
    )
    return {
        "state": state_to_dict(state),
        "pressure": candidate_report["pressure"],
        "pressured_domains": candidate_report["pressured_domains"],
        "candidates": [r.to_dict() for r in candidate_report["ranked"]],
        "candidate_count": len(candidate_report["ranked"]),
        "message": candidate_report["message"],
    }


def state_to_dict(state: DigitalTwinState) -> dict[str, Any]:
    """Serialize a DigitalTwinState for API/JSON responses."""
    return {
        "timestamp": state.timestamp,
        "sample_interval_seconds": state.sample_interval_seconds,
        "cpu_percent": state.cpu_percent,
        "cpu_core_count": state.cpu_core_count,
        "cpu_percent_per_core": state.cpu_percent_per_core,
        "load_avg_1": state.load_avg_1,
        "load_avg_5": state.load_avg_5,
        "load_avg_15": state.load_avg_15,
        "ram_percent": state.ram_percent,
        "ram_used_gb": state.ram_used_gb,
        "ram_total_gb": state.ram_total_gb,
        "ram_available_gb": state.ram_available_gb,
        "ram_free_gb": state.ram_free_gb,
        "swap_percent": state.swap_percent,
        "disk_percent": state.disk_percent,
        "disk_used_gb": state.disk_used_gb,
        "disk_total_gb": state.disk_total_gb,
        "disk_read_mb_s": state.disk_read_mb_s,
        "disk_write_mb_s": state.disk_write_mb_s,
        "net_rx_mb_s": state.net_rx_mb_s,
        "net_tx_mb_s": state.net_tx_mb_s,
        "nics": [asdict(n) for n in state.nics],
        "io_controllers": [asdict(d) for d in state.io_controllers],
        "gpus": [asdict(g) for g in state.gpus],
        "process_count": len(state.processes),
        "top_cpu": [asdict(p) for p in state.top_by_cpu(10)],
        "top_memory": [asdict(p) for p in state.top_by_memory(10)],
        "top_io": [asdict(p) for p in state.top_by_io(10)],
    }


def compare_prediction_vs_actual(
    predicted: dict[str, Any],
    actual: dict[str, Any],
) -> dict[str, float]:
    """Signed error dict (actual - predicted) for numeric keys in both."""
    try:
        import digital_twin_learning as dtl
        return dtl._compute_signed_error(predicted, actual)
    except ImportError:
        errors: dict[str, float] = {}
        for key, pred_val in predicted.items():
            if not isinstance(pred_val, (int, float)):
                continue
            act_val = actual.get(key)
            if isinstance(act_val, (int, float)):
                errors[key] = round(float(act_val) - float(pred_val), 4)
        return errors


# ============================================================================
# Command-line test harness -- SIMULATION ONLY, nothing here is executed
# against the real system.
# ============================================================================

def _fmt_pct(v: Optional[float]) -> str:
    return "n/a" if v is None else f"{v:.1f}%"


def _print_header(text: str) -> None:
    print()
    print("=" * 78)
    print(text)
    print("=" * 78)


def _print_state_summary(state: DigitalTwinState) -> None:
    _print_header("CURRENT SERVER STATE  (measured)")
    print(f"  Timestamp:        {state.timestamp}")
    print(f"  Sample window:    {state.sample_interval_seconds:.2f}s")
    print(f"  CPU:              {state.cpu_percent:.1f}%  ({state.cpu_core_count} logical cores)")
    print(f"  RAM:              {state.ram_percent:.1f}%  "
          f"({state.ram_used_gb:.2f} GB / {state.ram_total_gb:.2f} GB)")
    print(f"  Disk (/):         {state.disk_percent:.1f}%  "
          f"({state.disk_used_gb:.2f} GB / {state.disk_total_gb:.2f} GB)")
    print(f"  Disk throughput:  read {state.disk_read_mb_s:.2f} MB/s | write {state.disk_write_mb_s:.2f} MB/s")
    print(f"  Network:          rx {state.net_rx_mb_s:.3f} MB/s | tx {state.net_tx_mb_s:.3f} MB/s")
    if state.gpus:
        for gpu in state.gpus:
            temp_str = f"{gpu.temperature_c}C" if gpu.temperature_c is not None else "n/a"
            power_str = f"{gpu.power_watts:.1f}W" if gpu.power_watts is not None else "n/a"
            print(f"  GPU {gpu.index} ({gpu.name}): "
                  f"util {_fmt_pct(gpu.utilization_percent)} | "
                  f"mem {gpu.memory_used_mb:.0f}/{gpu.memory_total_mb:.0f} MB | "
                  f"temp {temp_str} | power {power_str}")
    else:
        print("  GPU:              none detected")
    if state.nics:
        print(f"  NICs ({len(state.nics)} discovered):")
        for nic in state.nics:
            rx = f"{nic.rx_mb_s:.3f}" if nic.rx_mb_s is not None else NOT_AVAILABLE
            tx = f"{nic.tx_mb_s:.3f}" if nic.tx_mb_s is not None else NOT_AVAILABLE
            print(f"    {nic.name:<10} up={nic.is_up}  rx {rx} MB/s  tx {tx} MB/s  "
                  f"errs(rx/tx)={nic.rx_errors}/{nic.tx_errors}  drops(rx/tx)={nic.rx_drops}/{nic.tx_drops}")
    if state.io_controllers:
        print(f"  Block devices ({len(state.io_controllers)} discovered):")
        for dev in state.io_controllers:
            if not dev.available:
                print(f"    {dev.device:<10} {NOT_AVAILABLE}")
            else:
                print(f"    {dev.device:<10} io_time_ms_delta={dev.io_time_ms_delta}  "
                      f"in_progress={dev.io_in_progress}  reads={dev.reads_completed_delta}  writes={dev.writes_completed_delta}")


def _print_high_resource_processes(state: DigitalTwinState, n: int = 8) -> None:
    _print_header(f"DETECTED HIGH-RESOURCE PROCESSES  (top {n} by CPU)")
    print(f"  {'PID':>7}  {'CPU%':>6}  {'MEM%':>6}  {'MEM(MB)':>9}  {'R MB/s':>8}  {'W MB/s':>8}  NAME")
    for p in state.top_by_cpu(n):
        print(f"  {p.pid:>7}  {p.cpu_percent:>6.1f}  {p.memory_percent:>6.1f}  {p.memory_mb:>9.1f}  "
              f"{('%.2f' % p.read_mb_s) if p.read_mb_s is not None else 'n/a':>8}  "
              f"{('%.2f' % p.write_mb_s) if p.write_mb_s is not None else 'n/a':>8}  {p.name}")


def _print_simulation_result(r: SimulationResult, index: Optional[int] = None) -> None:
    prefix = f"[{index}] " if index is not None else ""
    target = r.target_name or r.target_process or "n/a"
    pid_str = f"PID {r.target_pid}" if r.target_pid is not None else "no PID"
    print(f"\n  {prefix}[{r.domain}] {r.action.upper()}  ->  {pid_str} ({target})")

    cur_cpu = r.current_state.get("cpu_percent")
    cur_ram = r.current_state.get("ram_percent")
    pred_cpu = r.predicted_state.get("cpu_percent")
    pred_ram = r.predicted_state.get("ram_percent")

    if cur_cpu is not None and pred_cpu is not None:
        print(f"      CURRENT   CPU: {cur_cpu:.1f}%   RAM: {(cur_ram or 0):.1f}%")
        print(f"      PREDICTED CPU: {pred_cpu:.1f}%   RAM: {(pred_ram or 0):.1f}%")
    else:
        print(f"      CURRENT/PREDICTED: domain-specific (see explanation)")

    print(f"      Delta       CPU: {r.cpu_delta_percent:+.1f}pp   RAM: {r.ram_delta_percent:+.1f}pp "
          f"({r.ram_delta_mb:+.1f} MB)   Disk I/O: {r.disk_io_delta_mb_s:+.2f} MB/s   "
          f"Net: {r.net_delta_mb_s if r.net_delta_mb_s is not None else 'n/a'}")
    print(f"      Risk: {r.risk:<6}  Confidence: {r.confidence_percent:>5.1f}%  "
          f"Expected improvement: {r.expected_improvement_percent:+.1f}%  "
          f"Reversible: {r.reversible}  Requires approval: {r.requires_approval}")
    print(f"      {r.explanation}")
    for w in r.warnings:
        print(f"      NOTE: {w}")


def main() -> None:
    print("#" * 78)
    print("# DIGITAL TWIN AUTO-HEAL -- SIMULATION ONLY")
    print("# No process on this machine will be paused, resumed, terminated,")
    print("# or killed by running this script. All numbers below are predictions")
    print("# computed from a real measured snapshot, not the result of any")
    print("# real action.")
    print("#" * 78)

    print("\nCollecting a real, measured snapshot (~1.5s sampling window)...")
    state = collect_current_state(sample_interval=1.5)

    _print_state_summary(state)
    _print_high_resource_processes(state, n=8)

    pressure = detect_pressure(state)
    _print_header("DETECTED PROBLEM")
    if not pressure["has_problem"]:
        print("  No significant pressure detected on any monitored domain (cpu/ram/disk/nic/io_controller/gpu).")
        print("  No domain-specific recovery candidates will be generated for healthy domains.")
    else:
        for domain, info in pressure["domains"].items():
            flag = "PRESSURE" if info["pressure"] else "ok"
            print(f"  [{flag:>8}] {domain:<14} {info['reason']}")

    _print_header("DOMAIN-AWARE SIMULATED RECOVERY CANDIDATES")
    report = generate_recovery_candidates(state, top_n_processes=5,
                                          actions=("pause", "terminate", "kill"))
    candidates = report["ranked"]
    if report["message"]:
        print(f"  {report['message']}")
    if report["pressured_domains"]:
        print(f"  Pressured domains: {', '.join(report['pressured_domains'])}")
    if not candidates:
        if not report["message"]:
            print("  No eligible candidates were found for the pressured domain(s).")
    else:
        for i, r in enumerate(candidates[:10], start=1):
            _print_simulation_result(r, index=i)

        best = candidates[0]
        _print_header("RECOMMENDATION  (SIMULATION ONLY -- NOT EXECUTED)")
        target = best.target_name or best.target_process or "n/a"
        print(f"  Best-ranked action: [{best.domain}] {best.action.upper()} -> {target}")
        if best.current_state.get("cpu_percent") is not None:
            print(f"  Current CPU:   {best.current_state['cpu_percent']:.1f}%")
            print(f"  Predicted CPU: {best.predicted_state.get('cpu_percent', 'n/a')}")
        print(f"  Risk:          {best.risk}")
        print(f"  Confidence:    {best.confidence_percent:.1f}%")
        print(f"  Expected improvement: {best.expected_improvement_percent:+.1f}%")
        print(f"  Reversible:    {best.reversible}")
        print(f"  Requires approval: {best.requires_approval}")
        if best.target_pid is not None:
            print(f"\n  Reminder: PID {best.target_pid} is still running right now.")
        print("  This script took no action against it.")

    print("\nDone. This was a simulation -- nothing on this machine was changed.")


if __name__ == "__main__":
    main()
