from __future__ import annotations

import datetime as dt
import importlib.util
import json
import logging
import os
import signal
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterator
from unittest import mock
from zoneinfo import ZoneInfo


MODULE_PATH = Path(__file__).resolve().parents[1] / "daily_briefing_runner.py"
SPEC = importlib.util.spec_from_file_location("daily_briefing_runner", MODULE_PATH)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)

PACIFIC = ZoneInfo("America/Los_Angeles")


@contextmanager
def loopback_server(
    handler: type[BaseHTTPRequestHandler],
) -> Iterator[ThreadingHTTPServer]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_config(root: Path, *, codex_home: Path | None = None) -> runner.Config:
    values = {
        "WORKOUT_RELEASE_ROOT": str(MODULE_PATH.parent),
        "WORKOUT_AUTOMATION_ROOT": str(root),
        "WORKOUT_STATE_DIR": str(root / "state"),
        "WORKOUT_LOG_DIR": str(root / "logs"),
        "WORKOUT_ENV_FILE": str(root / "credentials.env"),
        "WORKOUT_OURA_ROOT": str(root / "oura"),
        "WORKOUT_CODEX_HOME": str(codex_home or root / "codex-home"),
    }
    with mock.patch.dict(os.environ, values, clear=False):
        return runner.Config.from_env()


def create_codex_home(path: Path) -> None:
    path.mkdir(parents=True, mode=0o700)
    path.chmod(0o700)
    auth = path / "auth.json"
    auth.write_text("{}\n", encoding="utf-8")
    auth.chmod(0o600)


def create_codex_runtime_state(path: Path) -> None:
    (path / "installation_id").write_text("test-installation\n", encoding="utf-8")
    (path / "models_cache.json").write_text("{}\n", encoding="utf-8")
    (path / ".sandbox_migration").write_text("3\n", encoding="utf-8")
    for name in ("goals_1", "logs_2", "memories_1", "state_5"):
        (path / f"{name}.sqlite").write_bytes(b"")
        (path / f"{name}.sqlite-shm").write_bytes(b"")
        (path / f"{name}.sqlite-wal").write_bytes(b"")
    (path / "tmp").mkdir()
    (path / "shell_snapshots").mkdir()
    system = path / "skills" / ".system"
    system.mkdir(parents=True)
    (system / ".codex-system-skills.marker").write_text(
        "6fac8acc0c6abb7b\n", encoding="utf-8"
    )
    for name in runner.CODEX_SYSTEM_SKILL_DIRS:
        skill = system / name
        skill.mkdir()
        (skill / "SKILL.md").write_text("bundled system skill\n", encoding="utf-8")


def committed_publish_response(spool: dict, revision: int = 1) -> dict:
    briefing = json.loads(json.dumps(spool["briefing"]))
    state = json.loads(json.dumps(spool["memory"]["state"]))
    return {
        "publishId": spool["manifest"]["runId"],
        "briefing": {
            "briefingDate": spool["manifest"]["date"],
            "createdAt": 1,
            **briefing,
        },
        "memoryState": {
            "updatedAt": 1,
            **state,
        },
        "memoryRevision": revision,
    }


def pacific_ms(year: int, month: int, day: int, hour: int = 0) -> int:
    return int(dt.datetime(year, month, day, hour, tzinfo=PACIFIC).timestamp() * 1000)


def snapshot_body(updated_at: int) -> dict:
    return {
        "snapshot": {
            "id": "primary",
            "updatedAt": updated_at,
            "payload": {
                "schemaVersion": 2,
                "data": {
                    "exercises": [],
                    "programs": [],
                    "sessionTemplates": [],
                    "templateExercises": [],
                    "workoutSessions": [
                        {
                            "id": "session-1",
                            "name": "Upper",
                            "startedAt": updated_at - 2000,
                            "completedAt": updated_at - 1000,
                        }
                    ],
                    "loggedSets": [{"id": "set-1"}],
                    "aiMemorySettings": [],
                    "aiNotes": [],
                    "aiMemorySummaries": [],
                },
            },
        }
    }


def model_output(updated_at: int) -> dict:
    return {
        "briefing": {
            "headline": "Run Upper as written and earn the progression",
            "mode": "normal",
            "sections": {
                "todaysCall": "Run Upper as written. Add load only if the first work set clears the target cleanly.",
                "why": [
                    "The latest completed session is available.",
                    "Recent logged work supports the programmed progression.",
                ],
                "trainingTrend": "Recent training is stable enough to progress from performance.",
                "watchOuts": [],
            },
        },
        "memory": {
            "newItems": [
                {
                    "id": "workout:session-1",
                    "memoryType": "workout",
                    "periodStartAt": updated_at - 2000,
                    "periodEndAt": updated_at - 1000,
                    "sourceWorkoutSessionId": "session-1",
                    "bullets": ["Upper completed with one logged work set."],
                    "sourceSessionIds": ["session-1"],
                    "sourceNoteIds": [],
                    "sourceSummaryIds": [],
                }
            ],
        },
    }


def summary_item(
    memory_type: str,
    start: int,
    end: int,
    *,
    source_session_ids: list[str] | None = None,
    source_note_ids: list[str] | None = None,
    source_summary_ids: list[str] | None = None,
) -> dict:
    return {
        "id": f"{memory_type}:{start}:{end}",
        "memoryType": memory_type,
        "periodStartAt": start,
        "periodEndAt": end,
        "sourceWorkoutSessionId": None,
        "bullets": ["Period summary"] if memory_type == "two_week" else ["Long summary one", "Long summary two"],
        "sourceSessionIds": source_session_ids or [],
        "sourceNoteIds": source_note_ids or [],
        "sourceSummaryIds": source_summary_ids or [],
    }


class EnvTests(unittest.TestCase):
    def test_daily_briefing_model_defaults_to_sol_and_allows_override(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runner.Config.from_env().codex_model, "gpt-5.6-sol")
        with mock.patch.dict(
            os.environ, {"WORKOUT_CODEX_MODEL": "fixture-model"}, clear=True
        ):
            self.assertEqual(runner.Config.from_env().codex_model, "fixture-model")

    def test_parse_env_reads_only_exact_key_without_evaluating_shell(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / ".env"
            path.write_text(
                "OTHER=$(touch /tmp/should-not-run)\n"
                "export CLOUD_AUTOMATION_SECRET='safe-value'\n",
                encoding="utf-8",
            )
            self.assertEqual(
                runner.parse_env_value(path, "CLOUD_AUTOMATION_SECRET"),
                "safe-value",
            )

    def test_clean_child_environment_drops_secret_variables(self) -> None:
        old = os.environ.get("CLOUD_AUTOMATION_SECRET")
        os.environ["CLOUD_AUTOMATION_SECRET"] = "canary"
        try:
            child = runner.clean_child_env()
        finally:
            if old is None:
                os.environ.pop("CLOUD_AUTOMATION_SECRET", None)
            else:
                os.environ["CLOUD_AUTOMATION_SECRET"] = old
        self.assertNotIn("CLOUD_AUTOMATION_SECRET", child)
        self.assertNotIn("OPENAI_API_KEY", child)
        self.assertNotIn("CODEX_API_KEY", child)
        self.assertNotIn("CODEX_HOME", child)

    def test_codex_environment_uses_only_the_dedicated_home(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            codex_home = root / "codex-home"
            create_codex_home(codex_home)
            config = test_config(root, codex_home=codex_home)

            child = runner.clean_codex_env(config)

            self.assertEqual(child["CODEX_HOME"], str(codex_home.resolve()))
            self.assertNotEqual(child["CODEX_HOME"], str(Path.home() / ".codex"))
            self.assertNotIn("OPENAI_API_KEY", child)

    def test_codex_home_rejects_global_instructions(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            codex_home = root / "codex-home"
            create_codex_home(codex_home)
            (codex_home / "AGENTS.md").write_text("untrusted", encoding="utf-8")
            config = test_config(root, codex_home=codex_home)
            with self.assertRaisesRegex(runner.ConfigError, "forbidden"):
                runner.clean_codex_env(config)

    def test_codex_home_accepts_only_managed_runtime_state_across_runs(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            codex_home = root / "codex-home"
            create_codex_home(codex_home)
            create_codex_runtime_state(codex_home)
            config = test_config(root, codex_home=codex_home)

            first = runner.clean_codex_env(config)
            second = runner.clean_codex_env(config)

            self.assertEqual(first["CODEX_HOME"], str(codex_home.resolve()))
            self.assertEqual(second, first)

    def test_invoke_codex_revalidates_home_after_runtime_materialization(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            codex_home = root / "codex-home"
            run_dir = root / "run"
            create_codex_home(codex_home)
            run_dir.mkdir()
            config = test_config(root, codex_home=codex_home)

            def fake_run_bounded(
                _command: list[str],
                *,
                stdout_path: Path,
                **_kwargs: object,
            ) -> int:
                create_codex_runtime_state(codex_home)
                events = [
                    {"type": "thread.started", "thread_id": "thread"},
                    {"type": "turn.started"},
                    {
                        "type": "item.completed",
                        "item": {"id": "answer", "type": "agent_message", "text": "{}"},
                    },
                    {"type": "turn.completed", "usage": {}},
                ]
                stdout_path.write_text(
                    "\n".join(json.dumps(event) for event in events) + "\n",
                    encoding="utf-8",
                )
                (run_dir / "codex-output.json").write_text("{}\n", encoding="utf-8")
                return 0

            version = runner.subprocess.CompletedProcess(
                args=["codex", "--version"],
                returncode=0,
                stdout="codex-cli test\n",
            )
            with mock.patch.object(
                runner, "run_bounded", side_effect=fake_run_bounded
            ), mock.patch.object(runner.subprocess, "run", return_value=version):
                output, codex_version = runner.invoke_codex(
                    config,
                    Path("/usr/local/bin/codex"),
                    run_dir,
                    "test prompt",
                )

            self.assertEqual(output, {})
            self.assertEqual(codex_version, "codex-cli test")
            runner.validate_codex_home(codex_home)

    def test_codex_home_rejects_personal_skills_beside_system_skills(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            codex_home = root / "codex-home"
            create_codex_home(codex_home)
            create_codex_runtime_state(codex_home)
            (codex_home / "skills" / "personal-coach").mkdir()
            config = test_config(root, codex_home=codex_home)

            with self.assertRaisesRegex(runner.ConfigError, "personal or unknown skills"):
                runner.clean_codex_env(config)

    def test_codex_home_rejects_an_unknown_system_skill(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            codex_home = root / "codex-home"
            create_codex_home(codex_home)
            create_codex_runtime_state(codex_home)
            (codex_home / "skills" / ".system" / "unexpected-skill").mkdir()
            config = test_config(root, codex_home=codex_home)

            with self.assertRaisesRegex(runner.ConfigError, "audited bundle"):
                runner.clean_codex_env(config)

    def test_codex_command_explicitly_disables_all_tool_surfaces(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = test_config(root)
            command = runner.build_codex_command(
                config,
                Path("/usr/local/bin/codex"),
                root,
                root / "final.json",
                use_caffeinate=False,
            )
            self.assertIn("--ignore-user-config", command)
            self.assertIn("--ignore-rules", command)
            model_index = command.index("--model")
            self.assertEqual(command[model_index + 1], "gpt-5.6-sol")
            configs = [
                command[index + 1]
                for index, value in enumerate(command[:-1])
                if value == "--config"
            ]
            self.assertIn('web_search="disabled"', configs)
            skills_config = next(
                value for value in configs if value.startswith("skills.config=")
            )
            for name in runner.CODEX_SYSTEM_SKILL_DIRS:
                self.assertIn(f"/.system/{name}/SKILL.md", skills_config)
            self.assertEqual(
                skills_config.count("enabled=false"),
                len(runner.CODEX_SYSTEM_SKILL_DIRS),
            )
            disabled = {
                command[index + 1]
                for index, value in enumerate(command[:-1])
                if value == "--disable"
            }
            self.assertEqual(disabled, set(runner.DISABLED_CODEX_FEATURES))

    def test_binary_override_is_preferred(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / "codex"
            binary.write_text("#!/bin/sh\n", encoding="utf-8")
            binary.chmod(0o700)
            self.assertEqual(runner.resolve_codex_binary(str(binary)), binary)


class CloudTransportTests(unittest.TestCase):
    def test_cross_origin_redirect_never_receives_automation_secret(self) -> None:
        target_secrets: list[str | None] = []
        source_requests = 0

        class TargetHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                target_secrets.append(self.headers.get("X-Cloud-Automation-Secret"))
                self.send_response(200)
                self.end_headers()

            def log_message(self, _format: str, *args: object) -> None:
                pass

        with loopback_server(TargetHandler) as target:
            target_url = f"http://127.0.0.1:{target.server_port}/capture"

            class RedirectHandler(BaseHTTPRequestHandler):
                def do_POST(self) -> None:
                    nonlocal source_requests
                    source_requests += 1
                    self.rfile.read(int(self.headers.get("Content-Length", "0")))
                    self.send_response(302)
                    self.send_header("Location", target_url)
                    self.end_headers()

                def log_message(self, _format: str, *args: object) -> None:
                    pass

            with loopback_server(RedirectHandler) as source:
                config = type(
                    "CloudConfigStub",
                    (),
                    {
                        "app_url": f"http://127.0.0.1:{source.server_port}",
                        "http_timeout_seconds": 2,
                        "http_retries": 3,
                        "retry_delay_seconds": 0,
                    },
                )()
                client = runner.CloudClient(
                    config,
                    "synthetic-automation-secret",
                    logging.getLogger("daily-cloud-redirect-test"),
                )
                with self.assertRaisesRegex(runner.ConfigError, "HTTP 302"):
                    client.request("POST", "/start", body={"probe": True})

        self.assertEqual(source_requests, 1)
        self.assertEqual(target_secrets, [])


class CodexEventAuditTests(unittest.TestCase):
    def test_safe_event_stream_is_audited_without_retaining_content(self) -> None:
        events = [
            {"type": "thread.started", "thread_id": "thread"},
            {"type": "turn.started"},
            {
                "type": "item.completed",
                "item": {"id": "reason", "type": "reasoning", "text": "private"},
            },
            {
                "type": "item.completed",
                "item": {"id": "answer", "type": "agent_message", "text": "private"},
            },
            {"type": "turn.completed", "usage": {}},
        ]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            event_path = root / "events.jsonl"
            audit_path = root / "audit.json"
            event_path.write_text(
                "\n".join(json.dumps(event) for event in events) + "\n",
                encoding="utf-8",
            )
            audit = runner.audit_codex_events(event_path, audit_path)

            self.assertFalse(audit["toolsObserved"])
            self.assertEqual(audit["itemTypes"]["agent_message"], 1)
            self.assertNotIn("private", audit_path.read_text(encoding="utf-8"))

    def test_any_tool_item_fails_closed_before_output_is_accepted(self) -> None:
        events = [
            {"type": "thread.started", "thread_id": "thread"},
            {"type": "turn.started"},
            {
                "type": "item.started",
                "item": {"id": "tool", "type": "web_search", "query": "gym"},
            },
        ]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            event_path = root / "events.jsonl"
            event_path.write_text(
                "\n".join(json.dumps(event) for event in events) + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(runner.ConfigError, "forbidden"):
                runner.audit_codex_events(event_path, root / "audit.json")
            self.assertFalse((root / "audit.json").exists())

    def test_malformed_or_incomplete_event_stream_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            malformed = root / "malformed.jsonl"
            malformed.write_text("not-json\n", encoding="utf-8")
            with self.assertRaisesRegex(runner.ConfigError, "invalid JSON"):
                runner.audit_codex_events(malformed, root / "audit.json")

            incomplete = root / "incomplete.jsonl"
            incomplete.write_text(
                json.dumps({"type": "turn.started"}) + "\n", encoding="utf-8"
            )
            with self.assertRaisesRegex(runner.ConfigError, "completed answer"):
                runner.audit_codex_events(incomplete, root / "audit.json")


class ProcessCleanupTests(unittest.TestCase):
    def test_run_bounded_cleans_child_group_on_parent_exception(self) -> None:
        process = mock.Mock()
        process.pid = 43210
        process.poll.return_value = None
        process.communicate.side_effect = runner.TerminationRequested(signal.SIGTERM)
        process.wait.return_value = 0
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(
            runner.subprocess, "Popen", return_value=process
        ), mock.patch.object(runner.os, "killpg") as killpg:
            root = Path(temp)
            with self.assertRaises(runner.TerminationRequested):
                runner.run_bounded(
                    ["ignored"],
                    cwd=root,
                    env={},
                    timeout=10,
                    stdout_path=root / "stdout",
                    stderr_path=root / "stderr",
                )
        killpg.assert_called_once_with(43210, signal.SIGTERM)
        process.wait.assert_called_once()

    def test_pending_signal_at_spawn_unmask_still_cleans_child_group(self) -> None:
        process = mock.Mock()
        process.pid = 54321
        process.poll.return_value = None
        process.wait.return_value = 0
        context_count = 0

        @contextmanager
        def deliver_signal_once() -> Iterator[None]:
            nonlocal context_count
            context_count += 1
            current = context_count
            yield
            if current == 1:
                runner.handle_termination_signal(signal.SIGTERM, None)

        with tempfile.TemporaryDirectory() as temp, mock.patch.object(
            runner.subprocess, "Popen", return_value=process
        ), mock.patch.object(
            runner, "blocked_termination_signals", deliver_signal_once
        ), mock.patch.object(runner.os, "killpg") as killpg:
            root = Path(temp)
            with self.assertRaises(runner.TerminationRequested):
                runner.run_bounded(
                    ["ignored"],
                    cwd=root,
                    env={},
                    timeout=10,
                    stdout_path=root / "stdout",
                    stderr_path=root / "stderr",
                )

        self.assertGreaterEqual(context_count, 2)
        self.assertEqual(
            killpg.call_args_list,
            [
                mock.call(54321, signal.SIGTERM),
                mock.call(54321, signal.SIGTERM),
            ],
        )
        process.wait.assert_called_once()
        self.assertIsNone(runner._ACTIVE_PROCESS)

    def test_terminate_process_group_blocks_signals_through_kill_and_reap(self) -> None:
        process = mock.Mock()
        process.pid = 65432
        process.poll.return_value = None
        signals_blocked = False

        @contextmanager
        def tracked_signal_block() -> Iterator[None]:
            nonlocal signals_blocked
            signals_blocked = True
            try:
                yield
            finally:
                signals_blocked = False

        wait_count = 0

        def wait(*, timeout: float | None = None) -> int:
            nonlocal wait_count
            self.assertTrue(signals_blocked)
            wait_count += 1
            if wait_count == 1:
                raise runner.subprocess.TimeoutExpired("ignored", timeout)
            return 0

        process.wait.side_effect = wait
        with mock.patch.object(
            runner, "blocked_termination_signals", tracked_signal_block
        ), mock.patch.object(runner.os, "killpg") as killpg:
            runner.terminate_process_group(process, grace_seconds=0.01)

        self.assertFalse(signals_blocked)
        self.assertEqual(
            killpg.call_args_list,
            [
                mock.call(65432, signal.SIGTERM),
                mock.call(65432, signal.SIGKILL),
            ],
        )
        self.assertEqual(wait_count, 2)


class StatusTests(unittest.TestCase):
    def test_each_status_replaces_stale_branch_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = test_config(root)
            runner.update_status(
                config,
                stage="complete",
                outcome="published",
                runId="old-run",
                newMemoryItemCount=4,
            )
            runner.update_status(
                config,
                stage="complete",
                outcome="exists",
                message="already exists",
            )
            status = runner.read_json(config.state_dir / "status.json")
            self.assertEqual(status["outcome"], "exists")
            self.assertNotIn("runId", status)
            self.assertNotIn("newMemoryItemCount", status)

    def test_existing_briefing_preserves_recovery_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = test_config(root)
            config.credential_file.write_text(
                "CLOUD_AUTOMATION_SECRET=test-secret\n", encoding="utf-8"
            )
            today = dt.datetime.now(PACIFIC).date().isoformat()
            existing = {
                "briefingDate": today,
                "snapshotUpdatedAt": 123,
                "inputSummary": {
                    "recoveryStatus": "fresh",
                    "recoveryFreshnessPolicy": runner.RECOVERY_FRESHNESS_POLICY,
                    "recoveryEvaluationDate": today,
                    "recoveryReadinessDay": today,
                    "recoverySleepDay": today,
                },
            }
            cloud = mock.Mock()
            cloud.request.return_value = (200, {"briefing": existing})

            with mock.patch.object(runner, "CloudClient", return_value=cloud):
                result = runner.run(
                    config, runner.parse_args(["--ignore-schedule", "--dry-run"])
                )

            self.assertEqual(result, runner.EXIT_OK)
            status = runner.read_json(config.state_dir / "status.json")
            self.assertEqual(status["outcome"], "exists")
            self.assertEqual(status["recoveryStatus"], "fresh")
            self.assertEqual(
                status["recoveryFreshnessPolicy"],
                runner.RECOVERY_FRESHNESS_POLICY,
            )
            self.assertEqual(status["recoveryEvaluationDate"], today)
            self.assertEqual(status["recoveryReadinessDay"], today)
            self.assertEqual(status["recoverySleepDay"], today)

    def test_legacy_existing_briefing_tolerates_missing_diagnostics(self) -> None:
        diagnostics = runner.briefing_recovery_diagnostics(
            {
                "inputSummary": {
                    "recoveryStatus": "stale",
                    "recoveryFreshnessPolicy": "elapsed_hours_v1",
                }
            }
        )

        self.assertEqual(diagnostics, {"recoveryStatus": "stale"})


class SchedulingTests(unittest.TestCase):
    def test_daily_gate(self) -> None:
        self.assertFalse(
            runner.is_schedule_ready(
                dt.datetime(2026, 8, 1, 10, 29, tzinfo=PACIFIC), 10, 30
            )
        )
        self.assertTrue(
            runner.is_schedule_ready(
                dt.datetime(2026, 8, 1, 10, 30, tzinfo=PACIFIC), 10, 30
            )
        )

    def test_oura_grace_window(self) -> None:
        self.assertTrue(
            runner.is_before_oura_grace(
                dt.datetime(2026, 8, 1, 11, 59, tzinfo=PACIFIC), 12
            )
        )
        self.assertFalse(
            runner.is_before_oura_grace(
                dt.datetime(2026, 8, 1, 12, 0, tzinfo=PACIFIC), 12
            )
        )

    def test_ignore_schedule_does_not_override_oura_grace(self) -> None:
        before_grace = dt.datetime(2026, 8, 1, 9, 0, tzinfo=PACIFIC)

        self.assertTrue(
            runner.should_wait_for_oura(
                "stale", before_grace, 12, force=False
            )
        )
        self.assertTrue(
            runner.should_wait_for_oura(
                "unavailable", before_grace, 12, force=False
            )
        )
        self.assertFalse(
            runner.should_wait_for_oura("fresh", before_grace, 12, force=False)
        )
        self.assertFalse(
            runner.should_wait_for_oura("stale", before_grace, 12, force=True)
        )

    def test_memory_calendar_windows_follow_pacific_boundaries(self) -> None:
        self.assertEqual(
            runner.add_calendar_days_ms(pacific_ms(2026, 3, 1), 14),
            pacific_ms(2026, 3, 15),
        )
        self.assertEqual(
            runner.add_calendar_months_ms(pacific_ms(2026, 10, 31), 4),
            pacific_ms(2027, 3, 3),
        )


class InputValidationTests(unittest.TestCase):
    def test_snapshot_facts(self) -> None:
        now = dt.datetime(2026, 8, 1, 12, 0, tzinfo=PACIFIC)
        updated_at = int(now.timestamp() * 1000)
        facts = runner.validate_snapshot(snapshot_body(updated_at), now.date())
        self.assertEqual(facts.updated_at, updated_at)
        self.assertEqual(len(facts.completed_workouts), 1)
        self.assertEqual(len(facts.logged_sets), 1)

    def test_stale_snapshot_waits_instead_of_generating(self) -> None:
        now = dt.datetime(2026, 8, 20, 12, 0, tzinfo=PACIFIC)
        old = dt.datetime(2026, 8, 1, 12, 0, tzinfo=PACIFIC)
        with self.assertRaises(runner.WaitingError):
            runner.validate_snapshot(snapshot_body(int(old.timestamp() * 1000)), now.date())

    def test_recovery_staleness_is_recomputed(self) -> None:
        now = dt.datetime(2026, 8, 2, 12, 0, tzinfo=PACIFIC)
        raw = {
            "status": "fresh",
            "latestReadiness": {
                "day": "2026-08-01",
                "score": 80,
                "observedAt": "2026-08-01T08:00:00-07:00",
                "isStale": False,
            },
            "latestSleep": {
                "day": "2026-08-01",
                "score": 75,
                "totalSleepHours": 7.0,
                "observedAt": "2026-08-01T08:00:00-07:00",
                "isStale": False,
            },
        }
        sanitized = runner.sanitize_recovery(raw, now)
        self.assertEqual(sanitized["status"], "stale")
        self.assertTrue(sanitized["latestReadiness"]["isStale"])

    def test_current_pacific_day_is_fresh_despite_midnight_utc_marker(self) -> None:
        now = dt.datetime(2026, 8, 5, 20, 41, tzinfo=PACIFIC)
        raw = {
            "status": "stale",
            "latestReadiness": {
                "day": "2026-08-05",
                "score": 75,
                "observedAt": "2026-08-05T00:00:00+00:00",
                "isStale": True,
            },
            "latestSleep": {
                "day": "2026-08-05",
                "score": 78,
                "observedAt": "2026-08-05T00:00:00+00:00",
                "isStale": True,
            },
        }

        sanitized = runner.sanitize_recovery(raw, now)

        self.assertEqual(sanitized["status"], "fresh")
        self.assertFalse(sanitized["latestReadiness"]["isStale"])
        self.assertIsNone(sanitized["latestReadiness"]["ageHours"])
        self.assertIsNone(sanitized["latestReadiness"]["observedAt"])
        self.assertEqual(
            sanitized["latestReadiness"]["freshnessBasis"], "pacific_day"
        )
        self.assertNotIn("staleAfterHours", sanitized)

    def test_prior_pacific_day_is_stale_even_with_recent_timestamp(self) -> None:
        now = dt.datetime(2026, 8, 2, 0, 30, tzinfo=PACIFIC)
        raw = {
            "latestReadiness": {
                "day": "2026-08-01",
                "score": 80,
                "observedAt": "2026-08-02T06:00:00+00:00",
            },
            "latestSleep": {
                "day": "2026-08-01",
                "score": 75,
                "observedAt": "2026-08-02T06:00:00+00:00",
            },
        }

        sanitized = runner.sanitize_recovery(raw, now)

        self.assertEqual(sanitized["status"], "stale")
        self.assertTrue(sanitized["latestSleep"]["isStale"])

    def test_mixed_daily_record_days_are_never_fresh(self) -> None:
        now = dt.datetime(2026, 8, 2, 12, 0, tzinfo=PACIFIC)
        raw = {
            "latestReadiness": {
                "day": "2026-08-01",
                "score": 80,
                "observedAt": "2026-08-01T00:00:00+00:00",
            },
            "latestSleep": {
                "day": "2026-08-02",
                "score": 75,
                "observedAt": "2026-08-02T00:00:00+00:00",
            },
        }

        sanitized = runner.sanitize_recovery(raw, now)

        self.assertEqual(sanitized["status"], "stale")
        self.assertEqual(sanitized["latestReadiness"]["day"], "2026-08-01")
        self.assertEqual(sanitized["latestSleep"]["day"], "2026-08-02")

    def test_sleep_uses_actual_bedtime_end_for_observation_metadata(self) -> None:
        now = dt.datetime(2026, 8, 5, 12, 0, tzinfo=PACIFIC)
        raw = {
            "day": "2026-08-05",
            "score": 78,
            "observedAt": "2026-08-05T00:00:00+00:00",
            "bedtimeEnd": "2026-08-05T08:15:34-07:00",
        }

        sanitized = runner.sanitized_recovery_record(raw, now, sleep=True)

        self.assertIsNotNone(sanitized)
        self.assertEqual(
            sanitized["observedAt"], "2026-08-05T08:15:34-07:00"
        )
        self.assertEqual(
            sanitized["bedtimeEnd"], "2026-08-05T08:15:34-07:00"
        )

    def test_future_recovery_day_is_rejected(self) -> None:
        now = dt.datetime(2026, 8, 5, 12, 0, tzinfo=PACIFIC)
        raw = {
            "day": "2026-08-06",
            "score": 80,
            "observedAt": "2026-08-06T00:00:00+00:00",
        }

        self.assertIsNone(
            runner.sanitized_recovery_record(raw, now, sleep=False)
        )

    def test_present_invalid_recovery_day_is_rejected(self) -> None:
        now = dt.datetime(2026, 8, 5, 12, 0, tzinfo=PACIFIC)
        for invalid_day in ("2026-02-30", "2026-8-05", "", 20260805):
            with self.subTest(day=invalid_day):
                raw = {
                    "day": invalid_day,
                    "score": 80,
                    "observedAt": "2026-08-05T11:00:00-07:00",
                }
                self.assertIsNone(
                    runner.sanitized_recovery_record(raw, now, sleep=False)
                )

    def test_missing_day_uses_bounded_legacy_timestamp_fallback(self) -> None:
        now = dt.datetime(2026, 8, 5, 12, 0, tzinfo=PACIFIC)
        at_boundary = {
            "score": 80,
            "observedAt": "2026-08-04T12:00:00-07:00",
        }
        beyond_boundary = {
            "score": 80,
            "observedAt": "2026-08-04T11:59:59-07:00",
        }
        future = {
            "score": 80,
            "observedAt": "2026-08-05T12:00:01-07:00",
        }

        at_boundary_record = runner.sanitized_recovery_record(
            at_boundary, now, sleep=False
        )
        beyond_boundary_record = runner.sanitized_recovery_record(
            beyond_boundary, now, sleep=False
        )

        self.assertIsNotNone(at_boundary_record)
        self.assertFalse(at_boundary_record["isStale"])
        self.assertEqual(at_boundary_record["ageHours"], 24.0)
        self.assertEqual(
            at_boundary_record["freshnessBasis"], "elapsed_hours_legacy"
        )
        self.assertIsNotNone(beyond_boundary_record)
        self.assertTrue(beyond_boundary_record["isStale"])
        self.assertIsNone(
            runner.sanitized_recovery_record(future, now, sleep=False)
        )

    def test_pacific_midnight_and_dst_dates_use_calendar_day(self) -> None:
        raw = {
            "day": "2026-11-01",
            "score": 80,
            "observedAt": "2026-11-01T00:00:00+00:00",
        }
        before_midnight = dt.datetime(2026, 11, 1, 23, 59, tzinfo=PACIFIC)
        after_midnight = dt.datetime(2026, 11, 2, 0, 0, tzinfo=PACIFIC)

        current = runner.sanitized_recovery_record(
            raw, before_midnight, sleep=False
        )
        prior = runner.sanitized_recovery_record(raw, after_midnight, sleep=False)

        self.assertIsNotNone(current)
        self.assertFalse(current["isStale"])
        self.assertIsNotNone(prior)
        self.assertTrue(prior["isStale"])

    def test_recovery_summary_uses_neutral_trusted_wording(self) -> None:
        fresh = {
            "status": "fresh",
            "latestReadiness": {"score": 80, "ageHours": 4.0},
            "latestSleep": {
                "score": 75,
                "totalSleepHours": 6.2,
                "ageHours": 4.0,
            },
        }
        stale = {
            "status": "stale",
            "latestReadiness": {
                "day": "2026-08-01",
                "score": 80,
                "ageHours": None,
                "isStale": True,
            },
            "latestSleep": {
                "day": "2026-08-01",
                "score": 75,
                "ageHours": None,
                "isStale": True,
            },
        }

        self.assertEqual(
            runner.trusted_recovery_summary(fresh),
            "Oura estimate: 6.2 h sleep and readiness score 80; use as context, not a diagnosis.",
        )
        self.assertEqual(
            runner.trusted_recovery_summary(stale),
            "Oura data are from 2026-08-01; use workout history for this call.",
        )
        mismatched = {
            "status": "stale",
            "latestReadiness": {
                "day": "2026-08-01",
                "score": 80,
                "isStale": True,
            },
            "latestSleep": {
                "day": "2026-08-02",
                "score": 75,
                "isStale": False,
            },
        }
        self.assertEqual(
            runner.trusted_recovery_summary(mismatched),
            "Oura daily records do not match (readiness 2026-08-01; sleep 2026-08-02); use workout history for this call.",
        )
        self.assertEqual(
            runner.trusted_recovery_summary({"status": "unavailable"}),
            "Oura unavailable; use workout history only.",
        )

    def test_recovery_sanitizer_drops_impossible_scores_and_sleep_duration(self) -> None:
        now = dt.datetime(2026, 8, 1, 12, 0, tzinfo=PACIFIC)
        raw = {
            "latestReadiness": {
                "day": "2026-08-01",
                "score": 101,
                "observedAt": "2026-08-01T08:00:00-07:00",
            },
            "latestSleep": {
                "day": "2026-08-01",
                "score": -1,
                "totalSleepHours": 25,
                "observedAt": "2026-08-01T08:00:00-07:00",
            },
        }

        sanitized = runner.sanitize_recovery(raw, now)

        self.assertEqual(sanitized["status"], "unavailable")
        self.assertIsNone(sanitized["latestReadiness"])
        self.assertIsNone(sanitized["latestSleep"])


class OutputValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        now = dt.datetime(2026, 8, 1, 12, 0, tzinfo=PACIFIC)
        self.updated_at = int(now.timestamp() * 1000)
        self.facts = runner.validate_snapshot(snapshot_body(self.updated_at), now.date())
        self.recovery = {
            "generatedAt": now.isoformat(),
            "status": "fresh",
            "freshnessPolicy": runner.RECOVERY_FRESHNESS_POLICY,
            "evaluationDate": "2026-08-01",
            "latestReadiness": {
                "day": "2026-08-01",
                "score": 80,
                "observedAt": "2026-08-01T08:00:00-07:00",
            },
            "latestSleep": {
                "day": "2026-08-01",
                "score": 75,
                "observedAt": "2026-08-01T08:10:00-07:00",
            },
        }

    def facts_with_memory(
        self,
        *,
        current_context: str = "trusted context",
        paused: bool = False,
        window_started_at: int | None = None,
        four_month_started_at: int | None = None,
        notes: list[dict] | None = None,
        summaries: list[dict] | None = None,
    ) -> runner.SnapshotFacts:
        body = snapshot_body(self.updated_at)
        data = body["snapshot"]["payload"]["data"]
        if window_started_at is not None:
            data["aiMemorySettings"] = [
                {
                    "id": "default",
                    "currentContext": current_context,
                    "paused": paused,
                    "windowStartedAt": window_started_at,
                    "fourMonthStartedAt": four_month_started_at
                    if four_month_started_at is not None
                    else window_started_at,
                    "createdAt": window_started_at,
                    "updatedAt": self.updated_at,
                }
            ]
        data["aiNotes"] = notes or []
        data["aiMemorySummaries"] = summaries or []
        return runner.validate_snapshot(body, dt.date(2026, 8, 1))

    def validate(
        self,
        output: dict,
        memory: dict | None = None,
        *,
        facts: runner.SnapshotFacts | None = None,
        today: str = "2026-08-01",
        generated_at: int | None = None,
    ) -> dict:
        memory_body = dict(memory) if memory is not None else {"state": None, "items": []}
        memory_body.setdefault("revision", 0)
        return runner.validate_model_output(
            output,
            facts=facts or self.facts,
            memory_body=memory_body,
            recovery=self.recovery,
            today=today,
            run_id="test-run",
            prompt_hash="abc123",
            model=runner.DEFAULT_CODEX_MODEL,
            reasoning_effort="xhigh",
            codex_version="codex-cli test",
            generated_at=(
                generated_at if generated_at is not None else self.updated_at + 1
            ),
        )

    def test_supervisor_constructs_all_briefing_metadata(self) -> None:
        validated = self.validate(model_output(self.updated_at))
        briefing = validated["briefing"]
        self.assertEqual(briefing["source"], "codex-local")
        self.assertEqual(briefing["model"], runner.DEFAULT_CODEX_MODEL)
        self.assertEqual(briefing["snapshotUpdatedAt"], self.updated_at)
        self.assertEqual(briefing["inputSummary"]["modelReasoningEffort"], "xhigh")
        self.assertEqual(briefing["inputSummary"]["workoutCount"], 1)
        self.assertEqual(briefing["inputSummary"]["newMemoryItemCount"], 1)
        self.assertEqual(briefing["inputSummary"]["deferredMemoryItemIds"], [])
        self.assertEqual(
            briefing["inputSummary"]["recoveryFreshnessPolicy"],
            runner.RECOVERY_FRESHNESS_POLICY,
        )
        self.assertEqual(
            briefing["inputSummary"]["recoveryReadinessDay"], "2026-08-01"
        )
        self.assertEqual(
            briefing["inputSummary"]["recoverySleepDay"], "2026-08-01"
        )

    def test_supervisor_constructs_trusted_memory_state(self) -> None:
        snapshot_start = pacific_ms(2026, 7, 1)
        cloud_two_week_start = pacific_ms(2026, 7, 2)
        cloud_four_month_start = pacific_ms(2026, 7, 3)
        facts = self.facts_with_memory(
            current_context="trusted snapshot context",
            paused=True,
            window_started_at=snapshot_start,
        )
        output = model_output(self.updated_at)
        output["memory"]["newItems"] = []
        validated = self.validate(
            output,
            facts=facts,
            memory={
                "state": {
                    "currentContext": "cloud context",
                    "paused": False,
                    "windowStartedAt": cloud_two_week_start,
                    "fourMonthStartedAt": cloud_four_month_start,
                },
                "items": [],
            },
        )
        self.assertEqual(
            validated["memory"]["state"],
            {
                "currentContext": "trusted snapshot context",
                "paused": True,
                "windowStartedAt": cloud_two_week_start,
                "fourMonthStartedAt": cloud_four_month_start,
                "sourceSnapshotUpdatedAt": self.updated_at,
            },
        )

    def test_model_memory_state_is_rejected_as_an_extra_field(self) -> None:
        output = model_output(self.updated_at)
        output["memory"]["state"] = {
            "currentContext": "model replacement",
            "paused": False,
            "windowStartedAt": 1,
            "fourMonthStartedAt": 2,
            "sourceSnapshotUpdatedAt": -1,
        }
        with self.assertRaisesRegex(runner.ConfigError, "only newItems"):
            self.validate(output)

    def test_model_briefing_metadata_is_rejected(self) -> None:
        extras = {
            "source": "untrusted",
            "model": "untrusted",
            "snapshotUpdatedAt": self.updated_at,
            "inputSummary": {},
        }
        for field, value in extras.items():
            with self.subTest(field=field):
                output = model_output(self.updated_at)
                output["briefing"][field] = value
                with self.assertRaisesRegex(runner.ConfigError, "briefing must contain"):
                    self.validate(output)

    def test_extra_briefing_section_field_is_rejected(self) -> None:
        output = model_output(self.updated_at)
        output["briefing"]["sections"]["modelClaim"] = "untrusted"
        with self.assertRaisesRegex(runner.ConfigError, "invalid shape"):
            self.validate(output)

    def test_trusted_pause_rejects_model_items(self) -> None:
        facts = self.facts_with_memory(
            paused=True,
            window_started_at=pacific_ms(2026, 8, 1),
        )
        output = model_output(self.updated_at)
        with self.assertRaisesRegex(runner.ConfigError, "Paused memory"):
            self.validate(output, facts=facts)

    def test_nonexistent_workout_provenance_is_rejected(self) -> None:
        output = model_output(self.updated_at)
        item = output["memory"]["newItems"][0]
        item["id"] = "workout:not-in-snapshot"
        item["sourceWorkoutSessionId"] = "not-in-snapshot"
        item["sourceSessionIds"] = ["not-in-snapshot"]
        with self.assertRaisesRegex(runner.ConfigError, "omitted required memory item"):
            self.validate(output)

    def test_workout_period_and_sources_are_canonical(self) -> None:
        mutations = {
            "period": lambda item: item.__setitem__(
                "periodStartAt", item["periodStartAt"] - 1
            ),
            "workout source": lambda item: item.__setitem__(
                "sourceWorkoutSessionId", "not-in-snapshot"
            ),
            "session sources": lambda item: item.__setitem__(
                "sourceSessionIds", ["session-1", "not-in-snapshot"]
            ),
            "summary sources": lambda item: item.__setitem__(
                "sourceSummaryIds", ["not-a-summary"]
            ),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                output = model_output(self.updated_at)
                mutate(output["memory"]["newItems"][0])
                with self.assertRaises(runner.ConfigError):
                    self.validate(output)

    def test_workout_note_ids_must_exist_in_snapshot(self) -> None:
        output = model_output(self.updated_at)
        output["memory"]["newItems"][0]["sourceNoteIds"] = ["not-in-snapshot"]
        with self.assertRaisesRegex(runner.ConfigError, "unknown AI note"):
            self.validate(output)

    def test_runner_owns_new_item_metadata_and_timestamps(self) -> None:
        validated = self.validate(model_output(self.updated_at))
        new_item = validated["memory"]["items"][0]
        self.assertEqual(new_item["model"], runner.DEFAULT_CODEX_MODEL)
        self.assertEqual(new_item["createdAt"], self.updated_at + 1)
        self.assertEqual(new_item["updatedAt"], self.updated_at + 1)
        self.assertEqual(new_item["snapshotUpdatedAt"], self.updated_at)

    def test_model_new_item_metadata_is_rejected(self) -> None:
        extras = {
            "model": "model-controlled",
            "createdAt": 1,
            "updatedAt": 2,
            "snapshotUpdatedAt": self.updated_at,
        }
        for field, value in extras.items():
            with self.subTest(field=field):
                output = model_output(self.updated_at)
                output["memory"]["newItems"][0][field] = value
                with self.assertRaisesRegex(runner.ConfigError, "candidate content fields"):
                    self.validate(output)

    def test_two_week_summary_has_canonical_period_sources_and_cursor(self) -> None:
        start = pacific_ms(2026, 7, 1)
        end = pacific_ms(2026, 7, 15)
        note = {
            "id": "note-in-window",
            "body": "Relevant context",
            "createdAt": pacific_ms(2026, 7, 5),
            "updatedAt": pacific_ms(2026, 7, 5),
        }
        later_note = {
            "id": "note-outside-window",
            "body": "Later context",
            "createdAt": pacific_ms(2026, 7, 20),
            "updatedAt": pacific_ms(2026, 7, 20),
        }
        facts = self.facts_with_memory(
            window_started_at=start,
            notes=[note, later_note],
        )
        output = model_output(self.updated_at)
        output["memory"]["newItems"].append(
            summary_item(
                "two_week",
                start,
                end,
                source_note_ids=["note-in-window"],
            )
        )
        validated = self.validate(output, facts=facts)
        summary = validated["memory"]["items"][-1]
        self.assertEqual(summary["id"], f"two_week:{start}:{end}")
        self.assertEqual(summary["sourceSessionIds"], [])
        self.assertEqual(summary["sourceNoteIds"], ["note-in-window"])
        self.assertEqual(validated["memory"]["state"]["windowStartedAt"], end)

        invalid = model_output(self.updated_at)
        invalid_summary = summary_item(
            "two_week",
            start,
            end,
            source_session_ids=["session-1"],
            source_note_ids=["note-in-window"],
        )
        invalid["memory"]["newItems"].append(invalid_summary)
        with self.assertRaisesRegex(runner.ConfigError, "invalid sourceSessionIds"):
            self.validate(invalid, facts=facts)

        invalid_note = model_output(self.updated_at)
        invalid_note["memory"]["newItems"].append(
            summary_item(
                "two_week",
                start,
                end,
                source_note_ids=["note-outside-window"],
            )
        )
        with self.assertRaisesRegex(runner.ConfigError, "unknown AI note"):
            self.validate(invalid_note, facts=facts)

    def test_omitted_two_week_summary_is_deferred_without_advancing_cursor(self) -> None:
        start = pacific_ms(2026, 7, 1)
        end = pacific_ms(2026, 7, 15)
        facts = self.facts_with_memory(window_started_at=start)

        validated = self.validate(model_output(self.updated_at), facts=facts)

        self.assertEqual(validated["memory"]["state"]["windowStartedAt"], start)
        self.assertEqual(
            validated["briefing"]["inputSummary"]["deferredMemoryItemIds"],
            [f"two_week:{start}:{end}"],
        )
        self.assertEqual(
            [item["memoryType"] for item in validated["memory"]["items"]],
            ["workout"],
        )

    def test_deferred_two_week_summary_blocks_dependent_four_month_rollup(self) -> None:
        two_week_start = pacific_ms(2026, 7, 18)
        two_week_end = pacific_ms(2026, 8, 1)
        four_month_start = pacific_ms(2026, 4, 1)
        four_month_end = pacific_ms(2026, 8, 1)
        facts = self.facts_with_memory(
            window_started_at=two_week_start,
            four_month_started_at=four_month_start,
        )

        validated = self.validate(model_output(self.updated_at), facts=facts)

        self.assertEqual(
            validated["memory"]["state"]["windowStartedAt"], two_week_start
        )
        self.assertEqual(
            validated["memory"]["state"]["fourMonthStartedAt"],
            four_month_start,
        )
        self.assertEqual(
            validated["briefing"]["inputSummary"]["deferredMemoryItemIds"],
            [
                f"two_week:{two_week_start}:{two_week_end}",
                f"four_month:{four_month_start}:{four_month_end}",
            ],
        )

        invalid = model_output(self.updated_at)
        invalid["memory"]["newItems"].append(
            summary_item(
                "four_month",
                four_month_start,
                four_month_end,
                source_summary_ids=[
                    f"two_week:{two_week_start}:{two_week_end}"
                ],
            )
        )
        with self.assertRaisesRegex(runner.ConfigError, "deferred summary"):
            self.validate(invalid, facts=facts)

    def test_valid_two_week_can_advance_while_four_month_is_deferred(self) -> None:
        two_week_start = pacific_ms(2026, 7, 18)
        two_week_end = pacific_ms(2026, 8, 1)
        four_month_start = pacific_ms(2026, 4, 1)
        four_month_end = pacific_ms(2026, 8, 1)
        facts = self.facts_with_memory(
            window_started_at=two_week_start,
            four_month_started_at=four_month_start,
        )
        output = model_output(self.updated_at)
        output["memory"]["newItems"].append(
            summary_item("two_week", two_week_start, two_week_end)
        )

        validated = self.validate(output, facts=facts)

        self.assertEqual(
            validated["memory"]["state"]["windowStartedAt"], two_week_end
        )
        self.assertEqual(
            validated["memory"]["state"]["fourMonthStartedAt"],
            four_month_start,
        )
        self.assertEqual(
            validated["briefing"]["inputSummary"]["deferredMemoryItemIds"],
            [f"four_month:{four_month_start}:{four_month_end}"],
        )

    def test_prompt_includes_supervisor_candidate_plan_as_untrusted_data(self) -> None:
        start = pacific_ms(2026, 7, 1)
        facts = self.facts_with_memory(window_started_at=start)
        with tempfile.TemporaryDirectory() as temp:
            config = test_config(Path(temp))
            prompt = runner.build_model_prompt(
                config,
                facts=facts,
                today="2026-08-01",
                now=dt.datetime(2026, 8, 1, 10, 30, tzinfo=PACIFIC),
                run_id="test-run",
                prompt_hash="abc123",
                snapshot_body={"snapshot": facts.snapshot},
                memory_body={"revision": 0, "state": None, "items": []},
                recovery=self.recovery,
            )

        trusted_start = prompt.index("## Trusted run context")
        untrusted_start = prompt.index("## Untrusted input data")
        plan_start = prompt.index('"supervisorCandidatePlan"')
        self.assertLess(trusted_start, untrusted_start)
        self.assertLess(untrusted_start, plan_start)
        self.assertIn(f'"id":"two_week:{start}:{pacific_ms(2026, 7, 15)}"', prompt)

        instructions = config.prompt_file.read_text(encoding="utf-8")
        self.assertIn("exercise performance must match a movement in today's session", instructions)
        self.assertIn("Use one reason when that is all the relevant evidence", instructions)

    def test_prompt_redacts_stale_recovery_measurements(self) -> None:
        stale = {
            "generatedAt": "2026-08-01T10:30:00-07:00",
            "status": "stale",
            "freshnessPolicy": runner.RECOVERY_FRESHNESS_POLICY,
            "evaluationDate": "2026-08-01",
            "latestReadiness": {"score": 80, "ageHours": 26.5},
            "latestSleep": {"totalSleepHours": 6.2, "ageHours": 26.0},
        }
        with tempfile.TemporaryDirectory() as temp:
            config = test_config(Path(temp))
            prompt = runner.build_model_prompt(
                config,
                facts=self.facts,
                today="2026-08-01",
                now=dt.datetime(2026, 8, 1, 10, 30, tzinfo=PACIFIC),
                run_id="test-run",
                prompt_hash="abc123",
                snapshot_body={"snapshot": self.facts.snapshot},
                memory_body={"revision": 0, "state": None, "items": []},
                recovery=stale,
            )

        self.assertIn('"status":"stale"', prompt)
        self.assertIn('"latestReadiness":null', prompt)
        self.assertIn('"latestSleep":null', prompt)
        self.assertNotIn('"ageHours":26.5', prompt)

    def test_existing_exact_summary_advances_cursor_without_duplicate(self) -> None:
        start = pacific_ms(2026, 7, 18)
        end = pacific_ms(2026, 8, 1)
        facts = self.facts_with_memory(
            window_started_at=start,
            summaries=[
                {
                    "id": "existing-two-week",
                    "periodType": "two_week",
                    "periodStartAt": start,
                    "periodEndAt": end,
                    "bullets": ["Existing summary"],
                    "sourceSessionIds": [],
                    "sourceNoteIds": [],
                    "sourceSummaryIds": [],
                    "model": "codex",
                    "createdAt": end,
                    "updatedAt": end,
                }
            ],
        )
        validated = self.validate(model_output(self.updated_at), facts=facts)
        self.assertEqual(validated["memory"]["state"]["windowStartedAt"], end)
        self.assertEqual(
            [item["memoryType"] for item in validated["memory"]["items"]],
            ["workout"],
        )

    def test_four_month_summary_requires_exact_trusted_summary_sources(self) -> None:
        start = pacific_ms(2026, 4, 1)
        end = pacific_ms(2026, 8, 1)
        facts = self.facts_with_memory(
            window_started_at=end,
            four_month_started_at=start,
            summaries=[
                {
                    "id": "trusted-two-week",
                    "periodType": "two_week",
                    "periodStartAt": pacific_ms(2026, 5, 1),
                    "periodEndAt": pacific_ms(2026, 5, 15),
                    "bullets": ["Trusted summary"],
                    "sourceSessionIds": [],
                    "sourceNoteIds": [],
                    "sourceSummaryIds": [],
                    "model": "codex",
                    "createdAt": end,
                    "updatedAt": end,
                }
            ],
        )
        output = model_output(self.updated_at)
        output["memory"]["newItems"].append(
            summary_item(
                "four_month",
                start,
                end,
                source_summary_ids=["trusted-two-week"],
            )
        )
        validated = self.validate(output, facts=facts)
        self.assertEqual(
            validated["memory"]["state"]["fourMonthStartedAt"], end
        )

        invalid = model_output(self.updated_at)
        invalid["memory"]["newItems"].append(
            summary_item(
                "four_month",
                start,
                end,
                source_summary_ids=["not-in-snapshot"],
            )
        )
        with self.assertRaisesRegex(runner.ConfigError, "invalid sourceSummaryIds"):
            self.validate(invalid, facts=facts)

    def test_trusted_window_must_be_a_pacific_day_boundary(self) -> None:
        facts = self.facts_with_memory(
            window_started_at=pacific_ms(2026, 7, 1, 1),
        )
        with self.assertRaisesRegex(runner.ConfigError, "Pacific day boundary"):
            self.validate(model_output(self.updated_at), facts=facts)

    def test_existing_memory_is_never_resent_or_overwritten(self) -> None:
        existing = {
            "id": "workout:older",
            "memoryType": "workout",
            "periodStartAt": 1,
            "periodEndAt": 2,
            "sourceWorkoutSessionId": "older",
            "bullets": ["Original bullet"],
            "sourceSessionIds": ["older"],
            "sourceNoteIds": [],
            "sourceSummaryIds": [],
            "model": "codex",
            "createdAt": 1,
            "updatedAt": 2,
            "snapshotUpdatedAt": 3,
        }
        validated = self.validate(
            model_output(self.updated_at),
            memory={"state": None, "items": [existing]},
        )
        self.assertEqual(
            [item["id"] for item in validated["memory"]["items"]],
            ["workout:session-1"],
        )
        self.assertEqual(existing["bullets"], ["Original bullet"])

    def test_supervisor_owns_recovery_status_and_presentation(self) -> None:
        validated = self.validate(model_output(self.updated_at))
        sections = validated["briefing"]["sections"]
        self.assertEqual(sections["recoveryStatus"], "fresh")
        self.assertEqual(
            sections["ouraRecovery"],
            "Oura estimate: sleep score 75 and readiness score 80; use as context, not a diagnosis.",
        )

        for field in ("recoveryStatus", "ouraRecovery"):
            with self.subTest(field=field):
                output = model_output(self.updated_at)
                output["briefing"]["sections"][field] = "model-controlled"
                with self.assertRaisesRegex(runner.ConfigError, "invalid shape"):
                    self.validate(output)

    def test_briefing_copy_is_rejected_instead_of_silently_truncated(self) -> None:
        mutations = {
            "headline": lambda output: output["briefing"].__setitem__(
                "headline", "h" * (runner.BRIEFING_HEADLINE_MAX + 1)
            ),
            "today's call": lambda output: output["briefing"]["sections"].__setitem__(
                "todaysCall", "c" * (runner.BRIEFING_TODAYS_CALL_MAX + 1)
            ),
            "reason": lambda output: output["briefing"]["sections"]["why"].__setitem__(
                0, "r" * (runner.BRIEFING_REASON_MAX + 1)
            ),
            "trend": lambda output: output["briefing"]["sections"].__setitem__(
                "trainingTrend", "t" * (runner.BRIEFING_TREND_MAX + 1)
            ),
            "watch-out": lambda output: output["briefing"]["sections"].__setitem__(
                "watchOuts", ["w" * (runner.BRIEFING_WATCH_OUT_MAX + 1)]
            ),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                output = model_output(self.updated_at)
                mutate(output)
                with self.assertRaises(runner.ConfigError):
                    self.validate(output)

    def test_briefing_requires_one_or_two_reasons_and_one_model_guardrail(self) -> None:
        for reasons in ([], ["one", "two", "three"]):
            with self.subTest(reasons=reasons):
                output = model_output(self.updated_at)
                output["briefing"]["sections"]["why"] = reasons
                with self.assertRaises(runner.ConfigError):
                    self.validate(output)

        output = model_output(self.updated_at)
        output["briefing"]["sections"]["why"] = ["one"]
        self.assertEqual(
            self.validate(output)["briefing"]["sections"]["why"], ["one"]
        )

        output = model_output(self.updated_at)
        output["briefing"]["sections"]["why"] = ["same", " same "]
        self.assertEqual(
            self.validate(output)["briefing"]["sections"]["why"], ["same"]
        )

        output = model_output(self.updated_at)
        output["briefing"]["sections"]["watchOuts"] = ["one", "two"]
        with self.assertRaisesRegex(runner.ConfigError, "too many items"):
            self.validate(output)

    def test_supervisor_adds_the_stale_snapshot_warning_once(self) -> None:
        generated = int(
            (
                dt.datetime.fromtimestamp(self.updated_at / 1000.0, PACIFIC)
                + dt.timedelta(hours=49)
            ).timestamp()
            * 1000
        )
        expected = (
            "Data last synced 2026-08-01; if you trained since then, open the app "
            "to sync before relying on this."
        )
        output = model_output(self.updated_at)
        output["briefing"]["sections"]["watchOuts"] = [
            "Workout data may be stale; sync before relying on this."
        ]

        validated = self.validate(output, generated_at=generated)

        self.assertEqual(validated["briefing"]["sections"]["watchOuts"], [expected])

    def test_snapshot_warning_starts_only_after_48_hours(self) -> None:
        snapshot_time = dt.datetime.fromtimestamp(self.updated_at / 1000.0, PACIFIC)
        at_boundary = int((snapshot_time + dt.timedelta(hours=48)).timestamp() * 1000)
        after_boundary = int(
            (snapshot_time + dt.timedelta(hours=48, milliseconds=1)).timestamp()
            * 1000
        )

        self.assertIsNone(runner.trusted_snapshot_warning(self.facts, at_boundary))
        self.assertIsNotNone(
            runner.trusted_snapshot_warning(self.facts, after_boundary)
        )

    def test_spool_requires_current_snapshot(self) -> None:
        validated = self.validate(model_output(self.updated_at))
        runner.validate_spool(
            validated,
            today="2026-08-01",
            snapshot_updated_at=self.updated_at,
            memory_revision=0,
            prompt_hash="abc123",
            model=runner.DEFAULT_CODEX_MODEL,
            reasoning_effort="xhigh",
        )
        with self.assertRaises(runner.ConfigError):
            runner.validate_spool(
                validated,
                today="2026-08-01",
                snapshot_updated_at=self.updated_at + 1,
                memory_revision=0,
                prompt_hash="abc123",
                model=runner.DEFAULT_CODEX_MODEL,
                reasoning_effort="xhigh",
            )

    def test_spool_rejects_a_different_reasoning_effort(self) -> None:
        validated = self.validate(model_output(self.updated_at))
        with self.assertRaises(runner.ConfigError):
            runner.validate_spool(
                validated,
                today="2026-08-01",
                snapshot_updated_at=self.updated_at,
                memory_revision=0,
                prompt_hash="abc123",
                model=runner.DEFAULT_CODEX_MODEL,
                reasoning_effort="medium",
            )

    def test_spool_is_bound_to_memory_prompt_runner_and_validator_versions(self) -> None:
        mutations = {
            "expectedMemoryRevision": 9,
            "promptHash": "obsolete",
            "promptVersion": "obsolete",
            "runnerVersion": "obsolete",
            "validatorCompatibilityVersion": "obsolete",
            "recoveryFreshnessPolicy": "obsolete",
            "recoveryEvaluationDate": "2026-08-02",
        }
        for field, value in mutations.items():
            with self.subTest(field=field):
                validated = self.validate(model_output(self.updated_at))
                validated["manifest"][field] = value
                with self.assertRaises(runner.ConfigError):
                    runner.validate_spool(
                        validated,
                        today="2026-08-01",
                        snapshot_updated_at=self.updated_at,
                        memory_revision=0,
                        prompt_hash="abc123",
                        model=runner.DEFAULT_CODEX_MODEL,
                        reasoning_effort="xhigh",
                    )

    def test_spool_recovery_diagnostics_match_the_briefing(self) -> None:
        manifest_mutations = {
            "recoveryStatus": "invalid",
            "recoveryReadinessDay": "2026-08-02",
            "recoverySleepDay": "2026-08-02",
        }
        for field, value in manifest_mutations.items():
            with self.subTest(field=field):
                validated = self.validate(model_output(self.updated_at))
                validated["manifest"][field] = value
                with self.assertRaises(runner.ConfigError):
                    runner.validate_spool(
                        validated,
                        today="2026-08-01",
                        snapshot_updated_at=self.updated_at,
                        memory_revision=0,
                        prompt_hash="abc123",
                        model=runner.DEFAULT_CODEX_MODEL,
                        reasoning_effort="xhigh",
                    )

        validated = self.validate(model_output(self.updated_at))
        validated["briefing"]["inputSummary"]["recoveryStatus"] = "stale"
        with self.assertRaisesRegex(runner.ConfigError, "do not match"):
            runner.validate_spool(
                validated,
                today="2026-08-01",
                snapshot_updated_at=self.updated_at,
                memory_revision=0,
                prompt_hash="abc123",
                model=runner.DEFAULT_CODEX_MODEL,
                reasoning_effort="xhigh",
            )

        validated = self.validate(model_output(self.updated_at))
        validated["briefing"]["sections"]["recoveryStatus"] = "stale"
        with self.assertRaisesRegex(runner.ConfigError, "presentation"):
            runner.validate_spool(
                validated,
                today="2026-08-01",
                snapshot_updated_at=self.updated_at,
                memory_revision=0,
                prompt_hash="abc123",
                model=runner.DEFAULT_CODEX_MODEL,
                reasoning_effort="xhigh",
            )

    def test_rest_is_a_valid_supervisor_mode(self) -> None:
        output = model_output(self.updated_at)
        output["briefing"]["mode"] = "rest"
        output["briefing"]["headline"] = "Rest today and get the pain assessed"
        validated = self.validate(output)
        self.assertEqual(validated["briefing"]["mode"], "rest")

    def test_atomic_publish_sends_cas_and_verifies_the_commit(self) -> None:
        spool = self.validate(model_output(self.updated_at))

        class FakeCloud:
            def __init__(self) -> None:
                self.calls: list[tuple[str, str, object | None]] = []

            def request(
                self,
                method: str,
                path: str,
                *,
                body: object | None = None,
                expected: set[int] | None = None,
            ) -> tuple[int, object]:
                self.calls.append((method, path, body))
                if method == "PUT":
                    return 200, committed_publish_response(spool)
                if path.endswith("/briefing/2026-08-01"):
                    return 200, {
                        "briefing": committed_publish_response(spool)["briefing"]
                    }
                return 200, {
                    "revision": 1,
                    "state": spool["memory"]["state"],
                    "items": spool["memory"]["items"],
                }

        cloud = FakeCloud()
        runner.publish_spool(
            cloud, spool, logger=logging.getLogger("atomic-publish-test")
        )

        method, path, body = cloud.calls[0]
        self.assertEqual((method, path), ("PUT", "/api/cloud/publish/2026-08-01"))
        self.assertIsInstance(body, dict)
        assert isinstance(body, dict)
        self.assertEqual(body["publishId"], "test-run")
        self.assertEqual(body["expectedMemoryRevision"], 0)
        self.assertEqual(
            [item["id"] for item in body["memory"]["items"]],
            ["workout:session-1"],
        )

    def test_atomic_publish_tolerates_a_later_memory_revision(self) -> None:
        spool = self.validate(model_output(self.updated_at))

        class ConcurrentMemoryCloud:
            def request(
                self,
                method: str,
                path: str,
                **_kwargs: object,
            ) -> tuple[int, object]:
                if method == "PUT":
                    return 200, committed_publish_response(spool)
                if path.endswith("/briefing/2026-08-01"):
                    return 200, {
                        "briefing": committed_publish_response(spool)["briefing"]
                    }
                return 200, {
                    "revision": 2,
                    "state": {
                        "sourceSnapshotUpdatedAt": self_updated_at + 1,
                        "currentContext": "newer legitimate state",
                    },
                    "items": spool["memory"]["items"],
                }

        self_updated_at = self.updated_at
        runner.publish_spool(
            ConcurrentMemoryCloud(),
            spool,
            logger=logging.getLogger("concurrent-memory-publish-test"),
        )

    def test_atomic_publish_response_must_match_the_publish_id(self) -> None:
        spool = self.validate(model_output(self.updated_at))
        mismatched = committed_publish_response(spool)
        mismatched["publishId"] = "different-run"

        class MismatchedCloud:
            def request(self, *args: object, **kwargs: object) -> tuple[int, object]:
                return 200, mismatched

        with self.assertRaisesRegex(runner.TransientError, "publish ID"):
            runner.publish_spool(
                MismatchedCloud(),
                spool,
                logger=logging.getLogger("mismatched-publish-id-test"),
            )

    def test_atomic_publish_rejects_a_stale_compare_and_set(self) -> None:
        spool = self.validate(model_output(self.updated_at))

        class StaleCloud:
            def request(self, *args: object, **kwargs: object) -> tuple[int, object]:
                return 409, {"error": "stale_publish_state"}

        with self.assertRaises(runner.StalePublishError):
            runner.publish_spool(
                StaleCloud(),
                spool,
                logger=logging.getLogger("stale-publish-test"),
            )

    def test_prior_day_pending_upload_is_retried_after_rollover(self) -> None:
        spool = self.validate(model_output(self.updated_at))
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = test_config(root)
            spool_dir = config.state_dir / "spool"
            spool_dir.mkdir(parents=True)
            path = spool_dir / "2026-08-01.json"
            runner.atomic_write_json(path, spool)
            with mock.patch.object(runner, "publish_spool") as publish:
                runner.retry_prior_spools(
                    config,
                    object(),
                    today="2026-08-02",
                    run_id="retry-run",
                    prompt_hash="abc123",
                    logger=logging.getLogger("prior-spool-test"),
                )
            publish.assert_called_once()
            self.assertFalse(path.exists())

    def test_stale_prior_day_upload_is_quarantined(self) -> None:
        spool = self.validate(model_output(self.updated_at))
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = test_config(root)
            spool_dir = config.state_dir / "spool"
            spool_dir.mkdir(parents=True)
            path = spool_dir / "2026-08-01.json"
            runner.atomic_write_json(path, spool)
            with mock.patch.object(
                runner,
                "publish_spool",
                side_effect=runner.StalePublishError("stale"),
            ):
                runner.retry_prior_spools(
                    config,
                    object(),
                    today="2026-08-02",
                    run_id="retry-run",
                    prompt_hash="abc123",
                    logger=logging.getLogger("prior-spool-stale-test"),
                )
            self.assertFalse(path.exists())
            self.assertEqual(
                len(list(spool_dir.glob("2026-08-01.stale-retry-run.quarantine"))),
                1,
            )

    def test_transient_prior_day_failure_remains_pending_without_bubbling(self) -> None:
        spool = self.validate(model_output(self.updated_at))
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = test_config(root)
            spool_dir = config.state_dir / "spool"
            spool_dir.mkdir(parents=True)
            path = spool_dir / "2026-08-01.json"
            runner.atomic_write_json(path, spool)

            with mock.patch.object(
                runner,
                "publish_spool",
                side_effect=runner.TransientError("offline"),
            ):
                runner.retry_prior_spools(
                    config,
                    object(),
                    today="2026-08-02",
                    run_id="retry-run",
                    prompt_hash="abc123",
                    logger=logging.getLogger("prior-spool-transient-test"),
                )

            self.assertTrue(path.is_file())
            self.assertEqual(list(spool_dir.glob("*.quarantine")), [])

    def test_config_prior_day_failure_remains_pending_without_bubbling(self) -> None:
        spool = self.validate(model_output(self.updated_at))
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = test_config(root)
            spool_dir = config.state_dir / "spool"
            spool_dir.mkdir(parents=True)
            path = spool_dir / "2026-08-01.json"
            runner.atomic_write_json(path, spool)

            with mock.patch.object(
                runner,
                "publish_spool",
                side_effect=runner.ConfigError("server contract changed"),
            ):
                runner.retry_prior_spools(
                    config,
                    object(),
                    today="2026-08-02",
                    run_id="retry-run",
                    prompt_hash="abc123",
                    logger=logging.getLogger("prior-spool-config-test"),
                )

            self.assertTrue(path.is_file())
            self.assertEqual(list(spool_dir.glob("*.quarantine")), [])


class SchemaTests(unittest.TestCase):
    def test_schema_is_strict_at_every_object_boundary(self) -> None:
        schema_path = MODULE_PATH.parent / "codex_daily_briefing_output_schema.json"
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        self.assertFalse(schema["additionalProperties"])
        briefing = schema["properties"]["briefing"]
        memory = schema["properties"]["memory"]
        sections = briefing["properties"]["sections"]
        item = memory["properties"]["newItems"]["items"]
        self.assertFalse(briefing["additionalProperties"])
        self.assertFalse(sections["additionalProperties"])
        self.assertFalse(memory["additionalProperties"])
        self.assertFalse(item["additionalProperties"])
        self.assertEqual(set(briefing["properties"]), {"headline", "mode", "sections"})
        self.assertEqual(
            briefing["properties"]["headline"]["maxLength"],
            runner.BRIEFING_HEADLINE_MAX,
        )
        self.assertEqual(
            sections["properties"]["todaysCall"]["maxLength"],
            runner.BRIEFING_TODAYS_CALL_MAX,
        )
        self.assertEqual(sections["properties"]["why"]["minItems"], 1)
        self.assertEqual(sections["properties"]["why"]["maxItems"], 2)
        self.assertEqual(sections["properties"]["watchOuts"]["maxItems"], 1)
        # Codex Structured Outputs does not support uniqueItems. The supervisor
        # safely deduplicates reasons after generation instead.
        self.assertNotIn("uniqueItems", sections["properties"]["why"])
        self.assertNotIn("uniqueItems", sections["properties"]["watchOuts"])
        self.assertEqual(set(memory["properties"]), {"newItems"})
        self.assertEqual(
            set(item["properties"]),
            {
                "id",
                "memoryType",
                "periodStartAt",
                "periodEndAt",
                "sourceWorkoutSessionId",
                "bullets",
                "sourceSessionIds",
                "sourceNoteIds",
                "sourceSummaryIds",
            },
        )


if __name__ == "__main__":
    unittest.main()
