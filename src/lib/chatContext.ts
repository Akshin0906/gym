import { db } from '../db/schema'
import type {
  AiMemorySettings,
  AiMemorySummary,
  AiNote,
  DailyBriefing,
  Exercise,
  LoadConvention,
  LoggedSet,
  PostWorkoutFeedbackV2,
  PreWorkoutCheckInV1,
  ProgramRow,
  RepBounds,
  SessionExerciseSnapshot,
  SessionTemplate,
  SetKind,
  TemplateExercise,
  UnfinishedWorkNoteV1,
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
  // Omitted when unrecorded, so the Coach can tell "warm-up" from "unclassified"
  // and "assistance" from "assumed pounds" instead of inferring either.
  setKind?: SetKind
  loadConvention?: LoadConvention
}

interface CoachContextPlannedExercise {
  exerciseId: string
  exerciseName: string
  order: number
  targetSets: number
  repRange: string
  repBounds?: RepBounds | null
  warmupSets?: number
  loadConvention?: LoadConvention
  planSource: 'frozen_session' | 'live_template'
}

export interface CoachLiveContext {
  generatedAt: number
  actionStateHashes: CoachActionStateHashes
  activeWorkout: null | {
    id: string
    name: string
    programName: string | null
    startedAt: number
    preWorkoutCheckIn: PreWorkoutCheckInV1 | null
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
    preWorkoutCheckIn: PreWorkoutCheckInV1 | null
    postWorkoutFeedback: PostWorkoutFeedbackV2 | null
    // Optional context the athlete recorded for planned work that was not
    // completed. Passed through so the Coach reads the stated reason instead of
    // inferring one from missing sets.
    unfinishedWork: UnfinishedWorkNoteV1 | null
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

export interface ProgramActionStateRows {
  exercises: Exercise[]
  programs: ProgramRow[]
  templates: SessionTemplate[]
  templateExercises: TemplateExercise[]
}

export interface ActiveWorkoutActionStateRows {
  exercises: Exercise[]
  inProgress: WorkoutSession[]
  loggedSets: LoggedSet[]
}

export type OneTimeWorkoutActionStateRows = ActiveWorkoutActionStateRows

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
    ...(set.setKind !== undefined ? { setKind: set.setKind } : {}),
    ...(set.loadConvention !== undefined
      ? { loadConvention: set.loadConvention }
      : {}),
  }
}

// A session snapshot and a program template are different kinds of plan, and
// the difference matters here.
//
// A snapshot is frozen history: its measurement is whatever was recorded when
// the session started, and falling back to the exercise's current setting would
// let one edit retroactively change what an old session meant — the same bug
// the analytics layer had.
//
// A template is a live plan for future work, so reading the exercise's current
// setting is correct: that is the measurement the next session will freeze.
function plannedExerciseContext(
  snap: SessionExerciseSnapshot | TemplateExercise,
  exercises: Map<string, Exercise>,
  source: 'frozen_session' | 'live_template',
): CoachContextPlannedExercise {
  const frozen = 'loadConvention' in snap ? snap.loadConvention : undefined
  const loadConvention =
    source === 'frozen_session'
      ? (frozen ?? 'unknown')
      : (frozen ?? exercises.get(snap.exerciseId)?.measurement?.loadConvention)
  return {
    exerciseId: snap.exerciseId,
    exerciseName: exercises.get(snap.exerciseId)?.name ?? '(missing exercise)',
    order: snap.order,
    targetSets: snap.targetSets,
    repRange: snap.targetRepRange,
    ...(snap.repBounds !== undefined ? { repBounds: snap.repBounds } : {}),
    ...(snap.warmupSets !== undefined ? { warmupSets: snap.warmupSets } : {}),
    ...(loadConvention !== undefined ? { loadConvention } : {}),
    // Says which of the two the Coach is looking at, so it never treats a
    // frozen `unknown` as "the exercise has no convention configured".
    planSource: source,
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

// Shared by every action-state hash. `measurement` is included because it is an
// input to the actions themselves: a new or swapped plan row freezes the
// exercise's current convention, and that convention decides whether a
// zero-load set is valid. A plan proposed before the convention changed would
// therefore mean something different if applied after, so it must read stale.
function exerciseCatalogActionState(exercises: Exercise[]) {
  return exercises.slice().sort(byId).map((exercise) => ({
    id: exercise.id,
    name: exercise.name,
    hiddenFromLibrary: exercise.hiddenFromLibrary,
    measurement: exercise.measurement ?? null,
  }))
}

function sortedInProgressSessions(
  sessions: WorkoutSession[],
): WorkoutSession[] {
  return sessions
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
}

export async function hashActiveWorkoutActionState(
  rows: ActiveWorkoutActionStateRows,
  preferredSessionId?: string,
): Promise<string> {
  const inProgress = sortedInProgressSessions(rows.inProgress)
  const preferred = preferredSessionId
    ? inProgress.find((session) => session.id === preferredSessionId)
    : undefined
  const active = preferred ?? inProgress[0] ?? null
  const loggedSetCounts = new Map<string, number>()
  if (active) {
    for (const snapshot of active.exerciseSnapshot) {
      loggedSetCounts.set(snapshot.exerciseId, 0)
    }
    for (const set of rows.loggedSets) {
      if (
        set.workoutSessionId === active.id &&
        loggedSetCounts.has(set.exerciseId)
      ) {
        loggedSetCounts.set(
          set.exerciseId,
          (loggedSetCounts.get(set.exerciseId) ?? 0) + 1,
        )
      }
    }
  }
  return sha256({
    exerciseAvailability: exerciseCatalogActionState(rows.exercises),
    activeWorkout: active
      ? {
          id: active.id,
          sessionTemplateId: active.sessionTemplateId,
          programId: active.programId,
          name: active.name,
          programName: active.programName,
          doneExerciseIds: (active.doneExerciseIds ?? [])
            .slice()
            .sort((a, b) => a.localeCompare(b)),
          exerciseSnapshot: active.exerciseSnapshot
            .slice()
            .sort((a, b) => a.order - b.order),
          loggedSetCounts: Array.from(loggedSetCounts.entries())
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([exerciseId, count]) => ({ exerciseId, count })),
        }
      : null,
  })
}

export async function hashOneTimeWorkoutActionState(
  rows: OneTimeWorkoutActionStateRows,
): Promise<string> {
  const sessionsWithWork = new Set(
    rows.loggedSets.map((set) => set.workoutSessionId),
  )
  return sha256({
    exerciseCatalog: exerciseCatalogActionState(rows.exercises),
    inProgress: rows.inProgress.slice().sort(byId).map((session) => ({
      id: session.id,
      sessionTemplateId: session.sessionTemplateId,
      programId: session.programId,
      name: session.name,
      programName: session.programName,
      exerciseSnapshot: session.exerciseSnapshot
        .slice()
        .sort((a, b) => a.order - b.order),
      hasLoggedWork: sessionsWithWork.has(session.id),
    })),
  })
}

export async function hashProgramActionState(
  rows: ProgramActionStateRows,
): Promise<string> {
  return sha256({
    exerciseCatalog: exerciseCatalogActionState(rows.exercises),
    programs: rows.programs.slice().sort(byId),
    templates: rows.templates.slice().sort(byId),
    templateExercises: rows.templateExercises.slice().sort(byId),
  })
}

export async function hashExerciseLibraryActionState(
  exercises: Exercise[],
): Promise<string> {
  return sha256(
    exercises.slice().sort(byId).map((exercise) => ({
      id: exercise.id,
      name: exercise.name,
      primaryMuscle: exercise.primaryMuscle,
      secondaryMuscles: exercise.secondaryMuscles,
      notes: exercise.notes,
      defaultRestSeconds: exercise.defaultRestSeconds,
      isCustom: exercise.isCustom,
      hiddenFromLibrary: exercise.hiddenFromLibrary,
      createdAt: exercise.createdAt,
      // Changing what an exercise's weight number means changes what a Coach
      // plan written against it would mean, so it belongs in the staleness
      // fingerprint. `normalizedName` is derived from `name` and is not.
      measurement: exercise.measurement ?? null,
    })),
  )
}

export async function hashAiMemoryActionState(
  memorySettings: AiMemorySettings | undefined,
): Promise<string> {
  // Saving a note is append-only. Only availability should invalidate a
  // pending proposal; unrelated notes or summaries can safely change.
  return sha256({ paused: memorySettings?.paused ?? false })
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
      inProgress: sortedInProgressSessions(allInProgress),
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
  const inProgress = sortedInProgressSessions(rows.inProgress)
  const exerciseById = new Map(rows.exercises.map((exercise) => [exercise.id, exercise]))
  const setsBySession = new Map<string, LoggedSet[]>()
  for (const set of rows.relevantSets) {
    const list = setsBySession.get(set.workoutSessionId) ?? []
    list.push(set)
    setsBySession.set(set.workoutSessionId, list)
  }

  const preferred = preferredSessionId
    ? inProgress.find((session) => session.id === preferredSessionId)
    : undefined
  const active = preferred ?? inProgress[0] ?? null
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

  const exerciseCatalogState = exerciseCatalogActionState(rows.exercises)
  const [
    activeWorkoutHash,
    oneTimeWorkoutHash,
    programHash,
    exerciseLibraryHash,
    aiMemoryHash,
  ] =
    await Promise.all([
      hashActiveWorkoutActionState(
        {
          exercises: rows.exercises,
          inProgress,
          loggedSets: rows.relevantSets,
        },
        preferredSessionId,
      ),
      hashOneTimeWorkoutActionState({
        exercises: rows.exercises,
        inProgress,
        loggedSets: rows.relevantSets,
      }),
      hashProgramActionState(rows),
      hashExerciseLibraryActionState(rows.exercises),
      hashAiMemoryActionState(rows.memorySettings),
    ])
  const actionStateHashes: CoachActionStateHashes = {
    active_workout: activeWorkoutHash,
    one_time_workout: oneTimeWorkoutHash,
    program: programHash,
    exercise_library: exerciseLibraryHash,
    ai_memory: aiMemoryHash,
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
          preWorkoutCheckIn: active.preWorkoutCheckIn ?? null,
          doneExerciseIds: active.doneExerciseIds ?? [],
          exercises: active.exerciseSnapshot
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((snap) => ({
              ...plannedExerciseContext(snap, exerciseById, 'frozen_session'),
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
              .map((row) =>
                plannedExerciseContext(row, exerciseById, 'live_template'),
              ),
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
        preWorkoutCheckIn: session.preWorkoutCheckIn ?? null,
        postWorkoutFeedback: session.postWorkoutFeedback ?? null,
        unfinishedWork: session.unfinishedWork ?? null,
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
    inProgress: inProgress.slice().sort(byId).map((session) => ({
      ...session,
      exerciseSnapshot: session.exerciseSnapshot
        .slice()
        .sort((a, b) => a.order - b.order),
      sets: (setsBySession.get(session.id) ?? []).slice().sort(byId),
    })),
  }

  return { context, stateHash: await sha256(actionState) }
}
