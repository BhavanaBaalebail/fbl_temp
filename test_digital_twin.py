#!/usr/bin/env python3
"""
test_digital_twin.py
=====================

unittest suite for digital_twin.py / digital_twin_execution.py /
digital_twin_learning.py.

Run:
    python3 -m unittest -v test_digital_twin.py
"""

from __future__ import annotations

import ast
import inspect
import json
import os
import tempfile
import time
import unittest
from unittest import mock

import digital_twin as dt
import digital_twin_execution as dte
import digital_twin_learning as dtl


def _make_proc(
    pid=12345,
    name="worker",
    username="alice",
    status="running",
    cpu_percent=50.0,
    memory_percent=10.0,
    memory_mb=500.0,
    read_mb_s=1.0,
    write_mb_s=1.0,
    io_available=True,
) -> dt.ProcessSnapshot:
    return dt.ProcessSnapshot(
        pid=pid,
        name=name,
        username=username,
        status=status,
        cpu_percent=cpu_percent,
        memory_percent=memory_percent,
        memory_mb=memory_mb,
        read_mb_s=read_mb_s,
        write_mb_s=write_mb_s,
        io_available=io_available,
    )


def _make_state(
    processes,
    cpu_core_count=4,
    cpu_percent=40.0,
    ram_total_gb=16.0,
    ram_used_gb=8.0,
    ram_percent=50.0,
    disk_total_gb=100.0,
    disk_used_gb=50.0,
    disk_percent=50.0,
    disk_read_mb_s=5.0,
    disk_write_mb_s=5.0,
    nics=None,
    io_controllers=None,
    gpus=None,
) -> dt.DigitalTwinState:
    return dt.DigitalTwinState(
        timestamp="2026-01-01T00:00:00+00:00",
        sample_interval_seconds=1.0,
        cpu_percent=cpu_percent,
        cpu_core_count=cpu_core_count,
        ram_percent=ram_percent,
        ram_used_gb=ram_used_gb,
        ram_total_gb=ram_total_gb,
        disk_percent=disk_percent,
        disk_used_gb=disk_used_gb,
        disk_total_gb=disk_total_gb,
        disk_read_mb_s=disk_read_mb_s,
        disk_write_mb_s=disk_write_mb_s,
        net_rx_mb_s=0.0,
        net_tx_mb_s=0.0,
        processes=processes,
        nics=nics or [],
        io_controllers=io_controllers or [],
        gpus=gpus or [],
    )


class TestCpuMetrics(unittest.TestCase):
    def test_cpu_process_contribution_divides_by_core_count(self):
        proc = _make_proc(cpu_percent=100.0)
        st = _make_state([proc], cpu_core_count=4, cpu_percent=40.0)
        contribution = dt._process_cpu_contribution(proc, st)
        self.assertAlmostEqual(contribution, 25.0, places=1)

    def test_cpu_contribution_clamped_to_100(self):
        proc = _make_proc(cpu_percent=1000.0)
        st = _make_state([proc], cpu_core_count=1)
        contribution = dt._process_cpu_contribution(proc, st)
        self.assertGreaterEqual(contribution, 0.0)
        self.assertLessEqual(contribution, 100.0)


class TestCpuCollectionReal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = dt.collect_current_state(sample_interval=0.3)

    def test_per_core_cpu_collection_real(self):
        self.assertIsInstance(self.state.cpu_percent_per_core, list)
        self.assertEqual(len(self.state.cpu_percent_per_core), self.state.cpu_core_count)
        self.assertTrue(all(isinstance(c, float) for c in self.state.cpu_percent_per_core))

    def test_load_average_collected_when_available(self):
        if hasattr(os, "getloadavg"):
            self.assertIsNotNone(self.state.load_avg_1)


class TestRamSemantics(unittest.TestCase):
    def test_pause_keeps_ram_allocated(self):
        proc = _make_proc(pid=999, memory_mb=1000.0, memory_percent=10.0)
        st = _make_state([proc], ram_total_gb=16.0, ram_used_gb=8.0, ram_percent=50.0)
        result = dt.simulate_action("pause", 999, st)
        self.assertEqual(result.ram_delta_mb, 0.0)
        self.assertAlmostEqual(result.predicted_state["ram_used_gb"], st.ram_used_gb, places=3)

    def test_terminate_releases_ram(self):
        proc = _make_proc(pid=998, memory_mb=1000.0, memory_percent=10.0)
        st = _make_state([proc], ram_total_gb=16.0, ram_used_gb=8.0, ram_percent=50.0)
        result = dt.simulate_action("terminate", 998, st)
        self.assertAlmostEqual(result.ram_delta_mb, 1000.0, places=1)
        self.assertLess(result.predicted_state["ram_used_gb"], st.ram_used_gb)

    def test_kill_releases_ram(self):
        proc = _make_proc(pid=997, memory_mb=500.0, memory_percent=5.0)
        st = _make_state([proc], ram_total_gb=16.0, ram_used_gb=8.0, ram_percent=50.0)
        result = dt.simulate_action("kill", 997, st)
        self.assertAlmostEqual(result.ram_delta_mb, 500.0, places=1)

    def test_ram_prediction_clamped_nonnegative(self):
        proc = _make_proc(pid=996, memory_mb=99999.0, memory_percent=99.0)
        st = _make_state([proc], ram_total_gb=16.0, ram_used_gb=1.0, ram_percent=6.0)
        result = dt.simulate_action("terminate", 996, st)
        self.assertGreaterEqual(result.predicted_state["ram_used_gb"], 0.0)


class TestRamCollectionReal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = dt.collect_current_state(sample_interval=0.3)

    def test_swap_and_available_ram_collected_real(self):
        self.assertIsNotNone(self.state.swap_percent)
        self.assertIsNotNone(self.state.ram_available_gb)


class TestDiskSeparation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = dt.collect_current_state(sample_interval=0.3)

    def test_disk_capacity_and_throughput_are_separate_fields(self):
        self.assertTrue(hasattr(self.state, "disk_percent"))
        self.assertTrue(hasattr(self.state, "disk_read_mb_s"))
        self.assertTrue(hasattr(self.state, "disk_write_mb_s"))
        summary = self.state.summary_dict()
        self.assertIn("disk_percent", summary)
        self.assertIn("disk_read_mb_s", summary)

    def test_top_by_io_excludes_unmeasurable(self):
        measurable = _make_proc(pid=1, read_mb_s=5.0, write_mb_s=5.0, io_available=True)
        unmeasurable = _make_proc(pid=2, read_mb_s=None, write_mb_s=None, io_available=False)
        st = _make_state([measurable, unmeasurable])
        top = st.top_by_io()
        self.assertNotIn(unmeasurable, top)
        self.assertIn(measurable, top)


class TestNic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = dt.collect_current_state(sample_interval=0.3)

    def test_nic_discovery_is_dynamic_not_hardcoded(self):
        src = inspect.getsource(dt._collect_nic_snapshots)
        for banned in ("eno1", "enp0s31f6", "wlp3s0"):
            self.assertNotIn(banned, src)
        names = [n.name for n in self.state.nics]
        self.assertTrue(any(n == "lo" or n.startswith("lo") for n in names), names)

    def test_nic_missing_metric_uses_explicit_fallback(self):
        nic = dt.NICSnapshot(
            name="fake0",
            is_up=None,
            speed_mbps=None,
            duplex=None,
            mtu=None,
            addresses=[],
            rx_mb_s=None,
            tx_mb_s=None,
            rx_errors=None,
            tx_errors=None,
            rx_drops=None,
            tx_drops=None,
        )
        st = _make_state([], nics=[nic])
        result = dt.simulate_nic_action("restart_interface", "fake0", st)
        self.assertTrue(any(dt.NOT_AVAILABLE in w for w in result.warnings))

    def test_nic_action_never_touches_real_interface_fields(self):
        nic = dt.NICSnapshot(
            name="eth9",
            is_up=True,
            speed_mbps=1000.0,
            duplex="FULL",
            mtu=1500,
            addresses=["10.0.0.5"],
            rx_mb_s=1.0,
            tx_mb_s=1.0,
            rx_errors=0,
            tx_errors=0,
            rx_drops=0,
            tx_drops=0,
        )
        st = _make_state([], nics=[nic])
        result = dt.simulate_nic_action("restart_interface", "eth9", st)
        self.assertEqual(result.domain, "nic")
        self.assertEqual(result.cpu_delta_percent, 0.0)


class TestIoController(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = dt.collect_current_state(sample_interval=0.3)

    def test_io_controller_unavailable_metric_handling(self):
        dev = dt.IOControllerSnapshot(
            device="sdz",
            reads_completed_delta=None,
            writes_completed_delta=None,
            sectors_read_delta=None,
            sectors_written_delta=None,
            io_in_progress=None,
            io_time_ms_delta=None,
            weighted_io_time_ms_delta=None,
            available=False,
        )
        proc = _make_proc(pid=1234, read_mb_s=2.0, write_mb_s=1.0, io_available=True)
        st = _make_state([proc], io_controllers=[dev])
        result = dt.simulate_io_controller_action("reduce_offending_workload", "sdz", 1234, st)
        self.assertTrue(any(dt.NOT_AVAILABLE in w for w in result.warnings))
        self.assertEqual(result.domain, "io_controller")

    def test_io_controller_domain_is_separate_from_disk_capacity(self):
        dev = dt.IOControllerSnapshot(
            device="sda",
            reads_completed_delta=100,
            writes_completed_delta=50,
            sectors_read_delta=1000,
            sectors_written_delta=500,
            io_in_progress=2,
            io_time_ms_delta=500,
            weighted_io_time_ms_delta=600,
            available=True,
        )
        proc = _make_proc(pid=42, read_mb_s=3.0, write_mb_s=2.0, io_available=True)
        st = _make_state([proc], io_controllers=[dev], disk_percent=10.0)
        result = dt.simulate_io_controller_action("reduce_offending_workload", "sda", 42, st)
        self.assertIsNone(result.current_state["disk_percent"])

    def test_io_controller_discovery_real(self):
        self.assertIsInstance(self.state.io_controllers, list)


class TestGpu(unittest.TestCase):
    def test_gpu_unavailable_raises_not_fabricated(self):
        st = _make_state([], gpus=[])
        with self.assertRaises(ValueError):
            dt.simulate_gpu_action("throttle_recommendation", st)

    def test_gpu_action_domain_tagged(self):
        gpu = dt.GPUSnapshot(
            index=0,
            name="Fake GPU",
            utilization_percent=80.0,
            memory_used_mb=4000.0,
            memory_total_mb=8000.0,
            temperature_c=60.0,
            power_watts=150.0,
            processes=[],
        )
        st = _make_state([], gpus=[gpu])
        result = dt.simulate_gpu_action("throttle_recommendation", st, gpu_index=0)
        self.assertEqual(result.domain, "gpu")
        self.assertEqual(result.cpu_delta_percent, 0.0)
        self.assertEqual(result.ram_delta_percent, 0.0)

    def test_gpu_workload_action_requires_valid_pid(self):
        gpu = dt.GPUSnapshot(
            index=0,
            name="Fake GPU",
            utilization_percent=80.0,
            memory_used_mb=4000.0,
            memory_total_mb=8000.0,
            temperature_c=60.0,
            power_watts=150.0,
            processes=[],
        )
        st = _make_state([], gpus=[gpu])
        with self.assertRaises(ValueError):
            dt.simulate_gpu_action("terminate_gpu_workload", st, gpu_index=0, pid=None)


class TestDomainAwareSimulation(unittest.TestCase):
    def test_simulation_result_tags_domain_for_process_actions(self):
        proc = _make_proc(pid=1111)
        st = _make_state([proc])
        result = dt.simulate_action("pause", 1111, st)
        self.assertEqual(result.domain, "process")

    def test_backward_compatible_wrappers_still_work(self):
        proc = _make_proc(pid=2222)
        st = _make_state([proc])
        for fn, action in (
            (dt.simulate_kill_process, "kill"),
            (dt.simulate_terminate_process, "terminate"),
            (dt.simulate_pause_process, "pause"),
            (dt.simulate_resume_process, "resume"),
        ):
            r = fn(2222, st)
            self.assertEqual(r.action, action)
            self.assertEqual(r.target_pid, 2222)


class TestPressureDetection(unittest.TestCase):
    def test_detect_pressure_no_problem_when_all_normal(self):
        proc = _make_proc(pid=1, cpu_percent=1.0, memory_percent=1.0)
        st = _make_state([proc], cpu_percent=5.0, ram_percent=10.0, disk_percent=20.0)
        st.load_avg_1 = 0.1
        st.swap_percent = 0.0
        result = dt.detect_pressure(st)
        self.assertFalse(result["has_problem"])

    def test_detect_pressure_flags_high_cpu(self):
        st = _make_state([], cpu_percent=99.0)
        st.load_avg_1 = 0.1
        result = dt.detect_pressure(st)
        self.assertTrue(result["domains"]["cpu"]["pressure"])
        self.assertTrue(result["has_problem"])

    def test_detect_pressure_flags_ram_and_swap(self):
        st = _make_state([], ram_percent=95.0)
        result = dt.detect_pressure(st)
        self.assertTrue(result["domains"]["ram"]["pressure"])

    def test_detect_pressure_flags_nic_errors(self):
        nic = dt.NICSnapshot(
            name="eth0",
            is_up=True,
            speed_mbps=1000.0,
            duplex="FULL",
            mtu=1500,
            addresses=[],
            rx_mb_s=0.0,
            tx_mb_s=0.0,
            rx_errors=50,
            tx_errors=0,
            rx_drops=0,
            tx_drops=0,
        )
        st = _make_state([], cpu_percent=1.0, ram_percent=1.0, disk_percent=1.0, nics=[nic])
        st.load_avg_1 = 0.0
        result = dt.detect_pressure(st)
        self.assertTrue(result["domains"]["nic"]["pressure"])

    def test_detect_pressure_flags_nic_link_down(self):
        nic = dt.NICSnapshot(
            name="eno1",
            is_up=False,
            speed_mbps=1000.0,
            duplex="FULL",
            mtu=1500,
            addresses=[],
            rx_mb_s=0.0,
            tx_mb_s=0.0,
            rx_errors=0,
            tx_errors=0,
            rx_drops=0,
            tx_drops=0,
        )
        st = _make_state([], cpu_percent=1.6, ram_percent=24.1, disk_percent=61.3, nics=[nic])
        st.load_avg_1 = 0.1
        result = dt.detect_pressure(st)
        self.assertTrue(result["domains"]["nic"]["pressure"])
        self.assertFalse(result["domains"]["cpu"]["pressure"])
        self.assertFalse(result["domains"]["ram"]["pressure"])


class TestDomainAwareCandidates(unittest.TestCase):
    def test_healthy_domains_produce_no_unrelated_process_candidates(self):
        """Critical bug regression: NIC-only pressure must not kill Firefox."""
        firefox = _make_proc(pid=100, name="firefox", cpu_percent=80.0, memory_percent=15.0)
        webcontent = _make_proc(pid=101, name="Isolated Web Content", cpu_percent=60.0, memory_percent=10.0)
        nic = dt.NICSnapshot(
            name="eno1",
            is_up=False,
            speed_mbps=1000.0,
            duplex="FULL",
            mtu=1500,
            addresses=[],
            rx_mb_s=0.0,
            tx_mb_s=0.0,
            rx_errors=0,
            tx_errors=0,
            rx_drops=0,
            tx_drops=0,
        )
        st = _make_state(
            [firefox, webcontent],
            cpu_percent=1.6,
            ram_percent=24.1,
            disk_percent=61.3,
            nics=[nic],
        )
        st.load_avg_1 = 0.1
        report = dt.generate_recovery_candidates(st)
        process_actions = {
            (c.action, c.target_process)
            for c in report["ranked"]
            if c.action in ("pause", "terminate", "kill")
        }
        self.assertEqual(process_actions, set())
        self.assertTrue(any(c.domain == dt.DOMAIN_NIC for c in report["ranked"]))

    def test_cpu_pressure_generates_cpu_domain_candidates(self):
        worker = _make_proc(pid=200, name="stress-ng", cpu_percent=95.0)
        st = _make_state([worker], cpu_percent=95.0, ram_percent=10.0, disk_percent=20.0)
        st.load_avg_1 = 10.0
        report = dt.generate_recovery_candidates(st)
        self.assertTrue(any(c.domain == dt.DOMAIN_CPU for c in report["ranked"]))

    def test_no_pressure_means_no_candidates(self):
        st = _make_state([], cpu_percent=5.0, ram_percent=10.0, disk_percent=20.0)
        st.load_avg_1 = 0.1
        report = dt.generate_recovery_candidates(st)
        self.assertEqual(report["ranked"], [])
        self.assertIn("No domain pressure detected", report["message"] or "")


class TestRiskModel(unittest.TestCase):
    def test_protected_process_is_high_risk(self):
        proc = _make_proc(pid=5555, name="sshd")
        st = _make_state([proc])
        result = dt.simulate_action("kill", 5555, st)
        self.assertEqual(result.risk, dt.RISK_HIGH)

    def test_pid_1_is_never_a_recovery_candidate(self):
        proc = _make_proc(pid=1, name="init")
        st = _make_state([proc])
        result = dt.simulate_action("kill", 1, st)
        self.assertEqual(result.risk, dt.RISK_HIGH)

    def test_pause_resume_lower_risk_than_kill(self):
        proc = _make_proc(pid=6666, name="worker")
        st = _make_state([proc])
        kill_result = dt.simulate_action("kill", 6666, st)
        pause_result = dt.simulate_action("pause", 6666, st)
        self.assertLessEqual(dt._RISK_ORDER[pause_result.risk], dt._RISK_ORDER[kill_result.risk])


class TestRankActions(unittest.TestCase):
    def test_rank_actions_sorts_by_risk_first(self):
        proc = _make_proc(pid=7777, name="worker")
        st = _make_state([proc])
        results = [
            dt.simulate_action("kill", 7777, st),
            dt.simulate_action("pause", 7777, st),
        ]
        ranked = dt.rank_actions(results)
        self.assertLessEqual(dt._RISK_ORDER[ranked[0].risk], dt._RISK_ORDER[ranked[-1].risk])


class TestSimulationSafety(unittest.TestCase):
    def test_simulate_action_never_calls_os_kill(self):
        called = {"count": 0}

        def _tripwire(*a, **kw):
            called["count"] += 1
            raise AssertionError("os.kill() must NEVER be called from digital_twin.py")

        with mock.patch.object(dt.os, "kill", _tripwire):
            proc = _make_proc(pid=8888)
            st = _make_state([proc])
            for action in ("kill", "terminate", "pause", "resume"):
                dt.simulate_action(action, 8888, st)
        self.assertEqual(called["count"], 0)

    def _call_name(self, node: ast.Call) -> str:
        func = node.func
        if isinstance(func, ast.Attribute):
            base = func.value.id if isinstance(func.value, ast.Name) else ""
            return f"{base}.{func.attr}"
        if isinstance(func, ast.Name):
            return func.id
        return ""

    def test_digital_twin_source_never_sends_real_signals(self):
        tree = ast.parse(inspect.getsource(dt))
        forbidden_calls = {"os.kill", "kill", "send_signal", "suspend", "resume", "terminate"}
        offenders = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = self._call_name(node)
                if name in forbidden_calls:
                    offenders.append(name)
        self.assertEqual(offenders, [], f"digital_twin.py contains real signal-sending call(s): {offenders}")

    def test_digital_twin_does_not_import_execution_module(self):
        tree = ast.parse(inspect.getsource(dt))
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                names = [n.name for n in node.names] + (
                    [node.module] if isinstance(node, ast.ImportFrom) and node.module else []
                )
                self.assertNotIn("digital_twin_execution", names)

    def test_current_predicted_labels(self):
        proc = _make_proc(pid=3333)
        st = _make_state([proc])
        result = dt.simulate_action("pause", 3333, st)
        self.assertEqual(result.current_state["label"], "CURRENT")
        self.assertEqual(result.predicted_state["label"], "PREDICTED")


class TestExecutionGating(unittest.TestCase):
    def test_execution_disabled_by_default(self):
        self.assertFalse(dte.EXECUTION_ENABLED)

    def test_execute_refuses_without_enabling(self):
        fingerprint = dte.ProcessFingerprint(pid=os.getpid(), name="unittest", create_time=time.time())
        approval = dte.ApprovalToken(
            approved_by="tester",
            approved_at="now",
            action="pause",
            pid=os.getpid(),
            acknowledged_risk=True,
        )
        req = dte.ExecutionRequest(action="pause", pid=os.getpid(), fingerprint=fingerprint, approval=approval)
        with mock.patch.object(dte, "EXECUTION_ENABLED", False):
            with self.assertRaises(dte.ExecutionDisabledError):
                dte.execute(req)

    def test_execute_refuses_without_matching_approval(self):
        fingerprint = dte.ProcessFingerprint(pid=os.getpid(), name="unittest", create_time=time.time())
        bad_approval = dte.ApprovalToken(
            approved_by="",
            approved_at="now",
            action="pause",
            pid=os.getpid(),
            acknowledged_risk=False,
        )
        req = dte.ExecutionRequest(action="pause", pid=os.getpid(), fingerprint=fingerprint, approval=bad_approval)
        with mock.patch.object(dte, "EXECUTION_ENABLED", True):
            with self.assertRaises(dte.ApprovalRequiredError):
                dte.execute(req)

    def test_execute_refuses_on_pid_reuse_fingerprint_mismatch(self):
        real_pid = os.getpid()
        stale_fingerprint = dte.ProcessFingerprint(pid=real_pid, name="unittest", create_time=1.0)
        approval = dte.ApprovalToken(
            approved_by="tester",
            approved_at="now",
            action="pause",
            pid=real_pid,
            acknowledged_risk=True,
        )
        req = dte.ExecutionRequest(action="pause", pid=real_pid, fingerprint=stale_fingerprint, approval=approval)
        with mock.patch.object(dte, "EXECUTION_ENABLED", True):
            with self.assertRaises(dte.IdentityMismatchError):
                dte.execute(req)

    def test_execute_refuses_protected_pids(self):
        fingerprint = dte.ProcessFingerprint(pid=1, name="init", create_time=0.0)
        approval = dte.ApprovalToken(
            approved_by="tester",
            approved_at="now",
            action="kill",
            pid=1,
            acknowledged_risk=True,
        )
        req = dte.ExecutionRequest(action="kill", pid=1, fingerprint=fingerprint, approval=approval)
        with mock.patch.object(dte, "EXECUTION_ENABLED", True):
            with self.assertRaises(dte.IdentityMismatchError):
                dte.execute(req)

    def test_execute_resume_requires_stopped_status(self):
        real_pid = os.getpid()
        fingerprint = dte.ProcessFingerprint.capture(real_pid)
        approval = dte.ApprovalToken(
            approved_by="tester",
            approved_at="now",
            action="resume",
            pid=real_pid,
            acknowledged_risk=True,
        )
        req = dte.ExecutionRequest(action="resume", pid=real_pid, fingerprint=fingerprint, approval=approval)
        with mock.patch.object(dte, "EXECUTION_ENABLED", True):
            with self.assertRaises(dte.IdentityMismatchError):
                dte.execute(req)


class TestLearning(unittest.TestCase):
    def test_record_and_load_prediction_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "predictions.jsonl")
            dtl.record_prediction(
                action="terminate",
                domain="process",
                predicted_metrics={"cpu_percent": 40.0},
                actual_metrics={"cpu_percent": 45.0},
                pid=123,
                process_name="worker",
                log_path=path,
            )
            records = dtl.load_predictions(path)
            self.assertEqual(len(records), 1)
            self.assertAlmostEqual(records[0].signed_error["cpu_percent"], 5.0, places=1)

    def test_jsonl_is_append_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "predictions.jsonl")
            dtl.record_prediction("pause", "process", {"cpu_percent": 10.0}, {"cpu_percent": 8.0}, log_path=path)
            dtl.record_prediction("pause", "process", {"cpu_percent": 10.0}, {"cpu_percent": 12.0}, log_path=path)
            with open(path) as fh:
                lines = fh.readlines()
            self.assertEqual(len(lines), 2)
            for line in lines:
                json.loads(line)

    def test_historical_error_stats_empty_when_no_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "predictions.jsonl")
            stats = dtl.historical_error_stats("nonexistent-proc", "kill", "process", "cpu_percent", log_path=path)
            self.assertEqual(stats["sample_size"], 0)
            self.assertEqual(
                dtl.confidence_adjustment("nonexistent-proc", "kill", "process", "cpu_percent", log_path=path),
                1.0,
            )

    def test_confidence_adjustment_penalizes_large_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "predictions.jsonl")
            for _ in range(5):
                dtl.record_prediction(
                    "kill",
                    "process",
                    {"cpu_percent": 10.0},
                    {"cpu_percent": 40.0},
                    process_name="flaky",
                    log_path=path,
                )
            adj = dtl.confidence_adjustment("flaky", "kill", "process", "cpu_percent", log_path=path)
            self.assertLess(adj, 1.0)

    def test_compare_prediction_vs_actual(self):
        predicted = {"cpu_percent": 10.0, "ram_percent": 50.0}
        actual = {"cpu_percent": 12.0, "ram_percent": 48.0}
        errors = dt.compare_prediction_vs_actual(predicted, actual)
        self.assertAlmostEqual(errors["cpu_percent"], 2.0, places=1)
        self.assertAlmostEqual(errors["ram_percent"], -2.0, places=1)


if __name__ == "__main__":
    unittest.main()
