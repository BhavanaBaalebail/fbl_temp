#!/usr/bin/env bash
# FBL analyze_stall.sh — interpret stall evidence already on the host.
set -euo pipefail
echo "analyze_stall.sh"
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
DSTATE="$(ps -eo pid,state,wchan,comm 2>/dev/null | awk '$2=="D"{print}' || true)"
if [[ -n "${DSTATE}" ]]; then
  echo "KERNEL STALL DETECTED (D-state processes)"
  echo "${DSTATE}" | head -n 40
else
  echo "No D-state processes at capture time."
fi
if [[ -r /proc/stat ]]; then
  awk '/cpu /{w=$6; t=$2+$3+$4+$5+$6+$7+$8+$9+$10+$11; printf "iowait_share=%.2f\n", (t>0?w/t:0)}' /proc/stat
fi
echo "Completed: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
