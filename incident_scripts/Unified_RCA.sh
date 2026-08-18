#!/usr/bin/env bash
# FBL Unified_RCA.sh — correlative RCA from local signals. Do not invent a cause
# when evidence is missing.
set -uo pipefail
echo "Unified Root Cause Analysis"
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Host: $(hostname)"
echo

STORAGE=0
GPU=0
KERNEL=0
APP=0
CPU=0
MEM=0
NET=0

if command -v iostat >/dev/null 2>&1; then
  if iostat -xz 1 2 2>/dev/null | awk 'NF>0 && $1 !~ /Linux|avg-cpu|Device/ {await=$10+0; if(await>50) found=1} END{exit found?0:1}'; then
    echo "STORAGE ISSUE DETECTED (XFS / DM / BLOCK I/O)"
    STORAGE=1
  fi
fi
if [[ -r /proc/diskstats ]]; then
  # High weighted I/O time is a weak signal; report only if iowait looks elevated.
  IOWAIT="$(awk '/cpu /{u=$2+$3+$4+$6+$8+$9+$10+$11; w=$6; if(u>0 && w/u>0.25) print 1}' /proc/stat 2>/dev/null || true)"
  if [[ "${IOWAIT}" == "1" ]]; then
    echo "STORAGE ISSUE DETECTED (XFS / DM / BLOCK I/O)"
    STORAGE=1
  fi
fi
if [[ -d /sys/class/drm ]]; then
  if ls /sys/class/drm 2>/dev/null | grep -Eq 'qxl|card'; then
    if dmesg 2>/dev/null | tail -n 200 | grep -Ei 'qxl|drm.*error|vram' >/dev/null 2>&1; then
      echo "GPU / VRAM ISSUE DETECTED (DRM/QXL)"
      GPU=1
    fi
  fi
fi
DSTATE="$(ps -eo state= 2>/dev/null | awk '$1=="D"{c++} END{print c+0}')"
if [[ "${DSTATE}" -gt 0 ]]; then
  echo "KERNEL STALL DETECTED (D-state processes)"
  KERNEL=1
fi
if pgrep -x java >/dev/null 2>&1; then
  echo "APPLICATION LOAD PRESENT (Java detected)"
  APP=1
fi
LOAD="$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)"
CPUS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
awk -v load="${LOAD}" -v n="${CPUS}" 'BEGIN{if(n>0 && load>n*1.5) exit 0; exit 1}' && { echo "CPU PRESSURE DETECTED"; CPU=1; } || true
MEM_USED="$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{if(t>0 && (t-a)/t>0.92) print 1}' /proc/meminfo 2>/dev/null || true)"
if [[ "${MEM_USED}" == "1" ]]; then
  echo "MEMORY PRESSURE DETECTED"
  MEM=1
fi

echo
PRIMARY=""
if [[ "${STORAGE}" -eq 1 && "${KERNEL}" -eq 1 ]]; then
  PRIMARY="STORAGE LATENCY (causing kernel stalls)"
elif [[ "${STORAGE}" -eq 1 ]]; then
  PRIMARY="STORAGE LATENCY"
elif [[ "${KERNEL}" -eq 1 ]]; then
  PRIMARY="KERNEL STALL"
elif [[ "${MEM}" -eq 1 ]]; then
  PRIMARY="MEMORY PRESSURE"
elif [[ "${CPU}" -eq 1 ]]; then
  PRIMARY="CPU SATURATION"
elif [[ "${GPU}" -eq 1 ]]; then
  PRIMARY="GPU / VRAM"
elif [[ "${APP}" -eq 1 ]]; then
  PRIMARY="APPLICATION LOAD"
fi
if [[ -n "${PRIMARY}" ]]; then
  echo "PRIMARY ROOT CAUSE: ${PRIMARY}"
else
  echo "INSUFFICIENT EVIDENCE TO DETERMINE PRIMARY ROOT CAUSE"
fi
echo "Completed: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
