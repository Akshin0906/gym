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


def load_conventions_comparable_for_progression(left: Any, right: Any) -> bool:
    """Stricter than `load_conventions_comparable`, for progression claims.

    Reading a legacy row as total pounds is the right DESCRIPTIVE default: it
    is what every existing chart already assumed. It is not a safe basis for
    telling somebody to add load. An old unrecorded 20 may well have been 20
    per dumbbell, and pairing it with a new explicit 40 lb total reads as
    doubled strength when nothing changed.

    So "unknown" is comparable only with "unknown", and the assumption is
    reported rather than acted on. There is no conversion, and none is ever
    inferred.
    """
    return load_convention(left) == load_convention(right)


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

def rep_attainment_counts(
    rep_range: tuple[int, int] | None, reps: list[int]
) -> dict[str, int]:
    """How the logged reps sat against the plan's band.

    Adherence only. A set above the upper bound is not a failure to measure —
    it is more work at the same load — and a set below the lower bound is still
    a real observation, so both are counted rather than used to discard the
    exposure.
    """
    if rep_range is None:
        return {"belowTargetMinimum": 0, "inTargetRange": 0, "aboveTargetMaximum": 0}
    low, high = rep_range
    return {
        "belowTargetMinimum": sum(1 for value in reps if value < low),
        "inTargetRange": sum(1 for value in reps if low <= value <= high),
        "aboveTargetMaximum": sum(1 for value in reps if value > high),
    }

def comparator_completion(
    historical_plan: dict[str, Any] | None,
    rows: list[dict[str, Any]],
    *,
    unfinished_work: dict[str, Any] | None = None,
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
    every_set_has_reps = len(counted) > 0 and len(valid_reps) == len(counted)
    all_reps_in_range = (
        rep_range is not None
        and every_set_has_reps
        and all(rep_range[0] <= reps <= rep_range[1] for reps in valid_reps)
    )
    attainment = rep_attainment_counts(rep_range, valid_reps)
    completed_target_sets = target_sets is not None and len(counted) >= target_sets
    # Readiness to ADD LOAD. Every planned working set was completed and no set
    # fell short of the target's lower bound. Reps ABOVE the upper bound do not
    # disqualify it: three sets of 13 at the same load is more work than three
    # of 12, not less measurable. Requiring the upper bound too is what made an
    # improved session lose its own progression evidence.
    progression_ready_before_comparability = (
        rep_range is not None
        and completed_target_sets
        and every_set_has_reps
        and attainment["belowTargetMinimum"] == 0
    )
    # Whether this exposure can be COMPARED with another exposure of the same
    # movement at all — in either direction. Short or below-target work is the
    # evidence a decline is made of, so it stays comparable and carries its own
    # uncertainty instead of being filtered out.
    observation_reasons: list[str] = []
    if not every_set_has_reps:
        observation_reasons.append("logged_reps_missing")
    if common_load_convention(counted) is None:
        observation_reasons.append("mixed_load_conventions_within_exposure")
    # Whatever makes an exposure uncomparable also makes it unusable as
    # evidence of readiness to progress. Keeping the boolean and its reasons
    # derived from the same list stops them from disagreeing, even though the
    # mode contract independently blocks a mixed-unit exposure as well.
    progression_reasons: list[str] = list(observation_reasons)
    if rep_range is None:
        progression_reasons.append("no_parsed_target_rep_range")
    if not completed_target_sets:
        progression_reasons.append("target_sets_not_completed")
    if attainment["belowTargetMinimum"]:
        progression_reasons.append("logged_reps_below_target_minimum")
    # Why the work fell short, when the user said. A time or equipment
    # interruption is not the same observation as work that got harder, and
    # neither is a fatigue finding.
    shortfall_context = None
    if not completed_target_sets or attainment["belowTargetMinimum"]:
        shortfall_context = {
            "belowTargetMinimumSetCount": attainment["belowTargetMinimum"],
            "missingTargetSetCount": (
                max(0, target_sets - len(counted)) if target_sets is not None else None
            ),
            "userReportedReason": (
                unfinished_work.get("reason")
                if isinstance(unfinished_work, dict)
                else None
            ),
            "interpretation": "cause_unknown_unless_user_reported",
        }
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
        # Kept for compatibility and for honest adherence reporting. It is no
        # longer the gate for anything: adherence, readiness to progress, and
        # comparability are three different questions.
        "allLoggedSetRepsInTargetRange": all_reps_in_range,
        "repAttainmentCounts": attainment,
        "eligibleForProgressionTrend": (
            progression_ready_before_comparability and not progression_reasons
        ),
        "progressionIneligibilityReasons": progression_reasons,
        "eligibleForComparableObservation": not observation_reasons,
        "observationIneligibilityReasons": observation_reasons,
        **(
            {"shortfallContext": shortfall_context}
            if shortfall_context is not None
            else {}
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

def one_rep_max_estimate_context(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """How much weight the Epley estimate can carry for this group of sets.

    Epley is a descriptive rearrangement of load and reps. It has no term for
    effort, so two sets of the same load and reps produce the same estimate
    whether the last rep was comfortable or a grind, and repetition-based
    estimates depend on the individual's strength-endurance profile and on
    standardized conditions (Mitter 2022). The error grows with rep count.
    This function reports those limits with the number instead of leaving the
    reader to assume the estimate is a measurement.
    """
    counted = working_sets(rows)
    reps = [
        value
        for row in counted
        for value in (positive_integer(row.get("reps")),)
        if value is not None
    ]
    highest = max(reps) if reps else None
    effort_recorded = sum(1 for row in counted if finite_number(row.get("rpe")))
    # Heuristic flags, deliberately NOT confidence bands. Prediction accuracy
    # varies with reps, effort, exercise, and the individual's own
    # strength-endurance profile, and there is no calibrated error curve for
    # this user — so naming a rep count at which the estimate becomes
    # "unreliable" would swap one false precision for another.
    flags: list[str] = []
    if highest is not None and highest >= 10:
        flags.append("many_reps_extrapolated_from")
    if effort_recorded == 0 and counted:
        flags.append("no_set_effort_recorded")
    elif counted and effort_recorded < len(counted):
        flags.append("set_effort_partially_recorded")
    if 1 in reps:
        # A logged single is a load moved for one rep. It is only a maximum if
        # it was actually taken near the limit, which the row does not say.
        flags.append("single_rep_set_is_a_load_not_a_verified_maximum")
    return {
        "estimator": "epley",
        "highestRepCountUsed": highest,
        "workingSetCount": len(counted),
        "setRpeRecordedCount": effort_recorded,
        "effortAccountedFor": False,
        "heuristicFlags": flags,
        "flagPolicy": "heuristic_flags_not_calibrated_error_bands_v1",
        "limitation": "descriptive_estimate_not_proof_of_recovery_or_fatigue",
    }


def ordinal_progress_marker(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    """A comparable progress reading for loads that have no valid e1RM.

    A machine pin number, an added-bodyweight figure, and an assistance weight
    are not external loads, so turning them into an estimated one-rep max
    invents a number. They are still ordered: for assistance, LESS is harder.

    The honest comparison is same-setting reps — at an identical recorded
    setting, more reps is more work — so this returns the hardest setting the
    group reached and the best rep count achieved at exactly that setting.
    Callers must only compare exposures whose `loadValue` is identical.
    """
    counted = working_sets(rows)
    convention = common_load_convention(counted)
    if convention is None:
        return None
    semantics = load_semantics(convention)
    candidates = [
        (float(row["weightLbs"]), reps)
        for row in counted
        for reps in (positive_integer(row.get("reps")),)
        if reps is not None and finite_number(row.get("weightLbs"))
    ]
    if not candidates:
        return None
    higher_is_harder = semantics["higherIsHarder"]
    hardest_load = (
        max(item[0] for item in candidates)
        if higher_is_harder
        else min(item[0] for item in candidates)
    )
    best_reps = max(reps for load, reps in candidates if load == hardest_load)
    return {
        "metric": "best_working_set_reps_at_hardest_recorded_setting",
        "convention": convention,
        "loadValue": hardest_load,
        "repsAtLoadValue": best_reps,
        "direction": "higher_is_harder" if higher_is_harder else "lower_is_harder",
        "comparability": "only_against_an_identical_recorded_setting",
    }


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
