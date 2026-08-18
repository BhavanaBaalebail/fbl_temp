from __future__ import annotations

import os
import time
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask

import fbl_incident_analysis as ia


class ParseTests(unittest.TestCase):
    def test_parse_rca_from_script_output(self):
        text = (
            "STORAGE ISSUE DETECTED (XFS / DM / BLOCK I/O)\n"
            "KERNEL STALL DETECTED (D-state processes)\n"
            "APPLICATION LOAD PRESENT (Java detected)\n"
            "PRIMARY ROOT CAUSE: STORAGE LATENCY (causing kernel stalls)\n"
        )
        parsed = ia.parse_rca(text)
        self.assertEqual(parsed["primary_root_cause"], "STORAGE LATENCY")
        self.assertIn("Storage", parsed["affected_subsystems"])
        self.assertIn("Kernel", parsed["affected_subsystems"])
        self.assertFalse(parsed["insufficient"])

    def test_parse_rca_insufficient(self):
        parsed = ia.parse_rca("nothing useful here")
        self.assertTrue(parsed["insufficient"])
        self.assertIsNone(parsed["primary_root_cause"])

    def test_parse_pid500_not_hardcoded(self):
        text = "PID: 9999  Process: python  CPU: 701%\nPID: 42  Process: java  CPU: 512%"
        parsed = ia.parse_pid500(text)
        self.assertEqual(parsed["occurrences"], 2)
        self.assertEqual(parsed["processes"][0]["pid"], "9999")
        self.assertEqual(parsed["processes"][1]["process"], "java")


class PathSafetyTests(unittest.TestCase):
    def test_blocks_traversal(self):
        self.assertFalse(ia.is_safe_output_path(Path("/etc/passwd")))
        self.assertFalse(ia.is_safe_output_path(Path("/tmp/../etc/passwd")))

    def test_allows_tmp(self):
        self.assertTrue(ia.is_safe_output_path(Path("/tmp")))


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        ia.register_incident_analysis_routes(self.app, get_demo_active=lambda: False)
        self.client = self.app.test_client()

    def test_reject_unknown_utility(self):
        res = self.client.post("/incident-analysis/run/not-a-real-tool", json={})
        self.assertEqual(res.status_code, 400)
        self.assertIn("allowlist", res.get_json())

    def test_report_missing_execution(self):
        res = self.client.get("/incident-analysis/report/does-not-exist")
        self.assertEqual(res.status_code, 404)

    def test_run_analyze_and_complete(self):
        script = Path(__file__).resolve().parents[1] / "incident_scripts" / "Analyze.sh"
        if not script.exists():
            self.skipTest("Analyze.sh missing")
        with mock.patch.dict(os.environ, {"ANALYZE_SCRIPT": str(script), "INCIDENT_OUTPUT_DIR": "/tmp"}):
            res = self.client.post(
                "/incident-analysis/run/analyze",
                json={"incident_id": "fault-test-1", "operator": "pytest"},
            )
            self.assertEqual(res.status_code, 202)
            eid = res.get_json()["execution_id"]
            self.assertTrue(str(eid).startswith("incident-analysis-"))
            deadline = time.time() + 30
            payload = None
            while time.time() < deadline:
                status = self.client.get(f"/incident-analysis/status/{eid}")
                payload = status.get_json()
                if payload.get("status") in ("COMPLETED", "FAILED", "TIMEOUT"):
                    break
                time.sleep(0.2)
            self.assertIsNotNone(payload)
            self.assertIn(payload["status"], ("COMPLETED", "FAILED", "TIMEOUT"))
            self.assertEqual(payload["incident_id"], "fault-test-1")

    def test_html_report_path_rejected_if_unsafe(self):
        record = {
            "execution_id": "incident-analysis-test-html",
            "incident_id": "x",
            "utility_id": "health",
            "status": "COMPLETED",
            "html_report_location": "/etc/passwd",
            "started_at_epoch": time.time(),
        }
        ia.persist_execution(record)
        res = self.client.get("/incident-analysis/report/incident-analysis-test-html")
        self.assertEqual(res.status_code, 403)


if __name__ == "__main__":
    unittest.main()
