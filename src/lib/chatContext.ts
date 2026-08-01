import { db } from '../db/schema'
import type {
  AiMemorySettings,
  AiMemorySummary,
  AiNote,
  DailyBriefing,
  Exercise,
  LoggedSet,
  ProgramRow,
  SessionExerciseSnapshot,
  SessionTemplate,
  TemplateExercise,
  WorkoutSession,
} from '../db/types'
import type { CoachActionStateHashes } from './chatTypes'

interface CoachContextExercise {
  id: string
  name: string
  primaryMuscle: Exercise['primaryMuscle']
  secondaryMuscles: Exercise['secondaryMuscles']
  notes: string
  defaultRestSeconds: number
  available: boolean
}

interface CoachContextSet {
  id: string
  setNumber: number
  weightLbs: number
  reps: number
  rpe: number | null
  loggedAt: number
}

interface CoachContextPlannedExercise {
  exerciseId: string
  exerciseName: string
  order: number
  targetSets: number
  repRange: string
}

export interface CoachLiveContext {
  generatedAt: number
  actionStateHashes: CoachActionStateHashes
  activeWorkout: null | {
    id: string
    name: string
    programName: string | null
    startedAt: number
    doneExerciseIds: string[]
    exercises: Array<
      CoachContextPlannedExercise & {
        done: boolean
        sets: CoachContextSet[]
      }
    >
  }
  exerciseCatalog: CoachContextExercise[]
  programs: Array<{
    id: string
    name: string
    active: boolean
    archived: boolean
    sessions: Array<{
      id: string
      name: string
      order: number
      exercises: CoachContextPlannedExercise[]
    }>
  }>
  recentWorkouts: Array<{
    id: string
    name: string
    programName: string | null
    startedAt: number
    completedAt: number | null
    sessionPlanned: number | null
    sessionFeel: number | null
    exercises: Array<{
      exerciseId: string
      exerciseName: string
      sets: CoachContextSet[]
    }>
  }>
  latestBriefing: null | Pick<
    DailyBriefing,
    'briefingDate' | 'headline' | 'mode' | 'sections' | 'model'
  >
  memory: {
    currentContext: string
    paused: boolean
    recentNotes: Array<Pick<AiNote, 'id' | 'body' | 'createdAt' | 'updatedAt'>>
    recentSummaries: Array<
      Pick<
        AiMemorySummary,
        'id' | 'periodType' | 'periodStartAt' | 'periodEndAt' | 'bullets'
      >
    >
  } | null
}

interface ContextRows {
  exercises: Exercise[]
  programs: ProgramRow[]
  templates: SessionTemplate[]
  templateExercises: TemplateExercise[]
  inProgress: WorkoutSession[]
  recentSessions: WorkoutSession[]
  relevantSets: LoggedSet[]
  latestBriefing: DailyBriefing | undefined
  memorySettings: AiMemorySettings | undefined
  notes: AiNote[]
  summaries: AiMemorySummary[]
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id)
}

function setContext(set: LoggedSet): CoachContextSet {
  return {
    id: set.id,
    setNumber: set.setNumber,
    weightLbs: set.weightLbs,
    reps: set.reps,
    rpe: set.rpe,
    loggedAt: set.loggedAt,
  }
}

function plannedExerciseContext(
  snap: SessionExerciseSnapshot | TemplateExercise,
  exercises: Map<string, Exercise>,
): CoachContextPlannedExercise {
  return {
    exerciseId: snap.exerciseId,
    exerciseName: exercises.get(snap.exerciseId)?.name ?? '(missing exercise)',
    order: snap.order,
    targetSets: snap.targetSets,
    repRange: snap.targetRepRange,
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      result[key] = canonicalize(source[key])
    }
    return result
  }
  return value
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

async function readContextRows(): Promise<ContextRows> {
  return db.transaction('r', db.tables, async () => {
    const [
      exercises,
      programs,
      templates,
      templateExercises,
      allInProgress,
      recentSessions,
      latestBriefing,
      memorySettings,
      notes,
      summaries,
    ] = await Promise.all([
      db.exercises.toArray(),
      db.programs.toArray(),
      db.sessionTemplates.toArray(),
      db.templateExercises.toArray(),
      db.workoutSessions.filter((session) => session.completedAt === null).toArray(),
      db.workoutSessions.orderBy('startedAt').reverse().limit(12).toArray(),
      db.dailyBriefings.orderBy('createdAt').last(),
      db.aiMemorySettings.get('default'),
      db.aiNotes.orderBy('createdAt').reverse().limit(20).toArray(),
      db.aiMemorySummaries.orderBy('periodEndAt').reverse().limit(12).toArray(),
    ])

    const relevantSessionIds = Array.from(
      new Set([...allInProgress, ...recentSessions].map((session) => session.id)),
    )
    const relevantSets = relevantSessionIds.length
      ? await db.loggedSets.where('workoutSessionId').anyOf(relevantSessionIds).toArray()
      : []

    return {
      exercises,
      programs,
      templates,
      templateExercises,
      inProgress: allInProgress.sort((a, b) => b.startedAt - a.startedAt),
      recentSessions,
      relevantSets,
      latestBriefing,
      memorySettings,
      notes,
      summaries,
    }
  })
}

export async function buildLiveCoachContext(
  preferredSessionId?: string,
): Promise<{ context: CoachLiveContext; stateHash: string }> {
  const rows = await readContextRows()
  const exerciseById = new Map(rows.exercises.map((exercise) => [exercise.id, exercise]))
  const setsBySession = new Map<string, LoggedSet[]>()
  for (const set of rows.relevantSets) {
    const list = setsBySession.get(set.workoutSessionId) ?? []
    list.push(set)
    setsBySession.set(set.workoutSessionId, list)
  }

  const preferred = preferredSessionId
    ? rows.inProgress.find((session) => session.id === preferredSessionId)
    : undefined
  const active = preferred ?? rows.inProgress[0] ?? null
  const activeSets = active ? setsBySession.get(active.id) ?? [] : []
  const activeSetsByExercise = new Map<string, LoggedSet[]>()
  for (const set of activeSets) {
    const list = activeSetsByExercise.get(set.exerciseId) ?? []
    list.push(set)
    activeSetsByExercise.set(set.exerciseId, list)
  }

  const templatesByProgram = new Map<string, SessionTemplate[]>()
  for (const template of rows.templates) {
    const list = templatesByProgram.get(template.programId) ?? []
    list.push(template)
    templatesByProgram.set(template.programId, list)
  }
  const templateExercisesByTemplate = new Map<string, TemplateExercise[]>()
  for (const row of rows.templateExercises) {
    const list = templateExercisesByTemplate.get(row.sessionTemplateId) ?? []
    list.push(row)
    templateExercisesByTemplate.set(row.sessionTemplateId, list)
  }

  const exerciseCatalogState = rows.exercises.slice().sort(byId).map((exercise) => ({
    id: exercise.id,
    name: exercise.name,
    hiddenFromLibrary: exercise.hiddenFromLibrary,
  }))
  const activeWorkoutState = {
    exerciseAvailability: exerciseCatalogState,
    activeWorkout: active
      ? {
          id: active.id,
          sessionTemplateId: active.sessionTemplateId,
          programId: active.programId,
          name: active.name,
          programName: active.programName,
          exerciseSnapshot: active.exerciseSnapshot
            .slice()
            .sort((a, b) => a.order - b.order),
        }
      : null,
  }
  const inProgressStructure = rows.inProgress.slice().sort(byId).map((session) => ({
    id: session.id,
    sessionTemplateId: session.sessionTemplateId,
    programId: session.programId,
    name: session.name,
    programName: session.programName,
    exerciseSnapshot: session.exerciseSnapshot
      .slice()
      .sort((a, b) => a.order - b.order),
    hasLoggedWork: (setsBySession.get(session.id) ?? []).length > 0,
  }))
  const programStructure = {
    exerciseCatalog: exerciseCatalogState,
    programs: rows.programs.slice().sort(byId),
    templates: rows.templates.slice().sort(byId),
    templateExercises: rows.templateExercises.slice().sort(byId),
  }
  const [activeWorkoutHash, oneTimeWorkoutHash, programHash] = await Promise.all([
    sha256(activeWorkoutState),
    sha256({
      exerciseCatalog: exerciseCatalogState,
      inProgress: inProgressStructure,
    }),
    sha256(programStructure),
  ])
  const actionStateHashes: CoachActionStateHashes = {
    active_workout: activeWorkoutHash,
    one_time_workout: oneTimeWorkoutHash,
    program: programHash,
  }

  const context: CoachLiveContext = {
    generatedAt: Date.now(),
    actionStateHashes,
    activeWorkout: active
      ? {
          id: active.id,
          name: active.name,
          programName: active.programName,
          startedAt: active.startedAt,
          doneExerciseIds: active.doneExerciseIds ?? [],
          exercises: active.exerciseSnapshot
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((snap) => ({
              ...plannedExerciseContext(snap, exerciseById),
              done: (active.doneExerciseIds ?? []).includes(snap.exerciseId),
              sets: (activeSetsByExercise.get(snap.exerciseId) ?? [])
                .slice()
                .sort((a, b) => a.setNumber - b.setNumber)
                .map(setContext),
            })),
        }
      : null,
    exerciseCatalog: rows.exercises
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((exercise) => ({
        id: exercise.id,
        name: exercise.name,
        primaryMuscle: exercise.primaryMuscle,
        secondaryMuscles: exercise.secondaryMuscles,
        notes: exercise.notes,
        defaultRestSeconds: exercise.defaultRestSeconds,
        available: !exercise.hiddenFromLibrary,
      })),
    programs: rows.programs
      .slice()
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name))
      .map((program) => ({
        id: program.id,
        name: program.name,
        active: program.isActive === 1,
        archived: program.archivedAt !== null,
        sessions: (templatesByProgram.get(program.id) ?? [])
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((template) => ({
            id: template.id,
            name: template.name,
            order: template.order,
            exercises: (templateExercisesByTemplate.get(template.id) ?? [])
              .slice()
              .sort((a, b) => a.order - b.order)
              .map((row) => plannedExerciseContext(row, exerciseById)),
          })),
      })),
    recentWorkouts: rows.recentSessions.map((session) => {
      const sessionSets = (setsBySession.get(session.id) ?? []).slice().sort(
        (a, b) => a.loggedAt - b.loggedAt,
      )
      const grouped = new Map<string, LoggedSet[]>()
      for (const set of sessionSets) {
        const list = grouped.get(set.exerciseId) ?? []
        list.push(set)
        grouped.set(set.exerciseId, list)
      }
      return {
        id: session.id,
        name: session.name,
        programName: session.programName,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        sessionPlanned: session.sessionPlanned ?? null,
        sessionFeel: session.sessionFeel ?? null,
        exercises: Array.from(grouped.entries()).map(([exerciseId, sets]) => ({
          exerciseId,
          exerciseName: exerciseById.get(exerciseId)?.name ?? '(missing exercise)',
          sets: sets.sort((a, b) => a.setNumber - b.setNumber).map(setContext),
        })),
      }
    }),
    latestBriefing: rows.latestBriefing
      ? {
          briefingDate: rows.latestBriefing.briefingDate,
          headline: rows.latestBriefing.headline,
          mode: rows.latestBriefing.mode,
          sections: rows.latestBriefing.sections,
          model: rows.latestBriefing.model,
        }
      : null,
    memory: rows.memorySettings
      ? {
          currentContext: rows.memorySettings.paused
            ? ''
            : rows.memorySettings.currentContext,
          paused: rows.memorySettings.paused,
          recentNotes: rows.memorySettings.paused
            ? []
            : rows.notes.map(({ id, body, createdAt, updatedAt }) => ({
                id,
                body,
                createdAt,
                updatedAt,
              })),
          recentSummaries: rows.memorySettings.paused
            ? []
            : rows.summaries.map(
                ({ id, periodType, periodStartAt, periodEndAt, bullets }) => ({
                  id,
                  periodType,
                  periodStartAt,
                  periodEndAt,
                  bullets,
                }),
              ),
        }
      : null,
  }

  const actionState = {
    exercises: exerciseCatalogState,
    programs: rows.programs.slice().sort(byId),
    templates: rows.templates.slice().sort(byId),
    templateExercises: rows.templateExercises.slice().sort(byId),
    inProgress: rows.inProgress.slice().sort(byId).map((session) => ({
      ...session,
      exerciseSnapshot: session.exerciseSnapshot
        .slice()
        .sort((a, b) => a.order - b.order),
      sets: (setsBySession.get(session.id) ?? []).slice().sort(byId),
    })),
  }

  return { context, stateHash: await sha256(actionState) }
}
