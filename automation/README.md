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
2. It retries compatible pending uploads, validates the current cloud snapshot,
   and reuses an existing same-day briefing only when the snapshot, runner,
   validator, prompt, packet schema, configured model, reasoning effort, and a
   secret-free fingerprint of the newly sanitized recovery inputs all match the
   current contract. A stale/unavailable-to-fresh or materially changed fresh
   recovery record therefore regenerates even when workout data are unchanged.
3. It refreshes Oura through the local OAuth companion and sanitizes recovery data.
4. It fetches the existing Codex-owned training memory.
5. It constructs a bounded, deduplicated `briefingEvidencePacket` for today's
   decision and a separate candidate-scoped `memorySourcePacket` for memory
   creation. The full workout database remains canonical storage outside the
   model context.
6. It invokes `codex exec` with ChatGPT subscription authentication.
7. Codex runs from an automation-only `CODEX_HOME` with web search and every currently exposed tool-bearing feature disabled, and receives no app secrets or Oura tokens.
8. Codex returns one JSON object constrained by `codex_daily_briefing_output_schema.json`.
9. The supervisor deterministically owns evidence selection, memory state/provenance, trusted metadata, the Oura summary, and snapshot-age warnings; it audits the Codex JSONL stream for tool use, then spools the result.
10. One server-side transaction compare-and-sets both the snapshot timestamp and memory revision before writing memory plus the briefing; the supervisor verifies the committed reads.

If upload fails after generation, later same-day or next-day launches retry the
version-bound spool rather than consuming another Codex turn. A changed cloud
snapshot or memory revision quarantines the artifact instead of publishing it.
A transient or server-contract failure on an older spool leaves that artifact
pending but never blocks today's check or generation. Runs are ephemeral and do
not create hidden Codex conversation history.

### Bounded context and memory separation

The daily agent is a decision synthesizer, not a full-database reader. The
supervisor projects canonical data into two purpose-separated inputs:

- `briefingEvidencePacket` retains a current resumable workout when one is
  eligible for today, otherwise the next rotated programmed session. It also
  retains bounded recent safety evidence with explicit timestamps, up to three
  recent complete workout episodes, up to three same-exercise comparators per
  scheduled movement, explicit missingness and subjective-signal contradictions, one
  deduplicated recovery view, and non-overlapping older summaries or notes.
- `memorySourcePacket` contains only the source records, notes, summaries, and
  references required by `supervisorCandidatePlan`. Its periodic-candidate
  digests aggregate all canonical session sources while retaining at most four
  bounded session samples; periodic sources are not expanded into full session
  episodes. Memory compaction remains a separate candidate-scoped input/output
  lane within the same invocation, and its duplicate records cannot reinforce
  the daily decision.

Each citable domain atom has an internal `evidenceId`; its `sourceStoryId`
groups representations derived from the same session, note, summary, or
recovery record. This prevents one record from masquerading as repeated
evidence. Distinct atoms in one story can still describe different domains,
but repetition requires distinct source stories. Recent intervals use compact
session episodes. The older-summary selector preserves recent 14-day detail
and, when available, a non-overlapping older four-month horizon; neither is an
independent mode trigger. Prior briefings, recommendations, Coach receipts,
unrelated programs and exercises, and workout-memory copies of canonical
sessions are excluded from decision context.

The packet's `subjectiveSignalContradictions` are deterministic directional
cues between PRS and perceived performance. They help preserve disagreement,
but are not a validated classifier, an independent evidence atom, or a claim
about logged performance.

Before applying the overall budget, the supervisor creates deterministic
field-level excerpts and source compactions. Notes are limited to 400
characters, current context to 1,400 characters, each recent episode to eight
movements with four retained sets per movement, and the current plan to 16
movements. Truncation and compaction objects retain original, retained, and
omitted counts or hashes so the model cannot mistake an excerpt for a full
record.

The memory plan exposes bounded projections of candidate provenance. Codex must
echo the projected `sourceSessionIds` and `sourceSummaryIds` exactly; after
validating them, the supervisor restores the complete canonical source lists
before persistence. Note IDs are limited to the supplied allowed subset, and
note bodies are never expanded beyond their bounded excerpts. For 14-day
candidates, `periodicCandidateDigests` compute period-wide counts from every
canonical session and retain no more than four illustrative samples. Four-month
candidates use exactly eight consecutive, non-overlapping 14-day summaries,
forming one gap-free 112-day `four_month` rollup. This prevents calendar-month
boundaries from permanently dropping a crossing 14-day child. Malformed,
missing, or overlapping sources block the candidate, and the long-horizon
cursor waits until the sequential 14-day lane has caught up.
Summary-to-summary provenance
is recursively resolved to its underlying workout sessions before decision
deduplication.

AI-note decision recency follows the latest saved body (`updatedAt`, never
earlier than `createdAt`) and exposes both timestamps plus their meaning. This
keeps an edited current safety note current without pretending its described
event necessarily happened at the edit time.

The model-input data budget is 48,000 serialized UTF-8 bytes and the full prompt
budget is 81,920 bytes. Selected safety evidence, the current resumable or next
programmed session, up to three available compact recent episodes, and the
recovery lane remain mandatory. If that bounded core cannot fit, generation
fails closed. Optional
older summaries are removed first while preserving the newest summary of each
horizon when possible. The supervisor then defers whole periodic memory
candidates and their dependents, then whole selected workout-memory candidates,
only when the input-byte budget requires it; it next removes the oldest
comparable exposures and finally general notes. The separately bounded workout
backlog is staged across runs rather than inferred by the model. The supervisor
never cuts serialized JSON in the middle of a value or emits a partial memory
candidate.

Trusted telemetry records `briefingPacketBytes`, `memorySourcePacketBytes`,
`supervisorPlanBytes`, `totalInputBytes`, selected and deferred memory-candidate
counts and reasons, and retained/pruned history counts without logging workout
content. This bounded, retrieved structure reduces the risk of relevant
evidence being buried in a long prompt, as studied in
[Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/), while preserving
session-level chronology recommended by
[LongMemEval](https://arxiv.org/abs/2410.10813).

## Evidence and writing policy

The briefing is a decision aid, not a medical assessment. Its content contract
is intentionally conservative:

- The action appears first, with one or two short supporting reasons and progressive
  disclosure for detail, following the U.S. Department of Health and Human
  Services guidance for [brief, actionable health content](https://odphp.health.gov/healthliteracyonline/create-actionable-content).
- Resistance-training advice favors consistent progressive training and does
  not presume that advanced or failure-based techniques are necessary, in line
  with the [2026 ACSM position stand](https://pubmed.ncbi.nlm.nih.gov/41843416/).
- Recent session feedback is considered before a wearable score. A broad
  [systematic review of athlete monitoring](https://pubmed.ncbi.nlm.nih.gov/26423706/)
  found subjective well-being measures often more sensitive and consistent
  than common objective markers; the app's own feedback sliders are useful
  context, not independently validated clinical measures.
- Oura total sleep and readiness are supporting context only. The
  [AASM/SRS consensus](https://www.aasm.org/resources/pdf/adultsleepdurationconsensus.pdf)
  recommends at least seven hours of habitual sleep for adults, while consumer
  wearables remain estimates with device-level variability in a
  [2026 systematic review](https://pubmed.ncbi.nlm.nih.gov/42175611/).
- Oura daily summaries are freshness-checked by their `day` in Pacific time,
  because the API's midnight-UTC timestamps identify a calendar day rather
  than the time a score was measured. An actual sleep-end timestamp is retained
  when available.
- The supervisor, not the model, supplies the neutral Oura sentence and any
  stale-snapshot warning. A current reading is never described as proof of good
  recovery, and no proprietary score alone selects `light`, `deload`, or
  `rest`.

The model evaluates evidence by domain rather than producing a weighted
readiness score. This follows the IOC consensus that monitoring should combine
external work, internal response, performance, subjective wellbeing, and
health symptoms rather than rely on one marker
([consensus statement](https://pmc.ncbi.nlm.nih.gov/articles/PMC5013087/)):

1. Current safety reports are a gate and can override ordinary optimization.
2. Same-exercise performance and completed exposure are the primary progression evidence.
3. Per-set and whole-session RPE jointly describe one internal-effort domain.
4. Pre-workout recovery, perceived performance, and user context describe one subjective state/outcome domain.
5. Oura sleep and readiness form one supporting wearable domain.
6. Repeated comparable exposures and non-overlapping summaries describe long-term adaptation.

Correlated fields are not independent votes: load, reps, sets, and volume from
one session are one external-work story; set RPE and session RPE are one effort
story; logged and perceived performance are two views of one outcome; Oura
sleep and readiness are one wearable story. A raw workout and a summary derived
from it are correlated history, not independent votes. Missing or skipped data
are unknown, not neutral. Material disagreement is preserved rather than
averaged away, and mixed, sparse, stale, or non-comparable evidence defaults to
`normal` unless a current safety report requires otherwise.

All comparisons are within-person and exercise performance is used only across
comparable exposures of a movement scheduled today. The app treats PRS as
within-person context; a small resistance-training
[PRS study](https://pubmed.ncbi.nlm.nih.gov/35255478/) supports pairing it with
subsequent performance rather than applying a universal cutoff. A completed
session's PRS remains historical, even if recorded today. Only
`currentProgrammedSession.currentSubjectiveState` on a resumable workout is
current; on its own, PRS 0-3 can make only `light` directly eligible, while a
higher current PRS never unlocks `push`. The stored
0-10 session RPE is an intensity rating, not session-load without reliable
active duration, consistent with the original
[session-RPE method](https://pubmed.ncbi.nlm.nih.gov/11708692/). The automation
does not calculate weighted readiness, acute:chronic workload ratios, workload
safe zones, or injury-risk percentages; ratio-based injury thresholds have
important conceptual and statistical limitations described in a
[critical analysis](https://pubmed.ncbi.nlm.nih.gov/32502973/).

Exact readiness cutoffs and fixed percentage deload prescriptions are
deliberately omitted; the evidence for deload prescription is still limited and
largely [consensus-based](https://pubmed.ncbi.nlm.nih.gov/37730925/). The 3%
historical performance-marker decline below is an eligibility screen, not a
prescribed reduction. Explicit recent injury, illness, or red-flag symptoms
always take priority over performance data, without diagnosis.

Mode selection remains deliberately conservative and is checked against typed
evidence IDs. Historical adverse feedback is actionable only inside an
inclusive seven-day window, while progression and decline comparisons use an
inclusive 90-day window. `push` requires at least two exact-target,
progression-eligible same-movement exposures from distinct sessions, stable or
improving logged markers, perceived performance of at least 3, no pain, and
session RPE below 9. It is blocked by recent pain from any retained session,
current PRS 0-3, or a current red flag; poor perceived performance or session
RPE 9-10 is an automatic blocker only on a scheduled-movement comparator, while
unrelated values remain context. `light` requires current PRS 0-3, recent poor
perceived performance, pain that modified/stopped training, a current red flag,
or 9-10 session RPE corroborated by poor performance or modifying pain.
Historical PRS and pain reported as present without effect remain context rather
than independently authorizing `light`. `deload` requires three strictly
declining comparable external markers, at least 3% from oldest to newest, plus
an eligible current state, corroborated internal-response, or material safety
atom. Historical PRS and perceived performance cannot serve as the second
domain because they are calibration/outcome views of the same session.
`rest` requires
seven-day stopped-pain evidence or an eligible current/same-day unresolved red
flag. Sparse or mixed evidence remains `normal`, which may carry no supporting
ID. The 7-day, 90-day, and 3% thresholds are conservative product eligibility
guardrails, not validated clinical or physiological cutoffs; passing one
permits but never compels a mode. Oura alone never changes the mode.

## Schedule

The launch agent tries at 10:30 AM Pacific, then at 11:00 AM, noon, 3:00 PM,
4:00 PM, 6:00 PM, and 9:00 PM. It also checks once after login. The later
launches provide bounded upload retries; all attempts are idempotent and stop
before Codex when a verified briefing already matches the current phone
snapshot and the current runner, validator, prompt, packet, model, and reasoning
contract. If the snapshot or contract changes later that day, the next
scheduled check replaces the older briefing automatically.

When Oura is stale or unavailable before noon, the early runs wait for the next
catch-up instead of permanently publishing a recovery-blind briefing. At noon
or later, the workout-only fallback is allowed so the day still receives an
insight.

## Install or update

The daily briefing optionally consumes a separate local Oura companion checkout.
Point the first install at that checkout; later updates can reuse the staged copy
under the private runtime directory.

```bash
WORKOUT_OURA_SOURCE=/absolute/path/to/oura-codex-health \
  ./automation/manage_daily_briefing.sh install
```

The same command with `update` stages and validates a new release, coordinates
with the runner lock, reloads both launch agents with `bootout --wait`, and
rolls back a failed doctor/reload. Mutable Oura credentials, its rotating OAuth
database, and reports are preserved across updates.

Useful commands:

```bash
# Verify the Codex binary, ChatGPT login, credentials, Oura state, and files.
./automation/manage_daily_briefing.sh doctor

# Show the durable runner status and both launch agents.
./automation/manage_daily_briefing.sh status

# Run immediately, bypassing only the clock gate.
./automation/manage_daily_briefing.sh run-now

# Generate and validate without publishing.
./automation/manage_daily_briefing.sh run-now --dry-run

# Intentionally replace today's briefing.
./automation/manage_daily_briefing.sh run-now --force
```

`sync_launchd_runtime.sh` remains as a compatibility alias for `update`.

## Supervisor module layout

`daily_briefing_runner.py` is the entry point and owns everything that touches
the outside world: configuration and credential loading, process supervision and
signal handling, the Oura subprocess, Codex invocation and its JSONL audit,
locking, logging, and the `run`/`doctor` command surface. The parts that are
pure data handling live in the `briefing/` package next to it:

| Module | Responsibility |
| --- | --- |
| `errors.py` | Error taxonomy and process exit codes |
| `constants.py` | Version markers, packet/prompt budgets, safety regexes |
| `primitives.py` | Strict coercions for untrusted JSON, Pacific-day arithmetic |
| `models.py` | Dataclasses passed between stages |
| `textutil.py` | Bounded text handling, evidence ids, byte accounting |
| `measurement.py` | One-rep-max, rep ranges, load conventions |
| `recovery.py` | Oura sanitisation, freshness policy, fingerprints |
| `cloudclient.py` | Authenticated cloud client that rejects redirects |
| `evidence.py` | Bounded evidence packet construction |
| `memory.py` | Trusted memory state and candidate derivation |
| `validation.py` | Snapshot, model-output, and spool contract validation |
| `publishing.py` | Atomic spool publishing with commit verification |

The entry point re-exports every public name from the package, so the module
surface it presents is unchanged: the launchd wrapper, the staged release, and
the test-suite all still import one module, and patching a name on it still
reaches the `run()` call sites.

`stage_release` in `manage_daily_briefing.sh` installs the package from an
explicit module list rather than a glob, byte-compiles every file, and then runs
the staged copy in a clean environment to prove it imports without the working
tree on `sys.path`. A module that is added to the source tree but not to that
list — or one that fails to import — fails the release before the live
installation is touched, and the transaction rolls back.

### Shared calculation fixtures

`shared_fixtures/calculations.json` pins the calculations that exist in both the
app and the supervisor: the one-rep-max formula, rep-range parsing, load
comparability, and which loads have a defined tonnage.
`automation/tests/test_shared_fixtures.py` and `src/lib/sharedFixtures.test.ts`
assert the same expectations against their own implementation, so a divergence
fails exactly one of the two suites.

The file also records one deliberate difference: the app treats a bare `10` as a
rep target, while the supervisor only recognises an explicit range. Both
behaviours are asserted rather than left to drift.

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
item. The audit permits only one exact, pre-turn Code Mode host-disabled
compatibility diagnostic emitted by Codex CLI 0.147; every changed diagnostic,
other error, malformed event lifecycle, or tool item is still rejected.

## Configuration overrides

Launchd uses these safe defaults:

- Model: `gpt-6-astra`
- Reasoning effort: High (`high`)
- Codex timeout: 20 minutes
- Model-input data budget: 48,000 serialized UTF-8 bytes
- Full prompt budget: 81,920 serialized UTF-8 bytes
- Oura sync and briefing window: 45 days
- Snapshot maximum age: 7 Pacific calendar days

For a manual run, environment variables can override them:

```bash
WORKOUT_CODEX_MODEL=gpt-6-astra \
WORKOUT_CODEX_REASONING_EFFORT=high \
./automation/manage_daily_briefing.sh run-now
```

The runner discovers the CLI from `WORKOUT_CODEX_BIN`, the current ChatGPT app,
the legacy Codex app, then `PATH`. This prevents another app-rename failure.

## Effort targets: a deliberate non-change

The audit asked whether the app should store an optional per-exercise effort
target (a saved RPE or RIR ceiling). It does not, on purpose.

Nothing in the current schema records one, so a briefing that states "keep the
first working set at RPE 8 or below" is stating the model's own suggestion for
today — and it must say so rather than presenting it as an agreed prescription.
Both prompts now require that, and both state the reps-in-reserve anchors so the
number means the same thing from one set to the next. Where the user's own saved
plan or note *does* prescribe an effort or rep target, that is their target and
the surfaces are told to use it and name it as theirs.

Adding a saved effort target would touch the exercise schema, the template and
snapshot shapes, export/import validation, the cloud snapshot, the Coach action
DSL, and the supervisor's comparators. That is a large change to carry for a
field with no evidence-based default value: the research does not support one
correct RIR, and inventing a stored number would be exactly the false precision
this audit was about. It stays unimplemented and is recorded here as a decision
rather than an oversight.

## Shared evidence guide

`automation/evidence_guide.md` is one dated, source-linked summary of the
training evidence the coaching surfaces rely on. Neither runtime model has
browsing or tools, so guidance that is not in the package does not reach them.

- It is appended verbatim to BOTH runtime prompts: the daily briefing prompt
  and the conversational Coach's base instructions.
- It never relaxes a security, approval, or memory rule. Both prompts state
  that the surface's own contract wins on any apparent conflict.
- Its version is pinned in three places that must agree — `EVIDENCE_GUIDE_VERSION`
  in `briefing/constants.py`, the same constant in `chat_bridge.py`, and the
  version line inside the guide itself. Both installers refuse to stage a
  release whose guide does not declare the expected version.
- Its bytes are folded into the daily runner's `promptHash`, so changing it
  changes the recorded prompt fingerprint and invalidates a same-day spool
  produced under the old guidance. The version is also recorded in briefing
  metadata as `evidenceGuideVersion`.
- `--doctor` reports `evidenceGuide` on both surfaces and fails without it.

A prompt containing a sentence is not evidence that a model reasons from it.
The packaging tests prove only that the curated text physically reaches the
runtime; the behavioural tests in `tests/test_coaching_science.py` are what pin
the supervisor's own decisions.

## Validation

```bash
python3 -m unittest discover -s automation/tests -v
bash -n automation/*.sh
plutil -lint automation/*.plist
python3 -m compileall -q automation
```

## Local Coach chat bridge

The Coach page uses a separate long-running bridge built on the stable Codex
App Server stdio protocol. It also uses the existing ChatGPT login rather than
an OpenAI API key.

- Messages run `gpt-6-astra` at `high` reasoning effort. `high` is the product
  default, not a catalog limit: the model advertises `medium`, `high`, and
  `xhigh`, and the bridge will still execute a job an older client queued at one
  of the previous defaults rather than stranding it mid-rollout. Historical
  transcript rows keep the effort they actually ran at.
- The composer shows the model and effort instead of offering a choice, because
  there is only one effort new messages are composed at.
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
./automation/manage_chat_bridge.sh install
./automation/manage_chat_bridge.sh doctor
./automation/manage_chat_bridge.sh status
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
must use `medium`, `high`, or `xhigh`; a missing value defaults to `high`. The
D1 CHECK constraints were widened by `migrations/0009_codex_chat_high_effort.sql`,
which rebuilds the three linked chat tables — preserving every row, index,
foreign key, and the `codex_chat_messages` AUTOINCREMENT high-water mark — and
keeps the two legacy values valid so no stored row is rewritten. Action plans use the typed DSL in `codex_chat_output_schema.json` and
are proposals only. After validating model output, the trusted bridge binds a
plan to both the claimed context's global `sourceStateHash` and the 64-character
lowercase `actionStateHashes[scope]` value as `sourceActionStateHash`. The model
cannot supply either trusted value. The phone must still validate and confirm
the proposal before applying a local IndexedDB transaction.
