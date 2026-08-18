#!/usr/bin/env bash
# FBL Stall_Capture_setup.sh — prepare stall evidence capture.
# Does not configure passwordless sudo. Root may be required to install
# a persistent stall probe on the host; this script only snapshots what
# the current user can read.
set -euo pipefail
OUT_ROOT="${FBL_INCIDENT_OUTPUT:-/tmp}"
STAMP="$(date +%Y%m%d_%H%M%S)"
DIR="${OUT_ROOT}/fbl_stall_${STAMP}"
mkdir -p "${DIR}"
{
  echo "Stall Capture Setup"
  echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Evidence directory: ${DIR}"
  echo
  echo "=== Load / blocked tasks ==="
  [[ -r /proc/loadavg ]] && cat /proc/loadavg
  ps -eo pid,state,wchan:32,pcpu,comm --sort=state 2>/dev/null | awk 'NR==1 || $2=="D" || $2=="R"' | head -n 80 || true
  echo
  echo "=== Optional: analyze_stall.sh is invoked by FBL after this setup if present ==="
  echo "Default path: /usr/local/bin/analyze_stall.sh"
  echo "Required privileges: reading /proc is enough for a snapshot. Installing a"
  echo "boot-persistent stall probe typically requires root and is not performed here."
  echo "Completed: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "${DIR}/setup.txt"
echo "STALL_EVIDENCE_DIR=${DIR}"
