"""Dataclasses passed between the supervisor stages."""

from __future__ import annotations

import datetime as dt
import dataclasses
from typing import Any


@dataclasses.dataclass(frozen=True)
class SnapshotFacts:
    snapshot: dict[str, Any]
    data: dict[str, Any]
    updated_at: int | float
    updated_date: dt.date
    completed_workouts: list[dict[str, Any]]
    logged_sets: list[dict[str, Any]]
    ai_memory_settings: list[dict[str, Any]]
    ai_notes: list[dict[str, Any]]
    ai_memory_summaries: list[dict[str, Any]]

@dataclasses.dataclass(frozen=True)
class MemoryCandidatePlan:
    revision: int
    existing_items: list[dict[str, Any]]
    existing_ids: set[str]
    trusted_state: dict[str, Any]
    candidates: list[dict[str, Any]]
    workout_backlog_count: int = 0
    deferred_candidate_ids: tuple[str, ...] = ()

@dataclasses.dataclass(frozen=True)
class ModelInputBundle:
    inputs: dict[str, Any]
    telemetry: dict[str, Any]
    allowed_evidence_ids: frozenset[str]
    safety_evidence_ids: frozenset[str]
    external_work_evidence_ids: frozenset[str]
    recovery_evidence_ids: frozenset[str]
    memory_candidate_plan: MemoryCandidatePlan
    rest_evidence_ids: frozenset[str]
    light_adverse_evidence_ids: frozenset[str]
    push_evidence_groups: tuple[frozenset[str], ...]
    push_blocking_evidence_ids: frozenset[str]
    deload_decline_groups: tuple[frozenset[str], ...]
    deload_secondary_adverse_evidence_ids: frozenset[str]
    evidence_source_story_ids: dict[str, str]
    evidence_domains: dict[str, str]
