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
    for name in ("goals_1", "logs_2", "memories_1", "queue_1", "state_5"):
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


def recovery_fixture(
    now: dt.datetime,
    status: str,
    *,
    readiness_score: int = 80,
    sleep_score: int = 75,
    sleep_hours: float = 7.0,
) -> dict:
    today = now.astimezone(PACIFIC).date()
    if status == "unavailable":
        return {
            "generatedAt": now.isoformat(),
            "status": "unavailable",
            "freshnessPolicy": runner.RECOVERY_FRESHNESS_POLICY,
            "evaluationDate": today.isoformat(),
            "latestReadiness": None,
            "latestSleep": None,
        }
    record_day = today if status == "fresh" else today - dt.timedelta(days=1)
    observed_at = dt.datetime.combine(
        record_day, dt.time(8), tzinfo=PACIFIC
    ).isoformat()
    stale = status == "stale"
    return {
        "generatedAt": now.isoformat(),
        "status": status,
        "freshnessPolicy": runner.RECOVERY_FRESHNESS_POLICY,
        "evaluationDate": today.isoformat(),
        "latestReadiness": {
            "day": record_day.isoformat(),
            "score": float(readiness_score),
            "observedAt": observed_at,
            "ageHours": None,
            "freshnessBasis": "pacific_day",
            "isStale": stale,
        },
        "latestSleep": {
            "day": record_day.isoformat(),
            "score": float(sleep_score),
            "observedAt": observed_at,
            "ageHours": None,
            "freshnessBasis": "pacific_day",
            "isStale": stale,
            "totalSleepHours": sleep_hours,
            "bedtimeEnd": observed_at,
        },
    }


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
            "supportingEvidenceIds": [],
            "contradictingEvidenceIds": [],
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


def validated_spool_fixture(
    config: runner.Config,
    now: dt.datetime,
    recovery: dict,
) -> tuple[dict, int]:
    updated_at = int(now.timestamp() * 1000)
    facts = runner.validate_snapshot(snapshot_body(updated_at), now.date())
    spool = runner.validate_model_output(
        model_output(updated_at),
        facts=facts,
        memory_body={"revision": 0, "state": None, "items": []},
        recovery=recovery,
        today=now.date().isoformat(),
        run_id="pending-run",
        prompt_hash=runner.prompt_fingerprint(config),
        model=config.codex_model,
        reasoning_effort=config.codex_effort,
        codex_version="codex-cli test",
        generated_at=updated_at + 1,
    )
    return spool, updated_at


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

    def test_codex_home_accepts_only_exact_queue_database_names(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            codex_home = root / "codex-home"
            create_codex_home(codex_home)
            for suffix in ("", "-shm", "-wal"):
                (codex_home / f"queue_1.sqlite{suffix}").write_bytes(b"")

            runner.validate_codex_home(codex_home)

            (codex_home / "queue.sqlite").write_bytes(b"")
            with self.assertRaisesRegex(runner.ConfigError, "forbidden or unknown"):
                runner.validate_codex_home(codex_home)

    def test_invoke_codex_accepts_compatibility_diagnostic_and_revalidates_home(
        self,
    ) -> None:
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
                    {
                        "type": "item.completed",
                        "item": {
                            "id": "startup-diagnostic",
                            "type": "error",
                            "message": runner.CODEX_CODE_MODE_HOST_DISABLED_DIAGNOSTIC,
                        },
                    },
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
            audit = json.loads(
                (run_dir / "codex-events-audit.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                audit["compatibilityDiagnostics"], {"codeModeHostDisabled": 1}
            )
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

    def test_exact_pre_turn_code_mode_diagnostic_is_allowed(self) -> None:
        events = [
            {"type": "thread.started", "thread_id": "thread"},
            {
                "type": "item.completed",
                "item": {
                    "id": "startup-diagnostic",
                    "type": "error",
                    "message": runner.CODEX_CODE_MODE_HOST_DISABLED_DIAGNOSTIC,
                },
            },
            {"type": "turn.started"},
            {
                "type": "item.completed",
                "item": {"id": "answer", "type": "agent_message", "text": "{}"},
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

            self.assertEqual(audit["itemTypes"]["error"], 1)
            self.assertEqual(
                audit["compatibilityDiagnostics"], {"codeModeHostDisabled": 1}
            )
            self.assertFalse(audit["toolsObserved"])
            self.assertNotIn(
                runner.CODEX_CODE_MODE_HOST_DISABLED_DIAGNOSTIC,
                audit_path.read_text(encoding="utf-8"),
            )

    def test_code_mode_diagnostic_near_misses_fail_closed(self) -> None:
        diagnostic_item = {
            "id": "startup-diagnostic",
            "type": "error",
            "message": runner.CODEX_CODE_MODE_HOST_DISABLED_DIAGNOSTIC,
        }
        answer = {
            "type": "item.completed",
            "item": {"id": "answer", "type": "agent_message", "text": "{}"},
        }
        completed = {"type": "turn.completed", "usage": {}}
        cases = {
            "changed-message": [
                {"type": "thread.started", "thread_id": "thread"},
                {
                    "type": "item.completed",
                    "item": {**diagnostic_item, "message": "changed"},
                },
                {"type": "turn.started"},
                answer,
                completed,
            ],
            "missing-message": [
                {"type": "thread.started", "thread_id": "thread"},
                {
                    "type": "item.completed",
                    "item": {"id": "startup-diagnostic", "type": "error"},
                },
                {"type": "turn.started"},
                answer,
                completed,
            ],
            "extra-key": [
                {"type": "thread.started", "thread_id": "thread"},
                {
                    "type": "item.completed",
                    "item": {**diagnostic_item, "unexpected": True},
                },
                {"type": "turn.started"},
                answer,
                completed,
            ],
            "extra-event-key": [
                {"type": "thread.started", "thread_id": "thread"},
                {
                    "type": "item.completed",
                    "item": diagnostic_item,
                    "unexpected": True,
                },
                {"type": "turn.started"},
                answer,
                completed,
            ],
            "empty-id": [
                {"type": "thread.started", "thread_id": "thread"},
                {
                    "type": "item.completed",
                    "item": {**diagnostic_item, "id": ""},
                },
                {"type": "turn.started"},
                answer,
                completed,
            ],
            "historical-metadata-error": [
                {"type": "thread.started", "thread_id": "thread"},
                {
                    "type": "item.completed",
                    "item": {
                        **diagnostic_item,
                        "message": (
                            "Model metadata for `gpt-5.6-sol` not found. Defaulting "
                            "to fallback metadata; this can degrade performance and "
                            "cause issues."
                        ),
                    },
                },
                {"type": "turn.started"},
                answer,
                completed,
            ],
            "wrong-envelope": [
                {"type": "thread.started", "thread_id": "thread"},
                {"type": "item.started", "item": diagnostic_item},
                {"type": "turn.started"},
                answer,
                completed,
            ],
            "after-turn-started": [
                {"type": "thread.started", "thread_id": "thread"},
                {"type": "turn.started"},
                {"type": "item.completed", "item": diagnostic_item},
                answer,
                completed,
            ],
            "duplicate": [
                {"type": "thread.started", "thread_id": "thread"},
                {"type": "item.completed", "item": diagnostic_item},
                {"type": "item.completed", "item": diagnostic_item},
                {"type": "turn.started"},
                answer,
                completed,
            ],
        }

        for name, events in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                event_path = root / "events.jsonl"
                audit_path = root / "audit.json"
                event_path.write_text(
                    "\n".join(json.dumps(event) for event in events) + "\n",
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(runner.ConfigError, "forbidden"):
                    runner.audit_codex_events(event_path, audit_path)
                self.assertFalse(audit_path.exists())

    def test_allowed_diagnostic_does_not_allow_a_tool_item(self) -> None:
        events = [
            {"type": "thread.started", "thread_id": "thread"},
            {
                "type": "item.completed",
                "item": {
                    "id": "startup-diagnostic",
                    "type": "error",
                    "message": runner.CODEX_CODE_MODE_HOST_DISABLED_DIAGNOSTIC,
                },
            },
            {"type": "turn.started"},
            {
                "type": "item.started",
                "item": {"id": "tool", "type": "web_search", "query": "gym"},
            },
        ]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            event_path = root / "events.jsonl"
            audit_path = root / "audit.json"
            event_path.write_text(
                "\n".join(json.dumps(event) for event in events) + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(runner.ConfigError, "forbidden"):
                runner.audit_codex_events(event_path, audit_path)
            self.assertFalse(audit_path.exists())

    def test_malformed_event_lifecycle_fails_closed(self) -> None:
        thread_started = {"type": "thread.started", "thread_id": "thread"}
        turn_started = {"type": "turn.started"}
        answer = {
            "type": "item.completed",
            "item": {"id": "answer", "type": "agent_message", "text": "{}"},
        }
        completed = {"type": "turn.completed", "usage": {}}
        diagnostic = {
            "type": "item.completed",
            "item": {
                "id": "startup-diagnostic",
                "type": "error",
                "message": runner.CODEX_CODE_MODE_HOST_DISABLED_DIAGNOSTIC,
            },
        }
        cases = {
            "missing-turn-started": [thread_started, answer, completed],
            "completion-before-answer": [
                thread_started,
                turn_started,
                completed,
                answer,
            ],
            "duplicate-thread": [
                thread_started,
                diagnostic,
                thread_started,
                turn_started,
                answer,
                completed,
            ],
            "event-after-completion": [
                thread_started,
                turn_started,
                answer,
                completed,
                {"type": "warning", "message": "late"},
            ],
            "duplicate-answer": [
                thread_started,
                turn_started,
                answer,
                answer,
                completed,
            ],
        }

        for name, events in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                event_path = root / "events.jsonl"
                audit_path = root / "audit.json"
                event_path.write_text(
                    "\n".join(json.dumps(event) for event in events) + "\n",
                    encoding="utf-8",
                )
                with self.assertRaises(runner.ConfigError):
                    runner.audit_codex_events(event_path, audit_path)
                self.assertFalse(audit_path.exists())

    def test_allowed_diagnostic_does_not_allow_top_level_failure(self) -> None:
        for failure_type in ("error", "turn.failed"):
            with self.subTest(failure_type=failure_type), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                event_path = root / "events.jsonl"
                audit_path = root / "audit.json"
                events = [
                    {"type": "thread.started", "thread_id": "thread"},
                    {
                        "type": "item.completed",
                        "item": {
                            "id": "startup-diagnostic",
                            "type": "error",
                            "message": runner.CODEX_CODE_MODE_HOST_DISABLED_DIAGNOSTIC,
                        },
                    },
                    {"type": "turn.started"},
                    {"type": failure_type, "error": {"message": "failed"}},
                ]
                event_path.write_text(
                    "\n".join(json.dumps(event) for event in events) + "\n",
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(runner.TransientError, failure_type):
                    runner.audit_codex_events(event_path, audit_path)
                self.assertFalse(audit_path.exists())

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
            with self.assertRaisesRegex(runner.ConfigError, "event stream"):
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
            now = dt.datetime.now(PACIFIC)
            today = now.date().isoformat()
            updated_at = int(now.timestamp() * 1000)
            current_recovery = recovery_fixture(now, "fresh")
            prior_recovery = {
                **current_recovery,
                "generatedAt": "prior-generation-time-is-non-material",
            }
            existing = {
                "briefingDate": today,
                "snapshotUpdatedAt": updated_at,
                "inputSummary": {
                    "runnerVersion": runner.RUNNER_VERSION,
                    "validatorCompatibilityVersion": (
                        runner.VALIDATOR_COMPATIBILITY_VERSION
                    ),
                    "promptVersion": runner.PROMPT_VERSION,
                    "promptHash": runner.prompt_fingerprint(config),
                    "packetSchemaVersion": runner.BRIEFING_EVIDENCE_PACKET_VERSION,
                    "model": config.codex_model,
                    "modelReasoningEffort": config.codex_effort,
                    "recoveryStatus": "fresh",
                    "recoveryFingerprint": runner.trusted_recovery_fingerprint(
                        prior_recovery
                    ),
                    "recoveryFreshnessPolicy": runner.RECOVERY_FRESHNESS_POLICY,
                    "recoveryEvaluationDate": today,
                    "recoveryReadinessDay": today,
                    "recoverySleepDay": today,
                },
            }
            cloud = mock.Mock()
            cloud.request.side_effect = [
                (200, {"briefing": existing}),
                (200, snapshot_body(updated_at)),
            ]

            with mock.patch.object(
                runner, "CloudClient", return_value=cloud
            ), mock.patch.object(
                runner, "run_oura", return_value=current_recovery
            ) as refresh:
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
            self.assertEqual(status["snapshotUpdatedAt"], updated_at)
            refresh.assert_called_once()
            self.assertEqual(
                [call.args[:2] for call in cloud.request.call_args_list],
                [
                    ("GET", f"/api/cloud/briefing/{today}"),
                    ("GET", "/api/cloud/snapshot"),
                ],
            )

    def test_same_day_reuse_regenerates_for_material_recovery_changes(self) -> None:
        scenarios = (
            ("unavailable_to_fresh", "unavailable", None),
            ("stale_to_fresh", "stale", None),
            ("changed_fresh", "fresh", 70),
            ("obsolete_legacy_fingerprint", "fresh", "legacy"),
        )
        for label, prior_status, prior_score in scenarios:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                config = test_config(root)
                config.credential_file.write_text(
                    "CLOUD_AUTOMATION_SECRET=test-secret\n", encoding="utf-8"
                )
                now = dt.datetime.now(PACIFIC)
                today = now.date().isoformat()
                updated_at = int(now.timestamp() * 1000)
                current_recovery = recovery_fixture(now, "fresh")
                prior_recovery = recovery_fixture(
                    now,
                    prior_status,
                    readiness_score=(
                        prior_score if isinstance(prior_score, int) else 80
                    ),
                )
                prior_fingerprint = (
                    "sanitized-recovery-v0:"
                    + "0" * 64
                    if prior_score == "legacy"
                    else runner.trusted_recovery_fingerprint(prior_recovery)
                )
                existing = {
                    "briefingDate": today,
                    "snapshotUpdatedAt": updated_at,
                    "inputSummary": {
                        "runnerVersion": runner.RUNNER_VERSION,
                        "validatorCompatibilityVersion": (
                            runner.VALIDATOR_COMPATIBILITY_VERSION
                        ),
                        "promptVersion": runner.PROMPT_VERSION,
                        "promptHash": runner.prompt_fingerprint(config),
                        "packetSchemaVersion": (
                            runner.BRIEFING_EVIDENCE_PACKET_VERSION
                        ),
                        "model": config.codex_model,
                        "modelReasoningEffort": config.codex_effort,
                        "recoveryFingerprint": prior_fingerprint,
                    },
                }
                cloud = mock.Mock()
                cloud.request.side_effect = [
                    (200, {"briefing": existing}),
                    (200, snapshot_body(updated_at)),
                    (200, {"revision": 0, "state": None, "items": []}),
                ]

                with mock.patch.object(
                    runner, "CloudClient", return_value=cloud
                ), mock.patch.object(
                    runner, "run_oura", return_value=current_recovery
                ) as refresh, mock.patch.object(
                    runner,
                    "resolve_codex_binary",
                    side_effect=RuntimeError("reached generation"),
                ):
                    with self.assertRaisesRegex(RuntimeError, "reached generation"):
                        runner.run(
                            config,
                            runner.parse_args(["--ignore-schedule", "--dry-run"]),
                        )

                refresh.assert_called_once()
                self.assertEqual(
                    [call.args[:2] for call in cloud.request.call_args_list],
                    [
                        ("GET", f"/api/cloud/briefing/{today}"),
                        ("GET", "/api/cloud/snapshot"),
                        ("GET", "/api/cloud/memory"),
                    ],
                )

    def test_recovery_fingerprint_ignores_generation_time_and_unknown_fields(
        self,
    ) -> None:
        now = dt.datetime.now(PACIFIC)
        first = recovery_fixture(now, "fresh")
        second = {
            **first,
            "generatedAt": (now + dt.timedelta(minutes=5)).isoformat(),
            "credentialCanary": "must-not-affect-artifacts",
        }

        self.assertEqual(
            runner.trusted_recovery_fingerprint(first),
            runner.trusted_recovery_fingerprint(second),
        )
        self.assertNotIn(
            "must-not-affect-artifacts",
            runner.trusted_recovery_fingerprint(second),
        )

    def test_current_spool_with_changed_recovery_is_quarantined_and_regenerated(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = test_config(root)
            config.credential_file.write_text(
                "CLOUD_AUTOMATION_SECRET=test-secret\n", encoding="utf-8"
            )
            now = dt.datetime.now(PACIFIC)
            today = now.date().isoformat()
            prior_recovery = recovery_fixture(now, "fresh", readiness_score=70)
            current_recovery = recovery_fixture(now, "fresh", readiness_score=80)
            spool, updated_at = validated_spool_fixture(
                config, now, prior_recovery
            )
            spool_path = config.state_dir / "spool" / f"{today}.json"
            runner.atomic_write_json(spool_path, spool)

            events: list[str] = []
            cloud = mock.Mock()

            def request(
                _method: str, path: str, **_kwargs: object
            ) -> tuple[int, object]:
                events.append(path)
                if path.endswith(f"/briefing/{today}"):
                    return 404, {}
                if path == "/api/cloud/snapshot":
                    return 200, snapshot_body(updated_at)
                if path == "/api/cloud/memory":
                    return 200, {"revision": 0, "state": None, "items": []}
                raise AssertionError(f"unexpected cloud request: {path}")

            def refresh(*_args: object, **_kwargs: object) -> dict:
                events.append("recovery")
                return current_recovery

            cloud.request.side_effect = request
            with mock.patch.object(
                runner, "CloudClient", return_value=cloud
            ), mock.patch.object(
                runner, "run_oura", side_effect=refresh
            ), mock.patch.object(
                runner,
                "resolve_codex_binary",
                side_effect=RuntimeError("reached regeneration"),
            ):
                with self.assertRaisesRegex(RuntimeError, "reached regeneration"):
                    runner.run(
                        config,
                        runner.parse_args(["--ignore-schedule", "--dry-run"]),
                    )

            self.assertEqual(
                events,
                [
                    f"/api/cloud/briefing/{today}",
                    "/api/cloud/snapshot",
                    "recovery",
                    "/api/cloud/memory",
                ],
            )
            self.assertFalse(spool_path.exists())
            self.assertEqual(
                len(list(spool_path.parent.glob(f"{today}.obsolete-*.quarantine"))),
                1,
            )

    def test_current_spool_waits_for_stale_or_unavailable_recovery_before_grace(
        self,
    ) -> None:
        for recovery_status in ("stale", "unavailable"):
            with self.subTest(recovery_status=recovery_status), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                with mock.patch.dict(
                    os.environ, {"WORKOUT_OURA_GRACE_HOUR": "24"}, clear=False
                ):
                    config = test_config(root)
                config.credential_file.write_text(
                    "CLOUD_AUTOMATION_SECRET=test-secret\n", encoding="utf-8"
                )
                now = dt.datetime.now(PACIFIC)
                today = now.date().isoformat()
                current_recovery = recovery_fixture(now, recovery_status)
                spool, updated_at = validated_spool_fixture(
                    config, now, current_recovery
                )
                spool_path = config.state_dir / "spool" / f"{today}.json"
                runner.atomic_write_json(spool_path, spool)

                events: list[str] = []
                cloud = mock.Mock()

                def request(
                    _method: str, path: str, **_kwargs: object
                ) -> tuple[int, object]:
                    events.append(path)
                    if path.endswith(f"/briefing/{today}"):
                        return 404, {}
                    if path == "/api/cloud/snapshot":
                        return 200, snapshot_body(updated_at)
                    if path == "/api/cloud/memory":
                        return 200, {
                            "revision": 0,
                            "state": None,
                            "items": [],
                        }
                    raise AssertionError(f"unexpected cloud request: {path}")

                def refresh(*_args: object, **_kwargs: object) -> dict:
                    events.append("recovery")
                    return current_recovery

                cloud.request.side_effect = request
                with mock.patch.object(
                    runner, "CloudClient", return_value=cloud
                ), mock.patch.object(
                    runner, "run_oura", side_effect=refresh
                ), mock.patch.object(runner, "publish_spool") as publish:
                    result = runner.run(
                        config, runner.parse_args(["--ignore-schedule"])
                    )

                self.assertEqual(result, runner.EXIT_OK)
                self.assertEqual(
                    events,
                    [
                        f"/api/cloud/briefing/{today}",
                        "/api/cloud/snapshot",
                        "recovery",
                    ],
                )
                publish.assert_not_called()
                self.assertTrue(spool_path.is_file())
                status = runner.read_json(config.state_dir / "status.json")
                self.assertEqual(status["stage"], "waiting_for_oura")
                self.assertEqual(status["outcome"], "waiting")
                self.assertEqual(status["recoveryStatus"], recovery_status)

    def test_current_spool_with_unchanged_fresh_recovery_is_reused(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = test_config(root)
            config.credential_file.write_text(
                "CLOUD_AUTOMATION_SECRET=test-secret\n", encoding="utf-8"
            )
            now = dt.datetime.now(PACIFIC)
            today = now.date().isoformat()
            current_recovery = recovery_fixture(now, "fresh")
            spool, updated_at = validated_spool_fixture(
                config, now, current_recovery
            )
            spool_path = config.state_dir / "spool" / f"{today}.json"
            runner.atomic_write_json(spool_path, spool)

            events: list[str] = []
            cloud = mock.Mock()

            def request(
                _method: str, path: str, **_kwargs: object
            ) -> tuple[int, object]:
                events.append(path)
                if path.endswith(f"/briefing/{today}"):
                    return 404, {}
                if path == "/api/cloud/snapshot":
                    return 200, snapshot_body(updated_at)
                if path == "/api/cloud/memory":
                    return 200, {"revision": 0, "state": None, "items": []}
                raise AssertionError(f"unexpected cloud request: {path}")

            def refresh(*_args: object, **_kwargs: object) -> dict:
                events.append("recovery")
                return current_recovery

            cloud.request.side_effect = request
            with mock.patch.object(
                runner, "CloudClient", return_value=cloud
            ), mock.patch.object(
                runner, "run_oura", side_effect=refresh
            ), mock.patch.object(runner, "publish_spool") as publish, mock.patch.object(
                runner, "resolve_codex_binary"
            ) as resolve:
                result = runner.run(
                    config, runner.parse_args(["--ignore-schedule"])
                )

            self.assertEqual(result, runner.EXIT_OK)
            self.assertEqual(
                events,
                [
                    f"/api/cloud/briefing/{today}",
                    "/api/cloud/snapshot",
                    "recovery",
                    "/api/cloud/memory",
                ],
            )
            publish.assert_called_once()
            resolve.assert_not_called()
            self.assertFalse(spool_path.exists())
            status = runner.read_json(config.state_dir / "status.json")
            self.assertEqual(status["stage"], "complete")
            self.assertEqual(status["outcome"], "published")

    def test_newer_snapshot_replaces_an_existing_same_day_briefing(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = test_config(root)
            config.credential_file.write_text(
                "CLOUD_AUTOMATION_SECRET=test-secret\n", encoding="utf-8"
            )
            now = dt.datetime.now(PACIFIC)
            today = now.date().isoformat()
            updated_at = int(now.timestamp() * 1000)
            existing = {
                "briefingDate": today,
                "snapshotUpdatedAt": updated_at - 1,
                "inputSummary": {},
            }
            cloud = mock.Mock()
            cloud.request.side_effect = [
                (200, {"briefing": existing}),
                (200, snapshot_body(updated_at)),
                (200, {"revision": 0, "state": None, "items": []}),
            ]

            with mock.patch.object(
                runner, "CloudClient", return_value=cloud
            ), mock.patch.object(
                runner,
                "run_oura",
                side_effect=RuntimeError("reached recovery refresh"),
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "reached recovery refresh"
                ):
                    runner.run(
                        config,
                        runner.parse_args(["--ignore-schedule", "--dry-run"]),
                    )

            self.assertEqual(
                [call.args[:2] for call in cloud.request.call_args_list],
                [
                    ("GET", f"/api/cloud/briefing/{today}"),
                    ("GET", "/api/cloud/snapshot"),
                ],
            )

    def test_obsolete_same_day_contract_regenerates_for_every_contract_field(
        self,
    ) -> None:
        contract_fields = (
            "runnerVersion",
            "validatorCompatibilityVersion",
            "promptVersion",
            "promptHash",
            "packetSchemaVersion",
            "model",
            "modelReasoningEffort",
            "missing-all",
        )
        for changed_field in contract_fields:
            with self.subTest(changed_field=changed_field), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                config = test_config(root)
                config.credential_file.write_text(
                    "CLOUD_AUTOMATION_SECRET=test-secret\n", encoding="utf-8"
                )
                now = dt.datetime.now(PACIFIC)
                today = now.date().isoformat()
                updated_at = int(now.timestamp() * 1000)
                contract = {
                    "runnerVersion": runner.RUNNER_VERSION,
                    "validatorCompatibilityVersion": (
                        runner.VALIDATOR_COMPATIBILITY_VERSION
                    ),
                    "promptVersion": runner.PROMPT_VERSION,
                    "promptHash": runner.prompt_fingerprint(config),
                    "packetSchemaVersion": runner.BRIEFING_EVIDENCE_PACKET_VERSION,
                    "model": config.codex_model,
                    "modelReasoningEffort": config.codex_effort,
                }
                if changed_field == "missing-all":
                    contract = {}
                else:
                    contract[changed_field] = "obsolete"
                existing = {
                    "briefingDate": today,
                    "snapshotUpdatedAt": updated_at,
                    "model": config.codex_model,
                    "inputSummary": contract,
                }
                cloud = mock.Mock()
                cloud.request.side_effect = [
                    (200, {"briefing": existing}),
                    (200, snapshot_body(updated_at)),
                    (200, {"revision": 0, "state": None, "items": []}),
                ]

                with mock.patch.object(
                    runner, "CloudClient", return_value=cloud
                ), mock.patch.object(
                    runner,
                    "run_oura",
                    side_effect=RuntimeError("reached recovery refresh"),
                ):
                    with self.assertRaisesRegex(
                        RuntimeError, "reached recovery refresh"
                    ):
                        runner.run(
                            config,
                            runner.parse_args(["--ignore-schedule", "--dry-run"]),
                        )

                self.assertEqual(
                    [call.args[:2] for call in cloud.request.call_args_list],
                    [
                        ("GET", f"/api/cloud/briefing/{today}"),
                        ("GET", "/api/cloud/snapshot"),
                    ],
                )

    def test_older_snapshot_cannot_replace_a_same_day_briefing(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = test_config(root)
            config.credential_file.write_text(
                "CLOUD_AUTOMATION_SECRET=test-secret\n", encoding="utf-8"
            )
            now = dt.datetime.now(PACIFIC)
            today = now.date().isoformat()
            updated_at = int(now.timestamp() * 1000)
            existing = {
                "briefingDate": today,
                "snapshotUpdatedAt": updated_at + 1,
                "inputSummary": {},
            }
            cloud = mock.Mock()
            cloud.request.side_effect = [
                (200, {"briefing": existing}),
                (200, snapshot_body(updated_at)),
            ]

            with mock.patch.object(runner, "CloudClient", return_value=cloud):
                with self.assertRaisesRegex(
                    runner.ConfigError,
                    "Cloud snapshot predates the existing same-day briefing",
                ):
                    runner.run(
                        config,
                        runner.parse_args(["--ignore-schedule", "--dry-run"]),
                    )

            self.assertEqual(len(cloud.request.call_args_list), 2)

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


class PromptPolicyTests(unittest.TestCase):
    def test_domain_policy_prevents_correlated_votes_and_neutral_missingness(
        self,
    ) -> None:
        instructions = (
            MODULE_PATH.parent / "codex_daily_briefing_prompt.md"
        ).read_text(encoding="utf-8")
        normalized = " ".join(instructions.split())

        self.assertIn(
            "Do not calculate a composite or weighted readiness score", normalized
        )
        self.assertIn(
            "external-work story, not multiple confirmations", normalized
        )
        self.assertIn("Treat them as one effort domain", normalized)
        self.assertIn(
            "count them as one supporting domain, not independent confirmations",
            normalized,
        )
        self.assertIn(
            "missing, skipped, null, stale, pruned, or non-comparable value is unknown",
            normalized,
        )
        self.assertIn(
            "Prior generated recommendations and briefings are not evidence",
            normalized,
        )
        self.assertIn("acute:chronic workload ratio", normalized)


class ModelInputBundleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.today = "2026-08-01"
        self.updated_at = pacific_ms(2026, 8, 1, 12)
        self.recovery = {
            "generatedAt": "2026-08-01T12:00:00-07:00",
            "status": "fresh",
            "freshnessPolicy": runner.RECOVERY_FRESHNESS_POLICY,
            "evaluationDate": self.today,
            "latestReadiness": {
                "day": self.today,
                "score": 80,
                "observedAt": "2026-08-01T08:00:00-07:00",
                "isStale": False,
            },
            "latestSleep": {
                "day": self.today,
                "score": 75,
                "totalSleepHours": 7.0,
                "observedAt": "2026-08-01T08:10:00-07:00",
                "isStale": False,
            },
        }

    def empty_body(self) -> dict:
        body = snapshot_body(self.updated_at)
        data = body["snapshot"]["payload"]["data"]
        for table in (
            "exercises",
            "programs",
            "sessionTemplates",
            "templateExercises",
            "workoutSessions",
            "loggedSets",
            "aiMemorySettings",
            "aiNotes",
            "aiMemorySummaries",
        ):
            data[table] = []
        return body

    def session(
        self,
        session_id: str,
        completed_at: int,
        *,
        program_id: str | None = None,
        template_id: str | None = None,
        exercises: list[tuple[str, str]] | None = None,
        pre: object = "absent",
        post: object = "absent",
    ) -> dict:
        result = {
            "id": session_id,
            "sessionTemplateId": template_id,
            "programId": program_id,
            "name": session_id,
            "programName": "Program" if program_id else None,
            "exerciseSnapshot": [
                {
                    "exerciseId": exercise_id,
                    "order": index,
                    "targetSets": 3,
                    "targetRepRange": target_range,
                }
                for index, (exercise_id, target_range) in enumerate(exercises or [])
            ],
            "startedAt": completed_at - 3_600_000,
            "completedAt": completed_at,
        }
        if pre != "absent":
            result["preWorkoutCheckIn"] = pre
        if post != "absent":
            result["postWorkoutFeedback"] = post
        return result

    @staticmethod
    def logged_set(
        set_id: str,
        session_id: str,
        exercise_id: str,
        logged_at: int,
        *,
        weight: int = 100,
        reps: int = 8,
        rpe: int | None = 7,
    ) -> dict:
        return {
            "id": set_id,
            "workoutSessionId": session_id,
            "exerciseId": exercise_id,
            "setNumber": 1,
            "weightLbs": weight,
            "reps": reps,
            "rpe": rpe,
            "loggedAt": logged_at,
        }

    def memory_body(
        self, items: list[dict] | None = None, *, current_context: str = ""
    ) -> dict:
        start = pacific_ms(2026, 8, 1)
        return {
            "revision": 0,
            "state": {
                "currentContext": current_context,
                "paused": False,
                "windowStartedAt": start,
                "fourMonthStartedAt": start,
            },
            "items": items or [],
        }

    def facts(self, body: dict) -> runner.SnapshotFacts:
        return runner.validate_snapshot(body, dt.date.fromisoformat(self.today))

    def test_prompt_contains_only_bounded_packets_and_excludes_generated_tables(
        self,
    ) -> None:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        data["workoutSessions"] = [self.session("session-1", self.updated_at - 1_000)]
        data["exercises"] = [{"id": "unused", "name": "UNRELATED_EXERCISE_SENTINEL"}]
        data["recommendations"] = [{"id": "OLD_RECOMMENDATION_SENTINEL"}]
        data["dailyBriefings"] = [{"headline": "OLD_BRIEFING_SENTINEL"}]
        data["chatActionReceipts"] = [{"resultJson": "OLD_RECEIPT_SENTINEL"}]
        memory = self.memory_body(
            [
                {
                    "id": "workout:session-1",
                    "memoryType": "workout",
                    "sourceWorkoutSessionId": "session-1",
                    "bullets": ["DUPLICATE_WORKOUT_MEMORY_SENTINEL"],
                }
            ]
        )
        facts = self.facts(body)
        bundle = runner.build_model_input_bundle(
            facts=facts,
            memory_body=memory,
            recovery=self.recovery,
            today=self.today,
        )

        self.assertEqual(
            set(bundle.inputs),
            {
                "briefingEvidencePacket",
                "memorySourcePacket",
                "supervisorCandidatePlan",
            },
        )
        serialized = json.dumps(bundle.inputs, sort_keys=True)
        for sentinel in (
            "UNRELATED_EXERCISE_SENTINEL",
            "OLD_RECOMMENDATION_SENTINEL",
            "OLD_BRIEFING_SENTINEL",
            "OLD_RECEIPT_SENTINEL",
            "DUPLICATE_WORKOUT_MEMORY_SENTINEL",
        ):
            self.assertNotIn(sentinel, serialized)

        with tempfile.TemporaryDirectory() as temp:
            config = test_config(Path(temp))
            prompt = runner.build_model_prompt(
                config,
                facts=facts,
                today=self.today,
                now=dt.datetime(2026, 8, 1, 12, tzinfo=PACIFIC),
                run_id="test-run",
                prompt_hash="abc123",
                snapshot_body={"RAW_SNAPSHOT_SENTINEL": True},
                memory_body=memory,
                recovery=self.recovery,
                input_bundle=bundle,
            )
        self.assertNotIn("snapshotResponse", prompt)
        self.assertNotIn("memoryResponse", prompt)
        self.assertNotIn("RAW_SNAPSHOT_SENTINEL", prompt)

    def test_next_session_rotation_matches_today_screen(self) -> None:
        for last_template_id, expected_template_id in (
            ("template-b", "template-c"),
            ("template-c", "template-a"),
            ("deleted-template", "template-a"),
            (None, "template-a"),
        ):
            with self.subTest(last_template_id=last_template_id):
                body = self.empty_body()
                data = body["snapshot"]["payload"]["data"]
                data["exercises"] = [{"id": "squat", "name": "Squat"}]
                data["programs"] = [
                    {"id": "active", "name": "Active", "isActive": 1},
                    {"id": "other", "name": "Other", "isActive": 0},
                ]
                data["sessionTemplates"] = [
                    {"id": "template-c", "programId": "active", "name": "C", "order": 2},
                    {"id": "template-a", "programId": "active", "name": "A", "order": 0},
                    {"id": "template-b", "programId": "active", "name": "B", "order": 1},
                    {"id": "other-template", "programId": "other", "name": "X", "order": 0},
                ]
                data["templateExercises"] = [
                    {
                        "id": "planned-row",
                        "sessionTemplateId": expected_template_id,
                        "exerciseId": "squat",
                        "order": 0,
                        "targetSets": 3,
                        "targetRepRange": "5-8",
                    }
                ]
                active_last = self.session(
                    "active-last",
                    self.updated_at - 2_000,
                    program_id="active",
                    template_id=last_template_id,
                )
                other_later = self.session(
                    "other-later",
                    self.updated_at - 1_000,
                    program_id="other",
                    template_id="other-template",
                )
                data["workoutSessions"] = [other_later, active_last]

                bundle = runner.build_model_input_bundle(
                    facts=self.facts(body),
                    memory_body=self.memory_body(),
                    recovery=self.recovery,
                    today=self.today,
                )
                current = bundle.inputs["briefingEvidencePacket"][
                    "currentProgrammedSession"
                ]
                self.assertEqual(current["sessionTemplate"]["id"], expected_template_id)
                self.assertEqual(
                    current["rotation"]["lastCompletedSessionId"], "active-last"
                )
                self.assertEqual(current["rotation"]["semantics"], "today_screen_v1")

    def test_same_day_template_and_freestyle_workouts_are_resumable(self) -> None:
        for label, program_id, template_id in (
            ("template", "program", "lower"),
            ("freestyle", None, None),
        ):
            with self.subTest(label=label):
                body = self.empty_body()
                data = body["snapshot"]["payload"]["data"]
                data["exercises"] = [{"id": "squat", "name": "Squat"}]
                data["programs"] = [
                    {"id": "program", "name": "Plan", "isActive": 1}
                ]
                data["sessionTemplates"] = [
                    {
                        "id": "lower",
                        "programId": "program",
                        "name": "Lower",
                        "order": 0,
                    }
                ]
                data["workoutSessions"] = [
                    self.session("completed-baseline", self.updated_at - 10_000),
                    {
                        "id": f"active-{label}",
                        "name": f"Active {label}",
                        "programId": program_id,
                        "programName": "Plan" if program_id else None,
                        "sessionTemplateId": template_id,
                        "startedAt": self.updated_at - 1_000,
                        "completedAt": None,
                        "exerciseSnapshot": [
                            {
                                "exerciseId": "squat",
                                "order": 0,
                                "targetSets": 3,
                                "targetRepRange": "5-8",
                            }
                        ],
                    }
                ]

                bundle = runner.build_model_input_bundle(
                    facts=self.facts(body),
                    memory_body=self.memory_body(),
                    recovery=self.recovery,
                    today=self.today,
                )
                current = bundle.inputs["briefingEvidencePacket"][
                    "currentProgrammedSession"
                ]
                self.assertEqual(current["status"], "resumable")
                self.assertEqual(current["activeWorkout"]["id"], f"active-{label}")
                self.assertEqual(current["activeWorkout"]["programId"], program_id)
                self.assertEqual(current["sessionTemplate"]["id"], template_id)
                self.assertEqual(
                    [item["exerciseId"] for item in current["sessionTemplate"]["exercises"]],
                    ["squat"],
                )
                self.assertEqual(
                    current["rotation"]["semantics"], "today_screen_resumable_v1"
                )
                self.assertIn(current["evidenceId"], bundle.allowed_evidence_ids)

    def test_invalid_newer_incomplete_rows_do_not_hide_a_resumable_workout(self) -> None:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        valid_id = "valid-current"
        completed_baseline = self.session(
            "completed-baseline", self.updated_at - 10_000
        )
        data["workoutSessions"] = [
            {
                "id": "stale-yesterday",
                "name": "Stale",
                "startedAt": pacific_ms(2026, 7, 31, 23),
                "completedAt": None,
            },
            {
                "id": "future-current-day",
                "name": "Future",
                "startedAt": self.updated_at + 1,
                "completedAt": None,
            },
            {
                "id": valid_id,
                "name": "Resume me",
                "startedAt": self.updated_at - 1,
                "completedAt": None,
            },
            {
                "id": "missing-start",
                "name": "Malformed",
                "startedAt": None,
                "completedAt": None,
            },
            completed_baseline,
        ]

        bundle = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=self.memory_body(),
            recovery=self.recovery,
            today=self.today,
        )
        current = bundle.inputs["briefingEvidencePacket"]["currentProgrammedSession"]
        self.assertEqual(current["status"], "resumable")
        self.assertEqual(current["activeWorkout"]["id"], valid_id)

        data["workoutSessions"] = [
            data["workoutSessions"][0],
            data["workoutSessions"][1],
            completed_baseline,
        ]
        ignored = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=self.memory_body(),
            recovery=self.recovery,
            today=self.today,
        ).inputs["briefingEvidencePacket"]["currentProgrammedSession"]
        self.assertEqual(ignored["status"], "unavailable")
        self.assertNotIn("evidenceId", ignored)

    def test_archived_active_program_is_ignored(self) -> None:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        data["programs"] = [
            {
                "id": "archived",
                "name": "Archived",
                "isActive": 1,
                "archivedAt": self.updated_at - 1,
            },
            {"id": "live", "name": "Live", "isActive": 1, "archivedAt": None},
        ]
        data["sessionTemplates"] = [
            {"id": "old", "programId": "archived", "name": "Old", "order": 0},
            {"id": "current", "programId": "live", "name": "Current", "order": 0},
        ]
        data["workoutSessions"] = [
            self.session("completed-baseline", self.updated_at - 10_000)
        ]

        current = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=self.memory_body(),
            recovery=self.recovery,
            today=self.today,
        ).inputs["briefingEvidencePacket"]["currentProgrammedSession"]
        self.assertEqual(current["program"]["id"], "live")
        self.assertEqual(current["sessionTemplate"]["id"], "current")

        data["programs"] = data["programs"][:1]
        unavailable = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=self.memory_body(),
            recovery=self.recovery,
            today=self.today,
        ).inputs["briefingEvidencePacket"]["currentProgrammedSession"]
        self.assertEqual(unavailable["status"], "unavailable")
        self.assertNotIn("evidenceId", unavailable)

    def test_missing_and_skipped_feedback_are_explicitly_unknown(self) -> None:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        sessions = [
            self.session("absent", self.updated_at - 3_000),
            self.session("top-null", self.updated_at - 2_000, pre=None, post=None),
            self.session(
                "skipped",
                self.updated_at - 1_000,
                pre={
                    "version": 1,
                    "perceivedRecovery": None,
                    "recordedAt": self.updated_at - 2_000,
                },
            ),
        ]
        data["workoutSessions"] = sessions
        bundle = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=self.memory_body(),
            recovery=self.recovery,
            today=self.today,
        )
        episodes = {
            item["sourceSessionId"]: item
            for item in bundle.inputs["briefingEvidencePacket"][
                "recentSessionEpisodes"
            ]
        }

        for session_id in ("absent", "top-null"):
            self.assertIsNone(episodes[session_id]["feedback"]["preWorkoutCheckIn"])
            self.assertEqual(
                episodes[session_id]["missingness"]["preWorkoutRecovery"],
                "not_collected",
            )
            self.assertEqual(
                episodes[session_id]["signalAlignment"]["status"], "unknown"
            )
        skipped = episodes["skipped"]
        self.assertIsNone(
            skipped["feedback"]["preWorkoutCheckIn"]["perceivedRecovery"]
        )
        self.assertEqual(
            skipped["missingness"]["preWorkoutRecovery"], "skipped"
        )
        self.assertEqual(skipped["signalAlignment"]["status"], "unknown")

    def comparable_history_body(self, *, include_safety: bool = False) -> dict:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        data["exercises"] = [
            {"id": "squat", "name": "Squat"},
            {"id": "row", "name": "Row"},
            {"id": "bench", "name": "Bench"},
        ]
        data["programs"] = [{"id": "program", "name": "Plan", "isActive": 1}]
        data["sessionTemplates"] = [
            {"id": "lower", "programId": "program", "name": "Lower", "order": 0},
            {"id": "upper", "programId": "program", "name": "Upper", "order": 1},
        ]
        data["templateExercises"] = [
            {
                "id": "lower-squat",
                "sessionTemplateId": "lower",
                "exerciseId": "squat",
                "order": 0,
                "targetSets": 3,
                "targetRepRange": "5-8",
            },
            {
                "id": "lower-row",
                "sessionTemplateId": "lower",
                "exerciseId": "row",
                "order": 1,
                "targetSets": 3,
                "targetRepRange": "5-8",
            },
            {
                "id": "upper-bench",
                "sessionTemplateId": "upper",
                "exerciseId": "bench",
                "order": 0,
                "targetSets": 3,
                "targetRepRange": "5-8",
            },
        ]
        sessions = []
        sets = []
        for index in range(1, 5):
            completed_at = self.updated_at - (9 - index) * 10_000
            session_id = f"squat-{index}"
            sessions.append(
                self.session(
                    session_id,
                    completed_at,
                    program_id="program",
                    template_id="lower",
                    exercises=[("squat", "5-8"), ("row", "5-8")],
                    pre={
                        "version": 1,
                        "perceivedRecovery": 5 + index % 2,
                        "recordedAt": completed_at - 2_000,
                    },
                    post={
                        "version": 2,
                        "performance": 3 + index % 2,
                        "sessionRpe": 7,
                        "painImpact": "none",
                    },
                )
            )
            sets.append(
                self.logged_set(
                    f"squat-set-{index}",
                    session_id,
                    "squat",
                    completed_at - 1_000,
                    weight=100 + index,
                )
            )
            if index >= 3:
                sets.append(
                    self.logged_set(
                        f"row-set-{index}",
                        session_id,
                        "row",
                        completed_at - 900,
                        weight=80 + index,
                    )
                )
        different_at = self.updated_at - 20_000
        sessions.append(
            self.session(
                "different-range",
                different_at,
                exercises=[("squat", "10-12")],
            )
        )
        sets.append(
            self.logged_set(
                "different-set",
                "different-range",
                "squat",
                different_at - 1_000,
            )
        )
        bench_at = self.updated_at - 90_000
        sessions.append(
            self.session("bench-only", bench_at, exercises=[("bench", "5-8")])
        )
        sets.append(
            self.logged_set("bench-set", "bench-only", "bench", bench_at - 1_000)
        )
        last_at = self.updated_at - 10_000
        sessions.append(
            self.session(
                "last-upper",
                last_at,
                program_id="program",
                template_id="upper",
                exercises=[("bench", "5-8")],
                post=(
                    {
                        "version": 2,
                        "performance": 2,
                        "sessionRpe": 8,
                        "painImpact": "stopped",
                    }
                    if include_safety
                    else "absent"
                ),
            )
        )
        data["workoutSessions"] = sessions
        data["loggedSets"] = sets
        if include_safety:
            data["aiNotes"] = [
                {
                    "id": "current-safety-note",
                    "body": "Fever today; do not assume this is resolved. " + "x" * 400,
                    "createdAt": self.updated_at - 500,
                    "updatedAt": self.updated_at - 500,
                }
            ]
        return body

    def test_comparators_cover_only_next_movements_and_reuse_recent_episode_refs(
        self,
    ) -> None:
        body = self.comparable_history_body()
        memory = self.memory_body(
            [
                {
                    "id": f"workout:{item['id']}",
                    "memoryType": "workout",
                    "sourceWorkoutSessionId": item["id"],
                    "bullets": ["existing"],
                }
                for item in body["snapshot"]["payload"]["data"]["workoutSessions"]
            ]
        )
        bundle = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=memory,
            recovery=self.recovery,
            today=self.today,
        )
        packet = bundle.inputs["briefingEvidencePacket"]
        movements = {
            item["exerciseId"]: item
            for item in packet["comparableMovementExposures"]
        }
        self.assertEqual(set(movements), {"squat", "row"})
        self.assertNotIn("bench", movements)
        squat = movements["squat"]
        self.assertEqual(squat["availableComparableExposureCount"], 4)
        self.assertEqual(squat["retainedComparableExposureCount"], 3)
        self.assertEqual(squat["prunedComparableExposureCount"], 1)
        self.assertEqual(
            [item["sourceSessionId"] for item in squat["exposures"]],
            ["squat-4", "squat-3", "squat-2"],
        )
        self.assertEqual(movements["row"]["availableComparableExposureCount"], 2)
        self.assertEqual(bundle.telemetry["prunedComparatorCount"], 2)

        recent_by_id = {
            item["sourceSessionId"]: item for item in packet["recentSessionEpisodes"]
        }
        recent_reference = squat["exposures"][0]
        self.assertEqual(recent_reference["representation"], "recent_episode_reference")
        self.assertNotIn("loggedSets", recent_reference)
        source_episode = recent_by_id[recent_reference["sourceSessionId"]]
        source_work = next(
            item
            for item in source_episode["loggedWork"]
            if item["exerciseId"] == "squat"
        )
        self.assertEqual(
            recent_reference["sourceStoryId"], source_episode["sourceStoryId"]
        )
        self.assertNotIn("evidenceId", source_episode)
        self.assertNotIn("sourceSessionEvidenceId", recent_reference)
        self.assertEqual(
            recent_reference["sourceWorkEvidenceId"], source_work["evidenceId"]
        )
        self.assertEqual(
            set(recent_reference["sourceDomainEvidenceIds"]),
            {
                key
                for key, value in source_episode["domainEvidence"].items()
                if value is not None
            },
        )
        self.assertIn(source_work["evidenceId"], bundle.allowed_evidence_ids)

    def test_story_containers_are_not_citable_and_subjective_conflicts_use_atoms(
        self,
    ) -> None:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        completed_at = self.updated_at - 1_000
        data["workoutSessions"] = [
            self.session(
                "opposed",
                completed_at,
                pre={
                    "version": 1,
                    "perceivedRecovery": 2,
                    "recordedAt": completed_at - 2_000,
                },
                post={
                    "version": 2,
                    "performance": 5,
                    "sessionRpe": 7,
                    "painImpact": "none",
                },
            )
        ]
        bundle = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=self.memory_body(),
            recovery=self.recovery,
            today=self.today,
        )
        packet = bundle.inputs["briefingEvidencePacket"]
        episode = packet["recentSessionEpisodes"][0]
        story_id = episode["sourceStoryId"]
        state_id = episode["domainEvidence"]["subjectiveState"]["evidenceId"]
        outcome_id = episode["domainEvidence"]["subjectiveOutcome"]["evidenceId"]

        self.assertNotIn("evidenceId", episode)
        self.assertNotIn(story_id, bundle.allowed_evidence_ids)
        self.assertIn(state_id, bundle.allowed_evidence_ids)
        self.assertIn(outcome_id, bundle.allowed_evidence_ids)
        self.assertNotIn("crossDomainContradictions", packet)
        contradictions = packet["subjectiveSignalContradictions"]
        self.assertEqual(len(contradictions), 1)
        self.assertEqual(contradictions[0]["sourceStoryId"], story_id)
        self.assertEqual(contradictions[0]["subjectiveStateEvidenceId"], state_id)
        self.assertEqual(
            contradictions[0]["subjectiveOutcomeEvidenceId"], outcome_id
        )

    def test_current_safety_survives_budget_pruning(self) -> None:
        body = self.comparable_history_body(include_safety=True)
        sessions = body["snapshot"]["payload"]["data"]["workoutSessions"]
        memory = self.memory_body(
            [
                {
                    "id": f"workout:{item['id']}",
                    "memoryType": "workout",
                    "sourceWorkoutSessionId": item["id"],
                    "bullets": ["existing"],
                }
                for item in sessions
            ]
        )
        facts = self.facts(body)
        full = runner.build_model_input_bundle(
            facts=facts,
            memory_body=memory,
            recovery=self.recovery,
            today=self.today,
        )
        reduced = runner.build_model_input_bundle(
            facts=facts,
            memory_body=memory,
            recovery=self.recovery,
            today=self.today,
            max_input_bytes=full.telemetry["totalInputBytes"] - 1,
        )
        safety_events = reduced.inputs["briefingEvidencePacket"][
            "safetyAndUserContext"
        ]["safetyEvents"]
        self.assertIn(
            "current-safety-note",
            {item.get("sourceNoteId") for item in safety_events},
        )
        pain_event = next(
            item for item in safety_events if item.get("sourceSessionId") == "last-upper"
        )
        self.assertEqual(pain_event["painImpact"], "stopped")
        self.assertIn(pain_event["sourceEvidenceId"], reduced.safety_evidence_ids)
        self.assertIn(
            runner.evidence_id("note", "current-safety-note"),
            reduced.safety_evidence_ids,
        )
        self.assertGreater(
            reduced.telemetry["prunedComparatorCount"],
            full.telemetry["prunedComparatorCount"],
        )
        self.assertLessEqual(
            reduced.telemetry["totalInputBytes"],
            reduced.telemetry["maxInputBytes"],
        )

    def test_raw_workout_memory_and_overlapping_periodic_views_are_deduplicated(
        self,
    ) -> None:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        completed_at = self.updated_at - 1_000
        data["workoutSessions"] = [self.session("recent", completed_at)]
        older_start = pacific_ms(2026, 6, 1)
        older_end = pacific_ms(2026, 6, 15)
        data["aiMemorySummaries"] = [
            {
                "id": "older-summary",
                "periodType": "two_week",
                "periodStartAt": older_start,
                "periodEndAt": older_end,
                "bullets": ["SNAPSHOT_SUMMARY_COPY"],
                "sourceSessionIds": ["old-source"],
                "sourceNoteIds": [],
                "sourceSummaryIds": [],
            },
            {
                "id": "overlapping-recent",
                "periodType": "two_week",
                "periodStartAt": completed_at - 10_000,
                "periodEndAt": completed_at,
                "bullets": ["OVERLAPPING_RAW_SUMMARY_SENTINEL"],
                "sourceSessionIds": ["recent"],
                "sourceNoteIds": [],
                "sourceSummaryIds": [],
            },
        ]
        memory = self.memory_body(
            [
                {
                    "id": "workout:recent",
                    "memoryType": "workout",
                    "sourceWorkoutSessionId": "recent",
                    "bullets": ["RAW_WORKOUT_MEMORY_SENTINEL"],
                },
                {
                    "id": "older-summary",
                    "memoryType": "two_week",
                    "periodStartAt": older_start,
                    "periodEndAt": older_end,
                    "sourceWorkoutSessionId": None,
                    "bullets": ["CLOUD_SUMMARY_COPY"],
                    "sourceSessionIds": ["old-source"],
                    "sourceNoteIds": [],
                    "sourceSummaryIds": [],
                },
            ]
        )
        bundle = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=memory,
            recovery=self.recovery,
            today=self.today,
        )
        packet = bundle.inputs["briefingEvidencePacket"]
        summaries = packet["olderPeriodicSummaries"]
        self.assertEqual([item["sourceSummaryId"] for item in summaries], ["older-summary"])
        self.assertEqual(summaries[0]["sourceStore"], "cloud_memory")
        serialized = json.dumps(packet)
        self.assertNotIn("SNAPSHOT_SUMMARY_COPY", serialized)
        self.assertIn("CLOUD_SUMMARY_COPY", serialized)
        self.assertNotIn("RAW_WORKOUT_MEMORY_SENTINEL", serialized)
        self.assertNotIn("OVERLAPPING_RAW_SUMMARY_SENTINEL", serialized)

    def test_rare_old_comparator_does_not_suppress_balanced_summary_horizons(
        self,
    ) -> None:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        data["exercises"] = [
            {"id": "squat", "name": "Squat"},
            {"id": "bench", "name": "Bench"},
        ]
        data["programs"] = [{"id": "program", "name": "Plan", "isActive": 1}]
        data["sessionTemplates"] = [
            {"id": "lower", "programId": "program", "name": "Lower", "order": 0}
        ]
        data["templateExercises"] = [
            {
                "id": "lower-squat",
                "sessionTemplateId": "lower",
                "exerciseId": "squat",
                "order": 0,
                "targetSets": 3,
                "targetRepRange": "5-8",
            }
        ]
        old_at = pacific_ms(2026, 4, 1, 12)
        old = self.session(
            "rare-old-squat",
            old_at,
            exercises=[("squat", "5-8")],
        )
        recent = [
            self.session(
                f"recent-{index}",
                pacific_ms(2026, 7, 29 + index, 12),
                exercises=[("bench", "5-8")],
            )
            for index in range(3)
        ]
        data["workoutSessions"] = [old, *recent]
        data["loggedSets"] = [
            self.logged_set("old-squat-set", old["id"], "squat", old_at - 1_000)
        ]

        periods = [
            ("four_month", pacific_ms(2026, 1, 1), pacific_ms(2026, 5, 1)),
            ("two_week", pacific_ms(2026, 6, 1), pacific_ms(2026, 6, 15)),
            ("two_week", pacific_ms(2026, 6, 15), pacific_ms(2026, 6, 29)),
            ("two_week", pacific_ms(2026, 7, 1), pacific_ms(2026, 7, 15)),
        ]
        data["aiMemorySummaries"] = [
            {
                "id": f"summary-{index}",
                "periodType": memory_type,
                "periodStartAt": start,
                "periodEndAt": end,
                "bullets": [f"{memory_type} {index}"],
                "sourceSessionIds": [],
                "sourceNoteIds": [],
                "sourceSummaryIds": [],
                "updatedAt": end,
            }
            for index, (memory_type, start, end) in enumerate(periods)
        ]
        existing = [
            {
                "id": f"workout:{session['id']}",
                "memoryType": "workout",
                "sourceWorkoutSessionId": session["id"],
                "bullets": ["existing"],
            }
            for session in data["workoutSessions"]
        ]

        bundle = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=self.memory_body(existing),
            recovery=self.recovery,
            today=self.today,
        )
        packet = bundle.inputs["briefingEvidencePacket"]
        exposures = packet["comparableMovementExposures"][0]["exposures"]
        self.assertEqual(
            [item["sourceSessionId"] for item in exposures], ["rare-old-squat"]
        )
        summaries = packet["olderPeriodicSummaries"]
        self.assertGreaterEqual(
            sum(item["memoryType"] == "two_week" for item in summaries), 2
        )
        self.assertGreaterEqual(
            sum(item["memoryType"] == "four_month" for item in summaries), 1
        )
        self.assertIn("summary-0", {item["sourceSummaryId"] for item in summaries})

    def test_large_text_and_set_histories_are_excerpted_and_compacted(self) -> None:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        data["exercises"] = [{"id": "squat", "name": "Squat"}]
        completed_at = self.updated_at - 10_000
        session = self.session(
            "large-session",
            completed_at,
            exercises=[("squat", "5-8")],
        )
        data["workoutSessions"] = [session]
        all_sets = [
            {
                **self.logged_set(
                    f"set-{index:03d}",
                    session["id"],
                    "squat",
                    session["startedAt"] + index,
                    weight=100 + index,
                    reps=5,
                ),
                "setNumber": index + 1,
            }
            for index in range(40)
        ]
        data["loggedSets"] = all_sets
        note_body = "Chest day was routine. " + "x" * 4_000 + " Severe chest pain today."
        data["aiNotes"] = [
            {
                "id": "large-note",
                "body": note_body,
                "createdAt": self.updated_at - 1,
                "updatedAt": self.updated_at - 1,
            }
        ]
        context_body = (
            "Training notes. " + "y" * 5_000 + " Fever today and not resolved."
        )
        existing = [
            {
                "id": "workout:large-session",
                "memoryType": "workout",
                "sourceWorkoutSessionId": "large-session",
                "bullets": ["existing"],
            }
        ]
        bundle = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=self.memory_body(existing, current_context=context_body),
            recovery=self.recovery,
            today=self.today,
        )
        packet = bundle.inputs["briefingEvidencePacket"]
        context = packet["safetyAndUserContext"]["currentContext"]
        note = next(
            item
            for item in packet["safetyAndUserContext"]["safetyEvents"]
            if item.get("sourceNoteId") == "large-note"
        )
        self.assertLessEqual(len(context["body"]), runner.CURRENT_CONTEXT_EXCERPT_MAX_CHARS)
        self.assertLessEqual(len(note["body"]), runner.NOTE_EXCERPT_MAX_CHARS)
        self.assertTrue(context["bodyTruncation"]["truncated"])
        self.assertTrue(note["bodyTruncation"]["truncated"])
        self.assertIn("Fever today", context["body"])
        self.assertIn("Severe chest pain", note["body"])
        self.assertIn(context["evidenceId"], bundle.rest_evidence_ids)
        self.assertIn(note["evidenceId"], bundle.rest_evidence_ids)

        work = packet["recentSessionEpisodes"][0]["loggedWork"][0]
        self.assertEqual(len(work["sets"]), runner.MAX_RETAINED_SETS_PER_EXERCISE)
        self.assertEqual(work["setCompaction"]["totalLoggedSetCount"], len(all_sets))
        self.assertEqual(
            work["setCompaction"]["omittedLoggedSetCount"],
            len(all_sets) - runner.MAX_RETAINED_SETS_PER_EXERCISE,
        )
        self.assertLessEqual(
            bundle.telemetry["totalInputBytes"], runner.MODEL_INPUT_PACKET_MAX_BYTES
        )
        serialized = json.dumps(bundle.inputs)
        self.assertNotIn(note_body, serialized)
        self.assertNotIn(context_body, serialized)

    def test_worst_case_recent_episodes_and_current_plan_fit_the_packet_budget(
        self,
    ) -> None:
        def long_value(prefix: str, index: int, maximum: int = 180) -> str:
            stem = f"{prefix}-{index}-"
            return stem + "x" * (maximum - len(stem))

        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        exercise_ids = [long_value("exercise", index) for index in range(20)]
        data["exercises"] = [
            {"id": exercise_id, "name": "N" * 400 + str(index)}
            for index, exercise_id in enumerate(exercise_ids)
        ]
        data["programs"] = [{"id": "program", "name": "P" * 400, "isActive": 1}]
        data["sessionTemplates"] = [
            {"id": "template", "programId": "program", "name": "T" * 400, "order": 0}
        ]
        data["templateExercises"] = [
            {
                "id": long_value("template-row", index),
                "sessionTemplateId": "template",
                "exerciseId": exercise_id,
                "order": index,
                "targetSets": 4,
                "targetRepRange": "5-8 " + "r" * 400,
            }
            for index, exercise_id in enumerate(exercise_ids)
        ]
        sessions = []
        logged_sets = []
        for session_index in range(3):
            completed_at = self.updated_at - (session_index + 1) * 10_000
            session_id = long_value("session", session_index, 170)
            session = self.session(
                session_id,
                completed_at,
                exercises=[
                    (exercise_id, "5-8 " + "r" * 400)
                    for exercise_id in exercise_ids[:12]
                ],
            )
            session["name"] = "S" * 400 + str(session_index)
            sessions.append(session)
            for exercise_index, exercise_id in enumerate(exercise_ids[:12]):
                for set_index in range(10):
                    set_id = long_value(
                        f"set-{session_index}-{exercise_index}", set_index
                    )
                    logged_set = self.logged_set(
                        set_id,
                        session_id,
                        exercise_id,
                        completed_at - 1_000 + set_index,
                        weight=100 + set_index,
                        reps=5,
                    )
                    logged_set["setNumber"] = set_index + 1
                    logged_sets.append(logged_set)
        period_start = pacific_ms(2026, 7, 1)
        period_end = pacific_ms(2026, 7, 15)
        periodic_sessions = []
        for session_index in range(40):
            completed_at = period_start + (session_index + 1) * 60_000
            periodic_sessions.append(
                {
                    "id": f"period-session-{session_index:02d}",
                    "name": f"Period session {session_index}",
                    "startedAt": completed_at - 30_000,
                    "completedAt": completed_at,
                    "exerciseSnapshot": [],
                }
            )
        sessions.extend(periodic_sessions)
        data["workoutSessions"] = sessions
        data["loggedSets"] = logged_sets
        existing = [
            {
                "id": f"workout:{session['id']}",
                "memoryType": "workout",
                "sourceWorkoutSessionId": session["id"],
                "bullets": ["existing"],
            }
            for session in sessions
        ]
        memory = self.memory_body(existing)
        memory["state"]["windowStartedAt"] = period_start
        memory["state"]["fourMonthStartedAt"] = period_start

        bundle = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=memory,
            recovery=self.recovery,
            today=self.today,
        )
        packet = bundle.inputs["briefingEvidencePacket"]
        self.assertEqual(len(packet["recentSessionEpisodes"]), 3)
        for episode in packet["recentSessionEpisodes"]:
            self.assertLessEqual(
                len(episode["loggedWork"]),
                runner.MAX_RETAINED_EXERCISES_PER_EPISODE,
            )
            self.assertTrue(
                all(
                    len(work["sets"]) <= runner.MAX_RETAINED_SETS_PER_EXERCISE
                    for work in episode["loggedWork"]
                )
            )
            self.assertLessEqual(
                episode["episodeBudgetCompaction"]["finalBytes"],
                runner.SESSION_EPISODE_MAX_BYTES,
            )
            self.assertGreater(
                episode["episodeBudgetCompaction"]["setRowsRemovedForBudget"]
                + episode["episodeBudgetCompaction"][
                    "loggedWorkRowsRemovedForBudget"
                ]
                + episode["episodeBudgetCompaction"]["planRowsRemovedForBudget"],
                0,
            )
        self.assertLessEqual(
            len(packet["currentProgrammedSession"]["sessionTemplate"]["exercises"]),
            runner.MAX_RETAINED_CURRENT_PLAN_EXERCISES,
        )
        self.assertLessEqual(
            packet["currentProgrammedSession"]["planBudgetCompaction"]["finalBytes"],
            runner.CURRENT_PROGRAMMED_SESSION_MAX_BYTES,
        )
        self.assertGreater(
            packet["currentProgrammedSession"]["planBudgetCompaction"][
                "exerciseRowsRemovedForBudget"
            ],
            0,
        )
        self.assertLessEqual(
            bundle.telemetry["totalInputBytes"], runner.MODEL_INPUT_PACKET_MAX_BYTES
        )
        self.assertEqual(
            bundle.telemetry["totalInputBytes"], runner.compact_json_bytes(bundle.inputs)
        )
        candidate_id = f"two_week:{period_start}:{period_end}"
        self.assertNotIn(
            candidate_id,
            [item["id"] for item in bundle.inputs["supervisorCandidatePlan"]],
        )
        self.assertIn(
            candidate_id, bundle.memory_candidate_plan.deferred_candidate_ids
        )
        self.assertGreater(bundle.telemetry["retainedComparatorCount"], 0)
        self.assertEqual(
            bundle.telemetry["deferredMemoryCandidateReasons"][candidate_id],
            "input_budget",
        )
        self.assertNotIn(
            candidate_id,
            {
                item["candidateId"]
                for item in bundle.inputs["memorySourcePacket"][
                    "periodicCandidateDigests"
                ]
            },
        )

    def test_memory_source_packet_contains_only_candidate_sources(self) -> None:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        sessions = [
            self.session(f"session-{index}", self.updated_at - (6 - index) * 10_000)
            for index in range(1, 6)
        ]
        data["workoutSessions"] = sessions
        first = sessions[0]
        data["aiNotes"] = [
            {
                "id": "candidate-note",
                "body": "Felt focused during the first session.",
                "createdAt": first["startedAt"] + 1_000,
                "updatedAt": first["startedAt"] + 1_000,
            },
            *[
                {
                    "id": f"newer-note-{index}",
                    "body": f"General note {index}",
                    "createdAt": self.updated_at - index,
                    "updatedAt": self.updated_at - index,
                }
                for index in range(6)
            ],
        ]
        existing = [
            {
                "id": f"workout:session-{index}",
                "memoryType": "workout",
                "sourceWorkoutSessionId": f"session-{index}",
                "bullets": ["existing"],
            }
            for index in (3, 4, 5)
        ]
        bundle = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=self.memory_body(existing),
            recovery=self.recovery,
            today=self.today,
        )
        source_packet = bundle.inputs["memorySourcePacket"]
        plan = bundle.inputs["supervisorCandidatePlan"]
        self.assertEqual(
            [item["sourceWorkoutSessionId"] for item in plan],
            ["session-1", "session-2"],
        )
        self.assertEqual(
            [item["sourceSessionId"] for item in source_packet["sessionEpisodes"]],
            ["session-1", "session-2"],
        )
        self.assertEqual(
            [item["sourceNoteId"] for item in source_packet["sourceNotes"]],
            ["candidate-note"],
        )
        self.assertEqual(source_packet["sourceSummaries"], [])
        serialized = json.dumps(source_packet)
        for unrelated in ("session-3", "session-4", "session-5"):
            self.assertNotIn(unrelated, serialized)

    def test_newest_summary_copy_wins_and_identity_conflicts_fail_closed(self) -> None:
        start = pacific_ms(2026, 5, 1)
        end = pacific_ms(2026, 5, 15)

        def copies(snapshot_updated_at: int, cloud_updated_at: int) -> tuple[dict, dict]:
            body = self.empty_body()
            body["snapshot"]["payload"]["data"]["workoutSessions"] = [
                self.session("completed-baseline", self.updated_at - 10_000)
            ]
            body["snapshot"]["payload"]["data"]["aiMemorySummaries"] = [
                {
                    "id": "shared-summary",
                    "periodType": "two_week",
                    "periodStartAt": start,
                    "periodEndAt": end,
                    "bullets": ["SNAPSHOT_COPY"],
                    "sourceSessionIds": ["locally-edited-source"],
                    "sourceNoteIds": [],
                    "sourceSummaryIds": [],
                    "updatedAt": snapshot_updated_at,
                }
            ]
            memory = self.memory_body(
                [
                    {
                        "id": "shared-summary",
                        "memoryType": "two_week",
                        "periodStartAt": start,
                        "periodEndAt": end,
                        "bullets": ["CLOUD_COPY"],
                        "sourceSessionIds": ["cloud-source"],
                        "sourceNoteIds": [],
                        "sourceSummaryIds": [],
                        "updatedAt": cloud_updated_at,
                    }
                ]
            )
            return body, memory

        for snapshot_updated_at, cloud_updated_at, expected_store, expected_bullet in (
            (300, 200, "snapshot", "SNAPSHOT_COPY"),
            (200, 300, "cloud_memory", "CLOUD_COPY"),
            (300, 300, "cloud_memory", "CLOUD_COPY"),
        ):
            with self.subTest(
                snapshot_updated_at=snapshot_updated_at,
                cloud_updated_at=cloud_updated_at,
            ):
                body, memory = copies(snapshot_updated_at, cloud_updated_at)
                pool = runner.memory_summary_pool(self.facts(body), memory["items"])
                winner = pool["shared-summary"]
                self.assertEqual(winner["sourceStore"], expected_store)
                self.assertEqual(winner["bullets"], [expected_bullet])
                self.assertEqual(winner["sourceSessionIds"], ["cloud-source"])
                self.assertEqual(
                    winner["_provenanceSourceStore"], "cloud_memory"
                )

        body, memory = copies(300, 200)
        memory["items"][0]["periodEndAt"] = end + 1
        with self.assertRaisesRegex(
            runner.ConfigError, "Conflicting trusted memory summary id"
        ):
            runner.memory_summary_pool(self.facts(body), memory["items"])

    def test_summary_provenance_closes_over_source_summaries(self) -> None:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        data["workoutSessions"] = [
            self.session("source-session", self.updated_at - 10_000)
        ]
        data["aiMemorySummaries"] = [
            {
                "id": "source-two-week",
                "periodType": "two_week",
                "periodStartAt": pacific_ms(2026, 3, 1),
                "periodEndAt": pacific_ms(2026, 3, 15),
                "bullets": ["Source period"],
                "sourceSessionIds": ["source-session"],
                "sourceNoteIds": [],
                "sourceSummaryIds": [],
                "updatedAt": self.updated_at,
            },
            {
                "id": "rollup-four-month",
                "periodType": "four_month",
                "periodStartAt": pacific_ms(2026, 1, 1),
                "periodEndAt": pacific_ms(2026, 5, 1),
                "bullets": ["Rollup period"],
                "sourceSessionIds": [],
                "sourceNoteIds": [],
                "sourceSummaryIds": ["source-two-week"],
                "updatedAt": self.updated_at,
            },
        ]

        pool = runner.memory_summary_pool(self.facts(body), [])
        rollup = pool["rollup-four-month"]
        self.assertEqual(rollup["_allSourceSessionIds"], ["source-session"])
        self.assertEqual(rollup["sourceSessionIds"], ["source-session"])
        retained, _ = runner.build_older_periodic_summaries(
            pool,
            {"source-session"},
            None,
        )
        self.assertNotIn(
            "rollup-four-month",
            [item["sourceSummaryId"] for item in retained],
        )

        data["aiMemorySummaries"][1]["sourceSummaryIds"] = ["missing-summary"]
        with self.assertRaisesRegex(
            runner.ConfigError, "references an unavailable source"
        ):
            runner.memory_summary_pool(self.facts(body), [])

    def test_workout_memory_allows_only_notes_within_the_session_window(self) -> None:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        session = self.session("session-window", self.updated_at - 10_000)
        data["workoutSessions"] = [session]
        data["aiNotes"] = [
            {
                "id": "before-note",
                "body": "Written just before training started.",
                "createdAt": session["startedAt"] - 1,
                "updatedAt": session["startedAt"] - 1,
            },
            {
                "id": "inside-note",
                "body": "Written during the workout.",
                "createdAt": session["startedAt"] + 1,
                "updatedAt": session["startedAt"] + 1,
            },
            {
                "id": "after-note",
                "body": "Written just after training ended.",
                "createdAt": session["completedAt"] + 1,
                "updatedAt": session["completedAt"] + 1,
            },
        ]

        bundle = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=self.memory_body(),
            recovery=self.recovery,
            today=self.today,
        )

        candidate = bundle.inputs["supervisorCandidatePlan"][0]
        self.assertEqual(candidate["sourceWorkoutSessionId"], "session-window")
        self.assertEqual(candidate["allowedSourceNoteIds"], ["inside-note"])
        references = set(
            bundle.inputs["memorySourcePacket"]["briefingEvidenceReferences"]
        )
        self.assertIn(runner.evidence_id("note", "inside-note"), references)
        self.assertNotIn(runner.evidence_id("note", "before-note"), references)
        self.assertNotIn(runner.evidence_id("note", "after-note"), references)

    def test_workout_memory_backfill_is_batched_and_reports_the_backlog(self) -> None:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        sessions = [
            self.session(
                f"backfill-{index:02d}",
                self.updated_at - (12 - index) * 10_000,
            )
            for index in range(12)
        ]
        data["workoutSessions"] = sessions
        bundle = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=self.memory_body(),
            recovery=self.recovery,
            today=self.today,
        )

        plan = bundle.inputs["supervisorCandidatePlan"]
        expected_ids = [f"backfill-{index:02d}" for index in range(8)]
        self.assertEqual(
            [item["sourceWorkoutSessionId"] for item in plan], expected_ids
        )
        self.assertEqual(
            bundle.telemetry["memoryWorkoutCandidateCount"],
            runner.MAX_WORKOUT_MEMORY_CANDIDATES,
        )
        self.assertEqual(bundle.telemetry["memoryWorkoutBacklogCount"], 4)
        self.assertEqual(
            bundle.inputs["memorySourcePacket"]["missingness"][
                "workoutCandidateBacklogCount"
            ],
            4,
        )
        source_packet_ids = {
            item["sourceSessionId"]
            for item in bundle.inputs["memorySourcePacket"]["sessionEpisodes"]
        }
        source_packet_ids.update(
            item["sourceSessionId"]
            for item in bundle.inputs["briefingEvidencePacket"][
                "recentSessionEpisodes"
            ]
            if item["sourceStoryId"]
            in bundle.inputs["memorySourcePacket"]["briefingSourceStoryReferences"]
        )
        self.assertEqual(source_packet_ids, set(expected_ids))

    def test_dense_memory_candidates_are_deferred_with_canonical_byte_accounting(
        self,
    ) -> None:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        sessions = []
        notes = []
        for session_index in range(8):
            completed_at = pacific_ms(2026, 7, 1 + session_index, 12)
            session = self.session(f"dense-{session_index}", completed_at)
            sessions.append(session)
            for note_index in range(runner.MAX_MEMORY_NOTES_PER_CANDIDATE):
                notes.append(
                    {
                        "id": f"dense-note-{session_index}-{note_index}",
                        "body": (
                            f"Session {session_index} note {note_index}: "
                            + chr(65 + session_index) * runner.NOTE_EXCERPT_MAX_CHARS
                        ),
                        "createdAt": session["startedAt"] + note_index + 1,
                        "updatedAt": session["startedAt"] + note_index + 1,
                    }
                )
        data["workoutSessions"] = sessions
        data["aiNotes"] = notes
        start = pacific_ms(2026, 7, 1)
        memory = {
            "revision": 0,
            "state": {
                "currentContext": "",
                "paused": False,
                "windowStartedAt": start,
                "fourMonthStartedAt": start,
            },
            "items": [],
        }

        bundle = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=memory,
            recovery=self.recovery,
            today=self.today,
        )
        telemetry = bundle.telemetry
        selected_plan_ids = [
            item["id"] for item in bundle.inputs["supervisorCandidatePlan"]
        ]
        internal_plan_ids = [
            item["expected"]["id"]
            for item in bundle.memory_candidate_plan.candidates
        ]
        self.assertEqual(selected_plan_ids, internal_plan_ids)
        self.assertTrue(telemetry["deferredMemoryCandidateIds"])
        self.assertGreater(telemetry["deferredMemoryWorkoutCandidateCount"], 0)
        self.assertGreaterEqual(telemetry["deferredMemoryPeriodicCandidateCount"], 1)
        self.assertEqual(
            set(telemetry["deferredMemoryCandidateReasons"].values()),
            {"input_budget"},
        )
        self.assertEqual(
            telemetry["selectedMemoryCandidateCount"], len(selected_plan_ids)
        )
        self.assertEqual(
            telemetry["selectedMemoryWorkoutCandidateCount"]
            + telemetry["deferredMemoryWorkoutCandidateCount"],
            runner.MAX_WORKOUT_MEMORY_CANDIDATES,
        )
        self.assertEqual(
            telemetry["briefingPacketBytes"],
            runner.compact_json_bytes(bundle.inputs["briefingEvidencePacket"]),
        )
        self.assertEqual(
            telemetry["memorySourcePacketBytes"],
            runner.compact_json_bytes(bundle.inputs["memorySourcePacket"]),
        )
        self.assertEqual(
            telemetry["supervisorPlanBytes"],
            runner.compact_json_bytes(bundle.inputs["supervisorCandidatePlan"]),
        )
        self.assertEqual(
            telemetry["totalInputBytes"], runner.compact_json_bytes(bundle.inputs)
        )
        self.assertEqual(
            telemetry["inputBudgetRemainingBytes"],
            telemetry["maxInputBytes"] - telemetry["totalInputBytes"],
        )
        self.assertLessEqual(
            telemetry["totalInputBytes"], telemetry["maxInputBytes"]
        )

    def test_periodic_memory_defers_before_the_last_unique_comparator(self) -> None:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        data["exercises"] = [
            {"id": "squat", "name": "Squat"},
            {"id": "bench", "name": "Bench"},
        ]
        data["programs"] = [
            {"id": "program", "name": "Plan", "isActive": 1}
        ]
        data["sessionTemplates"] = [
            {
                "id": "today-template",
                "programId": "program",
                "name": "Today",
                "order": 0,
            }
        ]
        data["templateExercises"] = [
            {
                "id": "today-squat",
                "sessionTemplateId": "today-template",
                "exerciseId": "squat",
                "order": 0,
                "targetSets": 3,
                "targetRepRange": "5-8",
            }
        ]
        sessions = []
        logged_sets = []
        for days_ago in range(6):
            exercise_id = "bench" if days_ago < 3 else "squat"
            session_id = f"session-{exercise_id}-{days_ago}"
            completed_at = int(
                (
                    dt.datetime(2026, 8, 1, 12, tzinfo=PACIFIC)
                    - dt.timedelta(days=days_ago)
                ).timestamp()
                * 1000
            )
            sessions.append(
                self.session(
                    session_id,
                    completed_at,
                    exercises=[(exercise_id, "5-8")],
                )
            )
            logged_sets.append(
                self.logged_set(
                    f"set-{session_id}",
                    session_id,
                    exercise_id,
                    completed_at - 1_000,
                )
            )
        data["workoutSessions"] = sessions
        data["loggedSets"] = logged_sets
        facts = self.facts(body)
        memory = self.memory_body(
            [
                {
                    "id": f"workout:{session['id']}",
                    "memoryType": "workout",
                    "sourceWorkoutSessionId": session["id"],
                    "bullets": ["existing"],
                }
                for session in sessions
            ]
        )
        period_start = pacific_ms(2026, 7, 1)
        memory["state"]["windowStartedAt"] = period_start
        memory["state"]["fourMonthStartedAt"] = period_start

        bundle = runner.build_model_input_bundle(
            facts=facts,
            memory_body=memory,
            recovery=self.recovery,
            today="2026-08-01",
        )
        periodic_id = f"two_week:{period_start}:{pacific_ms(2026, 7, 15)}"
        constrained = None
        for _ in range(20):
            movement = bundle.inputs["briefingEvidencePacket"][
                "comparableMovementExposures"
            ][0]
            periodic_selected = periodic_id in {
                item["id"] for item in bundle.inputs["supervisorCandidatePlan"]
            }
            if len(movement["exposures"]) == 1 and periodic_selected:
                constrained = runner.build_model_input_bundle(
                    facts=facts,
                    memory_body=memory,
                    recovery=self.recovery,
                    today="2026-08-01",
                    max_input_bytes=bundle.telemetry["totalInputBytes"] - 1,
                )
                break
            bundle = runner.build_model_input_bundle(
                facts=facts,
                memory_body=memory,
                recovery=self.recovery,
                today="2026-08-01",
                max_input_bytes=bundle.telemetry["totalInputBytes"] - 1,
            )

        self.assertIsNotNone(constrained)
        assert constrained is not None
        movement = constrained.inputs["briefingEvidencePacket"][
            "comparableMovementExposures"
        ][0]
        self.assertEqual(len(movement["exposures"]), 1)
        self.assertEqual(movement["exerciseId"], "squat")
        self.assertIn(
            periodic_id, constrained.memory_candidate_plan.deferred_candidate_ids
        )
        self.assertNotIn(
            periodic_id,
            {item["id"] for item in constrained.inputs["supervisorCandidatePlan"]},
        )

    def test_long_history_is_deterministic_and_telemetry_matches_packet_bytes(
        self,
    ) -> None:
        body = self.empty_body()
        data = body["snapshot"]["payload"]["data"]
        sessions = [
            self.session(
                f"history-{index:03d}",
                self.updated_at - (100 - index) * 10_000,
            )
            for index in range(80)
        ]
        data["workoutSessions"] = sessions
        data["recommendations"] = [
            {"id": f"irrelevant-{index}", "headline": "x" * 500}
            for index in range(100)
        ]
        existing = [
            {
                "id": f"workout:{item['id']}",
                "memoryType": "workout",
                "sourceWorkoutSessionId": item["id"],
                "bullets": ["existing"],
            }
            for item in sessions
        ]
        memory = self.memory_body(existing)
        first = runner.build_model_input_bundle(
            facts=self.facts(body),
            memory_body=memory,
            recovery=self.recovery,
            today=self.today,
        )

        reordered = json.loads(json.dumps(body))
        reordered_data = reordered["snapshot"]["payload"]["data"]
        for table in reordered_data.values():
            if isinstance(table, list):
                table.reverse()
        second = runner.build_model_input_bundle(
            facts=self.facts(reordered),
            memory_body={**memory, "items": list(reversed(memory["items"]))},
            recovery=self.recovery,
            today=self.today,
        )

        self.assertEqual(first.inputs, second.inputs)
        self.assertLessEqual(
            first.telemetry["totalInputBytes"], runner.MODEL_INPUT_PACKET_MAX_BYTES
        )
        self.assertEqual(
            first.telemetry["totalInputBytes"], runner.compact_json_bytes(first.inputs)
        )
        self.assertEqual(
            first.telemetry["briefingPacketBytes"],
            runner.compact_json_bytes(first.inputs["briefingEvidencePacket"]),
        )
        self.assertEqual(
            first.telemetry["memorySourcePacketBytes"],
            runner.compact_json_bytes(first.inputs["memorySourcePacket"]),
        )
        self.assertEqual(
            first.inputs["briefingEvidencePacket"]["allowedEvidenceIds"],
            sorted(first.allowed_evidence_ids),
        )
        self.assertEqual(
            first.telemetry["allowedEvidenceIdCount"], len(first.allowed_evidence_ids)
        )


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

    def two_week_summary_chain(
        self,
        start: int,
        *,
        count: int = runner.FOUR_MONTH_ROLLUP_PERIOD_COUNT,
        id_prefix: str = "trusted-two-week",
    ) -> tuple[list[dict], int]:
        summaries = []
        cursor = start
        for index in range(count):
            end = runner.add_calendar_days_ms(
                cursor, runner.TWO_WEEK_PERIOD_DAYS
            )
            summaries.append(
                {
                    "id": f"{id_prefix}-{index}",
                    "periodType": "two_week",
                    "periodStartAt": cursor,
                    "periodEndAt": end,
                    "bullets": [f"Period {index}"],
                    "sourceSessionIds": [],
                    "sourceNoteIds": [],
                    "sourceSummaryIds": [],
                    "model": "codex",
                    "createdAt": end,
                    "updatedAt": end,
                }
            )
            cursor = end
        return summaries, cursor

    def validate(
        self,
        output: dict,
        memory: dict | None = None,
        *,
        facts: runner.SnapshotFacts | None = None,
        today: str = "2026-08-01",
        generated_at: int | None = None,
        input_bundle: runner.ModelInputBundle | None = None,
        packet_telemetry: dict | None = None,
        recovery: dict | None = None,
    ) -> dict:
        memory_body = dict(memory) if memory is not None else {"state": None, "items": []}
        memory_body.setdefault("revision", 0)
        return runner.validate_model_output(
            output,
            facts=facts or self.facts,
            memory_body=memory_body,
            recovery=recovery if recovery is not None else self.recovery,
            today=today,
            run_id="test-run",
            prompt_hash="abc123",
            model=runner.DEFAULT_CODEX_MODEL,
            reasoning_effort="xhigh",
            codex_version="codex-cli test",
            generated_at=(
                generated_at if generated_at is not None else self.updated_at + 1
            ),
            input_bundle=input_bundle,
            packet_telemetry=packet_telemetry,
        )

    def progression_bundle(
        self,
        session_specs: list[dict],
        *,
        include_plan: bool = True,
        today_target_range: str = "5-8",
    ) -> tuple[runner.SnapshotFacts, dict, runner.ModelInputBundle]:
        body = snapshot_body(self.updated_at)
        data = body["snapshot"]["payload"]["data"]
        for table in (
            "exercises",
            "programs",
            "sessionTemplates",
            "templateExercises",
            "workoutSessions",
            "loggedSets",
            "aiMemorySettings",
            "aiNotes",
            "aiMemorySummaries",
        ):
            data[table] = []
        data["exercises"] = [
            {"id": "squat", "name": "Squat"},
            {"id": "bench", "name": "Bench"},
        ]
        if include_plan:
            data["programs"] = [
                {"id": "program", "name": "Plan", "isActive": 1}
            ]
            data["sessionTemplates"] = [
                {
                    "id": "today-template",
                    "programId": "program",
                    "name": "Today",
                    "order": 0,
                }
            ]
            data["templateExercises"] = [
                {
                    "id": "today-squat",
                    "sessionTemplateId": "today-template",
                    "exerciseId": "squat",
                    "order": 0,
                    "targetSets": 3,
                    "targetRepRange": today_target_range,
                }
            ]

        sessions = []
        logged_sets = []
        today_noon = dt.datetime(2026, 8, 1, 12, tzinfo=PACIFIC)
        for index, spec in enumerate(session_specs):
            completed_at = int(
                (today_noon - dt.timedelta(days=spec.get("days_ago", index + 1)))
                .timestamp()
                * 1000
            )
            session_id = spec.get("id", f"session-{index}")
            exercise_id = spec.get("exercise_id", "squat")
            target_range = spec.get("target_range", "5-8")
            target_sets = spec.get("target_sets", 3)
            session = {
                "id": session_id,
                "name": session_id,
                "programId": None,
                "programName": None,
                "sessionTemplateId": None,
                "startedAt": completed_at - 3_600_000,
                "completedAt": completed_at,
                "exerciseSnapshot": [
                    {
                        "exerciseId": exercise_id,
                        "order": 0,
                        "targetSets": target_sets,
                        "targetRepRange": target_range,
                    }
                ],
            }
            if "pre" in spec:
                session["preWorkoutCheckIn"] = {
                    "version": 1,
                    "perceivedRecovery": spec["pre"],
                    "recordedAt": completed_at - 3_000,
                }
            if spec.get("post", True):
                session["postWorkoutFeedback"] = {
                    "version": 2,
                    "performance": spec.get("performance", 3),
                    "sessionRpe": spec.get("session_rpe", 7),
                    "painImpact": spec.get("pain", "none"),
                }
            sessions.append(session)
            reps_values = spec.get(
                "reps_values",
                [spec.get("reps", 5)] * spec.get("set_count", 3),
            )
            for set_index, reps in enumerate(reps_values):
                logged_sets.append(
                    {
                        "id": f"set-{session_id}-{set_index}",
                        "workoutSessionId": session_id,
                        "exerciseId": exercise_id,
                        "setNumber": set_index + 1,
                        "weightLbs": spec.get("weight", 100),
                        "reps": reps,
                        "rpe": spec.get("set_rpe", 7),
                        "loggedAt": completed_at - 2_000 + set_index,
                    }
                )
        data["workoutSessions"] = sessions
        data["loggedSets"] = logged_sets
        facts = runner.validate_snapshot(body, dt.date(2026, 8, 1))
        start = pacific_ms(2026, 8, 1)
        memory = {
            "revision": 0,
            "state": {
                "currentContext": "",
                "paused": False,
                "windowStartedAt": start,
                "fourMonthStartedAt": start,
            },
            "items": [
                {
                    "id": f"workout:{session['id']}",
                    "memoryType": "workout",
                    "sourceWorkoutSessionId": session["id"],
                    "bullets": ["existing"],
                }
                for session in sessions
            ],
        }
        bundle = runner.build_model_input_bundle(
            facts=facts,
            memory_body=memory,
            recovery=self.recovery,
            today="2026-08-01",
        )
        return facts, memory, bundle

    def mode_output(self, mode: str, supporting_ids: list[str]) -> dict:
        output = model_output(self.updated_at)
        output["briefing"]["mode"] = mode
        output["briefing"]["supportingEvidenceIds"] = supporting_ids
        output["memory"]["newItems"] = []
        return output

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
        self.assertNotIn("supportingEvidenceIds", briefing)
        self.assertNotIn("contradictingEvidenceIds", briefing)
        self.assertEqual(
            briefing["inputSummary"]["supportingEvidenceIds"],
            [],
        )
        self.assertEqual(
            briefing["inputSummary"]["contradictingEvidenceIds"], []
        )
        self.assertEqual(
            briefing["inputSummary"]["packetSchemaVersion"],
            runner.BRIEFING_EVIDENCE_PACKET_VERSION,
        )
        self.assertLessEqual(
            briefing["inputSummary"]["totalInputBytes"],
            briefing["inputSummary"]["maxInputBytes"],
        )

    def test_evidence_references_must_be_known_unique_disjoint_and_bounded(
        self,
    ) -> None:
        valid_id = runner.evidence_id(
            "recovery",
            "2026-08-01",
            "fresh",
            runner.RECOVERY_FRESHNESS_POLICY,
        )
        cases = (
            (
                "missing supporting field",
                lambda briefing: briefing.pop("supportingEvidenceIds"),
                "briefing must contain",
            ),
            (
                "too many support ids",
                lambda briefing: briefing.__setitem__(
                    "supportingEvidenceIds", [f"unknown-{index}" for index in range(5)]
                ),
                "at most 4 ids",
            ),
            (
                "duplicate support",
                lambda briefing: briefing.__setitem__(
                    "supportingEvidenceIds", [valid_id, valid_id]
                ),
                "duplicate id",
            ),
            (
                "duplicate contradiction",
                lambda briefing: briefing.__setitem__(
                    "contradictingEvidenceIds", [valid_id, valid_id]
                ),
                "duplicate id",
            ),
            (
                "too many contradictions",
                lambda briefing: briefing.__setitem__(
                    "contradictingEvidenceIds", [f"unknown-{index}" for index in range(3)]
                ),
                "at most 2 ids",
            ),
            (
                "overlapping support and contradiction",
                lambda briefing: briefing.update(
                    {
                        "supportingEvidenceIds": [valid_id],
                        "contradictingEvidenceIds": [valid_id],
                    }
                ),
                "both support and contradict",
            ),
            (
                "unknown support",
                lambda briefing: briefing.__setitem__(
                    "supportingEvidenceIds", ["not-in-packet"]
                ),
                "unknown evidence ids",
            ),
        )
        for label, mutate, error in cases:
            with self.subTest(label=label):
                output = model_output(self.updated_at)
                mutate(output["briefing"])
                with self.assertRaisesRegex(runner.ConfigError, error):
                    self.validate(output)

    def test_evidence_references_and_prompt_telemetry_are_trusted_audit_only(
        self,
    ) -> None:
        memory = {"revision": 0, "state": None, "items": []}
        bundle = runner.build_model_input_bundle(
            facts=self.facts,
            memory_body=memory,
            recovery=self.recovery,
            today="2026-08-01",
        )
        output = model_output(self.updated_at)
        output["briefing"]["contradictingEvidenceIds"] = [
            next(iter(bundle.recovery_evidence_ids))
        ]
        with tempfile.TemporaryDirectory() as temp:
            config = test_config(Path(temp))
            prompt = runner.build_model_prompt(
                config,
                facts=self.facts,
                today="2026-08-01",
                now=dt.datetime(2026, 8, 1, 12, tzinfo=PACIFIC),
                run_id="test-run",
                prompt_hash="abc123",
                snapshot_body={"unused": True},
                memory_body=memory,
                recovery=self.recovery,
                input_bundle=bundle,
            )
        telemetry = runner.model_prompt_telemetry(prompt, bundle)
        validated = self.validate(
            output,
            memory=memory,
            input_bundle=bundle,
            packet_telemetry=telemetry,
        )
        briefing = validated["briefing"]
        self.assertNotIn("supportingEvidenceIds", briefing)
        self.assertNotIn("contradictingEvidenceIds", briefing)
        self.assertEqual(
            briefing["inputSummary"]["supportingEvidenceIds"],
            output["briefing"]["supportingEvidenceIds"],
        )
        self.assertEqual(
            briefing["inputSummary"]["contradictingEvidenceIds"],
            output["briefing"]["contradictingEvidenceIds"],
        )
        for field, value in telemetry.items():
            self.assertEqual(briefing["inputSummary"][field], value)

        invalid_telemetry = dict(telemetry)
        invalid_telemetry["promptBudgetRemainingBytes"] += 1
        with self.assertRaisesRegex(runner.ConfigError, "inconsistent"):
            self.validate(
                output,
                memory=memory,
                input_bundle=bundle,
                packet_telemetry=invalid_telemetry,
            )

    def test_validator_uses_the_selected_memory_plan_after_budget_deferral(self) -> None:
        body = snapshot_body(self.updated_at)
        data = body["snapshot"]["payload"]["data"]
        for table in (
            "exercises",
            "programs",
            "sessionTemplates",
            "templateExercises",
            "workoutSessions",
            "loggedSets",
            "aiMemorySettings",
            "aiNotes",
            "aiMemorySummaries",
        ):
            data[table] = []
        sessions = []
        notes = []
        for session_index in range(8):
            completed_at = pacific_ms(2026, 7, 1 + session_index, 12)
            session_id = f"dense-{session_index}"
            session = {
                "id": session_id,
                "name": session_id,
                "startedAt": completed_at - 3_600_000,
                "completedAt": completed_at,
                "exerciseSnapshot": [],
            }
            sessions.append(session)
            for note_index in range(runner.MAX_MEMORY_NOTES_PER_CANDIDATE):
                notes.append(
                    {
                        "id": f"dense-note-{session_index}-{note_index}",
                        "body": (
                            f"Dense {session_index}-{note_index}: "
                            + chr(65 + session_index) * runner.NOTE_EXCERPT_MAX_CHARS
                        ),
                        "createdAt": session["startedAt"] + note_index + 1,
                        "updatedAt": session["startedAt"] + note_index + 1,
                    }
                )
        data["workoutSessions"] = sessions
        data["aiNotes"] = notes
        facts = runner.validate_snapshot(body, dt.date(2026, 8, 1))
        start = pacific_ms(2026, 7, 1)
        memory = {
            "revision": 0,
            "state": {
                "currentContext": "",
                "paused": False,
                "windowStartedAt": start,
                "fourMonthStartedAt": start,
            },
            "items": [],
        }
        bundle = runner.build_model_input_bundle(
            facts=facts,
            memory_body=memory,
            recovery=self.recovery,
            today="2026-08-01",
        )
        self.assertTrue(bundle.memory_candidate_plan.deferred_candidate_ids)
        self.assertGreater(
            bundle.telemetry["selectedMemoryWorkoutCandidateCount"], 0
        )

        selected_workouts = []
        selected_periodic_ids = []
        for candidate in bundle.memory_candidate_plan.candidates:
            expected = candidate["expected"]
            if expected["memoryType"] != "workout":
                selected_periodic_ids.append(expected["id"])
                continue
            selected_workouts.append(
                {
                    "id": expected["id"],
                    "memoryType": expected["memoryType"],
                    "periodStartAt": expected["periodStartAt"],
                    "periodEndAt": expected["periodEndAt"],
                    "sourceWorkoutSessionId": expected["sourceWorkoutSessionId"],
                    "bullets": ["Selected bounded workout memory."],
                    "sourceSessionIds": expected["sourceSessionIds"],
                    "sourceNoteIds": [],
                    "sourceSummaryIds": expected["sourceSummaryIds"],
                }
            )
        output = self.mode_output("normal", [])
        output["memory"]["newItems"] = selected_workouts
        validated = self.validate(
            output,
            facts=facts,
            memory=memory,
            input_bundle=bundle,
        )
        deferred = validated["briefing"]["inputSummary"]["deferredMemoryItemIds"]
        budget_deferred = list(bundle.memory_candidate_plan.deferred_candidate_ids)
        self.assertEqual(deferred[: len(budget_deferred)], budget_deferred)
        self.assertTrue(set(selected_periodic_ids).issubset(deferred))
        self.assertEqual(
            [item["id"] for item in validated["memory"]["items"]],
            [item["id"] for item in selected_workouts],
        )

        unexpected = self.mode_output("normal", [])
        unexpected["memory"]["newItems"] = [
            *selected_workouts,
            {
                "id": budget_deferred[0],
                "memoryType": "workout",
                "periodStartAt": start,
                "periodEndAt": start + 1,
                "sourceWorkoutSessionId": "deferred",
                "bullets": ["must reject"],
                "sourceSessionIds": ["deferred"],
                "sourceNoteIds": [],
                "sourceSummaryIds": [],
            },
        ]
        with self.assertRaisesRegex(runner.ConfigError, "unexpected memory items"):
            self.validate(
                unexpected,
                facts=facts,
                memory=memory,
                input_bundle=bundle,
            )

    def test_dense_closed_period_is_summarized_from_a_projection_and_restored(
        self,
    ) -> None:
        body = snapshot_body(self.updated_at)
        data = body["snapshot"]["payload"]["data"]
        for table in (
            "exercises",
            "programs",
            "sessionTemplates",
            "templateExercises",
            "workoutSessions",
            "loggedSets",
            "aiMemorySettings",
            "aiNotes",
            "aiMemorySummaries",
        ):
            data[table] = []
        period_start = pacific_ms(2026, 7, 1)
        period_end = pacific_ms(2026, 7, 15)
        sessions = []
        for index in range(40):
            completed_at = period_start + (index + 1) * 60_000
            sessions.append(
                {
                    "id": f"period-session-{index:02d}",
                    "name": f"Period session {index}",
                    "startedAt": completed_at - 30_000,
                    "completedAt": completed_at,
                    "exerciseSnapshot": [],
                }
            )
        data["workoutSessions"] = sessions
        facts = runner.validate_snapshot(body, dt.date(2026, 8, 1))
        memory = {
            "revision": 0,
            "state": {
                "currentContext": "",
                "paused": False,
                "windowStartedAt": period_start,
                "fourMonthStartedAt": period_start,
            },
            "items": [
                {
                    "id": f"workout:{session['id']}",
                    "memoryType": "workout",
                    "sourceWorkoutSessionId": session["id"],
                    "bullets": ["existing"],
                }
                for session in sessions
            ],
        }
        bundle = runner.build_model_input_bundle(
            facts=facts,
            memory_body=memory,
            recovery=self.recovery,
            today="2026-08-01",
        )
        plan = bundle.inputs["supervisorCandidatePlan"]
        candidate = next(item for item in plan if item["memoryType"] == "two_week")
        candidate_id = f"two_week:{period_start}:{period_end}"
        self.assertEqual(candidate["id"], candidate_id)
        self.assertEqual(
            candidate["sourceSessionIdCompaction"]["totalCount"], len(sessions)
        )
        self.assertEqual(
            candidate["sourceSessionIdCompaction"]["retainedCount"],
            runner.MAX_MEMORY_SESSION_SOURCES_PER_CANDIDATE,
        )
        self.assertEqual(
            candidate["sourceSessionIdCompaction"]["omittedCount"],
            len(sessions) - runner.MAX_MEMORY_SESSION_SOURCES_PER_CANDIDATE,
        )
        self.assertEqual(
            candidate["sourceProvenancePolicy"],
            "model_returns_projection_supervisor_restores_canonical_v1",
        )
        self.assertNotIn(candidate_id, bundle.memory_candidate_plan.deferred_candidate_ids)
        source_packet = bundle.inputs["memorySourcePacket"]
        self.assertEqual(source_packet["sessionEpisodes"], [])
        digest = next(
            item
            for item in source_packet["periodicCandidateDigests"]
            if item["candidateId"] == candidate_id
        )
        self.assertEqual(digest["aggregate"]["availableSessionCount"], len(sessions))
        self.assertEqual(
            bundle.telemetry["totalInputBytes"], runner.compact_json_bytes(bundle.inputs)
        )

        output = self.mode_output("normal", [])
        output["memory"]["newItems"] = [
            {
                "id": candidate_id,
                "memoryType": "two_week",
                "periodStartAt": period_start,
                "periodEndAt": period_end,
                "sourceWorkoutSessionId": None,
                "bullets": ["Dense period summarized from the bounded digest."],
                "sourceSessionIds": candidate["sourceSessionIds"],
                "sourceNoteIds": [],
                "sourceSummaryIds": candidate["sourceSummaryIds"],
            }
        ]
        validated = self.validate(
            output,
            facts=facts,
            memory=memory,
            input_bundle=bundle,
        )
        item = validated["memory"]["items"][0]
        self.assertEqual(item["sourceSessionIds"], [session["id"] for session in sessions])
        self.assertEqual(validated["memory"]["state"]["windowStartedAt"], period_end)

        tampered = self.mode_output("normal", [])
        tampered["memory"]["newItems"] = [
            {
                "id": candidate_id,
                "memoryType": "two_week",
                "periodStartAt": period_start,
                "periodEndAt": period_end,
                "sourceWorkoutSessionId": None,
                "bullets": ["Attempted provenance tamper."],
                "sourceSessionIds": candidate["sourceSessionIds"][:-1],
                "sourceNoteIds": [],
                "sourceSummaryIds": candidate["sourceSummaryIds"],
            }
        ]
        with self.assertRaisesRegex(runner.ConfigError, "invalid sourceSessionIds"):
            self.validate(
                tampered,
                facts=facts,
                memory=memory,
                input_bundle=bundle,
            )

    def test_push_requires_retained_external_work_evidence(self) -> None:
        body = snapshot_body(self.updated_at)
        data = body["snapshot"]["payload"]["data"]
        data["exercises"] = [{"id": "squat", "name": "Squat"}]
        data["programs"] = [{"id": "program", "name": "Plan", "isActive": 1}]
        data["sessionTemplates"] = [
            {"id": "today", "programId": "program", "name": "Today", "order": 0}
        ]
        data["templateExercises"] = [
            {
                "id": "today-squat",
                "sessionTemplateId": "today",
                "exerciseId": "squat",
                "order": 0,
                "targetSets": 1,
                "targetRepRange": "5-8",
            }
        ]
        data["workoutSessions"][0]["exerciseSnapshot"] = [
            {
                "exerciseId": "squat",
                "order": 0,
                "targetSets": 1,
                "targetRepRange": "5-8",
            }
        ]
        data["loggedSets"] = [
            {
                "id": "set-1",
                "workoutSessionId": "session-1",
                "exerciseId": "squat",
                "setNumber": 1,
                "weightLbs": 225,
                "reps": 5,
                "rpe": 7,
                "loggedAt": self.updated_at - 1_500,
            }
        ]
        facts = runner.validate_snapshot(body, dt.date(2026, 8, 1))
        memory = {"revision": 0, "state": None, "items": []}
        bundle = runner.build_model_input_bundle(
            facts=facts,
            memory_body=memory,
            recovery=self.recovery,
            today="2026-08-01",
        )
        output = model_output(self.updated_at)
        output["briefing"]["mode"] = "push"

        with self.assertRaisesRegex(
            runner.ConfigError,
            "explicit retained evidence",
        ):
            self.validate(
                output,
                memory=memory,
                facts=facts,
                input_bundle=bundle,
            )

        work_id = runner.evidence_id("work", "session-1", "squat")
        self.assertIn(work_id, bundle.external_work_evidence_ids)
        output["briefing"]["supportingEvidenceIds"] = [work_id]
        with self.assertRaisesRegex(
            runner.ConfigError,
            "repeated high-quality scheduled-movement evidence",
        ):
            self.validate(
                output,
                memory=memory,
                facts=facts,
                input_bundle=bundle,
            )

    def test_wearable_recovery_alone_cannot_select_light_or_deload(self) -> None:
        facts, memory, bundle = self.progression_bundle(
            [
                {"id": "stable-new", "days_ago": 1, "weight": 100},
                {"id": "stable-old", "days_ago": 2, "weight": 100},
            ]
        )
        recovery_id = next(iter(bundle.recovery_evidence_ids))
        for mode in ("light", "deload"):
            with self.subTest(mode=mode):
                output = self.mode_output(mode, [recovery_id])
                with self.assertRaisesRegex(
                    runner.ConfigError,
                    (
                        "actual adverse non-wearable evidence"
                        if mode == "light"
                        else "repeated comparable external decline"
                    ),
                ):
                    self.validate(
                        output,
                        facts=facts,
                        memory=memory,
                        input_bundle=bundle,
                    )

        output = self.mode_output("normal", [recovery_id])
        validated = self.validate(
            output,
            facts=facts,
            memory=memory,
            input_bundle=bundle,
        )
        self.assertEqual(validated["briefing"]["mode"], "normal")

    def test_current_context_safety_can_authorize_rest(self) -> None:
        start = pacific_ms(2026, 8, 1)
        context_text = "Fever today; skip training until it resolves."
        memory = {
            "revision": 0,
            "state": {
                "currentContext": context_text,
                "paused": False,
                "windowStartedAt": start,
                "fourMonthStartedAt": start,
            },
            "items": [],
        }
        bundle = runner.build_model_input_bundle(
            facts=self.facts,
            memory_body=memory,
            recovery=self.recovery,
            today="2026-08-01",
        )
        context_id = runner.evidence_id(
            "context", "ai-memory-state:default", context_text
        )
        self.assertIn(context_id, bundle.safety_evidence_ids)
        output = model_output(self.updated_at)
        output["briefing"]["mode"] = "rest"
        output["briefing"]["supportingEvidenceIds"] = [context_id]

        validated = self.validate(
            output,
            memory=memory,
            input_bundle=bundle,
        )
        self.assertEqual(validated["briefing"]["mode"], "rest")

    def test_sparse_normal_accepts_no_evidence_but_adaptive_modes_do_not(self) -> None:
        body = snapshot_body(self.updated_at)
        data = body["snapshot"]["payload"]["data"]
        for table in (
            "exercises",
            "programs",
            "sessionTemplates",
            "templateExercises",
            "workoutSessions",
            "loggedSets",
            "aiMemorySettings",
            "aiNotes",
            "aiMemorySummaries",
        ):
            data[table] = []
        data["workoutSessions"] = [
            {
                "id": "legacy-empty",
                "name": "Legacy empty workout",
                "startedAt": self.updated_at - 2_000,
                "completedAt": self.updated_at - 1_000,
                "exerciseSnapshot": [],
            }
        ]
        facts = runner.validate_snapshot(body, dt.date(2026, 8, 1))
        recovery = {
            "generatedAt": "2026-08-01T12:00:00-07:00",
            "status": "unavailable",
            "freshnessPolicy": runner.RECOVERY_FRESHNESS_POLICY,
            "evaluationDate": "2026-08-01",
            "latestReadiness": None,
            "latestSleep": None,
        }
        memory = {
            "revision": 0,
            "state": None,
            "items": [
                {
                    "id": "workout:legacy-empty",
                    "memoryType": "workout",
                    "sourceWorkoutSessionId": "legacy-empty",
                    "bullets": ["existing"],
                }
            ],
        }
        bundle = runner.build_model_input_bundle(
            facts=facts,
            memory_body=memory,
            recovery=recovery,
            today="2026-08-01",
        )
        current = bundle.inputs["briefingEvidencePacket"]["currentProgrammedSession"]
        self.assertEqual(current["status"], "unavailable")
        self.assertNotIn("evidenceId", current)
        self.assertNotIn(
            "evidenceId", bundle.inputs["briefingEvidencePacket"]["freshRecoveryLane"]
        )
        self.assertEqual(bundle.allowed_evidence_ids, frozenset())

        output = self.mode_output("normal", [])
        validated = self.validate(
            output,
            facts=facts,
            memory=memory,
            recovery=recovery,
            input_bundle=bundle,
        )
        self.assertEqual(validated["briefing"]["mode"], "normal")
        for mode in ("push", "light", "deload", "rest"):
            with self.subTest(mode=mode), self.assertRaisesRegex(
                runner.ConfigError, "requires explicit retained evidence"
            ):
                self.validate(
                    self.mode_output(mode, []),
                    facts=facts,
                    memory=memory,
                    recovery=recovery,
                    input_bundle=bundle,
                )

    def test_safety_negation_benign_chest_and_current_recurrence(self) -> None:
        start = pacific_ms(2026, 8, 1)
        cases = (
            ("Chest day is the next programmed workout.", False),
            ("No chest pain today.", False),
            ("Prior chest pain, now resolved.", False),
            ("Chest pain last week. It is resolved now.", False),
            ("Chest pain last week. It returned today.", True),
            ("Chest pain last week. Symptoms returned today.", True),
            ("Chest pain last week. They returned today.", True),
            ("Chest pain last week. Symptoms returned to normal today.", False),
            ("Chest pain last week. Symptoms returned to baseline today.", False),
            ("Chest pain last week. They returned to training today.", False),
            ("Chest pain last week. They returned home today.", False),
            ("Chest pain today. Fever resolved.", True),
            ("No chest pain yesterday, but chest pain returned today.", True),
            ("I have the flu and feel sick today.", True),
            ("I tested positive for COVID today.", True),
            ("I tested negative for COVID today.", False),
            ("I am vomiting and cannot train today.", True),
            ("I haven't vomited today.", False),
            ("Shortness of breath today.", True),
            ("Shortness of breath has resolved.", False),
            ("I passed out today.", True),
            ("I did not pass out today.", False),
            ("I had chest pain yesterday but no chest pain today.", False),
            ("Chest pain has not returned.", False),
            ("Chest pain today has not worsened.", True),
            ("Chest pain has not returned but has worsened today.", True),
        )
        for context_text, expected_rest in cases:
            with self.subTest(context_text=context_text):
                memory = {
                    "revision": 0,
                    "state": {
                        "currentContext": context_text,
                        "paused": False,
                        "windowStartedAt": start,
                        "fourMonthStartedAt": start,
                    },
                    "items": [],
                }
                bundle = runner.build_model_input_bundle(
                    facts=self.facts,
                    memory_body=memory,
                    recovery=self.recovery,
                    today="2026-08-01",
                )
                context_id = runner.evidence_id(
                    "context", "ai-memory-state:default", context_text
                )
                self.assertIn(context_id, bundle.allowed_evidence_ids)
                self.assertEqual(context_id in bundle.rest_evidence_ids, expected_rest)
                self.assertEqual(
                    context_id in bundle.push_blocking_evidence_ids,
                    expected_rest,
                )
                output = model_output(self.updated_at)
                output["briefing"]["mode"] = "rest"
                output["briefing"]["supportingEvidenceIds"] = [context_id]
                if expected_rest:
                    self.assertEqual(
                        self.validate(
                            output, memory=memory, input_bundle=bundle
                        )["briefing"]["mode"],
                        "rest",
                    )
                else:
                    with self.assertRaisesRegex(
                        runner.ConfigError, "stopped-pain or unresolved red-flag"
                    ):
                        self.validate(output, memory=memory, input_bundle=bundle)

    def test_explicit_current_safety_blocks_an_otherwise_valid_push(self) -> None:
        facts, memory, _ = self.progression_bundle(
            [
                {"id": "good-new", "days_ago": 1, "weight": 105},
                {"id": "good-old", "days_ago": 2, "weight": 100},
            ]
        )
        for context_text in (
            "Chest pain last week. Symptoms returned today.",
            "Shortness of breath today.",
            "I passed out today.",
        ):
            with self.subTest(context_text=context_text):
                memory["state"]["currentContext"] = context_text
                bundle = runner.build_model_input_bundle(
                    facts=facts,
                    memory_body=memory,
                    recovery=self.recovery,
                    today="2026-08-01",
                )
                context_id = runner.evidence_id(
                    "context", "ai-memory-state:default", context_text
                )
                self.assertTrue(bundle.push_evidence_groups)
                self.assertIn(context_id, bundle.rest_evidence_ids)
                self.assertIn(context_id, bundle.push_blocking_evidence_ids)
                with self.assertRaisesRegex(runner.ConfigError, "blocked"):
                    self.validate(
                        self.mode_output(
                            "push", sorted(bundle.push_evidence_groups[0])
                        ),
                        facts=facts,
                        memory=memory,
                        input_bundle=bundle,
                    )

    def test_edited_note_uses_content_update_time_for_current_safety(self) -> None:
        start = pacific_ms(2026, 8, 1)
        note_updated_at = pacific_ms(2026, 8, 1, 9)
        facts = self.facts_with_memory(
            window_started_at=start,
            notes=[
                {
                    "id": "edited-safety-note",
                    "body": "Severe chest pain today.",
                    "createdAt": pacific_ms(2026, 6, 1),
                    "updatedAt": note_updated_at,
                }
            ],
        )
        bundle = runner.build_model_input_bundle(
            facts=facts,
            memory_body={"revision": 0, "state": None, "items": []},
            recovery=self.recovery,
            today="2026-08-01",
        )

        safety_note = bundle.inputs["briefingEvidencePacket"][
            "safetyAndUserContext"
        ]["safetyEvents"][0]
        self.assertEqual(safety_note["createdAt"], pacific_ms(2026, 6, 1))
        self.assertEqual(safety_note["observedAt"], note_updated_at)
        self.assertEqual(safety_note["observedDate"], "2026-08-01")
        self.assertEqual(safety_note["timestampMeaning"], "note_content_updated_at")
        self.assertIn(safety_note["evidenceId"], bundle.rest_evidence_ids)

    def test_present_no_effect_cannot_authorize_rest_but_stopped_can(self) -> None:
        for pain, expected_rest in (("present_no_effect", False), ("stopped", True)):
            with self.subTest(pain=pain):
                facts, memory, bundle = self.progression_bundle(
                    [{"id": "pain-session", "days_ago": 1, "pain": pain}]
                )
                safety_id = runner.evidence_id("safety", "pain-session")
                self.assertEqual(safety_id in bundle.rest_evidence_ids, expected_rest)
                output = self.mode_output("rest", [safety_id])
                if expected_rest:
                    self.assertEqual(
                        self.validate(
                            output,
                            facts=facts,
                            memory=memory,
                            input_bundle=bundle,
                        )["briefing"]["mode"],
                        "rest",
                    )
                else:
                    with self.assertRaisesRegex(
                        runner.ConfigError, "stopped-pain or unresolved red-flag"
                    ):
                        self.validate(
                            output,
                            facts=facts,
                            memory=memory,
                            input_bundle=bundle,
                        )

    def test_push_requires_repeated_stable_or_improving_completed_work(self) -> None:
        good_specs = [
            {"id": "new-good", "days_ago": 1, "weight": 105},
            {"id": "old-good", "days_ago": 2, "weight": 100},
        ]
        facts, memory, bundle = self.progression_bundle(good_specs)
        self.assertEqual(len(bundle.push_evidence_groups), 1)
        group = sorted(bundle.push_evidence_groups[0])
        exposures = bundle.inputs["briefingEvidencePacket"][
            "comparableMovementExposures"
        ][0]["exposures"]
        self.assertTrue(
            all(
                exposure["programCompletion"]["eligibleForProgressionTrend"]
                for exposure in exposures
            )
        )
        validated = self.validate(
            self.mode_output("push", group),
            facts=facts,
            memory=memory,
            input_bundle=bundle,
        )
        self.assertEqual(validated["briefing"]["mode"], "push")

        facts, memory, declining = self.progression_bundle(
            [
                {"id": "new-decline", "days_ago": 1, "weight": 90},
                {"id": "old-decline", "days_ago": 2, "weight": 100},
            ]
        )
        self.assertEqual(declining.push_evidence_groups, ())
        work_ids = sorted(declining.external_work_evidence_ids)
        with self.assertRaisesRegex(
            runner.ConfigError, "repeated high-quality scheduled-movement evidence"
        ):
            self.validate(
                self.mode_output("push", work_ids[:2]),
                facts=facts,
                memory=memory,
                input_bundle=declining,
            )

        facts, memory, unrelated = self.progression_bundle(
            [
                {
                    "id": "bench-new",
                    "days_ago": 1,
                    "exercise_id": "bench",
                    "weight": 105,
                    "performance": 5,
                },
                {
                    "id": "bench-old",
                    "days_ago": 2,
                    "exercise_id": "bench",
                    "weight": 100,
                    "performance": 5,
                },
            ]
        )
        self.assertEqual(unrelated.push_evidence_groups, ())
        with self.assertRaisesRegex(
            runner.ConfigError, "repeated high-quality scheduled-movement evidence"
        ):
            self.validate(
                self.mode_output(
                    "push",
                    sorted(unrelated.external_work_evidence_ids)[:2],
                ),
                facts=facts,
                memory=memory,
                input_bundle=unrelated,
            )

    def test_target_range_variants_match_but_incomplete_targets_cannot_progress(
        self,
    ) -> None:
        facts, memory, canonical = self.progression_bundle(
            [
                {
                    "id": "variant-new",
                    "days_ago": 1,
                    "weight": 105,
                    "target_range": "5 to 8 reps",
                },
                {
                    "id": "variant-old",
                    "days_ago": 2,
                    "weight": 100,
                    "target_range": "5-8",
                },
            ],
            today_target_range="5–8",
        )
        exposures = canonical.inputs["briefingEvidencePacket"][
            "comparableMovementExposures"
        ][0]["exposures"]
        self.assertEqual(len(exposures), 2)
        self.assertTrue(
            all(
                item["comparability"] == "same_exercise_same_target_rep_range"
                and item["programCompletion"]["eligibleForProgressionTrend"]
                for item in exposures
            )
        )
        self.assertTrue(canonical.push_evidence_groups)

        invalid_specs = (
            {"target_sets": 0},
            {"set_count": 2},
            {"reps_values": [5, 9, 5]},
            {"target_range": "around five"},
            {"target_range": "10-12"},
        )
        for mutation in invalid_specs:
            with self.subTest(mutation=mutation):
                bad = {
                    "id": "bad-new",
                    "days_ago": 1,
                    "weight": 105,
                    **mutation,
                }
                _, _, bundle = self.progression_bundle(
                    [bad, {"id": "good-old", "days_ago": 2, "weight": 100}]
                )
                exposures = bundle.inputs["briefingEvidencePacket"][
                    "comparableMovementExposures"
                ][0]["exposures"]
                bad_exposure = next(
                    item for item in exposures if item["sourceSessionId"] == "bad-new"
                )
                self.assertFalse(
                    bad_exposure["programCompletion"]["eligibleForProgressionTrend"]
                )
                self.assertEqual(bundle.push_evidence_groups, ())

    def test_recent_scheduled_pain_or_high_effort_blocks_push(self) -> None:
        for mutation in (
            {"pain": "present_no_effect"},
            {"session_rpe": 9},
        ):
            with self.subTest(mutation=mutation):
                specs = [
                    {"id": "adverse", "days_ago": 0, "weight": 106, **mutation},
                    {"id": "good-new", "days_ago": 1, "weight": 105},
                    {"id": "good-old", "days_ago": 2, "weight": 100},
                ]
                facts, memory, bundle = self.progression_bundle(specs)
                self.assertTrue(bundle.push_evidence_groups)
                self.assertTrue(bundle.push_blocking_evidence_ids)
                with self.assertRaisesRegex(runner.ConfigError, "blocked"):
                    self.validate(
                        self.mode_output(
                            "push", sorted(bundle.push_evidence_groups[0])
                        ),
                        facts=facts,
                        memory=memory,
                        input_bundle=bundle,
                    )

    def test_unrelated_pain_blocks_push_but_unrelated_low_outcome_does_not(self) -> None:
        for pain in ("present_no_effect", "modified"):
            with self.subTest(pain=pain):
                facts, memory, bundle = self.progression_bundle(
                    [
                        {
                            "id": "unrelated-pain",
                            "days_ago": 0,
                            "exercise_id": "bench",
                            "pain": pain,
                        },
                        {"id": "good-new", "days_ago": 1, "weight": 105},
                        {"id": "good-old", "days_ago": 2, "weight": 100},
                    ]
                )
                self.assertTrue(bundle.push_blocking_evidence_ids)
                with self.assertRaisesRegex(runner.ConfigError, "blocked"):
                    self.validate(
                        self.mode_output(
                            "push", sorted(bundle.push_evidence_groups[0])
                        ),
                        facts=facts,
                        memory=memory,
                        input_bundle=bundle,
                    )

        facts, memory, bundle = self.progression_bundle(
            [
                {
                    "id": "unrelated-subjective",
                    "days_ago": 0,
                    "exercise_id": "bench",
                    "performance": 1,
                    "session_rpe": 9,
                },
                {"id": "good-new", "days_ago": 1, "weight": 105},
                {"id": "good-old", "days_ago": 2, "weight": 100},
            ]
        )
        self.assertFalse(bundle.push_blocking_evidence_ids)
        self.assertEqual(
            self.validate(
                self.mode_output("push", sorted(bundle.push_evidence_groups[0])),
                facts=facts,
                memory=memory,
                input_bundle=bundle,
            )["briefing"]["mode"],
            "push",
        )

    def test_deload_requires_three_declines_and_a_nonwearable_adverse_atom(self) -> None:
        decline_specs = [
            {"id": "decline-new", "days_ago": 1, "weight": 80},
            {"id": "decline-middle", "days_ago": 2, "weight": 90},
            {"id": "decline-old", "days_ago": 3, "weight": 100},
        ]
        facts, memory, no_adverse = self.progression_bundle(decline_specs)
        self.assertEqual(len(no_adverse.deload_decline_groups), 1)
        decline_ids = sorted(no_adverse.deload_decline_groups[0])
        with self.assertRaisesRegex(runner.ConfigError, "second adverse evidence domain"):
            self.validate(
                self.mode_output("deload", decline_ids),
                facts=facts,
                memory=memory,
                input_bundle=no_adverse,
            )
        recovery_id = next(iter(no_adverse.recovery_evidence_ids))
        with self.assertRaisesRegex(runner.ConfigError, "second adverse evidence domain"):
            self.validate(
                self.mode_output("deload", [*decline_ids, recovery_id]),
                facts=facts,
                memory=memory,
                input_bundle=no_adverse,
            )

        outcome_specs = [dict(item) for item in decline_specs]
        outcome_specs[0]["performance"] = 1
        facts, memory, outcome_only = self.progression_bundle(outcome_specs)
        decline_ids = sorted(outcome_only.deload_decline_groups[0])
        outcome_id = runner.evidence_id("subjective-outcome", "decline-new")
        self.assertIn(outcome_id, outcome_only.light_adverse_evidence_ids)
        self.assertNotIn(
            outcome_id, outcome_only.deload_secondary_adverse_evidence_ids
        )
        with self.assertRaisesRegex(
            runner.ConfigError, "second adverse evidence domain"
        ):
            self.validate(
                self.mode_output("deload", [*decline_ids, outcome_id]),
                facts=facts,
                memory=memory,
                input_bundle=outcome_only,
            )

        historical_prs_specs = [dict(item) for item in decline_specs]
        historical_prs_specs[0]["pre"] = 3
        facts, memory, historical_prs = self.progression_bundle(
            historical_prs_specs
        )
        decline_ids = sorted(historical_prs.deload_decline_groups[0])
        historical_prs_id = runner.evidence_id(
            "subjective-state", "decline-new"
        )
        self.assertNotIn(
            historical_prs_id,
            historical_prs.deload_secondary_adverse_evidence_ids,
        )
        with self.assertRaisesRegex(
            runner.ConfigError, "second adverse evidence domain"
        ):
            self.validate(
                self.mode_output(
                    "deload", [*decline_ids, historical_prs_id]
                ),
                facts=facts,
                memory=memory,
                input_bundle=historical_prs,
            )

        adverse_specs = [dict(item) for item in decline_specs]
        adverse_specs[0].update({"performance": 1, "session_rpe": 9})
        facts, memory, valid = self.progression_bundle(adverse_specs)
        decline_ids = sorted(valid.deload_decline_groups[0])
        adverse_id = runner.evidence_id("internal-response", "decline-new")
        self.assertIn(adverse_id, valid.deload_secondary_adverse_evidence_ids)
        validated = self.validate(
            self.mode_output("deload", [*decline_ids, adverse_id]),
            facts=facts,
            memory=memory,
            input_bundle=valid,
        )
        self.assertEqual(validated["briefing"]["mode"], "deload")

        facts, memory, only_two = self.progression_bundle(adverse_specs[:2])
        with self.assertRaisesRegex(
            runner.ConfigError, "repeated comparable external decline"
        ):
            self.validate(
                self.mode_output(
                    "deload",
                    [
                        runner.evidence_id("work", item["id"], "squat")
                        for item in adverse_specs[:2]
                    ]
                    + [adverse_id],
                ),
                facts=facts,
                memory=memory,
                input_bundle=only_two,
            )

    def test_historical_isolated_adverse_atoms_do_not_authorize_light(self) -> None:
        cases = (
            (
                {"pre": 2, "performance": 5, "session_rpe": 5},
                "subjective-state",
            ),
            (
                {"pre": 8, "performance": 5, "session_rpe": 9},
                "internal-response",
            ),
            (
                {"performance": 5, "pain": "present_no_effect"},
                "safety",
            ),
        )
        for mutation, evidence_kind in cases:
            with self.subTest(mutation=mutation):
                facts, memory, bundle = self.progression_bundle(
                    [{"id": "isolated", "days_ago": 6, **mutation}]
                )
                atom_id = runner.evidence_id(evidence_kind, "isolated")
                self.assertIn(atom_id, bundle.allowed_evidence_ids)
                self.assertNotIn(atom_id, bundle.light_adverse_evidence_ids)
                with self.assertRaisesRegex(
                    runner.ConfigError, "actual adverse non-wearable evidence"
                ):
                    self.validate(
                        self.mode_output("light", [atom_id]),
                        facts=facts,
                        memory=memory,
                        input_bundle=bundle,
                    )

    def test_adaptive_modes_require_an_available_current_plan(self) -> None:
        facts, memory, light_bundle = self.progression_bundle(
            [{"id": "adverse", "days_ago": 1, "pre": 2}],
            include_plan=False,
        )
        adverse_id = runner.evidence_id("subjective-state", "adverse")
        with self.assertRaisesRegex(runner.ConfigError, "current trainable session"):
            self.validate(
                self.mode_output("light", [adverse_id]),
                facts=facts,
                memory=memory,
                input_bundle=light_bundle,
            )

        specs = [
            {"id": "decline-new", "days_ago": 1, "weight": 80, "pre": 2},
            {"id": "decline-middle", "days_ago": 2, "weight": 90},
            {"id": "decline-old", "days_ago": 3, "weight": 100},
        ]
        facts, memory, deload_bundle = self.progression_bundle(specs)
        deload_bundle.inputs["briefingEvidencePacket"]["currentProgrammedSession"] = {
            "status": "unavailable",
            "sourceStoryId": runner.evidence_id("story", "plan", "unavailable"),
            "sourceIds": [],
            "missingness": {
                "activeProgram": "missing",
                "sessionTemplate": "missing",
            },
        }
        decline_ids = sorted(deload_bundle.deload_decline_groups[0])
        with self.assertRaisesRegex(runner.ConfigError, "current trainable session"):
            self.validate(
                self.mode_output(
                    "deload",
                    [
                        *decline_ids,
                        runner.evidence_id("subjective-state", "decline-new"),
                    ],
                ),
                facts=facts,
                memory=memory,
                input_bundle=deload_bundle,
            )

    def test_old_adverse_feedback_is_visible_but_not_actionable_at_day_eight(self) -> None:
        def bundle_for_age(days_ago: int) -> tuple:
            return self.progression_bundle(
                [
                    {
                        "id": "old-pain",
                        "days_ago": days_ago,
                        "exercise_id": "bench",
                        "pain": "stopped",
                    },
                    {"id": "good-new", "days_ago": 1, "weight": 105},
                    {"id": "good-old", "days_ago": 2, "weight": 100},
                ]
            )

        facts, memory, stale = bundle_for_age(runner.RECENT_ADVERSE_WINDOW_DAYS + 1)
        safety_id = runner.evidence_id("safety", "old-pain")
        self.assertIn(safety_id, stale.allowed_evidence_ids)
        self.assertNotIn(safety_id, stale.rest_evidence_ids)
        self.assertNotIn(safety_id, stale.light_adverse_evidence_ids)
        self.assertFalse(stale.push_blocking_evidence_ids)
        for mode, error in (
            ("rest", "stopped-pain or unresolved red-flag"),
            ("light", "actual adverse non-wearable evidence"),
        ):
            with self.subTest(mode=mode), self.assertRaisesRegex(
                runner.ConfigError, error
            ):
                self.validate(
                    self.mode_output(mode, [safety_id]),
                    facts=facts,
                    memory=memory,
                    input_bundle=stale,
                )
        self.assertEqual(
            self.validate(
                self.mode_output("push", sorted(stale.push_evidence_groups[0])),
                facts=facts,
                memory=memory,
                input_bundle=stale,
            )["briefing"]["mode"],
            "push",
        )

        facts, memory, boundary = bundle_for_age(runner.RECENT_ADVERSE_WINDOW_DAYS)
        self.assertIn(safety_id, boundary.rest_evidence_ids)
        self.assertIn(safety_id, boundary.light_adverse_evidence_ids)
        self.assertIn(safety_id, boundary.push_blocking_evidence_ids)
        self.assertEqual(
            self.validate(
                self.mode_output("rest", [safety_id]),
                facts=facts,
                memory=memory,
                input_bundle=boundary,
            )["briefing"]["mode"],
            "rest",
        )

    def test_performance_comparator_window_is_inclusive_at_day_ninety(self) -> None:
        window = runner.PERFORMANCE_COMPARATOR_WINDOW_DAYS
        _, _, push_boundary = self.progression_bundle(
            [
                {"id": "push-new", "days_ago": window - 1, "weight": 105},
                {"id": "push-old", "days_ago": window, "weight": 100},
            ]
        )
        self.assertEqual(len(push_boundary.push_evidence_groups), 1)

        _, _, push_stale = self.progression_bundle(
            [
                {"id": "push-new", "days_ago": window - 1, "weight": 105},
                {"id": "push-old", "days_ago": window + 1, "weight": 100},
            ]
        )
        stale_exposures = push_stale.inputs["briefingEvidencePacket"][
            "comparableMovementExposures"
        ][0]["exposures"]
        self.assertEqual(len(stale_exposures), 2)
        self.assertEqual(push_stale.push_evidence_groups, ())

        _, _, deload_boundary = self.progression_bundle(
            [
                {"id": "decline-new", "days_ago": window - 2, "weight": 80},
                {"id": "decline-middle", "days_ago": window - 1, "weight": 90},
                {"id": "decline-old", "days_ago": window, "weight": 100},
            ]
        )
        self.assertEqual(len(deload_boundary.deload_decline_groups), 1)

        _, _, deload_stale = self.progression_bundle(
            [
                {"id": "decline-new", "days_ago": window - 2, "weight": 80},
                {"id": "decline-middle", "days_ago": window - 1, "weight": 90},
                {"id": "decline-old", "days_ago": window + 1, "weight": 100},
            ]
        )
        stale_declines = deload_stale.inputs["briefingEvidencePacket"][
            "comparableMovementExposures"
        ][0]["exposures"]
        self.assertEqual(len(stale_declines), 3)
        self.assertEqual(deload_stale.deload_decline_groups, ())

    def test_same_story_work_atoms_collapse_on_one_side_but_cross_side_is_allowed(
        self,
    ) -> None:
        body = snapshot_body(self.updated_at)
        data = body["snapshot"]["payload"]["data"]
        data["exercises"] = [
            {"id": "squat", "name": "Squat"},
            {"id": "bench", "name": "Bench"},
        ]
        session = data["workoutSessions"][0]
        session["exerciseSnapshot"] = [
            {"exerciseId": "squat", "order": 0, "targetSets": 1, "targetRepRange": "5-8"},
            {"exerciseId": "bench", "order": 1, "targetSets": 1, "targetRepRange": "5-8"},
        ]
        data["loggedSets"] = [
            {
                "id": "squat-set",
                "workoutSessionId": "session-1",
                "exerciseId": "squat",
                "setNumber": 1,
                "weightLbs": 100,
                "reps": 5,
                "rpe": 7,
                "loggedAt": self.updated_at - 1_500,
            },
            {
                "id": "bench-set",
                "workoutSessionId": "session-1",
                "exerciseId": "bench",
                "setNumber": 1,
                "weightLbs": 100,
                "reps": 5,
                "rpe": 7,
                "loggedAt": self.updated_at - 1_400,
            },
        ]
        facts = runner.validate_snapshot(body, dt.date(2026, 8, 1))
        memory = {"revision": 0, "state": None, "items": []}
        bundle = runner.build_model_input_bundle(
            facts=facts,
            memory_body=memory,
            recovery=self.recovery,
            today="2026-08-01",
        )
        squat_id = runner.evidence_id("work", "session-1", "squat")
        bench_id = runner.evidence_id("work", "session-1", "bench")
        output = model_output(self.updated_at)
        output["briefing"]["supportingEvidenceIds"] = [squat_id, bench_id]
        with self.assertRaisesRegex(runner.ConfigError, "correlated atoms"):
            self.validate(
                output, facts=facts, memory=memory, input_bundle=bundle
            )

        output["briefing"]["supportingEvidenceIds"] = [squat_id]
        output["briefing"]["contradictingEvidenceIds"] = [bench_id]
        validated = self.validate(
            output, facts=facts, memory=memory, input_bundle=bundle
        )
        self.assertEqual(
            validated["briefing"]["inputSummary"]["supportingEvidenceIds"],
            [squat_id],
        )
        self.assertEqual(
            validated["briefing"]["inputSummary"]["contradictingEvidenceIds"],
            [bench_id],
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
        four_month_start = runner.add_calendar_days_ms(
            two_week_start,
            -runner.TWO_WEEK_PERIOD_DAYS
            * (runner.FOUR_MONTH_ROLLUP_PERIOD_COUNT - 1),
        )
        existing_children, chain_end = self.two_week_summary_chain(
            four_month_start,
            count=runner.FOUR_MONTH_ROLLUP_PERIOD_COUNT - 1,
        )
        self.assertEqual(chain_end, two_week_start)
        four_month_end = two_week_end
        facts = self.facts_with_memory(
            window_started_at=two_week_start,
            four_month_started_at=four_month_start,
            summaries=existing_children,
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
        memory = {"revision": 0, "state": None, "items": []}
        bundle = runner.build_model_input_bundle(
            facts=facts,
            memory_body=memory,
            recovery=self.recovery,
            today="2026-08-01",
        )
        projected_four_month = next(
            item
            for item in bundle.inputs["supervisorCandidatePlan"]
            if item["memoryType"] == "four_month"
        )
        invalid["memory"]["newItems"].append(
            summary_item(
                "four_month",
                four_month_start,
                four_month_end,
                source_summary_ids=projected_four_month["sourceSummaryIds"],
            )
        )
        with self.assertRaisesRegex(runner.ConfigError, "deferred summary"):
            self.validate(
                invalid,
                facts=facts,
                memory=memory,
                input_bundle=bundle,
            )

    def test_four_month_rollup_waits_for_two_week_lineage_to_catch_up(self) -> None:
        period_start = pacific_ms(2026, 4, 1)
        facts = self.facts_with_memory(
            window_started_at=period_start,
            four_month_started_at=period_start,
        )
        bundle = runner.build_model_input_bundle(
            facts=facts,
            memory_body={"revision": 0, "state": None, "items": []},
            recovery=self.recovery,
            today="2026-08-01",
        )

        candidate_types = [
            candidate["expected"]["memoryType"]
            for candidate in bundle.memory_candidate_plan.candidates
        ]
        self.assertIn("two_week", candidate_types)
        self.assertNotIn("four_month", candidate_types)
        self.assertEqual(
            bundle.memory_candidate_plan.trusted_state["fourMonthStartedAt"],
            period_start,
        )

    def test_long_term_rollups_cover_every_two_week_child_across_boundaries(
        self,
    ) -> None:
        start = pacific_ms(2025, 1, 31)
        child_count = runner.FOUR_MONTH_ROLLUP_PERIOD_COUNT * 3
        child_summaries, end = self.two_week_summary_chain(
            start, count=child_count
        )
        facts = self.facts_with_memory(
            window_started_at=end,
            four_month_started_at=start,
            summaries=child_summaries,
        )
        memory = {
            "revision": 0,
            "state": {
                "currentContext": "",
                "paused": False,
                "windowStartedAt": end,
                "fourMonthStartedAt": start,
            },
            "items": [],
        }
        covered_source_ids: list[str] = []
        for _ in range(3):
            plan = runner.derive_memory_candidate_plan(
                facts, memory, today="2026-08-01"
            )
            candidate = next(
                item
                for item in plan.candidates
                if item["expected"]["memoryType"] == "four_month"
            )
            expected = candidate["expected"]
            covered_source_ids.extend(expected["sourceSummaryIds"])
            memory["items"].append(
                {
                    **expected,
                    "bullets": ["Long-term context", "Long-term trend"],
                    "updatedAt": expected["periodEndAt"],
                }
            )
            memory["state"]["fourMonthStartedAt"] = candidate["cursorValue"]

        self.assertEqual(
            covered_source_ids,
            [item["id"] for item in child_summaries],
        )
        self.assertEqual(memory["state"]["fourMonthStartedAt"], end)

    def test_long_term_rollup_includes_child_crossing_a_legacy_cursor(self) -> None:
        legacy_cursor = pacific_ms(2026, 8, 1)
        crossing_start = pacific_ms(2026, 7, 22)
        child_summaries, end = self.two_week_summary_chain(crossing_start)
        facts = self.facts_with_memory(
            window_started_at=end,
            four_month_started_at=legacy_cursor,
            summaries=child_summaries,
        )
        memory = {
            "revision": 0,
            "state": {
                "currentContext": "",
                "paused": False,
                "windowStartedAt": end,
                "fourMonthStartedAt": legacy_cursor,
            },
            "items": [],
        }

        plan = runner.derive_memory_candidate_plan(
            facts, memory, today="2026-12-01"
        )
        candidate = next(
            item
            for item in plan.candidates
            if item["expected"]["memoryType"] == "four_month"
        )
        self.assertEqual(candidate["expected"]["periodStartAt"], crossing_start)
        self.assertEqual(candidate["expected"]["periodEndAt"], end)
        self.assertEqual(
            candidate["expected"]["sourceSummaryIds"],
            [item["id"] for item in child_summaries],
        )

    def test_long_term_rollup_requires_usable_authoritative_child_bullets(
        self,
    ) -> None:
        start = pacific_ms(2026, 4, 11)
        base_children, end = self.two_week_summary_chain(start)
        missing = object()

        def candidate_exists(
            snapshot_bullets: object,
            *,
            snapshot_updated_at: int = 300,
            cloud_bullets: object = missing,
            cloud_updated_at: int = 200,
        ) -> bool:
            children = [dict(item) for item in base_children]
            first = children[0]
            first["updatedAt"] = snapshot_updated_at
            if snapshot_bullets is missing:
                first.pop("bullets", None)
            else:
                first["bullets"] = snapshot_bullets
            facts = self.facts_with_memory(
                window_started_at=end,
                four_month_started_at=start,
                summaries=children,
            )
            cloud_items = []
            if cloud_bullets is not missing:
                cloud_items.append(
                    {
                        "id": first["id"],
                        "memoryType": "two_week",
                        "periodStartAt": first["periodStartAt"],
                        "periodEndAt": first["periodEndAt"],
                        "sourceWorkoutSessionId": None,
                        "sourceSessionIds": [],
                        "sourceNoteIds": [],
                        "sourceSummaryIds": [],
                        "bullets": cloud_bullets,
                        "updatedAt": cloud_updated_at,
                    }
                )
            memory = {
                "revision": 0,
                "state": {
                    "currentContext": "",
                    "paused": False,
                    "windowStartedAt": end,
                    "fourMonthStartedAt": start,
                },
                "items": cloud_items,
            }
            plan = runner.derive_memory_candidate_plan(
                facts, memory, today="2026-08-01"
            )
            return any(
                item["expected"]["memoryType"] == "four_month"
                for item in plan.candidates
            )

        for invalid_bullets in (missing, [], ["   "]):
            with self.subTest(invalid_bullets=repr(invalid_bullets)):
                self.assertFalse(candidate_exists(invalid_bullets))

        self.assertFalse(
            candidate_exists([], cloud_bullets=["Older cloud content"])
        )
        self.assertTrue(
            candidate_exists(
                [],
                snapshot_updated_at=200,
                cloud_bullets=["Newer cloud content"],
                cloud_updated_at=300,
            )
        )
        self.assertFalse(
            candidate_exists(
                ["Older snapshot content"],
                snapshot_updated_at=200,
                cloud_bullets=[],
                cloud_updated_at=300,
            )
        )
        self.assertTrue(
            candidate_exists(
                [],
                snapshot_updated_at=300,
                cloud_bullets=["Cloud wins an equal timestamp"],
                cloud_updated_at=300,
            )
        )

    def test_valid_two_week_can_advance_while_four_month_is_deferred(self) -> None:
        two_week_start = pacific_ms(2026, 7, 18)
        two_week_end = pacific_ms(2026, 8, 1)
        four_month_start = runner.add_calendar_days_ms(
            two_week_start,
            -runner.TWO_WEEK_PERIOD_DAYS
            * (runner.FOUR_MONTH_ROLLUP_PERIOD_COUNT - 1),
        )
        existing_children, chain_end = self.two_week_summary_chain(
            four_month_start,
            count=runner.FOUR_MONTH_ROLLUP_PERIOD_COUNT - 1,
        )
        self.assertEqual(chain_end, two_week_start)
        four_month_end = two_week_end
        facts = self.facts_with_memory(
            window_started_at=two_week_start,
            four_month_started_at=four_month_start,
            summaries=existing_children,
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
        self.assertIn("`preWorkoutCheckIn.version: 1`", instructions)
        self.assertIn("0-10 Perceived Recovery Status", instructions)
        self.assertIn("same user's history", instructions)
        self.assertIn("do not infer a neutral score", instructions)

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
        end = pacific_ms(2026, 8, 1)
        start = runner.add_calendar_days_ms(
            end,
            -runner.TWO_WEEK_PERIOD_DAYS
            * runner.FOUR_MONTH_ROLLUP_PERIOD_COUNT,
        )
        child_summaries, chain_end = self.two_week_summary_chain(start)
        self.assertEqual(chain_end, end)
        facts = self.facts_with_memory(
            window_started_at=end,
            four_month_started_at=start,
            summaries=child_summaries,
        )
        memory = {"revision": 0, "state": None, "items": []}
        bundle = runner.build_model_input_bundle(
            facts=facts,
            memory_body=memory,
            recovery=self.recovery,
            today="2026-08-01",
        )
        projected = next(
            item
            for item in bundle.inputs["supervisorCandidatePlan"]
            if item["memoryType"] == "four_month"
        )
        output = model_output(self.updated_at)
        output["memory"]["newItems"].append(
            summary_item(
                "four_month",
                start,
                end,
                source_summary_ids=projected["sourceSummaryIds"],
            )
        )
        validated = self.validate(
            output,
            facts=facts,
            memory=memory,
            input_bundle=bundle,
        )
        self.assertEqual(
            validated["memory"]["state"]["fourMonthStartedAt"], end
        )
        four_month = next(
            item
            for item in validated["memory"]["items"]
            if item["memoryType"] == "four_month"
        )
        self.assertEqual(
            four_month["sourceSummaryIds"],
            [item["id"] for item in child_summaries],
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
            self.validate(
                invalid,
                facts=facts,
                memory=memory,
                input_bundle=bundle,
            )

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
        recovery_fingerprint = validated["briefing"]["inputSummary"][
            "recoveryFingerprint"
        ]
        self.assertTrue(runner.valid_recovery_fingerprint(recovery_fingerprint))
        self.assertEqual(
            validated["manifest"]["recoveryFingerprint"], recovery_fingerprint
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

    def test_spool_recovery_fingerprint_is_trusted_and_current(self) -> None:
        validated = self.validate(model_output(self.updated_at))
        current_fingerprint = validated["manifest"]["recoveryFingerprint"]
        runner.validate_spool(
            validated,
            today="2026-08-01",
            snapshot_updated_at=self.updated_at,
            memory_revision=0,
            prompt_hash="abc123",
            model=runner.DEFAULT_CODEX_MODEL,
            reasoning_effort="xhigh",
            recovery_fingerprint=current_fingerprint,
        )

        with self.assertRaisesRegex(runner.ConfigError, "current recovery"):
            runner.validate_spool(
                validated,
                today="2026-08-01",
                snapshot_updated_at=self.updated_at,
                memory_revision=0,
                prompt_hash="abc123",
                model=runner.DEFAULT_CODEX_MODEL,
                reasoning_effort="xhigh",
                recovery_fingerprint=(
                    f"{runner.RECOVERY_FINGERPRINT_VERSION}:" + "0" * 64
                ),
            )

        legacy = self.validate(model_output(self.updated_at))
        legacy_fingerprint = "sanitized-recovery-v0:" + "0" * 64
        legacy["manifest"]["recoveryFingerprint"] = legacy_fingerprint
        legacy["briefing"]["inputSummary"]["recoveryFingerprint"] = (
            legacy_fingerprint
        )
        with self.assertRaisesRegex(runner.ConfigError, "fingerprint is invalid"):
            runner.validate_spool(
                legacy,
                today="2026-08-01",
                snapshot_updated_at=self.updated_at,
                memory_revision=0,
                prompt_hash="abc123",
                model=runner.DEFAULT_CODEX_MODEL,
                reasoning_effort="xhigh",
            )

    def test_rest_requires_explicit_retained_safety_evidence(self) -> None:
        output = model_output(self.updated_at)
        output["briefing"]["mode"] = "rest"
        output["briefing"]["headline"] = "Rest today and get the pain assessed"

        with self.assertRaisesRegex(runner.ConfigError, "explicit retained evidence"):
            self.validate(output)

        body = snapshot_body(self.updated_at)
        body["snapshot"]["payload"]["data"]["workoutSessions"][0][
            "postWorkoutFeedback"
        ] = {
            "version": 2,
            "performance": 2,
            "sessionRpe": 8,
            "painImpact": "stopped",
        }
        facts = runner.validate_snapshot(body, dt.date(2026, 8, 1))
        output["briefing"]["supportingEvidenceIds"] = [
            runner.evidence_id("safety", "session-1")
        ]
        validated = self.validate(output, facts=facts)
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
        self.assertEqual(
            set(briefing["properties"]),
            {
                "headline",
                "mode",
                "sections",
                "supportingEvidenceIds",
                "contradictingEvidenceIds",
            },
        )
        self.assertEqual(set(briefing["required"]), set(briefing["properties"]))
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
        self.assertEqual(
            briefing["properties"]["supportingEvidenceIds"]["minItems"], 0
        )
        self.assertEqual(
            briefing["properties"]["supportingEvidenceIds"]["maxItems"], 4
        )
        self.assertEqual(
            briefing["properties"]["contradictingEvidenceIds"]["maxItems"], 2
        )
        # Codex Structured Outputs does not support uniqueItems. The trusted
        # supervisor rejects duplicate and overlapping evidence references.
        self.assertNotIn(
            "uniqueItems", briefing["properties"]["supportingEvidenceIds"]
        )
        self.assertNotIn(
            "uniqueItems", briefing["properties"]["contradictingEvidenceIds"]
        )
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
