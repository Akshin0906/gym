"""Trusted memory state, candidate derivation, and period advancement."""

from __future__ import annotations

import dataclasses
from typing import Any

from .errors import ConfigError
from .constants import (
    FOUR_MONTH_ROLLUP_PERIOD_COUNT,
    MAX_MEMORY_NOTES_PER_CANDIDATE,
    MAX_MEMORY_SESSION_SOURCES_PER_CANDIDATE,
    MAX_MEMORY_SUMMARY_SOURCES_PER_CANDIDATE,
    MAX_PERIODIC_MEMORY_NOTES_PER_CANDIDATE,
    MAX_SAFE_INTEGER,
    MAX_WORKOUT_MEMORY_CANDIDATES,
    TWO_WEEK_PERIOD_DAYS,
)
from .primitives import (
    add_calendar_days_ms,
    add_calendar_months_ms,
    add_four_month_rollup_ms,
    finite_number,
    pacific_date_start_ms,
    pacific_day_start_ms,
    require_bounded_string,
    require_epoch_ms,
    require_object,
    require_string,
)
from .models import (
    MemoryCandidatePlan,
    SnapshotFacts,
)
from .textutil import (
    compact_source_ids,
    optional_text,
)

def canonical_completed_sessions(facts: SnapshotFacts) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in facts.completed_workouts:
        session_id = require_bounded_string(
            raw.get("id"), "completed workout id", 172
        )
        if session_id in seen:
            raise ConfigError(f"Cloud snapshot has duplicate workout id: {session_id}")
        seen.add(session_id)
        completed_at = require_epoch_ms(
            raw.get("completedAt"), f"workout {session_id}.completedAt"
        )
        started_raw = raw.get("startedAt")
        started_at = (
            completed_at
            if started_raw is None
            else require_epoch_ms(started_raw, f"workout {session_id}.startedAt")
        )
        if started_at > completed_at:
            raise ConfigError(f"Workout {session_id} starts after it completes")
        result.append(
            {
                "id": session_id,
                "startedAt": started_at,
                "completedAt": completed_at,
            }
        )
    return sorted(result, key=lambda item: (item["completedAt"], item["id"]))

def canonical_ai_notes(facts: SnapshotFacts) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in facts.ai_notes:
        note_id = require_bounded_string(raw.get("id"), "AI note id", 180)
        if note_id in seen:
            raise ConfigError(f"Cloud snapshot has duplicate AI note id: {note_id}")
        seen.add(note_id)
        created_at = require_epoch_ms(raw.get("createdAt"), f"AI note {note_id}.createdAt")
        result.append({"id": note_id, "createdAt": created_at})
    return sorted(result, key=lambda item: (item["createdAt"], item["id"]))

def trusted_summary_records(
    facts: SnapshotFacts, existing_items: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}

    def add(raw: dict[str, Any], *, type_field: str, label: str) -> None:
        memory_type = raw.get(type_field)
        if memory_type not in {"two_week", "four_month"}:
            if label == "snapshot summary":
                raise ConfigError("Snapshot AI memory summary has an invalid period type")
            return
        item_id = require_bounded_string(raw.get("id"), f"{label} id", 180)
        start = require_epoch_ms(raw.get("periodStartAt"), f"{item_id}.periodStartAt")
        end = require_epoch_ms(raw.get("periodEndAt"), f"{item_id}.periodEndAt")
        if end <= start:
            raise ConfigError(f"{item_id} has a non-positive memory period")
        bullets = raw.get("bullets")
        has_usable_bullets = isinstance(bullets, list) and any(
            optional_text(item) is not None
            for item in bullets
            if isinstance(item, str)
        )
        updated_at = (
            float(raw["updatedAt"])
            if finite_number(raw.get("updatedAt"))
            else 0.0
        )
        record = {
            "id": item_id,
            "memoryType": memory_type,
            "periodStartAt": start,
            "periodEndAt": end,
            "_hasUsableBullets": has_usable_bullets,
            "_contentAuthorityUpdatedAt": updated_at,
            "_contentSourceStore": label,
        }
        prior = by_id.get(item_id)
        if prior is not None and (
            prior["memoryType"],
            prior["periodStartAt"],
            prior["periodEndAt"],
        ) != (memory_type, start, end):
            raise ConfigError(f"Conflicting trusted memory summary id: {item_id}")
        if (
            prior is None
            or updated_at > float(prior["_contentAuthorityUpdatedAt"])
            or (
                updated_at == float(prior["_contentAuthorityUpdatedAt"])
                and label == "cloud memory item"
            )
        ):
            by_id[item_id] = record

    for item in facts.ai_memory_summaries:
        add(item, type_field="periodType", label="snapshot summary")
    for item in existing_items:
        add(item, type_field="memoryType", label="cloud memory item")
    return sorted(
        by_id.values(),
        key=lambda item: (item["periodStartAt"], item["periodEndAt"], item["id"]),
    )

def trusted_memory_state(
    facts: SnapshotFacts,
    memory_envelope: dict[str, Any],
    sessions: list[dict[str, Any]],
    *,
    today: str,
) -> dict[str, Any]:
    def parse(raw: Any, label: str) -> dict[str, Any] | None:
        if raw is None:
            return None
        state = require_object(raw, label)
        current_context = require_string(
            state.get("currentContext"), f"{label}.currentContext", allow_empty=True
        )
        if not isinstance(state.get("paused"), bool):
            raise ConfigError(f"{label}.paused must be a boolean")
        return {
            "currentContext": current_context,
            "paused": state["paused"],
            "windowStartedAt": require_epoch_ms(
                state.get("windowStartedAt"), f"{label}.windowStartedAt"
            ),
            "fourMonthStartedAt": require_epoch_ms(
                state.get("fourMonthStartedAt"), f"{label}.fourMonthStartedAt"
            ),
        }

    if len(facts.ai_memory_settings) > 1:
        raise ConfigError("Cloud snapshot has multiple AI memory settings rows")
    snapshot_state: dict[str, Any] | None = None
    if facts.ai_memory_settings:
        settings = facts.ai_memory_settings[0]
        if require_string(settings.get("id"), "AI memory settings id") != "default":
            raise ConfigError("Cloud snapshot AI memory settings id must be default")
        snapshot_state = parse(settings, "snapshot AI memory state")
    cloud_state = parse(memory_envelope.get("state"), "cloud memory state")

    today_start = pacific_date_start_ms(today)
    candidates = [state for state in (snapshot_state, cloud_state) if state is not None]
    if candidates:
        for state in candidates:
            for field in ("windowStartedAt", "fourMonthStartedAt"):
                value = state[field]
                if pacific_day_start_ms(value) != value:
                    raise ConfigError(f"Trusted memory {field} is not a Pacific day boundary")
                if value > today_start:
                    raise ConfigError(f"Trusted memory {field} is in the future")
        window_started_at = max(state["windowStartedAt"] for state in candidates)
        four_month_started_at = max(
            state["fourMonthStartedAt"] for state in candidates
        )
    else:
        earliest = min((item["startedAt"] for item in sessions), default=today_start)
        window_started_at = pacific_day_start_ms(earliest)
        four_month_started_at = window_started_at

    owner = snapshot_state or cloud_state
    return {
        "currentContext": owner["currentContext"] if owner is not None else "",
        "paused": owner["paused"] if owner is not None else False,
        "windowStartedAt": window_started_at,
        "fourMonthStartedAt": four_month_started_at,
        "sourceSnapshotUpdatedAt": facts.updated_at,
    }

def derive_memory_candidate_plan(
    facts: SnapshotFacts,
    memory_body: Any,
    *,
    today: str,
) -> MemoryCandidatePlan:
    """Derive candidate identities and provenance without trusting model output."""
    memory_envelope = require_object(memory_body, "memory response")
    revision = memory_envelope.get("revision")
    if (
        not isinstance(revision, int)
        or isinstance(revision, bool)
        or revision < 0
        or revision >= MAX_SAFE_INTEGER
    ):
        raise ConfigError("Cloud memory response has an invalid revision")

    existing_items_raw = memory_envelope.get("items")
    if not isinstance(existing_items_raw, list):
        raise ConfigError("Cloud memory items must be an array")
    existing_items = [
        require_object(item, "existing memory item") for item in existing_items_raw
    ]
    existing_ids: set[str] = set()
    for item in existing_items:
        item_id = require_bounded_string(
            item.get("id"), "existing memory item id", 180
        )
        if item_id in existing_ids:
            raise ConfigError(f"Cloud memory has duplicate item id: {item_id}")
        existing_ids.add(item_id)

    sessions = canonical_completed_sessions(facts)
    notes = canonical_ai_notes(facts)
    summaries = trusted_summary_records(facts, existing_items)
    trusted_state = trusted_memory_state(
        facts, memory_envelope, sessions, today=today
    )
    candidates: list[dict[str, Any]] = []
    if trusted_state["paused"]:
        return MemoryCandidatePlan(
            revision=revision,
            existing_items=existing_items,
            existing_ids=existing_ids,
            trusted_state=trusted_state,
            candidates=candidates,
        )

    existing_workout_sources = {
        item.get("sourceWorkoutSessionId")
        for item in existing_items
        if item.get("memoryType") == "workout"
        and isinstance(item.get("sourceWorkoutSessionId"), str)
        and item.get("sourceWorkoutSessionId").strip()
    }
    missing_sessions = [
        session
        for session in sessions
        if session["id"] not in existing_workout_sources
    ]
    included_missing_sessions = missing_sessions[:MAX_WORKOUT_MEMORY_CANDIDATES]
    workout_backlog_count = len(missing_sessions) - len(included_missing_sessions)
    for session in included_missing_sessions:
        session_id = session["id"]
        session_note_ids = [
            note["id"]
            for note in notes
            if session["startedAt"] <= note["createdAt"] <= session["completedAt"]
        ]
        retained_session_note_ids = session_note_ids[-MAX_MEMORY_NOTES_PER_CANDIDATE:]
        candidates.append(
            {
                "expected": {
                    "id": f"workout:{session_id}",
                    "memoryType": "workout",
                    "periodStartAt": session["startedAt"],
                    "periodEndAt": session["completedAt"],
                    "sourceWorkoutSessionId": session_id,
                    "sourceSessionIds": [session_id],
                    "sourceNoteIds": [],
                    "sourceSummaryIds": [],
                },
                "allowedNoteIds": retained_session_note_ids,
                "omittedAllowedNoteCount": (
                    len(session_note_ids) - len(retained_session_note_ids)
                ),
                "periodic": False,
                "dependsOn": [],
                "cursorField": None,
                "cursorValue": None,
            }
        )

    today_start = pacific_date_start_ms(today)
    periods = {
        (item["memoryType"], item["periodStartAt"], item["periodEndAt"])
        for item in summaries
    }
    planned_summary_ids: set[str] = set()

    two_week_start = advance_existing_periods(
        trusted_state["windowStartedAt"],
        memory_type="two_week",
        today_start=today_start,
        periods=periods,
    )
    trusted_state["windowStartedAt"] = two_week_start
    two_week_end = add_calendar_days_ms(two_week_start, TWO_WEEK_PERIOD_DAYS)
    projected_two_week_cursor = two_week_start
    if two_week_end <= today_start:
        source_sessions = [
            item["id"]
            for item in sessions
            if two_week_start <= item["completedAt"] < two_week_end
        ]
        source_notes = [
            item["id"]
            for item in notes
            if two_week_start <= item["createdAt"] < two_week_end
        ]
        retained_source_notes = source_notes[-MAX_MEMORY_NOTES_PER_CANDIDATE:]
        item_id = f"two_week:{two_week_start}:{two_week_end}"
        expected = {
            "id": item_id,
            "memoryType": "two_week",
            "periodStartAt": two_week_start,
            "periodEndAt": two_week_end,
            "sourceWorkoutSessionId": None,
            "sourceSessionIds": source_sessions,
            "sourceNoteIds": source_notes,
            "sourceSummaryIds": [],
        }
        candidates.append(
            {
                "expected": expected,
                "allowedNoteIds": retained_source_notes,
                "omittedAllowedNoteCount": (
                    len(source_notes) - len(retained_source_notes)
                ),
                "periodic": True,
                "dependsOn": [],
                "cursorField": "windowStartedAt",
                "cursorValue": two_week_end,
            }
        )
        summaries.append(
            {
                "id": item_id,
                "memoryType": "two_week",
                "periodStartAt": two_week_start,
                "periodEndAt": two_week_end,
                "_hasUsableBullets": True,
                "_contentAuthorityUpdatedAt": float(facts.updated_at),
                "_contentSourceStore": "planned candidate",
            }
        )
        planned_summary_ids.add(item_id)
        projected_two_week_cursor = two_week_end

    four_month_cursor = advance_existing_periods(
        trusted_state["fourMonthStartedAt"],
        memory_type="four_month",
        today_start=today_start,
        periods=periods,
    )
    trusted_state["fourMonthStartedAt"] = four_month_cursor
    summaries_by_period: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for summary in summaries:
        if (
            summary["memoryType"] != "two_week"
            or summary.get("_hasUsableBullets") is not True
            or summary["periodEndAt"]
            != add_calendar_days_ms(
                summary["periodStartAt"], TWO_WEEK_PERIOD_DAYS
            )
        ):
            continue
        summaries_by_period.setdefault(
            (summary["periodStartAt"], summary["periodEndAt"]), []
        ).append(summary)
    period_representatives: dict[int, dict[str, Any]] = {}
    for (summary_start, summary_end), period_candidates in sorted(
        summaries_by_period.items()
    ):
        canonical_id = f"two_week:{summary_start}:{summary_end}"
        period_representatives[summary_start] = min(
            period_candidates,
            key=lambda item: (
                item["id"] not in planned_summary_ids,
                item["id"] != canonical_id,
                item["id"],
            ),
        )

    exact_start = period_representatives.get(four_month_cursor)
    crossing = [
        item
        for item in period_representatives.values()
        if item["periodStartAt"] < four_month_cursor < item["periodEndAt"]
    ]
    first_child = exact_start or (
        max(crossing, key=lambda item: item["periodStartAt"])
        if crossing
        else None
    )
    retained_summary_records: list[dict[str, Any]] = []
    if first_child is not None:
        next_start = first_child["periodStartAt"]
        for _ in range(FOUR_MONTH_ROLLUP_PERIOD_COUNT):
            child = period_representatives.get(next_start)
            if child is None:
                retained_summary_records = []
                break
            retained_summary_records.append(child)
            next_start = child["periodEndAt"]

    if len(retained_summary_records) == FOUR_MONTH_ROLLUP_PERIOD_COUNT:
        four_month_start = retained_summary_records[0]["periodStartAt"]
        four_month_end = retained_summary_records[-1]["periodEndAt"]
        if (
            four_month_end <= today_start
            and projected_two_week_cursor >= four_month_end
        ):
            source_summaries = [
                summary["id"] for summary in retained_summary_records
            ]
            if len(source_summaries) > MAX_MEMORY_SUMMARY_SOURCES_PER_CANDIDATE:
                raise ConfigError(
                    "Canonical four-month summary sources exceed their proven bound"
                )
            item_id = f"four_month:{four_month_start}:{four_month_end}"
            candidates.append(
                {
                    "expected": {
                        "id": item_id,
                        "memoryType": "four_month",
                        "periodStartAt": four_month_start,
                        "periodEndAt": four_month_end,
                        "sourceWorkoutSessionId": None,
                        "sourceSessionIds": [],
                        "sourceNoteIds": [],
                        "sourceSummaryIds": source_summaries,
                    },
                    "allowedNoteIds": None,
                    "omittedAllowedNoteCount": 0,
                    "periodic": True,
                    "dependsOn": [
                        summary_id
                        for summary_id in source_summaries
                        if summary_id in planned_summary_ids
                    ],
                    "cursorField": "fourMonthStartedAt",
                    "cursorValue": four_month_end,
                }
            )

    return MemoryCandidatePlan(
        revision=revision,
        existing_items=existing_items,
        existing_ids=existing_ids,
        trusted_state=trusted_state,
        candidates=candidates,
        workout_backlog_count=workout_backlog_count,
    )

def candidate_prompt_source_projection(
    candidate: dict[str, Any],
) -> dict[str, Any]:
    """Return the bounded provenance the model must echo for one candidate.

    The trusted candidate retains the complete canonical provenance. The model
    sees and returns only this deterministic projection; validation expands the
    projected ids back to the trusted complete lists before persistence.
    """
    expected = candidate["expected"]
    retained_sessions, session_compaction = compact_source_ids(
        expected["sourceSessionIds"],
        maximum=MAX_MEMORY_SESSION_SOURCES_PER_CANDIDATE,
        selection="newest_tail",
    )
    retained_summaries, summary_compaction = compact_source_ids(
        expected["sourceSummaryIds"],
        maximum=MAX_MEMORY_SUMMARY_SOURCES_PER_CANDIDATE,
        required=tuple(candidate["dependsOn"]),
        selection="newest_tail",
    )
    note_limit = (
        MAX_PERIODIC_MEMORY_NOTES_PER_CANDIDATE
        if candidate["periodic"]
        else MAX_MEMORY_NOTES_PER_CANDIDATE
    )
    retained_notes, note_compaction = compact_source_ids(
        candidate["allowedNoteIds"] or [],
        maximum=note_limit,
        selection="newest_tail",
    )
    return {
        "sourceSessionIds": retained_sessions,
        "sourceSessionIdCompaction": session_compaction,
        "sourceSummaryIds": retained_summaries,
        "sourceSummaryIdCompaction": summary_compaction,
        "allowedSourceNoteIds": retained_notes,
        "allowedSourceNoteIdCompaction": note_compaction,
    }

def prompt_memory_candidate_plan(plan: MemoryCandidatePlan) -> list[dict[str, Any]]:
    bullet_limits = {
        "workout": {"minimum": 1, "maximum": 3},
        "two_week": {"minimum": 1, "maximum": 1},
        "four_month": {"minimum": 2, "maximum": 2},
    }
    result: list[dict[str, Any]] = []
    for candidate in plan.candidates:
        expected = candidate["expected"]
        projection = candidate_prompt_source_projection(candidate)
        result.append(
            {
                "id": expected["id"],
                "memoryType": expected["memoryType"],
                "periodStartAt": expected["periodStartAt"],
                "periodEndAt": expected["periodEndAt"],
                "sourceWorkoutSessionId": expected["sourceWorkoutSessionId"],
                "sourceSessionIds": projection["sourceSessionIds"],
                "sourceSessionIdCompaction": projection[
                    "sourceSessionIdCompaction"
                ],
                "allowedSourceNoteIds": projection["allowedSourceNoteIds"],
                "allowedSourceNoteIdCompaction": projection[
                    "allowedSourceNoteIdCompaction"
                ],
                "omittedAllowedSourceNoteCount": candidate.get(
                    "omittedAllowedNoteCount", 0
                )
                + projection["allowedSourceNoteIdCompaction"]["omittedCount"],
                "sourceSummaryIds": projection["sourceSummaryIds"],
                "sourceSummaryIdCompaction": projection[
                    "sourceSummaryIdCompaction"
                ],
                "sourceProvenancePolicy": (
                    "model_returns_projection_supervisor_restores_canonical_v1"
                ),
                "requiredBulletCount": bullet_limits[expected["memoryType"]],
            }
        )
    return result

def defer_memory_candidate(
    plan: MemoryCandidatePlan, candidate_id: str
) -> MemoryCandidatePlan:
    selected_by_id = {
        candidate["expected"]["id"]: candidate for candidate in plan.candidates
    }
    if candidate_id not in selected_by_id:
        raise ConfigError(f"Cannot defer unknown memory candidate: {candidate_id}")
    deferred = {candidate_id}
    changed = True
    while changed:
        changed = False
        for candidate in plan.candidates:
            item_id = candidate["expected"]["id"]
            if item_id in deferred:
                continue
            if deferred.intersection(candidate["dependsOn"]):
                deferred.add(item_id)
                changed = True
    newly_deferred = [
        candidate["expected"]["id"]
        for candidate in plan.candidates
        if candidate["expected"]["id"] in deferred
    ]
    retained = [
        candidate
        for candidate in plan.candidates
        if candidate["expected"]["id"] not in deferred
    ]
    deferred_workout_count = sum(
        1
        for candidate in plan.candidates
        if candidate["expected"]["id"] in deferred
        and candidate["expected"]["memoryType"] == "workout"
    )
    return dataclasses.replace(
        plan,
        candidates=retained,
        workout_backlog_count=plan.workout_backlog_count + deferred_workout_count,
        deferred_candidate_ids=tuple(
            [*plan.deferred_candidate_ids, *newly_deferred]
        ),
    )

def advance_existing_periods(
    start: int,
    *,
    memory_type: str,
    today_start: int,
    periods: set[tuple[str, int, int]],
) -> int:
    for _ in range(10_000):
        if memory_type == "two_week":
            possible_ends = [
                add_calendar_days_ms(start, TWO_WEEK_PERIOD_DAYS)
            ]
        else:
            # Accept already-persisted calendar-four-month summaries while
            # generating new gap-free rollups from eight 14-day children.
            possible_ends = [
                add_four_month_rollup_ms(start),
                add_calendar_months_ms(start, 4),
            ]
        end = next(
            (
                candidate_end
                for candidate_end in possible_ends
                if candidate_end <= today_start
                and (memory_type, start, candidate_end) in periods
            ),
            None,
        )
        if end is None:
            return start
        start = end
    raise ConfigError(f"Too many existing {memory_type} memory periods")
