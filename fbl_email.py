"""
fbl_email.py
============
Email WARNING/CRITICAL notifications for FBL.

Invoked from the existing fault lifecycle after SQLite persist — not a second
detector, and not inlined SMTP inside the telemetry collector.

Environment (email.env or process env):
  EMAIL_ENABLED=true|false
  SMTP_HOST=smtp.gmail.com
  SMTP_PORT=587
  SMTP_USERNAME=...
  SMTP_PASSWORD=...          # app password; never logged
  EMAIL_FROM=...
  EMAIL_RECIPIENT=...
  SMTP_USE_TLS=true          # STARTTLS on 587; ignored when port is 465 (SSL)
"""

from __future__ import annotations

import html
import logging
import os
import re
import smtplib
import ssl
import threading
import time
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger("fbl_email")

try:
    import telemetry_db
except Exception:  # pragma: no cover
    telemetry_db = None  # type: ignore

_lock = threading.Lock()
_EMAIL_ENV_LOADED = False
_poll_bootstrapped = False


def load_email_env_file(path: Optional[str] = None) -> bool:
    """Load EMAIL_* / SMTP_* from email.env. Existing process env wins."""
    global _EMAIL_ENV_LOADED
    if _EMAIL_ENV_LOADED:
        return False

    candidates = []
    if path:
        candidates.append(Path(path))
    else:
        here = Path(__file__).resolve().parent
        candidates.extend(
            [
                here / "email.env",
                here / ".env.email",
                here / "email.env.example",
            ]
        )

    env_path = next((p for p in candidates if p.is_file()), None)
    if env_path is None:
        _EMAIL_ENV_LOADED = True
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
        if not (key.startswith("EMAIL_") or key.startswith("SMTP_")):
            continue
        if key in os.environ and os.environ.get(key):
            continue
        os.environ[key] = value
        loaded += 1

    _EMAIL_ENV_LOADED = True
    if loaded:
        logger.info("Loaded email notification config from %s (%s vars)", env_path.name, loaded)
    return loaded > 0


load_email_env_file()


def _env_bool(name: str, default: bool = False) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def mask_email(address: str) -> str:
    text = (address or "").strip()
    if "@" not in text:
        return "***" if text else ""
    local, _, domain = text.partition("@")
    if not local:
        return f"***@{domain}"
    return f"{local[0]}***@{domain}"


def _smtp_password() -> str:
    return (os.environ.get("SMTP_PASSWORD") or "").strip()


def get_email_config() -> dict[str, Any]:
    enabled = _env_bool("EMAIL_ENABLED", False)
    host = (os.environ.get("SMTP_HOST") or "").strip()
    try:
        port = int((os.environ.get("SMTP_PORT") or "587").strip() or "587")
    except ValueError:
        port = 587
    username = (os.environ.get("SMTP_USERNAME") or "").strip()
    password = _smtp_password()
    mail_from = (os.environ.get("EMAIL_FROM") or username).strip()
    recipient = (os.environ.get("EMAIL_RECIPIENT") or "").strip()
    use_tls = _env_bool("SMTP_USE_TLS", port != 465)

    configured = bool(enabled and host and port and username and password and mail_from and recipient)
    return {
        "enabled": enabled,
        "configured": configured,
        "smtp_host": host if configured else "",
        "smtp_port": port,
        "use_tls": use_tls,
        "username": username if configured else "",
        "mail_from": mail_from if configured else "",
        "recipient": recipient if configured else "",
        "recipient_masked": mask_email(recipient) if recipient else None,
        "_password": password if configured else "",
    }


def _config_status_message(cfg: dict[str, Any]) -> str:
    if not cfg["enabled"] or not cfg["configured"]:
        return "Email notifications disabled/not configured"
    return "Email notifications enabled"


def _clean(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.lower() in ("null", "undefined", "n/a", "none", "—", "-"):
        return None
    return text


def _format_detected(ts: Any) -> Optional[str]:
    if ts is None:
        ts = time.time()
    try:
        if isinstance(ts, (int, float)):
            dt = datetime.fromtimestamp(float(ts))
        else:
            raw = str(ts).strip()
            if raw.endswith("Z"):
                raw = raw[:-1] + "+00:00"
            dt = datetime.fromisoformat(raw)
            if dt.tzinfo is not None:
                dt = dt.astimezone()
        return dt.strftime("%d %b %Y, %H:%M")
    except Exception:
        return _clean(ts)


def _alert_severity(value: Any) -> Optional[str]:
    text = (_clean(value) or "").lower()
    if text in ("warning", "warn"):
        return "warning"
    if text in ("critical", "crit"):
        return "critical"
    return None


def _normalize_fault(payload: dict[str, Any]) -> dict[str, Any]:
    fault = dict(payload or {})
    return {
        "fault_id": _clean(fault.get("fault_id") or fault.get("faultId") or fault.get("id")),
        "severity": _alert_severity(fault.get("severity")),
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
    }


def _threshold_label(severity: str) -> str:
    return "Warning Threshold" if severity == "warning" else "Critical Threshold"


def build_email_subject(fault: dict[str, Any]) -> str:
    severity = fault.get("severity") or "critical"
    metric = fault.get("metric_name") or fault.get("component") or "Alert"
    if severity == "warning":
        return f"⚠️ FBL WARNING — {metric}"
    return f"🚨 FBL CRITICAL — {metric}"


def build_email_text(fault: dict[str, Any]) -> str:
    severity = fault.get("severity") or "critical"
    heading = "FBL WARNING" if severity == "warning" else "FBL CRITICAL ALERT"
    status = "WARNING" if severity == "warning" else "CRITICAL"
    lines = [heading, ""]
    pairs = [
        ("Component", fault.get("component")),
        ("Metric", fault.get("metric_name")),
        ("Current Value", fault.get("current_value")),
        (_threshold_label(severity), fault.get("threshold_crossed")),
        ("Status", status),
        ("Detected", _format_detected(fault.get("detected_at"))),
        ("Fault ID", fault.get("fault_id")),
    ]
    for label, value in pairs:
        if value:
            lines.append(f"{label}: {value}")
    if fault.get("description"):
        lines.append("")
        lines.append("Description:")
        lines.append(fault["description"])
    return "\n".join(lines)


def build_email_html(fault: dict[str, Any]) -> str:
    severity = fault.get("severity") or "critical"
    is_crit = severity == "critical"
    status = "CRITICAL" if is_crit else "WARNING"
    accent = "#b71c1c" if is_crit else "#e65100"
    title = "CRITICAL ALERT" if is_crit else "WARNING"
    icon = "🚨" if is_crit else "⚠️"

    rows = []
    for label, value in [
        ("Component", fault.get("component")),
        ("Metric", fault.get("metric_name")),
        ("Current", fault.get("current_value")),
        ("Threshold", fault.get("threshold_crossed")),
        ("Status", status),
        ("Fault ID", fault.get("fault_id")),
        ("Detected", _format_detected(fault.get("detected_at"))),
    ]:
        if not value:
            continue
        rows.append(
            "<tr>"
            f'<td style="padding:6px 0;color:#64748b;font-size:13px;width:120px;vertical-align:top;">{html.escape(label)}</td>'
            f'<td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600;">{html.escape(str(value))}</td>'
            "</tr>"
        )
    desc = ""
    if fault.get("description"):
        desc = (
            '<tr><td colspan="2" style="padding-top:12px;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;">Description</td></tr>'
            f'<tr><td colspan="2" style="padding:4px 0 0;color:#334155;font-size:13px;line-height:1.5;">{html.escape(fault["description"])}</td></tr>'
        )

    return f"""<!DOCTYPE html>
<html><body style="margin:0;padding:16px;background:#e8eef4;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d5dee8;border-radius:8px;overflow:hidden;">
    <tr>
      <td style="background:#003366;padding:16px 20px;color:#ffffff;">
        <div style="font-size:20px;font-weight:700;letter-spacing:0.08em;">FBL</div>
        <div style="font-size:12px;opacity:0.85;margin-top:2px;">Framework Block Ledger</div>
      </td>
    </tr>
    <tr>
      <td style="padding:8px 20px;background:{accent};color:#ffffff;font-size:15px;font-weight:700;">
        {icon} {html.escape(title)}
      </td>
    </tr>
    <tr>
      <td style="padding:18px 20px 22px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          {''.join(rows)}
          {desc}
        </table>
      </td>
    </tr>
  </table>
</body></html>"""


def _sanitize_error(exc: BaseException, cfg: dict[str, Any]) -> str:
    text = str(exc)
    password = cfg.get("_password") or _smtp_password()
    if password:
        text = text.replace(password, "***")
    username = cfg.get("username") or ""
    if username:
        text = text.replace(username, mask_email(username) or "***")
    return text[:500]


def send_email(subject: str, text_body: str, html_body: str) -> dict[str, Any]:
    cfg = get_email_config()
    if not cfg["enabled"] or not cfg["configured"]:
        logger.info("Email notifications disabled/not configured")
        return {
            "ok": False,
            "skipped": True,
            "status": "disabled",
            "message": "Email notifications disabled/not configured",
        }

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = cfg["mail_from"]
    msg["To"] = cfg["recipient"]
    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")

    host = cfg["smtp_host"]
    port = int(cfg["smtp_port"])
    try:
        context = ssl.create_default_context()
        if port == 465:
            with smtplib.SMTP_SSL(host, port, timeout=20, context=context) as smtp:
                smtp.login(cfg["username"], cfg["_password"])
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=20) as smtp:
                smtp.ehlo()
                if cfg.get("use_tls", True):
                    smtp.starttls(context=context)
                    smtp.ehlo()
                smtp.login(cfg["username"], cfg["_password"])
                smtp.send_message(msg)
        return {
            "ok": True,
            "skipped": False,
            "status": "sent",
            "recipient_masked": cfg.get("recipient_masked"),
        }
    except Exception as exc:  # noqa: BLE001
        err = _sanitize_error(exc, cfg)
        logger.error("Email notification failed: %s", err)
        return {
            "ok": False,
            "skipped": False,
            "status": "failed",
            "error": err,
            "recipient_masked": cfg.get("recipient_masked"),
        }


def _persist_event(
    *,
    fault_id: str,
    notification_type: str,
    send_status: str,
    recipient_masked: Optional[str],
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
                "provider": "smtp",
                "provider_response": None,
                "error": error,
                "payload_summary": payload_summary,
                "hostname": hostname,
            }
        )
    except Exception:
        logger.exception("Failed to persist email notification event")


def _record_severity_state(fault_id: str, severity: str, snapshot: dict[str, Any]) -> None:
    if telemetry_db is None:
        return
    try:
        telemetry_db.upsert_notification_severity_state(fault_id, severity, snapshot)
        telemetry_db.upsert_open_notification_alert(fault_id, snapshot)
    except Exception:
        logger.exception("Failed to record email notification state")


def _clear_severity_state(fault_id: str) -> None:
    if telemetry_db is None:
        return
    try:
        telemetry_db.clear_notification_severity_state(fault_id)
        telemetry_db.clear_open_notification_alert(fault_id)
    except Exception:
        logger.exception("Failed to clear email notification state")


def notify_alert_fault(payload: dict[str, Any]) -> dict[str, Any]:
    """Send exactly one email per fault_id + severity until recovered."""
    fault = _normalize_fault(payload)
    fault_id = fault.get("fault_id")
    if not fault_id:
        return {"ok": False, "status": "invalid", "message": "fault_id required"}

    severity = fault.get("severity")
    if severity not in ("warning", "critical"):
        return {
            "ok": True,
            "status": "ignored",
            "message": "Only WARNING and CRITICAL faults trigger email alerts",
        }

    cfg = get_email_config()
    if not cfg["enabled"] or not cfg["configured"]:
        logger.info("Email notifications disabled/not configured")
        return {
            "ok": True,
            "status": "disabled",
            "message": "Email notifications disabled/not configured",
        }

    with _lock:
        already = None
        if telemetry_db is not None:
            try:
                already = telemetry_db.get_notification_severity_state(fault_id, severity)
            except Exception:
                logger.exception("Failed to read email notification state")

        if already:
            return {
                "ok": True,
                "status": "duplicate",
                "message": f"{severity.upper()} email already sent for this active fault",
                "fault_id": fault_id,
            }

        result = send_email(
            build_email_subject(fault),
            build_email_text(fault),
            build_email_html(fault),
        )
        status = result.get("status") or ("sent" if result.get("ok") else "failed")

        if not result.get("ok"):
            logger.error("Email notification failed for %s", fault_id)

        _persist_event(
            fault_id=fault_id,
            notification_type=f"{severity}_alert",
            send_status=status,
            recipient_masked=result.get("recipient_masked") or cfg.get("recipient_masked"),
            error=result.get("error"),
            payload_summary={
                "component": fault.get("component"),
                "metric": fault.get("metric_name"),
                "current": fault.get("current_value"),
                "threshold": fault.get("threshold_crossed"),
                "severity": severity,
            },
            hostname=fault.get("hostname"),
        )

        if result.get("ok"):
            _record_severity_state(fault_id, severity, fault)

        return {
            "ok": bool(result.get("ok") or result.get("skipped")),
            "status": status,
            "fault_id": fault_id,
            "message": result.get("message"),
        }


def notify_recovery_fault(payload: dict[str, Any]) -> dict[str, Any]:
    """Reset notification state after verified recovery. Does not send email."""
    fault = _normalize_fault(payload)
    fault_id = fault.get("fault_id")
    if not fault_id:
        return {"ok": False, "status": "invalid", "message": "fault_id required"}

    with _lock:
        had_state = False
        if telemetry_db is not None:
            try:
                states = telemetry_db.list_notification_severity_states()
                had_state = any(s.get("fault_id") == fault_id for s in states)
                if not had_state:
                    had_state = bool(telemetry_db.get_open_notification_alert(fault_id))
            except Exception:
                logger.exception("Failed to read email notification state")

        if not had_state:
            return {
                "ok": True,
                "status": "skipped",
                "message": "No prior email alert for this fault",
                "fault_id": fault_id,
            }

        _clear_severity_state(fault_id)
        return {
            "ok": True,
            "status": "reset",
            "fault_id": fault_id,
            "message": "Email notification state reset",
        }


def _seed_existing_alerts(active: list[dict[str, Any]]) -> None:
    """Mark currently active faults as already-notified so a restart does not burst."""
    for fault in active:
        fault_id = fault.get("fault_id")
        severity = _alert_severity(fault.get("severity"))
        if not fault_id or severity not in ("warning", "critical"):
            continue
        if telemetry_db is None:
            continue
        try:
            if telemetry_db.get_notification_severity_state(fault_id, severity):
                continue
            _record_severity_state(fault_id, severity, fault)
        except Exception:
            logger.exception("Failed to seed email notification state")


def handle_poll_alert_faults(
    alert_faults: list[dict[str, Any]],
    *,
    hostname: Optional[str] = None,
) -> None:
    """
    Called after each SQLite persist with CURRENT warning/critical faults.
    Failures never raise into telemetry collection.
    """
    global _poll_bootstrapped
    try:
        current_ids: set[str] = set()
        active: list[dict[str, Any]] = []
        for raw in alert_faults or []:
            fault = dict(raw)
            if hostname and not fault.get("hostname"):
                fault["hostname"] = hostname
            severity = _alert_severity(fault.get("severity"))
            if severity not in ("warning", "critical"):
                continue
            fault["severity"] = "Warning" if severity == "warning" else "Critical"
            fid = fault.get("fault_id")
            if not fid:
                continue
            current_ids.add(fid)
            active.append(fault)

        if not _poll_bootstrapped:
            with _lock:
                _seed_existing_alerts(active)
                _poll_bootstrapped = True
            return

        for fault in active:
            notify_alert_fault(fault)

        open_ids: set[str] = set()
        if telemetry_db is not None:
            try:
                for row in telemetry_db.list_notification_severity_states():
                    if row.get("fault_id"):
                        open_ids.add(row["fault_id"])
                for fid in telemetry_db.list_open_notification_alert_ids():
                    open_ids.add(fid)
            except Exception:
                logger.exception("Failed to list email notification state")

        for fid in open_ids:
            if fid in current_ids:
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
        logger.exception("Email poll handler failed (telemetry unaffected)")


def get_public_status() -> dict[str, Any]:
    cfg = get_email_config()
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

    missing = []
    if not _env_bool("EMAIL_ENABLED", False):
        missing.append("EMAIL_ENABLED")
    if not (os.environ.get("SMTP_HOST") or "").strip():
        missing.append("SMTP_HOST")
    if not (os.environ.get("SMTP_USERNAME") or "").strip():
        missing.append("SMTP_USERNAME")
    if not _smtp_password():
        missing.append("SMTP_PASSWORD")
    if not (os.environ.get("EMAIL_RECIPIENT") or os.environ.get("EMAIL_FROM") or "").strip():
        missing.append("EMAIL_RECIPIENT")

    return {
        "enabled": bool(cfg["enabled"] and cfg["configured"]),
        "configured": bool(cfg["configured"]),
        "channel": "email" if cfg["configured"] else None,
        "recipient_masked": cfg.get("recipient_masked") if cfg["configured"] else None,
        "smtp_host": (os.environ.get("SMTP_HOST") or "").strip() or None,
        "missing": missing,
        "message": _config_status_message(cfg),
        "last_alert": last_public,
    }


def register_email_routes(app, get_latest: Optional[Callable] = None) -> None:
    from flask import jsonify, request

    @app.route("/notifications/email/status", methods=["GET"])
    def email_status():
        return jsonify(get_public_status())

    @app.route("/notifications/email/test", methods=["POST", "GET"])
    def email_test():
        """Send one diagnostic email. Does not use fault detection."""
        cfg = get_email_config()
        if not cfg["enabled"] or not cfg["configured"]:
            return jsonify(get_public_status()), 200
        fault = {
            "fault_id": "email-test",
            "severity": "warning",
            "component": "FBL",
            "metric_name": "Email diagnostic",
            "current_value": "test",
            "description": "Manual SMTP test from FBL. If you received this, email delivery works.",
        }
        result = send_email(
            "FBL email diagnostic",
            build_email_text(fault),
            build_email_html(fault),
        )
        public = get_public_status()
        public["test"] = {
            "status": result.get("status"),
            "error": result.get("error"),
            "recipient_masked": result.get("recipient_masked") or cfg.get("recipient_masked"),
        }
        return jsonify(public), 200

    @app.route("/notifications/email/history", methods=["GET"])
    def email_history():
        limit = request.args.get("limit", default=20, type=int)
        limit = max(1, min(limit, 100))
        rows = []
        if telemetry_db is not None:
            try:
                rows = telemetry_db.query_notification_events(limit=limit)
            except Exception as exc:  # noqa: BLE001
                logger.exception("Failed to query notification history")
                return jsonify({"events": [], "error": str(exc)}), 500
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

    logger.info("Email notification routes registered")
