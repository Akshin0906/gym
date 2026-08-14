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

export interface TemplateExercise {
  id: string
  sessionTemplateId: string
  exerciseId: string
  order: number
  targetSets: number
  targetRepRange: string
}

export interface SessionExerciseSnapshot {
  exerciseId: string
  order: number
  targetSets: number
  targetRepRange: string
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

export interface DailyBriefingSections {
  todaysCall: string
  why: string[]
  recoveryStatus?: RecoveryStatus
  ouraRecovery: string
  trainingTrend: string
  watchOuts: string[]
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

export interface LoggedSet {
  id: string
  workoutSessionId: string
  exerciseId: string
  setNumber: number
  weightLbs: number
  reps: number
  rpe: number | null
  loggedAt: number
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
