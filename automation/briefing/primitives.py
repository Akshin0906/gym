"""Strict coercions for untrusted JSON plus Pacific-day arithmetic.

These never guess: an out-of-contract value raises ConfigError rather than
being silently defaulted."""

from __future__ import annotations

import datetime as dt
import hashlib
import math
import time
from typing import Any

from .errors import ConfigError
from .constants import (
    FOUR_MONTH_ROLLUP_PERIOD_COUNT,
    MAX_SAFE_INTEGER,
    PACIFIC,
    TWO_WEEK_PERIOD_DAYS,
)

def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()

def parse_iso_datetime(raw: Any) -> dt.datetime | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    value = raw.strip().replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=PACIFIC)
    return parsed

def finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

def require_object(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError(f"{field} must be an object")
    return value

def require_string(value: Any, field: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise ConfigError(f"{field} must be a string")
    cleaned = value.strip()
    if not allow_empty and not cleaned:
        raise ConfigError(f"{field} must not be empty")
    return cleaned

def require_bounded_string(
    value: Any,
    field: str,
    maximum: int,
    *,
    allow_empty: bool = False,
) -> str:
    cleaned = require_string(value, field, allow_empty=allow_empty)
    if len(cleaned) > maximum:
        raise ConfigError(f"{field} must be at most {maximum} characters")
    return cleaned

def string_list(value: Any, field: str, *, maximum: int | None = None) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ConfigError(f"{field} must be an array of strings")
    cleaned = [item.strip() for item in value if item.strip()]
    if maximum is not None and len(cleaned) > maximum:
        raise ConfigError(f"{field} has too many items")
    return cleaned

def require_epoch_ms(value: Any, field: str) -> int:
    if (
        not finite_number(value)
        or value < 0
        or value > MAX_SAFE_INTEGER
        or not float(value).is_integer()
    ):
        raise ConfigError(f"{field} must be a non-negative integer timestamp")
    return int(value)

def pacific_day_start_ms(epoch_ms: int) -> int:
    local = dt.datetime.fromtimestamp(epoch_ms / 1000.0, PACIFIC)
    return int(local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)

def pacific_date_start_ms(value: str) -> int:
    try:
        day = dt.date.fromisoformat(value)
    except ValueError as exc:
        raise ConfigError("today must be an ISO calendar date") from exc
    if day.isoformat() != value:
        raise ConfigError("today must be an ISO calendar date")
    return int(dt.datetime.combine(day, dt.time.min, PACIFIC).timestamp() * 1000)

def add_calendar_days_ms(epoch_ms: int, days: int) -> int:
    local = dt.datetime.fromtimestamp(epoch_ms / 1000.0, PACIFIC)
    target = local.date() + dt.timedelta(days=days)
    return int(dt.datetime.combine(target, local.timetz(), PACIFIC).timestamp() * 1000)

def add_calendar_months_ms(epoch_ms: int, months: int) -> int:
    """Match JavaScript Date.setMonth calendar rollover in Pacific time."""
    local = dt.datetime.fromtimestamp(epoch_ms / 1000.0, PACIFIC)
    month_index = local.year * 12 + (local.month - 1) + months
    year, zero_based_month = divmod(month_index, 12)
    first = dt.datetime(
        year,
        zero_based_month + 1,
        1,
        local.hour,
        local.minute,
        local.second,
        local.microsecond,
        tzinfo=PACIFIC,
    )
    target = first + dt.timedelta(days=local.day - 1)
    return int(target.timestamp() * 1000)

def add_four_month_rollup_ms(epoch_ms: int) -> int:
    """Advance by eight complete 14-day source windows without boundary gaps."""
    return add_calendar_days_ms(
        epoch_ms, TWO_WEEK_PERIOD_DAYS * FOUR_MONTH_ROLLUP_PERIOD_COUNT
    )

def require_unique_ids(value: Any, field: str) -> list[str]:
    if not isinstance(value, list):
        raise ConfigError(f"{field} must be an array of strings")
    result: list[str] = []
    seen: set[str] = set()
    for index, raw in enumerate(value):
        item = require_bounded_string(raw, f"{field}[{index}]", 180)
        if item in seen:
            raise ConfigError(f"{field} contains duplicate id: {item}")
        seen.add(item)
        result.append(item)
    return result
