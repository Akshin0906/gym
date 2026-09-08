"""Version markers, prompt/packet budgets, and safety regexes.

Every limit the supervisor enforces lives here so a budget change is a one-line
review rather than a search through the orchestration code."""

from __future__ import annotations

import datetime as dt
import re
import signal
from zoneinfo import ZoneInfo


RUNNER_VERSION = "3.8"

PROMPT_VERSION = "2026-08-13-bounded-evidence-packet-v2"

VALIDATOR_COMPATIBILITY_VERSION = "2026-08-13-bounded-evidence-v7"

DEFAULT_CODEX_MODEL = "gpt-5.6-sol"

DEFAULT_CODEX_REASONING_EFFORT = "xhigh"

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

MODEL_INPUT_PACKET_MAX_BYTES = 48_000

MODEL_PROMPT_MAX_BYTES = 81_920

BRIEFING_EVIDENCE_PACKET_VERSION = "briefing-evidence-v2"

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

REST_RED_FLAG_RE = re.compile(
    r"\b(?:fever|chest\s+pain|faint(?:ed|ing)?|severe\s+dizz(?:y|iness)|"
    r"severe\s+pain|unexplained\s+pain|acute\s+illness|flu|influenza|"
    r"covid(?:-?19)?|vomit(?:ed|ing|s)?|pass(?:ed|ing)?\s+out|"
    r"shortness\s+of\s+breath|cannot\s+breathe|can't\s+breathe|"
    r"difficulty\s+breathing|medical\s+emergency)\b",
    re.IGNORECASE,
)
