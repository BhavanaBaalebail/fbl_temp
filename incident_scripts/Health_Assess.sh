#!/usr/bin/env bash
# FBL Health_Assess.sh — writes TXT + HTML under /tmp/telecom_health_<date>_<time>/
set -uo pipefail
STAMP="$(date +%Y%m%d_%H%M%S)"
DIR="/tmp/telecom_health_${STAMP}"
mkdir -p "${DIR}"
TXT="${DIR}/health_report.txt"
HTML="${DIR}/health_report.html"
{
  echo "Comprehensive Health Assessment"
  echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Directory: ${DIR}"
  echo
  echo "=== CPU assessment ==="
  uptime 2>/dev/null || true
  echo
  echo "=== Memory assessment ==="
  free -h 2>/dev/null || true
  echo
  echo "=== Storage assessment ==="
  df -h 2>/dev/null | head -n 20 || true
  echo
  echo "=== Filesystem assessment ==="
  mount 2>/dev/null | head -n 20 || true
  echo
  echo "=== Network assessment ==="
  if command -v ip >/dev/null 2>&1; then ip -br addr 2>/dev/null || true; else ifconfig 2>/dev/null | head -n 40 || true; fi
  echo
  echo "=== Application assessment ==="
  ps -eo pid,%cpu,%mem,comm --sort=-%cpu 2>/dev/null | head -n 20 || true
  echo "HTML: ${HTML}"
  echo "Completed: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "${TXT}"
python3 - "${TXT}" "${HTML}" <<'PY'
import pathlib, sys, html
txt, dest = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
body = html.escape(txt.read_text(encoding="utf-8", errors="replace"))
dest.write_text(
    "<html><head><meta charset='utf-8'><title>Health Assessment</title></head>"
    "<body style='background:#0b1220;color:#e2e8f0;font-family:ui-sans-serif,system-ui;padding:24px'>"
    "<h1>Health Assessment</h1><pre style='white-space:pre-wrap'>"
    + body
    + "</pre></body></html>",
    encoding="utf-8",
)
print(dest)
PY
