"""Construction of the bounded evidence packet handed to the model."""

from __future__ import annotations

import json
from typing import Any

from .errors import ConfigError
from .constants import (
    BRIEFING_EVIDENCE_PACKET_VERSION,
    COMPARABLE_EXPOSURE_LIMIT,
    CURRENT_CONTEXT_EXCERPT_MAX_CHARS,
    CURRENT_PROGRAMMED_SESSION_MAX_BYTES,
    DELOAD_MIN_TOTAL_DECLINE_FRACTION,
    DISPLAY_TEXT_EXCERPT_MAX_CHARS,
    MAX_MEMORY_SOURCE_SUMMARY_BULLETS,
    MAX_PERIODIC_DIGEST_EXERCISES,
    MAX_PERIODIC_DIGEST_SESSION_SAMPLES,
    MAX_RETAINED_CURRENT_PLAN_EXERCISES,
    MAX_RETAINED_EXERCISES_PER_EPISODE,
    MAX_RETAINED_SETS_PER_EXERCISE,
    MAX_RETAINED_SUMMARY_BULLETS,
    MAX_SAFE_INTEGER,
    MEMORY_SOURCE_PACKET_VERSION,
    MEMORY_SOURCE_SUMMARY_BULLET_MAX_CHARS,
    MODEL_INPUT_PACKET_MAX_BYTES,
    MODEL_PROMPT_MAX_BYTES,
    NOTE_EXCERPT_MAX_CHARS,
    OLDER_PERIODIC_SUMMARY_LIMIT,
    PERFORMANCE_COMPARATOR_WINDOW_DAYS,
    RECENT_ADVERSE_WINDOW_DAYS,
    RECENT_GENERAL_NOTE_LIMIT,
    RECENT_SAFETY_NOTE_LIMIT,
    RECENT_SESSION_EPISODE_LIMIT,
    REST_RED_FLAG_RE,
    SAFETY_CONTEXT_RE,
    SESSION_EPISODE_MAX_BYTES,
    SUMMARY_BULLET_EXCERPT_MAX_CHARS,
)
from .primitives import (
    finite_number,
    require_epoch_ms,
    require_string,
    sha256_bytes,
)
from .models import (
    MemoryCandidatePlan,
    ModelInputBundle,
    SnapshotFacts,
)
from .textutil import (
    bounded_source_id,
    canonical_string_list_sha256,
    compact_json_bytes,
    compact_rows_by_id,
    compact_source_ids,
    display_text,
    evidence_id,
    has_unresolved_red_flag,
    observed_within_recent_window,
    optional_excerpt_text,
    optional_text,
    pacific_date_for_epoch,
    stabilize_compact_json_byte_metric,
    text_excerpt,
)
from .measurement import (
    load_convention,
    one_rep_max_eligible_set_count,
    valid_rep_bounds,
    plan_rep_bounds,
    rep_bounds_source,
    set_kind,
    comparator_completion,
    parsed_target_rep_range,
    target_range_comparability,
    top_estimated_one_rep_max,
)
from .recovery import model_recovery_context
from .memory import (
    candidate_prompt_source_projection,
    defer_memory_candidate,
    derive_memory_candidate_plan,
    prompt_memory_candidate_plan,
)

def indexed_snapshot_rows(
    facts: SnapshotFacts, table: str
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    rows = facts.data.get(table)
    if not isinstance(rows, list):
        raise ConfigError(f"Cloud snapshot is missing {table}")
    for index, raw in enumerate(rows):
        if not isinstance(raw, dict):
            raise ConfigError(f"Cloud snapshot {table}[{index}] must be an object")
        source_id = bounded_source_id(raw.get("id"), f"{table}[{index}].id")
        if source_id in result:
            raise ConfigError(f"Cloud snapshot {table} has duplicate id: {source_id}")
        result[source_id] = raw
    return result

def exercise_display(
    exercises: dict[str, dict[str, Any]], exercise_id: str
) -> dict[str, Any]:
    raw = exercises.get(exercise_id)
    name, truncation = display_text(
        raw.get("name") if raw is not None else None, exercise_id
    )
    return {"exerciseName": name, "exerciseNameTruncation": truncation}

def canonical_sets_by_session(
    facts: SnapshotFacts,
) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    seen_ids: set[str] = set()
    for index, raw in enumerate(facts.logged_sets):
        set_id = bounded_source_id(raw.get("id"), f"loggedSets[{index}].id")
        if set_id in seen_ids:
            raise ConfigError(f"Cloud snapshot loggedSets has duplicate id: {set_id}")
        seen_ids.add(set_id)
        session_id = optional_text(raw.get("workoutSessionId"))
        exercise_id = optional_text(raw.get("exerciseId"))
        # Older supervisor unit fixtures and corrupt non-app snapshots can lack
        # linkage. Exclude those rows from evidence rather than attaching them
        # to a workout by inference; aggregate counts remain trusted elsewhere.
        if session_id is None or exercise_id is None:
            continue
        bounded_source_id(session_id, f"loggedSets[{index}].workoutSessionId")
        bounded_source_id(exercise_id, f"loggedSets[{index}].exerciseId")
        logged_at = raw.get("loggedAt")
        result.setdefault(session_id, []).append(
            {
                "sourceSetId": set_id,
                "exerciseId": exercise_id,
                "setNumber": (
                    raw.get("setNumber")
                    if finite_number(raw.get("setNumber"))
                    else None
                ),
                "weightLbs": (
                    raw.get("weightLbs")
                    if finite_number(raw.get("weightLbs"))
                    else None
                ),
                "reps": raw.get("reps") if finite_number(raw.get("reps")) else None,
                "rpe": raw.get("rpe") if finite_number(raw.get("rpe")) else None,
                "loggedAt": logged_at if finite_number(logged_at) else None,
                # Measurement metadata the app freezes onto each row, carried
                # through so every downstream comparator reads a set with the
                # units and classification it was recorded under.
                #
                # Emitted ONLY when actually recorded. The packet lives under a
                # hard byte budget, and a default-valued key on every set would
                # spend that budget pushing real evidence out. Absence has a
                # precise meaning here — unclassified, unit not recorded — and
                # every consumer already resolves it that way.
                **(
                    {"setKind": set_kind(raw.get("setKind"))}
                    if raw.get("setKind") in ("working", "warmup")
                    else {}
                ),
                **(
                    {"loadConvention": load_convention(raw.get("loadConvention"))}
                    if load_convention(raw.get("loadConvention")) != "unknown"
                    else {}
                ),
            }
        )
    for rows in result.values():
        rows.sort(
            key=lambda item: (
                item["exerciseId"],
                item["setNumber"] if finite_number(item["setNumber"]) else MAX_SAFE_INTEGER,
                item["loggedAt"] if finite_number(item["loggedAt"]) else MAX_SAFE_INTEGER,
                item["sourceSetId"],
            )
        )
    return result

def compact_logged_sets(
    rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if len(rows) <= MAX_RETAINED_SETS_PER_EXERCISE:
        retained = list(rows)
    else:
        edge_count = MAX_RETAINED_SETS_PER_EXERCISE // 4
        selected_ids = {
            item["sourceSetId"] for item in [*rows[:edge_count], *rows[-edge_count:]]
        }
        ranked = sorted(
            rows,
            key=lambda item: (
                float(item["weightLbs"])
                if finite_number(item.get("weightLbs"))
                else -1.0,
                float(item["reps"]) if finite_number(item.get("reps")) else -1.0,
                item["sourceSetId"],
            ),
            reverse=True,
        )
        for item in ranked:
            if len(selected_ids) >= MAX_RETAINED_SETS_PER_EXERCISE:
                break
            selected_ids.add(item["sourceSetId"])
        retained = [item for item in rows if item["sourceSetId"] in selected_ids]
    all_ids = [item["sourceSetId"] for item in rows]
    return retained, {
        "totalLoggedSetCount": len(rows),
        "retainedLoggedSetCount": len(retained),
        "omittedLoggedSetCount": len(rows) - len(retained),
        "allSetSourceIdsSha256": canonical_string_list_sha256(all_ids),
    }

def session_plan_rows(
    session: dict[str, Any], exercises: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    raw_rows = session.get("exerciseSnapshot")
    if not isinstance(raw_rows, list):
        return []
    result: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_rows):
        if not isinstance(raw, dict):
            continue
        try:
            exercise_id = bounded_source_id(
                raw.get("exerciseId"), f"exerciseSnapshot[{index}].exerciseId"
            )
        except ConfigError:
            continue
        target_range, target_range_truncation = optional_excerpt_text(
            raw.get("targetRepRange")
        )
        result.append(
            {
                "exerciseId": exercise_id,
                **exercise_display(exercises, exercise_id),
                "order": raw.get("order") if finite_number(raw.get("order")) else None,
                "targetSets": (
                    raw.get("targetSets")
                    if finite_number(raw.get("targetSets"))
                    else None
                ),
                "targetRepRange": target_range,
                "targetRepRangeTruncation": target_range_truncation,
                # The plan's structured bounds win over re-parsing the display
                # text; `None` is an explicit "no machine-readable target".
                # Structured plan metadata, again emitted only when present so
                # a legacy plan row stays byte-identical to what it was before.
                # `repBounds` is carried verbatim — including an explicit null,
                # which means "deliberately no machine-readable target" — so the
                # comparators honour it instead of re-parsing the display text.
                **(
                    {
                        "repBounds": raw["repBounds"],
                        "targetRepRangeSource": rep_bounds_source(raw),
                    }
                    if "repBounds" in raw
                    and (raw["repBounds"] is None or valid_rep_bounds(raw["repBounds"]))
                    else {}
                ),
                # Only when the plan carried structured bounds. For a plain
                # text target the bounds are exactly what re-parsing
                # `targetRepRange` yields, so restating them would spend the
                # packet's byte budget on a value the reader already has.
                **(
                    {
                        "parsedTargetRepRange": {
                            "minimum": bounds[0],
                            "maximum": bounds[1],
                        }
                    }
                    if "repBounds" in raw
                    and (bounds := plan_rep_bounds(raw)) is not None
                    else {}
                ),
                **(
                    {"plannedWarmupSets": int(raw["warmupSets"])}
                    if finite_number(raw.get("warmupSets"))
                    and not isinstance(raw.get("warmupSets"), bool)
                    and float(raw["warmupSets"]) >= 0
                    else {}
                ),
                **(
                    {"loadConvention": load_convention(raw.get("loadConvention"))}
                    if load_convention(raw.get("loadConvention")) != "unknown"
                    else {}
                ),
            }
        )
    return sorted(
        result,
        key=lambda item: (
            item["order"] if finite_number(item["order"]) else MAX_SAFE_INTEGER,
            item["exerciseId"],
        ),
    )

def valid_pre_workout_feedback(session: dict[str, Any]) -> dict[str, Any] | None:
    raw = session.get("preWorkoutCheckIn")
    if not isinstance(raw, dict) or raw.get("version") != 1:
        return None
    score = raw.get("perceivedRecovery")
    if score is not None and (
        not isinstance(score, int) or isinstance(score, bool) or not 0 <= score <= 10
    ):
        return None
    recorded_at = raw.get("recordedAt")
    if not finite_number(recorded_at):
        return None
    return {
        "version": 1,
        "perceivedRecovery": score,
        "recordedAt": recorded_at,
        "recordedDate": pacific_date_for_epoch(recorded_at),
        "answerStatus": "skipped" if score is None else "reported",
    }

def valid_post_workout_feedback(session: dict[str, Any]) -> dict[str, Any] | None:
    raw = session.get("postWorkoutFeedback")
    if not isinstance(raw, dict) or raw.get("version") != 2:
        return None
    performance = raw.get("performance")
    session_rpe = raw.get("sessionRpe")
    pain_impact = raw.get("painImpact")
    if (
        not isinstance(performance, int)
        or isinstance(performance, bool)
        or not 1 <= performance <= 5
        or not isinstance(session_rpe, int)
        or isinstance(session_rpe, bool)
        or not 0 <= session_rpe <= 10
        or not isinstance(pain_impact, str)
        or pain_impact not in {"none", "present_no_effect", "modified", "stopped"}
    ):
        return None
    return {
        "version": 2,
        "performance": performance,
        "sessionRpe": session_rpe,
        "painImpact": pain_impact,
    }

UNFINISHED_WORK_REASONS = frozenset(
    {"time", "equipment", "deliberate_change", "discomfort", "not_recorded"}
)

def valid_unfinished_work(session: dict[str, Any]) -> dict[str, Any] | None:
    """Optional context the athlete recorded for planned work not completed.

    Never inferred and never a clinical judgement: it is passed through exactly
    as recorded, or omitted. Preserving it means the model reads the stated
    reason instead of guessing one from a short session.
    """
    raw = session.get("unfinishedWork")
    if not isinstance(raw, dict) or raw.get("version") != 1:
        return None
    reason = raw.get("reason")
    recorded_at = raw.get("recordedAt")
    if (
        not isinstance(reason, str)
        or reason not in UNFINISHED_WORK_REASONS
        or not isinstance(recorded_at, int)
        or isinstance(recorded_at, bool)
        or recorded_at < 0
    ):
        return None
    return {"version": 1, "reason": reason, "recordedAt": recorded_at}

def episode_signal_alignment(
    pre: dict[str, Any] | None, post: dict[str, Any] | None
) -> dict[str, Any]:
    if (
        pre is None
        or post is None
        or not isinstance(pre.get("perceivedRecovery"), int)
    ):
        return {
            "comparison": "pre_recovery_vs_perceived_performance",
            "status": "unknown",
            "reason": "one_or_both_signals_missing",
        }
    recovery = pre["perceivedRecovery"]
    performance = post["performance"]
    recovery_direction = -1 if recovery < 5 else 1 if recovery > 5 else 0
    performance_direction = -1 if performance < 3 else 1 if performance > 3 else 0
    if recovery_direction and performance_direction:
        status = "aligned" if recovery_direction == performance_direction else "opposed"
    else:
        status = "neutral_or_mixed"
    return {
        "comparison": "pre_recovery_vs_perceived_performance",
        "status": status,
        "values": {
            "perceivedRecovery": recovery,
            "perceivedPerformance": performance,
        },
    }

def build_session_episode(
    facts: SnapshotFacts,
    session: dict[str, Any],
    exercises: dict[str, dict[str, Any]],
    sets_by_session: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    session_id = bounded_source_id(session.get("id"), "workoutSession.id")
    source_story_id = evidence_id("story", session_id)
    started_at = require_epoch_ms(session.get("startedAt"), f"{session_id}.startedAt")
    completed_at = require_epoch_ms(
        session.get("completedAt"), f"{session_id}.completedAt"
    )
    all_plan = session_plan_rows(session, exercises)
    plan, plan_compaction = compact_rows_by_id(
        all_plan,
        maximum=MAX_RETAINED_EXERCISES_PER_EPISODE,
        id_field="exerciseId",
    )
    plan_order = {row["exerciseId"]: index for index, row in enumerate(all_plan)}
    sets = sets_by_session.get(session_id, [])
    grouped: dict[str, list[dict[str, Any]]] = {}
    for logged_set in sets:
        grouped.setdefault(logged_set["exerciseId"], []).append(logged_set)
    logged_work: list[dict[str, Any]] = []
    for exercise_id, rows in grouped.items():
        retained_sets, set_compaction = compact_logged_sets(rows)
        set_rpe_count = sum(1 for row in rows if finite_number(row.get("rpe")))
        logged_work.append(
            {
                "evidenceId": evidence_id("work", session_id, exercise_id),
                "sourceStoryId": source_story_id,
                "domain": "external_work",
                "sourceIds": [
                    session_id,
                    *[row["sourceSetId"] for row in retained_sets],
                ],
                "exerciseId": exercise_id,
                **exercise_display(exercises, exercise_id),
                "sets": retained_sets,
                "performanceMarker": {
                    "metric": "top_epley_estimated_one_rep_max_lbs",
                    "value": top_estimated_one_rep_max(rows),
                    # Counts exactly the rows the marker above could use:
                    # working sets whose recorded load has a valid estimate.
                    "eligibleSetCount": one_rep_max_eligible_set_count(rows),
                },
                "setCompaction": set_compaction,
                "missingness": {
                    "setRpe": (
                        "complete"
                        if set_rpe_count == len(rows)
                        else "missing"
                        if set_rpe_count == 0
                        else "partial"
                    )
                },
            }
        )
    logged_work.sort(
        key=lambda item: (plan_order.get(item["exerciseId"], MAX_SAFE_INTEGER), item["exerciseId"])
    )
    logged_work, work_compaction = compact_rows_by_id(
        logged_work,
        maximum=MAX_RETAINED_EXERCISES_PER_EPISODE,
        id_field="exerciseId",
    )
    pre = valid_pre_workout_feedback(session)
    post = valid_post_workout_feedback(session)
    unfinished = valid_unfinished_work(session)
    legacy = None
    if post is None:
        planned_raw = session.get("sessionPlanned")
        feel_raw = session.get("sessionFeel")
        planned = (
            planned_raw
            if isinstance(planned_raw, int)
            and not isinstance(planned_raw, bool)
            and 1 <= planned_raw <= 5
            else None
        )
        feel = (
            feel_raw
            if isinstance(feel_raw, int)
            and not isinstance(feel_raw, bool)
            and 1 <= feel_raw <= 5
            else None
        )
        if planned is not None or feel is not None:
            legacy = {"sessionPlanned": planned, "sessionFeel": feel}
    subjective_state = (
        {
            "evidenceId": evidence_id("subjective-state", session_id),
            "sourceStoryId": source_story_id,
            "domain": "subjective_state",
            "values": {"perceivedRecovery": pre["perceivedRecovery"]},
        }
        if pre is not None and isinstance(pre.get("perceivedRecovery"), int)
        else None
    )
    subjective_outcome = None
    if post is not None:
        subjective_outcome = {
            "evidenceId": evidence_id("subjective-outcome", session_id),
            "sourceStoryId": source_story_id,
            "domain": "subjective_outcome",
            "values": {"performance": post["performance"]},
        }
    elif legacy is not None:
        subjective_outcome = {
            "evidenceId": evidence_id("legacy-outcome", session_id),
            "sourceStoryId": source_story_id,
            "domain": "legacy_subjective_outcome",
            "values": legacy,
        }
    internal_response = (
        {
            "evidenceId": evidence_id("internal-response", session_id),
            "sourceStoryId": source_story_id,
            "domain": "internal_response",
            "values": {
                "sessionRpe": post.get("sessionRpe") if post is not None else None,
                "setRpeRecordedCount": sum(
                    1 for row in sets if finite_number(row.get("rpe"))
                ),
                "loggedSetCount": len(sets),
            },
        }
        if post is not None or any(finite_number(row.get("rpe")) for row in sets)
        else None
    )
    safety = (
        {
            "evidenceId": evidence_id("safety", session_id),
            "sourceStoryId": source_story_id,
            "domain": "safety",
            "values": {"painImpact": post["painImpact"]},
        }
        if post is not None and post["painImpact"] != "none"
        else None
    )
    alignment = episode_signal_alignment(pre, post)
    if alignment["status"] != "unknown":
        alignment["subjectiveStateEvidenceId"] = (
            subjective_state["evidenceId"] if subjective_state is not None else None
        )
        alignment["subjectiveOutcomeEvidenceId"] = (
            subjective_outcome["evidenceId"] if subjective_outcome is not None else None
        )
    retained_set_ids = [
        row["sourceSetId"]
        for work in logged_work
        for row in work["sets"]
    ]
    all_set_ids = [row["sourceSetId"] for row in sets]
    session_name, session_name_truncation = display_text(
        session.get("name"), "Workout"
    )
    program_name_raw = optional_text(session.get("programName"))
    program_name = None
    program_name_truncation = None
    if program_name_raw is not None:
        program_name, program_name_truncation = text_excerpt(
            program_name_raw, DISPLAY_TEXT_EXCERPT_MAX_CHARS
        )
    episode = {
        "sourceStoryId": source_story_id,
        "sourceIds": [session_id],
        "sourceCompaction": {
            "totalSetSourceIdCount": len(all_set_ids),
            "retainedSetSourceIdCount": len(retained_set_ids),
            "omittedSetSourceIdCount": len(all_set_ids) - len(retained_set_ids),
            "allSetSourceIdsSha256": canonical_string_list_sha256(all_set_ids),
        },
        "sourceSessionId": session_id,
        "observedAt": completed_at,
        "observedDate": pacific_date_for_epoch(completed_at),
        "session": {
            "name": session_name,
            "nameTruncation": session_name_truncation,
            "programId": optional_text(session.get("programId")),
            "programName": program_name,
            "programNameTruncation": program_name_truncation,
            "sessionTemplateId": optional_text(session.get("sessionTemplateId")),
            "startedAt": started_at,
            "completedAt": completed_at,
        },
        "plan": plan,
        "planCompaction": plan_compaction,
        "loggedWork": logged_work,
        "loggedWorkCompaction": work_compaction,
        "feedback": {
            "preWorkoutCheckIn": pre,
            "postWorkoutFeedback": post,
            "legacyPostWorkoutFeedback": legacy,
            **({"unfinishedWork": unfinished} if unfinished is not None else {}),
        },
        "missingness": {
            "programmedPlan": "available" if plan else "missing",
            "loggedWork": "available" if sets else "missing",
            "preWorkoutRecovery": (
                "not_collected"
                if pre is None
                else pre["answerStatus"]
            ),
            "postWorkoutFeedback": "reported" if post is not None else "not_collected",
            "legacyPostWorkoutFeedback": "available" if legacy is not None else "not_used",
            "unfinishedWork": (
                "reported" if unfinished is not None else "not_collected"
            ),
        },
        "signalAlignment": alignment,
        "domainEvidence": {
            "subjectiveState": subjective_state,
            "subjectiveOutcome": subjective_outcome,
            "internalResponse": internal_response,
            "safety": safety,
        },
    }
    return enforce_session_episode_budget(episode)

def enforce_session_episode_budget(episode: dict[str, Any]) -> dict[str, Any]:
    plan = episode["plan"]
    logged_work = episode["loggedWork"]
    compaction = {
        "maxBytes": SESSION_EPISODE_MAX_BYTES,
        "setRowsRemovedForBudget": 0,
        "loggedWorkRowsRemovedForBudget": 0,
        "planRowsRemovedForBudget": 0,
        "finalBytes": 0,
    }
    episode["episodeBudgetCompaction"] = compaction

    for work in logged_work:
        if compact_json_bytes(episode) <= SESSION_EPISODE_MAX_BYTES:
            break
        rows = work["sets"]
        if len(rows) <= 1:
            continue
        retained = max(
            rows,
            key=lambda row: (
                top_estimated_one_rep_max([row]) or -1.0,
                float(row["weightLbs"])
                if finite_number(row.get("weightLbs"))
                else -1.0,
                float(row["reps"])
                if finite_number(row.get("reps"))
                else -1.0,
                row["sourceSetId"],
            ),
        )
        removed = len(rows) - 1
        work["sets"] = [retained]
        work["sourceIds"] = [episode["sourceSessionId"], retained["sourceSetId"]]
        work["setCompaction"]["retainedLoggedSetCount"] = 1
        work["setCompaction"]["omittedLoggedSetCount"] = (
            work["setCompaction"]["totalLoggedSetCount"] - 1
        )
        compaction["setRowsRemovedForBudget"] += removed

    while (
        compact_json_bytes(episode) > SESSION_EPISODE_MAX_BYTES
        and logged_work
    ):
        logged_work.pop()
        compaction["loggedWorkRowsRemovedForBudget"] += 1
        episode["loggedWorkCompaction"]["retainedCount"] = len(logged_work)
        episode["loggedWorkCompaction"]["omittedCount"] = (
            episode["loggedWorkCompaction"]["totalCount"] - len(logged_work)
        )

    while compact_json_bytes(episode) > SESSION_EPISODE_MAX_BYTES and plan:
        plan.pop()
        compaction["planRowsRemovedForBudget"] += 1
        episode["planCompaction"]["retainedCount"] = len(plan)
        episode["planCompaction"]["omittedCount"] = (
            episode["planCompaction"]["totalCount"] - len(plan)
        )

    retained_set_count = sum(len(work["sets"]) for work in logged_work)
    if not logged_work and episode["sourceCompaction"]["totalSetSourceIdCount"]:
        episode["missingness"]["loggedWork"] = "budget_compacted_to_counts"
    if not plan and episode["planCompaction"]["totalCount"]:
        episode["missingness"]["programmedPlan"] = "budget_compacted_to_counts"
    episode["sourceCompaction"]["retainedSetSourceIdCount"] = retained_set_count
    episode["sourceCompaction"]["omittedSetSourceIdCount"] = (
        episode["sourceCompaction"]["totalSetSourceIdCount"] - retained_set_count
    )
    stabilize_compact_json_byte_metric(episode, compaction, "finalBytes")
    if compaction["finalBytes"] > SESSION_EPISODE_MAX_BYTES:
        raise ConfigError(
            "A compact recent-session episode exceeds its deterministic byte budget"
        )
    return episode

def enforce_current_plan_budget(packet: dict[str, Any]) -> dict[str, Any]:
    template = packet.get("sessionTemplate")
    exercises = template.get("exercises") if isinstance(template, dict) else None
    compaction = {
        "maxBytes": CURRENT_PROGRAMMED_SESSION_MAX_BYTES,
        "exerciseRowsRemovedForBudget": 0,
        "finalBytes": 0,
    }
    packet["planBudgetCompaction"] = compaction
    if isinstance(exercises, list):
        exercise_compaction = template.get("exerciseCompaction")
        while (
            compact_json_bytes(packet) > CURRENT_PROGRAMMED_SESSION_MAX_BYTES
            and exercises
        ):
            exercises.pop()
            compaction["exerciseRowsRemovedForBudget"] += 1
        if isinstance(exercise_compaction, dict):
            exercise_compaction["retainedCount"] = len(exercises)
            exercise_compaction["omittedCount"] = (
                exercise_compaction["totalCount"] - len(exercises)
            )
        if not exercises and isinstance(packet.get("missingness"), dict):
            packet["missingness"]["plannedExercises"] = (
                "budget_compacted_to_counts"
            )
    stabilize_compact_json_byte_metric(packet, compaction, "finalBytes")
    if compaction["finalBytes"] > CURRENT_PROGRAMMED_SESSION_MAX_BYTES:
        raise ConfigError(
            "The current programmed session exceeds its deterministic byte budget"
        )
    return packet

def build_current_programmed_session(
    facts: SnapshotFacts,
    exercises: dict[str, dict[str, Any]],
    *,
    today: str,
) -> dict[str, Any]:
    incomplete = [
        row
        for row in facts.data["workoutSessions"]
        if isinstance(row, dict) and row.get("completedAt") is None
    ]
    incomplete.sort(
        key=lambda row: (
            float(row.get("startedAt", -1))
            if finite_number(row.get("startedAt"))
            else -1.0,
            str(row.get("id", "")),
        ),
        reverse=True,
    )
    candidate = next(
        (
            row
            for row in incomplete
            if finite_number(row.get("startedAt"))
            and float(row["startedAt"]) <= float(facts.updated_at)
            and pacific_date_for_epoch(row["startedAt"]) == today
        ),
        None,
    )
    if candidate is not None:
        started_at = candidate["startedAt"]
        if finite_number(started_at):
            session_id = bounded_source_id(
                candidate.get("id"), "resumable workout id"
            )
            all_exercises = session_plan_rows(candidate, exercises)
            planned_exercises, plan_compaction = compact_rows_by_id(
                all_exercises,
                maximum=MAX_RETAINED_CURRENT_PLAN_EXERCISES,
                id_field="exerciseId",
            )
            session_name, session_name_truncation = display_text(
                candidate.get("name"), "Workout"
            )
            program_name, program_name_truncation = optional_excerpt_text(
                candidate.get("programName")
            )
            current_pre = valid_pre_workout_feedback(candidate)
            current_subjective_state = (
                {
                    "evidenceId": evidence_id(
                        "current-subjective-state",
                        session_id,
                        current_pre["recordedAt"],
                        current_pre["perceivedRecovery"],
                    ),
                    "sourceStoryId": evidence_id("story", session_id),
                    "domain": "current_subjective_state",
                    "timing": "current_after_warmup",
                    "observedAt": current_pre["recordedAt"],
                    "observedDate": current_pre["recordedDate"],
                    "values": {
                        "perceivedRecovery": current_pre["perceivedRecovery"]
                    },
                }
                if current_pre is not None
                and isinstance(current_pre.get("perceivedRecovery"), int)
                else None
            )
            return enforce_current_plan_budget({
                "evidenceId": evidence_id(
                    "active-plan", session_id, facts.updated_at
                ),
                "sourceStoryId": evidence_id("story", session_id),
                "domain": "current_plan",
                "sourceIds": [
                    session_id,
                ],
                "status": "resumable",
                "activeWorkout": {
                    "id": session_id,
                    "name": session_name,
                    "nameTruncation": session_name_truncation,
                    "programId": optional_text(candidate.get("programId")),
                    "programName": program_name,
                    "programNameTruncation": program_name_truncation,
                    "sessionTemplateId": optional_text(
                        candidate.get("sessionTemplateId")
                    ),
                    "startedAt": started_at,
                },
                "sessionTemplate": {
                    "id": optional_text(candidate.get("sessionTemplateId")),
                    "name": session_name,
                    "exercises": planned_exercises,
                    "exerciseCompaction": plan_compaction,
                },
                "rotation": {
                    "semantics": "today_screen_resumable_v1",
                    "resumableSessionId": session_id,
                },
                "currentPreWorkoutCheckIn": current_pre,
                "currentSubjectiveState": current_subjective_state,
                "missingness": {
                    "resumableWorkout": "available",
                    "currentPreWorkoutRecovery": (
                        "not_collected"
                        if current_pre is None
                        else current_pre["answerStatus"]
                    ),
                    "plannedExercises": (
                        "available" if planned_exercises else "missing"
                    ),
                },
            })
    programs = [row for row in facts.data["programs"] if isinstance(row, dict)]
    active = [
        row
        for row in programs
        if row.get("isActive") in (1, True)
        and row.get("archivedAt") is None
    ]
    active.sort(key=lambda row: str(row.get("id", "")))
    if not active:
        return {
            "sourceStoryId": evidence_id("story", "plan", "unavailable"),
            "sourceIds": [],
            "status": "unavailable",
            "missingness": {"activeProgram": "missing", "sessionTemplate": "missing"},
        }
    program = active[0]
    program_id = bounded_source_id(program.get("id"), "active program id")
    templates = [
        row
        for row in facts.data["sessionTemplates"]
        if isinstance(row, dict) and row.get("programId") == program_id
    ]
    templates.sort(
        key=lambda row: (
            row.get("order") if finite_number(row.get("order")) else MAX_SAFE_INTEGER,
            str(row.get("id", "")),
        )
    )
    if not templates:
        program_name, program_name_truncation = display_text(
            program.get("name"), "Program"
        )
        return {
            "sourceStoryId": evidence_id("story", "plan", program_id),
            "sourceIds": [program_id],
            "status": "unavailable",
            "program": {
                "id": program_id,
                "name": program_name,
                "nameTruncation": program_name_truncation,
            },
            "missingness": {"activeProgram": "available", "sessionTemplate": "missing"},
        }
    completed_for_program = [
        row
        for row in facts.completed_workouts
        if row.get("programId") == program_id and finite_number(row.get("completedAt"))
    ]
    last_completed = (
        max(completed_for_program, key=lambda row: float(row["completedAt"]))
        if completed_for_program
        else None
    )
    last_template_id = (
        optional_text(last_completed.get("sessionTemplateId"))
        if last_completed is not None
        else None
    )
    last_index = next(
        (
            index
            for index, template in enumerate(templates)
            if template.get("id") == last_template_id
        ),
        -1,
    )
    next_index = 0 if last_index == -1 else (last_index + 1) % len(templates)
    template = templates[next_index]
    template_id = bounded_source_id(template.get("id"), "next session template id")
    template_rows = [
        row
        for row in facts.data["templateExercises"]
        if isinstance(row, dict) and row.get("sessionTemplateId") == template_id
    ]
    template_rows.sort(
        key=lambda row: (
            row.get("order") if finite_number(row.get("order")) else MAX_SAFE_INTEGER,
            str(row.get("id", "")),
        )
    )
    all_planned_exercises: list[dict[str, Any]] = []
    for index, row in enumerate(template_rows):
        row_id = bounded_source_id(row.get("id"), f"templateExercises[{index}].id")
        exercise_id = bounded_source_id(
            row.get("exerciseId"), f"templateExercises[{index}].exerciseId"
        )
        target_range, target_range_truncation = optional_excerpt_text(
            row.get("targetRepRange")
        )
        all_planned_exercises.append(
            {
                "sourceTemplateExerciseId": row_id,
                "exerciseId": exercise_id,
                **exercise_display(exercises, exercise_id),
                "order": row.get("order") if finite_number(row.get("order")) else None,
                "targetSets": (
                    row.get("targetSets")
                    if finite_number(row.get("targetSets"))
                    else None
                ),
                "targetRepRange": target_range,
                "targetRepRangeTruncation": target_range_truncation,
            }
        )
    planned_exercises, plan_compaction = compact_rows_by_id(
        all_planned_exercises,
        maximum=MAX_RETAINED_CURRENT_PLAN_EXERCISES,
        id_field="sourceTemplateExerciseId",
    )
    source_ids = [program_id, template_id]
    last_session_id = (
        bounded_source_id(last_completed.get("id"), "last completed workout id")
        if last_completed is not None
        else None
    )
    if last_session_id is not None:
        source_ids.append(last_session_id)
    program_name, program_name_truncation = display_text(
        program.get("name"), "Program"
    )
    template_name, template_name_truncation = display_text(
        template.get("name"), "Session"
    )
    return enforce_current_plan_budget({
        "evidenceId": evidence_id("plan", program_id, template_id, facts.updated_at),
        "sourceStoryId": evidence_id("story", "plan", program_id, template_id),
        "domain": "current_plan",
        "sourceIds": source_ids,
        "status": "available",
        "program": {
            "id": program_id,
            "name": program_name,
            "nameTruncation": program_name_truncation,
        },
        "sessionTemplate": {
            "id": template_id,
            "name": template_name,
            "nameTruncation": template_name_truncation,
            "order": template.get("order"),
            "exercises": planned_exercises,
            "exerciseCompaction": plan_compaction,
        },
        "rotation": {
            "semantics": "today_screen_v1",
            "lastCompletedSessionId": last_session_id,
            "lastCompletedSessionTemplateId": last_template_id,
            "nextTemplateIndex": next_index,
            "templateCount": len(templates),
        },
        "missingness": {
            "activeProgram": "available",
            "sessionTemplate": "available",
            "plannedExercises": "available" if planned_exercises else "missing",
        },
    })

def compact_feedback_for_comparator(
    session: dict[str, Any],
    *,
    session_id: str,
    source_story_id: str,
    rows: list[dict[str, Any]],
) -> dict[str, Any]:
    pre = valid_pre_workout_feedback(session)
    post = valid_post_workout_feedback(session)
    return {
        "feedback": {
            "preWorkoutCheckIn": pre,
            "postWorkoutFeedback": post,
            "missingness": {
                "preWorkoutRecovery": (
                    "missing" if pre is None else pre["answerStatus"]
                ),
                "postWorkoutFeedback": "missing" if post is None else "reported",
            },
        },
        "domainEvidence": {
            "subjectiveState": (
                {
                    "evidenceId": evidence_id("subjective-state", session_id),
                    "sourceStoryId": source_story_id,
                    "domain": "subjective_state",
                    "values": {"perceivedRecovery": pre["perceivedRecovery"]},
                }
                if pre is not None and isinstance(pre.get("perceivedRecovery"), int)
                else None
            ),
            "subjectiveOutcome": (
                {
                    "evidenceId": evidence_id("subjective-outcome", session_id),
                    "sourceStoryId": source_story_id,
                    "domain": "subjective_outcome",
                    "values": {"performance": post["performance"]},
                }
                if post is not None
                else None
            ),
            "internalResponse": (
                {
                    "evidenceId": evidence_id("internal-response", session_id),
                    "sourceStoryId": source_story_id,
                    "domain": "internal_response",
                    "values": {
                        "sessionRpe": post["sessionRpe"] if post is not None else None,
                        "setRpeRecordedCount": sum(
                            1 for row in rows if finite_number(row.get("rpe"))
                        ),
                        "comparableLoggedSetCount": len(rows),
                    },
                }
                if post is not None
                or any(finite_number(row.get("rpe")) for row in rows)
                else None
            ),
            "safety": (
                {
                    "evidenceId": evidence_id("safety", session_id),
                    "sourceStoryId": source_story_id,
                    "domain": "safety",
                    "values": {"painImpact": post["painImpact"]},
                }
                if post is not None and post["painImpact"] != "none"
                else None
            ),
        },
    }

def build_comparable_exposures(
    facts: SnapshotFacts,
    current_plan: dict[str, Any],
    exercises: dict[str, dict[str, Any]],
    sets_by_session: dict[str, list[dict[str, Any]]],
    recent_episodes_by_session: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    template = current_plan.get("sessionTemplate")
    planned = template.get("exercises") if isinstance(template, dict) else None
    if not isinstance(planned, list):
        return []
    completed = sorted(
        facts.completed_workouts,
        key=lambda row: (float(row.get("completedAt", 0)), str(row.get("id", ""))),
        reverse=True,
    )
    plans_by_session: dict[str, dict[str, dict[str, Any]]] = {}
    for session in completed:
        session_id = bounded_source_id(session.get("id"), "workoutSession.id")
        plans_by_session[session_id] = {
            row["exerciseId"]: row for row in session_plan_rows(session, exercises)
        }
    result: list[dict[str, Any]] = []
    for movement in planned:
        exercise_id = movement["exerciseId"]
        wanted_range = parsed_target_rep_range(movement.get("targetRepRange"))
        exact_exposures: list[dict[str, Any]] = []
        noncomparable_exposures: list[dict[str, Any]] = []
        available_exact_count = 0
        available_same_exercise_count = 0
        for session in completed:
            session_id = bounded_source_id(session.get("id"), "workoutSession.id")
            rows = [
                row
                for row in sets_by_session.get(session_id, [])
                if row["exerciseId"] == exercise_id
            ]
            if not rows:
                continue
            available_same_exercise_count += 1
            historical_plan = plans_by_session[session_id].get(exercise_id)
            historical_target = (
                historical_plan.get("targetRepRange") if historical_plan else None
            )
            comparability = target_range_comparability(
                movement.get("targetRepRange"), historical_target
            )
            exact = comparability == "same_exercise_same_target_rep_range"
            if exact:
                available_exact_count += 1
                target_exposures = exact_exposures
            else:
                target_exposures = noncomparable_exposures
            if len(target_exposures) >= COMPARABLE_EXPOSURE_LIMIT:
                continue
            completed_at = require_epoch_ms(
                session.get("completedAt"), f"{session_id}.completedAt"
            )
            source_story_id = evidence_id("story", session_id)
            retained_sets, set_compaction = compact_logged_sets(rows)
            marker = {
                "metric": "top_epley_estimated_one_rep_max_lbs",
                "value": top_estimated_one_rep_max(rows),
                "eligibleSetCount": one_rep_max_eligible_set_count(rows),
            }
            completion = comparator_completion(historical_plan, rows)
            if not exact:
                completion["eligibleForProgressionTrend"] = False
                completion["ineligibilityReasons"] = [
                    "target_rep_range_not_exactly_comparable"
                ]
            else:
                completion["ineligibilityReasons"] = (
                    []
                    if completion["eligibleForProgressionTrend"]
                    else ["target_sets_or_logged_reps_incomplete"]
                )
            recent_episode = recent_episodes_by_session.get(session_id)
            recent_work = (
                next(
                    (
                        item
                        for item in recent_episode["loggedWork"]
                        if item["exerciseId"] == exercise_id
                    ),
                    None,
                )
                if recent_episode is not None
                else None
            )
            if recent_episode is not None and recent_work is not None:
                exposure = {
                    "representation": "recent_episode_reference",
                    "sourceIds": [session_id],
                    "sourceStoryId": source_story_id,
                    "sourceSessionId": session_id,
                    "observedAt": completed_at,
                    "observedDate": pacific_date_for_epoch(completed_at),
                    "sourceWorkEvidenceId": recent_work["evidenceId"],
                    "sourceDomainEvidenceIds": {
                        key: value["evidenceId"]
                        for key, value in recent_episode["domainEvidence"].items()
                        if isinstance(value, dict)
                    },
                    "performanceMarker": marker,
                    "programCompletion": completion,
                    "sourceSetCompaction": set_compaction,
                    "comparability": comparability,
                    "canonicalHistoricalTargetRepRange": (
                        f"{parsed_target_rep_range(historical_target)[0]}-"
                        f"{parsed_target_rep_range(historical_target)[1]}"
                        if parsed_target_rep_range(historical_target) is not None
                        else None
                    ),
                }
            else:
                session_name, session_name_truncation = display_text(
                    session.get("name"), "Workout"
                )
                feedback = compact_feedback_for_comparator(
                    session,
                    session_id=session_id,
                    source_story_id=source_story_id,
                    rows=rows,
                )
                exposure = {
                    "representation": "compact_exposure",
                    "evidenceId": evidence_id("work", session_id, exercise_id),
                    "sourceStoryId": source_story_id,
                    "domain": "external_work",
                    "sourceIds": [
                        session_id,
                        *[row["sourceSetId"] for row in retained_sets],
                    ],
                    "sourceSessionId": session_id,
                    "observedAt": completed_at,
                    "observedDate": pacific_date_for_epoch(completed_at),
                    "sessionName": session_name,
                    "sessionNameTruncation": session_name_truncation,
                    "programmedTarget": historical_plan,
                    "loggedSets": retained_sets,
                    "sourceSetCompaction": set_compaction,
                    "performanceMarker": marker,
                    "programCompletion": completion,
                    **feedback,
                    "comparability": comparability,
                    "canonicalHistoricalTargetRepRange": (
                        f"{parsed_target_rep_range(historical_target)[0]}-"
                        f"{parsed_target_rep_range(historical_target)[1]}"
                        if parsed_target_rep_range(historical_target) is not None
                        else None
                    ),
                }
            target_exposures.append(exposure)
        exposures = exact_exposures[:COMPARABLE_EXPOSURE_LIMIT]
        if len(exposures) < COMPARABLE_EXPOSURE_LIMIT:
            exposures.extend(
                noncomparable_exposures[
                    : COMPARABLE_EXPOSURE_LIMIT - len(exposures)
                ]
            )
        retained_exact_count = sum(
            1
            for exposure in exposures
            if exposure["comparability"]
            == "same_exercise_same_target_rep_range"
        )
        selection_pruned = available_same_exercise_count - len(exposures)
        missingness = (
            "no_same_exercise_exposures"
            if not exposures
            else "selection_limited"
            if available_same_exercise_count > len(exposures)
            else "no_exact_target_range_comparators"
            if available_exact_count == 0
            else "fewer_than_three"
            if available_exact_count < COMPARABLE_EXPOSURE_LIMIT
            else "complete"
        )
        result.append(
            {
                "sourceIds": [exercise_id],
                "exerciseId": exercise_id,
                **exercise_display(exercises, exercise_id),
                "todayTarget": {
                    "targetSets": movement.get("targetSets"),
                    "targetRepRange": movement.get("targetRepRange"),
                    "canonicalTargetRepRange": (
                        f"{wanted_range[0]}-{wanted_range[1]}"
                        if wanted_range is not None
                        else None
                    ),
                },
                "availableSameExerciseExposureCount": available_same_exercise_count,
                "availableComparableExposureCount": available_exact_count,
                "retainedExposureCount": len(exposures),
                "retainedComparableExposureCount": retained_exact_count,
                "prunedExposureCount": selection_pruned,
                "prunedComparableExposureCount": (
                    available_exact_count - retained_exact_count
                ),
                "excludedNonComparableExposureCount": (
                    available_same_exercise_count
                    - available_exact_count
                    - (len(exposures) - retained_exact_count)
                ),
                "exposures": exposures,
                "missingness": missingness,
            }
        )
    return result

def memory_summary_pool(
    facts: SnapshotFacts, existing_items: list[dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}

    def add(raw: dict[str, Any], *, type_field: str, source: str) -> None:
        memory_type = raw.get(type_field)
        if memory_type not in {"two_week", "four_month"}:
            return
        summary_id = bounded_source_id(raw.get("id"), f"{source} summary id")
        start = require_epoch_ms(raw.get("periodStartAt"), f"{summary_id}.periodStartAt")
        end = require_epoch_ms(raw.get("periodEndAt"), f"{summary_id}.periodEndAt")
        bullets_raw = raw.get("bullets")
        raw_bullets = []
        if isinstance(bullets_raw, list):
            for item in bullets_raw:
                cleaned = optional_text(item) if isinstance(item, str) else None
                if cleaned is not None:
                    raw_bullets.append(cleaned)
        bullet_pairs = [
            text_excerpt(item, SUMMARY_BULLET_EXCERPT_MAX_CHARS)
            for item in raw_bullets[:MAX_RETAINED_SUMMARY_BULLETS]
        ]
        source_session_ids = [
            item
            for item in raw.get("sourceSessionIds", [])
            if isinstance(item, str)
        ]
        source_note_ids = [
            item
            for item in raw.get("sourceNoteIds", [])
            if isinstance(item, str)
        ]
        source_summary_ids = [
            item
            for item in raw.get("sourceSummaryIds", [])
            if isinstance(item, str)
        ]
        retained_session_ids, session_id_compaction = compact_source_ids(
            source_session_ids
        )
        retained_note_ids, note_id_compaction = compact_source_ids(source_note_ids)
        retained_summary_ids, summary_id_compaction = compact_source_ids(
            source_summary_ids
        )
        updated_at = (
            float(raw["updatedAt"])
            if finite_number(raw.get("updatedAt"))
            else 0.0
        )
        record = {
            "evidenceId": evidence_id("summary", summary_id),
            "sourceStoryId": evidence_id("story", "summary", summary_id),
            "domain": "periodic_summary",
            "sourceIds": [summary_id],
            "sourceSummaryId": summary_id,
            "sourceStore": source,
            "memoryType": memory_type,
            "periodStartAt": start,
            "periodEndAt": end,
            "observedAt": end,
            "observedDate": pacific_date_for_epoch(end),
            "updatedAt": updated_at or None,
            "bullets": [item[0] for item in bullet_pairs],
            "bulletTruncations": [item[1] for item in bullet_pairs],
            "bulletCompaction": {
                "totalCount": len(raw_bullets),
                "retainedCount": len(bullet_pairs),
                "omittedCount": len(raw_bullets) - len(bullet_pairs),
                "allBulletsSha256": sha256_bytes(
                    json.dumps(
                        raw_bullets,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ).encode("utf-8")
                ),
            },
            "sourceSessionIds": retained_session_ids,
            "sourceNoteIds": retained_note_ids,
            "sourceSummaryIds": retained_summary_ids,
            "sourceIdCompaction": {
                "sessions": session_id_compaction,
                "notes": note_id_compaction,
                "summaries": summary_id_compaction,
            },
            "_allSourceSessionIds": source_session_ids,
            "_allSourceNoteIds": source_note_ids,
            "_allSourceSummaryIds": source_summary_ids,
            "_contentAuthorityUpdatedAt": updated_at,
            "_provenanceSourceStore": source,
        }
        prior = result.get(summary_id)
        if prior is not None and (
            prior["memoryType"],
            prior["periodStartAt"],
            prior["periodEndAt"],
        ) != (memory_type, start, end):
            raise ConfigError(f"Conflicting trusted memory summary id: {summary_id}")
        if prior is None:
            result[summary_id] = record
            return

        content_winner = (
            record
            if updated_at > float(prior.get("_contentAuthorityUpdatedAt", 0.0))
            or (
                updated_at
                == float(prior.get("_contentAuthorityUpdatedAt", 0.0))
                and source == "cloud_memory"
            )
            else prior
        )
        provenance_winner = (
            record
            if source == "cloud_memory"
            else prior
            if prior.get("_provenanceSourceStore") == "cloud_memory"
            else content_winner
        )
        for key in (
            "sourceSessionIds",
            "sourceNoteIds",
            "sourceSummaryIds",
            "sourceIdCompaction",
            "_allSourceSessionIds",
            "_allSourceNoteIds",
            "_allSourceSummaryIds",
        ):
            content_winner[key] = provenance_winner[key]
        content_winner["_provenanceSourceStore"] = provenance_winner[
            "_provenanceSourceStore"
        ]
        result[summary_id] = content_winner

    for raw in facts.ai_memory_summaries:
        add(raw, type_field="periodType", source="snapshot")
    for raw in existing_items:
        add(raw, type_field="memoryType", source="cloud_memory")

    resolved_sessions: dict[str, set[str]] = {}
    visiting: set[str] = set()

    def source_session_closure(summary_id: str) -> set[str]:
        cached = resolved_sessions.get(summary_id)
        if cached is not None:
            return cached
        if summary_id in visiting:
            raise ConfigError(
                f"Trusted memory summary provenance contains a cycle: {summary_id}"
            )
        visiting.add(summary_id)
        record = result[summary_id]
        closure = set(record["_allSourceSessionIds"])
        for source_summary_id in record["_allSourceSummaryIds"]:
            if source_summary_id not in result:
                raise ConfigError(
                    "Trusted memory summary references an unavailable source: "
                    f"{source_summary_id}"
                )
            closure.update(source_session_closure(source_summary_id))
        visiting.remove(summary_id)
        resolved_sessions[summary_id] = closure
        return closure

    for summary_id, record in result.items():
        all_source_session_ids = sorted(source_session_closure(summary_id))
        retained_session_ids, session_id_compaction = compact_source_ids(
            all_source_session_ids
        )
        record["_allSourceSessionIds"] = all_source_session_ids
        record["sourceSessionIds"] = retained_session_ids
        record["sourceIdCompaction"]["sessions"] = session_id_compaction
    return result

def build_older_periodic_summaries(
    pool: dict[str, dict[str, Any]],
    retained_session_ids: set[str],
    oldest_recent_session_at: int | float | None,
) -> tuple[list[dict[str, Any]], int]:
    candidates = []
    for summary in pool.values():
        if not summary["bullets"]:
            continue
        if (
            oldest_recent_session_at is not None
            and summary["periodEndAt"] > oldest_recent_session_at
        ):
            continue
        if retained_session_ids.intersection(summary["_allSourceSessionIds"]):
            continue
        candidates.append(summary)
    candidates.sort(
        key=lambda item: (item["periodEndAt"], item["periodStartAt"], item["sourceSummaryId"]),
        reverse=True,
    )
    retained_internal: list[dict[str, Any]] = []

    def add_nonoverlapping(candidate: dict[str, Any]) -> bool:
        if any(
            candidate["periodStartAt"] < item["periodEndAt"]
            and item["periodStartAt"] < candidate["periodEndAt"]
            for item in retained_internal
        ):
            return False
        retained_internal.append(candidate)
        return True

    two_week = [item for item in candidates if item["memoryType"] == "two_week"]
    four_month = [item for item in candidates if item["memoryType"] == "four_month"]
    for candidate in two_week:
        add_nonoverlapping(candidate)
        if len([item for item in retained_internal if item["memoryType"] == "two_week"]) >= 2:
            break
    older_than = min(
        (item["periodStartAt"] for item in retained_internal),
        default=oldest_recent_session_at,
    )
    for candidate in four_month:
        if older_than is not None and candidate["periodEndAt"] > older_than:
            continue
        if add_nonoverlapping(candidate):
            break
    for candidate in [*two_week, *four_month]:
        if len(retained_internal) >= OLDER_PERIODIC_SUMMARY_LIMIT:
            break
        if candidate not in retained_internal:
            add_nonoverlapping(candidate)

    retained = [
        {key: value for key, value in item.items() if not key.startswith("_")}
        for item in retained_internal
    ]
    return retained, len(candidates)

def build_user_context(
    facts: SnapshotFacts, plan: MemoryCandidatePlan
) -> dict[str, Any]:
    if plan.trusted_state["paused"]:
        return {
            "memoryPaused": True,
            "currentContext": None,
            "safetyEvents": [],
            "recentGeneralNotes": [],
            "missingness": "paused",
            "omittedOlderSafetyNoteCount": 0,
            "omittedOlderGeneralNoteCount": 0,
        }
    notes: list[dict[str, Any]] = []
    for raw in facts.ai_notes:
        note_id = bounded_source_id(raw.get("id"), "AI note id")
        created_at = require_epoch_ms(raw.get("createdAt"), f"AI note {note_id}.createdAt")
        parsed_updated_at = (
            require_epoch_ms(raw.get("updatedAt"), f"AI note {note_id}.updatedAt")
            if finite_number(raw.get("updatedAt"))
            else created_at
        )
        updated_at = max(created_at, parsed_updated_at)
        content_observed_at = updated_at
        full_body = require_string(raw.get("body"), f"AI note {note_id}.body")
        safety_match = SAFETY_CONTEXT_RE.search(full_body) is not None
        unresolved_red_flag = has_unresolved_red_flag(full_body)
        body, body_truncation = text_excerpt(
            full_body,
            NOTE_EXCERPT_MAX_CHARS,
            focus_re=(
                REST_RED_FLAG_RE
                if unresolved_red_flag
                else SAFETY_CONTEXT_RE
                if safety_match
                else None
            ),
        )
        notes.append(
            {
                "evidenceId": evidence_id("note", note_id),
                "sourceStoryId": evidence_id("story", "note", note_id),
                "domain": "user_context",
                "sourceIds": [note_id],
                "sourceNoteId": note_id,
                "createdAt": created_at,
                "updatedAt": updated_at,
                "observedAt": content_observed_at,
                "observedDate": pacific_date_for_epoch(content_observed_at),
                "timestampMeaning": "note_content_updated_at",
                "body": body,
                "bodyTruncation": body_truncation,
                "retrievalSafetyMatch": safety_match,
                "unresolvedRedFlag": unresolved_red_flag,
            }
        )
    notes.sort(key=lambda item: (item["observedAt"], item["sourceNoteId"]), reverse=True)
    all_safety_notes = [item for item in notes if item["retrievalSafetyMatch"]]
    safety_notes = all_safety_notes[:RECENT_SAFETY_NOTE_LIMIT]
    safety_ids = {item["sourceNoteId"] for item in all_safety_notes}
    all_general = [item for item in notes if item["sourceNoteId"] not in safety_ids]
    general = all_general[:RECENT_GENERAL_NOTE_LIMIT]
    context_text = optional_text(plan.trusted_state.get("currentContext"))
    settings_updated_at = None
    if facts.ai_memory_settings:
        raw_updated_at = facts.ai_memory_settings[0].get("updatedAt")
        if finite_number(raw_updated_at):
            settings_updated_at = raw_updated_at
    context_excerpt = None
    context_truncation = None
    context_has_red_flag = False
    context_has_safety_match = False
    if context_text is not None:
        context_has_red_flag = has_unresolved_red_flag(context_text)
        context_has_safety_match = SAFETY_CONTEXT_RE.search(context_text) is not None
        context_excerpt, context_truncation = text_excerpt(
            context_text,
            CURRENT_CONTEXT_EXCERPT_MAX_CHARS,
            focus_re=(
                REST_RED_FLAG_RE
                if context_has_red_flag
                else SAFETY_CONTEXT_RE
                if context_has_safety_match
                else None
            ),
        )
    current_context = (
        {
            "evidenceId": evidence_id(
                "context", "ai-memory-state:default", context_text
            ),
            "sourceStoryId": evidence_id("story", "context", "ai-memory-state:default"),
            "domain": "user_context",
            "sourceIds": ["ai-memory-state:default"],
            "observedAt": settings_updated_at,
            "observedDate": pacific_date_for_epoch(settings_updated_at),
            "snapshotObservedAt": facts.updated_at,
            "timestampMeaning": (
                "memory_settings_updated_at"
                if settings_updated_at is not None
                else "snapshot_sync_only_not_report_time"
            ),
            "body": context_excerpt,
            "bodyTruncation": context_truncation,
            "retrievalSafetyMatch": context_has_safety_match,
            "unresolvedRedFlag": context_has_red_flag,
        }
        if context_text is not None
        else None
    )
    return {
        "memoryPaused": False,
        "currentContext": current_context,
        "safetyEvents": safety_notes,
        "recentGeneralNotes": general,
        "missingness": "available" if current_context or notes else "no_user_context",
        "omittedOlderSafetyNoteCount": len(all_safety_notes) - len(safety_notes),
        "omittedOlderGeneralNoteCount": len(all_general) - len(general),
    }

def build_session_safety_events(episodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for episode in episodes:
        safety = episode["domainEvidence"].get("safety")
        if not isinstance(safety, dict):
            continue
        result.append(
            {
                "sourceIds": [episode["sourceSessionId"]],
                "sourceStoryId": episode["sourceStoryId"],
                "sourceEvidenceId": safety["evidenceId"],
                "sourceSessionId": episode["sourceSessionId"],
                "observedAt": episode["observedAt"],
                "observedDate": episode["observedDate"],
                "kind": "reported_pain_or_physical_problem",
                "painImpact": safety["values"]["painImpact"],
            }
        )
    return result

def build_recovery_lane(recovery: dict[str, Any]) -> dict[str, Any]:
    exposed = model_recovery_context(recovery)
    status = exposed.get("status")
    lane = {
        "sourceStoryId": evidence_id(
            "story", "recovery", exposed.get("evaluationDate")
        ),
        "sourceIds": ["oura:daily-readiness", "oura:daily-sleep"],
        "observedAt": exposed.get("generatedAt"),
        "status": status,
        "freshnessPolicy": exposed.get("freshnessPolicy"),
        "evaluationDate": exposed.get("evaluationDate"),
        "latestReadiness": exposed.get("latestReadiness"),
        "latestSleep": exposed.get("latestSleep"),
        "missingness": (
            "available"
            if status == "fresh"
            else "redacted_stale"
            if status == "stale"
            else "unavailable"
        ),
    }
    if status == "fresh":
        lane["evidenceId"] = evidence_id(
            "recovery",
            exposed.get("evaluationDate"),
            status,
            exposed.get("freshnessPolicy"),
        )
        lane["domain"] = "wearable_recovery"
    return lane

def collect_evidence_ids(value: Any) -> frozenset[str]:
    found: set[str] = set()

    def walk(item: Any) -> None:
        if isinstance(item, dict):
            candidate = item.get("evidenceId")
            if isinstance(candidate, str):
                if len(candidate) > 180:
                    raise ConfigError("Evidence id exceeds 180 characters")
                found.add(candidate)
            for key, child in item.items():
                if key != "allowedEvidenceIds":
                    walk(child)
        elif isinstance(item, list):
            for child in item:
                walk(child)

    walk(value)
    return frozenset(found)

def collect_evidence_provenance(
    value: Any,
) -> tuple[dict[str, str], dict[str, str]]:
    source_stories: dict[str, str] = {}
    domains: dict[str, str] = {}

    def walk(item: Any) -> None:
        if isinstance(item, dict):
            candidate = item.get("evidenceId")
            if isinstance(candidate, str):
                story = item.get("sourceStoryId")
                domain = item.get("domain")
                canonical_story = story if isinstance(story, str) else candidate
                canonical_domain = (
                    domain
                    if isinstance(domain, str)
                    else candidate.partition(":")[0]
                )
                prior_story = source_stories.setdefault(candidate, canonical_story)
                prior_domain = domains.setdefault(candidate, canonical_domain)
                if prior_story != canonical_story or prior_domain != canonical_domain:
                    raise ConfigError(
                        f"Evidence id has conflicting provenance: {candidate}"
                    )
            for child in item.values():
                walk(child)
        elif isinstance(item, list):
            for child in item:
                walk(child)

    walk(value)
    return source_stories, domains

def compact_memory_source_summary(summary: dict[str, Any]) -> dict[str, Any]:
    bullets = summary.get("bullets")
    raw_bullets = (
        [item for item in bullets if isinstance(item, str)]
        if isinstance(bullets, list)
        else []
    )
    retained_pairs = [
        text_excerpt(item, MEMORY_SOURCE_SUMMARY_BULLET_MAX_CHARS)
        for item in raw_bullets[:MAX_MEMORY_SOURCE_SUMMARY_BULLETS]
    ]
    return {
        "sourceSummaryId": summary["sourceSummaryId"],
        "memoryType": summary["memoryType"],
        "periodStartAt": summary["periodStartAt"],
        "periodEndAt": summary["periodEndAt"],
        "bullets": [item[0] for item in retained_pairs],
        "bulletCompaction": {
            "totalCount": (
                summary.get("bulletCompaction", {}).get(
                    "totalCount", len(raw_bullets)
                )
            ),
            "retainedCount": len(retained_pairs),
            "omittedCount": max(
                0,
                summary.get("bulletCompaction", {}).get(
                    "totalCount", len(raw_bullets)
                )
                - len(retained_pairs),
            ),
            "allBulletsSha256": summary.get("bulletCompaction", {}).get(
                "allBulletsSha256"
            ),
        },
    }

def build_periodic_candidate_digest(
    candidate: dict[str, Any],
    projection: dict[str, Any],
    sessions_by_id: dict[str, dict[str, Any]],
    exercises: dict[str, dict[str, Any]],
    sets_by_session: dict[str, list[dict[str, Any]]],
) -> tuple[dict[str, Any], list[str]]:
    expected = candidate["expected"]
    source_sessions: list[tuple[str, dict[str, Any]]] = []
    missing_ids: list[str] = []
    for source_id in expected["sourceSessionIds"]:
        session = sessions_by_id.get(source_id)
        if session is None:
            missing_ids.append(source_id)
        else:
            source_sessions.append((source_id, session))
    source_sessions.sort(
        key=lambda item: (
            float(item[1].get("completedAt", 0)),
            item[0],
        )
    )

    observed_date_counts: dict[str, int] = {}
    pre_answer_counts: dict[str, int] = {}
    recovery_score_counts: dict[str, int] = {}
    post_answer_counts: dict[str, int] = {}
    performance_counts: dict[str, int] = {}
    session_rpe_counts: dict[str, int] = {}
    pain_impact_counts: dict[str, int] = {}
    legacy_planned_counts: dict[str, int] = {}
    legacy_feel_counts: dict[str, int] = {}
    exercise_stats: dict[str, dict[str, Any]] = {}
    session_samples: list[dict[str, Any]] = []
    session_with_logged_work_count = 0
    logged_set_count = 0
    set_rpe_recorded_count = 0

    def increment(counter: dict[str, int], key: str) -> None:
        counter[key] = counter.get(key, 0) + 1

    for session_id, session in source_sessions:
        completed_at = require_epoch_ms(
            session.get("completedAt"), f"{session_id}.completedAt"
        )
        observed_date = pacific_date_for_epoch(completed_at)
        if observed_date is not None:
            increment(observed_date_counts, observed_date)
        rows = sets_by_session.get(session_id, [])
        if rows:
            session_with_logged_work_count += 1
        logged_set_count += len(rows)
        set_rpe_recorded_count += sum(
            1 for row in rows if finite_number(row.get("rpe"))
        )
        rows_by_exercise: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            rows_by_exercise.setdefault(row["exerciseId"], []).append(row)
        for exercise_id, exercise_rows in rows_by_exercise.items():
            stat = exercise_stats.setdefault(
                exercise_id,
                {
                    "exerciseId": exercise_id,
                    "sessionExposureCount": 0,
                    "loggedSetCount": 0,
                    "topEpleyEstimatedOneRepMaxLbs": None,
                },
            )
            stat["sessionExposureCount"] += 1
            stat["loggedSetCount"] += len(exercise_rows)
            marker = top_estimated_one_rep_max(exercise_rows)
            if marker is not None and (
                stat["topEpleyEstimatedOneRepMaxLbs"] is None
                or marker > stat["topEpleyEstimatedOneRepMaxLbs"]
            ):
                stat["topEpleyEstimatedOneRepMaxLbs"] = marker

        pre = valid_pre_workout_feedback(session)
        if pre is None:
            increment(pre_answer_counts, "not_collected")
        else:
            increment(pre_answer_counts, pre["answerStatus"])
            if isinstance(pre.get("perceivedRecovery"), int):
                increment(
                    recovery_score_counts, str(pre["perceivedRecovery"])
                )
        post = valid_post_workout_feedback(session)
        legacy = None
        if post is None:
            planned = session.get("sessionPlanned")
            feel = session.get("sessionFeel")
            valid_planned = (
                planned
                if isinstance(planned, int)
                and not isinstance(planned, bool)
                and 1 <= planned <= 5
                else None
            )
            valid_feel = (
                feel
                if isinstance(feel, int)
                and not isinstance(feel, bool)
                and 1 <= feel <= 5
                else None
            )
            if valid_planned is not None or valid_feel is not None:
                legacy = {
                    "sessionPlanned": valid_planned,
                    "sessionFeel": valid_feel,
                }
                if valid_planned is not None:
                    increment(legacy_planned_counts, str(valid_planned))
                if valid_feel is not None:
                    increment(legacy_feel_counts, str(valid_feel))
        if post is None:
            increment(post_answer_counts, "not_collected")
        else:
            increment(post_answer_counts, "reported")
            increment(performance_counts, str(post["performance"]))
            increment(session_rpe_counts, str(post["sessionRpe"]))
            increment(pain_impact_counts, post["painImpact"])

        session_name, session_name_truncation = optional_excerpt_text(
            session.get("name"), 80
        )
        session_samples.append(
            {
                "sourceStoryId": evidence_id("story", session_id),
                "observedAt": completed_at,
                "observedDate": observed_date,
                "sessionName": session_name or "Workout",
                "sessionNameTruncation": session_name_truncation,
                "exerciseExposureCount": len(rows_by_exercise),
                "loggedSetCount": len(rows),
                "preWorkout": (
                    {
                        "answerStatus": pre["answerStatus"],
                        "perceivedRecovery": pre["perceivedRecovery"],
                    }
                    if pre is not None
                    else None
                ),
                "postWorkout": (
                    {
                        "performance": post["performance"],
                        "sessionRpe": post["sessionRpe"],
                        "painImpact": post["painImpact"],
                    }
                    if post is not None
                    else None
                ),
                "legacyPostWorkout": legacy,
            }
        )

    def adverse_sample_key(item: dict[str, Any]) -> tuple[Any, ...]:
        post = item["postWorkout"]
        pre = item["preWorkout"]
        pain = post.get("painImpact") if isinstance(post, dict) else None
        performance = post.get("performance") if isinstance(post, dict) else None
        session_rpe = post.get("sessionRpe") if isinstance(post, dict) else None
        recovery_score = (
            pre.get("perceivedRecovery") if isinstance(pre, dict) else None
        )
        return (
            {
                "stopped": 3,
                "modified": 2,
                "present_no_effect": 1,
            }.get(pain, 0),
            6 - performance if isinstance(performance, int) else 0,
            session_rpe if isinstance(session_rpe, int) else -1,
            10 - recovery_score if isinstance(recovery_score, int) else -1,
            item["observedAt"],
            item["sourceStoryId"],
        )

    sample_candidates = [
        *list(reversed(session_samples[-2:])),
        *sorted(session_samples, key=adverse_sample_key, reverse=True)[:1],
        *session_samples[:1],
    ]
    retained_samples: list[dict[str, Any]] = []
    retained_story_ids: set[str] = set()
    for item in sample_candidates:
        if item["sourceStoryId"] in retained_story_ids:
            continue
        retained_samples.append(item)
        retained_story_ids.add(item["sourceStoryId"])
        if len(retained_samples) >= MAX_PERIODIC_DIGEST_SESSION_SAMPLES:
            break

    ranked_exercises = sorted(
        exercise_stats.values(),
        key=lambda item: (
            -item["sessionExposureCount"],
            -item["loggedSetCount"],
            item["exerciseId"],
        ),
    )
    retained_exercises = ranked_exercises[:MAX_PERIODIC_DIGEST_EXERCISES]
    for item in retained_exercises:
        raw = exercises.get(item["exerciseId"])
        exercise_name, exercise_name_truncation = optional_excerpt_text(
            raw.get("name") if raw is not None else None, 80
        )
        item["exerciseName"] = exercise_name or item["exerciseId"]
        item["exerciseNameTruncation"] = exercise_name_truncation

    digest = {
        "candidateId": expected["id"],
        "memoryType": expected["memoryType"],
        "periodStartAt": expected["periodStartAt"],
        "periodEndAt": expected["periodEndAt"],
        "sourceSessionIdCompaction": projection[
            "sourceSessionIdCompaction"
        ],
        "sourceSummaryIdCompaction": projection[
            "sourceSummaryIdCompaction"
        ],
        "aggregate": {
            "availableSessionCount": len(source_sessions),
            "sessionWithLoggedWorkCount": session_with_logged_work_count,
            "loggedSetCount": logged_set_count,
            "setRpeRecordedCount": set_rpe_recorded_count,
            "observedDateCounts": dict(sorted(observed_date_counts.items())),
            "preWorkoutAnswerStatusCounts": dict(
                sorted(pre_answer_counts.items())
            ),
            "perceivedRecoveryScoreCounts": dict(
                sorted(recovery_score_counts.items(), key=lambda item: int(item[0]))
            ),
            "postWorkoutAnswerStatusCounts": dict(
                sorted(post_answer_counts.items())
            ),
            "performanceScoreCounts": dict(
                sorted(performance_counts.items(), key=lambda item: int(item[0]))
            ),
            "sessionRpeCounts": dict(
                sorted(session_rpe_counts.items(), key=lambda item: int(item[0]))
            ),
            "painImpactCounts": dict(sorted(pain_impact_counts.items())),
            "legacySessionPlannedCounts": dict(
                sorted(legacy_planned_counts.items(), key=lambda item: int(item[0]))
            ),
            "legacySessionFeelCounts": dict(
                sorted(legacy_feel_counts.items(), key=lambda item: int(item[0]))
            ),
        },
        "exerciseAggregates": retained_exercises,
        "exerciseAggregateCompaction": {
            "totalCount": len(ranked_exercises),
            "retainedCount": len(retained_exercises),
            "omittedCount": len(ranked_exercises) - len(retained_exercises),
            "allExerciseIdsSha256": canonical_string_list_sha256(
                sorted(item["exerciseId"] for item in ranked_exercises)
            ),
        },
        "sessionSamples": retained_samples,
        "sessionSampleCompaction": {
            "selection": "newest_two_plus_most_adverse_plus_oldest_v1",
            "totalCount": len(session_samples),
            "retainedCount": len(retained_samples),
            "omittedCount": len(session_samples) - len(retained_samples),
        },
        "missingness": {
            "missingSourceSessionCount": len(missing_ids),
            "sessionFeedback": (
                "available"
                if post_answer_counts.get("reported", 0)
                else "not_collected"
            ),
            "loggedWork": (
                "available" if logged_set_count else "not_collected"
            ),
        },
    }
    return digest, missing_ids

def build_memory_source_packet(
    facts: SnapshotFacts,
    plan: MemoryCandidatePlan,
    exercises: dict[str, dict[str, Any]],
    sets_by_session: dict[str, list[dict[str, Any]]],
    briefing_packet: dict[str, Any],
    summary_pool: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    workout_session_ids: set[str] = set()
    note_ids: set[str] = set()
    summary_ids: set[str] = set()
    projections: dict[str, dict[str, Any]] = {}
    for candidate in plan.candidates:
        expected = candidate["expected"]
        candidate_id = expected["id"]
        projection = candidate_prompt_source_projection(candidate)
        projections[candidate_id] = projection
        if expected["memoryType"] == "workout":
            workout_session_ids.update(projection["sourceSessionIds"])
        note_ids.update(projection["allowedSourceNoteIds"])
        summary_ids.update(projection["sourceSummaryIds"])
    briefing_sessions = {
        item["sourceSessionId"]: item
        for item in briefing_packet["recentSessionEpisodes"]
    }
    briefing_context_items = []
    context = briefing_packet["safetyAndUserContext"]
    if context["currentContext"] is not None:
        briefing_context_items.append(context["currentContext"])
    briefing_context_items.extend(context["safetyEvents"])
    briefing_context_items.extend(context["recentGeneralNotes"])
    briefing_note_ids = {
        item.get("sourceNoteId")
        for item in briefing_context_items
        if isinstance(item.get("sourceNoteId"), str)
    }
    briefing_summaries = {
        item["sourceSummaryId"]: item
        for item in briefing_packet["olderPeriodicSummaries"]
    }
    sessions_by_id = {
        bounded_source_id(item.get("id"), "workoutSession.id"): item
        for item in facts.completed_workouts
    }
    notes_by_id = {
        bounded_source_id(item.get("id"), "AI note id"): item
        for item in facts.ai_notes
    }
    source_episodes = []
    referenced_briefing_story_ids: set[str] = set()
    referenced_briefing_evidence_ids: set[str] = set()
    missing_source_ids: list[str] = []
    for source_id in sorted(workout_session_ids):
        if source_id in briefing_sessions:
            referenced_briefing_story_ids.add(
                briefing_sessions[source_id]["sourceStoryId"]
            )
        elif source_id in sessions_by_id:
            source_episodes.append(
                build_session_episode(
                    facts, sessions_by_id[source_id], exercises, sets_by_session
                )
            )
        else:
            missing_source_ids.append(source_id)
    source_notes = []
    for source_id in sorted(note_ids):
        if source_id in briefing_note_ids:
            for item in briefing_context_items:
                if item.get("sourceNoteId") == source_id:
                    referenced_briefing_evidence_ids.add(item["evidenceId"])
                    break
        elif source_id in notes_by_id:
            raw = notes_by_id[source_id]
            created_at = require_epoch_ms(
                raw.get("createdAt"), f"AI note {source_id}.createdAt"
            )
            parsed_updated_at = (
                require_epoch_ms(
                    raw.get("updatedAt"), f"AI note {source_id}.updatedAt"
                )
                if finite_number(raw.get("updatedAt"))
                else created_at
            )
            updated_at = max(created_at, parsed_updated_at)
            content_observed_at = updated_at
            full_body = require_string(
                raw.get("body"), f"AI note {source_id}.body"
            )
            safety_match = SAFETY_CONTEXT_RE.search(full_body) is not None
            unresolved_red_flag = has_unresolved_red_flag(full_body)
            body, body_truncation = text_excerpt(
                full_body,
                NOTE_EXCERPT_MAX_CHARS,
                focus_re=(
                    REST_RED_FLAG_RE
                    if unresolved_red_flag
                    else SAFETY_CONTEXT_RE
                    if safety_match
                    else None
                ),
            )
            source_notes.append(
                {
                    "evidenceId": evidence_id("note", source_id),
                    "sourceStoryId": evidence_id("story", "note", source_id),
                    "domain": "user_context",
                    "sourceIds": [source_id],
                    "sourceNoteId": source_id,
                    "createdAt": created_at,
                    "updatedAt": updated_at,
                    "observedAt": content_observed_at,
                    "observedDate": pacific_date_for_epoch(content_observed_at),
                    "timestampMeaning": "note_content_updated_at",
                    "body": body,
                    "bodyTruncation": body_truncation,
                    "retrievalSafetyMatch": safety_match,
                    "unresolvedRedFlag": unresolved_red_flag,
                }
            )
        else:
            missing_source_ids.append(source_id)
    source_summaries = []
    pending_candidate_ids = {
        candidate["expected"]["id"] for candidate in plan.candidates
    }
    pending_candidate_source_ids = []
    for source_id in sorted(summary_ids):
        if source_id in briefing_summaries:
            referenced_briefing_evidence_ids.add(
                briefing_summaries[source_id]["evidenceId"]
            )
        elif source_id in summary_pool:
            source_summaries.append(
                compact_memory_source_summary(summary_pool[source_id])
            )
        elif source_id in pending_candidate_ids:
            pending_candidate_source_ids.append(source_id)
        else:
            missing_source_ids.append(source_id)
    if missing_source_ids:
        raise ConfigError(
            "Memory candidate plan references unavailable sources: "
            + ", ".join(sorted(set(missing_source_ids)))
        )
    periodic_digests = []
    for candidate in plan.candidates:
        if not candidate["periodic"]:
            continue
        candidate_id = candidate["expected"]["id"]
        digest, digest_missing_ids = build_periodic_candidate_digest(
            candidate,
            projections[candidate_id],
            sessions_by_id,
            exercises,
            sets_by_session,
        )
        if digest_missing_ids:
            raise ConfigError(
                "Memory candidate plan references unavailable sources: "
                + ", ".join(sorted(set(digest_missing_ids)))
            )
        periodic_digests.append(digest)
    return {
        "schemaVersion": MEMORY_SOURCE_PACKET_VERSION,
        "snapshotUpdatedAt": facts.updated_at,
        "memoryState": {
            "paused": plan.trusted_state["paused"],
            "windowStartedAt": plan.trusted_state["windowStartedAt"],
            "fourMonthStartedAt": plan.trusted_state["fourMonthStartedAt"],
        },
        "briefingSourceStoryReferences": sorted(referenced_briefing_story_ids),
        "briefingEvidenceReferences": sorted(referenced_briefing_evidence_ids),
        "sessionEpisodes": source_episodes,
        "periodicCandidateDigests": periodic_digests,
        "sourceNotes": source_notes,
        "sourceSummaries": source_summaries,
        "pendingCandidateSourceIds": pending_candidate_source_ids,
        "missingness": {
            "missingSourceIds": [],
            "workoutCandidateBacklogCount": plan.workout_backlog_count,
        },
    }

def exposure_domain_evidence(
    exposure: dict[str, Any],
    recent_episodes_by_session: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    if exposure.get("representation") == "recent_episode_reference":
        episode = recent_episodes_by_session.get(exposure["sourceSessionId"])
        if episode is not None:
            return episode["domainEvidence"]
        return {}
    domains = exposure.get("domainEvidence")
    return domains if isinstance(domains, dict) else {}

def evidence_atom_id(atom: Any) -> str | None:
    if isinstance(atom, dict) and isinstance(atom.get("evidenceId"), str):
        return atom["evidenceId"]
    return None

def build_mode_evidence_contract(
    briefing_packet: dict[str, Any],
    recent_episodes_by_session: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    rest_ids: set[str] = set()
    light_adverse_ids: set[str] = set()
    secondary_adverse_ids: set[str] = set()
    recent_pain_ids: set[str] = set()
    direct_current_adverse_ids: set[str] = set()

    def classify_domains(domains: dict[str, Any], *, recent: bool) -> None:
        if not recent:
            return
        subjective_state = domains.get("subjectiveState")
        subjective_outcome = domains.get("subjectiveOutcome")
        internal_response = domains.get("internalResponse")
        safety = domains.get("safety")
        # A completed session's PRS is calibration context for the work that
        # followed it, not evidence of the user's state today. Only the
        # current resumable-session PRS is mode-eligible below.
        if isinstance(subjective_outcome, dict):
            performance = subjective_outcome.get("values", {}).get("performance")
            atom_id = evidence_atom_id(subjective_outcome)
            if isinstance(performance, int) and performance <= 2 and atom_id is not None:
                light_adverse_ids.add(atom_id)
        else:
            performance = None
        material_pain = False
        if isinstance(safety, dict):
            pain_impact = safety.get("values", {}).get("painImpact")
            atom_id = evidence_atom_id(safety)
            if pain_impact in {"modified", "stopped"} and atom_id:
                material_pain = True
                light_adverse_ids.add(atom_id)
                secondary_adverse_ids.add(atom_id)
                recent_pain_ids.add(atom_id)
            elif pain_impact == "present_no_effect" and atom_id:
                # Still blocks progression conservatively, but does not by
                # itself justify reducing or skipping a later workout.
                recent_pain_ids.add(atom_id)
            if pain_impact == "stopped" and atom_id:
                rest_ids.add(atom_id)
        if isinstance(internal_response, dict):
            session_rpe = internal_response.get("values", {}).get("sessionRpe")
            atom_id = evidence_atom_id(internal_response)
            if (
                isinstance(session_rpe, int)
                and session_rpe >= 9
                and atom_id is not None
                and (
                    isinstance(performance, int)
                    and performance <= 2
                    or material_pain
                )
            ):
                light_adverse_ids.add(atom_id)
                secondary_adverse_ids.add(atom_id)

    for episode in briefing_packet["recentSessionEpisodes"]:
        classify_domains(
            episode["domainEvidence"],
            recent=observed_within_recent_window(
                episode.get("observedAt"), briefing_packet["today"]
            ),
        )
    for movement in briefing_packet["comparableMovementExposures"]:
        for exposure in movement["exposures"]:
            classify_domains(
                exposure_domain_evidence(exposure, recent_episodes_by_session),
                recent=observed_within_recent_window(
                    exposure.get("observedAt"), briefing_packet["today"]
                ),
            )

    current_state = briefing_packet["currentProgrammedSession"].get(
        "currentSubjectiveState"
    )
    if isinstance(current_state, dict):
        current_score = current_state.get("values", {}).get("perceivedRecovery")
        current_state_id = evidence_atom_id(current_state)
        if (
            isinstance(current_score, int)
            and current_score <= 3
            and current_state_id is not None
        ):
            light_adverse_ids.add(current_state_id)
            secondary_adverse_ids.add(current_state_id)
            direct_current_adverse_ids.add(current_state_id)

    context = briefing_packet["safetyAndUserContext"]
    context_items = [
        context.get("currentContext"),
        *context.get("safetyEvents", []),
        *context.get("recentGeneralNotes", []),
    ]
    for item in context_items:
        if not isinstance(item, dict) or not item.get("unresolvedRedFlag"):
            continue
        is_persistent_context = item is context.get("currentContext")
        is_same_day_note = (
            isinstance(item.get("sourceNoteId"), str)
            and item.get("observedDate") == briefing_packet["today"]
        )
        if not is_persistent_context and not is_same_day_note:
            continue
        atom_id = evidence_atom_id(item)
        if atom_id is None and isinstance(item.get("sourceEvidenceId"), str):
            atom_id = item["sourceEvidenceId"]
        if atom_id is not None:
            rest_ids.add(atom_id)
            light_adverse_ids.add(atom_id)
            secondary_adverse_ids.add(atom_id)

    push_groups: list[frozenset[str]] = []
    push_blockers = set(rest_ids) | recent_pain_ids | direct_current_adverse_ids
    decline_groups: list[frozenset[str]] = []
    for movement in briefing_packet["comparableMovementExposures"]:
        eligible_push: list[tuple[str, str, float]] = []
        eligible_decline: list[tuple[str, str, float]] = []
        for exposure in movement["exposures"]:
            work_id = exposure.get("evidenceId") or exposure.get(
                "sourceWorkEvidenceId"
            )
            story_id = exposure.get("sourceStoryId")
            if not isinstance(work_id, str) or not isinstance(story_id, str):
                continue
            domains = exposure_domain_evidence(
                exposure, recent_episodes_by_session
            )
            outcome = domains.get("subjectiveOutcome")
            safety = domains.get("safety")
            performance = (
                outcome.get("values", {}).get("performance")
                if isinstance(outcome, dict)
                else None
            )
            pain_impact = (
                safety.get("values", {}).get("painImpact")
                if isinstance(safety, dict)
                else "none"
            )
            internal = domains.get("internalResponse")
            session_rpe = (
                internal.get("values", {}).get("sessionRpe")
                if isinstance(internal, dict)
                else None
            )
            recent_adverse = observed_within_recent_window(
                exposure.get("observedAt"), briefing_packet["today"]
            )
            if (
                recent_adverse
                and isinstance(performance, int)
                and performance <= 2
            ):
                outcome_id = evidence_atom_id(outcome)
                if outcome_id is not None:
                    push_blockers.add(outcome_id)
            if recent_adverse and pain_impact in {
                "present_no_effect",
                "modified",
                "stopped",
            }:
                safety_id = evidence_atom_id(safety)
                if safety_id is not None:
                    push_blockers.add(safety_id)
            if (
                recent_adverse
                and isinstance(session_rpe, int)
                and session_rpe >= 9
            ):
                internal_id = evidence_atom_id(internal)
                if internal_id is not None:
                    push_blockers.add(internal_id)
            completion = exposure.get("programCompletion")
            marker = exposure.get("performanceMarker")
            exact = (
                exposure.get("comparability")
                == "same_exercise_same_target_rep_range"
            )
            progression_eligible = (
                isinstance(completion, dict)
                and completion.get("eligibleForProgressionTrend") is True
            )
            marker_value = (
                marker.get("value") if isinstance(marker, dict) else None
            )
            if not exact or not progression_eligible or not finite_number(marker_value):
                continue
            if not observed_within_recent_window(
                exposure.get("observedAt"),
                briefing_packet["today"],
                days=PERFORMANCE_COMPARATOR_WINDOW_DAYS,
            ):
                continue
            eligible_decline.append((work_id, story_id, float(marker_value)))
            if (
                isinstance(performance, int)
                and performance >= 3
                and pain_impact == "none"
                and not (isinstance(session_rpe, int) and session_rpe >= 9)
            ):
                eligible_push.append(
                    (work_id, story_id, float(marker_value))
                )
        distinct_push: list[tuple[str, str, float]] = []
        seen_push_stories: set[str] = set()
        for item in eligible_push:
            if item[1] not in seen_push_stories:
                distinct_push.append(item)
                seen_push_stories.add(item[1])
        if (
            len(distinct_push) >= 2
            and distinct_push[0][2] >= distinct_push[1][2]
        ):
            push_groups.append(
                frozenset(item[0] for item in distinct_push[:2])
            )
        distinct_decline: list[tuple[str, str, float]] = []
        seen_decline_stories: set[str] = set()
        for item in eligible_decline:
            if item[1] not in seen_decline_stories:
                distinct_decline.append(item)
                seen_decline_stories.add(item[1])
            if len(distinct_decline) == 3:
                break
        if (
            len(distinct_decline) == 3
            and distinct_decline[0][2] < distinct_decline[1][2]
            and distinct_decline[1][2] < distinct_decline[2][2]
            and distinct_decline[2][2] > 0
            and (
                (distinct_decline[2][2] - distinct_decline[0][2])
                / distinct_decline[2][2]
            )
            >= DELOAD_MIN_TOTAL_DECLINE_FRACTION
        ):
            decline_groups.append(
                frozenset(item[0] for item in distinct_decline)
            )
    return {
        "restEvidenceIds": frozenset(rest_ids),
        "lightAdverseEvidenceIds": frozenset(light_adverse_ids),
        "pushEvidenceGroups": tuple(push_groups),
        "pushBlockingEvidenceIds": frozenset(push_blockers),
        "deloadDeclineGroups": tuple(decline_groups),
        "deloadSecondaryAdverseEvidenceIds": frozenset(secondary_adverse_ids),
    }

def build_model_input_bundle(
    *,
    facts: SnapshotFacts,
    memory_body: Any,
    recovery: dict[str, Any],
    today: str,
    max_input_bytes: int = MODEL_INPUT_PACKET_MAX_BYTES,
) -> ModelInputBundle:
    if (
        not isinstance(max_input_bytes, int)
        or isinstance(max_input_bytes, bool)
        or max_input_bytes < 1
    ):
        raise ConfigError("Model input packet byte budget must be a positive integer")
    exercises = indexed_snapshot_rows(facts, "exercises")
    sets_by_session = canonical_sets_by_session(facts)
    original_plan = derive_memory_candidate_plan(facts, memory_body, today=today)
    selected_plan = original_plan
    deferral_reasons: dict[str, str] = {}

    current_plan = build_current_programmed_session(facts, exercises, today=today)
    recent_sessions = sorted(
        facts.completed_workouts,
        key=lambda row: (float(row.get("completedAt", 0)), str(row.get("id", ""))),
        reverse=True,
    )[:RECENT_SESSION_EPISODE_LIMIT]
    recent_episodes = [
        build_session_episode(facts, session, exercises, sets_by_session)
        for session in recent_sessions
    ]
    recent_episodes_by_session = {
        item["sourceSessionId"]: item for item in recent_episodes
    }
    comparable = build_comparable_exposures(
        facts,
        current_plan,
        exercises,
        sets_by_session,
        recent_episodes_by_session,
    )
    user_context = build_user_context(facts, original_plan)
    session_safety = build_session_safety_events(recent_episodes)
    user_context["safetyEvents"] = sorted(
        [*user_context["safetyEvents"], *session_safety],
        key=lambda item: (
            item.get("observedAt") or 0,
            item.get("evidenceId") or item.get("sourceEvidenceId") or "",
        ),
        reverse=True,
    )
    retained_session_ids = {item["sourceSessionId"] for item in recent_episodes}
    for movement in comparable:
        retained_session_ids.update(
            exposure["sourceSessionId"] for exposure in movement["exposures"]
        )
    recent_times = [item["observedAt"] for item in recent_episodes]
    oldest_recent = min(recent_times, default=None)
    summaries = memory_summary_pool(facts, original_plan.existing_items)
    older_summaries, eligible_summary_count = build_older_periodic_summaries(
        summaries, retained_session_ids, oldest_recent
    )
    briefing_packet = {
        "schemaVersion": BRIEFING_EVIDENCE_PACKET_VERSION,
        "snapshotUpdatedAt": facts.updated_at,
        "snapshotUpdatedDate": facts.updated_date.isoformat(),
        "today": today,
        "currentProgrammedSession": current_plan,
        "safetyAndUserContext": user_context,
        "freshRecoveryLane": build_recovery_lane(recovery),
        "recentSessionEpisodes": recent_episodes,
        "comparableMovementExposures": comparable,
        "olderPeriodicSummaries": older_summaries,
        "subjectiveSignalContradictions": [
            {
                "sourceIds": [item["sourceSessionId"]],
                "sourceStoryId": item["sourceStoryId"],
                "observedAt": item["observedAt"],
                "observedDate": item["observedDate"],
                "comparison": item["signalAlignment"]["comparison"],
                "status": "opposed",
                "values": item["signalAlignment"]["values"],
                "subjectiveStateEvidenceId": item["signalAlignment"][
                    "subjectiveStateEvidenceId"
                ],
                "subjectiveOutcomeEvidenceId": item["signalAlignment"][
                    "subjectiveOutcomeEvidenceId"
                ],
            }
            for item in recent_episodes
            if item["signalAlignment"]["status"] == "opposed"
        ],
        "selection": {
            "recentSessionEpisodeLimit": RECENT_SESSION_EPISODE_LIMIT,
            "comparableExposureLimitPerMovement": COMPARABLE_EXPOSURE_LIMIT,
            "olderSummaryLanePolicy": "recent_two_week_plus_older_four_month_v1",
            "modeEligibilityPolicy": {
                "recentAdverseWindowDaysInclusive": RECENT_ADVERSE_WINDOW_DAYS,
                "performanceComparatorWindowDaysInclusive": (
                    PERFORMANCE_COMPARATOR_WINDOW_DAYS
                ),
                "deloadMinimumOldestToNewestDeclineFraction": (
                    DELOAD_MIN_TOTAL_DECLINE_FRACTION
                ),
            },
            "eligibleOlderPeriodicSummaryCount": eligible_summary_count,
            "retainedOlderPeriodicSummaryCount": len(older_summaries),
            "prunedComparatorCount": sum(
                item["prunedExposureCount"] for item in comparable
            ),
            "prunedOlderSummaryCount": max(
                0, eligible_summary_count - len(older_summaries)
            ),
            "prunedGeneralNoteCount": user_context["omittedOlderGeneralNoteCount"],
        },
    }
    supervisor_plan: list[dict[str, Any]] = []
    memory_packet: dict[str, Any] = {}

    def refresh_inputs() -> tuple[dict[str, Any], frozenset[str], int]:
        nonlocal memory_packet, supervisor_plan
        supervisor_plan = prompt_memory_candidate_plan(selected_plan)
        allowed = collect_evidence_ids(briefing_packet)
        briefing_packet["allowedEvidenceIds"] = sorted(allowed)
        memory_packet = build_memory_source_packet(
            facts,
            selected_plan,
            exercises,
            sets_by_session,
            briefing_packet,
            summaries,
        )
        inputs = {
            "briefingEvidencePacket": briefing_packet,
            "memorySourcePacket": memory_packet,
            "supervisorCandidatePlan": supervisor_plan,
        }
        return inputs, allowed, compact_json_bytes(inputs)

    inputs, allowed, total_bytes = refresh_inputs()
    while total_bytes > max_input_bytes:
        if briefing_packet["olderPeriodicSummaries"]:
            retained_summaries = briefing_packet["olderPeriodicSummaries"]
            newest_by_type = {
                memory_type: max(
                    (
                        item
                        for item in retained_summaries
                        if item["memoryType"] == memory_type
                    ),
                    key=lambda item: (item["periodEndAt"], item["evidenceId"]),
                    default=None,
                )
                for memory_type in ("two_week", "four_month")
            }
            protected_ids = {
                item["evidenceId"]
                for item in newest_by_type.values()
                if item is not None
            }
            removable = [
                item
                for item in retained_summaries
                if item["evidenceId"] not in protected_ids
            ]
            pool = removable or retained_summaries
            oldest = min(
                pool, key=lambda item: (item["periodEndAt"], item["evidenceId"])
            )
            retained_summaries.remove(oldest)
            briefing_packet["selection"]["retainedOlderPeriodicSummaryCount"] = len(
                retained_summaries
            )
            briefing_packet["selection"]["prunedOlderSummaryCount"] += 1
        else:
            periodic_candidates = [
                candidate
                for candidate in selected_plan.candidates
                if candidate["periodic"]
            ]
            workout_candidates = [
                candidate
                for candidate in selected_plan.candidates
                if candidate["expected"]["memoryType"] == "workout"
            ]
            protect_periodic_for_liveness = (
                bool(periodic_candidates)
                and not workout_candidates
                and selected_plan.workout_backlog_count == 0
            )
            if periodic_candidates and not protect_periodic_for_liveness:
                target = periodic_candidates[-1]
                prior_ids = set(selected_plan.deferred_candidate_ids)
                selected_plan = defer_memory_candidate(
                    selected_plan, target["expected"]["id"]
                )
                for item_id in selected_plan.deferred_candidate_ids:
                    if item_id not in prior_ids:
                        deferral_reasons[item_id] = "input_budget"
            elif workout_candidates:
                target = workout_candidates[-1]
                selected_plan = defer_memory_candidate(
                    selected_plan, target["expected"]["id"]
                )
                deferral_reasons[target["expected"]["id"]] = "input_budget"
            else:
                protected_comparator_ids: set[str] = set()
                if periodic_candidates:
                    # Memory maintenance must not erase the only retained
                    # same-movement observation for today's decision. Prefer
                    # an exact-target exposure when one is available.
                    for movement in comparable:
                        exact = [
                            item
                            for item in movement["exposures"]
                            if item.get("comparability")
                            == "same_exercise_same_target_rep_range"
                        ]
                        pool = exact or movement["exposures"]
                        if not pool:
                            continue
                        protected = max(
                            pool,
                            key=lambda item: (
                                item.get("observedAt") or 0,
                                item.get("evidenceId")
                                or item.get("sourceWorkEvidenceId")
                                or "",
                            ),
                        )
                        protected_id = protected.get(
                            "evidenceId"
                        ) or protected.get("sourceWorkEvidenceId")
                        if isinstance(protected_id, str):
                            protected_comparator_ids.add(protected_id)
                exposure_locations = [
                    (
                        exposure["observedAt"],
                        exposure.get("evidenceId")
                        or exposure.get("sourceWorkEvidenceId")
                        or "",
                        movement,
                    )
                    for movement in comparable
                    for exposure in movement["exposures"]
                    if (
                        exposure.get("evidenceId")
                        or exposure.get("sourceWorkEvidenceId")
                        or ""
                    )
                    not in protected_comparator_ids
                ]
                if exposure_locations:
                    _, oldest_id, movement = min(
                        exposure_locations, key=lambda item: (item[0], item[1])
                    )
                    removed_exposure = next(
                        item
                        for item in movement["exposures"]
                        if (
                            item.get("evidenceId")
                            or item.get("sourceWorkEvidenceId")
                        )
                        == oldest_id
                    )
                    movement["exposures"] = [
                        item
                        for item in movement["exposures"]
                        if (
                            item.get("evidenceId")
                            or item.get("sourceWorkEvidenceId")
                        )
                        != oldest_id
                    ]
                    movement["retainedExposureCount"] = len(
                        movement["exposures"]
                    )
                    movement["retainedComparableExposureCount"] = sum(
                        1
                        for item in movement["exposures"]
                        if item["comparability"]
                        == "same_exercise_same_target_rep_range"
                    )
                    movement["prunedExposureCount"] += 1
                    if (
                        removed_exposure["comparability"]
                        == "same_exercise_same_target_rep_range"
                    ):
                        movement["prunedComparableExposureCount"] += 1
                    else:
                        movement["excludedNonComparableExposureCount"] += 1
                    movement["missingness"] = "budget_pruned"
                    briefing_packet["selection"]["prunedComparatorCount"] += 1
                elif briefing_packet["safetyAndUserContext"]["recentGeneralNotes"]:
                    general = briefing_packet["safetyAndUserContext"][
                        "recentGeneralNotes"
                    ]
                    oldest = min(
                        general,
                        key=lambda item: (item["observedAt"], item["evidenceId"]),
                    )
                    general.remove(oldest)
                    briefing_packet["selection"]["prunedGeneralNoteCount"] += 1
                elif periodic_candidates:
                    target = periodic_candidates[-1]
                    prior_ids = set(selected_plan.deferred_candidate_ids)
                    selected_plan = defer_memory_candidate(
                        selected_plan, target["expected"]["id"]
                    )
                    for item_id in selected_plan.deferred_candidate_ids:
                        if item_id not in prior_ids:
                            deferral_reasons[item_id] = "input_budget"
                else:
                    raise ConfigError(
                        "Mandatory safety, current-plan, compact recent-session, and "
                        f"recovery data require {total_bytes} bytes, exceeding the "
                        f"{max_input_bytes}-byte model input budget"
                    )
        inputs, allowed, total_bytes = refresh_inputs()

    original_candidate_types = {
        candidate["expected"]["id"]: candidate["expected"]["memoryType"]
        for candidate in original_plan.candidates
    }
    selected_candidate_types = [item["memoryType"] for item in supervisor_plan]
    deferred_candidate_ids = list(selected_plan.deferred_candidate_ids)
    deferred_workout_count = sum(
        1
        for item_id in deferred_candidate_ids
        if original_candidate_types.get(item_id) == "workout"
    )
    deferred_periodic_count = len(deferred_candidate_ids) - deferred_workout_count
    telemetry = {
        "packetSchemaVersion": BRIEFING_EVIDENCE_PACKET_VERSION,
        "memoryPacketSchemaVersion": MEMORY_SOURCE_PACKET_VERSION,
        "maxInputBytes": max_input_bytes,
        "briefingPacketBytes": compact_json_bytes(briefing_packet),
        "memorySourcePacketBytes": compact_json_bytes(memory_packet),
        "supervisorPlanBytes": compact_json_bytes(supervisor_plan),
        "totalInputBytes": total_bytes,
        "inputBudgetRemainingBytes": max_input_bytes - total_bytes,
        "retainedRecentEpisodeCount": len(recent_episodes),
        "retainedComparatorCount": sum(
            len(item["exposures"]) for item in comparable
        ),
        "retainedOlderSummaryCount": len(briefing_packet["olderPeriodicSummaries"]),
        "prunedComparatorCount": briefing_packet["selection"]["prunedComparatorCount"],
        "prunedOlderSummaryCount": briefing_packet["selection"]["prunedOlderSummaryCount"],
        "prunedGeneralNoteCount": briefing_packet["selection"]["prunedGeneralNoteCount"],
        "allowedEvidenceIdCount": len(allowed),
        "allowedEvidenceIdsSha256": canonical_string_list_sha256(
            sorted(allowed)
        ),
        "selectedMemoryCandidateCount": len(supervisor_plan),
        "selectedMemoryWorkoutCandidateCount": selected_candidate_types.count(
            "workout"
        ),
        "selectedMemoryPeriodicCandidateCount": sum(
            selected_candidate_types.count(item)
            for item in ("two_week", "four_month")
        ),
        "deferredMemoryCandidateIds": deferred_candidate_ids,
        "deferredMemoryCandidateReasons": {
            item_id: deferral_reasons[item_id]
            for item_id in deferred_candidate_ids
        },
        "deferredMemoryWorkoutCandidateCount": deferred_workout_count,
        "deferredMemoryPeriodicCandidateCount": deferred_periodic_count,
        "memoryWorkoutCandidateCount": selected_candidate_types.count("workout"),
        "memoryWorkoutBacklogCount": selected_plan.workout_backlog_count,
    }
    safety_context = briefing_packet["safetyAndUserContext"]
    safety_ids = {
        item["evidenceId"]
        for item in safety_context["safetyEvents"]
        if isinstance(item.get("evidenceId"), str)
    }
    safety_ids.update(
        item["sourceEvidenceId"]
        for item in safety_context["safetyEvents"]
        if isinstance(item.get("sourceEvidenceId"), str)
    )
    current_context = safety_context.get("currentContext")
    if isinstance(current_context, dict) and current_context.get(
        "retrievalSafetyMatch"
    ):
        safety_ids.add(current_context["evidenceId"])
    external_work_ids = {
        work["evidenceId"]
        for episode in briefing_packet["recentSessionEpisodes"]
        for work in episode["loggedWork"]
    }
    for movement in briefing_packet["comparableMovementExposures"]:
        for exposure in movement["exposures"]:
            source_work_id = exposure.get("evidenceId") or exposure.get(
                "sourceWorkEvidenceId"
            )
            if isinstance(source_work_id, str):
                external_work_ids.add(source_work_id)
    recovery_id = briefing_packet["freshRecoveryLane"].get("evidenceId")
    recovery_ids = (
        frozenset({recovery_id}) if isinstance(recovery_id, str) else frozenset()
    )
    mode_contract = build_mode_evidence_contract(
        briefing_packet, recent_episodes_by_session
    )
    evidence_stories, evidence_domains = collect_evidence_provenance(
        briefing_packet
    )
    return ModelInputBundle(
        inputs=inputs,
        telemetry=telemetry,
        allowed_evidence_ids=allowed,
        safety_evidence_ids=frozenset(safety_ids),
        external_work_evidence_ids=frozenset(external_work_ids),
        recovery_evidence_ids=recovery_ids,
        memory_candidate_plan=selected_plan,
        rest_evidence_ids=mode_contract["restEvidenceIds"],
        light_adverse_evidence_ids=mode_contract["lightAdverseEvidenceIds"],
        push_evidence_groups=mode_contract["pushEvidenceGroups"],
        push_blocking_evidence_ids=mode_contract["pushBlockingEvidenceIds"],
        deload_decline_groups=mode_contract["deloadDeclineGroups"],
        deload_secondary_adverse_evidence_ids=mode_contract[
            "deloadSecondaryAdverseEvidenceIds"
        ],
        evidence_source_story_ids=evidence_stories,
        evidence_domains=evidence_domains,
    )

def model_prompt_telemetry(
    prompt: str,
    bundle: ModelInputBundle,
    *,
    max_prompt_bytes: int = MODEL_PROMPT_MAX_BYTES,
) -> dict[str, Any]:
    prompt_bytes = len(prompt.encode("utf-8"))
    return {
        **bundle.telemetry,
        "promptBytes": prompt_bytes,
        "promptMaxBytes": max_prompt_bytes,
        "promptBudgetRemainingBytes": max_prompt_bytes - prompt_bytes,
    }
