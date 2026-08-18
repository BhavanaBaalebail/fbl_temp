"""
fbl_whatsapp.py
===============
WhatsApp critical-alert notifications for FBL.

Triggered from the existing fault lifecycle (backend poll + frontend
threshold criticals). Never invents faults. Never exposes API tokens.

Environment:
  WHATSAPP_ENABLED=true|false
  WHATSAPP_PROVIDER=meta|log
  WHATSAPP_API_TOKEN=...
  WHATSAPP_PHONE_NUMBER_ID=...
  WHATSAPP_RECIPIENT_NUMBER=...   # E.164 digits, optional leading +
  WHATSAPP_API_VERSION=v21.0      # optional

Credentials stay in the environment — never in frontend, logs, or API bodies.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger("fbl_whatsapp")

try:
    import telemetry_db
except Exception:  # pragma: no cover
    telemetry_db = None  # type: ignore

_lock = threading.Lock()
_WHATSAPP_ENV_LOADED = False


def load_whatsapp_env_file(path: Optional[str] = None) -> bool:
    """
    Load WHATSAPP_* vars from a local file for demo/dev (never commit secrets).
    Default: whatsapp.env beside this module / CM.py project root.
    Existing process env vars are not overwritten.
    """
    global _WHATSAPP_ENV_LOADED
    if _WHATSAPP_ENV_LOADED:
        return False

    candidates = []
    if path:
        candidates.append(Path(path))
    else:
        here = Path(__file__).resolve().parent
        candidates.extend([here / "whatsapp.env", here / ".env.whatsapp"])

    env_path = next((p for p in candidates if p.is_file()), None)
    if env_path is None:
        _WHATSAPP_ENV_LOADED = True
        return False

    loaded = 0
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if not key.startswith("WHATSAPP_"):
            continue
        if key in os.environ and os.environ.get(key):
            continue
        os.environ[key] = value
        loaded += 1

    _WHATSAPP_ENV_LOADED = True
    if loaded:
        logger.info("Loaded WhatsApp demo config from %s (%s vars)", env_path.name, loaded)
    return loaded > 0


load_whatsapp_env_file()


# ---------------------------------------------------------------------------
# Config (never log secrets)
# ---------------------------------------------------------------------------


def _env_bool(name: str, default: bool = False) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def get_whatsapp_config() -> dict[str, Any]:
    enabled = _env_bool("WHATSAPP_ENABLED", False)
    provider = (os.environ.get("WHATSAPP_PROVIDER") or "meta").strip().lower()
    token = (os.environ.get("WHATSAPP_API_TOKEN") or "").strip()
    phone_id = (os.environ.get("WHATSAPP_PHONE_NUMBER_ID") or "").strip()
    recipient = (os.environ.get("WHATSAPP_RECIPIENT_NUMBER") or "").strip()
    api_version = (os.environ.get("WHATSAPP_API_VERSION") or "v21.0").strip()

    recipient_digits = re.sub(r"[^\d]", "", recipient)
    configured = bool(
        enabled
        and provider
        and (
            provider == "log"
            or (token and phone_id and recipient_digits)
        )
    )
    return {
        "enabled": enabled,
        "configured": configured,
        "provider": provider,
        "api_version": api_version,
        "phone_number_id": phone_id if configured else "",
        "has_token": bool(token),
        "recipient_masked": mask_phone(recipient_digits) if recipient_digits else None,
        # secrets kept only for send path — never returned by status API
        "_token": token if configured else "",
        "_recipient": recipient_digits if configured else "",
    }


def mask_phone(number: str) -> str:
    digits = re.sub(r"[^\d]", "", number or "")
    if len(digits) <= 4:
        return "****"
    return f"***{digits[-4:]}"


def _config_status_message(cfg: dict[str, Any]) -> str:
    if not cfg["enabled"]:
        return "WhatsApp notifications disabled/not configured"
    if not cfg["configured"]:
        return "WhatsApp notifications disabled/not configured"
    return "WhatsApp notifications enabled"


# ---------------------------------------------------------------------------
# Message formatting — omit unavailable fields
# ---------------------------------------------------------------------------


def _clean(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    lowered = text.lower()
    if lowered in ("null", "undefined", "n/a", "none", "—", "-"):
        return None
    return text


def _format_detected(ts: Any) -> Optional[str]:
    if ts is None:
        return None
    try:
        if isinstance(ts, (int, float)):
            dt = datetime.fromtimestamp(float(ts), tz=timezone.utc)
        else:
            raw = str(ts).strip()
            if raw.endswith("Z"):
                raw = raw[:-1] + "+00:00"
            dt = datetime.fromisoformat(raw)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        # Example: 12 Aug 2026, 16:42
        return dt.astimezone().strftime("%d %b %Y, %H:%M")
    except Exception:
        return _clean(ts)


def build_critical_message(fault: dict[str, Any]) -> str:
    lines = ["🚨 FBL CRITICAL ALERT", ""]
    pairs = [
        ("Component", _clean(fault.get("component"))),
        ("Metric", _clean(fault.get("metric_name") or fault.get("metricName"))),
        ("Current", _clean(fault.get("current_value") or fault.get("currentValue"))),
        (
            "Critical Threshold",
            _clean(fault.get("threshold_crossed") or fault.get("thresholdCrossed")),
        ),
        ("Status", "CRITICAL"),
        (
            "Detected",
            _format_detected(
                fault.get("detected_at")
                or fault.get("detected")
                or fault.get("first_seen_at")
                or fault.get("timestamp")
            ),
        ),
        ("Host", _clean(fault.get("hostname") or fault.get("host"))),
    ]
    for label, value in pairs:
        if value:
            lines.append(f"{label}: {value}")

    impact = _clean(
        fault.get("description")
        or fault.get("faultDescription")
        or fault.get("message")
    )
    if impact:
        lines.append("")
        lines.append(f"Impact: {impact}")

    lines.append("")
    lines.append("FBL: Recovery/Investigation Required")
    return "\n".join(lines)


def build_recovery_message(fault: dict[str, Any], prior: Optional[dict[str, Any]] = None) -> str:
    prior = prior or {}
    lines = ["✅ FBL RECOVERY", ""]
    pairs = [
        ("Component", _clean(fault.get("component") or prior.get("component"))),
        (
            "Metric",
            _clean(
                fault.get("metric_name")
                or fault.get("metricName")
                or prior.get("metric_name")
            ),
        ),
        (
            "Previous",
            _clean(
                fault.get("previous_value")
                or fault.get("previousValue")
                or prior.get("current_value")
            ),
        ),
        (
            "Current",
            _clean(fault.get("current_value") or fault.get("currentValue")),
        ),
        ("Status", "RECOVERED"),
        (
            "Recovery action",
            _clean(
                fault.get("recovery_action")
                or fault.get("recoveryAction")
                or fault.get("action")
            ),
        ),
        (
            "Verified",
            _format_detected(
                fault.get("verified_at")
                or fault.get("detected_at")
                or fault.get("timestamp")
                or time.time()
            ),
        ),
        ("Host", _clean(fault.get("hostname") or prior.get("hostname"))),
    ]
    for label, value in pairs:
        if value:
            lines.append(f"{label}: {value}")
    return "\n".join(lines)


def _normalize_fault(payload: dict[str, Any]) -> dict[str, Any]:
    fault = dict(payload or {})
    fault_id = _clean(fault.get("fault_id") or fault.get("faultId") or fault.get("id"))
    severity = (_clean(fault.get("severity")) or "").lower()
    return {
        "fault_id": fault_id,
        "severity": severity,
        "component": _clean(fault.get("component")),
        "metric_name": _clean(fault.get("metric_name") or fault.get("metricName")),
        "current_value": _clean(fault.get("current_value") or fault.get("currentValue")),
        "threshold_crossed": _clean(
            fault.get("threshold_crossed") or fault.get("thresholdCrossed")
        ),
        "description": _clean(
            fault.get("description")
            or fault.get("faultDescription")
            or fault.get("message")
        ),
        "detected_at": fault.get("detected_at")
        or fault.get("detected")
        or fault.get("first_seen_at")
        or fault.get("timestamp"),
        "hostname": _clean(fault.get("hostname") or fault.get("host")),
        "status": _clean(fault.get("status")),
        "recovery_action": _clean(
            fault.get("recovery_action")
            or fault.get("recoveryAction")
            or fault.get("action")
        ),
        "previous_value": _clean(
            fault.get("previous_value") or fault.get("previousValue")
        ),
        "verified_at": fault.get("verified_at") or fault.get("verifiedAt"),
    }


# ---------------------------------------------------------------------------
# Provider send
# ---------------------------------------------------------------------------


def _sanitize_provider_response(raw: Any) -> str:
    text = str(raw or "")
    # Strip anything that looks like a bearer token if somehow echoed.
    text = re.sub(r"Bearer\s+[A-Za-z0-9._\-]+", "Bearer ***", text, flags=re.I)
    token = (os.environ.get("WHATSAPP_API_TOKEN") or "").strip()
    if token and token in text:
        text = text.replace(token, "***")
    return text[:2000]


def _send_meta(cfg: dict[str, Any], body_text: str) -> dict[str, Any]:
    phone_id = cfg["phone_number_id"]
    version = cfg["api_version"]
    url = f"https://graph.facebook.com/{version}/{phone_id}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": cfg["_recipient"],
        "type": "text",
        "text": {"preview_url": False, "body": body_text},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {cfg['_token']}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return {
                "ok": 200 <= resp.status < 300,
                "status_code": resp.status,
                "response": _sanitize_provider_response(raw),
            }
    except urllib.error.HTTPError as exc:
        err_body = ""
        try:
            err_body = exc.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        return {
            "ok": False,
            "status_code": exc.code,
            "response": _sanitize_provider_response(err_body or str(exc)),
            "error": f"HTTP {exc.code}",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "status_code": None,
            "response": None,
            "error": _sanitize_provider_response(str(exc)),
        }


def _send_log(cfg: dict[str, Any], body_text: str) -> dict[str, Any]:
    # Safe test provider — logs message only (no credentials).
    logger.info(
        "WhatsApp LOG provider → recipient=%s\n%s",
        cfg.get("recipient_masked") or "(unset)",
        body_text,
    )
    return {
        "ok": True,
        "status_code": 200,
        "response": json.dumps({"provider": "log", "accepted": True}),
    }


def send_whatsapp_message(body_text: str) -> dict[str, Any]:
    cfg = get_whatsapp_config()
    if not cfg["enabled"] or not cfg["configured"]:
        logger.info("WhatsApp notifications disabled/not configured")
        return {
            "ok": False,
            "skipped": True,
            "status": "disabled",
            "message": "WhatsApp notifications disabled/not configured",
        }

    if cfg["provider"] == "log":
        result = _send_log(cfg, body_text)
    elif cfg["provider"] == "meta":
        result = _send_meta(cfg, body_text)
    else:
        logger.warning("Unknown WHATSAPP_PROVIDER=%s", cfg["provider"])
        return {
            "ok": False,
            "skipped": True,
            "status": "disabled",
            "message": "WhatsApp notifications disabled/not configured",
        }

    if not result.get("ok"):
        logger.error(
            "WhatsApp send failed (provider=%s, error=%s)",
            cfg["provider"],
            result.get("error") or result.get("response"),
        )
    return {
        "ok": bool(result.get("ok")),
        "skipped": False,
        "status": "sent" if result.get("ok") else "failed",
        "provider": cfg["provider"],
        "recipient_masked": cfg.get("recipient_masked"),
        "provider_response": result.get("response"),
        "error": result.get("error"),
        "status_code": result.get("status_code"),
    }


# ---------------------------------------------------------------------------
# Deduped notify API
# ---------------------------------------------------------------------------


def _persist_event(
    *,
    fault_id: str,
    notification_type: str,
    send_status: str,
    recipient_masked: Optional[str],
    provider: Optional[str],
    provider_response: Optional[str],
    error: Optional[str],
    payload_summary: dict[str, Any],
    hostname: Optional[str],
) -> None:
    if telemetry_db is None:
        return
    try:
        telemetry_db.insert_notification_event(
            {
                "fault_id": fault_id,
                "notification_type": notification_type,
                "recipient_masked": recipient_masked,
                "timestamp": time.time(),
                "send_status": send_status,
                "provider": provider,
                "provider_response": provider_response,
                "error": error,
                "payload_summary": payload_summary,
                "hostname": hostname,
            }
        )
    except Exception:
        logger.exception("Failed to persist WhatsApp notification event")


def notify_critical_fault(payload: dict[str, Any]) -> dict[str, Any]:
    """Send critical alert once per active fault_id until recovered."""
    fault = _normalize_fault(payload)
    fault_id = fault.get("fault_id")
    if not fault_id:
        return {"ok": False, "status": "invalid", "message": "fault_id required"}

    severity = fault.get("severity") or ""
    if severity not in ("critical",):
        return {
            "ok": True,
            "status": "ignored",
            "message": "Only CRITICAL faults trigger WhatsApp alerts",
        }

    cfg = get_whatsapp_config()
    if not cfg["enabled"] or not cfg["configured"]:
        logger.info("WhatsApp notifications disabled/not configured")
        return {
            "ok": True,
            "status": "disabled",
            "message": "WhatsApp notifications disabled/not configured",
        }

    with _lock:
        open_alert = None
        if telemetry_db is not None:
            try:
                open_alert = telemetry_db.get_open_notification_alert(fault_id)
            except Exception:
                logger.exception("Failed to read open notification alert")

        if open_alert:
            return {
                "ok": True,
                "status": "duplicate",
                "message": "Critical alert already sent for this active fault",
                "fault_id": fault_id,
            }

        body = build_critical_message(fault)
        result = send_whatsapp_message(body)
        status = result.get("status") or ("sent" if result.get("ok") else "failed")

        _persist_event(
            fault_id=fault_id,
            notification_type="critical_alert",
            send_status=status,
            recipient_masked=result.get("recipient_masked") or cfg.get("recipient_masked"),
            provider=result.get("provider") or cfg.get("provider"),
            provider_response=result.get("provider_response"),
            error=result.get("error"),
            payload_summary={
                "component": fault.get("component"),
                "metric": fault.get("metric_name"),
                "current": fault.get("current_value"),
                "threshold": fault.get("threshold_crossed"),
            },
            hostname=fault.get("hostname"),
        )

        # Only lock the open-alert slot when send succeeded — allows safe retry.
        if result.get("ok") and telemetry_db is not None:
            try:
                telemetry_db.upsert_open_notification_alert(
                    fault_id=fault_id,
                    snapshot=fault,
                )
            except Exception:
                logger.exception("Failed to record open WhatsApp alert")

        return {
            "ok": bool(result.get("ok") or result.get("skipped")),
            "status": status,
            "fault_id": fault_id,
            "message": result.get("message"),
        }


def notify_recovery_fault(payload: dict[str, Any]) -> dict[str, Any]:
    """Send recovery message only if a critical WhatsApp alert was previously sent."""
    fault = _normalize_fault(payload)
    fault_id = fault.get("fault_id")
    if not fault_id:
        return {"ok": False, "status": "invalid", "message": "fault_id required"}

    cfg = get_whatsapp_config()
    with _lock:
        open_alert = None
        if telemetry_db is not None:
            try:
                open_alert = telemetry_db.get_open_notification_alert(fault_id)
            except Exception:
                logger.exception("Failed to read open notification alert")

        if not open_alert:
            return {
                "ok": True,
                "status": "skipped",
                "message": "No prior WhatsApp critical alert for this fault",
                "fault_id": fault_id,
            }

        if not cfg["enabled"] or not cfg["configured"]:
            logger.info("WhatsApp notifications disabled/not configured")
            if telemetry_db is not None:
                try:
                    telemetry_db.clear_open_notification_alert(fault_id)
                except Exception:
                    pass
            return {
                "ok": True,
                "status": "disabled",
                "message": "WhatsApp notifications disabled/not configured",
            }

        prior = open_alert.get("snapshot") or {}
        body = build_recovery_message(fault, prior)
        result = send_whatsapp_message(body)
        status = result.get("status") or ("sent" if result.get("ok") else "failed")

        _persist_event(
            fault_id=fault_id,
            notification_type="recovery",
            send_status=status,
            recipient_masked=result.get("recipient_masked") or cfg.get("recipient_masked"),
            provider=result.get("provider") or cfg.get("provider"),
            provider_response=result.get("provider_response"),
            error=result.get("error"),
            payload_summary={
                "component": fault.get("component") or prior.get("component"),
                "metric": fault.get("metric_name") or prior.get("metric_name"),
                "current": fault.get("current_value"),
                "previous": prior.get("current_value"),
            },
            hostname=fault.get("hostname") or prior.get("hostname"),
        )

        # Clear open alert on success so a later re-critical can alert again.
        # On failure keep open so a later recovery retry can still notify.
        if result.get("ok") and telemetry_db is not None:
            try:
                telemetry_db.clear_open_notification_alert(fault_id)
            except Exception:
                logger.exception("Failed to clear open WhatsApp alert")

        return {
            "ok": bool(result.get("ok") or result.get("skipped")),
            "status": status,
            "fault_id": fault_id,
            "message": result.get("message"),
        }


def handle_poll_critical_faults(
    critical_faults: list[dict[str, Any]],
    *,
    hostname: Optional[str] = None,
) -> None:
    """
    Called after each SQLite persist cycle with CURRENT critical health-summary
    faults. Sends new alerts and recovery messages when prior alerts clear.
    Failures never raise to the telemetry loop.
    """
    try:
        current_ids: set[str] = set()
        for raw in critical_faults or []:
            fault = dict(raw)
            if hostname and not fault.get("hostname"):
                fault["hostname"] = hostname
            # Ensure severity label is critical for notify gate
            if str(fault.get("severity") or "").lower() != "critical":
                fault["severity"] = "Critical"
            fid = fault.get("fault_id")
            if not fid:
                continue
            current_ids.add(fid)
            notify_critical_fault(fault)

        open_ids: list[str] = []
        if telemetry_db is not None:
            open_ids = telemetry_db.list_open_notification_alert_ids()

        for fid in open_ids:
            if fid in current_ids:
                continue
            # Only auto-recover backend cm-* faults from poll clearance.
            # Frontend threshold-* alerts are closed by the UI notify path.
            if not str(fid).startswith("cm-"):
                continue
            notify_recovery_fault(
                {
                    "fault_id": fid,
                    "hostname": hostname,
                    "status": "RECOVERED",
                    "verified_at": time.time(),
                }
            )
    except Exception:
        logger.exception("WhatsApp poll handler failed (telemetry unaffected)")


def get_public_status() -> dict[str, Any]:
    cfg = get_whatsapp_config()
    last = None
    if telemetry_db is not None:
        try:
            last = telemetry_db.get_last_notification_event()
        except Exception:
            last = None

    last_public = None
    if last:
        summary = last.get("payload_summary") or {}
        last_public = {
            "fault_id": last.get("fault_id"),
            "type": last.get("notification_type"),
            "status": last.get("send_status"),
            "component": summary.get("component"),
            "metric": summary.get("metric"),
            "timestamp": last.get("timestamp"),
            "timestamp_label": _format_detected(last.get("timestamp")),
        }

    return {
        "enabled": bool(cfg["enabled"] and cfg["configured"]),
        "configured": bool(cfg["configured"]),
        "provider": cfg["provider"] if cfg["configured"] else None,
        "recipient_masked": cfg.get("recipient_masked") if cfg["configured"] else None,
        "message": _config_status_message(cfg),
        "last_alert": last_public,
        # Explicitly never include tokens / phone ids / raw recipient
    }


# ---------------------------------------------------------------------------
# Flask routes
# ---------------------------------------------------------------------------


def register_whatsapp_routes(app, get_latest: Optional[Callable] = None) -> None:
    from flask import jsonify, request

    @app.route("/notifications/whatsapp/status", methods=["GET"])
    def whatsapp_status():
        return jsonify(get_public_status())

    @app.route("/notifications/whatsapp/critical", methods=["POST"])
    def whatsapp_critical():
        body = request.get_json(silent=True) or {}
        # Optionally enrich hostname from live cache
        if get_latest and not body.get("hostname"):
            try:
                metrics, inventory, _lh = get_latest()
                host = (
                    ((inventory or {}).get("system") or {}).get("hostname")
                    or ((metrics or {}).get("system") or {}).get("hostname")
                )
                if host:
                    body = {**body, "hostname": host}
            except Exception:
                pass
        result = notify_critical_fault(body)
        # Never fail the caller hard — alerting is advisory
        return jsonify(result), 200

    @app.route("/notifications/whatsapp/recovery", methods=["POST"])
    def whatsapp_recovery():
        body = request.get_json(silent=True) or {}
        result = notify_recovery_fault(body)
        return jsonify(result), 200

    @app.route("/notifications/whatsapp/history", methods=["GET"])
    def whatsapp_history():
        limit = request.args.get("limit", default=20, type=int)
        limit = max(1, min(limit, 100))
        rows = []
        if telemetry_db is not None:
            try:
                rows = telemetry_db.query_notification_events(limit=limit)
            except Exception as exc:  # noqa: BLE001
                logger.exception("Failed to query notification history")
                return jsonify({"events": [], "error": str(exc)}), 500
        # Strip anything sensitive (should already be clean)
        safe = []
        for row in rows:
            safe.append(
                {
                    "fault_id": row.get("fault_id"),
                    "notification_type": row.get("notification_type"),
                    "recipient_masked": row.get("recipient_masked"),
                    "timestamp": row.get("timestamp"),
                    "send_status": row.get("send_status"),
                    "provider": row.get("provider"),
                    "error": row.get("error"),
                    "payload_summary": row.get("payload_summary"),
                    "hostname": row.get("hostname"),
                }
            )
        return jsonify({"events": safe, "count": len(safe)})

    logger.info("WhatsApp notification routes registered")
