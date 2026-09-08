"""Contract validation for the cloud snapshot, model output, and spool."""

from __future__ import annotations

import datetime as dt
from typing import Any

from .errors import (
    ConfigError,
    WaitingError,
)
from .constants import (
    BRIEFING_EVIDENCE_PACKET_VERSION,
    BRIEFING_HEADLINE_MAX,
    BRIEFING_REASON_MAX,
    BRIEFING_RECOVERY_MAX,
    BRIEFING_TODAYS_CALL_MAX,
    BRIEFING_TREND_MAX,
    BRIEFING_WATCH_OUT_MAX,
    EVIDENCE_GUIDE_VERSION,
    MAX_SAFE_INTEGER,
    MODEL_WATCH_OUT_MAX,
    MODES,
    PACIFIC,
    PROMPT_VERSION,
    RECOVERY_DIAGNOSTIC_FIELDS,
    RECOVERY_FRESHNESS_POLICY,
    RECOVERY_STATUSES,
    RUNNER_VERSION,
    VALIDATOR_COMPATIBILITY_VERSION,
)
from .primitives import (
    finite_number,
    require_bounded_string,
    require_epoch_ms,
    require_object,
    require_string,
    require_unique_ids,
    string_list,
)
from .models import (
    ModelInputBundle,
    SnapshotFacts,
)
from .recovery import (
    is_model_sync_warning,
    parse_recovery_day,
    recovery_status_diagnostics,
    trusted_recovery_fingerprint,
    trusted_recovery_summary,
    trusted_snapshot_warning,
    valid_recovery_fingerprint,
)
from .evidence import build_model_input_bundle
from .memory import candidate_prompt_source_projection

def validate_snapshot(body: Any, today: dt.date) -> SnapshotFacts:
    envelope = require_object(body, "snapshot response")
    snapshot = require_object(envelope.get("snapshot"), "snapshot")
    try:
        updated_at = require_epoch_ms(snapshot.get("updatedAt"), "snapshot.updatedAt")
    except ConfigError as exc:
        raise WaitingError("Cloud snapshot is missing a valid updatedAt value") from exc
    payload = require_object(snapshot.get("payload"), "snapshot.payload")
    if not finite_number(payload.get("schemaVersion")):
        raise WaitingError("Cloud snapshot payload has no schemaVersion")
    data = require_object(payload.get("data"), "snapshot.payload.data")
    for name in (
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
        if not isinstance(data.get(name), list):
            raise WaitingError(f"Cloud snapshot is missing {name}")
    completed = [
        item
        for item in data["workoutSessions"]
        if isinstance(item, dict) and finite_number(item.get("completedAt"))
    ]
    if not completed:
        raise WaitingError("Cloud snapshot has no completed workouts")
    updated = dt.datetime.fromtimestamp(float(updated_at) / 1000.0, PACIFIC)
    age_days = (today - updated.date()).days
    if age_days > 7:
        raise WaitingError(
            f"Cloud snapshot last synced {updated.date().isoformat()}; open the app to sync"
        )
    if age_days < -1:
        raise ConfigError("Cloud snapshot timestamp is unexpectedly in the future")
    logged_sets = [item for item in data["loggedSets"] if isinstance(item, dict)]
    ai_memory_settings = [
        item for item in data["aiMemorySettings"] if isinstance(item, dict)
    ]
    ai_notes = [item for item in data["aiNotes"] if isinstance(item, dict)]
    ai_memory_summaries = [
        item for item in data["aiMemorySummaries"] if isinstance(item, dict)
    ]
    for name, items in (
        ("aiMemorySettings", ai_memory_settings),
        ("aiNotes", ai_notes),
        ("aiMemorySummaries", ai_memory_summaries),
    ):
        if len(items) != len(data[name]):
            raise ConfigError(f"Cloud snapshot {name} contains an invalid row")
    return SnapshotFacts(
        snapshot=snapshot,
        data=data,
        updated_at=updated_at,
        updated_date=updated.date(),
        completed_workouts=completed,
        logged_sets=logged_sets,
        ai_memory_settings=ai_memory_settings,
        ai_notes=ai_notes,
        ai_memory_summaries=ai_memory_summaries,
    )

def validate_memory_item(
    raw: Any,
    *,
    expected: dict[str, Any],
    snapshot_updated_at: int | float,
    generated_at: int,
    model: str,
    allowed_note_ids: list[str] | None = None,
    source_projection: dict[str, Any] | None = None,
) -> dict[str, Any]:
    item = require_object(raw, f"memory item {expected['id']}")
    expected_keys = {
        "id",
        "memoryType",
        "periodStartAt",
        "periodEndAt",
        "sourceWorkoutSessionId",
        "bullets",
        "sourceSessionIds",
        "sourceNoteIds",
        "sourceSummaryIds",
    }
    if set(item) != expected_keys:
        raise ConfigError(
            f"Memory item {expected['id']} must contain only candidate content fields"
        )
    item_id = require_string(item.get("id"), "memory item id")
    if item_id != expected["id"]:
        raise ConfigError(f"Unexpected memory item id: {item_id}")
    memory_type = item.get("memoryType")
    if memory_type != expected["memoryType"]:
        raise ConfigError(f"Memory item {item_id} has the wrong type")
    start = require_epoch_ms(item.get("periodStartAt"), f"{item_id}.periodStartAt")
    end = require_epoch_ms(item.get("periodEndAt"), f"{item_id}.periodEndAt")
    if (start, end) != (expected["periodStartAt"], expected["periodEndAt"]):
        raise ConfigError(f"Memory item {item_id} has a non-canonical period")

    bullets = string_list(item.get("bullets"), f"{item_id}.bullets")
    if any(len(bullet) > 500 for bullet in bullets):
        raise ConfigError(f"Memory item {item_id} bullets must be at most 500 characters")
    required_bullets = {"workout": (1, 3), "two_week": (1, 1), "four_month": (2, 2)}
    minimum, maximum = required_bullets[memory_type]
    if not minimum <= len(bullets) <= maximum:
        raise ConfigError(
            f"Memory item {item_id} must have {minimum}"
            + (f"-{maximum}" if minimum != maximum else "")
            + " bullets"
        )

    source_workout = item.get("sourceWorkoutSessionId")
    if source_workout != expected["sourceWorkoutSessionId"]:
        raise ConfigError(f"Memory item {item_id} has the wrong workout source")

    def exact_sources(field: str) -> list[str]:
        actual = require_unique_ids(item.get(field), f"{item_id}.{field}")
        canonical = expected[field]
        model_visible = (
            source_projection.get(field, canonical)
            if source_projection is not None
            else canonical
        )
        if set(actual) != set(model_visible):
            raise ConfigError(f"Memory item {item_id} has invalid {field}")
        return canonical

    source_session_ids = exact_sources("sourceSessionIds")
    source_summary_ids = exact_sources("sourceSummaryIds")
    if allowed_note_ids is None:
        source_note_ids = exact_sources("sourceNoteIds")
    else:
        actual_notes = require_unique_ids(
            item.get("sourceNoteIds"), f"{item_id}.sourceNoteIds"
        )
        allowed = set(allowed_note_ids)
        if not set(actual_notes).issubset(allowed):
            raise ConfigError(f"Memory item {item_id} references an unknown AI note")
        selected = set(actual_notes)
        source_note_ids = [note_id for note_id in allowed_note_ids if note_id in selected]

    return {
        "id": item_id,
        "memoryType": memory_type,
        "periodStartAt": expected["periodStartAt"],
        "periodEndAt": expected["periodEndAt"],
        "sourceWorkoutSessionId": expected["sourceWorkoutSessionId"],
        "bullets": bullets,
        "sourceSessionIds": source_session_ids,
        "sourceNoteIds": source_note_ids,
        "sourceSummaryIds": source_summary_ids,
        "model": model,
        "createdAt": generated_at,
        "updatedAt": generated_at,
        "snapshotUpdatedAt": snapshot_updated_at,
    }

def validate_model_output(
    raw: Any,
    *,
    facts: SnapshotFacts,
    memory_body: Any,
    recovery: dict[str, Any],
    today: str,
    run_id: str,
    prompt_hash: str,
    model: str,
    reasoning_effort: str,
    codex_version: str,
    generated_at: int | float,
    input_bundle: ModelInputBundle | None = None,
    packet_telemetry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not model.strip() or len(model.strip()) > 120:
        raise ConfigError("Configured Codex model name must be 1-120 characters")
    root = require_object(raw, "Codex output")
    if set(root) != {"briefing", "memory"}:
        raise ConfigError("Codex output must contain only briefing and memory")

    bundle = input_bundle or build_model_input_bundle(
        facts=facts,
        memory_body=memory_body,
        recovery=recovery,
        today=today,
    )
    plan = bundle.memory_candidate_plan
    expected_memory_revision = plan.revision
    existing_items = plan.existing_items

    memory_out = require_object(root.get("memory"), "memory")
    if set(memory_out) != {"newItems"}:
        raise ConfigError("memory must contain only newItems")

    new_items_raw = memory_out.get("newItems")
    if not isinstance(new_items_raw, list):
        raise ConfigError("memory.newItems must be an array")

    raw_by_id: dict[str, dict[str, Any]] = {}
    for raw_item in new_items_raw:
        item = require_object(raw_item, "memory item")
        item_id = require_string(item.get("id"), "memory item id")
        if item_id in plan.existing_ids:
            raise ConfigError(f"Codex returned existing memory item as new: {item_id}")
        if item_id in raw_by_id:
            raise ConfigError(f"Codex returned duplicate memory item: {item_id}")
        raw_by_id[item_id] = item

    generated_timestamp = require_epoch_ms(generated_at, "generated_at")
    trusted_state = dict(plan.trusted_state)
    new_items: list[dict[str, Any]] = []
    deferred_memory_item_ids: list[str] = list(plan.deferred_candidate_ids)
    satisfied_candidate_ids: set[str] = set()

    if trusted_state["paused"] and raw_by_id:
        raise ConfigError("Paused memory cannot add new items")
    if not trusted_state["paused"]:
        for candidate in plan.candidates:
            expected = candidate["expected"]
            item_id = expected["id"]
            raw_item = raw_by_id.pop(item_id, None)
            missing_dependencies = [
                dependency
                for dependency in candidate["dependsOn"]
                if dependency not in satisfied_candidate_ids
            ]
            if missing_dependencies:
                if raw_item is not None:
                    raise ConfigError(
                        f"Memory item {item_id} depends on a deferred summary"
                    )
                deferred_memory_item_ids.append(item_id)
                continue
            if raw_item is None:
                if candidate["periodic"]:
                    deferred_memory_item_ids.append(item_id)
                    continue
                raise ConfigError(f"Codex omitted required memory item: {item_id}")
            source_projection = candidate_prompt_source_projection(candidate)
            new_item = validate_memory_item(
                raw_item,
                expected=expected,
                snapshot_updated_at=facts.updated_at,
                generated_at=generated_timestamp,
                model=model,
                allowed_note_ids=source_projection["allowedSourceNoteIds"],
                source_projection=source_projection,
            )
            new_items.append(new_item)
            satisfied_candidate_ids.add(item_id)
            cursor_field = candidate["cursorField"]
            if cursor_field is not None:
                trusted_state[cursor_field] = candidate["cursorValue"]

    if raw_by_id:
        unexpected = ", ".join(sorted(raw_by_id))
        raise ConfigError(f"Codex returned unexpected memory items: {unexpected}")
    memory_payload = {
        "state": trusted_state,
        # The server upserts only supervisor-validated new items. Existing rows
        # are never resent, so an artifact cannot overwrite prior memory.
        "items": new_items,
    }

    briefing = require_object(root.get("briefing"), "briefing")
    if set(briefing) != {
        "headline",
        "mode",
        "sections",
        "supportingEvidenceIds",
        "contradictingEvidenceIds",
    }:
        raise ConfigError(
            "briefing must contain only headline, mode, sections, and evidence ids"
        )
    headline = require_bounded_string(
        briefing.get("headline"),
        "briefing.headline",
        BRIEFING_HEADLINE_MAX,
    )
    mode = briefing.get("mode")
    if mode not in MODES:
        raise ConfigError("briefing.mode is invalid")
    supporting_evidence_ids = require_unique_ids(
        briefing.get("supportingEvidenceIds"), "briefing.supportingEvidenceIds"
    )
    contradicting_evidence_ids = require_unique_ids(
        briefing.get("contradictingEvidenceIds"),
        "briefing.contradictingEvidenceIds",
    )
    if len(supporting_evidence_ids) > 4:
        raise ConfigError("briefing.supportingEvidenceIds must contain at most 4 ids")
    if len(contradicting_evidence_ids) > 2:
        raise ConfigError("briefing.contradictingEvidenceIds must contain at most 2 ids")
    overlap = set(supporting_evidence_ids).intersection(contradicting_evidence_ids)
    if overlap:
        raise ConfigError("Briefing evidence ids cannot both support and contradict")
    unknown_evidence_ids = (
        set(supporting_evidence_ids) | set(contradicting_evidence_ids)
    ).difference(bundle.allowed_evidence_ids)
    if unknown_evidence_ids:
        raise ConfigError(
            "Briefing references unknown evidence ids: "
            + ", ".join(sorted(unknown_evidence_ids))
        )
    if mode != "normal" and not supporting_evidence_ids:
        raise ConfigError(f"{mode} mode requires explicit retained evidence")

    def reject_correlated_citations(ids: list[str], field: str) -> None:
        seen: set[tuple[str, str]] = set()
        for item_id in ids:
            provenance = (
                bundle.evidence_source_story_ids[item_id],
                bundle.evidence_domains[item_id],
            )
            if provenance in seen:
                raise ConfigError(
                    f"{field} cannot count correlated atoms from one story and domain twice"
                )
            seen.add(provenance)

    reject_correlated_citations(
        supporting_evidence_ids, "briefing.supportingEvidenceIds"
    )
    reject_correlated_citations(
        contradicting_evidence_ids, "briefing.contradictingEvidenceIds"
    )
    support_set = set(supporting_evidence_ids)
    # A current emergency-warning symptom and an explicit planned rest day are
    # not tie-breakers to weigh against good recent sessions: they settle the
    # question. Allowing `rest` while still accepting an ordinary training call
    # is exactly the failure this check exists to make impossible.
    if bundle.mandatory_rest_evidence_ids and mode != "rest":
        raise ConfigError(
            "a current emergency-warning report or planned rest day makes "
            f"{mode} mode invalid; today's call must be rest"
        )
    if bundle.mandatory_rest_evidence_ids and not support_set.intersection(
        bundle.mandatory_rest_evidence_ids
    ):
        raise ConfigError(
            "rest mode must cite the current report or planned rest day that "
            "requires it"
        )
    current_plan_status = bundle.inputs["briefingEvidencePacket"][
        "currentProgrammedSession"
    ].get("status")
    if mode in {"push", "light", "deload"} and current_plan_status not in {
        "available",
        "resumable",
    }:
        raise ConfigError(
            f"{mode} mode requires a current trainable session in the current plan"
        )
    # Rest covers three different situations, and only one of them is medical.
    # A keyword screen cannot decide safety, so a current user-authored report
    # is citable for stopping even when no lexicon matched it; a deliberate
    # rest day is ordinary programming and needs no adverse finding at all.
    rest_eligible_ids = (
        bundle.rest_evidence_ids
        | bundle.conservative_stop_evidence_ids
        | bundle.planned_rest_evidence_ids
    )
    if mode == "rest" and not support_set.intersection(rest_eligible_ids):
        raise ConfigError(
            "rest mode requires stopped-pain evidence, an unresolved red flag, "
            "an explicit planned rest day, or a current user report"
        )
    if mode == "light" and not support_set.intersection(
        bundle.light_adverse_evidence_ids
    ):
        raise ConfigError("light mode requires actual adverse non-wearable evidence")
    if mode == "push":
        if bundle.push_blocking_evidence_ids:
            raise ConfigError("push mode is blocked by retained adverse evidence")
        qualifying_group = next(
            (
                group
                for group in bundle.push_evidence_groups
                if len(support_set.intersection(group)) >= 2
            ),
            None,
        )
        if qualifying_group is None:
            raise ConfigError(
                "push mode requires repeated high-quality scheduled-movement evidence"
            )
        cited_stories = {
            bundle.evidence_source_story_ids[item_id]
            for item_id in support_set.intersection(qualifying_group)
        }
        if len(cited_stories) < 2:
            raise ConfigError("push evidence must come from distinct sessions")
    if mode == "deload":
        # A planned deload is programming, not a reaction. It never needed a
        # measured downturn, and demanding one made the supervisor unable to
        # respect the user's own written plan.
        planned_deload = bool(
            support_set.intersection(bundle.planned_deload_evidence_ids)
        )
        qualifying_group = next(
            (
                group
                for group in bundle.deload_decline_groups
                if group.issubset(support_set)
            ),
            None,
        )
        # Repeated high effort without improvement is a second, independent
        # reactive route. Its group already carries the internal-response atom,
        # so it supplies its own second domain.
        difficulty_group = next(
            (
                group
                for group in bundle.deload_difficulty_groups
                if group.issubset(support_set)
            ),
            None,
        )
        if not planned_deload and qualifying_group is None and difficulty_group is None:
            raise ConfigError(
                "deload mode requires an explicit planned deload, a repeated "
                "comparable external decline, or repeated comparable difficulty"
            )
        for group in (qualifying_group, difficulty_group):
            if group is None:
                continue
            # Every external-work atom in the group must be a different
            # session. A difficulty group also carries that session's own
            # internal-response atom, which correctly shares a story.
            work_atoms = [
                item_id
                for item_id in group
                if item_id in bundle.external_work_evidence_ids
            ]
            work_stories = {
                bundle.evidence_source_story_ids[item_id] for item_id in work_atoms
            }
            if len(work_atoms) < 2 or len(work_stories) != len(work_atoms):
                raise ConfigError(
                    "deload evidence must come from distinct sessions"
                )
        if (
            qualifying_group is not None
            and difficulty_group is None
            and not planned_deload
            and not support_set.intersection(
                bundle.deload_secondary_adverse_evidence_ids
            )
        ):
            raise ConfigError("deload mode requires a second adverse evidence domain")
    sections = require_object(briefing.get("sections"), "briefing.sections")
    if set(sections) != {"todaysCall", "why", "trainingTrend", "watchOuts"}:
        raise ConfigError("briefing.sections has an invalid shape")
    recovery_status = recovery.get("status")
    if recovery_status not in RECOVERY_STATUSES:
        raise ConfigError("Trusted recovery status is invalid")
    recovery_fingerprint = trusted_recovery_fingerprint(recovery)
    why = list(
        dict.fromkeys(
            string_list(sections.get("why"), "briefing.sections.why", maximum=2)
        )
    )
    if not 1 <= len(why) <= 2:
        raise ConfigError("briefing.sections.why must have 1-2 items")
    why = [
        require_bounded_string(
            item,
            f"briefing.sections.why[{index}]",
            BRIEFING_REASON_MAX,
        )
        for index, item in enumerate(why)
    ]
    model_watch_outs = string_list(
        sections.get("watchOuts"),
        "briefing.sections.watchOuts",
        maximum=MODEL_WATCH_OUT_MAX,
    )
    if len(set(model_watch_outs)) != len(model_watch_outs):
        raise ConfigError("briefing.sections.watchOuts must contain unique items")
    model_watch_outs = [
        require_bounded_string(
            item,
            f"briefing.sections.watchOuts[{index}]",
            BRIEFING_WATCH_OUT_MAX,
        )
        for index, item in enumerate(model_watch_outs)
    ]
    expected_recovery_summary = require_bounded_string(
        trusted_recovery_summary(recovery),
        "trusted recovery summary",
        BRIEFING_RECOVERY_MAX,
    )
    snapshot_warning = trusted_snapshot_warning(facts, generated_timestamp)
    watch_outs = [
        item
        for item in model_watch_outs
        if item != snapshot_warning and not is_model_sync_warning(item)
    ]
    if snapshot_warning is not None:
        watch_outs.append(snapshot_warning)

    latest_completed = max(
        (item["completedAt"] for item in facts.completed_workouts),
        default=None,
    )
    observed_candidates = []
    for key in ("latestReadiness", "latestSleep"):
        record = recovery.get(key)
        if isinstance(record, dict) and isinstance(record.get("observedAt"), str):
            observed_candidates.append(record["observedAt"])
    recovery_diagnostics = recovery_status_diagnostics(recovery)

    trusted_packet_metrics = dict(bundle.telemetry)
    if packet_telemetry is not None:
        prompt_bytes = packet_telemetry.get("promptBytes")
        prompt_max_bytes = packet_telemetry.get("promptMaxBytes")
        prompt_remaining = packet_telemetry.get("promptBudgetRemainingBytes")
        scaffold_bytes = packet_telemetry.get("promptScaffoldBytes")
        if any(
            not isinstance(value, int) or isinstance(value, bool)
            for value in (
                prompt_bytes,
                prompt_max_bytes,
                prompt_remaining,
                scaffold_bytes,
            )
        ):
            raise ConfigError("Trusted prompt byte telemetry is invalid")
        assert isinstance(prompt_bytes, int)
        assert isinstance(prompt_max_bytes, int)
        assert isinstance(prompt_remaining, int)
        assert isinstance(scaffold_bytes, int)
        total_input_bytes = trusted_packet_metrics["totalInputBytes"]
        if (
            prompt_bytes < 0
            or prompt_max_bytes < 1
            or prompt_bytes > prompt_max_bytes
            or prompt_remaining != prompt_max_bytes - prompt_bytes
            # The scaffold is whatever the prompt costs beyond the packet it
            # carried. A mismatch means the telemetry was paired with a
            # different bundle than the one being validated.
            or scaffold_bytes < 0
            or scaffold_bytes != prompt_bytes - total_input_bytes
        ):
            raise ConfigError("Trusted prompt byte telemetry is inconsistent")
        trusted_packet_metrics.update(
            {
                "promptBytes": prompt_bytes,
                "promptMaxBytes": prompt_max_bytes,
                "promptBudgetRemainingBytes": prompt_remaining,
                "promptScaffoldBytes": scaffold_bytes,
            }
        )

    # Supervisor-owned, never model-authored. `rest` means three different
    # things — a medical stop, a deliberate day off, and a precautionary stop
    # on an unclassified current report — and the app should not have to guess
    # which. Omitted entirely when the mode carries no such distinction, so the
    # persisted sections shape stays backwards compatible.
    mode_reason_label: str | None = None
    if mode == "rest":
        # Medical first when both are true. A note can say "today is my planned
        # rest day, and I have new crushing chest pressure" — labelling that as
        # ordinary programming would bury the part that matters.
        if support_set.intersection(bundle.medical_rest_evidence_ids):
            mode_reason_label = "medical_stop"
        elif support_set.intersection(bundle.planned_rest_evidence_ids):
            mode_reason_label = "planned_rest"
        else:
            mode_reason_label = "precautionary_stop"
    elif mode == "deload":
        mode_reason_label = (
            "planned_deload"
            if support_set.intersection(bundle.planned_deload_evidence_ids)
            else "reactive_deload"
        )
    elif mode == "light":
        mode_reason_label = "temporary_training_adjustment"

    trusted_briefing = {
        "headline": headline,
        "mode": mode,
        "sections": {
            "todaysCall": require_bounded_string(
                sections.get("todaysCall"),
                "briefing.sections.todaysCall",
                BRIEFING_TODAYS_CALL_MAX,
            ),
            "why": why,
            "recoveryStatus": recovery_status,
            "ouraRecovery": expected_recovery_summary,
            "trainingTrend": require_bounded_string(
                sections.get("trainingTrend"),
                "briefing.sections.trainingTrend",
                BRIEFING_TREND_MAX,
            ),
            "watchOuts": watch_outs,
            **(
                {"modeReasonLabel": mode_reason_label}
                if mode_reason_label is not None
                else {}
            ),
        },
        "source": "codex-local",
        "model": model,
        "snapshotUpdatedAt": facts.updated_at,
        "inputSummary": {
            "snapshotUpdatedAt": facts.updated_at,
            "latestCompletedWorkoutAt": latest_completed,
            "workoutCount": len(facts.completed_workouts),
            "loggedSetCount": len(facts.logged_sets),
            "usedOura": recovery_status == "fresh",
            "memoryItemCount": len(existing_items) + len(new_items),
            "newMemoryItemCount": len(new_items),
            "deferredMemoryItemIds": deferred_memory_item_ids,
            "recoveryStatus": recovery_status,
            "recoveryFingerprint": recovery_fingerprint,
            "recoveryFreshnessPolicy": recovery_diagnostics[
                "recoveryFreshnessPolicy"
            ],
            "recoveryEvaluationDate": recovery_diagnostics[
                "recoveryEvaluationDate"
            ],
            "recoveryReadinessDay": recovery_diagnostics[
                "recoveryReadinessDay"
            ],
            "recoverySleepDay": recovery_diagnostics["recoverySleepDay"],
            "ouraObservedAt": max(observed_candidates) if observed_candidates else None,
            "runId": run_id,
            "runnerVersion": RUNNER_VERSION,
            "validatorCompatibilityVersion": VALIDATOR_COMPATIBILITY_VERSION,
            "promptVersion": PROMPT_VERSION,
            "promptHash": prompt_hash,
            "evidenceGuideVersion": EVIDENCE_GUIDE_VERSION,
            "packetSchemaVersion": BRIEFING_EVIDENCE_PACKET_VERSION,
            "codexVersion": codex_version,
            "model": model,
            "modelReasoningEffort": reasoning_effort,
            "supportingEvidenceIds": supporting_evidence_ids,
            "contradictingEvidenceIds": contradicting_evidence_ids,
            **trusted_packet_metrics,
        },
    }
    return {
        "briefing": trusted_briefing,
        "memory": memory_payload,
        "manifest": {
            "date": today,
            "snapshotUpdatedAt": facts.updated_at,
            "expectedMemoryRevision": expected_memory_revision,
            "recoveryStatus": recovery_status,
            "recoveryFingerprint": recovery_fingerprint,
            "recoveryFreshnessPolicy": recovery_diagnostics[
                "recoveryFreshnessPolicy"
            ],
            "recoveryEvaluationDate": recovery_diagnostics[
                "recoveryEvaluationDate"
            ],
            "recoveryReadinessDay": recovery_diagnostics[
                "recoveryReadinessDay"
            ],
            "recoverySleepDay": recovery_diagnostics["recoverySleepDay"],
            "newMemoryItemIds": [item["id"] for item in new_items],
            "runId": run_id,
            "runnerVersion": RUNNER_VERSION,
            "validatorCompatibilityVersion": VALIDATOR_COMPATIBILITY_VERSION,
            "promptVersion": PROMPT_VERSION,
            "promptHash": prompt_hash,
            "evidenceGuideVersion": EVIDENCE_GUIDE_VERSION,
            "codexVersion": codex_version,
            "model": model,
            "reasoningEffort": reasoning_effort,
        },
    }

def validate_spool(
    raw: Any,
    *,
    today: str | None,
    snapshot_updated_at: int | float | None,
    memory_revision: int | None,
    prompt_hash: str,
    model: str,
    reasoning_effort: str,
    recovery_fingerprint: str | None = None,
) -> dict[str, Any]:
    spool = require_object(raw, "spool")
    if set(spool) != {"briefing", "memory", "manifest"}:
        raise ConfigError("Spool has an invalid shape")
    manifest = require_object(spool.get("manifest"), "spool.manifest")
    expected_manifest_fields = {
        "date",
        "snapshotUpdatedAt",
        "expectedMemoryRevision",
        "recoveryStatus",
        "recoveryFingerprint",
        "recoveryFreshnessPolicy",
        "recoveryEvaluationDate",
        "recoveryReadinessDay",
        "recoverySleepDay",
        "newMemoryItemIds",
        "runId",
        "runnerVersion",
        "validatorCompatibilityVersion",
        "promptVersion",
        "promptHash",
        "evidenceGuideVersion",
        "codexVersion",
        "model",
        "reasoningEffort",
    }
    if set(manifest) != expected_manifest_fields:
        raise ConfigError("Spool manifest has an invalid shape")
    spool_date = require_string(manifest.get("date"), "spool.manifest.date")
    try:
        parsed_date = dt.date.fromisoformat(spool_date)
    except ValueError as exc:
        raise ConfigError("Spool date is invalid") from exc
    if parsed_date.isoformat() != spool_date:
        raise ConfigError("Spool date is invalid")
    if today is not None and spool_date != today:
        raise ConfigError("Spool date does not match today")
    manifest_snapshot = manifest.get("snapshotUpdatedAt")
    if not finite_number(manifest_snapshot):
        raise ConfigError("Spool snapshot is invalid")
    if snapshot_updated_at is not None and manifest_snapshot != snapshot_updated_at:
        raise ConfigError("Spool snapshot does not match current snapshot")
    manifest_revision = manifest.get("expectedMemoryRevision")
    if (
        not isinstance(manifest_revision, int)
        or isinstance(manifest_revision, bool)
        or manifest_revision < 0
        or manifest_revision >= MAX_SAFE_INTEGER
    ):
        raise ConfigError("Spool memory revision is invalid")
    if memory_revision is not None and manifest_revision != memory_revision:
        raise ConfigError("Spool memory revision does not match current memory")
    if manifest.get("runnerVersion") != RUNNER_VERSION:
        raise ConfigError("Spool runner version is incompatible")
    if manifest.get("validatorCompatibilityVersion") != VALIDATOR_COMPATIBILITY_VERSION:
        raise ConfigError("Spool validator version is incompatible")
    if manifest.get("promptVersion") != PROMPT_VERSION:
        raise ConfigError("Spool prompt version is incompatible")
    if manifest.get("promptHash") != prompt_hash:
        raise ConfigError("Spool prompt fingerprint is incompatible")
    # A spool written against different curated guidance was produced by a
    # different set of instructions, even when every other marker matches.
    if manifest.get("evidenceGuideVersion") != EVIDENCE_GUIDE_VERSION:
        raise ConfigError("Spool evidence guide version is incompatible")
    if manifest.get("model") != model:
        raise ConfigError("Spool model does not match the configured model")
    if manifest.get("reasoningEffort") != reasoning_effort:
        raise ConfigError("Spool reasoning effort does not match the configured effort")
    if manifest.get("recoveryStatus") not in RECOVERY_STATUSES:
        raise ConfigError("Spool recovery status is invalid")
    manifest_recovery_fingerprint = manifest.get("recoveryFingerprint")
    if not valid_recovery_fingerprint(manifest_recovery_fingerprint):
        raise ConfigError("Spool recovery fingerprint is invalid")
    if (
        recovery_fingerprint is not None
        and manifest_recovery_fingerprint != recovery_fingerprint
    ):
        raise ConfigError("Spool recovery fingerprint does not match current recovery")
    if manifest.get("recoveryFreshnessPolicy") != RECOVERY_FRESHNESS_POLICY:
        raise ConfigError("Spool recovery freshness policy is incompatible")
    recovery_evaluation_date = manifest.get("recoveryEvaluationDate")
    if recovery_evaluation_date != spool_date:
        raise ConfigError("Spool recovery evaluation date is incompatible")
    for field in ("recoveryReadinessDay", "recoverySleepDay"):
        value = manifest.get(field)
        if value is not None:
            parsed_recovery_day = parse_recovery_day(value)
            if parsed_recovery_day is None or parsed_recovery_day > parsed_date:
                raise ConfigError(f"Spool {field} is invalid")
    briefing = require_object(spool.get("briefing"), "spool.briefing")
    memory = require_object(spool.get("memory"), "spool.memory")
    if briefing.get("snapshotUpdatedAt") != manifest_snapshot:
        raise ConfigError("Spool briefing snapshot does not match")
    state = require_object(memory.get("state"), "spool.memory.state")
    if state.get("sourceSnapshotUpdatedAt") != manifest_snapshot:
        raise ConfigError("Spool memory snapshot does not match")
    items = memory.get("items")
    if not isinstance(items, list):
        raise ConfigError("Spool memory items must be an array")
    item_ids: list[str] = []
    for item in items:
        item_object = require_object(item, "spool memory item")
        item_ids.append(require_string(item_object.get("id"), "spool memory item id"))
        if item_object.get("snapshotUpdatedAt") != manifest_snapshot:
            raise ConfigError("Spool memory item snapshot does not match")
    if len(item_ids) != len(set(item_ids)):
        raise ConfigError("Spool memory contains duplicate item IDs")
    new_ids = require_unique_ids(
        manifest.get("newMemoryItemIds"), "spool.manifest.newMemoryItemIds"
    )
    if item_ids != new_ids:
        raise ConfigError("Spool memory items do not match its manifest")
    input_summary = require_object(
        briefing.get("inputSummary"), "spool.briefing.inputSummary"
    )
    if input_summary.get("runnerVersion") != RUNNER_VERSION:
        raise ConfigError("Spool briefing runner version is incompatible")
    if (
        input_summary.get("validatorCompatibilityVersion")
        != VALIDATOR_COMPATIBILITY_VERSION
    ):
        raise ConfigError("Spool briefing validator version is incompatible")
    if input_summary.get("promptVersion") != PROMPT_VERSION:
        raise ConfigError("Spool briefing prompt version is incompatible")
    if input_summary.get("promptHash") != prompt_hash:
        raise ConfigError("Spool briefing prompt fingerprint is incompatible")
    if input_summary.get("packetSchemaVersion") != BRIEFING_EVIDENCE_PACKET_VERSION:
        raise ConfigError("Spool briefing packet schema is incompatible")
    if input_summary.get("model") != model:
        raise ConfigError("Spool briefing model is incompatible")
    if input_summary.get("modelReasoningEffort") != reasoning_effort:
        raise ConfigError("Spool briefing reasoning effort is incompatible")
    for field in RECOVERY_DIAGNOSTIC_FIELDS:
        if input_summary.get(field) != manifest.get(field):
            raise ConfigError("Spool recovery diagnostics do not match its briefing")
    if input_summary.get("recoveryFingerprint") != manifest_recovery_fingerprint:
        raise ConfigError("Spool recovery fingerprint does not match its briefing")
    sections = require_object(briefing.get("sections"), "spool.briefing.sections")
    if sections.get("recoveryStatus") != manifest.get("recoveryStatus"):
        raise ConfigError("Spool recovery status does not match its presentation")
    return spool
