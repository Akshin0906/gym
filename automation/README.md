# Local Codex Daily Briefing

This automation generates the workout app's daily **AI Insight** using the
ChatGPT-authenticated Codex CLI included with the ChatGPT desktop app. It does
not use an OpenAI API key and does not create API charges.

The Mac must be logged in, online, open, and connected to power. Installation
also loads an AC-only `caffeinate -s` launch agent so the system stays awake
while plugged in; the display can still sleep.

## Architecture

The job deliberately separates trusted operations from model reasoning:

1. A Python supervisor acquires an OS-released file lock.
2. It retries compatible pending uploads, checks for an existing same-day briefing, and validates the cloud snapshot.
3. It refreshes Oura through the local OAuth companion and sanitizes recovery data.
4. It fetches the existing Codex-owned training memory.
5. It invokes `codex exec` with ChatGPT subscription authentication.
6. Codex runs from an automation-only `CODEX_HOME` with web search and every currently exposed tool-bearing feature disabled, and receives no app secrets or Oura tokens.
7. Codex returns one JSON object constrained by `codex_daily_briefing_output_schema.json`.
8. The supervisor deterministically owns memory state/provenance and trusted metadata, audits the Codex JSONL stream for tool use, then spools the result.
9. One server-side transaction compare-and-sets both the snapshot timestamp and memory revision before writing memory plus the briefing; the supervisor verifies the committed reads.

If upload fails after generation, later same-day or next-day launches retry the
version-bound spool rather than consuming another Codex turn. A changed cloud
snapshot or memory revision quarantines the artifact instead of publishing it.
A transient or server-contract failure on an older spool leaves that artifact
pending but never blocks today's check or generation. Runs are ephemeral and do
not create hidden Codex conversation history.

## Schedule

The launch agent tries at 10:30 AM Pacific, then at 11:00 AM, noon, 3:00 PM,
4:00 PM, 6:00 PM, and 9:00 PM. It also checks once after login. The later
launches provide bounded upload retries; all attempts are idempotent and stop
before Codex when a verified briefing already exists.

When Oura is stale or unavailable before noon, the early runs wait for the next
catch-up instead of permanently publishing a recovery-blind briefing. At noon
or later, the workout-only fallback is allowed so the day still receives an
insight.

## Install or update

```bash
/Users/Apple/Documents/gym/automation/manage_daily_briefing.sh install
```

The same command with `update` stages and validates a new release, coordinates
with the runner lock, reloads both launch agents with `bootout --wait`, and
rolls back a failed doctor/reload. Mutable Oura credentials, its rotating OAuth
database, and reports are preserved across updates.

Useful commands:

```bash
# Verify the Codex binary, ChatGPT login, credentials, Oura state, and files.
/Users/Apple/Documents/gym/automation/manage_daily_briefing.sh doctor

# Show the durable runner status and both launch agents.
/Users/Apple/Documents/gym/automation/manage_daily_briefing.sh status

# Run immediately, bypassing only the clock gate.
/Users/Apple/Documents/gym/automation/manage_daily_briefing.sh run-now

# Generate and validate without publishing.
/Users/Apple/Documents/gym/automation/manage_daily_briefing.sh run-now --dry-run

# Intentionally replace today's briefing.
/Users/Apple/Documents/gym/automation/manage_daily_briefing.sh run-now --force
```

`sync_launchd_runtime.sh` remains as a compatibility alias for `update`.

## Runtime layout

Private runtime data lives under `~/.workout-tracker-codex-daily`:

- `current`: atomic symlink to the active immutable release.
- `codex-home`: automation-only ChatGPT authentication and allowlisted Codex runtime state. Codex necessarily materializes its bundled `skills/.system` descriptions and private SQLite/cache files even for ephemeral runs; personal instructions, user skills, plugins, memory folders, config, symlinks, and unknown top-level state remain forbidden.
- `credentials.env`: only `CLOUD_AUTOMATION_SECRET`, mode `0600`.
- `oura-codex-health`: symlink to immutable Oura code; `.env`, database, and reports resolve to the private mutable store.
- `rollback-bundles`: retained prior release/plist metadata for recovery.
- `state/status.json`: sanitized operational status.
- `state/spool`: validated results awaiting upload.
- `state/runs`: private per-run diagnostics and validated artifacts.
- `logs`: short supervisor and launchd logs.

The runtime tree is restricted to the current macOS user. Successful Codex
event streams are summarized into a content-free audit record before deletion,
and old logs/run artifacts are pruned automatically.

The audited bundled system skills are disabled individually by path, and the
accepted bundle directory names are exact rather than open-ended. They are not
copied from the personal Codex home. If a later Codex build changes that bundle,
the run fails closed until the automation is reviewed. Tool-bearing feature
paths—including image generation, skill search/install, app/browser/computer
access, shell/unified execution, workspace dependencies, hooks, goals,
subagents, and memories—are also explicitly disabled. The JSONL audit remains
the final fail-closed check if a future CLI version nevertheless emits a tool
item.

## Configuration overrides

Launchd uses these safe defaults:

- Model: `gpt-5.6-sol`
- Reasoning effort: Extra High (`xhigh`)
- Codex timeout: 20 minutes
- Oura sync and briefing window: 45 days
- Snapshot maximum age: 7 Pacific calendar days

For a manual run, environment variables can override them:

```bash
WORKOUT_CODEX_MODEL=gpt-5.6-sol \
WORKOUT_CODEX_REASONING_EFFORT=xhigh \
/Users/Apple/Documents/gym/automation/manage_daily_briefing.sh run-now
```

The runner discovers the CLI from `WORKOUT_CODEX_BIN`, the current ChatGPT app,
the legacy Codex app, then `PATH`. This prevents another app-rename failure.

## Validation

```bash
python3 -m unittest discover \
  -s /Users/Apple/Documents/gym/automation/tests -v
bash -n /Users/Apple/Documents/gym/automation/*.sh
plutil -lint /Users/Apple/Documents/gym/automation/*.plist
```

## Local Coach chat bridge

The Coach page uses a separate long-running bridge built on the stable Codex
App Server stdio protocol. It also uses the existing ChatGPT login rather than
an OpenAI API key.

- Normal messages run `gpt-5.6-sol` at `medium` reasoning effort.
- Messages sent with **Deep Think** run the same model at `xhigh`.
- One persistent Codex thread is stored per cloud conversation and resumed
  across bridge/App Server restarts.
- D1 remains the canonical transcript. If a saved Codex thread cannot resume,
  a new thread is seeded from the immutable job context and D1 transcript.
- Healthy resumed threads receive the fresh full workout context and current
  message without resending transcript history that the thread already owns.
  New and recovery threads receive the bounded D1 transcript seed as well.
- An explicit request to remember something for future AI Insights can produce
  a confirmation-gated `save_ai_note` proposal. Applying it writes an AI note
  on the phone and uploads a fresh snapshot; the Coach never writes memory
  silently or while AI Memory is paused.
- Coach can also propose confirmation-gated program renames and full
  replacements, program archival, saved-workout replacement or removal, and
  custom-exercise creation. Program archival and saved-workout removal preserve
  workout history and logged sets; a new exercise is created in its own step so
  the phone can generate its trusted ID.
- The bridge has no inbound listener. It polls over HTTPS, renews an exclusive
  job lease, and sends a heartbeat. Empty claims back off from 2 seconds to a
  10-second cap, reset immediately after activity or restart, and continue
  emitting the independent 20-second heartbeat throughout idle waits.
- A validated completion is written to a private local spool before upload, so
  an outage does not consume a duplicate model turn.
- Codex receives no cloud secret. Apps, plugins, browser/computer use, hooks,
  goals, subagents, the shell tool, web search, and memories are disabled. Turns
  use a read-only sandbox with network access disabled and approval policy
  `never`.

Install or update it independently from the daily briefing:

```bash
/Users/Apple/Documents/gym/automation/manage_chat_bridge.sh install
/Users/Apple/Documents/gym/automation/manage_chat_bridge.sh doctor
/Users/Apple/Documents/gym/automation/manage_chat_bridge.sh status
```

The launch agent wraps the bridge in `caffeinate -s`, which prevents system
sleep while the Mac is connected to AC power. Runtime data lives under
`~/.workout-tracker-codex-chat`.

Operational logs are bounded: `logs/bridge.log` and App Server stderr rotate at
2 MiB with three backups. Launchd's otherwise-unbounded raw stdout/stderr are
discarded because the same bridge events are already captured by the rotating
log. Updates retain the active release plus the newest releases, prune rejected
completion diagnostics after 30 days or 50 files per category, and never prune
validated root completion spools awaiting upload.

The cloud worker contract is:

- `POST /api/chat/automation/heartbeat`
- `POST /api/chat/automation/jobs/claim`
- `POST /api/chat/automation/jobs/:id/lease`
- `POST /api/chat/automation/jobs/:id/complete`
- `POST /api/chat/automation/jobs/:id/fail`

All five requests authenticate with `X-Cloud-Automation-Secret`. Claimed jobs
must use exactly `medium` or `xhigh`; a missing value safely defaults to
`medium`. Action plans use the typed DSL in `codex_chat_output_schema.json` and
are proposals only. After validating model output, the trusted bridge binds a
plan to both the claimed context's global `sourceStateHash` and the 64-character
lowercase `actionStateHashes[scope]` value as `sourceActionStateHash`. The model
cannot supply either trusted value. The phone must still validate and confirm
the proposal before applying a local IndexedDB transaction.
