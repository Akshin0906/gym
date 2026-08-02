import Dexie from 'dexie'
import { db } from '../schema'
import { estimated1RM } from '../../lib/analytics'
import type {
  LoggedSet,
  Program,
  SessionExerciseSnapshot,
  SessionTemplate,
  SliderValue,
  WorkoutSession,
} from '../types'

export async function startSession(
  template: SessionTemplate | null,
  program: Program | null,
  options: { resolveExisting?: boolean } = {},
): Promise<string> {
  const newId = crypto.randomUUID()
  const now = Date.now()

  await db.transaction(
    'rw',
    [
      db.workoutSessions,
      db.loggedSets,
      db.templateExercises,
      db.sessionTemplates,
      db.programs,
    ],
    async () => {
      let authoritativeTemplate = template
      let authoritativeProgramName = program?.name ?? null
      // A stale preview must not start a template that has since been archived,
      // deactivated, deleted, or moved to another program.
      if ((template === null) !== (program === null)) {
        throw new SessionTemplateUnavailableError()
      }
      if (template && program) {
        const [currentTemplate, currentProgram] = await Promise.all([
          db.sessionTemplates.get(template.id),
          db.programs.get(program.id),
        ])
        if (
          !currentTemplate ||
          currentTemplate.programId !== program.id ||
          !currentProgram ||
          currentProgram.isActive !== 1 ||
          currentProgram.archivedAt !== null
        ) {
          throw new SessionTemplateUnavailableError()
        }
        authoritativeTemplate = currentTemplate
        authoritativeProgramName = currentProgram.name
      }

      // Never end or discard an existing workout as an implicit side effect of
      // starting another one. Callers must first show an explicit confirmation,
      // then retry with resolveExisting=true.
      const stale = await db.workoutSessions
        .filter((s) => s.completedAt === null)
        .toArray()
      if (stale.length > 0 && !options.resolveExisting) {
        throw new UnfinishedWorkoutError()
      }
      for (const s of stale) {
        const lastSet = await db.loggedSets
          .where('workoutSessionId')
          .equals(s.id)
          .reverse()
          .sortBy('loggedAt')
          .then((arr) => arr[0])
        if (!lastSet) {
          await db.workoutSessions.delete(s.id)
          continue
        }
        await db.workoutSessions.update(s.id, {
          completedAt: Math.max(lastSet.loggedAt, s.startedAt),
        })
      }

      // Invariant 11: snapshot the template's exercises.
      const snapshot: SessionExerciseSnapshot[] = authoritativeTemplate
        ? (
            await db.templateExercises
              .where('[sessionTemplateId+order]')
              .between(
                [authoritativeTemplate.id, Dexie.minKey],
                [authoritativeTemplate.id, Dexie.maxKey],
              )
              .toArray()
          ).map((te) => ({
            exerciseId: te.exerciseId,
            order: te.order,
            targetSets: te.targetSets,
            targetRepRange: te.targetRepRange,
          }))
        : []

      await db.workoutSessions.add({
        id: newId,
        sessionTemplateId: authoritativeTemplate?.id ?? null,
        programId: program?.id ?? null,
        name: authoritativeTemplate?.name ?? 'Freestyle',
        programName: authoritativeProgramName,
        exerciseSnapshot: snapshot,
        startedAt: now,
        completedAt: null,
      })
    },
  )

  return newId
}

export class UnfinishedWorkoutError extends Error {
  constructor() {
    super('An unfinished workout already exists')
    this.name = 'UnfinishedWorkoutError'
  }
}

export class SessionTemplateUnavailableError extends Error {
  constructor() {
    super('This workout is no longer available from the active program')
    this.name = 'SessionTemplateUnavailableError'
  }
}

export function isResumable(
  startedAt: number,
  now: number = Date.now(),
): boolean {
  const started = new Date(startedAt)
  const current = new Date(now)
  return (
    startedAt <= now &&
    started.getFullYear() === current.getFullYear() &&
    started.getMonth() === current.getMonth() &&
    started.getDate() === current.getDate()
  )
}

export async function getResumableSession(): Promise<WorkoutSession | undefined> {
  const inProgress = await db.workoutSessions
    .filter((s) => s.completedAt === null)
    .toArray()
  if (inProgress.length === 0) return undefined
  const candidate = inProgress.sort((a, b) => b.startedAt - a.startedAt)[0]
  return isResumable(candidate.startedAt) ? candidate : undefined
}

export async function getSession(id: string): Promise<WorkoutSession | undefined> {
  return db.workoutSessions.get(id)
}

export async function endSession(id: string): Promise<void> {
  const session = await db.workoutSessions.get(id)
  if (!session) throw new Error('Session not found')
  await db.workoutSessions.update(id, {
    completedAt: Math.max(Date.now(), session.startedAt),
  })
}

export async function updateSessionFeedback(
  id: string,
  feedback: { planned: SliderValue | null; feel: SliderValue | null },
): Promise<void> {
  await db.workoutSessions.update(id, {
    sessionPlanned: feedback.planned,
    sessionFeel: feedback.feel,
  })
}

export async function setSessionDoneExercises(
  id: string,
  doneExerciseIds: string[],
): Promise<void> {
  await db.workoutSessions.update(id, { doneExerciseIds })
}

export async function deleteSession(id: string): Promise<void> {
  await db.transaction('rw', [db.workoutSessions, db.loggedSets], async () => {
    await db.loggedSets.where('workoutSessionId').equals(id).delete()
    await db.workoutSessions.delete(id)
  })
}

export async function appendExerciseToSession(
  sessionId: string,
  exerciseId: string,
): Promise<void> {
  await db.transaction('rw', db.workoutSessions, async () => {
    const s = await db.workoutSessions.get(sessionId)
    if (!s) throw new Error('Session not found')
    if (s.exerciseSnapshot.some((x) => x.exerciseId === exerciseId)) return
    const nextOrder = s.exerciseSnapshot.length
      ? Math.max(...s.exerciseSnapshot.map((x) => x.order)) + 1
      : 0
    const snap = [
      ...s.exerciseSnapshot,
      {
        exerciseId,
        order: nextOrder,
        targetSets: 0,
        targetRepRange: '',
      },
    ]
    await db.workoutSessions.update(sessionId, { exerciseSnapshot: snap })
  })
}

export async function getSetsForSession(sessionId: string): Promise<LoggedSet[]> {
  return db.loggedSets
    .where('workoutSessionId')
    .equals(sessionId)
    .sortBy('loggedAt')
}

export async function getSetsForSessionExercise(
  sessionId: string,
  exerciseId: string,
): Promise<LoggedSet[]> {
  const all = await db.loggedSets
    .where('[workoutSessionId+exerciseId+setNumber]')
    .between(
      [sessionId, exerciseId, Dexie.minKey],
      [sessionId, exerciseId, Dexie.maxKey],
    )
    .toArray()
  return all.sort((a, b) => a.setNumber - b.setNumber)
}

export interface LogSetResult {
  id: string
  setNumber: number
}

function assertValidSetValues(values: {
  weightLbs?: number
  reps?: number
  rpe?: number | null
}): void {
  if (
    values.weightLbs !== undefined &&
    (!Number.isFinite(values.weightLbs) || values.weightLbs <= 0)
  ) {
    throw new Error('Weight must be a finite number greater than 0')
  }
  if (
    values.reps !== undefined &&
    (!Number.isSafeInteger(values.reps) || values.reps <= 0)
  ) {
    throw new Error('Reps must be a whole number greater than 0')
  }
  if (
    values.rpe !== undefined &&
    values.rpe !== null &&
    (!Number.isFinite(values.rpe) || values.rpe < 1 || values.rpe > 10)
  ) {
    throw new Error('RPE must be a finite number between 1 and 10')
  }
}

export async function logSet(args: {
  sessionId: string
  exerciseId: string
  weightLbs: number
  reps: number
  rpe: number | null
}): Promise<LogSetResult> {
  assertValidSetValues(args)

  const id = crypto.randomUUID()
  let setNumber = 1

  await db.transaction('rw', [db.loggedSets, db.workoutSessions], async () => {
    const session = await db.workoutSessions.get(args.sessionId)
    if (!session) throw new Error('Session not found')
    const now = Date.now()
    let loggedAt: number
    if (session.completedAt !== null) {
      loggedAt = Math.max(session.completedAt, session.startedAt)
    } else if (isResumable(session.startedAt, now)) {
      loggedAt = now
    } else {
      // History can expose an abandoned unfinished session from an earlier day.
      // Keep corrections in that session's chronology rather than polluting
      // today's analytics.
      loggedAt = session.startedAt
      await db.loggedSets
        .where('workoutSessionId')
        .equals(session.id)
        .each((set) => {
          loggedAt = Math.max(loggedAt, set.loggedAt)
        })
    }

    // Next setNumber: take the highest existing setNumber in this
    // (session, exercise) via the compound index. `.last()` returns the
    // entry with the highest trailing key (setNumber).
    const last = await db.loggedSets
      .where('[workoutSessionId+exerciseId+setNumber]')
      .between(
        [args.sessionId, args.exerciseId, Dexie.minKey],
        [args.sessionId, args.exerciseId, Dexie.maxKey],
      )
      .last()
    setNumber = last ? last.setNumber + 1 : 1

    await db.loggedSets.add({
      id,
      workoutSessionId: args.sessionId,
      exerciseId: args.exerciseId,
      setNumber,
      weightLbs: args.weightLbs,
      reps: args.reps,
      rpe: args.rpe,
      // Edits made from a completed session's History screen belong to that
      // session's chronology, not to the day the correction was entered.
      loggedAt,
    })
  })
  return { id, setNumber }
}

export async function updateSet(
  id: string,
  patch: { weightLbs?: number; reps?: number; rpe?: number | null },
): Promise<void> {
  assertValidSetValues(patch)
  await db.loggedSets.update(id, patch)
}

export async function deleteSet(id: string): Promise<void> {
  await db.transaction('rw', db.loggedSets, async () => {
    const target = await db.loggedSets.get(id)
    if (!target) return
    await db.loggedSets.delete(id)

    // Invariant 4: renumber remaining sets in same (session, exercise) to stay dense and 1-based.
    const remaining = await db.loggedSets
      .where('[workoutSessionId+exerciseId+setNumber]')
      .between(
        [target.workoutSessionId, target.exerciseId, Dexie.minKey],
        [target.workoutSessionId, target.exerciseId, Dexie.maxKey],
      )
      .toArray()
    remaining.sort((a, b) => a.setNumber - b.setNumber)
    for (let i = 0; i < remaining.length; i++) {
      const want = i + 1
      if (remaining[i].setNumber !== want) {
        await db.loggedSets.update(remaining[i].id, { setNumber: want })
      }
    }
  })
}

// Re-insert a set that was just deleted (undo). Re-adds it, then renumbers the
// (session, exercise) group densely so set numbers stay 1-based and contiguous
// regardless of where the restored set lands.
export async function restoreSet(set: LoggedSet): Promise<void> {
  await db.transaction('rw', db.loggedSets, async () => {
    const exists = await db.loggedSets.get(set.id)
    if (exists) return
    await db.loggedSets.add(set)
    const group = await db.loggedSets
      .where('[workoutSessionId+exerciseId+setNumber]')
      .between(
        [set.workoutSessionId, set.exerciseId, Dexie.minKey],
        [set.workoutSessionId, set.exerciseId, Dexie.maxKey],
      )
      .toArray()
    group.sort((a, b) => a.loggedAt - b.loggedAt)
    for (let i = 0; i < group.length; i++) {
      const want = i + 1
      if (group[i].setNumber !== want) {
        await db.loggedSets.update(group[i].id, { setNumber: want })
      }
    }
  })
}

export async function listSessionsDesc(): Promise<WorkoutSession[]> {
  return db.workoutSessions.orderBy('startedAt').reverse().toArray()
}

export async function listAllSets(): Promise<LoggedSet[]> {
  return db.loggedSets.toArray()
}

export async function getLastCompletedSessionForProgram(
  programId: string,
): Promise<WorkoutSession | undefined> {
  let best: WorkoutSession | undefined
  await db.workoutSessions
    .where('programId')
    .equals(programId)
    .each((s) => {
      if (s.completedAt === null) return
      if (!best || (s.completedAt ?? 0) > (best.completedAt ?? 0)) best = s
    })
  return best
}

export async function countSets(): Promise<number> {
  return db.loggedSets.count()
}

export async function countSessions(): Promise<number> {
  return db.workoutSessions.count()
}

export interface ExerciseE1RMPoint {
  completedAt: number
  e1rm: number
}

export async function getRecentSessionE1RMsForExercise(
  exerciseId: string,
  excludeSessionId: string | undefined,
  limit: number,
): Promise<ExerciseE1RMPoint[]> {
  const maxBySession = new Map<string, number>()
  await db.loggedSets
    .where('exerciseId')
    .equals(exerciseId)
    .each((s) => {
      if (excludeSessionId && s.workoutSessionId === excludeSessionId) return
      const e = estimated1RM(s.weightLbs, s.reps)
      const cur = maxBySession.get(s.workoutSessionId) ?? 0
      if (e > cur) maxBySession.set(s.workoutSessionId, e)
    })

  const sessions = await db.workoutSessions.bulkGet(
    Array.from(maxBySession.keys()),
  )
  const points: ExerciseE1RMPoint[] = []
  for (const s of sessions) {
    if (!s || s.completedAt === null) continue
    const e = maxBySession.get(s.id)
    if (e === undefined) continue
    points.push({ completedAt: s.completedAt, e1rm: Math.round(e) })
  }
  points.sort((a, b) => b.completedAt - a.completedAt)
  return points.slice(0, limit).reverse()
}

export async function swapExerciseInSession(
  sessionId: string,
  fromExerciseId: string,
  toExerciseId: string,
): Promise<void> {
  if (fromExerciseId === toExerciseId) return
  await db.transaction(
    'rw',
    [db.workoutSessions, db.loggedSets, db.exercises],
    async () => {
      const s = await db.workoutSessions.get(sessionId)
      if (!s) throw new Error('Session not found')
      if (!(await db.exercises.get(toExerciseId))) {
        throw new Error('Replacement exercise not found')
      }
      const snapshot = s.exerciseSnapshot
        .slice()
        .sort((a, b) => a.order - b.order)
      const sourceIndex = snapshot.findIndex(
        (row) => row.exerciseId === fromExerciseId,
      )
      if (sourceIndex === -1) {
        throw new Error('Exercise is not in this session')
      }
      if (snapshot.some((x) => x.exerciseId === toExerciseId)) {
        throw new Error('Replacement exercise is already in this session')
      }

      const source = snapshot[sourceIndex]
      const loggedCount = await db.loggedSets
        .where('[workoutSessionId+exerciseId+setNumber]')
        .between(
          [sessionId, fromExerciseId, Dexie.minKey],
          [sessionId, fromExerciseId, Dexie.maxKey],
        )
        .count()
      let doneExerciseIds = s.doneExerciseIds ?? []
      if (loggedCount === 0) {
        // No work to preserve: replace in place with identical targets.
        snapshot[sourceIndex] = { ...source, exerciseId: toExerciseId }
        doneExerciseIds = doneExerciseIds.filter(
          (id) => id !== fromExerciseId && id !== toExerciseId,
        )
      } else {
        // Keep performed work visible as a completed exercise, then insert the
        // replacement immediately after it. Prescribe only the remaining planned
        // sets, never the original exercise's full workload again.
        snapshot[sourceIndex] = { ...source, targetSets: loggedCount }
        const remainingSets = source.targetSets - loggedCount
        snapshot.splice(sourceIndex + 1, 0, {
          exerciseId: toExerciseId,
          order: source.order + 1,
          targetSets: Math.max(0, remainingSets),
          targetRepRange: source.targetRepRange,
        })
        doneExerciseIds = doneExerciseIds.filter((id) => id !== toExerciseId)
        if (!doneExerciseIds.includes(fromExerciseId)) {
          doneExerciseIds = [...doneExerciseIds, fromExerciseId]
        }
      }
      const exerciseSnapshot = snapshot.map((row, order) => ({ ...row, order }))
      await db.workoutSessions.update(sessionId, {
        exerciseSnapshot,
        doneExerciseIds,
      })
    },
  )
}

export async function getAllSetsForExercise(
  exerciseId: string,
): Promise<LoggedSet[]> {
  return db.loggedSets
    .where('[exerciseId+loggedAt]')
    .between([exerciseId, Dexie.minKey], [exerciseId, Dexie.maxKey])
    .reverse()
    .toArray()
}

export async function getLastSessionSetsForExercise(
  exerciseId: string,
  excludeSessionId?: string,
): Promise<LoggedSet[]> {
  // Two-step lookup (data spec §5.4): find most recent set, then all sets for that session+exercise.
  // If excludeSessionId is provided, skip sets from that session (used by active workout to show *previous* session).
  // Walk the index newest-first and stop at the first match instead of
  // materializing the whole exercise history just to read row 0.
  const mostRecent = await db.loggedSets
    .where('[exerciseId+loggedAt]')
    .between([exerciseId, Dexie.minKey], [exerciseId, Dexie.maxKey])
    .reverse()
    .filter((s) => !excludeSessionId || s.workoutSessionId !== excludeSessionId)
    .first()
  if (!mostRecent) return []
  return getSetsForSessionExercise(mostRecent.workoutSessionId, exerciseId)
}
