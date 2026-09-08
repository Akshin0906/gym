"""Atomic publishing of a validated spool, with commit verification."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from .errors import (
    ConfigError,
    StalePublishError,
    TransientError,
)
from .constants import MAX_SAFE_INTEGER
from .primitives import (
    require_object,
    require_string,
)
from .cloudclient import CloudClient

def verify_committed_briefing(
    raw: Any,
    expected: dict[str, Any],
    *,
    date: str,
    field: str,
) -> dict[str, Any]:
    remote = require_object(raw, field)
    if remote.get("briefingDate") != date:
        raise TransientError(f"{field} returned the wrong date")
    for key, value in expected.items():
        if remote.get(key) != value:
            raise TransientError(f"{field} returned the wrong {key}")
    expected_summary = require_object(
        expected.get("inputSummary"), "spool.briefing.inputSummary"
    )
    remote_summary = require_object(remote.get("inputSummary"), f"{field}.inputSummary")
    if remote_summary.get("runId") != expected_summary.get("runId"):
        raise TransientError(f"{field} is not bound to the requested publish ID")
    return remote

def verify_committed_memory_state(
    raw: Any,
    expected: dict[str, Any],
    *,
    field: str,
) -> dict[str, Any]:
    remote = require_object(raw, field)
    for key, value in expected.items():
        if remote.get(key) != value:
            raise TransientError(f"{field} returned the wrong {key}")
    return remote

def publish_spool(
    cloud: CloudClient,
    spool: dict[str, Any],
    *,
    logger: logging.Logger,
) -> None:
    manifest = require_object(spool["manifest"], "spool.manifest")
    date = require_string(manifest.get("date"), "spool.manifest.date")
    publish_id = require_string(manifest.get("runId"), "spool.manifest.runId")
    expected_revision = manifest.get("expectedMemoryRevision")
    if (
        not isinstance(expected_revision, int)
        or isinstance(expected_revision, bool)
        or expected_revision < 0
        or expected_revision >= MAX_SAFE_INTEGER
    ):
        raise ConfigError("Spool has an invalid expected memory revision")
    logger.info("Atomically uploading validated memory and briefing")
    status, publish_response = cloud.request(
        "PUT",
        f"/api/cloud/publish/{date}",
        body={
            "publishId": publish_id,
            "expectedSnapshotUpdatedAt": manifest.get("snapshotUpdatedAt"),
            "expectedMemoryRevision": expected_revision,
            "memory": spool["memory"],
            "briefing": spool["briefing"],
        },
        expected={200, 409},
    )
    if status == 409:
        raise StalePublishError(
            "Cloud snapshot or memory changed while the insight was generated"
        )
    published = require_object(publish_response, "atomic publish response")
    next_revision = expected_revision + 1
    if published.get("publishId") != publish_id:
        raise TransientError("Atomic publish response is not bound to the publish ID")
    if published.get("memoryRevision") != next_revision:
        raise TransientError("Atomic publish returned the wrong memory revision")

    expected_briefing = require_object(spool.get("briefing"), "spool.briefing")
    expected_state = require_object(
        require_object(spool.get("memory"), "spool.memory").get("state"),
        "spool.memory.state",
    )
    # The endpoint returns a committed read selected through publishId replay
    # semantics. Validate that response before consulting global state that a
    # later legitimate memory mutation may already have advanced.
    verify_committed_briefing(
        published.get("briefing"),
        expected_briefing,
        date=date,
        field="atomic publish response.briefing",
    )
    verify_committed_memory_state(
        published.get("memoryState"),
        expected_state,
        field="atomic publish response.memoryState",
    )

    _, briefing_response = cloud.request(
        "GET", f"/api/cloud/briefing/{date}", expected={200}
    )
    verify_committed_briefing(
        require_object(briefing_response, "briefing verification").get("briefing"),
        expected_briefing,
        date=date,
        field="briefing verification.briefing",
    )

    _, memory_response = cloud.request("GET", "/api/cloud/memory", expected={200})
    remote_memory = require_object(memory_response, "memory verification")
    remote_revision = remote_memory.get("revision")
    if (
        not isinstance(remote_revision, int)
        or isinstance(remote_revision, bool)
        or remote_revision < next_revision
    ):
        raise TransientError("Remote memory verification returned an older revision")
    if remote_revision == next_revision:
        verify_committed_memory_state(
            remote_memory.get("state"),
            expected_state,
            field="memory verification.state",
        )
    remote_items = remote_memory.get("items")
    if not isinstance(remote_items, list):
        raise TransientError("Remote memory verification returned invalid items")
    remote_ids = {
        item.get("id") for item in remote_items if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    missing = set(manifest.get("newMemoryItemIds") or []) - remote_ids
    if missing:
        raise TransientError("Remote memory verification is missing new items")

def quarantine_spool(path: Path, *, run_id: str, reason: str) -> Path:
    target = path.with_name(f"{path.stem}.{reason}-{run_id}.quarantine")
    os.replace(path, target)
    return target
