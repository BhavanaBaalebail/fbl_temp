"""
FBL Utilities — safe on-demand collectors and Flask routes.

Reuses CM.py live caches (metrics/inventory/link_health) where possible.
Never fabricates data. Never shell-interpolates user input.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import re
import shutil
import socket
import ssl
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from flask import Flask, jsonify, request

logger = logging.getLogger("fbl_utilities")

try:
    import telemetry_db as _telemetry_db
except Exception:  # noqa: BLE001
    _telemetry_db = None  # type: ignore


def _persist_utility_event(entry: dict[str, Any]) -> None:
    """Best-effort SQLite audit for meaningful utility results only."""
    if _telemetry_db is None or not entry:
        return
    try:
        _telemetry_db.insert_utility_event(entry)
    except Exception:  # noqa: BLE001
        logger.debug("utility event persist skipped", exc_info=True)


def _should_persist_status(status: Optional[str]) -> bool:
    s = str(status or "").lower()
    return s in ("warning", "critical", "failed", "unreachable")

HOST_SAFE_RE = re.compile(r"^[A-Za-z0-9._:\-]+$")
PSEUDO_FS = {
    "proc",
    "sysfs",
    "devtmpfs",
    "devpts",
    "tmpfs",
    "cgroup",
    "cgroup2",
    "pstore",
    "bpf",
    "debugfs",
    "tracefs",
    "securityfs",
    "hugetlbfs",
    "mqueue",
    "fusectl",
    "configfs",
    "rpc_pipefs",
    "binfmt_misc",
    "autofs",
    "overlay",
}
SAFE_SCAN_ROOTS = ("/home", "/var/log", "/var/tmp", "/tmp", "/opt", "/srv", "/usr/local")
BLOCKED_SCAN_PREFIXES = ("/proc", "/sys", "/dev", "/run/user", "/snap")


def _cmd_exists(name: str) -> bool:
    return shutil.which(name) is not None


def _run(
    cmd: list[str],
    timeout: int = 15,
    *,
    input_text: Optional[str] = None,
) -> dict[str, Any]:
    """Argv-only subprocess. Never uses shell=True."""
    if not cmd or not _cmd_exists(cmd[0]):
        return {
            "ok": False,
            "stdout": "",
            "stderr": f"Command unavailable: {cmd[0] if cmd else '?'}",
            "returncode": None,
            "unavailable": True,
        }
    try:
        result = subprocess.run(
            cmd,
            input=input_text,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
        return {
            "ok": result.returncode == 0,
            "stdout": result.stdout or "",
            "stderr": result.stderr or "",
            "returncode": result.returncode,
            "unavailable": False,
        }
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "stdout": "",
            "stderr": "Command timed out",
            "returncode": None,
            "timeout": True,
            "unavailable": False,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "stdout": "",
            "stderr": str(exc),
            "returncode": None,
            "unavailable": False,
        }


def _read(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


def _prune(data: Any) -> Any:
    if isinstance(data, dict):
        out = {}
        for k, v in data.items():
            pv = _prune(v)
            if pv is None or pv == "" or pv == [] or pv == {}:
                continue
            out[k] = pv
        return out
    if isinstance(data, list):
        return [x for x in (_prune(i) for i in data) if x not in (None, "", [], {})]
    return data


def validate_host(host: str) -> Optional[str]:
    host = (host or "").strip()
    if not host or len(host) > 253:
        return None
    if not HOST_SAFE_RE.fullmatch(host):
        return None
    if host in (".", "..") or host.startswith("-"):
        return None
    return host


def _is_private_or_local(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
        return bool(ip.is_private or ip.is_loopback or ip.is_link_local)
    except ValueError:
        # hostname — allow; operator is expected to use authorized targets
        return True


def _human_duration(seconds: Optional[int]) -> Optional[str]:
    if seconds is None:
        return None
    try:
        s = int(seconds)
    except (TypeError, ValueError):
        return None
    if s < 0:
        return None
    d, rem = divmod(s, 86400)
    h, rem = divmod(rem, 3600)
    m, _ = divmod(rem, 60)
    parts = []
    if d:
        parts.append(f"{d} day{'s' if d != 1 else ''}")
    if h or d:
        parts.append(f"{h} hour{'s' if h != 1 else ''}")
    parts.append(f"{m} minute{'s' if m != 1 else ''}")
    return " ".join(parts)


def _fmt_boot(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(ts).strftime("%d %B %Y, %H:%M")
    except Exception:
        return None


# ── collectors ──────────────────────────────────────────────────────────────


def collect_uptime(metrics: Optional[dict] = None) -> dict[str, Any]:
    uptime_seconds = None
    if metrics and isinstance(metrics.get("system"), dict):
        uptime_seconds = metrics["system"].get("uptime_seconds")
    if uptime_seconds is None:
        raw = _read("/proc/uptime")
        if raw:
            try:
                uptime_seconds = int(float(raw.split()[0]))
            except (ValueError, IndexError):
                uptime_seconds = None

    boot_epoch = None
    if uptime_seconds is not None:
        boot_epoch = time.time() - uptime_seconds

    # Prefer who -b when available
    who = _run(["who", "-b"], timeout=5)
    boot_from_who = None
    if who.get("ok") and who.get("stdout"):
        m = re.search(r"(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})", who["stdout"])
        if m:
            boot_from_who = m.group(1)

    payload = {
        "available": uptime_seconds is not None or boot_from_who is not None,
        "uptime_seconds": uptime_seconds,
        "uptime": _human_duration(uptime_seconds),
        "boot_time": boot_from_who or _fmt_boot(boot_epoch),
        "boot_epoch": int(boot_epoch) if boot_epoch else None,
    }
    return _prune(payload)


def collect_disk(metrics: Optional[dict] = None) -> dict[str, Any]:
    mounts: list[dict[str, Any]] = []
    src_mounts = (metrics or {}).get("disk", {}).get("mounts") if metrics else None

    if isinstance(src_mounts, list) and src_mounts:
        for m in src_mounts:
            if not isinstance(m, dict):
                continue
            fstype = (m.get("fstype") or m.get("type") or "").lower()
            mp = m.get("mountpoint") or m.get("mount_point")
            if not mp:
                continue
            if fstype in PSEUDO_FS:
                continue
            if mp.startswith(("/proc", "/sys", "/dev", "/run", "/snap")):
                continue
            pct = m.get("usage_percent") if m.get("usage_percent") is not None else m.get("used_percent")
            row = {
                "mount": mp,
                "source": m.get("source") or m.get("device"),
                "fstype": fstype or None,
                "total_gb": m.get("total_gb") or m.get("size_gb"),
                "used_gb": m.get("used_gb"),
                "available_gb": m.get("available_gb") or m.get("free_gb"),
                "usage_percent": pct,
            }
            if pct is not None:
                try:
                    p = float(pct)
                    row["status"] = (
                        "critical" if p >= 90 else "warning" if p >= 80 else "healthy"
                    )
                except (TypeError, ValueError):
                    pass
            mounts.append(_prune(row))
    else:
        # Fallback: df -B1
        df = _run(["df", "-B1", "-T", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs"], timeout=10)
        if df.get("stdout"):
            lines = df["stdout"].strip().splitlines()[1:]
            for line in lines:
                parts = line.split()
                if len(parts) < 7:
                    continue
                source, fstype, total, used, avail, pct_s, mp = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]
                if fstype.lower() in PSEUDO_FS:
                    continue
                if mp.startswith(("/proc", "/sys", "/dev", "/run", "/snap")):
                    continue
                try:
                    total_i, used_i, avail_i = int(total), int(used), int(avail)
                    pct = float(pct_s.replace("%", ""))
                except ValueError:
                    continue
                mounts.append(
                    _prune(
                        {
                            "mount": mp,
                            "source": source,
                            "fstype": fstype,
                            "total_gb": round(total_i / (1024**3), 2),
                            "used_gb": round(used_i / (1024**3), 2),
                            "available_gb": round(avail_i / (1024**3), 2),
                            "usage_percent": pct,
                            "status": "critical"
                            if pct >= 90
                            else "warning"
                            if pct >= 80
                            else "healthy",
                        }
                    )
                )

    return _prune({"available": bool(mounts), "mounts": mounts})


def collect_large_files(
    path: str = "/home",
    min_mb: int = 100,
    limit: int = 50,
) -> dict[str, Any]:
    root = (path or "/home").strip() or "/home"
    if ".." in root or any(root.startswith(b) for b in BLOCKED_SCAN_PREFIXES):
        return {"available": False, "error": "Path not allowed for scanning", "files": []}
    if not root.startswith("/"):
        return {"available": False, "error": "Absolute path required", "files": []}
    # Prefer known safe roots; allow /var except /var/lib/docker deep scans via maxdepth
    allowed = any(root == r or root.startswith(r + "/") for r in SAFE_SCAN_ROOTS) or root in (
        "/",
        "/var",
    )
    if root == "/":
        return {
            "available": False,
            "error": "Full-filesystem scan is not permitted. Choose a subdirectory (e.g. /home, /var/log).",
            "files": [],
        }
    if not allowed and not root.startswith("/var/"):
        return {"available": False, "error": "Path outside approved scan roots", "files": []}
    if not Path(root).exists():
        return {"available": False, "error": "Path does not exist", "files": []}

    min_mb = max(1, min(int(min_mb or 100), 10240))
    limit = max(1, min(int(limit or 50), 200))
    min_bytes = str(min_mb * 1024 * 1024)

    if not _cmd_exists("find"):
        return {"available": False, "error": "find command unavailable", "files": []}

    # -printf may be GNU-specific; fall back to -ls parsing
    cmd = [
        "find",
        root,
        "-xdev",
        "-type",
        "f",
        "-size",
        f"+{min_bytes}c",
        "-printf",
        "%s\t%T@\t%p\n",
    ]
    result = _run(cmd, timeout=45)
    files: list[dict[str, Any]] = []
    if result.get("unavailable") or (result.get("returncode") not in (0, 1) and not result.get("stdout")):
        # macOS/BSD find fallback not needed on Ubuntu target; try without -printf
        cmd2 = ["find", root, "-xdev", "-type", "f", "-size", f"+{min_mb}M"]
        result = _run(cmd2, timeout=45)
        for line in (result.get("stdout") or "").splitlines():
            p = line.strip()
            if not p:
                continue
            try:
                st = os.stat(p)
                files.append(
                    {
                        "path": p,
                        "size_bytes": st.st_size,
                        "size_mb": round(st.st_size / (1024**2), 2),
                        "mtime": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
                    }
                )
            except OSError:
                continue
    else:
        for line in (result.get("stdout") or "").splitlines():
            parts = line.split("\t", 2)
            if len(parts) < 3:
                continue
            try:
                size_b = int(parts[0])
                mtime = float(parts[1])
                p = parts[2]
            except ValueError:
                continue
            files.append(
                {
                    "path": p,
                    "size_bytes": size_b,
                    "size_mb": round(size_b / (1024**2), 2),
                    "mtime": datetime.fromtimestamp(mtime).isoformat(timespec="seconds"),
                }
            )

    files.sort(key=lambda f: f.get("size_bytes") or 0, reverse=True)
    files = files[:limit]
    return _prune(
        {
            "available": True,
            "path": root,
            "min_mb": min_mb,
            "count": len(files),
            "files": files,
            "truncated": len(files) >= limit,
            "note": result.get("stderr") if result.get("stderr") and "Permission" in result.get("stderr", "") else None,
        }
    )


def collect_temperature(
    metrics: Optional[dict] = None,
    link_health: Optional[dict] = None,
) -> dict[str, Any]:
    temps: list[dict[str, Any]] = []
    fans: list[dict[str, Any]] = []

    cpu_t = (metrics or {}).get("cpu", {}).get("temperature_celsius") if metrics else None
    if cpu_t is not None:
        level = "critical" if float(cpu_t) >= 85 else "warning" if float(cpu_t) >= 75 else "healthy"
        temps.append({"label": "CPU", "celsius": cpu_t, "status": level})

    gpus = (metrics or {}).get("gpu") if metrics else None
    if isinstance(gpus, list):
        for i, g in enumerate(gpus):
            if not isinstance(g, dict):
                continue
            if g.get("temperature_celsius") is not None:
                t = g["temperature_celsius"]
                level = "critical" if float(t) >= 90 else "warning" if float(t) >= 80 else "healthy"
                name = g.get("name") or g.get("model") or f"GPU {i}"
                temps.append({"label": name, "celsius": t, "status": level})
            if g.get("fan_speed_percent") is not None:
                fans.append(
                    {
                        "label": (g.get("name") or f"GPU {i}") + " fan",
                        "percent": g["fan_speed_percent"],
                    }
                )

    smart = (metrics or {}).get("disk", {}).get("smart") if metrics else None
    if isinstance(smart, dict):
        for dev, info in smart.items():
            if isinstance(info, dict) and info.get("temperature_celsius") is not None:
                temps.append({"label": f"Disk {dev}", "celsius": info["temperature_celsius"]})

    hwmon = (link_health or {}).get("hwmon") if link_health else None
    if isinstance(hwmon, list):
        for chip in hwmon:
            for fan in chip.get("fans") or []:
                if fan.get("rpm") is not None:
                    fans.append({"label": fan.get("label") or chip.get("name") or "Fan", "rpm": fan["rpm"]})
            for sensor in chip.get("temperatures") or chip.get("temps") or []:
                if sensor.get("celsius") is not None or sensor.get("temp_c") is not None:
                    temps.append(
                        {
                            "label": sensor.get("label") or chip.get("name") or "Sensor",
                            "celsius": sensor.get("celsius", sensor.get("temp_c")),
                        }
                    )

    return _prune(
        {
            "available": bool(temps or fans),
            "temperatures": temps,
            "fans": fans,
        }
    )


def collect_reboots() -> dict[str, Any]:
    events: list[dict[str, Any]] = []

    # Prefer `last reboot`
    last = _run(["last", "-x", "reboot", "-n", "20"], timeout=10)
    if last.get("stdout"):
        for line in last["stdout"].splitlines():
            line = line.strip()
            if not line or line.startswith("wtmp") or line.lower().startswith("reboot"):
                # still parse reboot lines
                pass
            if "reboot" not in line.lower() and not line.startswith("system boot"):
                if not re.match(r"^reboot\s+", line, re.I):
                    continue
            # Example: reboot   system boot  6.8.0-71-generi Tue Aug  5 10:21   still running
            m = re.search(
                r"(?:reboot|system boot)\s+\S+\s+(.+?)(?:\s+-\s+(.+))?$",
                line,
                re.I,
            )
            # Simpler split: take from weekday onward
            parts = line.split()
            if len(parts) >= 6:
                # find weekday token
                boot_time = None
                for i, tok in enumerate(parts):
                    if tok[:3] in ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"):
                        boot_time = " ".join(parts[i : i + 4])
                        break
                row = _prune({"boot_time": boot_time or " ".join(parts[4:8]), "raw": None})
                if "still running" in line.lower():
                    row["status"] = "current"
                if row.get("boot_time"):
                    events.append(row)

    if not events:
        # who -b only current boot
        up = collect_uptime()
        if up.get("boot_time"):
            events.append({"boot_time": up["boot_time"], "status": "current"})

    # Deduplicate consecutive identical boot_time
    deduped = []
    seen = set()
    for e in events:
        key = e.get("boot_time")
        if key in seen:
            continue
        seen.add(key)
        deduped.append(e)

    return _prune({"available": bool(deduped), "events": deduped[:20]})


def collect_ping(host: str, count: int = 4) -> dict[str, Any]:
    target = validate_host(host)
    if not target:
        return {"available": False, "error": "Invalid hostname or IP"}
    count = max(1, min(int(count or 4), 20))
    if not _cmd_exists("ping"):
        return {"available": False, "error": "ping command unavailable"}

    result = _run(["ping", "-c", str(count), "-W", "2", target], timeout=count * 3 + 5)
    out = result.get("stdout") or ""
    if not out and result.get("timeout"):
        return {"available": True, "host": target, "reachable": False, "error": "Timed out"}

    transmitted = received = loss = None
    m = re.search(r"(\d+)\s+packets transmitted,\s+(\d+)\s+(?:packets )?received,\s+([\d.]+)%\s+packet loss", out)
    if m:
        transmitted, received, loss = int(m.group(1)), int(m.group(2)), float(m.group(3))

    rtt = {}
    m2 = re.search(r"rtt min/avg/max/(?:mdev|stddev) = ([\d.]+)/([\d.]+)/([\d.]+)", out)
    if m2:
        rtt = {"min_ms": float(m2.group(1)), "avg_ms": float(m2.group(2)), "max_ms": float(m2.group(3))}

    reachable = received is not None and received > 0
    status = "healthy" if reachable and (loss or 0) < 5 else "warning" if reachable else "critical"

    return _prune(
        {
            "available": True,
            "host": target,
            "reachable": reachable,
            "packets_transmitted": transmitted,
            "packets_received": received,
            "packet_loss_percent": loss,
            "latency": rtt or None,
            "status": status,
        }
    )


def collect_packet_loss(host: str, count: int = 20) -> dict[str, Any]:
    count = max(5, min(int(count or 20), 100))
    data = collect_ping(host, count=count)
    if not data.get("available"):
        return data
    loss = data.get("packet_loss_percent")
    if loss is not None:
        data["status"] = (
            "critical" if loss >= 25 else "warning" if loss >= 5 else "healthy"
        )
    return data


def collect_ports(host: str, ports: str) -> dict[str, Any]:
    target = validate_host(host)
    if not target:
        return {"available": False, "error": "Invalid hostname or IP"}
    if not _is_private_or_local(target) and target not in ("localhost",):
        # Still allow but note — keep scan limited
        pass

    port_list: list[int] = []
    for part in (ports or "").split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            try:
                start, end = int(a), int(b)
            except ValueError:
                return {"available": False, "error": f"Invalid port range: {part}"}
            if start > end or start < 1 or end > 65535 or (end - start) > 31:
                return {"available": False, "error": "Port range too large (max 32 ports) or invalid"}
            port_list.extend(range(start, end + 1))
        else:
            try:
                p = int(part)
            except ValueError:
                return {"available": False, "error": f"Invalid port: {part}"}
            if p < 1 or p > 65535:
                return {"available": False, "error": f"Invalid port: {part}"}
            port_list.append(p)

    port_list = sorted(set(port_list))
    if not port_list:
        return {"available": False, "error": "Specify at least one port"}
    if len(port_list) > 32:
        return {"available": False, "error": "Maximum 32 ports per scan"}

    results = []
    for p in port_list:
        state = "closed"
        try:
            sock = socket.create_connection((target, p), timeout=1.5)
            sock.close()
            state = "open"
        except (socket.timeout, TimeoutError):
            state = "filtered"
        except OSError:
            state = "closed"
        svc = None
        try:
            svc = socket.getservbyport(p, "tcp")
        except OSError:
            svc = None
        row = {"port": p, "protocol": "tcp", "state": state}
        if svc:
            row["service"] = svc
        results.append(row)

    return _prune({"available": True, "host": target, "results": results})


def collect_traceroute(host: str, max_hops: int = 15) -> dict[str, Any]:
    target = validate_host(host)
    if not target:
        return {"available": False, "error": "Invalid hostname or IP"}
    max_hops = max(1, min(int(max_hops or 15), 30))

    binary = "traceroute" if _cmd_exists("traceroute") else ("tracepath" if _cmd_exists("tracepath") else None)
    if not binary:
        return {"available": False, "error": "traceroute/tracepath unavailable"}

    if binary == "traceroute":
        result = _run(["traceroute", "-n", "-w", "2", "-q", "1", "-m", str(max_hops), target], timeout=45)
    else:
        result = _run(["tracepath", "-n", "-m", str(max_hops), target], timeout=45)

    hops = []
    for line in (result.get("stdout") or "").splitlines():
        line = line.strip()
        # traceroute: " 1  192.168.1.1  1.234 ms"
        m = re.match(r"^(\d+)\s+(\S+)(?:\s+([\d.]+)\s*ms)?", line)
        if m:
            hop = {"hop": int(m.group(1)), "address": m.group(2)}
            if m.group(2) not in ("*", "no"):
                if m.group(3):
                    hop["latency_ms"] = float(m.group(3))
                hops.append(hop)
            continue
        # tracepath: " 1:  192.168.1.1  0.5ms"
        m2 = re.match(r"^(\d+):\s+(\S+)\s+([\d.]+)ms", line)
        if m2 and m2.group(2) != "???":
            hops.append(
                {
                    "hop": int(m2.group(1)),
                    "address": m2.group(2),
                    "latency_ms": float(m2.group(3)),
                }
            )

    return _prune({"available": bool(hops), "host": target, "hops": hops, "tool": binary})


def collect_firewall() -> dict[str, Any]:
    info: dict[str, Any] = {"available": False}

    if _cmd_exists("ufw"):
        r = _run(["ufw", "status"], timeout=8)
        # may need sudo
        if not r.get("ok") or "inactive" not in (r.get("stdout") or "").lower() and "active" not in (r.get("stdout") or "").lower():
            r = _run(["sudo", "-n", "ufw", "status"], timeout=8)
        out = (r.get("stdout") or "").strip()
        if out:
            active = "active" in out.lower() and "inactive" not in out.splitlines()[0].lower()
            if out.lower().startswith("status: inactive"):
                active = False
            if out.lower().startswith("status: active"):
                active = True
            rules = [ln for ln in out.splitlines()[1:] if ln.strip() and not ln.startswith("--")]
            info = {
                "available": True,
                "technology": "ufw",
                "active": active,
                "status": "active" if active else "inactive",
                "rule_count": len(rules) if active else 0,
            }
            return _prune(info)

    if _cmd_exists("firewall-cmd"):
        r = _run(["firewall-cmd", "--state"], timeout=8)
        state = (r.get("stdout") or "").strip().lower()
        if state in ("running", "not running"):
            return _prune(
                {
                    "available": True,
                    "technology": "firewalld",
                    "active": state == "running",
                    "status": state,
                }
            )

    if _cmd_exists("nft"):
        r = _run(["sudo", "-n", "nft", "list", "ruleset"], timeout=8)
        if r.get("ok") and r.get("stdout"):
            ruleset = r["stdout"]
            return _prune(
                {
                    "available": True,
                    "technology": "nftables",
                    "active": "rule" in ruleset or "chain" in ruleset,
                    "status": "ruleset present" if ruleset.strip() else "empty",
                    "rule_lines": len([ln for ln in ruleset.splitlines() if ln.strip()]),
                }
            )

    ipt = _run(["sudo", "-n", "iptables", "-L", "-n"], timeout=8)
    if ipt.get("ok") and ipt.get("stdout"):
        lines = [ln for ln in ipt["stdout"].splitlines() if ln.strip() and not ln.startswith("Chain") and not ln.startswith("target")]
        return _prune(
            {
                "available": True,
                "technology": "iptables",
                "active": len(lines) > 0,
                "status": "rules present" if lines else "no filter rules listed",
                "rule_count": len(lines),
            }
        )

    return {"available": False, "error": "No supported firewall tooling detected"}


def _parse_auth_log_lines(text: str, failed: bool) -> list[dict[str, Any]]:
    events = []
    for line in text.splitlines():
        lower = line.lower()
        if failed:
            if not (
                "failed password" in lower
                or "authentication failure" in lower
                or "invalid user" in lower
            ):
                continue
        else:
            if "accepted" not in lower and "session opened" not in lower:
                continue
            if "sshd" not in lower and "ssh" not in lower:
                continue

        ts = None
        # syslog: "Aug 12 10:00:01" or ISO
        m = re.match(r"^(\d{4}-\d{2}-\d{2}T[\d:.+\-]+)", line)
        if m:
            ts = m.group(1)
        else:
            m = re.match(r"^([A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2})", line)
            if m:
                ts = m.group(1)

        user = None
        um = re.search(r"(?:user|for)\s+([A-Za-z0-9._\-]+)", line, re.I)
        if um:
            user = um.group(1)
        ip = None
        im = re.search(r"(\d{1,3}(?:\.\d{1,3}){3})", line)
        if im:
            ip = im.group(1)
        method = None
        if "password" in lower:
            method = "password"
        elif "publickey" in lower:
            method = "publickey"

        row = _prune(
            {
                "time": ts,
                "user": user if user not in ("from", "port") else None,
                "source_ip": ip,
                "method": method if failed or method else None,
                "type": "failed" if failed else "success",
            }
        )
        if row:
            events.append(row)
    return events


def collect_failed_logins(limit: int = 50) -> dict[str, Any]:
    limit = max(1, min(int(limit or 50), 200))
    text = ""
    for path in ("/var/log/auth.log", "/var/log/secure"):
        text = _read(path)
        if text:
            break
    if not text and _cmd_exists("journalctl"):
        r = _run(
            ["journalctl", "-u", "ssh", "-u", "sshd", "--no-pager", "-n", "300", "-o", "short-iso"],
            timeout=12,
        )
        text = r.get("stdout") or ""

    if not text:
        return {"available": False, "error": "Authentication logs unavailable"}

    events = _parse_auth_log_lines(text, failed=True)
    # Group by user+ip
    groups: dict[str, dict[str, Any]] = {}
    for e in events:
        key = f"{e.get('user') or '?'}@{e.get('source_ip') or '?'}"
        g = groups.get(key)
        if not g:
            groups[key] = {
                "user": e.get("user"),
                "source_ip": e.get("source_ip"),
                "count": 1,
                "last_seen": e.get("time"),
                "method": e.get("method"),
            }
        else:
            g["count"] += 1
            if e.get("time"):
                g["last_seen"] = e["time"]

    grouped = sorted(groups.values(), key=lambda x: x.get("count", 0), reverse=True)
    total = len(events)
    status = "critical" if total >= 20 else "warning" if total >= 5 else "healthy" if total else None

    return _prune(
        {
            "available": True,
            "total": total,
            "status": status,
            "groups": grouped[:limit],
            "recent": events[-limit:],
        }
    )


def collect_ssh_logins(limit: int = 40) -> dict[str, Any]:
    limit = max(1, min(int(limit or 40), 200))
    events: list[dict[str, Any]] = []

    last = _run(["last", "-ai", "-F", "-n", str(limit)], timeout=10)
    if last.get("stdout"):
        for line in last["stdout"].splitlines():
            if not line.strip() or line.startswith("wtmp") or "reboot" in line.lower():
                continue
            parts = line.split()
            if len(parts) < 3:
                continue
            user = parts[0]
            if user in ("reboot", "shutdown", "runlevel"):
                continue
            ip = None
            for tok in parts:
                if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", tok):
                    ip = tok
                    break
            # Time roughly from weekday
            time_str = None
            for i, tok in enumerate(parts):
                if tok[:3] in ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"):
                    time_str = " ".join(parts[i : i + 5])
                    break
            row = _prune({"user": user, "source_ip": ip, "login_time": time_str})
            if row.get("user"):
                events.append(row)

    if not events:
        text = _read("/var/log/auth.log") or _read("/var/log/secure")
        events = _parse_auth_log_lines(text, failed=False)[-limit:]

    return _prune({"available": bool(events), "sessions": events[:limit]})


def collect_ssl(host: str, port: int = 443) -> dict[str, Any]:
    target = validate_host(host)
    if not target:
        return {"available": False, "error": "Invalid hostname or IP"}
    port = int(port or 443)
    if port < 1 or port > 65535:
        return {"available": False, "error": "Invalid port"}

    try:
        context = ssl.create_default_context()
        with socket.create_connection((target, port), timeout=8) as sock:
            with context.wrap_socket(sock, server_hostname=target) as ssock:
                cert = ssock.getpeercert()
                tls = ssock.version()
    except ssl.SSLCertVerificationError as exc:
        return _prune(
            {
                "available": True,
                "host": target,
                "port": port,
                "valid": False,
                "hostname_ok": False,
                "error": str(exc),
                "status": "critical",
            }
        )
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "error": f"TLS probe failed: {exc}"}

    subject = dict(x[0] for x in cert.get("subject", ()))
    issuer = dict(x[0] for x in cert.get("issuer", ()))
    not_after = cert.get("notAfter")
    days_remaining = None
    if not_after:
        try:
            exp = datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
            days_remaining = (exp - datetime.now(timezone.utc)).days
        except ValueError:
            days_remaining = None

    status = "healthy"
    if days_remaining is not None:
        if days_remaining <= 7:
            status = "critical"
        elif days_remaining <= 30:
            status = "warning"

    return _prune(
        {
            "available": True,
            "host": target,
            "port": port,
            "valid": True,
            "hostname_ok": True,
            "subject": subject.get("commonName") or subject.get("organizationName"),
            "issuer": issuer.get("commonName") or issuer.get("organizationName"),
            "expires": not_after,
            "days_remaining": days_remaining,
            "tls_version": tls,
            "status": status,
        }
    )


def collect_software(limit: int = 200, search: str = "") -> dict[str, Any]:
    limit = max(1, min(int(limit or 200), 1000))
    search = (search or "").strip().lower()
    packages: list[dict[str, Any]] = []
    manager = None

    if _cmd_exists("dpkg-query"):
        manager = "dpkg"
        r = _run(["dpkg-query", "-W", "-f=${Package}\t${Version}\t${db:Status-Status}\n"], timeout=30)
        for line in (r.get("stdout") or "").splitlines():
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            name, ver = parts[0], parts[1]
            status = parts[2] if len(parts) > 2 else None
            if status and status != "installed":
                continue
            if search and search not in name.lower():
                continue
            packages.append(_prune({"name": name, "version": ver, "source": "dpkg"}))
    elif _cmd_exists("rpm"):
        manager = "rpm"
        r = _run(["rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\n"], timeout=30)
        for line in (r.get("stdout") or "").splitlines():
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            if search and search not in parts[0].lower():
                continue
            packages.append({"name": parts[0], "version": parts[1], "source": "rpm"})

    packages.sort(key=lambda p: p.get("name") or "")
    total = len(packages)
    return _prune(
        {
            "available": bool(manager),
            "package_manager": manager,
            "total": total,
            "packages": packages[:limit],
            "truncated": total > limit,
            "error": None if manager else "No package manager (dpkg/rpm) detected",
        }
    )


def collect_users() -> dict[str, Any]:
    users: list[dict[str, Any]] = []
    passwd = _read("/etc/passwd")
    if not passwd:
        return {"available": False, "error": "Unable to read account database"}

    lastlog_map: dict[str, str] = {}
    if _cmd_exists("lastlog"):
        r = _run(["lastlog", "-t", "365"], timeout=10)
        for line in (r.get("stdout") or "").splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 2 and "Never" not in line:
                # Username ... Latest
                lastlog_map[parts[0]] = " ".join(parts[3:]) if len(parts) > 3 else None

    human = []
    system = []
    for line in passwd.splitlines():
        parts = line.split(":")
        if len(parts) < 7:
            continue
        name, _pw, uid_s, _gid, gecos, home, shell = parts[:7]
        try:
            uid = int(uid_s)
        except ValueError:
            continue
        if name in ("sync", "halt", "shutdown"):
            continue
        row = _prune(
            {
                "username": name,
                "uid": uid,
                "shell": shell if shell and shell not in ("/usr/sbin/nologin", "/bin/false", "/sbin/nologin") else ("nologin" if "nologin" in shell or shell.endswith("false") else shell),
                "home": home if home and home != "/" else None,
                "login_enabled": shell not in ("/usr/sbin/nologin", "/bin/false", "/sbin/nologin"),
                "last_login": lastlog_map.get(name),
                "gecos": gecos or None,
            }
        )
        # Hide shell field if nologin marker only — keep login_enabled
        if row.get("shell") == "nologin":
            row.pop("shell", None)
        if uid >= 1000 and name != "nobody":
            human.append(row)
        else:
            system.append(row)

    return _prune(
        {
            "available": True,
            "human_users": human,
            "system_account_count": len(system),
        }
    )


def collect_backup() -> dict[str, Any]:
    """Detect known backup tooling only when verifiable — never claim success without evidence."""
    findings: list[dict[str, Any]] = []

    # systemd timers commonly used for backups
    if _cmd_exists("systemctl"):
        r = _run(["systemctl", "list-timers", "--all", "--no-pager"], timeout=10)
        out = r.get("stdout") or ""
        for line in out.splitlines():
            lower = line.lower()
            if any(k in lower for k in ("backup", "borg", "restic", "rsnapshot", "duplicity")):
                findings.append({"source": "systemd-timer", "detail": line.strip()})

    for unit in ("borgmatic.timer", "restic-backup.timer", "rsnapshot.timer"):
        if _cmd_exists("systemctl"):
            r = _run(["systemctl", "is-active", unit], timeout=5)
            state = (r.get("stdout") or "").strip()
            if state and state != "inactive" and "could not" not in state.lower():
                findings.append({"system": unit, "status": state})

    # Config presence (not success)
    for path, name in (
        ("/etc/borgmatic/config.yaml", "borgmatic"),
        ("/etc/restic", "restic"),
        ("/etc/rsnapshot.conf", "rsnapshot"),
        ("/etc/default/backup", "backup"),
    ):
        if Path(path).exists():
            findings.append({"system": name, "config": path, "status": "configured"})

    if not findings:
        return {"available": False, "message": "Backup status unavailable"}

    return _prune({"available": True, "findings": findings, "verified_success": False})


def broadcast_message(message: str, severity: str = "info") -> dict[str, Any]:
    message = (message or "").strip()
    if not message:
        return {"success": False, "error": "Message is required"}
    if len(message) > 500:
        return {"success": False, "error": "Message too long (max 500 characters)"}
    # Strip control chars except newline
    message = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", message)
    severity = (severity or "info").lower()
    if severity not in ("info", "warning", "critical", "maintenance"):
        severity = "info"

    header = {
        "info": "[FBL NOTICE]",
        "warning": "[FBL WARNING]",
        "critical": "[FBL CRITICAL]",
        "maintenance": "[FBL MAINTENANCE]",
    }[severity]
    body = f"{header} {message}"

    if not _cmd_exists("wall"):
        return {"success": False, "error": "wall command unavailable on this host"}

    # wall reads message from stdin — safe
    result = _run(["wall"], timeout=10, input_text=body + "\n")
    ts = datetime.now().isoformat(timespec="seconds")
    if result.get("ok") or result.get("returncode") == 0:
        return {"success": True, "timestamp": ts, "severity": severity}
    # Some wall versions return non-zero but still deliver; if no stderr permission issue treat carefully
    if result.get("unavailable"):
        return {"success": False, "error": "wall command unavailable"}
    if "permission" in (result.get("stderr") or "").lower():
        return {"success": False, "error": "Permission denied sending broadcast", "timestamp": ts}
    return {
        "success": result.get("returncode") in (0, None) and not result.get("timeout"),
        "timestamp": ts,
        "severity": severity,
        "error": result.get("stderr") or None,
    }


# ── Flask registration ──────────────────────────────────────────────────────


def register_utilities_routes(
    app: Flask,
    get_latest: Optional[Callable[[], tuple[dict, dict, dict]]] = None,
) -> None:
    """
    Register /utilities/* routes on the existing Flask app.
    get_latest() -> (metrics, inventory, link_health) from CM.py caches.
    """

    def latest() -> tuple[dict, dict, dict]:
        if get_latest:
            try:
                return get_latest()
            except Exception:
                logger.exception("get_latest failed")
        return {}, {}, {}

    @app.route("/utilities/uptime")
    def util_uptime():
        metrics, _, _ = latest()
        data = collect_uptime(metrics)
        if not data.get("available"):
            return jsonify({"available": False, "message": "Data unavailable on this host"}), 200
        return jsonify(data)

    @app.route("/utilities/disk")
    def util_disk():
        metrics, _, _ = latest()
        data = collect_disk(metrics)
        if not data.get("available"):
            return jsonify({"available": False, "message": "Data unavailable on this host"}), 200
        elevated = [
            m
            for m in (data.get("mounts") or [])
            if str(m.get("status") or "").lower() in ("warning", "critical")
        ]
        if elevated:
            worst = (
                "critical"
                if any(m.get("status") == "critical" for m in elevated)
                else "warning"
            )
            _persist_utility_event(
                {
                    "utility_id": "disk-usage",
                    "category": "system",
                    "severity": worst,
                    "status": worst,
                    "summary": f"{len(elevated)} filesystem(s) above threshold",
                    "result": worst,
                    "payload": {"mounts": elevated},
                }
            )
        return jsonify(data)

    @app.route("/utilities/large-files", methods=["GET", "POST"])
    def util_large_files():
        body = request.get_json(silent=True) or {}
        path = request.args.get("path") or body.get("path") or "/home"
        min_mb = request.args.get("min_mb") or body.get("min_mb") or 100
        limit = request.args.get("limit") or body.get("limit") or 50
        try:
            data = collect_large_files(path=str(path), min_mb=int(min_mb), limit=int(limit))
        except Exception as exc:  # noqa: BLE001
            logger.exception("large-files failed")
            return jsonify({"available": False, "error": str(exc)}), 200
        return jsonify(data)

    @app.route("/utilities/temperature")
    def util_temperature():
        metrics, _, link_health = latest()
        data = collect_temperature(metrics, link_health)
        if not data.get("available"):
            return jsonify({"available": False, "message": "Data unavailable on this host"}), 200
        return jsonify(data)

    @app.route("/utilities/reboots")
    def util_reboots():
        data = collect_reboots()
        if not data.get("available"):
            return jsonify({"available": False, "message": "Data unavailable on this host"}), 200
        return jsonify(data)

    @app.route("/utilities/ping", methods=["POST"])
    def util_ping():
        body = request.get_json(silent=True) or {}
        host = body.get("host") or body.get("target")
        count = body.get("count", 4)
        data = collect_ping(str(host or ""), count=int(count or 4))
        if data.get("available") and _should_persist_status(data.get("status")):
            _persist_utility_event(
                {
                    "utility_id": "ping-node",
                    "category": "network",
                    "severity": data.get("status"),
                    "status": data.get("status"),
                    "summary": f"Ping {data.get('host')}: loss {data.get('packet_loss_percent')}%",
                    "target": data.get("host"),
                    "result": "unreachable" if not data.get("reachable") else "degraded",
                    "success": bool(data.get("reachable")),
                    "payload": data,
                }
            )
        return jsonify(data), 200

    @app.route("/utilities/packet-loss", methods=["POST"])
    def util_packet_loss():
        body = request.get_json(silent=True) or {}
        host = body.get("host") or body.get("target")
        count = body.get("count", 20)
        data = collect_packet_loss(str(host or ""), count=int(count or 20))
        if data.get("available") and _should_persist_status(data.get("status")):
            _persist_utility_event(
                {
                    "utility_id": "packet-loss",
                    "category": "network",
                    "severity": data.get("status"),
                    "status": data.get("status"),
                    "summary": f"Packet loss {data.get('packet_loss_percent')}% to {data.get('host')}",
                    "target": data.get("host"),
                    "result": data.get("status"),
                    "success": data.get("status") == "healthy",
                    "payload": data,
                }
            )
        return jsonify(data), 200

    @app.route("/utilities/ports", methods=["POST"])
    def util_ports():
        body = request.get_json(silent=True) or {}
        host = body.get("host") or body.get("target") or "127.0.0.1"
        ports = body.get("ports") or "22,80,443"
        data = collect_ports(str(host), str(ports))
        return jsonify(data), 200

    @app.route("/utilities/traceroute", methods=["POST"])
    def util_traceroute():
        body = request.get_json(silent=True) or {}
        host = body.get("host") or body.get("target")
        data = collect_traceroute(str(host or ""))
        return jsonify(data), 200

    @app.route("/utilities/firewall")
    def util_firewall():
        data = collect_firewall()
        if not data.get("available"):
            return jsonify({"available": False, "message": data.get("error") or "Data unavailable on this host"}), 200
        return jsonify(data)

    @app.route("/utilities/failed-logins")
    def util_failed_logins():
        data = collect_failed_logins()
        if not data.get("available"):
            return jsonify({"available": False, "message": data.get("error") or "Data unavailable on this host"}), 200
        if _should_persist_status(data.get("status")):
            _persist_utility_event(
                {
                    "utility_id": "failed-login-alerts",
                    "category": "security",
                    "severity": data.get("status"),
                    "status": data.get("status"),
                    "summary": f"{data.get('total')} failed login events",
                    "result": data.get("status"),
                    "payload": {"total": data.get("total"), "groups": (data.get("groups") or [])[:10]},
                }
            )
        return jsonify(data)

    @app.route("/utilities/ssh-logins")
    def util_ssh_logins():
        data = collect_ssh_logins()
        if not data.get("available"):
            return jsonify({"available": False, "message": data.get("error") or "Data unavailable on this host"}), 200
        return jsonify(data)

    @app.route("/utilities/ssl", methods=["POST"])
    def util_ssl():
        body = request.get_json(silent=True) or {}
        host = body.get("host") or body.get("target")
        port = body.get("port", 443)
        data = collect_ssl(str(host or ""), port=int(port or 443))
        if data.get("available") and _should_persist_status(data.get("status")):
            _persist_utility_event(
                {
                    "utility_id": "ssl-certificate-checker",
                    "category": "security",
                    "severity": data.get("status"),
                    "status": data.get("status"),
                    "summary": (
                        f"SSL {data.get('host')}:{data.get('port')} "
                        f"days_remaining={data.get('days_remaining')}"
                    ),
                    "target": data.get("host"),
                    "result": "valid" if data.get("valid") else "invalid",
                    "success": bool(data.get("valid")),
                    "payload": data,
                }
            )
        return jsonify(data), 200

    @app.route("/utilities/software")
    def util_software():
        search = request.args.get("search") or ""
        limit = request.args.get("limit") or 200
        data = collect_software(limit=int(limit), search=search)
        if not data.get("available"):
            return jsonify({"available": False, "message": data.get("error") or "Data unavailable on this host"}), 200
        return jsonify(data)

    @app.route("/utilities/users")
    def util_users():
        data = collect_users()
        if not data.get("available"):
            return jsonify({"available": False, "message": data.get("error") or "Data unavailable on this host"}), 200
        return jsonify(data)

    @app.route("/utilities/backup")
    def util_backup():
        data = collect_backup()
        if not data.get("available"):
            return jsonify({"available": False, "message": data.get("message") or "Backup status unavailable"}), 200
        return jsonify(data)

    @app.route("/utilities/broadcast", methods=["POST"])
    def util_broadcast():
        body = request.get_json(silent=True) or {}
        if not body.get("confirm"):
            return jsonify({"success": False, "error": "Confirmation required"}), 400
        data = broadcast_message(str(body.get("message") or ""), str(body.get("severity") or "info"))
        _persist_utility_event(
            {
                "utility_id": "broadcast-message",
                "category": "operations",
                "severity": body.get("severity") or "info",
                "status": "sent" if data.get("success") else "failed",
                "summary": "Operator broadcast message",
                "result": "success" if data.get("success") else (data.get("error") or "failed"),
                "success": bool(data.get("success")),
                "payload": {
                    "timestamp": data.get("timestamp"),
                    "severity": data.get("severity"),
                    "success": data.get("success"),
                },
            }
        )
        code = 200 if data.get("success") else 400
        return jsonify(data), code

    logger.info("FBL utilities routes registered")
