"""Bounded text handling, evidence identifiers, and byte accounting."""

from __future__ import annotations

import datetime as dt
import json
import re
from typing import Any

from .errors import ConfigError
from .constants import (
    DISPLAY_TEXT_EXCERPT_MAX_CHARS,
    PACIFIC,
    RECENT_ADVERSE_WINDOW_DAYS,
)
from .safety import (
    classify_safety_text,
    has_unresolved_red_flag as safety_has_unresolved_red_flag,
)
from .primitives import (
    finite_number,
    require_bounded_string,
    sha256_bytes,
)

def compact_json_bytes(value: Any) -> int:
    return len(
        json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    )

def canonical_string_list_sha256(values: list[str]) -> str:
    return sha256_bytes(
        json.dumps(
            values,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    )

def stabilize_compact_json_byte_metric(
    value: Any, metrics: dict[str, Any], field: str
) -> int:
    """Set a self-inclusive serialized byte metric to its exact fixed point."""
    for _ in range(8):
        actual = compact_json_bytes(value)
        if metrics.get(field) == actual:
            return actual
        metrics[field] = actual
    raise ConfigError(f"Unable to stabilize compact JSON byte metric: {field}")

def bounded_source_id(value: Any, field: str) -> str:
    return require_bounded_string(value, field, 180)

def evidence_id(kind: str, *source_ids: Any) -> str:
    canonical = json.dumps(
        [kind, *source_ids],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"{kind}:{sha256_bytes(canonical)[:24]}"

def pacific_date_for_epoch(value: Any) -> str | None:
    if not finite_number(value) or float(value) < 0:
        return None
    return dt.datetime.fromtimestamp(float(value) / 1000.0, PACIFIC).date().isoformat()

def observed_within_recent_window(
    observed_at: Any, today: str, *, days: int = RECENT_ADVERSE_WINDOW_DAYS
) -> bool:
    if not finite_number(observed_at) or float(observed_at) < 0:
        return False
    try:
        today_date = dt.date.fromisoformat(today)
    except ValueError:
        return False
    observed_date = dt.datetime.fromtimestamp(
        float(observed_at) / 1000.0, PACIFIC
    ).date()
    age_days = (today_date - observed_date).days
    return 0 <= age_days <= days

def optional_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None

def optional_excerpt_text(
    value: Any, maximum: int = DISPLAY_TEXT_EXCERPT_MAX_CHARS
) -> tuple[str | None, dict[str, Any] | None]:
    cleaned = optional_text(value)
    if cleaned is None:
        return None, None
    excerpt, truncation = text_excerpt(cleaned, maximum)
    return excerpt, truncation

def text_excerpt(
    value: str,
    maximum: int,
    *,
    focus_re: re.Pattern[str] | None = None,
) -> tuple[str, dict[str, Any]]:
    if maximum < 8:
        raise ConfigError("Text excerpt maximum must be at least 8 characters")
    if len(value) <= maximum:
        return value, {
            "truncated": False,
            "originalCharacterCount": len(value),
            "omittedCharacterCount": 0,
        }
    focus = focus_re.search(value) if focus_re is not None else None
    payload = maximum - 1
    if focus is not None:
        before = payload // 2
        start = max(0, focus.start() - before)
        end = min(len(value), start + payload)
        start = max(0, end - payload)
        excerpt = value[start:end]
        if start > 0:
            excerpt = "…" + excerpt[1:]
        if end < len(value):
            excerpt = excerpt[:-1] + "…"
    else:
        prefix = payload // 2
        suffix = payload - prefix
        excerpt = value[:prefix] + "…" + value[-suffix:]
    return excerpt, {
        "truncated": True,
        "originalCharacterCount": len(value),
        "omittedCharacterCount": len(value) - len(excerpt),
    }

def display_text(value: Any, fallback: str) -> tuple[str, dict[str, Any]]:
    cleaned = optional_text(value) or fallback
    return text_excerpt(cleaned, DISPLAY_TEXT_EXCERPT_MAX_CHARS)

# Re-exported so every existing import site keeps working while the scoping,
# symptom-combination, and planned-pause rules live in one reviewed module.
has_unresolved_red_flag = safety_has_unresolved_red_flag

def compact_rows_by_id(
    rows: list[dict[str, Any]],
    *,
    maximum: int,
    id_field: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    retained = rows[:maximum]
    all_ids = [str(item.get(id_field, "")) for item in rows]
    return retained, {
        "totalCount": len(rows),
        "retainedCount": len(retained),
        "omittedCount": len(rows) - len(retained),
        "allSourceIdsSha256": canonical_string_list_sha256(all_ids),
    }

def compact_source_ids(
    values: list[str],
    *,
    maximum: int = 24,
    required: tuple[str, ...] = (),
    selection: str = "lexical",
) -> tuple[list[str], dict[str, Any]]:
    ordered = list(dict.fromkeys(values))
    canonical = sorted(ordered)
    required_ids = sorted(set(required))
    if any(item not in canonical for item in required_ids):
        raise ConfigError("Required compact source id is not in the canonical source set")
    if len(required_ids) > maximum:
        raise ConfigError("Required compact source ids exceed the deterministic limit")
    required_set = set(required_ids)
    if selection == "lexical":
        retained = sorted(
            [
                *required_ids,
                *[
                    item for item in canonical if item not in required_set
                ][: maximum - len(required_ids)],
            ]
        )
    elif selection == "newest_tail":
        selected = set(required_ids)
        for item in reversed(ordered):
            if len(selected) >= maximum:
                break
            selected.add(item)
        retained = [item for item in ordered if item in selected]
    else:
        raise ConfigError(f"Unknown compact source selection: {selection}")
    return retained, {
        "totalCount": len(canonical),
        "retainedCount": len(retained),
        "omittedCount": len(canonical) - len(retained),
        "allSourceIdsSha256": canonical_string_list_sha256(canonical),
    }
