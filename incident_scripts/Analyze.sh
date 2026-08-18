#!/usr/bin/env bash
# FBL Analyze.sh — CPU, memory, storage, disk latency, filesystem.
# Output is written under ${FBL_INCIDENT_OUTPUT:-/tmp}.
set -euo pipefail
OUT_ROOT="${FBL_INCIDENT_OUTPUT:-/tmp}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="${OUT_ROOT}/fbl_analyze_${STAMP}.txt"
{
  echo "Analyze System Health"
  echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Host: $(hostname)"
  echo
  echo "=== CPU ==="
  if command -v uptime >/dev/null 2>&1; then uptime; fi
  if [[ -r /proc/loadavg ]]; then echo "loadavg: $(cat /proc/loadavg)"; fi
  if command -v mpstat >/dev/null 2>&1; then mpstat 1 1 2>/dev/null || true; fi
  echo
  echo "=== Memory ==="
  if command -v free >/dev/null 2>&1; then free -h; fi
  echo
  echo "=== Top memory consumers ==="
  ps -eo pid,user,%mem,%cpu,comm --sort=-%mem 2>/dev/null | head -n 16 || true
  echo
  echo "=== Storage devices ==="
  lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT 2>/dev/null || true
  echo
  echo "=== Disk latency (iostat if present) ==="
  if command -v iostat >/dev/null 2>&1; then iostat -xz 1 2 2>/dev/null || true; else echo "iostat unavailable"; fi
  echo
  echo "=== Filesystem ==="
  df -hT 2>/dev/null | head -n 30 || true
  echo "Completed: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Output: ${OUT}"
} | tee "${OUT}"
