import Dexie, { type Table } from 'dexie'
import type {
  Exercise,
  ProgramRow,
  SessionTemplate,
  TemplateExercise,
  WorkoutSession,
  LoggedSet,
  Recommendation,
  DailyBriefing,
  AiMemorySettings,
  AiNote,
  AiMemorySummary,
  ChatActionReceipt,
} from './types'

export class WorkoutDB extends Dexie {
  exercises!: Table<Exercise, string>
  programs!: Table<ProgramRow, string>
  sessionTemplates!: Table<SessionTemplate, string>
  templateExercises!: Table<TemplateExercise, string>
  workoutSessions!: Table<WorkoutSession, string>
  loggedSets!: Table<LoggedSet, string>
  recommendations!: Table<Recommendation, string>
  dailyBriefings!: Table<DailyBriefing, string>
  aiMemorySettings!: Table<AiMemorySettings, string>
  aiNotes!: Table<AiNote, string>
  aiMemorySummaries!: Table<AiMemorySummary, string>
  chatActionReceipts!: Table<ChatActionReceipt, string>

  constructor() {
    super('workoutTracker')
    this.version(1).stores({
      exercises: 'id, name, primaryMuscle, isCustom',
      programs: 'id, isActive, archivedAt',
      sessionTemplates: 'id, programId, [programId+order]',
      templateExercises:
        'id, sessionTemplateId, exerciseId, [sessionTemplateId+order]',
      workoutSessions:
        'id, sessionTemplateId, programId, startedAt, completedAt',
      loggedSets:
        'id, workoutSessionId, exerciseId, [exerciseId+loggedAt], [workoutSessionId+exerciseId+setNumber]',
    })
    this.version(2).stores({
      recommendations: 'id, createdAt',
    })
    this.version(3).stores({
      aiMemorySettings: 'id',
      aiNotes: 'id, createdAt',
      aiMemorySummaries:
        'id, periodType, periodStartAt, periodEndAt, [periodType+periodStartAt]',
    })
    this.version(4).stores({
      dailyBriefings: 'briefingDate, createdAt',
    })
    this.version(5).stores({
      chatActionReceipts: 'proposalId, appliedAt',
    })
  }
}

export const db = new WorkoutDB()
