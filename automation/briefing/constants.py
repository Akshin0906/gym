"""Version markers, prompt/packet budgets, and safety regexes.

Every limit the supervisor enforces lives here so a budget change is a one-line
review rather than a search through the orchestration code."""

from __future__ import annotations

import datetime as dt
import re
import signal
from zoneinfo import ZoneInfo


# 3.10 repairs the prompt-budget arithmetic: the evidence allowance is derived
# from the measured prompt scaffold rather than assumed. A 3.9 spool is
# therefore not reusable, and `validate_spool` rejects it on this marker.
RUNNER_VERSION = "3.10"

PROMPT_VERSION = "2026-09-08-shared-evidence-guide-v1"

VALIDATOR_COMPATIBILITY_VERSION = "2026-09-08-scoped-safety-and-comparability-v8"

# The curated, dated, source-linked guidance appended to BOTH runtime prompts.
# Neither runtime model has browsing or tools, so anything not shipped in that
# file does not reach them. The version travels in briefing metadata and the
# chat heartbeat, and the file's bytes are folded into each prompt hash.
EVIDENCE_GUIDE_VERSION = "2026-09-08-shared-evidence-guide-v1"

EVIDENCE_GUIDE_FILENAME = "evidence_guide.md"

EVIDENCE_GUIDE_HEADING = "## Shared training-evidence guide (curated, versioned)"

EVIDENCE_GUIDE_MAX_BYTES = 32_768

DEFAULT_CODEX_MODEL = "gpt-6-astra"

DEFAULT_CODEX_REASONING_EFFORT = "high"

PACIFIC = ZoneInfo("America/Los_Angeles")

MODES = {"push", "normal", "light", "deload", "rest"}

RECOVERY_STATUSES = {"fresh", "stale", "unavailable"}

RECOVERY_FRESHNESS_POLICY = "pacific_day_v1"

RECOVERY_FINGERPRINT_VERSION = "sanitized-recovery-v1"

RECOVERY_DIAGNOSTIC_FIELDS = (
    "recoveryStatus",
    "recoveryFreshnessPolicy",
    "recoveryEvaluationDate",
    "recoveryReadinessDay",
    "recoverySleepDay",
)

MEMORY_TYPES = {"workout", "two_week", "four_month"}

MAX_SAFE_INTEGER = 9_007_199_254_740_991

TERMINATION_SIGNALS = frozenset({signal.SIGINT, signal.SIGTERM})

BRIEFING_HEADLINE_MAX = 80

BRIEFING_TODAYS_CALL_MAX = 280

BRIEFING_REASON_MAX = 220

BRIEFING_RECOVERY_MAX = 180

BRIEFING_TREND_MAX = 200

BRIEFING_WATCH_OUT_MAX = 220

MODEL_WATCH_OUT_MAX = 1

SNAPSHOT_WARNING_AFTER = dt.timedelta(hours=48)

MODEL_SYNC_WARNING_MARKERS = (
    "last synced",
    "open the app to sync",
    "sync before relying",
    "workout data may be stale",
)

# Ceiling on the serialized evidence packet. The allowance actually used is
# DERIVED per run from what the rendered prompt costs (see
# `model_input_packet_budget` in daily_briefing_runner.py) and is never larger
# than this. Treating this number as the real allowance is what broke the
# 3.9 release: the static prompt grew past 44 KB, and 44 KB of scaffold plus a
# packet filled to 48 KB is 92 KB against an 81,920-byte prompt budget.
MODEL_INPUT_PACKET_MAX_BYTES = 48_000

MODEL_PROMPT_MAX_BYTES = 81_920

BRIEFING_EVIDENCE_PACKET_VERSION = "briefing-evidence-v3"

MEMORY_SOURCE_PACKET_VERSION = "memory-sources-v2"

RECENT_SESSION_EPISODE_LIMIT = 3

COMPARABLE_EXPOSURE_LIMIT = 3

OLDER_PERIODIC_SUMMARY_LIMIT = 4

RECENT_GENERAL_NOTE_LIMIT = 5

RECENT_SAFETY_NOTE_LIMIT = 8

MAX_WORKOUT_MEMORY_CANDIDATES = 8

MAX_MEMORY_NOTES_PER_CANDIDATE = 8

MAX_MEMORY_SESSION_SOURCES_PER_CANDIDATE = 8

MAX_MEMORY_SUMMARY_SOURCES_PER_CANDIDATE = 8

MAX_PERIODIC_MEMORY_NOTES_PER_CANDIDATE = 2

MAX_PERIODIC_DIGEST_EXERCISES = 6

MAX_PERIODIC_DIGEST_SESSION_SAMPLES = 4

MAX_MEMORY_SOURCE_SUMMARY_BULLETS = 1

MEMORY_SOURCE_SUMMARY_BULLET_MAX_CHARS = 200

TWO_WEEK_PERIOD_DAYS = 14

FOUR_MONTH_ROLLUP_PERIOD_COUNT = 8

MAX_RETAINED_SUMMARY_BULLETS = 4

MAX_RETAINED_SETS_PER_EXERCISE = 4

MAX_RETAINED_EXERCISES_PER_EPISODE = 8

MAX_RETAINED_CURRENT_PLAN_EXERCISES = 16

RECENT_ADVERSE_WINDOW_DAYS = 7

PERFORMANCE_COMPARATOR_WINDOW_DAYS = 90

DELOAD_MIN_TOTAL_DECLINE_FRACTION = 0.03

SESSION_EPISODE_MAX_BYTES = 4_000

CURRENT_PROGRAMMED_SESSION_MAX_BYTES = 7_000

NOTE_EXCERPT_MAX_CHARS = 400

CURRENT_CONTEXT_EXCERPT_MAX_CHARS = 1_400

SUMMARY_BULLET_EXCERPT_MAX_CHARS = 600

DISPLAY_TEXT_EXCERPT_MAX_CHARS = 180

SAFETY_CONTEXT_RE = re.compile(
    r"\b(?:pain|painful|injur(?:y|ed|ies)|ill(?:ness)?|sick|fever|faint(?:ed|ing)?|"
    r"dizz(?:y|iness)|chest|shortness\s+of\s+breath|breath(?:ing|less)|"
    r"pass(?:ed|ing)?\s+out|concussion|fracture|sprain|strain|"
    r"tear|torn|bleed(?:ing)?|numb(?:ness)?|tingl(?:e|ing)|swelling|swollen|"
    r"flu|influenza|covid(?:-?19)?|vomit(?:ed|ing|s)?|"
    r"surgery|medical|doctor|urgent|emergency)\b",
    re.IGNORECASE,
)

# Two different things used to sit in one list, and the supervisor treated them
# identically: symptoms that warrant stopping and seeking urgent care, and an
# ordinary acute illness that warrants not training hard today. Telling somebody
# with the flu to seek urgent care is not proportionate, and it is not what the
# evidence in automation/evidence_guide.md supports.
#
# Emergency-warning tier. The American Heart Association's warning-signs page
# lists chest PRESSURE, squeezing, fullness, or discomfort — not only the word
# "pain" — so those wordings belong here; the earlier list matched "chest pain"
# alone and read "crushing chest pressure" as ordinary text.
#
# This is a keyword screen, not a medical assessment. It exists to make the
# supervisor fail safe, never to decide that nothing is wrong: an unmatched
# current report is `unknown`, and CONSERVATIVE_STOP_POLICY below is what lets
# the model act on one anyway.
_EMERGENCY_WARNING_PATTERN = (
    r"\b(?:chest\s+pain|faint(?:ed|ing)?|severe\s+dizz(?:y|iness)|"
    r"severe\s+pain|unexplained\s+pain|"
    r"pass(?:ed|ing)?\s+out|"
    r"shortness\s+of\s+breath|cannot\s+breathe|can't\s+breathe|"
    r"difficulty\s+breathing|medical\s+emergency)\b"
    r"|\bchest\s+(?:pressure|tightness|tightening|squeez(?:e|ing)|"
    r"heaviness|discomfort|fullness)\b"
    r"|\b(?:pressure|tightness|squeezing|heaviness|discomfort|fullness)"
    r"\s+(?:in|across|on)\s+(?:my\s+|the\s+)?chest\b"
    r"|\bchest\s+(?:feels?|felt|is|was|got|going)\s+(?:really\s+|very\s+)?"
    r"(?:tight|heavy|crushing)\b"
    r"|\bcrushing\s+(?:chest|pressure|sensation)\b"
    r"|\bslurred\s+speech\b"
    r"|\bnumbness\s+(?:on|down|in)\s+one\s+side\b"
    r"|\bweakness\s+on\s+one\s+side\b"
)

EMERGENCY_WARNING_RE = re.compile(_EMERGENCY_WARNING_PATTERN, re.IGNORECASE)

# Acute-illness tier. A current infection is a good reason to skip strenuous
# training and a bad reason to be told to seek urgent care.
_ACUTE_ILLNESS_PATTERN = (
    r"\b(?:fever|acute\s+illness|flu|influenza|"
    r"covid(?:-?19)?|vomit(?:ed|ing|s)?)\b"
)

ACUTE_ILLNESS_RE = re.compile(_ACUTE_ILLNESS_PATTERN, re.IGNORECASE)

# The union keeps the original name and the original meaning — "a current,
# unresolved report that should stop today's hard training" — so every existing
# caller, excerpt focus, and test keeps behaving the same way.
REST_RED_FLAG_RE = re.compile(
    f"{_EMERGENCY_WARNING_PATTERN}|{_ACUTE_ILLNESS_PATTERN}",
    re.IGNORECASE,
)

# Symptoms the AHA lists as accompanying warning signs. None is, alone, a
# reason to stop training. Two or more DISTINCT domains reported together as
# the user's own current experience are surfaced as a concerning combination
# rather than averaged away.
#
# The domains are deliberately coarse: "lightheaded" and "dizzy" are two words
# for one description and share a domain, so a note saying both does not
# manufacture two independent signals. The two-domain threshold is a
# conservative product screening heuristic, not a validated classifier.
CONCERNING_COMBINATION_TERMS = (
    (
        "lightheaded_or_dizzy",
        r"\blight[-\s]?headed(?:ness)?\b|\bdizz(?:y|iness)\b",
    ),
    ("breathless", r"\bbreathless(?:ness)?\b|\bshort\s+of\s+breath\b"),
    ("nausea", r"\bnause(?:a|ous|ated)\b"),
    ("cold_sweat", r"\bcold\s+sweat(?:s|ing)?\b|\bclammy\b"),
    (
        "palpitations",
        r"\bpalpitations?\b|\bheart\s+(?:racing|pounding)\b"
        r"|\bracing\s+heart\b",
    ),
    (
        "radiating_discomfort",
        r"\bradiat(?:ing|es|ed)\s+(?:to|into|down)?\s*"
        r"(?:my\s+|the\s+)?(?:jaw|arm|arms|neck|shoulder|back)\b"
        r"|\b(?:jaw|arm|neck)\s+(?:pain|discomfort|tightness)\s+"
        r"(?:that\s+)?radiat\w*\b",
    ),
    (
        "unusual_exertional_fatigue",
        r"\bunusual(?:ly)?\s+(?:tired|fatigued|winded|breathless|"
        r"out\s+of\s+breath)\b",
    ),
)

CONCERNING_COMBINATION_MINIMUM = 2

# A current, first-person physical complaint that neither urgent tier covers.
# This is what makes the conservative stop route real: the model can act on
# "my knee gave way during warm-up" without the supervisor pretending to know
# what it is, and without a keyword list having to anticipate every wording.
#
# Ordinary training soreness is deliberately absent. Being sore is the normal
# result of training, not a reason to treat a note as a safety report.
SELF_REPORTED_PROBLEM_RE = re.compile(
    r"\b(?:pain|painful|ache|aching|aches|hurts?|hurting|"
    r"sharp\s+\w+|swell(?:ing|ed)|swollen|numb(?:ness)?|tingl(?:e|ing)|"
    r"strain(?:ed)?|sprain(?:ed)?|tear|torn|pulled\s+\w+|pop(?:ped)?|"
    r"giving\s+way|gave\s+way|gave\s+out|locked\s+up|"
    r"injur(?:y|ed|ies)|unwell|sick|nauseous|dizzy|"
    r"headache|migraine|cramp(?:ing|s)?|spasm(?:s|ing)?|"
    r"flare[-\s]?up|flared\s+up|inflamed|"
    r"something\s+(?:feels|felt)\s+(?:wrong|off)|"
    r"(?:can(?:not|'t)|could\s*n[o']t)\s+(?:lift|move|walk|straighten|bend|grip))\b",
    re.IGNORECASE,
)

# Family, friends, and clients get talked about in training notes. A symptom
# attributed to somebody else is not the user's red flag, and treating it as one
# produced an urgent stop recommendation from "My father has chest pain."
THIRD_PARTY_RELATION = (
    r"(?:father|dad|mother|mom|mum|wife|husband|spouse|partner|brother|"
    r"sister|son|daughter|friend|buddy|coworker|co-worker|colleague|client|"
    r"roommate|neighbou?r|uncle|aunt|cousin|grandfather|grandmother|grandpa|"
    r"grandma|boss|trainer|teammate|training\s+partner|parent|kid|child)"
)

THIRD_PARTY_SUBJECT_RE = re.compile(
    rf"\b(?:my|his|her|their|our)\s+{THIRD_PARTY_RELATION}\b"
    r"|\b(?:he|she|they)\s+(?:has|have|had|is|was|were|reported|reports|"
    r"complained|complains|felt|feels|got|develops?|developed)\b",
    re.IGNORECASE,
)

FIRST_PERSON_SUBJECT_RE = re.compile(
    r"\bI\b|\bI['’](?:m|ve|d|ll)\b|\bmyself\b|\bme\b"
    rf"|\bmy\b(?!\s+{THIRD_PARTY_RELATION}\b)",
    re.IGNORECASE,
)

# Deliberate non-training days and planned easy weeks. These are ordinary
# programming, not illness, and the supervisor previously had no way to
# represent one: a "planned rest day" produced no evidence at all and could not
# stop a push recommendation.
PLANNED_REST_RE = re.compile(
    r"\b(?:planned|scheduled|programmed|deliberate)\s+"
    r"(?:rest|off|recovery)\s+day\b"
    r"|\brest\s+day\b"
    r"|\bday\s+off\b"
    r"|\bnot\s+(?:training|lifting)\s+today\b"
    r"|\bno\s+(?:training|lifting|workout|gym)\s+today\b"
    r"|\btaking\s+(?:today|the\s+day)\s+off\b",
    re.IGNORECASE,
)

PLANNED_DELOAD_RE = re.compile(
    r"\bdeload\s+(?:week|block|phase|day)\b"
    r"|\bplanned\s+deload\b"
    r"|\bscheduled\s+deload\b"
    r"|\beasy\s+week\b"
    r"|\bback[-\s]?off\s+week\b",
    re.IGNORECASE,
)

# A plan the user has already called off, moved, or replaced is not today's
# plan. "Today I canceled my planned rest day" still contains the words
# "planned rest day"; acting on them would override an explicit decision.
PLANNED_PAUSE_SUPERSEDED_RE = re.compile(
    r"\b(?:cancel(?:s|ed|led|ling|ing)?|call(?:ed|ing)?\s+off|"
    r"skipp?(?:ed|ing)?|mov(?:e|ed|ing)|reschedul(?:e|ed|ing)|"
    r"push(?:ed|ing)?\s+(?:it\s+)?(?:back|to)|swap(?:ped|ping)?|"
    r"drop(?:ped|ping)?|scrap(?:ped|ping)?|"
    r"no\s+longer|instead\s+of|changed\s+my\s+mind|"
    r"(?:was|were)\s+going\s+to|"
    r"will\s+(?:still\s+)?train|training\s+as\s+programmed|"
    r"train(?:ing)?\s+anyway)\b",
    re.IGNORECASE,
)

# A planned pause described for another day is not today's plan. Weekday names
# count: "Last Tuesday was my planned rest day" is a fact about last Tuesday.
OTHER_DAY_SCOPE_RE = re.compile(
    r"\b(?:tomorrow|next\s+(?:week|month)|yesterday|last\s+(?:week|month)|"
    r"previous(?:ly)?|prior|earlier|\w+\s+ago)\b"
    r"|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b"
    r"|\b(?:was|were)\s+(?:my|a|the|an)\b",
    re.IGNORECASE,
)

# Words that pin a statement to right now. Checked inside the matched clause,
# not anywhere in the sentence: "Today I train; tomorrow is my planned rest day"
# has a `today` token, but not in the clause that describes the rest day.
CURRENT_DAY_SCOPE_RE = re.compile(
    r"\b(?:today|right\s+now|currently|this\s+morning|tonight)\b",
    re.IGNORECASE,
)

CURRENT_WEEK_SCOPE_RE = re.compile(r"\bthis\s+week\b", re.IGNORECASE)

# Talking ABOUT a symptom is not reporting one. "I read that chest pressure is
# a warning sign" and "What does chest pressure mean?" are questions and
# quotations, not the user's current experience.
REFERENCE_FRAMING_RE = re.compile(
    r"\b(?:read|reading|heard|hearing|saw|seen|learned|learnt|googled|"
    r"searched|looked\s+up|was\s+told|article|video|podcast)\b"
    r"|\b(?:is|are|can\s+be|could\s+be|may\s+be)\s+(?:a|an)\s+"
    r"(?:warning\s+sign|symptom|red\s+flag|sign|indicator)\b"
    r"|\bwhat\s+(?:does|do|is|are)\b"
    r"|\bmeans?\b",
    re.IGNORECASE,
)

INTERROGATIVE_OPENER_RE = re.compile(
    r"^\s*(?:what|why|how|when|where|who|which|does|do|did|is|are|was|were|"
    r"can|could|should|would|will)\b",
    re.IGNORECASE,
)

# A first-person claim of experiencing something right now. Reading, hearing,
# and asking about a symptom are deliberately NOT in this list.
FIRST_PERSON_SYMPTOM_RE = re.compile(
    r"\bI\s*(?:'m|’m|\s+am|\s+have|\s+had|\s+feel|\s+felt|\s+get|\s+got|"
    r"\s+experience[ds]?|\s+woke|\s+notice[d]?|\s+develop(?:ed)?|"
    r"\s+started|\s+keep|\s+kept|\s+was|\s+been|\s+ve)\b"
    r"|\bmy\s+(?:chest|breathing|heart|head|symptoms?)\b"
    r"|\bfeeling\b",
    re.IGNORECASE,
)

FIRST_PERSON_PRONOUN_RE = re.compile(
    r"\b(?:I|my|me|myself)\b", re.IGNORECASE
)

# Whether a clause NEGATES what it says, as a grammatical property rather than
# a medical one. "I haven't vomited today" and "I tested negative for COVID"
# are statements that nothing is wrong; they should not open a stop route.
CLAUSE_NEGATION_RE = re.compile(
    r"\b(?:not|never|no|none|nothing)\b|n['’]t\b|\bnegative\s+for\b",
    re.IGNORECASE,
)

# The supervisor can decide, from grammar and dates alone, whether a piece of
# text is the user speaking about themselves right now. It cannot decide what
# the text means medically, and it must not pretend a keyword list is that
# decision. This policy name marks the boundary.
CURRENT_SELF_REPORT_POLICY = (
    "first_person_current_unnegated_not_third_party_not_educational_v1"
)

# Named so the packet, the prompts, and the tests all refer to the same rule
# rather than restating it. A regex screen cannot decide medical safety, so an
# unrecognized CURRENT self-report is citable evidence for a conservative stop.
CONSERVATIVE_STOP_POLICY = "current_self_report_may_justify_stopping_v1"

SAFETY_SCREEN_POLICY = "keyword_screen_not_a_medical_assessment_v1"

MAX_REPORTED_SAFETY_TERMS = 6
