"""Oura recovery sanitisation, freshness policy, and fingerprints."""

from __future__ import annotations

import datetime as dt
import json
import re
import time
from typing import Any

from .errors import ConfigError
from .constants import (
    BRIEFING_EVIDENCE_PACKET_VERSION,
    MODEL_SYNC_WARNING_MARKERS,
    PACIFIC,
    PROMPT_VERSION,
    RECOVERY_FINGERPRINT_VERSION,
    RECOVERY_FRESHNESS_POLICY,
    RECOVERY_STATUSES,
    RUNNER_VERSION,
    SNAPSHOT_WARNING_AFTER,
    VALIDATOR_COMPATIBILITY_VERSION,
)
from .primitives import (
    finite_number,
    parse_iso_datetime,
    sha256_bytes,
)
from .models import SnapshotFacts

def parse_recovery_day(value: Any) -> dt.date | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", cleaned):
        return None
    try:
        return dt.date.fromisoformat(cleaned)
    except ValueError:
        return None

def sanitized_recovery_record(
    raw: Any, now: dt.datetime, *, sleep: bool
) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    local_today = now.astimezone(PACIFIC).date()
    day_present = "day" in raw
    record_day = parse_recovery_day(raw.get("day"))
    if day_present and record_day is None:
        return None
    if record_day is not None and record_day > local_today:
        return None
    score = raw.get("score")
    if not finite_number(score) or not 0 <= float(score) <= 100:
        return None
    observed = parse_iso_datetime(raw.get("observedAt"))
    bedtime_end = parse_iso_datetime(raw.get("bedtimeEnd")) if sleep else None
    now_utc = now.astimezone(dt.timezone.utc)
    if any(
        value is not None and value.astimezone(dt.timezone.utc) > now_utc
        for value in (observed, bedtime_end)
    ):
        return None
    if bedtime_end is not None:
        observed = bedtime_end
    elif record_day is not None and observed is not None:
        daily_marker = dt.datetime.combine(
            record_day, dt.time.min, tzinfo=dt.timezone.utc
        )
        if observed.astimezone(dt.timezone.utc) == daily_marker:
            observed = None
    if observed is None and record_day is None:
        return None
    age_hours = None
    if observed is not None and record_day is None:
        age_hours = max(
            0.0,
            (
                now_utc - observed.astimezone(dt.timezone.utc)
            ).total_seconds()
            / 3600.0,
        )
    result: dict[str, Any] = {
        "day": record_day.isoformat() if record_day is not None else None,
        "score": float(score),
        "observedAt": observed.isoformat() if observed is not None else None,
        # Oura's daily endpoint timestamps are UTC day markers, not measurement
        # times. A calendar day therefore owns freshness; elapsed hours are only
        # meaningful for legacy records that do not include a day.
        "ageHours": round(age_hours, 1) if age_hours is not None else None,
        "freshnessBasis": (
            "pacific_day" if record_day is not None else "elapsed_hours_legacy"
        ),
        "isStale": (
            record_day < local_today
            if record_day is not None
            else age_hours is None or age_hours > 24.0
        ),
    }
    if sleep:
        total = raw.get("totalSleepHours")
        result["totalSleepHours"] = (
            float(total)
            if finite_number(total) and 0 <= float(total) <= 24
            else None
        )
        result["bedtimeEnd"] = (
            bedtime_end.isoformat() if bedtime_end is not None else None
        )
    return result

def sanitize_recovery(raw: Any, now: dt.datetime) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    readiness = sanitized_recovery_record(source.get("latestReadiness"), now, sleep=False)
    sleep = sanitized_recovery_record(source.get("latestSleep"), now, sleep=True)
    if readiness is None or sleep is None:
        status = "unavailable"
    elif readiness["day"] != sleep["day"]:
        status = "stale"
    elif readiness["isStale"] or sleep["isStale"]:
        status = "stale"
    else:
        status = "fresh"
    return {
        "generatedAt": now.isoformat(),
        "status": status,
        "freshnessPolicy": RECOVERY_FRESHNESS_POLICY,
        "evaluationDate": now.astimezone(PACIFIC).date().isoformat(),
        "latestReadiness": readiness,
        "latestSleep": sleep,
    }

def unavailable_recovery(now: dt.datetime) -> dict[str, Any]:
    return {
        "generatedAt": now.isoformat(),
        "status": "unavailable",
        "freshnessPolicy": RECOVERY_FRESHNESS_POLICY,
        "evaluationDate": now.astimezone(PACIFIC).date().isoformat(),
        "latestReadiness": None,
        "latestSleep": None,
    }

def display_metric(value: Any) -> str | None:
    if not finite_number(value):
        return None
    return f"{float(value):.1f}".rstrip("0").rstrip(".")

def trusted_recovery_summary(recovery: dict[str, Any]) -> str:
    status = recovery.get("status")
    if status == "unavailable":
        return "Oura unavailable; use workout history only."

    readiness = recovery.get("latestReadiness")
    sleep = recovery.get("latestSleep")
    records = [item for item in (readiness, sleep) if isinstance(item, dict)]
    if status == "stale":
        readiness_day = (
            readiness.get("day") if isinstance(readiness, dict) else None
        )
        sleep_day = sleep.get("day") if isinstance(sleep, dict) else None
        if readiness_day and sleep_day and readiness_day != sleep_day:
            return (
                "Oura daily records do not match "
                f"(readiness {readiness_day}; sleep {sleep_day}); "
                "use workout history for this call."
            )
        stale_days = [
            item["day"]
            for item in records
            if item.get("isStale") is True
            and parse_recovery_day(item.get("day")) is not None
        ]
        if stale_days:
            return (
                f"Oura data are from {min(stale_days)}; "
                "use workout history for this call."
            )
        ages = [
            float(item["ageHours"])
            for item in records
            if finite_number(item.get("ageHours"))
        ]
        if ages:
            age = display_metric(max(ages))
            return f"Oura is stale ({age} h old); use workout history for this call."
        return "Oura is stale; use workout history for this call."

    if status != "fresh":
        raise ConfigError("Trusted recovery status is invalid")

    sleep_hours = (
        display_metric(sleep.get("totalSleepHours"))
        if isinstance(sleep, dict)
        else None
    )
    sleep_score = (
        display_metric(sleep.get("score")) if isinstance(sleep, dict) else None
    )
    readiness_score = (
        display_metric(readiness.get("score"))
        if isinstance(readiness, dict)
        else None
    )
    metrics: list[str] = []
    if sleep_hours is not None:
        metrics.append(f"{sleep_hours} h sleep")
    elif sleep_score is not None:
        metrics.append(f"sleep score {sleep_score}")
    if readiness_score is not None:
        metrics.append(f"readiness score {readiness_score}")
    if not metrics:
        return "Oura data are current, but no usable sleep or readiness values were supplied."
    return (
        f"Oura estimate: {' and '.join(metrics)}; "
        "use as context, not a diagnosis."
    )

def model_recovery_context(recovery: dict[str, Any]) -> dict[str, Any]:
    """Expose measurements to the model only when the full recovery pair is fresh."""
    if recovery.get("status") == "fresh":
        return recovery
    return {
        "generatedAt": recovery.get("generatedAt"),
        "status": recovery.get("status"),
        "freshnessPolicy": recovery.get("freshnessPolicy"),
        "evaluationDate": recovery.get("evaluationDate"),
        "latestReadiness": None,
        "latestSleep": None,
    }

def recovery_status_diagnostics(recovery: dict[str, Any]) -> dict[str, Any]:
    def record_day(key: str) -> str | None:
        record = recovery.get(key)
        if not isinstance(record, dict):
            return None
        day = record.get("day")
        return day if parse_recovery_day(day) is not None else None

    return {
        "recoveryStatus": recovery.get("status"),
        "recoveryFreshnessPolicy": recovery.get("freshnessPolicy"),
        "recoveryEvaluationDate": recovery.get("evaluationDate"),
        "recoveryReadinessDay": record_day("latestReadiness"),
        "recoverySleepDay": record_day("latestSleep"),
    }

def trusted_recovery_fingerprint(recovery: dict[str, Any]) -> str:
    """Fingerprint only material fields from the sanitized recovery contract."""
    status = recovery.get("status")
    if status not in RECOVERY_STATUSES:
        raise ConfigError("Trusted recovery status is invalid")

    def material_record(key: str, *, sleep: bool) -> dict[str, Any] | None:
        if status != "fresh":
            return None
        raw = recovery.get(key)
        if not isinstance(raw, dict):
            return None
        fields = [
            "day",
            "score",
            "observedAt",
            "freshnessBasis",
            "isStale",
        ]
        if sleep:
            fields.extend(("totalSleepHours", "bedtimeEnd"))
        return {field: raw.get(field) for field in fields}

    diagnostics = recovery_status_diagnostics(recovery)
    payload = {
        "version": RECOVERY_FINGERPRINT_VERSION,
        "status": status,
        "freshnessPolicy": recovery.get("freshnessPolicy"),
        "evaluationDate": recovery.get("evaluationDate"),
        "readinessDay": diagnostics["recoveryReadinessDay"],
        "sleepDay": diagnostics["recoverySleepDay"],
        "latestReadiness": material_record("latestReadiness", sleep=False),
        "latestSleep": material_record("latestSleep", sleep=True),
    }
    digest = sha256_bytes(
        json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    )
    return f"{RECOVERY_FINGERPRINT_VERSION}:{digest}"

def valid_recovery_fingerprint(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(
        rf"{re.escape(RECOVERY_FINGERPRINT_VERSION)}:[0-9a-f]{{64}}", value
    ) is not None

def briefing_recovery_diagnostics(briefing: dict[str, Any]) -> dict[str, Any]:
    input_summary = briefing.get("inputSummary")
    if not isinstance(input_summary, dict):
        return {}

    diagnostics: dict[str, Any] = {}
    status = input_summary.get("recoveryStatus")
    if status in RECOVERY_STATUSES:
        diagnostics["recoveryStatus"] = status
    if input_summary.get("recoveryFreshnessPolicy") == RECOVERY_FRESHNESS_POLICY:
        diagnostics["recoveryFreshnessPolicy"] = RECOVERY_FRESHNESS_POLICY
    for field in (
        "recoveryEvaluationDate",
        "recoveryReadinessDay",
        "recoverySleepDay",
    ):
        value = input_summary.get(field)
        if parse_recovery_day(value) is not None:
            diagnostics[field] = value
    return diagnostics

def briefing_matches_current_contract(
    briefing: dict[str, Any],
    *,
    prompt_hash: str,
    model: str,
    reasoning_effort: str,
    recovery_fingerprint: str | None = None,
) -> bool:
    input_summary = briefing.get("inputSummary")
    if not isinstance(input_summary, dict):
        return False
    matches = all(
        (
            input_summary.get("runnerVersion") == RUNNER_VERSION,
            input_summary.get("validatorCompatibilityVersion")
            == VALIDATOR_COMPATIBILITY_VERSION,
            input_summary.get("promptVersion") == PROMPT_VERSION,
            input_summary.get("promptHash") == prompt_hash,
            input_summary.get("packetSchemaVersion")
            == BRIEFING_EVIDENCE_PACKET_VERSION,
            input_summary.get("model") == model,
            input_summary.get("modelReasoningEffort") == reasoning_effort,
        )
    )
    if not matches:
        return False
    return (
        recovery_fingerprint is None
        or input_summary.get("recoveryFingerprint") == recovery_fingerprint
    )

def trusted_snapshot_warning(facts: SnapshotFacts, generated_at: int) -> str | None:
    generated = dt.datetime.fromtimestamp(generated_at / 1000.0, dt.timezone.utc)
    snapshot = dt.datetime.fromtimestamp(facts.updated_at / 1000.0, dt.timezone.utc)
    if generated - snapshot <= SNAPSHOT_WARNING_AFTER:
        return None
    return (
        f"Data last synced {facts.updated_date.isoformat()}; if you trained since then, "
        "open the app to sync before relying on this."
    )

def is_model_sync_warning(value: str) -> bool:
    normalized = " ".join(value.lower().split())
    return any(marker in normalized for marker in MODEL_SYNC_WARNING_MARKERS)
