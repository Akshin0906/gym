"""Training measurement semantics shared with the app.

The one-rep-max formula, rep-range parsing, and load comparability rules here
are pinned by automation/shared_fixtures/calculations.json, which the
TypeScript suite exercises against the same expectations."""

from __future__ import annotations

import re
from typing import Any

from .primitives import finite_number
from .textutil import optional_text

# How the number recorded as `weightLbs` should be read. Mirrors LoadConvention
# in src/db/types.ts. Legacy rows carry no value at all and resolve to
# "unknown", which behaves exactly like "total" so no historical comparison
# changes meaning — but is reported as an assumption, never as a fact.
LOAD_CONVENTIONS = (
    "unknown",
    "total",
    "per_dumbbell",
    "machine_setting",
    "bodyweight",
    "assistance",
)

# supportsTonnage, supportsOneRepMax, higherIsHarder
_LOAD_SEMANTICS = {
    "unknown": (True, True, True),
    "total": (True, True, True),
    "per_dumbbell": (False, True, True),
    "machine_setting": (False, False, True),
    "bodyweight": (False, False, True),
    "assistance": (False, False, False),
}

_TOTAL_LIKE = frozenset({"unknown", "total"})


def load_convention(value: Any) -> str:
    """Coerce an untrusted load-convention value, defaulting to "unknown"."""
    return value if value in _LOAD_SEMANTICS else "unknown"


def load_semantics(convention: Any) -> dict[str, bool]:
    tonnage, one_rep_max, higher_is_harder = _LOAD_SEMANTICS[
        load_convention(convention)
    ]
    resolved = load_convention(convention)
    return {
        "convention": resolved,
        "supportsTonnage": tonnage,
        "supportsOneRepMax": one_rep_max,
        "higherIsHarder": higher_is_harder,
        "recorded": resolved != "unknown",
    }


def load_conventions_comparable(left: Any, right: Any) -> bool:
    """Two loads are comparable when they measure the same thing.

    "unknown" is comparable with "total" because a legacy row is read as total
    external load; nothing else is ever mixed.
    """
    a = load_convention(left)
    b = load_convention(right)
    if a == b:
        return True
    return a in _TOTAL_LIKE and b in _TOTAL_LIKE


def estimated_one_rep_max(weight_lbs: Any, reps: Any) -> float | None:
    """Epley, with a single rep returned exactly.

    A one-rep set *is* the measurement, so multiplying it by the 1 + reps/30
    term would inflate a 100 lb single to 103.33. src/lib/analytics.ts has
    always special-cased this; the supervisor did not, and the two disagreed.
    automation/shared_fixtures/calculations.json pins the shared behaviour.
    """
    if not finite_number(weight_lbs) or not finite_number(reps):
        return None
    weight = float(weight_lbs)
    rep_count = float(reps)
    if weight <= 0 or rep_count < 1:
        return None
    if rep_count == 1:
        return weight
    return weight * (1.0 + rep_count / 30.0)


def estimated_one_rep_max_for_load(
    weight_lbs: Any, reps: Any, convention: Any = "unknown"
) -> float | None:
    """Estimate only when weight x reps is a valid one-rep-max input."""
    if not load_semantics(convention)["supportsOneRepMax"]:
        return None
    return estimated_one_rep_max(weight_lbs, reps)


def set_volume_for_load(
    weight_lbs: Any, reps: Any, convention: Any = "unknown"
) -> float | None:
    """Tonnage only where the recorded number is a real external load."""
    if not load_semantics(convention)["supportsTonnage"]:
        return None
    if not finite_number(weight_lbs) or not finite_number(reps):
        return None
    return float(weight_lbs) * float(reps)


def normalized_target_range(value: Any) -> str | None:
    text = optional_text(value)
    return " ".join(text.lower().split()) if text is not None else None

def set_kind(value: Any) -> str:
    """Coerce a recorded set classification; anything else reads as working.

    A legacy row has no classification at all. Treating it as a working set is
    what every existing comparison already assumed, so nothing changes for old
    data — but `setKindRecorded` reports whether it was an actual answer.
    """
    return value if value in ("working", "warmup") else "working"

def is_working_set(row: Any) -> bool:
    return isinstance(row, dict) and set_kind(row.get("setKind")) == "working"

def working_sets(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Warm-ups are not performance data and never enter a comparison."""
    return [row for row in rows if is_working_set(row)]

def parsed_target_rep_range(value: Any) -> tuple[int, int] | None:
    """Parse a display rep target.

    Accepts an explicit range and, like the app's deriveRepBounds, a bare single
    number: "10" and "10 reps" both mean exactly ten reps. The two
    implementations are pinned together by
    automation/shared_fixtures/calculations.json.
    """
    normalized = normalized_target_range(value)
    if normalized is None:
        return None
    match = re.fullmatch(
        r"(\d{1,3})\s*(?:-|–|—|to)\s*(\d{1,3})(?:\s*reps?)?",
        normalized,
    )
    if match is not None:
        low = int(match.group(1))
        high = int(match.group(2))
        if low < 1 or high < low:
            return None
        return low, high
    single = re.fullmatch(r"(\d{1,3})(?:\s*reps?)?", normalized)
    if single is not None:
        reps = int(single.group(1))
        return (reps, reps) if reps >= 1 else None
    return None

def valid_rep_bounds(value: Any) -> tuple[int, int] | None:
    """Structured bounds as written by the app, or None if not usable."""
    if not isinstance(value, dict) or set(value) != {"min", "max"}:
        return None
    low_raw = value.get("min")
    high_raw = value.get("max")
    for candidate in (low_raw, high_raw):
        if (
            not finite_number(candidate)
            or isinstance(candidate, bool)
            or not float(candidate).is_integer()
        ):
            return None
    low = int(low_raw)
    high = int(high_raw)
    if low < 1 or high < low or high > 1000:
        return None
    return low, high

def plan_rep_bounds(plan: Any) -> tuple[int, int] | None:
    """Rep bounds for a plan row: structured field first, then display text.

    Mirrors resolveRepTarget in src/lib/measurement.ts, including the meaning of
    an explicit `repBounds: null` — a deliberate "no machine-readable target"
    that is NOT overridden by re-parsing the prose.
    """
    if not isinstance(plan, dict):
        return None
    if "repBounds" in plan:
        if plan["repBounds"] is None:
            return None
        structured = valid_rep_bounds(plan["repBounds"])
        if structured is not None:
            return structured
    return parsed_target_rep_range(plan.get("targetRepRange"))

def rep_bounds_source(plan: Any) -> str:
    """Where a plan row's rep target came from, or why there is none."""
    if not isinstance(plan, dict):
        return "missing"
    if "repBounds" in plan:
        if plan["repBounds"] is None:
            return "unparseable_text"
        if valid_rep_bounds(plan["repBounds"]) is not None:
            return "structured"
    if normalized_target_range(plan.get("targetRepRange")) is None:
        return "missing"
    return (
        "parsed_text"
        if parsed_target_rep_range(plan.get("targetRepRange")) is not None
        else "unparseable_text"
    )

def _target_text(value: Any) -> Any:
    return value.get("targetRepRange") if isinstance(value, dict) else value

def _target_bounds(value: Any) -> tuple[int, int] | None:
    if isinstance(value, dict):
        return plan_rep_bounds(value)
    return parsed_target_rep_range(value)

def positive_integer(value: Any) -> int | None:
    if (
        not finite_number(value)
        or isinstance(value, bool)
        or float(value) < 1
        or not float(value).is_integer()
    ):
        return None
    return int(value)

def target_range_comparability(today_value: Any, historical_value: Any) -> str:
    """Compare two rep targets.

    Accepts either a plan row (so structured `repBounds` are honoured) or the
    raw display string, which is what the older call sites pass.
    """
    today_text = normalized_target_range(_target_text(today_value))
    historical_text = normalized_target_range(_target_text(historical_value))
    today_range = _target_bounds(today_value)
    historical_range = _target_bounds(historical_value)
    if today_range is not None and historical_range is not None:
        return (
            "same_exercise_same_target_rep_range"
            if today_range == historical_range
            else "same_exercise_different_target_rep_range"
        )
    if today_text is None:
        return "same_exercise_today_target_rep_range_missing"
    if historical_text is None:
        return "same_exercise_historical_target_rep_range_missing"
    return "same_exercise_target_rep_range_malformed"

def comparator_completion(
    historical_plan: dict[str, Any] | None,
    rows: list[dict[str, Any]],
) -> dict[str, Any]:
    # Working sets only: a planned target is a working-set target, and a warm-up
    # neither completes one nor should be judged against its rep range.
    target_sets = positive_integer(
        historical_plan.get("targetSets") if historical_plan is not None else None
    )
    rep_range = plan_rep_bounds(historical_plan)
    counted = working_sets(rows)
    warmup_count = len(rows) - len(counted)
    valid_reps = [
        int(row["reps"])
        for row in counted
        if positive_integer(row.get("reps")) is not None
    ]
    all_reps_in_range = (
        rep_range is not None
        and len(counted) > 0
        and len(valid_reps) == len(counted)
        and all(rep_range[0] <= reps <= rep_range[1] for reps in valid_reps)
    )
    return {
        "targetSets": target_sets,
        "loggedSetCount": len(counted),
        # Only when there were any: the packet is byte-budgeted, and a zero on
        # every exposure would displace real evidence.
        **({"warmupSetCount": warmup_count} if warmup_count else {}),
        "completedTargetSets": (
            target_sets is not None and len(counted) >= target_sets
        ),
        "parsedTargetRepRange": (
            {"minimum": rep_range[0], "maximum": rep_range[1]}
            if rep_range is not None
            else None
        ),
        # Reported only when the plan carried structured bounds, because that is
        # the case a reader cannot infer from the display text alone.
        **(
            {"targetRepRangeSource": rep_bounds_source(historical_plan)}
            if isinstance(historical_plan, dict) and "repBounds" in historical_plan
            else {}
        ),
        "allLoggedSetRepsInTargetRange": all_reps_in_range,
        "eligibleForProgressionTrend": (
            target_sets is not None
            and len(counted) >= target_sets
            and all_reps_in_range
        ),
    }

def common_load_convention(rows: list[dict[str, Any]]) -> str | None:
    """The one convention a group of rows measures, or None if they disagree.

    `unknown` and `total` are the same measurement and merge to the recorded
    one; anything else in the same group means there is no shared unit.
    """
    resolved: str | None = None
    for row in rows:
        convention = load_convention(row.get("loadConvention"))
        if resolved is None:
            resolved = convention
            continue
        if resolved == convention:
            continue
        if load_conventions_comparable(resolved, convention):
            resolved = convention if resolved == "unknown" else resolved
            continue
        return None
    return resolved

def one_rep_max_eligible_set_count(rows: list[dict[str, Any]]) -> int:
    """How many rows the top estimate could actually use.

    Reported alongside the marker, so it must apply the same rules: working
    sets only, and only conventions that have a valid one-rep-max estimate.
    """
    counted = working_sets(rows)
    if common_load_convention(counted) is None:
        return 0
    return sum(
        1
        for row in counted
        if estimated_one_rep_max_for_load(
            row.get("weightLbs"),
            row.get("reps"),
            row.get("loadConvention", "unknown"),
        )
        is not None
    )

def top_estimated_one_rep_max(rows: list[dict[str, Any]]) -> float | None:
    """Best one-rep-max estimate across a group of sets.

    Working sets only — a warm-up is not a performance data point. A row whose
    recorded load is a machine setting, an assistance weight, or bodyweight-only
    has no valid estimate and is left out rather than being turned into a number
    that looks comparable.
    """
    counted = working_sets(rows)
    # A group whose working sets were recorded under incompatible conventions
    # has no single top estimate; reporting one would be a mislabelled maximum.
    if common_load_convention(counted) is None:
        return None
    estimates = [
        estimate
        for row in counted
        for estimate in (
            estimated_one_rep_max_for_load(
                row.get("weightLbs"),
                row.get("reps"),
                row.get("loadConvention", "unknown"),
            ),
        )
        if estimate is not None
    ]
    return round(max(estimates), 2) if estimates else None
