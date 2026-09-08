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
    REST_RED_FLAG_RE,
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

def has_unresolved_red_flag(value: str) -> bool:
    sentences = [
        sentence.strip()
        for sentence in re.split(r"[.!?\n]+", value)
        if sentence.strip()
    ]
    for sentence_index, sentence in enumerate(sentences):
        for match in REST_RED_FLAG_RE.finditer(sentence):
            prefix = sentence[max(0, match.start() - 80) : match.start()]
            suffix = sentence[match.end() : min(len(sentence), match.end() + 80)]
            next_sentence_raw = (
                sentences[sentence_index + 1][:120]
                if sentence_index + 1 < len(sentences)
                else ""
            )
            next_sentence_has_transition = re.search(
                r"\b(?:return(?:ed|s|ing)?|recur(?:red|s|ring)?|"
                r"(?:came|come)\s+back|back\s+again|persists?|"
                r"worsen(?:ed|ing)?|resolved|gone|cleared|recovered|"
                r"better\s+now|ruled\s+out)\b",
                next_sentence_raw,
                re.IGNORECASE,
            )
            next_sentence_subject = re.match(
                r"^(?:it|this|that|they|symptoms?|"
                r"(?:the|my)\s+(?:pain|symptoms?|issue|problem))\b",
                next_sentence_raw,
                re.IGNORECASE,
            )
            pronoun_return = re.match(
                r"^(?:it|this|that|they)\s+return(?:ed|s|ing)?\b(?P<tail>.*)$",
                next_sentence_raw,
                re.IGNORECASE,
            )
            pronoun_return_is_recurrence = (
                pronoun_return is None
                or re.match(
                    r"^\s*(?:$|today\b|again\b|now\b|yesterday\b|overnight\b|"
                    r"this\s+(?:morning|afternoon|evening)\b|last\s+night\b|"
                    r"and\s+(?:worsen(?:ed|ing)?|(?:is|was|feels?|felt|got)\s+worse)\b)",
                    pronoun_return.group("tail"),
                    re.IGNORECASE,
                )
                is not None
            )
            next_sentence = (
                next_sentence_raw
                if next_sentence_has_transition is not None
                and next_sentence_subject is not None
                and pronoun_return_is_recurrence
                else ""
            )
            forward_context = f"{suffix} {next_sentence}".strip()
            recurrence = None
            negated_absence_recurrence = False
            for candidate in re.finditer(
                r"\b(?:return(?:ed|s|ing)?|recur(?:red|s|ring)?|"
                r"(?:came|come)\s+back|"
                r"back\s+again|persists?|worsen(?:ed|ing)?)\b",
                forward_context,
                re.IGNORECASE,
            ):
                recurrence_text = candidate.group(0).lower()
                recurrence_suffix = forward_context[
                    candidate.end() : min(len(forward_context), candidate.end() + 40)
                ]
                if recurrence_text.startswith("return") and re.match(
                    r"^\s+(?:to\s+(?:normal|baseline|training)\b|home\b)",
                    recurrence_suffix,
                    re.IGNORECASE,
                ):
                    continue
                recurrence_prefix = forward_context[
                    max(0, candidate.start() - 48) : candidate.start()
                ]
                local_recurrence_prefix = re.split(
                    r"\b(?:but|however|although|yet)\b",
                    recurrence_prefix,
                    flags=re.IGNORECASE,
                )[-1]
                if re.search(
                    r"\b(?:no|not|never|have\s+not|haven['’]t|"
                    r"has\s+not|hasn['’]t|had\s+not|"
                    r"hadn['’]t|did\s+not|didn['’]t|without)\b"
                    r"(?:\W+\w+){0,3}\W*$",
                    local_recurrence_prefix,
                    re.IGNORECASE,
                ):
                    if recurrence_text.startswith(
                        ("return", "recur", "came back", "come back", "back again")
                    ):
                        negated_absence_recurrence = True
                    continue
                recurrence = candidate
                break
            local_prefix = re.split(
                r"\b(?:but|however|although|yet)\b",
                prefix,
                flags=re.IGNORECASE,
            )[-1]
            if recurrence is None and re.search(
                r"\b(?:no|not|never|without|do\s+not|don['’]t|does\s+not|"
                r"doesn['’]t|did\s+not|didn['’]t|have\s+not|haven['’]t|"
                r"has\s+not|hasn['’]t|"
                r"had\s+not|hadn['’]t|den(?:y|ies|ied)|"
                r"no\s+longer|negative\s+for|history\s+of|"
                r"previous(?:ly)?|prior|yesterday|last\s+(?:week|month)|"
                r"earlier|\w+\s+ago)\b(?:\W+\w+){0,5}\W*$",
                local_prefix,
                re.IGNORECASE,
            ):
                continue
            historical_after_match = re.match(
                r"^\W*(?:yesterday|last\s+(?:week|month)|earlier|"
                r"\d+\s+(?:days?|weeks?|months?)\s+ago)\b",
                suffix,
                re.IGNORECASE,
            )
            if recurrence is None and historical_after_match is not None:
                continue
            if recurrence is None and negated_absence_recurrence:
                continue
            resolved = re.search(
                r"(?:\b(?:resolved|gone|cleared|recovered|better\s+now|ruled\s+out)\b|"
                r"\breturn(?:ed|s|ing)?\s+to\s+(?:normal|baseline)\b|"
                r"[-\s]free\b)",
                forward_context,
                re.IGNORECASE,
            )
            if (
                resolved is not None
                and (recurrence is None or resolved.start() > recurrence.start())
                and not re.search(
                    r"\bnot\s+(?:resolved|gone|cleared|recovered|better)\b",
                    forward_context[: resolved.end()],
                    re.IGNORECASE,
                )
            ):
                continue
            return True
    return False

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
