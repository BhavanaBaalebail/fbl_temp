#!/usr/bin/env python3
"""
digital_twin_execution.py
==========================

The ONLY module in this project allowed to perform REAL recovery
actions against the live machine. digital_twin.py (the simulator) never
imports this module in any way that causes execution, and this module
is OFF by default -- nothing here runs unless a caller explicitly
constructs an ExecutionRequest, gets it approved, and calls execute().

Real execution for process actions is also available through CM.py
POST /digital_twin/execute (approval-gated, reuses RECOVERY_ACTIONS).
This module remains OFF by default -- nothing here runs unless a caller
explicitly constructs an ExecutionRequest, gets it approved, and calls execute().

SAFETY MODEL
------------
Before sending any real signal to a PID, this module:

  1. verifies the PID currently exists
  2. verifies the process identity (name) still matches what the caller
     observed when they decided to act
  3. verifies the process's create_time() fingerprint still matches --
     this is the actual defense against PID reuse: if PID 4821 was
     "slow-leak.py" five minutes ago and is now a brand new unrelated
     process the kernel happened to reassign that number to, the
     create_time() will differ and execution is refused
  4. verifies the process is still alive / in the expected status where
     relevant (e.g. refuses to "resume" a PID that isn't actually
     stopped)
  5. verifies explicit human approval was supplied (ApprovalToken)
  6. only then sends the real signal

Only this module may call os.kill() / send SIGSTOP/SIGCONT/SIGTERM/SIGKILL
(or platform equivalents) for recovery purposes anywhere in this project.
"""

from __future__ import annotations

import os
import signal
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

try:
    import psutil
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "digital_twin_execution.py requires the 'psutil' package.\n"
        "Install it with:  pip install psutil --break-system-packages"
    ) from exc


# ============================================================================
# Global off switch. Nothing executes unless this is explicitly flipped by
# the calling application AND every other check below also passes. This
# is a belt-and-suspenders guard on top of approval-gating, not a
# replacement for it.
# ============================================================================

EXECUTION_ENABLED = False


class ExecutionDisabledError(RuntimeError):
    """Raised whenever anything tries to execute while EXECUTION_ENABLED
    is False. This is the default state -- callers must opt in."""


class IdentityMismatchError(RuntimeError):
    """Raised when the PID's identity/fingerprint no longer matches what
    the caller observed -- almost certainly PID reuse. Execution is
    refused rather than risking signaling the wrong process."""


class ApprovalRequiredError(RuntimeError):
    """Raised when no valid, matching human approval was supplied."""


SIGNAL_MAP = {
    "kill": signal.SIGKILL,
    "terminate": signal.SIGTERM,
    "pause": signal.SIGSTOP,
    "resume": signal.SIGCONT,
}


@dataclass
class ProcessFingerprint:
    """Identity snapshot taken at DECISION time (e.g. when the Digital
    Twin simulation was generated / when the human looked at the
    dashboard). This is what execute() verifies against at ACT time."""
    pid: int
    name: Optional[str]
    create_time: float

    @classmethod
    def capture(cls, pid: int) -> "ProcessFingerprint":
        p = psutil.Process(pid)
        return cls(pid=pid, name=p.name(), create_time=p.create_time())


@dataclass
class ApprovalToken:
    """Explicit human approval for one specific action against one
    specific process. Must be supplied by the calling application's own
    approval-gate UI/flow -- this module does not itself decide what
    counts as 'a human approved this', it only refuses to proceed
    without one."""
    approved_by: str
    approved_at: str
    action: str
    pid: int
    acknowledged_risk: bool = False

    def matches(self, action: str, pid: int) -> bool:
        return (
            self.action == action
            and self.pid == pid
            and bool(self.approved_by)
            and self.acknowledged_risk
        )


@dataclass
class ExecutionRequest:
    action: str                       # one of SIGNAL_MAP keys
    pid: int
    fingerprint: ProcessFingerprint    # captured at decision time
    approval: ApprovalToken


@dataclass
class ExecutionResult:
    success: bool
    action: str
    pid: int
    signal_sent: Optional[str]
    message: str
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


def _verify_identity(req: ExecutionRequest) -> None:
    """Steps 1-4 of the safety model. Raises IdentityMismatchError or
    ProcessLookupError-style conditions rather than silently proceeding."""
    if req.action not in SIGNAL_MAP:
        raise ValueError(f"unknown action '{req.action}', expected one of {list(SIGNAL_MAP)}")

    if not psutil.pid_exists(req.pid):
        raise IdentityMismatchError(f"PID {req.pid} does not currently exist -- refusing to act")

    try:
        live = psutil.Process(req.pid)
        live_name = live.name()
        live_create_time = live.create_time()
        live_status = live.status()
    except (psutil.NoSuchProcess, psutil.ZombieProcess) as exc:
        raise IdentityMismatchError(f"PID {req.pid} vanished during verification: {exc}") from exc
    except psutil.AccessDenied as exc:
        raise IdentityMismatchError(f"PID {req.pid} could not be inspected (access denied): {exc}") from exc

    if req.fingerprint.pid != req.pid:
        raise IdentityMismatchError("fingerprint.pid does not match the requested pid -- request is inconsistent")

    if abs(live_create_time - req.fingerprint.create_time) > 0.5:
        raise IdentityMismatchError(
            f"PID {req.pid} create_time changed ({req.fingerprint.create_time} -> {live_create_time}); "
            f"this PID has almost certainly been reused by a different process since it was fingerprinted. "
            f"Refusing to act."
        )

    if req.fingerprint.name and live_name and req.fingerprint.name != live_name:
        raise IdentityMismatchError(
            f"PID {req.pid} name changed ('{req.fingerprint.name}' -> '{live_name}') since fingerprinting. "
            f"Refusing to act."
        )

    if req.action == "resume" and live_status != psutil.STATUS_STOPPED:
        raise IdentityMismatchError(
            f"PID {req.pid} is not currently STOPPED (status={live_status}) -- refusing to send SIGCONT "
            f"to a process that was never (or is no longer) paused"
        )

    # Never allow this module to be pointed at kernel/init or itself.
    if req.pid in (0, 1, 2) or req.pid == os.getpid():
        raise IdentityMismatchError(f"PID {req.pid} is a protected/self PID -- refusing to act")


def execute(req: ExecutionRequest) -> ExecutionResult:
    """The single real-execution entry point for the whole project.

    Order of operations (mirrors the safety model in the module
    docstring):
      1. EXECUTION_ENABLED must be True
      2. approval must be present and must match this exact action+pid
      3. PID identity/fingerprint must be re-verified right before acting
      4. only then: os.kill(pid, SIGNAL_MAP[action])
    """
    if not EXECUTION_ENABLED:
        raise ExecutionDisabledError(
            "digital_twin_execution.EXECUTION_ENABLED is False. This module is off by default; "
            "the calling application must explicitly enable it after its own safety review."
        )

    if not req.approval.matches(req.action, req.pid):
        raise ApprovalRequiredError(
            f"no valid ApprovalToken for action='{req.action}' pid={req.pid} -- refusing to execute"
        )

    _verify_identity(req)

    sig = SIGNAL_MAP[req.action]
    try:
        os.kill(req.pid, sig)
    except ProcessLookupError as exc:
        return ExecutionResult(
            success=False, action=req.action, pid=req.pid, signal_sent=sig.name,
            message=f"process vanished at the moment of signaling: {exc}",
        )
    except PermissionError as exc:
        return ExecutionResult(
            success=False, action=req.action, pid=req.pid, signal_sent=sig.name,
            message=f"permission denied sending {sig.name} to PID {req.pid}: {exc}",
        )

    return ExecutionResult(
        success=True, action=req.action, pid=req.pid, signal_sent=sig.name,
        message=f"sent {sig.name} to PID {req.pid} ({req.fingerprint.name}) after identity+approval verification",
    )


def build_request(action: str, pid: int, approved_by: str) -> ExecutionRequest:
    """Convenience helper: fingerprint the PID right now and build an
    ExecutionRequest with a matching approval token. This still requires
    EXECUTION_ENABLED=True and does not itself execute anything -- call
    execute() separately once you're ready."""
    fingerprint = ProcessFingerprint.capture(pid)
    approval = ApprovalToken(
        approved_by=approved_by,
        approved_at=datetime.now(timezone.utc).isoformat(),
        action=action,
        pid=pid,
        acknowledged_risk=True,
    )
    return ExecutionRequest(action=action, pid=pid, fingerprint=fingerprint, approval=approval)


if __name__ == "__main__":
    print(__doc__)
    print(f"EXECUTION_ENABLED = {EXECUTION_ENABLED}")
    print("This module performs no action when run directly.")
