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

export interface WorkoutSession {
  id: string
  sessionTemplateId: string | null
  programId: string | null
  name: string
  programName: string | null
  exerciseSnapshot: SessionExerciseSnapshot[]
  startedAt: number
  completedAt: number | null
  sessionPlanned?: SliderValue | null
  sessionFeel?: SliderValue | null
  // Exercises collapsed ("done") in the active screen, in completion order.
  // Not indexed, so no Dexie migration; absent on older sessions.
  doneExerciseIds?: string[]
}

export type RecommendationMode = 'push' | 'normal' | 'light' | 'deload'
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
