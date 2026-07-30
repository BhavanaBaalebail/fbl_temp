"""Apply force-kill (kill -9) handlers to an uncommented CM.py recovery engine."""
from pathlib import Path
import re

FORCE_KILL = '''
def _force_kill_process_pid(pid: int) -> dict[str, Any]:
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
'''

CPU_KILL = '''
def cpu_kill_process(params: dict) -> dict[str, Any]:
    logger.info("cpu.kill_process: backend received pid=%s", params.get("pid"))
    return _force_kill_process_pid(params["pid"])
'''

RAM_TERM = '''
def ram_terminate_process(params: dict) -> dict[str, Any]:
    logger.info("ram.terminate_process: backend received pid=%s", params.get("pid"))
    return _force_kill_process_pid(params["pid"])
'''

GPU_TERM = '''
def gpu_terminate_process(params: dict) -> dict[str, Any]:
    logger.info("gpu.terminate_process: backend received pid=%s", params.get("pid"))
    return _force_kill_process_pid(params["pid"])
'''


def replace_function(text: str, name: str, new_body: str) -> str:
    pattern = rf"def {name}\(params: dict\) -> dict\[str, Any\]:.*?(?=\n\ndef |\nclass |\n# ---|\nRECOVERY_ACTIONS|\Z)"
    if not re.search(pattern, text, flags=re.DOTALL):
        raise SystemExit(f"function {name} not found in CM.py")
    return re.sub(pattern, new_body.strip() + "\n", text, count=1, flags=re.DOTALL)


def insert_before_cpu_kill(text: str) -> str:
    if "_force_kill_process_pid" in text:
        return text
    marker = "def cpu_kill_process(params: dict) -> dict[str, Any]:"
    if marker not in text:
        raise SystemExit("cpu_kill_process marker not found")
    return text.replace(marker, FORCE_KILL.strip() + "\n\n\n" + marker, 1)


def patch_run_recovery_action(text: str) -> str:
    needle = "resolved_params = resolve_recovery_params(action_key, raw_params or {})"
    insert = (
        needle
        + '\n\n    if "pid" in (raw_params or {}):\n'
        + '        logger.info(\n'
        + '            "recovery execute: action=%s pid_received=%s pid_resolved=%s",\n'
        + "            action_key,\n"
        + '            (raw_params or {}).get("pid"),\n'
        + '            resolved_params.get("pid"),\n'
        + "        )"
    )
    if insert in text:
        return text
    if needle not in text:
        return text
    return text.replace(needle, insert, 1)


def patch_execute_route(text: str) -> str:
    needle = 'params = body.get("params") or {}'
    insert = (
        needle
        + '\n    logger.info(\n'
        + '        "POST /recovery/execute action=%s pid=%s",\n'
        + "        body.get(\"action\"),\n"
        + "        params.get(\"pid\"),\n"
        + "    )"
    )
    if "POST /recovery/execute action=" in text:
        return text
    return text.replace(needle, insert, 1)


def main() -> None:
    path = Path(__file__).resolve().parent.parent / "CM.py"
    text = path.read_text(encoding="utf-8")
    text = insert_before_cpu_kill(text)
    text = replace_function(text, "cpu_kill_process", CPU_KILL)
    text = replace_function(text, "ram_terminate_process", RAM_TERM)
    text = replace_function(text, "gpu_terminate_process", GPU_TERM)
    text = patch_run_recovery_action(text)
    text = patch_execute_route(text)
    path.write_text(text, encoding="utf-8")
    print("recovery kill patch applied to CM.py")


if __name__ == "__main__":
    main()
