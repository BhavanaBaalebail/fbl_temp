"""
Force-kill recovery handlers for CM.py.

Copy _force_kill_process_pid, cpu_kill_process, ram_terminate_process, and
gpu_terminate_process into the RECOVERY ENGINE section of CM.py (replace the
existing _signal_process-based kill/terminate handlers).

Requires run_recovery_command, logger, and Path from CM.py scope.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any


def _force_kill_process_pid(pid: int, *, run_recovery_command, logger) -> dict[str, Any]:
    """Force-kill exactly one PID via `kill -9 <PID>`."""
    pid_int = int(pid)
    cmd = ["kill", "-9", str(pid_int)]
    cmd_str = f"kill -9 {pid_int}"
    logger.info("recovery force-kill: received pid=%s command=%s", pid_int, cmd_str)

    if not Path(f"/proc/{pid_int}").is_dir():
        msg = f"pid {pid_int} does not exist — no process to kill"
        logger.warning("recovery force-kill: %s", msg)
        return {
            "success": False,
            "message": msg,
            "command": cmd_str,
            "stdout": "",
            "stderr": "no such process",
            "returncode": 1,
        }

    res = run_recovery_command(cmd)
    res["command"] = cmd_str
    still_alive = Path(f"/proc/{pid_int}").is_dir()
    logger.info(
        "recovery force-kill: pid=%s returncode=%s stdout=%r stderr=%r still_alive=%s",
        pid_int,
        res.get("returncode"),
        res.get("stdout"),
        res.get("stderr"),
        still_alive,
    )

    if still_alive:
        res["success"] = False
        res["message"] = f"Process {pid_int} is still running after kill -9."
    elif res.get("returncode") == 0:
        res["success"] = True
        res["message"] = f"Process {pid_int} force-killed (kill -9)."
    else:
        res["success"] = False
        res["message"] = (
            res.get("stderr")
            or f"kill -9 failed for pid {pid_int} (exit {res.get('returncode')})"
        )
    return res


def make_cpu_kill_process(run_recovery_command, logger):
    def cpu_kill_process(params: dict) -> dict[str, Any]:
        logger.info("cpu.kill_process: backend received pid=%s", params.get("pid"))
        return _force_kill_process_pid(
            params["pid"], run_recovery_command=run_recovery_command, logger=logger
        )

    return cpu_kill_process


def make_ram_terminate_process(run_recovery_command, logger):
    def ram_terminate_process(params: dict) -> dict[str, Any]:
        logger.info("ram.terminate_process: backend received pid=%s", params.get("pid"))
        return _force_kill_process_pid(
            params["pid"], run_recovery_command=run_recovery_command, logger=logger
        )

    return ram_terminate_process


def make_gpu_terminate_process(run_recovery_command, logger):
    def gpu_terminate_process(params: dict) -> dict[str, Any]:
        logger.info("gpu.terminate_process: backend received pid=%s", params.get("pid"))
        return _force_kill_process_pid(
            params["pid"], run_recovery_command=run_recovery_command, logger=logger
        )

    return gpu_terminate_process
