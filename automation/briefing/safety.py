"""Scoped screening of user-authored safety text.

This module answers one narrow question: does a piece of user-written text
report, as the user's own current experience, something that should stop or
change today's training?

Three things it deliberately does NOT do:

* It does not diagnose. A match is a report to surface, never a condition.
* It does not decide that nothing is wrong. Text this screen does not
  recognize is `unknown`, and the packet exposes it as a citable current
  self-report so the model can still stop on it. See CONSERVATIVE_STOP_POLICY.
* It does not treat somebody else's symptoms as the user's. "My father has
  chest pain" is a fact about the user's father.

The negation, history, recurrence, and resolution handling is the behaviour
that was already in `textutil.has_unresolved_red_flag`, factored out so the new
symptom tiers and the planned-pause detector reuse it unchanged.
"""

from __future__ import annotations

import re
from typing import Any

from .constants import (
    ACUTE_ILLNESS_RE,
    CLAUSE_NEGATION_RE,
    CURRENT_SELF_REPORT_POLICY,
    CONCERNING_COMBINATION_MINIMUM,
    CONCERNING_COMBINATION_TERMS,
    CURRENT_DAY_SCOPE_RE,
    CURRENT_WEEK_SCOPE_RE,
    EMERGENCY_WARNING_RE,
    FIRST_PERSON_PRONOUN_RE,
    FIRST_PERSON_SUBJECT_RE,
    FIRST_PERSON_SYMPTOM_RE,
    INTERROGATIVE_OPENER_RE,
    MAX_REPORTED_SAFETY_TERMS,
    OTHER_DAY_SCOPE_RE,
    PLANNED_DELOAD_RE,
    PLANNED_PAUSE_SUPERSEDED_RE,
    PLANNED_REST_RE,
    REFERENCE_FRAMING_RE,
    REST_RED_FLAG_RE,
    SELF_REPORTED_PROBLEM_RE,
    SAFETY_SCREEN_POLICY,
    THIRD_PARTY_SUBJECT_RE,
)

_COMBINATION_PATTERNS = tuple(
    (key, re.compile(pattern, re.IGNORECASE))
    for key, pattern in CONCERNING_COMBINATION_TERMS
)

# Clause boundaries used only to attribute a symptom to a subject. Sentences are
# split further so "My father has chest pain but I feel fine" does not make the
# whole sentence third-party, and "My father has chest pain and my chest is
# tight too" still reports the user's own symptom.
_CLAUSE_SPLIT_RE = re.compile(
    r"[,;]|\band\b|\bbut\b|\bwhile\b|\bwhereas\b|\balthough\b|\bthough\b",
    re.IGNORECASE,
)


def _clauses(sentence: str) -> list[tuple[int, int]]:
    """(start, end) spans of the sentence's clauses, in order."""
    spans: list[tuple[int, int]] = []
    cursor = 0
    for separator in _CLAUSE_SPLIT_RE.finditer(sentence):
        if separator.start() > cursor:
            spans.append((cursor, separator.start()))
        cursor = separator.end()
    if cursor < len(sentence):
        spans.append((cursor, len(sentence)))
    return spans or [(0, len(sentence))]


def _clause_span_for(sentence: str, start: int) -> tuple[int, int]:
    for span in _clauses(sentence):
        if span[0] <= start < span[1]:
            return span
    return (0, len(sentence))


def _sentences(value: str) -> list[str]:
    return [
        sentence.strip()
        for sentence in re.split(r"[.!?\n]+", value)
        if sentence.strip()
    ]


def _clause_is_third_party(clause: str) -> bool:
    """True when the clause attributes its content to somebody other than the user."""
    if THIRD_PARTY_SUBJECT_RE.search(clause) is None:
        return False
    return FIRST_PERSON_SUBJECT_RE.search(clause) is None


def _match_is_third_party(sentence: str, start: int, end: int) -> bool:
    # The common case has no third-party subject anywhere, so nothing is
    # re-scoped and the historical behaviour is bit-for-bit unchanged.
    del end
    if THIRD_PARTY_SUBJECT_RE.search(sentence) is None:
        return False
    # A coordinated clause with no subject of its own keeps the previous
    # clause's subject: in "My father has chest pain and shortness of breath",
    # the breathlessness is still the father's. Reading that second clause as
    # subjectless is what turned somebody else's symptoms into the user's.
    inherited = False
    for clause_start, clause_end in _clauses(sentence):
        clause = sentence[clause_start:clause_end]
        has_third_party = THIRD_PARTY_SUBJECT_RE.search(clause) is not None
        has_first_person = FIRST_PERSON_SUBJECT_RE.search(clause) is not None
        if has_third_party and not has_first_person:
            inherited = True
        elif has_first_person:
            inherited = False
        if clause_start <= start < clause_end:
            return inherited
    return inherited


def _clause_is_generic_mention(clause: str) -> bool:
    """True when the clause discusses a symptom rather than reporting one."""
    if FIRST_PERSON_SYMPTOM_RE.search(clause) is not None:
        return False
    if REFERENCE_FRAMING_RE.search(clause) is not None:
        return True
    # A bare question with no first-person pronoun at all is a definition
    # request. "Should I train with chest pressure?" keeps its pronoun and is
    # deliberately still treated as a report.
    return (
        INTERROGATIVE_OPENER_RE.search(clause) is not None
        and FIRST_PERSON_PRONOUN_RE.search(clause) is None
    )


def unresolved_matches(
    value: str,
    pattern: re.Pattern[str],
    *,
    exclude_third_party: bool = True,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Matches of `pattern` that read as current, unnegated, and unresolved.

    Returns the surviving matches plus a count of matches dropped only because
    of who or what they were about — somebody else, or a question about a
    symptom rather than a report of one — so callers can say a term was seen
    and scoped away instead of silently losing it.

    Factored verbatim out of the original `has_unresolved_red_flag` so the
    negation, historical-reference, recurrence, and resolution rules stay
    identical for the red-flag lexicon and are shared by the new detectors.
    """
    results: list[dict[str, Any]] = []
    third_party_skipped = 0
    generic_skipped = 0
    sentences = _sentences(value)
    for sentence_index, sentence in enumerate(sentences):
        for match in pattern.finditer(sentence):
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
                    r"and\s+(?:worsen(?:ed|ing)?|(?:is|was|feels?|felt|got)\s+worse)\b)"
                    # "It returned during warm-up today" is a recurrence too. A
                    # few words of circumstance may sit between the verb and the
                    # time marker; "returned to normal/baseline/training" and
                    # "returned home" are still excluded outright.
                    r"|^(?!\s+(?:to\s+(?:normal|baseline|training)|home)\b)"
                    r"(?:\W+\w+){0,6}?\W*"
                    r"\b(?:today|now|again|tonight|"
                    r"this\s+(?:morning|afternoon|evening))\b",
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
            if exclude_third_party and _match_is_third_party(
                sentence, match.start(), match.end()
            ):
                third_party_skipped += 1
                continue
            clause_start, clause_end = _clause_span_for(sentence, match.start())
            if _clause_is_generic_mention(sentence[clause_start:clause_end]):
                generic_skipped += 1
                continue
            results.append(
                {
                    "sentenceIndex": sentence_index,
                    "matchStart": match.start(),
                    "text": match.group(0),
                }
            )
    return results, {
        "thirdParty": third_party_skipped,
        "genericMention": generic_skipped,
    }


def _normalized_terms(matches: list[dict[str, Any]]) -> list[str]:
    seen: list[str] = []
    for item in matches:
        text = item.get("text")
        if not isinstance(text, str):
            continue
        normalized = " ".join(text.lower().split())
        if normalized not in seen:
            seen.append(normalized)
    return seen[:MAX_REPORTED_SAFETY_TERMS]


def has_unresolved_red_flag(value: str) -> bool:
    """Unchanged contract: an urgent, current, first-person red flag."""
    return bool(unresolved_matches(value, REST_RED_FLAG_RE)[0])


def _planned_pause(value: str) -> dict[str, Any] | None:
    """A deliberate non-training day or easy week described for right now."""
    sentences = _sentences(value)
    for kind, pattern in (
        ("planned_rest", PLANNED_REST_RE),
        ("planned_deload", PLANNED_DELOAD_RE),
    ):
        for item in unresolved_matches(value, pattern)[0]:
            sentence_index = item["sentenceIndex"]
            sentence = (
                sentences[sentence_index] if 0 <= sentence_index < len(sentences) else ""
            )
            # Scope is read from the CLAUSE the match sits in, not from anywhere
            # in the sentence. "Today I train; tomorrow is my planned rest day"
            # mentions today, but not in the clause that plans the rest day.
            start, end = _clause_span_for(sentence, item.get("matchStart", 0))
            clause = sentence[start:end]
            # A pause the user has already cancelled, moved, or overridden is
            # not in force. The marker is looked for everywhere in the sentence
            # EXCEPT the matched phrase itself, so both "I canceled my planned
            # rest day" and "…was going to be a rest day, but I moved it" are
            # caught, while "Today is a planned rest day. Resume training
            # tomorrow." is not.
            match_start = item.get("matchStart", 0)
            match_text = item.get("text") or ""
            remainder = (
                sentence[:match_start] + " " + sentence[match_start + len(match_text) :]
            )
            if PLANNED_PAUSE_SUPERSEDED_RE.search(remainder) is not None:
                continue
            same_day = CURRENT_DAY_SCOPE_RE.search(clause) is not None
            same_week = CURRENT_WEEK_SCOPE_RE.search(clause) is not None
            other_day = OTHER_DAY_SCOPE_RE.search(clause) is not None
            if other_day and not (same_day or same_week):
                continue
            return {
                "kind": kind,
                "matchedText": item["text"],
                "scope": (
                    "today" if same_day else "this_week" if same_week else "unscoped"
                ),
            }
    return None


# What the supervisor is willing to say about each screened category. The model
# is told these strings are the ceiling on urgency, never a diagnosis.
GUIDANCE_BY_KIND = {
    "emergency_warning_symptom": "stop_exercise_and_seek_urgent_care",
    "acute_illness": "skip_strenuous_training_ordinary_care",
    "concerning_combination": "stop_the_session_and_check_before_continuing",
    "unclassified_current_complaint": "judge_it_with_the_user_do_not_diagnose",
}

def current_self_report_scope(value: Any) -> dict[str, Any]:
    """Is this text the user describing themselves, right now, affirmatively?

    Deliberately keyword-free. Whether a report is the user's own, current, and
    affirmative is a question about grammar and dates, which the supervisor can
    actually answer. What the report MEANS medically is not, and no lexicon
    will ever be exhaustive — "I am seeing stars and my legs buckled" and "I
    just coughed up blood" match no symptom list here and are obviously reasons
    to stop.

    So this is the structural route: a clause that is first-person, not scoped
    to another day, not a question or a quotation, not about somebody else, and
    not itself a negation, makes the atom citable for a conservative stop. It
    permits the model to stop; it never forces it, and it never blocks a push
    on its own.
    """
    if not isinstance(value, str) or not value.strip():
        return {
            "eligible": False,
            "eligibleClauseCount": 0,
            "policy": CURRENT_SELF_REPORT_POLICY,
        }
    eligible = 0
    for sentence in _sentences(value):
        inherited_third_party = False
        inherited_first_person = False
        for clause_start, clause_end in _clauses(sentence):
            clause = sentence[clause_start:clause_end]
            has_third_party = THIRD_PARTY_SUBJECT_RE.search(clause) is not None
            has_self = FIRST_PERSON_SUBJECT_RE.search(clause) is not None
            if has_third_party and not has_self:
                inherited_third_party = True
                inherited_first_person = False
                continue
            if has_self:
                inherited_third_party = False
                inherited_first_person = True
            elif inherited_third_party:
                continue
            if not (has_self or inherited_first_person):
                continue
            if _clause_is_generic_mention(clause):
                continue
            if (
                OTHER_DAY_SCOPE_RE.search(clause) is not None
                and CURRENT_DAY_SCOPE_RE.search(clause) is None
                and CURRENT_WEEK_SCOPE_RE.search(clause) is None
            ):
                continue
            if CLAUSE_NEGATION_RE.search(clause) is not None:
                continue
            eligible += 1
    return {
        "eligible": eligible > 0,
        "eligibleClauseCount": eligible,
        "policy": CURRENT_SELF_REPORT_POLICY,
    }


_EMPTY_CLASSIFICATION = {
    "kind": None,
    "unresolvedRedFlag": False,
    "guidance": None,
    "terms": [],
    "combinationTerms": [],
    "thirdPartyOnlyMatchCount": 0,
    "genericMentionOnlyMatchCount": 0,
    "plannedPause": None,
    "currentSelfReport": {
        "eligible": False,
        "eligibleClauseCount": 0,
        "policy": CURRENT_SELF_REPORT_POLICY,
    },
    "screenPolicy": SAFETY_SCREEN_POLICY,
}


def classify_safety_text(value: Any) -> dict[str, Any]:
    """Screen one piece of user-authored text.

    `kind` is one of:

    * `emergency_warning_symptom` — a current first-person report from the
      emergency lexicon. Stopping exercise and seeking urgent care is
      proportionate advice; naming a condition is not.
    * `acute_illness` — a current infection or fever. A reason not to train
      hard today, NOT a reason to send somebody to urgent care.
    * `concerning_combination` — two or more distinct accompanying symptom
      domains reported together. A conservative screening heuristic: enough to
      stop and check, not a finding about what is happening.
    * `null` — this screen recognized nothing. That is `unknown`, not "fine",
      and the packet still exposes the report as citable current evidence.
    """
    if not isinstance(value, str) or not value.strip():
        return dict(_EMPTY_CLASSIFICATION)
    emergency, emergency_skipped = unresolved_matches(value, EMERGENCY_WARNING_RE)
    illness, illness_skipped = unresolved_matches(value, ACUTE_ILLNESS_RE)
    combination_keys: list[str] = []
    skipped_totals = {
        key: max(emergency_skipped[key], illness_skipped[key])
        for key in ("thirdParty", "genericMention")
    }
    for key, pattern in _COMBINATION_PATTERNS:
        matches, skipped = unresolved_matches(value, pattern)
        skipped_totals = {
            name: max(skipped_totals[name], skipped[name])
            for name in skipped_totals
        }
        if matches:
            combination_keys.append(key)
    complaint, complaint_skipped = unresolved_matches(
        value, SELF_REPORTED_PROBLEM_RE
    )
    skipped_totals = {
        name: max(skipped_totals[name], complaint_skipped[name])
        for name in skipped_totals
    }
    kind: str | None = None
    if emergency:
        kind = "emergency_warning_symptom"
    elif illness:
        kind = "acute_illness"
    elif len(combination_keys) >= CONCERNING_COMBINATION_MINIMUM:
        kind = "concerning_combination"
    elif complaint:
        # Something is currently wrong and this screen does not know what. That
        # is a real state to surface, not an absence of evidence.
        kind = "unclassified_current_complaint"
    return {
        "kind": kind,
        # Unchanged meaning: a current, unresolved report that should stop
        # today's hard training. Both urgent tiers set it; a combination does
        # not, so the existing rest gate keeps its original bar.
        "unresolvedRedFlag": bool(emergency or illness),
        "guidance": GUIDANCE_BY_KIND.get(kind) if kind is not None else None,
        "terms": _normalized_terms([*emergency, *illness, *complaint]),
        "combinationTerms": combination_keys[:MAX_REPORTED_SAFETY_TERMS],
        "thirdPartyOnlyMatchCount": skipped_totals["thirdParty"],
        "genericMentionOnlyMatchCount": skipped_totals["genericMention"],
        "plannedPause": _planned_pause(value),
        "currentSelfReport": current_self_report_scope(value),
        "screenPolicy": SAFETY_SCREEN_POLICY,
    }
