#!/usr/bin/env bash
# FBL ForensicV1.sh — point-in-time process + limited infrastructure snapshot.
# Avoids dumping sensitive files (/etc/shadow, ssh keys, full filesystem walks).
set -euo pipefail
OUT_ROOT="${FBL_INCIDENT_OUTPUT:-/tmp}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="${OUT_ROOT}/fbl_forensic_${STAMP}.txt"
{
  echo "Forensic Process & Infrastructure Capture"
  echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Host: $(hostname)"
  echo
  echo "=== Processes (pid, state, cpu, mem, command) ==="
  ps -eo pid,state,pcpu,pmem,user,comm,args --sort=-pcpu 2>/dev/null | head -n 200 || true
  echo
  echo "=== Infrastructure (non-sensitive) ==="
  uname -a 2>/dev/null || true
  echo "uptime: $(uptime 2>/dev/null || true)"
  echo
  echo "=== Memory summary ==="
  free -h 2>/dev/null || true
  echo
  echo "=== Disk summary ==="
  df -h 2>/dev/null | head -n 20 || true
  echo "Output: ${OUT}"
  echo "Completed: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "${OUT}"
