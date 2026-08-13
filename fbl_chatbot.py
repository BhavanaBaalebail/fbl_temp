"""
fbl_chatbot.py
==============
BAAV AI assistant backend for FBL.

Exposes:
  POST /api/chatbot/message  { session_id, message } -> { reply }
  POST /api/chatbot/reset    { session_id }          -> { ok: true }

Uses Gemini via the `google.generativeai` package (install in chatbot-venv).
API key is read from the environment:
  GEMINI_API_KEY   (preferred)
  GOOGLE_API_KEY   (fallback)

Never hardcode keys in source.
"""

from __future__ import annotations

import logging
import os
import threading
from collections import defaultdict, deque
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

logger = logging.getLogger("fbl_chatbot")

# Keep a short rolling history per browser session.
_MAX_TURNS = 16  # user+model pairs roughly; we store messages
_sessions: Dict[str, Deque[Dict[str, str]]] = defaultdict(lambda: deque(maxlen=_MAX_TURNS * 2))
_sessions_lock = threading.Lock()

_SYSTEM_PREAMBLE = """You are BAAV AI, the hardware assistant for Framework Block Ledger (FBL).
You help operators understand live Ubuntu server health: CPU, RAM, GPU, Disk, NIC, I/O, faults, and recovery.

Rules:
- Be concise and practical. Prefer short markdown (### headers, **bold**, bullets).
- Use ONLY the live telemetry context provided below. Do not invent sensors or readings.
- If data is missing, say so clearly.
- Distinguish real faults from healthy/normal readings.
- Do not claim a fault is recovered unless telemetry shows the condition cleared.
- Never reveal API keys or ask the user for secrets.
- If asked to kill/pause processes, explain that operators must use FBL Recovery actions in the UI; you cannot execute them yourself.
"""


def _get_api_key() -> Optional[str]:
    key = (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip()
    return key or None


def _compact_telemetry(metrics: dict, inventory: dict, link_health: dict) -> str:
    """Build a compact text context for the model from LATEST_* caches."""
    lines: List[str] = []

    hostname = (
        (inventory or {}).get("system", {}) or {}
    ).get("hostname") or (metrics or {}).get("system", {}).get("hostname")
    if hostname:
        lines.append(f"Hostname: {hostname}")

    cpu = (metrics or {}).get("cpu") or {}
    if cpu:
        parts = []
        if cpu.get("usage_percent") is not None:
            parts.append(f"usage={cpu.get('usage_percent')}%")
        if cpu.get("temperature_celsius") is not None:
            parts.append(f"temp={cpu.get('temperature_celsius')}°C")
        load = cpu.get("load_average") or {}
        if load:
            parts.append(
                f"load={load.get('1min')}/{load.get('5min')}/{load.get('15min')}"
            )
        if parts:
            lines.append("CPU: " + ", ".join(parts))

    mem = (metrics or {}).get("memory") or {}
    if mem.get("usage_percent") is not None:
        lines.append(
            f"RAM: usage={mem.get('usage_percent')}%"
            + (f", used_mb={mem.get('used_mb')}" if mem.get("used_mb") is not None else "")
        )

    gpus = (metrics or {}).get("gpu") or []
    if isinstance(gpus, dict):
        gpus = [gpus]
    for i, g in enumerate(gpus[:2]):
        if not isinstance(g, dict):
            continue
        gparts = []
        if g.get("gpu_utilization_percent") is not None:
            gparts.append(f"util={g.get('gpu_utilization_percent')}%")
        if g.get("temperature_celsius") is not None:
            gparts.append(f"temp={g.get('temperature_celsius')}°C")
        if g.get("memory_utilization_percent") is not None:
            gparts.append(f"vram={g.get('memory_utilization_percent')}%")
        if gparts:
            lines.append(f"GPU[{i}]: " + ", ".join(gparts))

    disks = (metrics or {}).get("disk") or {}
    mounts = disks.get("mounts") if isinstance(disks, dict) else None
    if isinstance(mounts, list):
        for m in mounts[:4]:
            if not isinstance(m, dict):
                continue
            mp = m.get("mountpoint") or m.get("path") or "?"
            pct = m.get("usage_percent") or m.get("use_percent")
            if pct is not None:
                lines.append(f"Disk {mp}: {pct}% used")

    nics = (metrics or {}).get("nic") or (metrics or {}).get("network") or {}
    if isinstance(nics, dict):
        ifaces = nics.get("interfaces") or nics.get("adapters") or []
        if isinstance(ifaces, list):
            for iface in ifaces[:4]:
                if not isinstance(iface, dict):
                    continue
                name = iface.get("name") or iface.get("interface") or "?"
                up = iface.get("operstate") or iface.get("link_state") or iface.get("state")
                util = iface.get("utilization_percent")
                bit = f"NIC {name}: state={up}"
                if util is not None:
                    bit += f", util={util}%"
                lines.append(bit)

    summary = (link_health or {}).get("health_summary") or {}
    if summary:
        lines.append(
            f"Link health: overall={summary.get('overall_health')}, "
            f"score={summary.get('score')}"
        )
        crit = summary.get("critical_alerts") or []
        warn = summary.get("warnings") or []
        for msg in (crit or [])[:6]:
            lines.append(f"CRITICAL: {msg}")
        for msg in (warn or [])[:6]:
            lines.append(f"WARNING: {msg}")

    # Component health snippets
    for key in ("cpu", "memory", "gpu", "disk", "nic", "io_controller"):
        block = (link_health or {}).get(key)
        if isinstance(block, list) and block:
            block = block[0]
        if not isinstance(block, dict):
            continue
        health = block.get("health") or {}
        status = health.get("status") or block.get("status")
        if status:
            lines.append(f"{key} health: {status}")

    if not lines:
        return "No live telemetry is currently cached on the agent."
    return "\n".join(lines)


def _call_gemini(session_id: str, user_message: str, telemetry_text: str) -> str:
    api_key = _get_api_key()
    if not api_key:
        return (
            "Gemini is not configured on this agent. "
            "Set GEMINI_API_KEY (or GOOGLE_API_KEY) in the environment before starting cm.py, "
            "then restart the agent."
        )

    try:
        import google.generativeai as genai  # type: ignore
    except ImportError:
        return (
            "The `google-generativeai` package is not installed in this Python environment. "
            "Activate chatbot-venv (or `pip install google-generativeai`) and restart cm.py."
        )

    genai.configure(api_key=api_key)
    model_name = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash").strip() or "gemini-2.0-flash"

    system = (
        _SYSTEM_PREAMBLE
        + "\n\n--- LIVE TELEMETRY CONTEXT ---\n"
        + telemetry_text
        + "\n--- END CONTEXT ---\n"
    )

    with _sessions_lock:
        history = list(_sessions[session_id])

    # Build chat history for the SDK (role: user/model).
    contents: List[Dict[str, Any]] = []
    for turn in history:
        role = turn.get("role")
        text = turn.get("text") or ""
        if role in ("user", "model") and text:
            contents.append({"role": role, "parts": [text]})

    contents.append({"role": "user", "parts": [user_message]})

    try:
        model = genai.GenerativeModel(
            model_name=model_name,
            system_instruction=system,
        )
        response = model.generate_content(contents)
        reply = (getattr(response, "text", None) or "").strip()
        if not reply:
            reply = "I received an empty response from Gemini. Please try again."
    except Exception as exc:
        logger.exception("Gemini request failed")
        err = str(exc)
        if "API_KEY" in err.upper() or "401" in err or "403" in err:
            return (
                "Gemini rejected the API key. Check GEMINI_API_KEY on the agent host "
                "and restart cm.py."
            )
        return f"Gemini request failed: {err}"

    with _sessions_lock:
        _sessions[session_id].append({"role": "user", "text": user_message})
        _sessions[session_id].append({"role": "model", "text": reply})

    return reply


def reset_session(session_id: str) -> None:
    with _sessions_lock:
        _sessions.pop(session_id, None)


def register_chatbot_routes(
    app,
    get_latest: Callable[[], Tuple[dict, dict, dict]],
) -> None:
    """
    Register chatbot routes on the Flask app.

    get_latest() must return (metrics, inventory, link_health) from CM caches.
    """
    from flask import jsonify, request

    @app.route("/api/chatbot/message", methods=["POST"])
    def chatbot_message():
        body = request.get_json(silent=True) or {}
        message = (body.get("message") or "").strip()
        session_id = (body.get("session_id") or "default").strip() or "default"

        if not message:
            return jsonify({"error": "message is required"}), 400

        try:
            metrics, inventory, link_health = get_latest()
        except Exception:
            logger.exception("Failed to read live telemetry for chatbot")
            metrics, inventory, link_health = {}, {}, {}

        telemetry_text = _compact_telemetry(metrics or {}, inventory or {}, link_health or {})
        reply = _call_gemini(session_id, message, telemetry_text)
        return jsonify({"reply": reply})

    @app.route("/api/chatbot/reset", methods=["POST"])
    def chatbot_reset():
        body = request.get_json(silent=True) or {}
        session_id = (body.get("session_id") or "").strip()
        if session_id:
            reset_session(session_id)
        return jsonify({"ok": True})

    key_state = "set" if _get_api_key() else "MISSING"
    logger.info(
        "FBL chatbot routes registered (/api/chatbot/message, /api/chatbot/reset); "
        "GEMINI_API_KEY=%s",
        key_state,
    )
