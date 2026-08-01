# Workout Tracker PWA — Data Spec

This document is the source of truth for the data layer. The main spec (`workout-tracker-spec.md`) describes *what the app does*; this document describes *how data is stored, queried, and computed*. If anything conflicts, this document wins for data-layer decisions.

## 1. Storage choice

- **IndexedDB**, accessed via **Dexie.js**.
- Single database: `workoutTracker`.
- IndexedDB is the primary store. Phase 1 cloud sync mirrors a full JSON
  snapshot to Cloudflare D1 only after completed workouts and manual syncs.
- Daily Codex briefings are fetched from D1 and cached locally.
- Codex-owned memory state and compact summaries are fetched from D1 on
  app open/foreground. The phone merges compact summaries locally but keeps
  phone-authored workout data, notes, and global context as the primary copy.
- Single-user concerns only.
- Export/import is the only data-portability mechanism.

## 2. TypeScript types (full)

```ts
// ---------- Enums ----------

export type MuscleGroup =
  | "chest"
  | "back"
  | "shoulders"
  | "biceps"
  | "triceps"
  | "forearms"
  | "quads"
  | "hamstrings"
  | "glutes"
  | "calves"
  | "abs"
  | "traps";

// ---------- Tables ----------

export interface Exercise {
  id: string;                       // uuid
  name: string;                     // unique, case-insensitive
  primaryMuscle: MuscleGroup;
  secondaryMuscles: MuscleGroup[];  // may be empty
  notes: string;                    // free-text, user-editable; "" if none
  defaultRestSeconds: number;       // > 0, default 120
  isCustom: boolean;                // false for seed exercises
  hiddenFromLibrary: boolean;       // true = does not appear in pickers; history preserved
  createdAt: number;                // epoch ms
}

export interface Program {
  id: string;
  name: string;
  isActive: 0 | 1;                  // 1 = active (exactly one Program); 0 = inactive. IndexedDB cannot index booleans reliably; store as number.
  createdAt: number;
  archivedAt: number | null;        // null while in rotation
}

export interface SessionTemplate {
  id: string;
  programId: string;                // FK -> Program.id
  name: string;                     // e.g., "Push A"
  order: number;                    // ordering within program, 0-based
}

export interface TemplateExercise {
  id: string;
  sessionTemplateId: string;        // FK -> SessionTemplate.id
  exerciseId: string;               // FK -> Exercise.id
  order: number;                    // ordering within session template, 0-based
  targetSets: number;               // > 0
  targetRepRange: string;           // free text, e.g., "8-12"
}

export interface WorkoutSession {
  id: string;
  sessionTemplateId: string | null; // null = freestyle session
  programId: string | null;         // null = freestyle session
  name: string;                     // snapshot of session template name at start time
  programName: string | null;       // snapshot of program name at start time; survives program archival
  exerciseSnapshot: SessionExerciseSnapshot[]; // frozen at session start; empty for freestyle
  startedAt: number;
  completedAt: number | null;       // null while in progress; auto-set on next session start if abandoned (see §4 invariant 12)
}

export interface SessionExerciseSnapshot {
  exerciseId: string;
  order: number;
  targetSets: number;
  targetRepRange: string;
}

export interface LoggedSet {
  id: string;
  workoutSessionId: string;         // FK -> WorkoutSession.id
  exerciseId: string;               // FK -> Exercise.id
  setNumber: number;                // 1-based, unique within (session, exercise)
  weightLbs: number;                // >= 1
  reps: number;                     // > 0
  rpe: number | null;               // 1-10 if present, null allowed
  loggedAt: number;
}
```

## 3. Dexie schema definition

Use Dexie version 1 for the initial release. Index strings follow Dexie syntax: primary key first, then comma-separated secondary indexes. `++` denotes auto-increment (not used here — all ids are uuids). Compound indexes use `[a+b]`.

```ts
import Dexie, { Table } from "dexie";

export class WorkoutDB extends Dexie {
  exercises!: Table<Exercise, string>;
  programs!: Table<Program, string>;
  sessionTemplates!: Table<SessionTemplate, string>;
  templateExercises!: Table<TemplateExercise, string>;
  workoutSessions!: Table<WorkoutSession, string>;
  loggedSets!: Table<LoggedSet, string>;

  constructor() {
    super("workoutTracker");
    this.version(1).stores({
      exercises: "id, name, primaryMuscle, isCustom",
      programs: "id, isActive, archivedAt",
      sessionTemplates: "id, programId, [programId+order]",
      templateExercises:
        "id, sessionTemplateId, exerciseId, [sessionTemplateId+order]",
      workoutSessions:
        "id, sessionTemplateId, programId, startedAt, completedAt",
      loggedSets:
        "id, workoutSessionId, exerciseId, [exerciseId+loggedAt], [workoutSessionId+exerciseId+setNumber]",
    });
  }
}

export const db = new WorkoutDB();
```

### Why these indexes

- `exercises.name` — search and uniqueness check
- `exercises.primaryMuscle` — list exercises filtered by muscle group in the library
- `programs.isActive` — find the active program (written as 1 for active, 0 for inactive; query with `.equals(1)`)
- `sessionTemplates.[programId+order]` — list sessions in order for a program
- `templateExercises.[sessionTemplateId+order]` — list exercises in order for a session template
- `workoutSessions.startedAt` — history view, descending by date
- `loggedSets.workoutSessionId` — fetch all sets for the current session
- `loggedSets.[exerciseId+loggedAt]` — per-exercise history sorted by date (powers "last session" lookup and est. 1RM chart)
- `loggedSets.[workoutSessionId+exerciseId+setNumber]` — enforce uniqueness and order within a session+exercise

## 4. Invariants (must be enforced in the app layer)

IndexedDB does not enforce these. Enforce in repository / service code.

1. **Exactly one active program.** When setting `Program.isActive = 1`, set all other programs' `isActive = 0` in the same transaction.
2. **Program archive sets timestamp.** Archiving a program sets `archivedAt = Date.now()` and `isActive = 0`.
3. **Active program is never archived.** `isActive=1` implies `archivedAt=null`.
4. **`LoggedSet.setNumber` is dense and 1-based** within `(workoutSessionId, exerciseId)`. When deleting a middle set, renumber subsequent sets in the same transaction to keep the sequence dense.
5. **`weightLbs >= 1`, `reps >= 1`, `rpe` is null or in `[1, 10]`.** UI validates; data layer rejects out-of-range writes.
6. **`Exercise.name` is unique case-insensitively.** Check before insert / rename.
7. **No deletes for Programs or Exercises.**
   - Programs cannot be deleted, only archived (sets `archivedAt = Date.now()`, `isActive = 0`). Archived programs and all their `SessionTemplate`s / `TemplateExercise`s remain queryable so historical `WorkoutSession`s stay readable.
   - Exercises cannot be deleted, only hidden (`hiddenFromLibrary = true`). The model has no exercise-delete operation.
   - Deleting a `SessionTemplate` cascades to its `TemplateExercise`s. `WorkoutSession`s that reference it are preserved with `sessionTemplateId = null`; the snapshot `name` and `exerciseSnapshot` survive.
   - Deleting a `WorkoutSession` cascades to its `LoggedSet`s.
8. **`completedAt >= startedAt`** when both are set.
9. **All writes that touch multiple tables run in a Dexie transaction** (`db.transaction("rw", ...)`).
10. **Hidden exercises are filtered from library pickers.** Repository methods that return exercises for selection (program editor, ad-hoc add) must filter `hiddenFromLibrary === false`. History views, analytics, and direct-id lookups ignore the flag.
11. **Snapshot at session start.** When creating a `WorkoutSession`, in the same transaction:
    - Copy `Program.name` into `WorkoutSession.programName` (or `null` for freestyle).
    - Copy the active `SessionTemplate`'s `TemplateExercise`s into `WorkoutSession.exerciseSnapshot` (`{exerciseId, order, targetSets, targetRepRange}` per row, or `[]` for freestyle).

    Subsequent edits to the `Program` or `SessionTemplate` do not propagate.
12. **Starting a new session auto-completes any prior in-progress sessions.** Before inserting a new `WorkoutSession`, find every existing `WorkoutSession` with `completedAt === null` and set `completedAt` to the max `LoggedSet.loggedAt` for that session (or `startedAt` if no sets exist). Same transaction as the new insert. As a consequence, at most one in-progress session exists at any moment.
13. **In-progress sessions are frozen against their template.** Editing a `SessionTemplate` (reorder, swap, change target sets/reps) does not affect any `WorkoutSession` referencing it, in-progress or completed. The active workout UI reads exercise order from `WorkoutSession.exerciseSnapshot`, not the live template.

## 5. Access patterns (every important query)

These are the queries the app actually runs. Each one shows the intent, the Dexie code, and any post-processing.

### 5.1 Get the active program

```ts
async function getActiveProgram(): Promise<Program | undefined> {
  return db.programs.where("isActive").equals(1).first();
}
```

### 5.2 List sessions for a program, in order

```ts
async function getSessionsForProgram(programId: string) {
  return db.sessionTemplates
    .where("[programId+order]")
    .between([programId, Dexie.minKey], [programId, Dexie.maxKey])
    .toArray();
}
```

### 5.3 List exercises in a session template, in order, with exercise data joined

```ts
async function getSessionTemplateDetail(sessionTemplateId: string) {
  const templateExercises = await db.templateExercises
    .where("[sessionTemplateId+order]")
    .between([sessionTemplateId, Dexie.minKey], [sessionTemplateId, Dexie.maxKey])
    .toArray();

  const exerciseIds = templateExercises.map(te => te.exerciseId);
  const exercises = await db.exercises.bulkGet(exerciseIds);
  const byId = new Map(exercises.filter(Boolean).map(e => [e!.id, e!]));

  return templateExercises.map(te => ({
    templateExercise: te,
    exercise: byId.get(te.exerciseId)!,
  }));
}
```

### 5.4 Get **last session's sets** for an exercise (the gym-flow critical query)

Two-step: find the most recent set for this exercise via the `[exerciseId+loggedAt]` index, then fetch all sets for that session+exercise via the compound uniqueness index. No magic limit.

```ts
async function getLastSessionSetsForExercise(exerciseId: string) {
  const mostRecent = await db.loggedSets
    .where("[exerciseId+loggedAt]")
    .between([exerciseId, Dexie.minKey], [exerciseId, Dexie.maxKey])
    .reverse()
    .first();

  if (!mostRecent) return [];

  return db.loggedSets
    .where("[workoutSessionId+exerciseId+setNumber]")
    .between(
      [mostRecent.workoutSessionId, exerciseId, Dexie.minKey],
      [mostRecent.workoutSessionId, exerciseId, Dexie.maxKey]
    )
    .toArray();
}
```

### 5.5 Get all sets for the current session

```ts
async function getSetsForSession(workoutSessionId: string) {
  return db.loggedSets
    .where("workoutSessionId")
    .equals(workoutSessionId)
    .sortBy("loggedAt");
}
```

### 5.6 Workout history (paginated, newest first)

```ts
async function getRecentSessions(limit = 30, offset = 0) {
  return db.workoutSessions
    .orderBy("startedAt")
    .reverse()
    .offset(offset)
    .limit(limit)
    .toArray();
}
```

### 5.7 Per-exercise history (every set ever, newest first)

```ts
async function getAllSetsForExercise(exerciseId: string) {
  return db.loggedSets
    .where("[exerciseId+loggedAt]")
    .between([exerciseId, Dexie.minKey], [exerciseId, Dexie.maxKey])
    .reverse()
    .toArray();
}
```

### 5.8 Suggest today's session

The home screen suggests the next session in the active program based on the most-recently-completed session in that program. If there is an in-progress same-day session, the UI shows **Resume** instead and skips this query (see §5.12).

```ts
async function suggestNextSession(): Promise<SessionTemplate | undefined> {
  const program = await getActiveProgram();
  if (!program) return undefined;

  const sessions = await getSessionsForProgram(program.id);
  if (sessions.length === 0) return undefined;

  const completed = await db.workoutSessions
    .where("programId").equals(program.id)
    .and(s => s.completedAt !== null)
    .sortBy("completedAt");
  const lastCompleted = completed[completed.length - 1];

  if (!lastCompleted?.sessionTemplateId) return sessions[0];

  const lastIdx = sessions.findIndex(s => s.id === lastCompleted.sessionTemplateId);
  if (lastIdx === -1) return sessions[0];
  return sessions[(lastIdx + 1) % sessions.length];
}
```

### 5.9 Est. 1RM trend for an exercise

See §6 for the formula. Compute on the client per set, then group by day (or per-set if the chart needs the granularity).

### 5.10 Weekly volume per muscle group

See §6. This requires joining `LoggedSet` → `Exercise` to get `primaryMuscle` and `secondaryMuscles`, applying the weighting rule from §6.4, bucketed by ISO week.

Implementation note: for the volume calc, iterate all `LoggedSet`s in a time window, look up each exercise's muscle data from a cached map (don't bulkGet per set), bucket by ISO week. For an active user this is a few thousand rows max per year — well within browser capability — but cache the result and recompute only on session save.

### 5.11 List exercises for a picker (filtered)

```ts
async function getExercisesForPicker(muscleGroup?: MuscleGroup): Promise<Exercise[]> {
  let q = db.exercises.filter(e => !e.hiddenFromLibrary);
  if (muscleGroup) q = q.filter(e => e.primaryMuscle === muscleGroup);
  return q.sortBy("name");
}
```

### 5.12 Find a same-day in-progress session (Resume detection)

The home screen calls this on every open. Returns the most recent in-progress session if it started today; otherwise undefined.

```ts
async function getResumableSession(): Promise<WorkoutSession | undefined> {
  const inProgress = await db.workoutSessions
    .filter(s => s.completedAt === null)
    .toArray();
  if (inProgress.length === 0) return undefined;

  const candidate = inProgress.sort((a, b) => b.startedAt - a.startedAt)[0];

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return candidate.startedAt >= startOfToday.getTime() ? candidate : undefined;
}
```

Notes:
- Full filter scan, but `workoutSessions` is small (one row per training day) and by invariant 12 at most one in-progress session exists. Fast enough.
- Sessions started yesterday or earlier that are still in-progress are *not* surfaced as Resume — they get auto-completed on next session start (invariant 12). User can still edit them via History.
- Uses device local timezone; "today" is whatever the phone says.

### 5.13 Start a new session (snapshot + auto-complete prior)

Implements invariants 11 (snapshot) and 12 (auto-complete prior in-progress). This is the only sanctioned way to create a `WorkoutSession`.

```ts
async function startSession(
  template: SessionTemplate | null,
  program: Program | null
): Promise<string> {
  const newId = crypto.randomUUID();
  const now = Date.now();

  await db.transaction(
    "rw",
    [db.workoutSessions, db.loggedSets, db.templateExercises],
    async () => {
      // Invariant 12: auto-complete any prior in-progress sessions.
      const stale = await db.workoutSessions
        .filter(s => s.completedAt === null)
        .toArray();
      for (const s of stale) {
        const lastSet = await db.loggedSets
          .where("workoutSessionId").equals(s.id)
          .reverse()
          .sortBy("loggedAt")
          .then(arr => arr[0]);
        await db.workoutSessions.update(s.id, {
          completedAt: lastSet?.loggedAt ?? s.startedAt,
        });
      }

      // Invariant 11: snapshot the template's exercises.
      const snapshot: SessionExerciseSnapshot[] = template
        ? (
            await db.templateExercises
              .where("[sessionTemplateId+order]")
              .between([template.id, Dexie.minKey], [template.id, Dexie.maxKey])
              .toArray()
          ).map(te => ({
            exerciseId: te.exerciseId,
            order: te.order,
            targetSets: te.targetSets,
            targetRepRange: te.targetRepRange,
          }))
        : [];

      await db.workoutSessions.add({
        id: newId,
        sessionTemplateId: template?.id ?? null,
        programId: program?.id ?? null,
        name: template?.name ?? "Freestyle",
        programName: program?.name ?? null,
        exerciseSnapshot: snapshot,
        startedAt: now,
        completedAt: null,
      });
    }
  );

  return newId;
}
```

## 6. Derived values

All computed on the fly, never stored.

### 6.1 Estimated 1RM (Epley formula)

```ts
function estimated1RM(weightLbs: number, reps: number): number {
  if (reps < 1) return 0;
  if (reps === 1) return weightLbs;
  return weightLbs * (1 + reps / 30);
}
```

Used for: per-exercise progression chart.

Note: ignore RPE in the calculation. RPE is for the user's reflection, not for adjusting 1RM estimates.

### 6.2 Set volume

```ts
function setVolume(weightLbs: number, reps: number): number {
  return weightLbs * reps;
}
```

### 6.3 Weekly volume per muscle group

For each `LoggedSet` whose `loggedAt` falls in the week, contribute volume to muscle-group buckets using the following rule:

- The exercise's `primaryMuscle` receives **100%** of `setVolume = weightLbs × reps`.
- Each entry in the exercise's `secondaryMuscles` array receives `SECONDARY_VOLUME_WEIGHT` (default 0.5) of `setVolume`.

So a 225 × 10 bench press (primary: chest, secondary: triceps, shoulders) contributes:
- chest: +2250
- triceps: +1125
- shoulders: +1125

Use ISO weeks (Mon–Sun) for consistency.

```ts
export const SECONDARY_VOLUME_WEIGHT = 0.5;

function contributeSetToVolumeMap(
  set: LoggedSet,
  exercise: Exercise,
  byMuscle: Map<MuscleGroup, number>
): void {
  const volume = setVolume(set.weightLbs, set.reps);
  byMuscle.set(exercise.primaryMuscle, (byMuscle.get(exercise.primaryMuscle) ?? 0) + volume);
  for (const m of exercise.secondaryMuscles) {
    byMuscle.set(m, (byMuscle.get(m) ?? 0) + volume * SECONDARY_VOLUME_WEIGHT);
  }
}

function isoWeekKey(epochMs: number): string {
  const d = new Date(epochMs);
  // ISO week calc...
  // Return key like "2026-W21"
}
```

The "weekly volume" view groups by `(isoWeekKey, muscleGroup) -> accumulated weighted volume`.

### 6.4 Secondary muscle weighting rationale

The 0.5 default is a deliberate simplification — there's no objectively correct number, but treating secondaries as ~half of a direct set produces volume charts that match how lifters actually perceive their training (bench press *does* train triceps, just not as much as a tricep isolation). Adjust `SECONDARY_VOLUME_WEIGHT` if it feels off after using the app for a few weeks.

## 7. Seed data

The app ships with these exercises pre-populated on first run. All seeded exercises have `isCustom: false`, `notes: ""`, `defaultRestSeconds: 120`, `createdAt: Date.now()` at install time.

Pure bodyweight exercises (pull-ups, dips, push-ups, etc.) are intentionally omitted per scope.

```ts
export const SEED_EXERCISES: Omit<Exercise, "id" | "createdAt">[] = [
  // ----- Chest -----
  { name: "Barbell Bench Press", primaryMuscle: "chest", secondaryMuscles: ["triceps", "shoulders"], notes: "", defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  { name: "Incline Barbell Bench Press", primaryMuscle: "chest", secondaryMuscles: ["shoulders", "triceps"], notes: "", defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  { name: "Dumbbell Bench Press", primaryMuscle: "chest", secondaryMuscles: ["triceps", "shoulders"], notes: "", defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: "Incline Dumbbell Press", primaryMuscle: "chest", secondaryMuscles: ["shoulders", "triceps"], notes: "", defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: "Decline Dumbbell Press", primaryMuscle: "chest", secondaryMuscles: ["triceps"], notes: "", defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: "Machine Chest Press", primaryMuscle: "chest", secondaryMuscles: ["triceps"], notes: "", defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: "Cable Fly", primaryMuscle: "chest", secondaryMuscles: [], notes: "", defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: "Pec Deck", primaryMuscle: "chest", secondaryMuscles: [], notes: "", defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },

  // ----- Back -----
  { name: "Lat Pulldown", primaryMuscle: "back", secondaryMuscles: ["biceps"], notes: "", defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: "Neutral-Grip Lat Pulldown", primaryMuscle: "back", secondaryMuscles: ["biceps"], notes: "", defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: "Barbell Row", primaryMuscle: "back", secondaryMuscles: ["biceps"], notes: "", defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: "Pendlay Row", primaryMuscle: "back", secondaryMuscles: ["biceps"], notes: "", defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: "T-Bar Row", primaryMuscle: "back", secondaryMuscles: ["biceps"], notes: "", defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: "Seated Cable Row", primaryMuscle: "back", secondaryMuscles: ["biceps"], notes: "", defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: "Single-Arm Dumbbell Row", primaryMuscle: "back", secondaryMuscles: ["biceps"], notes: "", defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: "Chest-Supported Row (Machine)", primaryMuscle: "back", secondaryMuscles: ["biceps"], notes: "", defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: "Straight-Arm Pulldown", primaryMuscle: "back", secondaryMuscles: [], notes: "", defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },

  // ----- Shoulders -----
  { name: "Overhead Press (Barbell)", primaryMuscle: "shoulders", secondaryMuscles: ["triceps"], notes: "", defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  { name: "Seated Dumbbell Press", primaryMuscle: "shoulders", secondaryMuscles: ["triceps"], notes: "", defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: "Arnold Press", primaryMuscle: "shoulders", secondaryMuscles: ["triceps"], notes: "", defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: "Machine Shoulder Press", primaryMuscle: "shoulders", secondaryMuscles: ["triceps"], notes: "", defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: "Dumbbell Lateral Raise", primaryMuscle: "shoulders", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: "Cable Lateral Raise", primaryMuscle: "shoulders", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: "Machine Lateral Raise", primaryMuscle: "shoulders", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: "Reverse Pec Deck", primaryMuscle: "shoulders", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: "Dumbbell Rear Delt Fly", primaryMuscle: "shoulders", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: "Cable Face Pull", primaryMuscle: "shoulders", secondaryMuscles: ["traps"], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: "Front Raise (Dumbbell)", primaryMuscle: "shoulders", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },

  // ----- Biceps -----
  { name: "Barbell Curl", primaryMuscle: "biceps", secondaryMuscles: [], notes: "", defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: "Dumbbell Curl", primaryMuscle: "biceps", secondaryMuscles: [], notes: "", defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: "Hammer Curl", primaryMuscle: "biceps", secondaryMuscles: ["forearms"], notes: "", defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: "Preacher Curl", primaryMuscle: "biceps", secondaryMuscles: [], notes: "", defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: "Cable Curl", primaryMuscle: "biceps", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: "Incline Dumbbell Curl", primaryMuscle: "biceps", secondaryMuscles: [], notes: "", defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: "Concentration Curl", primaryMuscle: "biceps", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },

  // ----- Triceps -----
  { name: "Cable Tricep Pushdown", primaryMuscle: "triceps", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: "Rope Pushdown", primaryMuscle: "triceps", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: "Overhead Tricep Extension (Dumbbell)", primaryMuscle: "triceps", secondaryMuscles: [], notes: "", defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: "Overhead Tricep Extension (Rope)", primaryMuscle: "triceps", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: "Skull Crusher", primaryMuscle: "triceps", secondaryMuscles: [], notes: "", defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: "Close-Grip Bench Press", primaryMuscle: "triceps", secondaryMuscles: ["chest"], notes: "", defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: "Single-Arm Reverse Pushdown", primaryMuscle: "triceps", secondaryMuscles: [], notes: "", defaultRestSeconds: 60, isCustom: false, hiddenFromLibrary: false },

  // ----- Forearms -----
  { name: "Wrist Curl (Barbell)", primaryMuscle: "forearms", secondaryMuscles: [], notes: "", defaultRestSeconds: 60, isCustom: false, hiddenFromLibrary: false },
  { name: "Reverse Wrist Curl (Barbell)", primaryMuscle: "forearms", secondaryMuscles: [], notes: "", defaultRestSeconds: 60, isCustom: false, hiddenFromLibrary: false },

  // ----- Quads -----
  { name: "Barbell Back Squat", primaryMuscle: "quads", secondaryMuscles: ["glutes", "hamstrings"], notes: "", defaultRestSeconds: 210, isCustom: false, hiddenFromLibrary: false },
  { name: "Front Squat", primaryMuscle: "quads", secondaryMuscles: ["glutes"], notes: "", defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  { name: "Leg Press", primaryMuscle: "quads", secondaryMuscles: ["glutes", "hamstrings"], notes: "", defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  { name: "Hack Squat (Machine)", primaryMuscle: "quads", secondaryMuscles: ["glutes"], notes: "", defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  { name: "Bulgarian Split Squat", primaryMuscle: "quads", secondaryMuscles: ["glutes"], notes: "", defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: "Walking Lunge", primaryMuscle: "quads", secondaryMuscles: ["glutes", "hamstrings"], notes: "", defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: "Leg Extension", primaryMuscle: "quads", secondaryMuscles: [], notes: "", defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },

  // ----- Hamstrings -----
  { name: "Romanian Deadlift", primaryMuscle: "hamstrings", secondaryMuscles: ["glutes", "back"], notes: "", defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  { name: "Stiff-Leg Deadlift", primaryMuscle: "hamstrings", secondaryMuscles: ["glutes", "back"], notes: "", defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  { name: "Seated Leg Curl", primaryMuscle: "hamstrings", secondaryMuscles: [], notes: "", defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: "Lying Leg Curl", primaryMuscle: "hamstrings", secondaryMuscles: [], notes: "", defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: "Good Morning", primaryMuscle: "hamstrings", secondaryMuscles: ["glutes", "back"], notes: "", defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },

  // ----- Glutes -----
  { name: "Hip Thrust (Barbell)", primaryMuscle: "glutes", secondaryMuscles: ["hamstrings"], notes: "", defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: "Cable Glute Kickback", primaryMuscle: "glutes", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: "Sumo Deadlift", primaryMuscle: "glutes", secondaryMuscles: ["hamstrings", "back"], notes: "", defaultRestSeconds: 210, isCustom: false, hiddenFromLibrary: false },

  // ----- Calves -----
  { name: "Standing Calf Raise", primaryMuscle: "calves", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: "Seated Calf Raise", primaryMuscle: "calves", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: "Leg Press Calf Raise", primaryMuscle: "calves", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },

  // ----- Abs -----
  { name: "Cable Crunch", primaryMuscle: "abs", secondaryMuscles: [], notes: "", defaultRestSeconds: 60, isCustom: false, hiddenFromLibrary: false },
  { name: "Weighted Decline Sit-Up", primaryMuscle: "abs", secondaryMuscles: [], notes: "", defaultRestSeconds: 60, isCustom: false, hiddenFromLibrary: false },
  { name: "Machine Crunch", primaryMuscle: "abs", secondaryMuscles: [], notes: "", defaultRestSeconds: 60, isCustom: false, hiddenFromLibrary: false },

  // ----- Traps -----
  { name: "Barbell Shrug", primaryMuscle: "traps", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: "Dumbbell Shrug", primaryMuscle: "traps", secondaryMuscles: [], notes: "", defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
];
```

### Seeding behavior

On first launch (when `exercises` table is empty), insert all seed exercises in a single transaction with freshly generated uuids and `createdAt = Date.now()`. Do not re-seed on subsequent launches even if the user deletes all exercises.

## 8. JSON export / import format

Format is a flat dump of every table. Versioned to allow future migrations.

```ts
interface ExportPayload {
  schemaVersion: 1;
  exportedAt: number;       // epoch ms
  appVersion: string;       // from package.json
  data: {
    exercises: Exercise[];
    programs: Program[];
    sessionTemplates: SessionTemplate[];
    templateExercises: TemplateExercise[];
    workoutSessions: WorkoutSession[];
    loggedSets: LoggedSet[];
  };
}
```

### Export

```ts
async function exportData(): Promise<ExportPayload> {
  return db.transaction("r", db.tables, async () => ({
    schemaVersion: 1,
    exportedAt: Date.now(),
    appVersion: APP_VERSION,
    data: {
      exercises: await db.exercises.toArray(),
      programs: await db.programs.toArray(),
      sessionTemplates: await db.sessionTemplates.toArray(),
      templateExercises: await db.templateExercises.toArray(),
      workoutSessions: await db.workoutSessions.toArray(),
      loggedSets: await db.loggedSets.toArray(),
    },
  }));
}
```

Trigger a file download with filename `workout-tracker-export-YYYY-MM-DD.json`.

### Import

Import is **replace, not merge**. The user is doing this to migrate devices or restore from backup, not to combine two devices' logs.

```ts
async function importData(payload: ExportPayload): Promise<void> {
  if (payload.schemaVersion !== 1) {
    throw new Error(`Unsupported schemaVersion: ${payload.schemaVersion}`);
  }
  await db.transaction("rw", db.tables, async () => {
    await Promise.all(db.tables.map(t => t.clear()));
    await db.exercises.bulkAdd(payload.data.exercises);
    await db.programs.bulkAdd(payload.data.programs);
    await db.sessionTemplates.bulkAdd(payload.data.sessionTemplates);
    await db.templateExercises.bulkAdd(payload.data.templateExercises);
    await db.workoutSessions.bulkAdd(payload.data.workoutSessions);
    await db.loggedSets.bulkAdd(payload.data.loggedSets);
  });
}
```

Show a confirmation dialog before import: "This will replace all your data. A backup of your current data will be downloaded first." Then trigger an auto-export, then run the import.

## 9. Migration strategy

When the schema changes, bump the Dexie version and write an upgrade function:

```ts
this.version(2).stores({
  // updated index strings
}).upgrade(async tx => {
  // transform existing rows if needed
});
```

Bump `schemaVersion` in the export payload at the same time, and write a migration step in `importData` that handles the older shape.

Rules:
- Never silently drop fields. If removing a field, log a warning to console during upgrade.
- Always preserve `LoggedSet` data through any migration. It's the irreplaceable user history.

## 10. Testing checklist for the data layer

Before considering the data layer done, verify:

- [ ] Seeding inserts all exercises on a fresh install, does not duplicate on second launch
- [ ] All seed exercises have `hiddenFromLibrary: false` and `isCustom: false`
- [ ] Creating a program with `isActive=1` deactivates the previous active program in the same transaction
- [ ] Archiving the active program sets `archivedAt` and `isActive=0`
- [ ] Programs and Exercises have no delete path; repository and UI both refuse
- [ ] Deleting a `SessionTemplate` preserves associated `WorkoutSession`s with `sessionTemplateId=null` and intact `name` + `exerciseSnapshot`
- [ ] Deleting a set in the middle of a sequence renumbers subsequent sets
- [ ] Hidden exercises (`hiddenFromLibrary=true`) do not appear in picker queries but DO appear in per-exercise history and analytics
- [ ] "Last session sets for exercise" returns sets from the most recent session only, ordered by `setNumber`, with no hard-coded set-count cap
- [ ] Suggested next session wraps around after the last session in the program
- [ ] Starting a session from the active program snapshots `programName` and `exerciseSnapshot` into the new `WorkoutSession`
- [ ] Freestyle session start (no template) has `programName=null` and `exerciseSnapshot=[]`
- [ ] Renaming the active program does NOT update `programName` on already-started sessions
- [ ] Editing a `SessionTemplate` (swap exercise, reorder, change target sets/reps) does NOT alter `exerciseSnapshot` on past or in-progress `WorkoutSession`s
- [ ] Starting a new session with a prior `completedAt === null` session sets the prior session's `completedAt` to the max `LoggedSet.loggedAt` (or `startedAt` if no sets), in the same transaction as the new insert
- [ ] After invariant 12 fires, at most one in-progress session exists
- [ ] `getResumableSession()` returns the in-progress session when it started today; returns undefined when it started yesterday or earlier
- [ ] Past sessions remain editable indefinitely (no midnight lock)
- [ ] Volume calc: a 225×10 bench press (primary chest, secondary triceps+shoulders) contributes 2250 to chest, 1125 to triceps, 1125 to shoulders (using default `SECONDARY_VOLUME_WEIGHT = 0.5`)
- [ ] Weekly volume calculation matches a hand-computed example for at least 2 distinct weeks of test data
- [ ] Export + Import round-trips losslessly (byte-for-byte equality of exported JSON before vs after)
- [ ] Export includes all six tables; import replaces, not merges
