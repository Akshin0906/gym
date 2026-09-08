"""Behavioural regressions for the scientific-coaching audit.

Every test here is a case the supervisor previously got wrong, or a boundary a
fix must not cross. They assert what the validator ACCEPTS and REJECTS, not the
wording of any prompt: a prompt is not a proof that a model reasons correctly,
and nothing in this file should be read as one. The packaging tests only prove
that curated guidance physically reaches the runtime, which is a necessary and
very much not sufficient condition.
"""

from __future__ import annotations

import datetime as dt
import json
import unittest
from pathlib import Path

from test_daily_briefing_runner import (
    BriefingHarness,
    PACIFIC,
    model_output,
    pacific_ms,
    runner,
    snapshot_body,
)

from briefing.safety import classify_safety_text, current_self_report_scope


AUTOMATION = Path(__file__).resolve().parents[1]


class SafetyScopeTests(unittest.TestCase):
    """What the keyword screen must and must not treat as a current report."""

    def assert_kind(self, text: str, expected: str | None) -> None:
        with self.subTest(text=text):
            self.assertEqual(classify_safety_text(text)["kind"], expected)

    def test_pressure_and_accompanying_symptoms_are_emergency_warnings(self) -> None:
        # The audit's reproduction case. "Chest pain" was the only cardiac
        # wording the screen knew, so this produced no safety evidence at all.
        for text in (
            "New crushing chest pressure with breathlessness and lightheadedness"
            " during warm-up.",
            "Tightness in my chest during the second set.",
            "My chest feels tight and heavy right now.",
            "Pressure across my chest since the warm-up.",
        ):
            self.assert_kind(text, "emergency_warning_symptom")

    def test_ordinary_illness_is_not_an_emergency(self) -> None:
        # A current infection is a reason not to train hard. Telling somebody
        # with the flu to seek urgent care is not proportionate.
        for text in (
            "I have the flu and feel sick today.",
            "Fever today.",
            "I am vomiting and cannot train today.",
        ):
            self.assert_kind(text, "acute_illness")
        self.assertEqual(
            classify_safety_text("I have the flu today.")["guidance"],
            "skip_strenuous_training_ordinary_care",
        )

    def test_two_accompanying_symptoms_are_a_conservative_combination(self) -> None:
        self.assert_kind(
            "I am lightheaded and nauseous after the warm-up.",
            "concerning_combination",
        )

    def test_lightheaded_and_dizzy_are_one_symptom_domain(self) -> None:
        # Two words for the same description are not two independent signals,
        # so this must not reach the two-domain combination tier.
        result = classify_safety_text("I feel lightheaded and dizzy today.")
        self.assertEqual(result["combinationTerms"], ["lightheaded_or_dizzy"])
        self.assertNotEqual(result["kind"], "concerning_combination")

    def test_somebody_elses_symptoms_are_not_the_users(self) -> None:
        for text in (
            "My father has chest pain.",
            # The coordinated clause has no subject of its own and inherits the
            # father's; reading it as subjectless made this the user's emergency.
            "My father has chest pain and shortness of breath.",
            "She had chest tightness at the gym.",
        ):
            self.assert_kind(text, None)
        self.assertEqual(
            classify_safety_text("My father has chest pain.")[
                "thirdPartyOnlyMatchCount"
            ],
            1,
        )

    def test_a_first_person_clause_after_a_third_party_one_still_counts(self) -> None:
        self.assert_kind(
            "My father has chest pain and my chest feels tight too.",
            "emergency_warning_symptom",
        )

    def test_questions_and_quotations_are_not_reports(self) -> None:
        for text in (
            "I read that chest pressure is a warning sign; I feel well.",
            "What does chest pressure mean?",
        ):
            self.assert_kind(text, None)

    def test_a_question_that_reports_a_symptom_still_counts(self) -> None:
        for text in (
            "I have crushing chest pressure now; should I train?",
            "Should I train with chest pressure?",
        ):
            self.assert_kind(text, "emergency_warning_symptom")

    def test_negated_historical_and_resolved_reports_stay_quiet(self) -> None:
        for text in (
            "Chest day is the next programmed workout.",
            "No chest pain today.",
            "Prior chest pain, now resolved.",
            "I had chest pain yesterday but no chest pain today.",
            "Shortness of breath has resolved.",
            "I tested negative for COVID today.",
            "Sore from Monday squats.",
        ):
            self.assert_kind(text, None)
            with self.subTest(text=text):
                self.assertFalse(
                    runner.has_unresolved_red_flag(text),
                    "benign text must not read as a red flag",
                )

    def test_recurrence_with_an_intervening_phrase_is_current(self) -> None:
        self.assert_kind(
            "Chest pressure yesterday. It returned during warm-up today.",
            "emergency_warning_symptom",
        )

    def test_unlisted_current_complaints_are_reported_not_swallowed(self) -> None:
        self.assert_kind(
            "My left knee gave way during warm-up today.",
            "unclassified_current_complaint",
        )

    def test_the_conservative_route_does_not_depend_on_any_lexicon(self) -> None:
        # The point of the fallback: a serious report no keyword list contains
        # is still recognisably the user, speaking about now, affirmatively.
        for text in (
            "I just coughed up blood during warm-up.",
            "I am seeing stars and my legs buckled during warm-up.",
            # Deliberately novel wording that matches no term in the module.
            "I keep blacking in and out between wobbles on the platform.",
        ):
            with self.subTest(text=text):
                self.assertTrue(current_self_report_scope(text)["eligible"])

    def test_the_conservative_route_ignores_negation_and_other_people(self) -> None:
        for text in (
            "I haven't vomited today.",
            "I did not pass out today.",
            "I tested negative for COVID today.",
            "My father has chest pain.",
            "Chest day is the next programmed workout.",
            "I had chest pain yesterday but no chest pain today.",
        ):
            with self.subTest(text=text):
                self.assertFalse(current_self_report_scope(text)["eligible"])

    def test_planned_pauses_are_recognized_and_scoped(self) -> None:
        cases = (
            ("Today is a planned rest day. Resume training tomorrow.", "planned_rest"),
            ("Rest day today.", "planned_rest"),
            ("This week is a planned deload week.", "planned_deload"),
            ("Tomorrow is a rest day.", None),
            ("Last Tuesday was my planned rest day.", None),
            ("Today I train; tomorrow is my planned rest day.", None),
        )
        for text, expected in cases:
            with self.subTest(text=text):
                pause = classify_safety_text(text)["plannedPause"]
                self.assertEqual(pause["kind"] if pause else None, expected)

    def test_a_cancelled_or_moved_pause_is_not_in_force(self) -> None:
        # The words survive the decision; the plan does not.
        for text in (
            "Today I canceled my planned rest day and will train as programmed.",
            "Today was going to be a planned rest day, but I moved it to tomorrow.",
            "I canceled this week's deload week and will train as programmed.",
            "Deload week was moved to next week.",
            "No longer taking a rest day today.",
        ):
            with self.subTest(text=text):
                self.assertIsNone(classify_safety_text(text)["plannedPause"])


class ScienceHarness(BriefingHarness):
    def canned_output(self, mode: str, supporting_ids: list[str]) -> dict:
        # A complete, otherwise-valid model answer with only the mode and its
        # citations changed, so a rejection is about the mode policy rather
        # than about some unrelated contract field.
        output = model_output(self.updated_at)
        output["briefing"]["mode"] = mode
        output["briefing"]["supportingEvidenceIds"] = supporting_ids
        return output


class CurrentContextModeTests(ScienceHarness):
    """How a current user report constrains today's call."""

    def bundle_for_context(self, context_text: str):
        memory = {
            "revision": 0,
            "state": {
                "currentContext": context_text,
                "paused": False,
                "windowStartedAt": pacific_ms(2026, 8, 1),
                "fourMonthStartedAt": pacific_ms(2026, 8, 1),
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
        return memory, bundle, context_id

    def test_an_emergency_report_makes_every_training_mode_invalid(self) -> None:
        # Before the fix this produced no rest evidence and no push blocker, so
        # a canned ordinary-training answer was accepted while a rest answer was
        # rejected. Allowing rest is not enough: training must be impossible.
        text = (
            "New crushing chest pressure with breathlessness and lightheadedness"
            " during warm-up."
        )
        memory, bundle, context_id = self.bundle_for_context(text)
        self.assertIn(context_id, bundle.mandatory_rest_evidence_ids)
        for mode in ("normal", "push", "light", "deload"):
            with self.subTest(mode=mode):
                with self.assertRaisesRegex(
                    runner.ConfigError, "today's call must be rest"
                ):
                    self.validate(
                        self.canned_output(mode, [context_id]),
                        memory=memory,
                        input_bundle=bundle,
                    )
        # An empty-evidence `normal` is refused for the same reason, not merely
        # for missing citations.
        with self.assertRaisesRegex(runner.ConfigError, "today's call must be rest"):
            self.validate(
                self.canned_output("normal", []), memory=memory, input_bundle=bundle
            )
        result = self.validate(
            self.canned_output("rest", [context_id]),
            memory=memory,
            input_bundle=bundle,
        )
        self.assertEqual(result["briefing"]["mode"], "rest")
        self.assertEqual(
            result["briefing"]["sections"]["modeReasonLabel"], "medical_stop"
        )

    def test_rest_must_cite_the_report_that_requires_it(self) -> None:
        memory, bundle, context_id = self.bundle_for_context(
            "Chest tightness during warm-up today."
        )
        with self.assertRaisesRegex(
            runner.ConfigError, "must cite|requires explicit retained evidence"
        ):
            self.validate(
                self.canned_output("rest", []), memory=memory, input_bundle=bundle
            )
        del context_id

    def test_a_planned_rest_day_blocks_ordinary_training_advice(self) -> None:
        text = "Today is a planned rest day. Resume training tomorrow."
        memory, bundle, context_id = self.bundle_for_context(text)
        self.assertIn(context_id, bundle.planned_rest_evidence_ids)
        self.assertIn(context_id, bundle.mandatory_rest_evidence_ids)
        with self.assertRaisesRegex(runner.ConfigError, "today's call must be rest"):
            self.validate(
                self.canned_output("normal", []), memory=memory, input_bundle=bundle
            )
        result = self.validate(
            self.canned_output("rest", [context_id]),
            memory=memory,
            input_bundle=bundle,
        )
        # Labelled as the user's own schedule, not as illness or a downturn.
        self.assertEqual(
            result["briefing"]["sections"]["modeReasonLabel"], "planned_rest"
        )

    def test_a_cancelled_rest_day_does_not_force_rest(self) -> None:
        memory, bundle, _ = self.bundle_for_context(
            "Today I canceled my planned rest day and will train as programmed."
        )
        self.assertEqual(bundle.mandatory_rest_evidence_ids, frozenset())
        self.validate(
            self.canned_output("normal", []), memory=memory, input_bundle=bundle
        )

    def test_an_unclassified_current_report_permits_a_precautionary_stop(self) -> None:
        # No lexicon here matches, and that is the point: the supervisor can
        # still verify who said it and when, so the model may stop on it.
        text = "I just coughed up blood during warm-up."
        memory, bundle, context_id = self.bundle_for_context(text)
        self.assertIn(context_id, bundle.conservative_stop_evidence_ids)
        self.assertEqual(bundle.mandatory_rest_evidence_ids, frozenset())
        result = self.validate(
            self.canned_output("rest", [context_id]),
            memory=memory,
            input_bundle=bundle,
        )
        self.assertEqual(
            result["briefing"]["sections"]["modeReasonLabel"], "precautionary_stop"
        )

    def test_ordinary_context_still_cannot_justify_rest(self) -> None:
        memory, bundle, context_id = self.bundle_for_context(
            "Chest day is the next programmed workout."
        )
        self.assertEqual(bundle.conservative_stop_evidence_ids, frozenset())
        with self.assertRaisesRegex(
            runner.ConfigError, "rest mode requires stopped-pain evidence"
        ):
            self.validate(
                self.canned_output("rest", [context_id]),
                memory=memory,
                input_bundle=bundle,
            )

    def test_a_medical_report_outranks_a_planned_rest_day(self) -> None:
        # Both facts live in one sentence and therefore in one atom. Deciding
        # the label by subtracting the planned-rest ids from the rest ids lost
        # the medical fact entirely.
        text = (
            "Today is my planned rest day, and I have new crushing chest"
            " pressure with breathlessness."
        )
        memory, bundle, context_id = self.bundle_for_context(text)
        self.assertIn(context_id, bundle.planned_rest_evidence_ids)
        self.assertIn(context_id, bundle.medical_rest_evidence_ids)
        result = self.validate(
            self.canned_output("rest", [context_id]),
            memory=memory,
            input_bundle=bundle,
        )
        self.assertEqual(
            result["briefing"]["sections"]["modeReasonLabel"], "medical_stop"
        )

    def test_somebody_elses_symptom_does_not_change_the_call(self) -> None:
        memory, bundle, context_id = self.bundle_for_context(
            "My father has chest pain and shortness of breath."
        )
        self.assertEqual(bundle.mandatory_rest_evidence_ids, frozenset())
        self.assertEqual(bundle.rest_evidence_ids, frozenset())
        self.validate(
            self.canned_output("normal", []), memory=memory, input_bundle=bundle
        )
        del context_id


class ComparablePerformanceTests(ScienceHarness):
    """Adherence, readiness to progress, and observable performance."""

    def test_beating_the_rep_target_keeps_its_progression_evidence(self) -> None:
        # Target 8-12 at the same load: latest 13, prior 12. The old rule
        # required every rep inside the band, so an improved session lost the
        # evidence of its own improvement.
        _, _, bundle = self.progression_bundle(
            [
                {
                    "id": "newer",
                    "days_ago": 1,
                    "reps_values": [13, 13, 13],
                    "target_range": "8-12",
                },
                {
                    "id": "older",
                    "days_ago": 3,
                    "reps_values": [12, 12, 12],
                    "target_range": "8-12",
                },
            ],
            today_target_range="8-12",
        )
        exposures = bundle.inputs["briefingEvidencePacket"][
            "comparableMovementExposures"
        ][0]["exposures"]
        newer = next(
            item for item in exposures if item["sourceSessionId"] == "newer"
        )
        completion = newer["programCompletion"]
        # Adherence still reports the truth: nothing landed inside the band.
        self.assertFalse(completion["allLoggedSetRepsInTargetRange"])
        self.assertEqual(completion["repAttainmentCounts"]["aboveTargetMaximum"], 3)
        # But readiness to add load and comparability are separate questions.
        self.assertTrue(completion["eligibleForProgressionTrend"])
        self.assertTrue(completion["eligibleForComparableObservation"])
        self.assertTrue(bundle.push_evidence_groups)

    def test_below_target_work_stays_observable_as_a_decline(self) -> None:
        # Target 8-12 at one load: 7 latest, 8, then 9. The low session used to
        # disqualify the whole comparison, so a real decline was invisible.
        specs = [
            {
                "id": "s1",
                "days_ago": 1,
                "reps_values": [7, 7, 7],
                "weight": 100,
                "target_range": "8-12",
            },
            {
                "id": "s2",
                "days_ago": 3,
                "reps_values": [8, 8, 8],
                "weight": 100,
                "target_range": "8-12",
            },
            {
                "id": "s3",
                "days_ago": 5,
                "reps_values": [9, 9, 9],
                "weight": 100,
                "target_range": "8-12",
            },
        ]
        _, _, bundle = self.progression_bundle(specs, today_target_range="8-12")
        exposures = bundle.inputs["briefingEvidencePacket"][
            "comparableMovementExposures"
        ][0]["exposures"]
        newest = next(item for item in exposures if item["sourceSessionId"] == "s1")
        completion = newest["programCompletion"]
        self.assertFalse(completion["eligibleForProgressionTrend"])
        self.assertTrue(completion["eligibleForComparableObservation"])
        self.assertEqual(
            completion["shortfallContext"]["belowTargetMinimumSetCount"], 3
        )
        # And the cause is explicitly not assumed.
        self.assertEqual(
            completion["shortfallContext"]["interpretation"],
            "cause_unknown_unless_user_reported",
        )
        self.assertTrue(bundle.deload_decline_groups)

    def test_shortfall_reports_a_user_stated_interruption(self) -> None:
        # A session cut short for time is not evidence that training got harder.
        body = snapshot_body(self.updated_at)
        del body
        _, _, bundle = self.progression_bundle(
            [{"id": "short", "days_ago": 1, "set_count": 2}],
            today_target_range="5-8",
        )
        exposures = bundle.inputs["briefingEvidencePacket"][
            "comparableMovementExposures"
        ][0]["exposures"]
        completion = exposures[0]["programCompletion"]
        self.assertFalse(completion["eligibleForProgressionTrend"])
        self.assertIn(
            "target_sets_not_completed",
            completion["progressionIneligibilityReasons"],
        )
        self.assertIsNone(completion["shortfallContext"]["userReportedReason"])

    def test_structured_rep_bounds_beat_matching_display_text(self) -> None:
        # Two plans whose prose both reads "5-8" are not the same target when
        # one froze structured bounds of 10-12.
        _, _, bundle = self.progression_bundle(
            [
                {"id": "newer", "days_ago": 1, "weight": 105},
                {"id": "older", "days_ago": 3, "weight": 100},
            ],
            structured_today_bounds={"min": 10, "max": 12},
        )
        movement = bundle.inputs["briefingEvidencePacket"][
            "comparableMovementExposures"
        ][0]
        self.assertTrue(
            all(
                item["comparability"] == "same_exercise_different_target_rep_range"
                for item in movement["exposures"]
            )
        )
        self.assertEqual(bundle.push_evidence_groups, ())


class LoadConventionTests(ScienceHarness):
    """Cross-exposure unit safety."""

    def test_a_convention_change_cannot_look_like_progress(self) -> None:
        # 20 lb per dumbbell then 40 lb total is the same work recorded two
        # ways. Comparing them reads as doubled strength.
        _, _, bundle = self.progression_bundle(
            [
                {
                    "id": "newer",
                    "days_ago": 1,
                    "weight": 40,
                    "load_convention": "total",
                },
                {
                    "id": "older",
                    "days_ago": 3,
                    "weight": 20,
                    "load_convention": "per_dumbbell",
                },
            ],
            today_load_convention="total",
        )
        movement = bundle.inputs["briefingEvidencePacket"][
            "comparableMovementExposures"
        ][0]
        self.assertEqual(
            movement["exposureLoadConventionComparability"]["status"],
            "differs_across_exposures",
        )
        self.assertEqual(bundle.push_evidence_groups, ())

    def test_an_unrecorded_legacy_load_is_not_paired_with_a_recorded_one(self) -> None:
        # The legacy row is READ as total pounds — that is the compatible
        # description — but "it probably meant total" is not a basis for telling
        # somebody their strength went up.
        _, _, bundle = self.progression_bundle(
            [
                {
                    "id": "newer",
                    "days_ago": 1,
                    "weight": 40,
                    "load_convention": "total",
                },
                {"id": "older", "days_ago": 3, "weight": 20},
            ],
            today_load_convention="total",
        )
        exposures = bundle.inputs["briefingEvidencePacket"][
            "comparableMovementExposures"
        ][0]["exposures"]
        legacy = next(item for item in exposures if item["sourceSessionId"] == "older")
        self.assertFalse(
            legacy["loadMeasurement"]["progressionComparableWithTodaysSetup"]
        )
        self.assertEqual(
            legacy["progressComparison"]["reason"],
            "unrecorded_legacy_load_versus_recorded_setup",
        )
        self.assertEqual(bundle.push_evidence_groups, ())

    def test_legacy_only_history_still_supports_a_progression(self) -> None:
        # Nothing changed for a user whose whole history predates the field.
        _, _, bundle = self.progression_bundle(
            [
                {"id": "newer", "days_ago": 1, "weight": 105},
                {"id": "older", "days_ago": 3, "weight": 100},
            ]
        )
        self.assertTrue(bundle.push_evidence_groups)

    def test_machine_settings_get_an_ordinal_comparison_not_a_fake_estimate(
        self,
    ) -> None:
        # A pin number is not pounds, so there is no one-rep-max estimate. Being
        # excluded from every progress statement is not the right answer either:
        # more reps at the same setting is real, comparable work.
        _, _, bundle = self.progression_bundle(
            [
                {
                    "id": "newer",
                    "days_ago": 1,
                    "weight": 7,
                    "reps_values": [8, 8, 8],
                    "load_convention": "machine_setting",
                },
                {
                    "id": "older",
                    "days_ago": 3,
                    "weight": 7,
                    "reps_values": [6, 6, 6],
                    "load_convention": "machine_setting",
                },
            ],
            today_load_convention="machine_setting",
            today_target_range="5-8",
        )
        exposures = bundle.inputs["briefingEvidencePacket"][
            "comparableMovementExposures"
        ][0]["exposures"]
        newer = next(item for item in exposures if item["sourceSessionId"] == "newer")
        self.assertIsNone(newer["performanceMarker"]["value"])
        self.assertEqual(newer["progressComparison"]["basis"], "same_setting_reps")
        self.assertEqual(newer["progressComparison"]["repsAtLoadValue"], 8)
        self.assertTrue(bundle.push_evidence_groups)

    def test_a_different_machine_setting_is_not_a_rep_comparison(self) -> None:
        _, _, bundle = self.progression_bundle(
            [
                {
                    "id": "newer",
                    "days_ago": 1,
                    "weight": 5,
                    "reps_values": [8, 8, 8],
                    "load_convention": "machine_setting",
                },
                {
                    "id": "older",
                    "days_ago": 3,
                    "weight": 7,
                    "reps_values": [6, 6, 6],
                    "load_convention": "machine_setting",
                },
            ],
            today_load_convention="machine_setting",
        )
        self.assertEqual(bundle.push_evidence_groups, ())

    def test_less_assistance_is_harder_work(self) -> None:
        # The recorded number falls as the lifter gets stronger, so the hardest
        # setting is the LOWEST one.
        marker = runner.ordinal_progress_marker(
            [
                {"weightLbs": 40, "reps": 10, "loadConvention": "assistance"},
                {"weightLbs": 30, "reps": 8, "loadConvention": "assistance"},
                {"weightLbs": 30, "reps": 9, "loadConvention": "assistance"},
            ]
        )
        self.assertEqual(marker["direction"], "lower_is_harder")
        self.assertEqual(marker["loadValue"], 30.0)
        self.assertEqual(marker["repsAtLoadValue"], 9)


class EstimateAndDeloadTests(ScienceHarness):
    """One-rep-max limits and the deload routes."""

    def test_the_estimate_reports_heuristic_flags_not_confidence_bands(self) -> None:
        context = runner.one_rep_max_estimate_context(
            [{"weightLbs": 100, "reps": 12}, {"weightLbs": 100, "reps": 11}]
        )
        self.assertEqual(
            context["flagPolicy"], "heuristic_flags_not_calibrated_error_bands_v1"
        )
        self.assertFalse(context["effortAccountedFor"])
        self.assertIn("many_reps_extrapolated_from", context["heuristicFlags"])
        self.assertIn("no_set_effort_recorded", context["heuristicFlags"])

    def test_a_logged_single_is_a_load_not_a_verified_maximum(self) -> None:
        context = runner.one_rep_max_estimate_context([{"weightLbs": 200, "reps": 1}])
        self.assertIn(
            "single_rep_set_is_a_load_not_a_verified_maximum",
            context["heuristicFlags"],
        )

    def test_a_planned_deload_needs_no_measured_downturn(self) -> None:
        text = "This week is a planned deload week."
        _, memory, bundle = self.progression_bundle(
            [{"id": "older", "days_ago": 3}], current_context=text
        )
        context_id = runner.evidence_id("context", "ai-memory-state:default", text)
        self.assertIn(context_id, bundle.planned_deload_evidence_ids)
        self.assertEqual(bundle.deload_decline_groups, ())
        result = self.validate(
            self.mode_output("deload", [context_id]),
            memory=memory,
            input_bundle=bundle,
        )
        # Reported as programming, not as a reaction to a problem.
        self.assertEqual(
            result["briefing"]["sections"]["modeReasonLabel"], "planned_deload"
        )

    def test_repeated_difficulty_is_a_second_reactive_deload_route(self) -> None:
        # Two comparable sessions at high effort with no improvement. A hard
        # percentage fall in a noisy estimate is not the only honest signal
        # that training is going badly.
        _, memory, bundle = self.progression_bundle(
            [
                {
                    "id": "newer",
                    "days_ago": 1,
                    "weight": 100,
                    "session_rpe": 9,
                    "performance": 2,
                },
                {
                    "id": "older",
                    "days_ago": 3,
                    "weight": 100,
                    "session_rpe": 9,
                    "performance": 2,
                },
            ]
        )
        self.assertEqual(bundle.deload_decline_groups, ())
        self.assertTrue(bundle.deload_difficulty_groups)
        group = sorted(bundle.deload_difficulty_groups[0])
        result = self.validate(
            self.mode_output("deload", group),
            memory=memory,
            input_bundle=bundle,
        )
        self.assertEqual(
            result["briefing"]["sections"]["modeReasonLabel"], "reactive_deload"
        )

    def test_one_bad_day_is_not_a_deload(self) -> None:
        _, memory, bundle = self.progression_bundle(
            [
                {
                    "id": "newer",
                    "days_ago": 1,
                    "weight": 100,
                    "session_rpe": 9,
                    "performance": 2,
                }
            ]
        )
        self.assertEqual(bundle.deload_difficulty_groups, ())
        self.assertEqual(bundle.deload_decline_groups, ())
        with self.assertRaisesRegex(runner.ConfigError, "deload mode requires"):
            self.validate(
                self.mode_output("deload", []),
                memory=memory,
                input_bundle=bundle,
            )


class ScheduleAndPacketTests(ScienceHarness):
    def test_the_next_template_is_not_claimed_to_be_scheduled_today(self) -> None:
        _, _, bundle = self.progression_bundle(
            [{"id": "older", "days_ago": 3}], include_plan=True
        )
        plan = bundle.inputs["briefingEvidencePacket"]["currentProgrammedSession"]
        self.assertEqual(plan["status"], "available")
        self.assertFalse(plan["scheduling"]["scheduledForToday"])
        self.assertEqual(
            plan["scheduling"]["basis"],
            "next_in_program_rotation_not_calendar_scheduled",
        )

    def test_the_packet_states_its_own_policy_boundaries(self) -> None:
        _, _, bundle = self.progression_bundle([{"id": "older", "days_ago": 3}])
        policy = bundle.inputs["briefingEvidencePacket"]["selection"][
            "modeEligibilityPolicy"
        ]
        self.assertEqual(
            policy["deloadDeclineFractionAppliesTo"],
            "continuous_one_rep_max_estimate_only",
        )
        self.assertEqual(
            policy["deloadCadencePolicy"], "no_universal_cadence_individualized_only"
        )
        self.assertIn(
            "current_user_report_the_keyword_screen_did_not_classify",
            policy["restRoutes"],
        )


class SharedEvidenceGuideTests(unittest.TestCase):
    """The curated guidance must physically reach both runtimes.

    These assert packaging and inclusion only. A prompt containing a sentence
    is not evidence that a model reasons from it; the behavioural checks above
    and the reviewer's own model runs are what test that.
    """

    def setUp(self) -> None:
        self.guide = (AUTOMATION / "evidence_guide.md").read_text(encoding="utf-8")

    def test_the_guide_declares_the_version_the_code_expects(self) -> None:
        self.assertIn(runner.EVIDENCE_GUIDE_VERSION, self.guide)

    def test_the_daily_prompt_carries_the_guide_verbatim(self) -> None:
        config = runner.Config.from_env()
        now = dt.datetime(2026, 8, 1, 12, 0, tzinfo=PACIFIC)
        facts = runner.validate_snapshot(
            snapshot_body(int(now.timestamp() * 1000)), now.date()
        )
        prompt = runner.build_model_prompt(
            config,
            facts=facts,
            today="2026-08-01",
            now=now,
            run_id="test-run",
            prompt_hash="abc123",
            snapshot_body=None,
            memory_body={"revision": 0, "state": None, "items": []},
            recovery={
                "generatedAt": now.isoformat(),
                "status": "unavailable",
                "freshnessPolicy": runner.RECOVERY_FRESHNESS_POLICY,
                "evaluationDate": "2026-08-01",
                "latestReadiness": None,
                "latestSleep": None,
            },
        )
        self.assertIn(runner.EVIDENCE_GUIDE_HEADING, prompt)
        self.assertIn(self.guide.strip(), prompt)
        self.assertIn(runner.EVIDENCE_GUIDE_VERSION, prompt)

    def test_the_chat_bridge_composes_the_same_guide(self) -> None:
        import importlib.util
        import sys

        spec = importlib.util.spec_from_file_location(
            "chat_bridge_guide_probe", AUTOMATION / "chat_bridge.py"
        )
        assert spec and spec.loader
        bridge = importlib.util.module_from_spec(spec)
        # Registered before execution: dataclasses resolves annotations through
        # sys.modules, and Python 3.9 fails outright without it.
        sys.modules[spec.name] = bridge
        try:
            spec.loader.exec_module(bridge)
        finally:
            sys.modules.pop(spec.name, None)
        config = bridge.Config.from_env()
        composed = bridge.compose_base_instructions(
            config.prompt_file.read_text(encoding="utf-8"),
            bridge.read_evidence_guide(config.evidence_guide_file),
        )
        self.assertIn(self.guide.strip(), composed)
        self.assertEqual(
            bridge.EVIDENCE_GUIDE_VERSION, runner.EVIDENCE_GUIDE_VERSION
        )
        # The contract still comes first and is not weakened by the guide.
        self.assertLess(
            composed.index("Workout Coach execution contract"),
            composed.index(bridge.EVIDENCE_GUIDE_HEADING),
        )

    def test_the_prompt_fingerprint_covers_the_guide(self) -> None:
        config = runner.Config.from_env()
        before = runner.prompt_fingerprint(config)
        original = config.evidence_guide_file.read_bytes()
        try:
            config.evidence_guide_file.write_bytes(original + b"\n<!-- probe -->\n")
            self.assertNotEqual(before, runner.prompt_fingerprint(config))
        finally:
            config.evidence_guide_file.write_bytes(original)
        self.assertEqual(before, runner.prompt_fingerprint(config))

    def test_both_installers_stage_the_guide(self) -> None:
        for name in ("manage_daily_briefing.sh", "manage_chat_bridge.sh"):
            with self.subTest(script=name):
                script = (AUTOMATION / name).read_text(encoding="utf-8")
                self.assertIn("evidence_guide.md", script)
                self.assertIn(runner.EVIDENCE_GUIDE_VERSION, script)

    def test_the_guide_cites_its_sources(self) -> None:
        # Curated guidance the runtimes cannot look up must at least carry the
        # identifiers a human reviewer can check.
        for citation in (
            "41843416",
            "41343037",
            "38970765",
            "38393985",
            "31230110",
            "37877099",
            "41630124",
            "39205815",
            "42175611",
            "38910451",
        ):
            with self.subTest(citation=citation):
                self.assertIn(citation, self.guide)

    def test_the_guide_states_its_own_limits(self) -> None:
        for phrase in (
            "not a substitute",
            "never act as an individual training cutoff",
            "no established universal cadence",
            "modelling convenience",
            "bookkeeping and nothing more",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, self.guide)


class ModelIdentityTests(unittest.TestCase):
    def test_the_daily_runner_defaults_to_astra_at_high(self) -> None:
        self.assertEqual(runner.DEFAULT_CODEX_MODEL, "gpt-6-astra")
        self.assertEqual(runner.DEFAULT_CODEX_REASONING_EFFORT, "high")

    def test_the_installed_launch_agent_matches(self) -> None:
        import plistlib

        with (
            AUTOMATION / "com.workout-tracker.codex-daily-briefing.plist"
        ).open("rb") as handle:
            plist = plistlib.load(handle)
        env = plist["EnvironmentVariables"]
        self.assertEqual(env["WORKOUT_CODEX_MODEL"], "gpt-6-astra")
        self.assertEqual(env["WORKOUT_CODEX_REASONING_EFFORT"], "high")

    def test_the_backend_accepts_high_and_the_legacy_efforts(self) -> None:
        source = (
            AUTOMATION.parent / "functions" / "api" / "chat" / "[[path]].ts"
        ).read_text(encoding="utf-8")
        self.assertIn(
            "const REQUEST_EFFORTS: readonly ReasoningEffort[] = "
            "['medium', 'high', 'xhigh']",
            source,
        )
        self.assertIn("type ReasoningEffort = 'medium' | 'high' | 'xhigh'", source)

    def test_the_migration_widens_both_effort_constraints(self) -> None:
        migration = (
            AUTOMATION.parent
            / "migrations"
            / "0009_codex_chat_high_effort.sql"
        ).read_text(encoding="utf-8")
        self.assertEqual(
            migration.count("'medium', 'high', 'xhigh'"),
            2,
            "messages and jobs must both accept the new effort",
        )

    def test_the_app_sends_high_for_new_messages(self) -> None:
        source = (
            AUTOMATION.parent / "src" / "lib" / "chatTypes.ts"
        ).read_text(encoding="utf-8")
        self.assertIn(
            "export const COACH_REQUEST_REASONING_EFFORT = 'high' as const", source
        )
        self.assertIn("export const COACH_MODEL = 'gpt-6-astra'", source)

    def test_the_shared_calculation_fixture_still_parses(self) -> None:
        json.loads(
            (AUTOMATION / "shared_fixtures" / "calculations.json").read_text(
                encoding="utf-8"
            )
        )


if __name__ == "__main__":
    unittest.main()
