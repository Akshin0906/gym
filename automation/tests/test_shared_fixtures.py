"""Python half of the shared calculation contract.

src/lib/sharedFixtures.test.ts reads the same JSON file and asserts the same
expectations against the TypeScript implementation. If the two languages ever
disagree again — as they did when a 100 lb single estimated 103.33 here and 100
in the app — exactly one of these two suites fails.
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import json
import math
import sys
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "daily_briefing_runner.py"
SPEC = importlib.util.spec_from_file_location("daily_briefing_runner", MODULE_PATH)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)

FIXTURES = json.loads(
    (
        Path(__file__).resolve().parents[1] / "shared_fixtures" / "calculations.json"
    ).read_text(encoding="utf-8")
)


def approximately(actual: float | None, expected: float | None) -> bool:
    if actual is None or expected is None:
        return actual is expected or actual == expected
    return math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-9)


class SharedCalculationFixtureTests(unittest.TestCase):
    def test_fixture_file_is_non_empty(self) -> None:
        # Guards against a silently empty fixture making every loop vacuous.
        for key in (
            "estimatedOneRepMax",
            "repRangeParsing",
            "loadComparability",
            "loadSemantics",
            "estimatedOneRepMaxForLoad",
            "setVolumeForLoad",
        ):
            self.assertGreater(len(FIXTURES[key]), 0, key)

    def test_estimated_one_rep_max(self) -> None:
        for case in FIXTURES["estimatedOneRepMax"]:
            with self.subTest(case["name"]):
                actual = runner.estimated_one_rep_max(
                    case["weightLbs"], case["reps"]
                )
                self.assertTrue(
                    approximately(actual, case["expected"]),
                    f"{case['name']}: {actual!r} != {case['expected']!r}",
                )

    def test_top_estimated_one_rep_max_matches_the_single_set_estimate(self) -> None:
        for case in FIXTURES["estimatedOneRepMax"]:
            with self.subTest(case["name"]):
                rows = [{"weightLbs": case["weightLbs"], "reps": case["reps"]}]
                actual = runner.top_estimated_one_rep_max(rows)
                expected = (
                    None if case["expected"] is None else round(case["expected"], 2)
                )
                self.assertTrue(
                    approximately(actual, expected),
                    f"{case['name']}: {actual!r} != {expected!r}",
                )

    def test_rep_range_parsing(self) -> None:
        for case in FIXTURES["repRangeParsing"]:
            with self.subTest(case["name"]):
                actual = runner.parsed_target_rep_range(case["input"])
                expected = case["expected"]
                if expected is None:
                    self.assertIsNone(actual, case["name"])
                else:
                    self.assertEqual(
                        actual, (expected["min"], expected["max"]), case["name"]
                    )

    def test_single_number_targets(self) -> None:
        # Previously a documented divergence; the supervisor now agrees with the
        # app that a bare "10" means exactly ten reps.
        for case in FIXTURES["singleNumberRepTargets"]:
            with self.subTest(case["name"]):
                actual = runner.parsed_target_rep_range(case["input"])
                expected = case["expected"]
                if expected is None:
                    self.assertIsNone(actual)
                else:
                    self.assertEqual(actual, (expected["min"], expected["max"]))

    def test_structured_rep_bounds(self) -> None:
        for case in FIXTURES["structuredRepBounds"]:
            with self.subTest(case["name"]):
                actual = runner.plan_rep_bounds(case["plan"])
                expected = case["expected"]
                if expected is None:
                    self.assertIsNone(actual)
                else:
                    self.assertEqual(actual, (expected["min"], expected["max"]))
                self.assertEqual(
                    runner.rep_bounds_source(case["plan"]), case["source"]
                )

    def test_zero_load_validity(self) -> None:
        # The supervisor never rejects a snapshot row outright, but its
        # comparators must agree with the app about which zero loads are real.
        for case in FIXTURES["zeroLoad"]:
            with self.subTest(case["name"]):
                semantics = runner.load_semantics(case["convention"])
                if case["weightLbs"] < 0:
                    self.assertIsNone(
                        runner.estimated_one_rep_max(case["weightLbs"], 5)
                    )
                    continue
                if case["weightLbs"] == 0 and case["valid"]:
                    # Zero is meaningful only where the number is an adjustment,
                    # and those conventions have no one-rep-max anyway.
                    self.assertFalse(semantics["supportsOneRepMax"])
                    self.assertFalse(semantics["supportsTonnage"])

    def test_load_comparability(self) -> None:
        for case in FIXTURES["loadComparability"]:
            with self.subTest(f"{case['left']}/{case['right']}"):
                self.assertEqual(
                    runner.load_conventions_comparable(case["left"], case["right"]),
                    case["comparable"],
                )

    def test_load_semantics(self) -> None:
        for case in FIXTURES["loadSemantics"]:
            with self.subTest(case["convention"]):
                semantics = runner.load_semantics(case["convention"])
                self.assertEqual(semantics["convention"], case["convention"])
                self.assertEqual(
                    semantics["supportsTonnage"], case["supportsTonnage"]
                )
                self.assertEqual(
                    semantics["supportsOneRepMax"], case["supportsOneRepMax"]
                )
                self.assertEqual(
                    semantics["higherIsHarder"], case["higherIsHarder"]
                )
                self.assertEqual(semantics["recorded"], case["recorded"])

    def test_every_declared_convention_has_semantics(self) -> None:
        declared = {case["convention"] for case in FIXTURES["loadSemantics"]}
        self.assertEqual(set(runner.LOAD_CONVENTIONS), declared)

    def test_estimated_one_rep_max_for_load(self) -> None:
        for case in FIXTURES["estimatedOneRepMaxForLoad"]:
            with self.subTest(case["name"]):
                actual = runner.estimated_one_rep_max_for_load(
                    case["weightLbs"], case["reps"], case["convention"]
                )
                self.assertTrue(
                    approximately(actual, case["expected"]),
                    f"{case['name']}: {actual!r} != {case['expected']!r}",
                )

    def test_set_volume_for_load(self) -> None:
        for case in FIXTURES["setVolumeForLoad"]:
            with self.subTest(case["name"]):
                actual = runner.set_volume_for_load(
                    case["weightLbs"], case["reps"], case["convention"]
                )
                self.assertTrue(
                    approximately(actual, case["expected"]),
                    f"{case['name']}: {actual!r} != {case['expected']!r}",
                )

    def test_app_expects_the_runner_version_this_tree_ships(self) -> None:
        # Settings tells the user when the installed daily runner is behind the
        # build they are running. That comparison is only meaningful if the
        # app's expectation tracks RUNNER_VERSION, so pin them together.
        release_info = (
            Path(__file__).resolve().parents[2] / "src" / "lib" / "releaseInfo.ts"
        ).read_text(encoding="utf-8")
        expected = f"export const EXPECTED_RUNNER_VERSION = '{runner.RUNNER_VERSION}'"
        self.assertIn(
            expected,
            release_info,
            "src/lib/releaseInfo.ts must expect the RUNNER_VERSION this tree ships",
        )

    def test_top_estimate_refuses_a_mixed_unit_group(self) -> None:
        # A group whose sets were recorded under incompatible conventions has no
        # single top estimate; reporting one would be a mislabelled maximum.
        self.assertIsNone(
            runner.top_estimated_one_rep_max(
                [
                    {"weightLbs": 60, "reps": 8, "loadConvention": "assistance"},
                    {"weightLbs": 100, "reps": 5, "loadConvention": "total"},
                ]
            )
        )
        self.assertIsNone(
            runner.top_estimated_one_rep_max(
                [{"weightLbs": 60, "reps": 8, "loadConvention": "assistance"}]
            )
        )
        # Legacy rows and explicit total load are the same measurement.
        self.assertEqual(
            runner.top_estimated_one_rep_max(
                [
                    {"weightLbs": 100, "reps": 5},
                    {"weightLbs": 90, "reps": 5, "loadConvention": "total"},
                ]
            ),
            116.67,
        )

    def test_top_estimate_excludes_warmups(self) -> None:
        self.assertIsNone(
            runner.top_estimated_one_rep_max(
                [{"weightLbs": 315, "reps": 5, "setKind": "warmup"}]
            )
        )
        self.assertEqual(
            runner.top_estimated_one_rep_max(
                [
                    {"weightLbs": 315, "reps": 5, "setKind": "warmup"},
                    {"weightLbs": 100, "reps": 5, "setKind": "working"},
                ]
            ),
            116.67,
        )

    def test_comparator_completion_counts_working_sets_only(self) -> None:
        plan = {"targetSets": 2, "targetRepRange": "8-12"}
        rows = [
            {"reps": 10, "setKind": "warmup"},
            {"reps": 10, "setKind": "working"},
            {"reps": 11, "setKind": "working"},
        ]
        completion = runner.comparator_completion(plan, rows)
        self.assertEqual(completion["loggedSetCount"], 2)
        self.assertEqual(completion["warmupSetCount"], 1)
        self.assertTrue(completion["completedTargetSets"])
        self.assertTrue(completion["eligibleForProgressionTrend"])
        # A plain-text plan carries no source key: the text is right there.
        self.assertNotIn("targetRepRangeSource", completion)

    def test_comparator_completion_honours_structured_bounds(self) -> None:
        plan = {
            "targetSets": 1,
            "targetRepRange": "top set then back-offs",
            "repBounds": {"min": 6, "max": 8},
        }
        completion = runner.comparator_completion(plan, [{"reps": 7}])
        self.assertEqual(
            completion["parsedTargetRepRange"], {"minimum": 6, "maximum": 8}
        )
        self.assertEqual(completion["targetRepRangeSource"], "structured")
        self.assertTrue(completion["allLoggedSetRepsInTargetRange"])


if __name__ == "__main__":
    unittest.main()


class EvidenceMetadataTests(unittest.TestCase):
    """The evidence packet must carry and consume the app's measurement fields.

    Helper-level agreement is not enough: these assert the metadata survives
    into the packet the model actually reads, and that the comparators use it.
    """

    def _facts(self, sets, snapshot, session_overrides=None):
        session = {
            "id": "w1",
            "name": "Pull",
            "programName": None,
            "startedAt": 1_000,
            "completedAt": 2_000,
            "exerciseSnapshot": snapshot,
        }
        session.update(session_overrides or {})
        return session, sets

    def test_canonical_sets_carry_set_kind_and_load_convention(self) -> None:
        facts = runner.SnapshotFacts(
            snapshot={},
            data={},
            updated_at=1,
            updated_date=dt.date(2026, 9, 7),
            completed_workouts=[],
            ai_memory_settings=[],
            ai_memory_summaries=[],
            logged_sets=[
                {
                    "id": "s1",
                    "workoutSessionId": "w1",
                    "exerciseId": "e1",
                    "setNumber": 1,
                    "weightLbs": 60,
                    "reps": 8,
                    "rpe": 8,
                    "loggedAt": 1_500,
                    "setKind": "warmup",
                    "loadConvention": "assistance",
                },
                {
                    "id": "s2",
                    "workoutSessionId": "w1",
                    "exerciseId": "e1",
                    "setNumber": 2,
                    "weightLbs": 40,
                    "reps": 8,
                    "rpe": 9,
                    "loggedAt": 1_600,
                },
            ],
            ai_notes=[],
        )
        rows = runner.canonical_sets_by_session(facts)["w1"]
        by_id = {row["sourceSetId"]: row for row in rows}

        self.assertEqual(by_id["s1"]["setKind"], "warmup")
        self.assertEqual(by_id["s1"]["loadConvention"], "assistance")
        # A legacy row carries neither key. Absence is the signal — the packet
        # is byte-budgeted, and every consumer resolves an absent value to
        # "working" and "unknown" exactly as the app does.
        self.assertNotIn("setKind", by_id["s2"])
        self.assertNotIn("loadConvention", by_id["s2"])
        self.assertEqual(runner.set_kind(by_id["s2"].get("setKind")), "working")
        self.assertEqual(
            runner.load_convention(by_id["s2"].get("loadConvention")), "unknown"
        )

    def test_session_plan_rows_carry_structured_bounds_and_convention(self) -> None:
        session = {
            "exerciseSnapshot": [
                {
                    "exerciseId": "e1",
                    "order": 0,
                    "targetSets": 3,
                    "targetRepRange": "top set then back-offs",
                    "repBounds": {"min": 6, "max": 8},
                    "warmupSets": 2,
                    "loadConvention": "per_dumbbell",
                }
            ]
        }
        row = runner.session_plan_rows(session, {"e1": {"name": "Press"}})[0]

        self.assertEqual(row["repBounds"], {"min": 6, "max": 8})
        self.assertEqual(
            row["parsedTargetRepRange"], {"minimum": 6, "maximum": 8}
        )
        self.assertEqual(row["targetRepRangeSource"], "structured")
        self.assertEqual(row["plannedWarmupSets"], 2)
        self.assertEqual(row["loadConvention"], "per_dumbbell")

        # The comparator honours those carried bounds rather than the prose.
        completion = runner.comparator_completion(row, [{"reps": 7}])
        self.assertEqual(completion["targetRepRangeSource"], "structured")
        self.assertTrue(completion["allLoggedSetRepsInTargetRange"])

    def test_plan_row_preserves_an_explicit_null_rep_bounds(self) -> None:
        session = {
            "exerciseSnapshot": [
                {
                    "exerciseId": "e1",
                    "order": 0,
                    "targetSets": 3,
                    "targetRepRange": "8-12",
                    "repBounds": None,
                }
            ]
        }
        row = runner.session_plan_rows(session, {"e1": {"name": "Press"}})[0]
        self.assertIsNone(row["repBounds"])
        # An explicit null is a deliberate "no machine-readable target", so no
        # parsed range is emitted even though the display text would parse.
        self.assertNotIn("parsedTargetRepRange", row)
        self.assertEqual(row["targetRepRangeSource"], "unparseable_text")
        self.assertIsNone(
            runner.comparator_completion(row, [{"reps": 10}])["parsedTargetRepRange"]
        )

    def test_eligible_set_count_matches_the_marker(self) -> None:
        rows = [
            {"weightLbs": 315, "reps": 3, "setKind": "warmup"},
            {"weightLbs": 100, "reps": 5, "setKind": "working"},
        ]
        self.assertEqual(runner.one_rep_max_eligible_set_count(rows), 1)
        self.assertIsNotNone(runner.top_estimated_one_rep_max(rows))

        mixed = [
            {"weightLbs": 100, "reps": 5, "loadConvention": "total"},
            {"weightLbs": 7, "reps": 5, "loadConvention": "machine_setting"},
        ]
        self.assertEqual(runner.one_rep_max_eligible_set_count(mixed), 0)
        self.assertIsNone(runner.top_estimated_one_rep_max(mixed))

    def test_unfinished_work_reaches_the_session_episode(self) -> None:
        note = {"version": 1, "reason": "equipment", "recordedAt": 2_100}
        self.assertEqual(
            runner.valid_unfinished_work({"unfinishedWork": note}), note
        )
        # Unknown reasons and malformed notes are dropped, never guessed at.
        self.assertIsNone(
            runner.valid_unfinished_work(
                {"unfinishedWork": {"version": 1, "reason": "bored", "recordedAt": 1}}
            )
        )
        self.assertIsNone(runner.valid_unfinished_work({}))

    def test_legacy_plan_and_set_rows_stay_byte_identical(self) -> None:
        """No metadata key appears on a row that recorded none.

        The evidence packet is byte-budgeted, so a default-valued key on every
        row would push real evidence out — which is exactly what happened when
        the metadata was first carried unconditionally.
        """
        session = {
            "exerciseSnapshot": [
                {
                    "exerciseId": "e1",
                    "order": 0,
                    "targetSets": 3,
                    "targetRepRange": "8-12",
                }
            ]
        }
        row = runner.session_plan_rows(session, {"e1": {"name": "Press"}})[0]
        for key in (
            "repBounds",
            "parsedTargetRepRange",
            "targetRepRangeSource",
            "plannedWarmupSets",
            "loadConvention",
        ):
            self.assertNotIn(key, row, key)

        # But the comparator still reads the target from the display text.
        completion = runner.comparator_completion(row, [{"reps": 10}])
        self.assertEqual(
            completion["parsedTargetRepRange"], {"minimum": 8, "maximum": 12}
        )
        self.assertNotIn("warmupSetCount", completion)
