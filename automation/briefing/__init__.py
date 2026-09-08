"""Modules behind the daily briefing supervisor.

This package holds the parts of the supervisor that are pure data handling:
constants, primitive coercions, text and measurement helpers, recovery
sanitisation, the cloud client, evidence packet construction, memory candidate
derivation, model-output validation, and spool publishing.

Process control, credential loading, Oura synchronisation, Codex invocation, and
the run/doctor entry points deliberately stay in daily_briefing_runner.py, which
re-exports every public name here so its module surface is unchanged.

Declared explicitly rather than relying on namespace packages: the supervisor is
staged into an immutable release directory by manage_daily_briefing.sh, and that
staging works from an explicit file list which this file belongs to.
"""
