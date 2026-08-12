#!/usr/bin/env python3
"""
digital_twin_learning.py
=========================

Prediction-vs-actual learning for the Digital Twin.

This module is intentionally NOT machine learning. It's a transparent,
auditable statistical tracker: every time a simulated action is later
actually taken (via digital_twin_execution.py) and the real result is
measured, we record both the PREDICTED and ACTUAL numbers, compute the
signed error, and persist it append-only as JSONL. Historical error per
(process_name, action, domain) bucket is then used to produce a
confidence ADJUSTMENT -- e.g. "predictions for terminating 'stress-ng'
have historically overestimated CPU relief by 8pp on average, so trust
this prediction a bit less."

Nothing in this module executes anything or collects live system state
itself -- it only records and analyzes numbers handed to it by the
caller (typically: a DigitalTwin SimulationResult before, and a fresh
collect_current_state() after, a real execution).
"""

from __future__ import annotations

import json
import os
import statistics
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Optional

DEFAULT_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "digital_twin_predictions.jsonl")


@dataclass
class PredictionRecord:
    timestamp: str
    action: str
    domain: str
    pid: Optional[int]
    process_name: Optional[str]

    predicted_metrics: dict[str, Any]
    actual_metrics: dict[str, Any]

    # signed_error[metric] = actual - predicted (so positive means the
    # real outcome was BIGGER/worse than predicted, negative means the
    # real outcome was smaller/better than predicted -- the sign is
    # meaningful and deliberately preserved, never absolute-valued here).
    signed_error: dict[str, float] = field(default_factory=dict)

    notes: str = ""

    def to_json_line(self) -> str:
        return json.dumps(asdict(self), sort_keys=True)

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "PredictionRecord":
        return PredictionRecord(
            timestamp=d["timestamp"],
            action=d["action"],
            domain=d.get("domain", "process"),
            pid=d.get("pid"),
            process_name=d.get("process_name"),
            predicted_metrics=d.get("predicted_metrics", {}),
            actual_metrics=d.get("actual_metrics", {}),
            signed_error=d.get("signed_error", {}),
            notes=d.get("notes", ""),
        )


def _compute_signed_error(predicted: dict[str, Any], actual: dict[str, Any]) -> dict[str, float]:
    """Only compares keys present as numbers in BOTH dicts -- never
    invents a comparison for a metric one side doesn't have."""
    errors: dict[str, float] = {}
    for key, pred_val in predicted.items():
        if not isinstance(pred_val, (int, float)):
            continue
        act_val = actual.get(key)
        if not isinstance(act_val, (int, float)):
            continue
        errors[key] = round(float(act_val) - float(pred_val), 4)
    return errors


def record_prediction(
    action: str,
    domain: str,
    predicted_metrics: dict[str, Any],
    actual_metrics: dict[str, Any],
    pid: Optional[int] = None,
    process_name: Optional[str] = None,
    notes: str = "",
    log_path: str = DEFAULT_LOG_PATH,
) -> PredictionRecord:
    """Build a PredictionRecord, compute its signed error, and append it
    (one JSON object per line) to log_path. Append-only: this function
    never rewrites or deletes existing lines."""
    record = PredictionRecord(
        timestamp=datetime.now(timezone.utc).isoformat(),
        action=action,
        domain=domain,
        pid=pid,
        process_name=process_name,
        predicted_metrics=predicted_metrics,
        actual_metrics=actual_metrics,
        signed_error=_compute_signed_error(predicted_metrics, actual_metrics),
        notes=notes,
    )
    with open(log_path, "a") as fh:
        fh.write(record.to_json_line() + "\n")
    return record


def load_predictions(log_path: str = DEFAULT_LOG_PATH) -> list[PredictionRecord]:
    """Read all records. Skips (does not crash on) any malformed line,
    since this is an append-only log that may have been touched by
    multiple processes/crashed mid-write."""
    if not os.path.exists(log_path):
        return []
    records: list[PredictionRecord] = []
    with open(log_path, "r") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(PredictionRecord.from_dict(json.loads(line)))
            except (json.JSONDecodeError, KeyError):
                continue
    return records


def historical_error_stats(
    process_name: Optional[str],
    action: str,
    domain: str,
    metric: str,
    log_path: str = DEFAULT_LOG_PATH,
    max_records: int = 200,
) -> dict[str, Any]:
    """Mean/mean-absolute signed error for this (process_name, action,
    domain, metric) bucket, over the most recent max_records matching
    entries. Returns sample_size=0 rather than fabricating a value when
    there's no history yet -- that's the caller's signal to fall back to
    the default (no-history) confidence."""
    records = [
        r for r in load_predictions(log_path)
        if r.action == action and r.domain == domain
        and (process_name is None or r.process_name == process_name)
        and metric in r.signed_error
    ]
    records = records[-max_records:]
    if not records:
        return {"sample_size": 0, "mean_error": None, "mean_abs_error": None}

    errors = [r.signed_error[metric] for r in records]
    return {
        "sample_size": len(errors),
        "mean_error": round(statistics.mean(errors), 4),
        "mean_abs_error": round(statistics.mean(abs(e) for e in errors), 4),
        "stdev_error": round(statistics.pstdev(errors), 4) if len(errors) > 1 else 0.0,
    }


def confidence_adjustment(
    process_name: Optional[str],
    action: str,
    domain: str,
    metric: str,
    log_path: str = DEFAULT_LOG_PATH,
) -> float:
    """Turn historical mean-absolute-error into a confidence multiplier
    in [0.5, 1.0]. No history at all -> 1.0 (no penalty, but also no
    boost -- absence of data is not evidence of accuracy). Large,
    consistent absolute error -> pulled down toward 0.5. This is a
    simple, transparent, monotonic function -- not a fitted model -- by
    design (see module docstring: "do not over-engineer ML")."""
    stats = historical_error_stats(process_name, action, domain, metric, log_path)
    if stats["sample_size"] == 0:
        return 1.0
    mae = stats["mean_abs_error"] or 0.0
    # 0 error -> multiplier 1.0; every 10 units of MAE knocks off 0.1,
    # floored at 0.5. "units" are whatever scale `metric` is already in
    # (e.g. percentage points), so this is deliberately coarse.
    penalty = min(0.5, (mae / 10.0) * 0.1)
    return round(1.0 - penalty, 3)


if __name__ == "__main__":
    recs = load_predictions()
    print(f"{len(recs)} prediction record(s) at {DEFAULT_LOG_PATH}")
    for r in recs[-5:]:
        print(f"  {r.timestamp}  {r.domain}/{r.action}  pid={r.pid} ({r.process_name})  error={r.signed_error}")
