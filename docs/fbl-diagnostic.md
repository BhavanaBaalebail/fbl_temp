# fbl-diagnostic CLI

Command-line interface for the **same** Incident Analysis service used by the FBL web UI (`fbl_incident_analysis.execute_utility`). It is not a general shell.

```text
FBL Web UI  ──►  Incident Analysis API  ──►  Incident Analysis Service
                                                    ▲
                                                    │
                                             fbl-diagnostic
                                                    │
                                                    ▼
                                            Approved scripts
```

## Install on the Linux collector

Copy next to `cm.py` (typically `/home/rvu`):

- `fbl-diagnostic`
- `fbl_diagnostic_cli.py`
- `fbl_incident_analysis.py` (already required for the UI)
- `incident_scripts/`

```bash
chmod +x /home/rvu/fbl-diagnostic /home/rvu/incident_scripts/*.sh
cd /home/rvu
./fbl-diagnostic list
```

Optional:

```bash
sudo ln -sf /home/rvu/fbl-diagnostic /usr/local/bin/fbl-diagnostic
# or: export FBL_HOME=/home/rvu
```

`start_fbl.sh` still only runs `python3 cm.py`. The CLI is a separate command you run in SSH when you want to test scripts.

## Commands

```text
fbl-diagnostic --help
fbl-diagnostic run --help

fbl-diagnostic list
fbl-diagnostic run analyze
fbl-diagnostic run health-assess
fbl-diagnostic run unified-rca
fbl-diagnostic run forensic
fbl-diagnostic run stall-capture
fbl-diagnostic run pid500

fbl-diagnostic stall setup      # Stall_Capture_setup.sh
fbl-diagnostic stall analyze    # analyze_stall.sh (/usr/local/bin or incident_scripts)

fbl-diagnostic history --limit 10
fbl-diagnostic status <execution_id>
fbl-diagnostic output <execution_id>
fbl-diagnostic output <execution_id> --tail 100
fbl-diagnostic report <execution_id>
fbl-diagnostic report <execution_id> --open   # prints path if no GUI browser
```

Associate with an Active Fault id:

```bash
fbl-diagnostic run unified-rca --incident <fault_id>
```

## Demo vs real

Without `--demo`, a missing script prints `FAILED` / `Script not found`. Success is never faked.

```bash
fbl-diagnostic run unified-rca --demo
```

prints **DEMO MODE** and simulated output only for that run.

## Script paths

Same env as the UI (`incident.env.example`):

`INCIDENT_SCRIPTS_DIR`, `ANALYZE_SCRIPT`, `HEALTH_ASSESS_SCRIPT`, `UNIFIED_RCA_SCRIPT`, `FORENSIC_SCRIPT`, `STALL_CAPTURE_SCRIPT`, `PID500_SCRIPT`, `ANALYZE_STALL_SCRIPT`.

## Privileges

| Utility | Root |
| --- | --- |
| analyze, health-assess, unified-rca, forensic, pid500 | No (read `/proc`, write `/tmp`) |
| stall setup / stall analyze | May require root for a persistent stall probe. The bundled setup only snapshots `/proc`. FBL does not add passwordless sudo. Optional: `INCIDENT_STALL_SUDO=true` uses `sudo -n`. |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `Script not found` | `incident_scripts/` next to `fbl-diagnostic` / `cm.py`; `chmod +x` |
| `Permission denied` | Script bits, `/tmp` write, sudo policy — do not weaken sudoers |
| CLI works, UI says backend unavailable | Restart `cm.py` so Flask loaded `fbl_incident_analysis` |
| `No module named fbl_incident_analysis` | Run from `/home/rvu` or set `FBL_HOME` |
