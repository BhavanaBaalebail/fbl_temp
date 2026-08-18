#!/usr/bin/env bash
# FBL Pid500.sh — record processes whose CPU% is >= 500 (ps pcpu can exceed 100
# on multi-core). Writes pid500_<timestamp>.log under output root.
set -euo pipefail
OUT_ROOT="${FBL_INCIDENT_OUTPUT:-/tmp}"
STAMP="$(date +%Y%m%d_%H%M%S)"
LOG="${OUT_ROOT}/pid500_${STAMP}.log"
: > "${LOG}"
FOUND=0
# ps %cpu is averaged; on Linux it can exceed 100 per process across cores.
while read -r pid pcpu comm args; do
  [[ "${pid}" == "PID" ]] && continue
  cpu_int="${pcpu%.*}"
  [[ -z "${cpu_int}" ]] && continue
  if [[ "${cpu_int}" -ge 500 ]]; then
    FOUND=1
    line="PID: ${pid}  Process: ${comm}  CPU: ${pcpu}%  Detected: $(date +%H:%M:%S)  CMD: ${args}"
    echo "${line}" | tee -a "${LOG}"
  fi
done < <(ps -eo pid= -o pcpu= -o comm= -o args= --sort=-pcpu 2>/dev/null | head -n 80)
if [[ "${FOUND}" -eq 0 ]]; then
  echo "No process currently at or above 500% CPU."
  echo "Evidence log (empty captures still timestamped): ${LOG}"
else
  echo "Evidence: $(basename "${LOG}")"
  echo "Output: ${LOG}"
fi
