export type MuscleGroup =
  | 'chest'
  | 'back'
  | 'shoulders'
  | 'biceps'
  | 'triceps'
  | 'forearms'
  | 'quads'
  | 'hamstrings'
  | 'glutes'
  | 'calves'
  | 'abs'
  | 'traps'

// How the number stored in `LoggedSet.weightLbs` should be read. Legacy rows
// predate the field and stay `unknown`, which the math layer treats exactly
// like `total` so historical charts keep their original interpretation — but
// it is labelled as an assumption instead of a recorded fact.
export type LoadConvention =
  | 'unknown'
  | 'total'
  | 'per_dumbbell'
  | 'machine_setting'
  | 'bodyweight'
  | 'assistance'

export const LOAD_CONVENTIONS: readonly LoadConvention[] = [
  'unknown',
  'total',
  'per_dumbbell',
  'machine_setting',
  'bodyweight',
  'assistance',
]

// Optional advanced metadata. Absent on every legacy exercise; the resolver in
// lib/measurement.ts fills the compatible defaults rather than guessing units.
export interface ExerciseMeasurement {
  loadConvention: LoadConvention
}

export interface Exercise {
  id: string
  name: string
  primaryMuscle: MuscleGroup
  secondaryMuscles: MuscleGroup[]
  notes: string
  defaultRestSeconds: number
  isCustom: boolean
  hiddenFromLibrary: boolean
  createdAt: number
  // Case/whitespace-folded `name`, maintained by the exercises repository so
  // uniqueness can be enforced by a single indexed lookup inside one
  // transaction. Derived local index state: stripped from exports and rebuilt
  // on import, so backup and cloud payloads keep their existing shape.
  normalizedName?: string
  measurement?: ExerciseMeasurement
}

export interface Program {
  id: string
  name: string
  isActive: boolean
  createdAt: number
  archivedAt: number | null
}

// DB row form. `isActive` is numeric so Dexie can index it (IndexedDB
// can't index booleans). The repo translates to/from `Program` at the boundary.
export interface ProgramRow extends Omit<Program, 'isActive'> {
  isActive: 0 | 1
}

export interface SessionTemplate {
  id: string
  programId: string
  name: string
  order: number
}

// Structured form of `targetRepRange`. The free-text field remains the display
// source of truth; these bounds exist so attainment math never has to re-parse
// prose. `null` means "no machine-readable target", which is different from a
// missing field (legacy row that may still have a parseable text range).
export interface RepBounds {
  min: number
  max: number
}

export interface TemplateExercise {
  id: string
  sessionTemplateId: string
  exerciseId: string
  order: number
  targetSets: number
  targetRepRange: string
  repBounds?: RepBounds | null
  // Planned warm-up sets, excluded from target attainment. Absent = none known.
  warmupSets?: number
}

export interface SessionExerciseSnapshot {
  exerciseId: string
  order: number
  targetSets: number
  targetRepRange: string
  repBounds?: RepBounds | null
  warmupSets?: number
  // Frozen at session start so later edits to the exercise never rewrite how an
  // old session's numbers should be read.
  loadConvention?: LoadConvention
}

export type SliderValue = 1 | 2 | 3 | 4 | 5

export type ZeroToTenRating = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10

export type SessionRpe = ZeroToTenRating

export type PerceivedRecoveryScore = ZeroToTenRating

export interface PreWorkoutCheckInV1 {
  version: 1
  // Null records an explicit skip without fabricating a neutral score.
  perceivedRecovery: PerceivedRecoveryScore | null
  recordedAt: number
}

export type SessionPainImpact =
  | 'none'
  | 'present_no_effect'
  | 'modified'
  | 'stopped'

export interface PostWorkoutFeedbackV2 {
  version: 2
  // 1 = far below expectations; 5 = far above expectations.
  performance: SliderValue
  // Immediate whole-session rating of perceived exertion (Foster CR-10).
  sessionRpe: SessionRpe
  painImpact: SessionPainImpact
}

// Why planned work was not completed. Deliberately coarse and optional: it is
// context for the athlete and the Coach, never a clinical judgement, and
// "not_recorded" is a real answer rather than an absence.
export type UnfinishedWorkReason =
  | 'time'
  | 'equipment'
  | 'deliberate_change'
  | 'discomfort'
  | 'not_recorded'

export const UNFINISHED_WORK_REASONS: readonly UnfinishedWorkReason[] = [
  'time',
  'equipment',
  'deliberate_change',
  'discomfort',
  'not_recorded',
]

export interface UnfinishedWorkNoteV1 {
  version: 1
  reason: UnfinishedWorkReason
  recordedAt: number
}

export interface WorkoutSession {
  id: string
  sessionTemplateId: string | null
  programId: string | null
  name: string
  programName: string | null
  exerciseSnapshot: SessionExerciseSnapshot[]
  startedAt: number
  completedAt: number | null
  // Legacy 1-5 questions retained so historical exports keep their meaning.
  sessionPlanned?: SliderValue | null
  sessionFeel?: SliderValue | null
  // null = a new session awaiting the check-in; undefined = a legacy session.
  preWorkoutCheckIn?: PreWorkoutCheckInV1 | null
  postWorkoutFeedback?: PostWorkoutFeedbackV2 | null
  // Optional, separate from postWorkoutFeedback so existing feedback semantics
  // are untouched. Only meaningful when planned work exceeded completed work.
  unfinishedWork?: UnfinishedWorkNoteV1 | null
  // Exercises collapsed ("done") in the active screen, in completion order.
  // Not indexed, so no Dexie migration; absent on older sessions.
  doneExerciseIds?: string[]
}

export type RecommendationMode = 'push' | 'normal' | 'light' | 'deload' | 'rest'
export type RecoveryStatus = 'fresh' | 'stale' | 'unavailable'

export interface Recommendation {
  id: string
  createdAt: number
  headline: string
  mode: RecommendationMode
  bullets: string[]
  model: string
}

// Why the mode is what it is, decided by the trusted supervisor rather than by
// the model. `rest` covers a medical stop, a deliberate day off, and a
// precautionary stop on an unclassified current report, and the app should not
// have to guess which. Optional: briefings published before this existed have
// no value and stay valid.
export type BriefingModeReason =
  | 'medical_stop'
  | 'planned_rest'
  | 'precautionary_stop'
  | 'planned_deload'
  | 'reactive_deload'
  | 'temporary_training_adjustment'

export const BRIEFING_MODE_REASONS: readonly BriefingModeReason[] = [
  'medical_stop',
  'planned_rest',
  'precautionary_stop',
  'planned_deload',
  'reactive_deload',
  'temporary_training_adjustment',
]

export interface DailyBriefingSections {
  todaysCall: string
  why: string[]
  recoveryStatus?: RecoveryStatus
  ouraRecovery: string
  trainingTrend: string
  watchOuts: string[]
  modeReasonLabel?: BriefingModeReason
}

export interface DailyBriefing {
  briefingDate: string
  createdAt: number
  source: string
  snapshotUpdatedAt: number
  headline: string
  mode: RecommendationMode
  sections: DailyBriefingSections
  model: string
  inputSummary: unknown | null
}

export interface AiMemorySettings {
  id: string
  currentContext: string
  paused: boolean
  windowStartedAt: number
  fourMonthStartedAt: number
  createdAt: number
  updatedAt: number
}

export interface AiNote {
  id: string
  body: string
  createdAt: number
  updatedAt: number
}

export type AiMemorySummaryType = 'two_week' | 'four_month'

export interface AiMemorySummary {
  id: string
  periodType: AiMemorySummaryType
  periodStartAt: number
  periodEndAt: number
  bullets: string[]
  sourceSessionIds: string[]
  sourceNoteIds: string[]
  sourceSummaryIds: string[]
  model: string
  createdAt: number
  updatedAt: number
}

export type SetKind = 'working' | 'warmup'

export interface LoggedSet {
  id: string
  workoutSessionId: string
  exerciseId: string
  setNumber: number
  weightLbs: number
  reps: number
  rpe: number | null
  loggedAt: number
  // Absent on legacy rows, which are treated as working sets (the behaviour
  // every existing chart already assumes) but reported as unclassified.
  setKind?: SetKind
  // Denormalized from the exercise at log time. Editing an exercise's load
  // convention later must not silently re-interpret sets already recorded.
  loadConvention?: LoadConvention
}

// Device-local mirror bookkeeping. `localRevision` advances inside the same
// IndexedDB transaction as every trusted local mutation, so a correction to a
// historical set is just as visible to the uploader as a brand new workout.
// `syncedRevision` only advances to the revision that was actually captured in
// the payload the cloud accepted, so an edit made mid-upload stays pending.
//
// This is device-local derived state: it is never exported, never uploaded, and
// never imported. The single-user mirror design is unchanged — there is no
// merge, only "does this device have local work the mirror has not seen".
export interface LocalSyncState {
  id: 'local'
  localRevision: number
  syncedRevision: number
  lastMutationAt: number | null
  lastSyncedAt: number | null
  lastSyncedCloudUpdatedAt: number | null
  lastSyncError: string | null
  failedAttempts: number
  // Bumped whenever the local dataset is wholesale replaced (a backup restore).
  // An upload that was already in flight belongs to the previous dataset, so its
  // response must not be allowed to mark the restored data as mirrored.
  datasetEpoch: number
  // Bumped on every pairing change. An upload or a 401 that crosses a logout,
  // a re-pair, or a device swap belongs to a session that no longer exists and
  // must not touch the watermark or fence the new session.
  authEpoch: number
  // Earliest time the automatic scheduler may retry, from capped exponential
  // backoff. Manual and reconnect triggers deliberately ignore it.
  nextAutoAttemptAt: number | null
}

// The identity an in-flight cloud operation was started under. Captured with
// the payload and re-checked before anything is written back, so a late reply
// from a superseded dataset or session is discarded instead of applied.
export interface SyncFence {
  datasetEpoch: number
  authEpoch: number
}

// Local idempotency receipt for a confirmed Coach action. The cloud proposal
// result may be retried after the IndexedDB transaction has already committed;
// retaining this row prevents a duplicate workout or program from being made.
export interface ChatActionReceipt {
  proposalId: string
  appliedAt: number
  sourceStateHash: string
  resultJson: string
}
