# Workout Tracker PWA — Spec

## 1. Overview

A single-user Progressive Web App for logging hypertrophy training. Built to be opened in the gym, used to quickly log straight sets against a structured program, and reviewed occasionally on desktop for program planning and progress checking. IndexedDB remains the primary store; Phase 1 cloud sync mirrors snapshots to D1 after completed workouts and manual syncs so a laptop Codex automation can write the daily briefing.

## 2. User profile (it's me)

- Trains for hypertrophy / bodybuilding
- Follows one structured program at a time, swaps programs every few months
- Logs only working sets, only straight sets
- Cares about: last session's numbers, weekly volume per muscle group, estimated 1RM trends
- Doesn't care about: PRs as a feature, plate math, bodyweight exercises, supersets, warm-ups, Apple Health, watch integration

## 3. Core user flow (the gym flow)

1. Open app → if there's an in-progress session from today, primary CTA is **Resume**. Otherwise primary CTA is the next-suggested session from the active program (advances by rotation: last completed + 1).
2. Tap to start the session → see the ordered list of exercises for that session
3. Tap first exercise → exercise screen shows:
   - **Last session's sets for this exercise** (prominent, top of screen)
   - **Persistent notes for this exercise** (machine settings, form cues)
   - **Input row** for the current set (weight, reps, RPE)
4. Log set → row commits, new empty input row appears
5. After last set: tap "Start Rest" → count-down timer with audible + visual alert when done
6. Tap next exercise, repeat
7. End session → session saved to history

## 4. Features in scope

### Logging
- Log straight sets only: `weight (lbs) × reps × RPE (1–10)`
- One unit: lbs only, no toggle
- Persistent notes attached to each exercise (not per-set, not per-workout)
- Edit / delete logged sets within the current session
- Edit past sessions (in case I forgot something)

### Programs
- One active program at a time
- Programs contain ordered sessions (e.g., "Push A", "Pull A", "Legs", "Push B"...)
- Sessions contain an ordered list of exercises with target set counts
- Switch active program (old program archives, historical data preserved)
- Edit / clone programs (especially useful for desktop planning)
- Programs are archived, never deleted

### Exercise library
- Ships with a seed catalog of ~50–80 common hypertrophy exercises
- Each exercise has: name, primary muscle group, secondary muscle group(s), notes (user-editable)
- Users can add custom exercises
- Users can edit any exercise (including seed ones — notes especially)
- Hide an exercise to remove it from pickers without losing history; unhide anytime. No delete.

### Rest timer
- Per-exercise default rest time (configurable, e.g., 90s for isolation, 180s for compound)
- Count-down style
- **Manual start** (tap a button after logging a set)
- Override target time inline (sometimes I need more)
- Runs in the background: switching exercises or logging a new set does not stop it. Only manual stop or expiry kills it.
- When timer hits zero: audible beep + visual flash + haptic if available

### History & analytics
- Chronological list of past sessions (calendar view + list view)
- Per-exercise history: every set ever logged, sortable by date
- Per-exercise estimated 1RM trend chart (using Epley formula: `weight × (1 + reps/30)`, ignore RPE for est. 1RM)
- Weekly volume per muscle group chart (volume = sum of `weight × reps` per primary muscle group, per ISO week)

### Data management
- Export all data as JSON (single button → downloads file)
- Import from JSON (for restore / device migration)
- This matters: iOS evicts PWA storage after ~7 weeks of non-use, and there's no other sync mechanism

## 5. Explicitly out of scope

These were considered and rejected. Do not build them. Do not ask about them.

- Supersets, drop sets, giant sets, any set grouping
- Warm-up set tracking (only working sets are logged)
- Plate calculator
- Unit toggle (lbs/kg)
- Bodyweight exercise affordances (no pull-ups, dips, etc. in this user's training)
- Mid-workout exercise reordering
- Multiple simultaneous programs
- Auto-PR detection / PR celebration
- Bodyweight tracking
- Progress photos
- Body measurements
- Apple Health / HealthKit (impossible in a PWA anyway)
- Apple Watch companion
- Cloud sync / multi-device sync
- Sharing workouts with anyone
- Social features of any kind
- Auto-starting timers
- Count-up timer
- Per-set or per-workout notes

## 6. Data model (Dexie / IndexedDB)

```ts
// Tables

interface Exercise {
  id: string;              // uuid
  name: string;            // "Barbell Row"
  primaryMuscle: MuscleGroup;
  secondaryMuscles: MuscleGroup[];
  notes: string;           // user-editable persistent notes
  defaultRestSeconds: number;  // e.g., 120
  isCustom: boolean;       // false for seed exercises
  createdAt: number;       // epoch ms
}

interface Program {
  id: string;
  name: string;            // "Upper/Lower Hypertrophy v3"
  isActive: boolean;       // only one true at a time
  createdAt: number;
  archivedAt: number | null;
}

interface SessionTemplate {
  id: string;
  programId: string;
  name: string;            // "Push A"
  order: number;           // position within program
}

interface TemplateExercise {
  id: string;
  sessionTemplateId: string;
  exerciseId: string;
  order: number;           // position within session
  targetSets: number;      // e.g., 3
  targetRepRange: string;  // free text, "8-12"
}

interface WorkoutSession {
  id: string;
  sessionTemplateId: string | null;  // null if freestyle
  programId: string | null;
  name: string;            // snapshot of template name at start time
  startedAt: number;
  completedAt: number | null;
}

interface LoggedSet {
  id: string;
  workoutSessionId: string;
  exerciseId: string;
  setNumber: number;       // 1, 2, 3 within the session+exercise
  weightLbs: number;
  reps: number;
  rpe: number | null;      // 1–10, nullable in case I forget
  loggedAt: number;
}

type MuscleGroup =
  | "chest" | "back" | "shoulders" | "biceps" | "triceps" | "forearms"
  | "quads" | "hamstrings" | "glutes" | "calves" | "abs" | "traps";
```

### Notes on the model

- `LoggedSet` is the atomic unit. Everything else exists to organize and retrieve sets.
- `WorkoutSession.sessionTemplateId` is nullable so freestyle/one-off workouts are still possible later if I want.
- `Program.isActive` should be enforced at the application layer to ensure exactly one active program (no DB constraint in IndexedDB).
- All ids are uuids (use `crypto.randomUUID()`).
- All timestamps are epoch milliseconds (number) for cheap sorting and comparison.

## 7. Screens

1. **Today** (home) — if an in-progress same-day session exists, primary CTA is **Resume**. Otherwise shows the suggested next session from active program, plus "Start an empty workout" fallback.
2. **Active Workout** — the in-gym screen; list of exercises for the session, tap to expand
3. **Exercise (in active workout)** — last session's sets, persistent notes, input row, rest timer
4. **History** — calendar + list view of past sessions
5. **Session Detail** — view/edit a past session
6. **Exercise Detail** — per-exercise history, est. 1RM trend chart
7. **Programs** — list of programs, mark active, edit, clone, archive
8. **Program Editor** — edit a program: add/reorder sessions, add/reorder exercises, set target sets/reps
9. **Exercise Library** — list of all exercises, search, edit notes, add custom
10. **Stats** — weekly volume per muscle group chart, est. 1RM trend across key lifts
11. **Settings** — export / import JSON, app info

## 8. Tech stack

- **Vite + React + TypeScript**
- **vite-plugin-pwa** for service worker and manifest
- **Dexie.js** for IndexedDB
- **Tailwind CSS** for styling
- **Zustand** for app-level state (active workout in progress, current program)
- **Recharts** for the two chart types
- **React Router** for navigation
- **Cloudflare Pages** for hosting

## 9. Build plan (vertical slices)

Build in this order. Each slice should be shippable and testable.

1. **Slice 0 — Foundation.** Scaffold Vite + React + TS + Tailwind + Dexie + vite-plugin-pwa. Verify PWA installs to iPhone home screen. Deploy "hello world" to Cloudflare Pages.
2. **Slice 1 — Exercise library.** Seed ~50 hypertrophy exercises. CRUD UI. Search by name and muscle group. Persistent notes editable per exercise.
3. **Slice 2 — Freestyle workout logging.** Start an empty workout, add exercises ad-hoc, log sets, complete workout. Test that data persists across reloads.
4. **Slice 3 — History.** Calendar + list view of past sessions. Drill into a session, view sets, edit/delete sets.
5. **Slice 4 — Programs.** Create a program with sessions and ordered exercises with target sets/reps. Mark one as active. Archive others.
6. **Slice 5 — Today + active workout from template.** Home screen suggests next session. Starting a session loads the template. "Last session's sets" displayed prominently per exercise.
7. **Slice 6 — Rest timer.** Per-exercise default rest seconds. Manual start. Count-down with audio + visual alert.
8. **Slice 7 — Analytics.** Per-exercise est. 1RM chart. Weekly volume per muscle group chart.
9. **Slice 8 — Export / import.** JSON dump and restore.
10. **Slice 9 — iOS PWA polish.** Apple meta tags, splash screen, status bar style, icons in all sizes. Test "Add to Home Screen" feels native.

## 10. iOS PWA requirements (slice 9 detail)

- `apple-mobile-web-app-capable: yes`
- `apple-mobile-web-app-status-bar-style: black-translucent`
- `apple-touch-icon` at 180×180
- Splash screens for common iPhone sizes (use a generator)
- Theme color matches app background to avoid status-bar mismatch
- Audio unlock pattern for the rest timer (first user gesture primes `AudioContext`)
- `display: standalone` in manifest

## 11. Open questions for implementation time

- Exact seed exercise list (defer until Slice 1)
- Visual design / color scheme (defer until Slice 0 is up; iterate)
- Whether to use `<dialog>` modals or routed full-screens for editing forms (lean full-screens on mobile)
