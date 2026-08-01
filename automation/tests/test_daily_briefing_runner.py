from __future__ import annotations

import datetime as dt
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from zoneinfo import ZoneInfo


MODULE_PATH = Path(__file__).resolve().parents[1] / "daily_briefing_runner.py"
SPEC = importlib.util.spec_from_file_location("daily_briefing_runner", MODULE_PATH)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)

PACIFIC = ZoneInfo("America/Los_Angeles")


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
                "recoveryStatus": "fresh",
                "ouraRecovery": "Readiness and sleep are fresh enough to support the normal session.",
                "trainingTrend": "Recent training is stable enough to progress from performance.",
                "watchOuts": [],
            },
            "source": "codex-local",
            "model": "gpt-5.6-sol",
            "snapshotUpdatedAt": updated_at,
            "inputSummary": {
                "snapshotUpdatedAt": updated_at,
                "latestCompletedWorkoutAt": updated_at - 1000,
                "workoutCount": 1,
                "loggedSetCount": 1,
                "usedOura": True,
                "memoryItemCount": 1,
                "newMemoryItemCount": 1,
            },
        },
        "memory": {
            "state": {
                "currentContext": "",
                "paused": False,
                "windowStartedAt": updated_at - 10000,
                "fourMonthStartedAt": updated_at - 10000,
                "sourceSnapshotUpdatedAt": updated_at,
            },
            "newItems": [
                {
                    "id": "workout:session-1",
                    "memoryType": "workout",
                    "periodStartAt": updated_at - 1000,
                    "periodEndAt": updated_at - 1000,
                    "sourceWorkoutSessionId": "session-1",
                    "bullets": ["Upper completed with one logged work set."],
                    "sourceSessionIds": ["session-1"],
                    "sourceNoteIds": [],
                    "sourceSummaryIds": [],
                    "model": "gpt-5.6-sol",
                    "createdAt": updated_at,
                    "updatedAt": updated_at,
                    "snapshotUpdatedAt": updated_at,
                }
            ],
        },
    }


class EnvTests(unittest.TestCase):
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

    def test_binary_override_is_preferred(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / "codex"
            binary.write_text("#!/bin/sh\n", encoding="utf-8")
            binary.chmod(0o700)
            self.assertEqual(runner.resolve_codex_binary(str(binary)), binary)


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


class OutputValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        now = dt.datetime(2026, 8, 1, 12, 0, tzinfo=PACIFIC)
        self.updated_at = int(now.timestamp() * 1000)
        self.facts = runner.validate_snapshot(snapshot_body(self.updated_at), now.date())
        self.recovery = {
            "status": "fresh",
            "latestReadiness": {
                "score": 80,
                "observedAt": "2026-08-01T08:00:00-07:00",
            },
            "latestSleep": {
                "score": 75,
                "observedAt": "2026-08-01T08:10:00-07:00",
            },
        }

    def validate(self, output: dict, memory: dict | None = None) -> dict:
        return runner.validate_model_output(
            output,
            facts=self.facts,
            memory_body=memory or {"state": None, "items": []},
            recovery=self.recovery,
            today="2026-08-01",
            run_id="test-run",
            prompt_hash="abc123",
            model="gpt-5.6-sol",
            reasoning_effort="xhigh",
            codex_version="codex-cli test",
        )

    def test_trusted_metadata_overrides_model_claims(self) -> None:
        output = model_output(self.updated_at)
        output["briefing"]["source"] = "untrusted"
        output["briefing"]["model"] = "untrusted"
        output["briefing"]["inputSummary"]["workoutCount"] = 999
        validated = self.validate(output)
        briefing = validated["briefing"]
        self.assertEqual(briefing["source"], "codex-local")
        self.assertEqual(briefing["model"], "gpt-5.6-sol")
        self.assertEqual(briefing["inputSummary"]["modelReasoningEffort"], "xhigh")
        self.assertEqual(briefing["inputSummary"]["workoutCount"], 1)
        self.assertEqual(briefing["inputSummary"]["newMemoryItemCount"], 1)

    def test_existing_memory_is_preserved_by_trusted_runner(self) -> None:
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
        self.assertEqual(validated["memory"]["items"][0], existing)

    def test_recovery_status_must_match_trusted_input(self) -> None:
        output = model_output(self.updated_at)
        output["briefing"]["sections"]["recoveryStatus"] = "unavailable"
        with self.assertRaises(runner.ConfigError):
            self.validate(output)

    def test_spool_requires_current_snapshot(self) -> None:
        validated = self.validate(model_output(self.updated_at))
        runner.validate_spool(
            validated,
            today="2026-08-01",
            snapshot_updated_at=self.updated_at,
            model="gpt-5.6-sol",
            reasoning_effort="xhigh",
        )
        with self.assertRaises(runner.ConfigError):
            runner.validate_spool(
                validated,
                today="2026-08-01",
                snapshot_updated_at=self.updated_at + 1,
                model="gpt-5.6-sol",
                reasoning_effort="xhigh",
            )

    def test_spool_rejects_a_different_reasoning_effort(self) -> None:
        validated = self.validate(model_output(self.updated_at))
        with self.assertRaises(runner.ConfigError):
            runner.validate_spool(
                validated,
                today="2026-08-01",
                snapshot_updated_at=self.updated_at,
                model="gpt-5.6-sol",
                reasoning_effort="medium",
            )


class SchemaTests(unittest.TestCase):
    def test_schema_is_strict_at_every_object_boundary(self) -> None:
        schema_path = MODULE_PATH.parent / "codex_daily_briefing_output_schema.json"
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        self.assertFalse(schema["additionalProperties"])
        self.assertFalse(schema["properties"]["briefing"]["additionalProperties"])
        self.assertFalse(schema["properties"]["memory"]["additionalProperties"])


if __name__ == "__main__":
    unittest.main()
