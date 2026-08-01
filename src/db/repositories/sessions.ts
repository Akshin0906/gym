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
): Promise<string> {
  const newId = crypto.randomUUID()
  const now = Date.now()

  await db.transaction(
    'rw',
    [db.workoutSessions, db.loggedSets, db.templateExercises],
    async () => {
      // Invariant 12: resolve any prior in-progress sessions.
      // Empty (no logged sets) sessions are deleted outright — they were
      // abandoned and don't belong in history.
      const stale = await db.workoutSessions
        .filter((s) => s.completedAt === null)
        .toArray()
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
          completedAt: lastSet.loggedAt,
        })
      }

      // Invariant 11: snapshot the template's exercises.
      const snapshot: SessionExerciseSnapshot[] = template
        ? (
            await db.templateExercises
              .where('[sessionTemplateId+order]')
              .between(
                [template.id, Dexie.minKey],
                [template.id, Dexie.maxKey],
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
        sessionTemplateId: template?.id ?? null,
        programId: program?.id ?? null,
        name: template?.name ?? 'Freestyle',
        programName: program?.name ?? null,
        exerciseSnapshot: snapshot,
        startedAt: now,
        completedAt: null,
      })
    },
  )

  return newId
}

// How long an in-progress session stays offered on the Today "Resume" card.
// A calendar-day cutoff stranded workouts that crossed midnight (started 11:50pm,
// finished after 12am) or were reopened the next morning. A rolling window keeps
// those resumable without resurfacing a day-old abandoned session.
export const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000

export function isResumable(
  startedAt: number,
  now: number = Date.now(),
): boolean {
  return now - startedAt <= RESUME_WINDOW_MS
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
  await db.workoutSessions.update(id, { completedAt: Date.now() })
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
  isPR: boolean
}

export async function logSet(args: {
  sessionId: string
  exerciseId: string
  weightLbs: number
  reps: number
  rpe: number | null
}): Promise<LogSetResult> {
  if (args.weightLbs < 1) throw new Error('Weight must be ≥ 1')
  if (args.reps < 1) throw new Error('Reps must be ≥ 1')
  if (args.rpe !== null && (args.rpe < 1 || args.rpe > 10))
    throw new Error('RPE must be between 1 and 10')

  const id = crypto.randomUUID()
  let setNumber = 1
  let isPR = false

  await db.transaction('rw', db.loggedSets, async () => {
    // Walk prior sets for this exercise via cursor — avoids materializing
    // the full history just to fold over it.
    let priorMax = 0
    let priorCount = 0
    await db.loggedSets
      .where('exerciseId')
      .equals(args.exerciseId)
      .each((s) => {
        priorCount++
        const e = estimated1RM(s.weightLbs, s.reps)
        if (e > priorMax) priorMax = e
      })
    const thisE1 = estimated1RM(args.weightLbs, args.reps)
    isPR = priorCount > 0 && thisE1 > priorMax

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
      loggedAt: Date.now(),
    })
  })
  return { id, setNumber, isPR }
}

export async function updateSet(
  id: string,
  patch: { weightLbs?: number; reps?: number; rpe?: number | null },
): Promise<void> {
  if (patch.weightLbs !== undefined && patch.weightLbs < 1)
    throw new Error('Weight must be ≥ 1')
  if (patch.reps !== undefined && patch.reps < 1)
    throw new Error('Reps must be ≥ 1')
  if (
    patch.rpe !== undefined &&
    patch.rpe !== null &&
    (patch.rpe < 1 || patch.rpe > 10)
  )
    throw new Error('RPE must be between 1 and 10')
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
    [db.workoutSessions, db.loggedSets],
    async () => {
      const s = await db.workoutSessions.get(sessionId)
      if (!s) throw new Error('Session not found')

      const fromSetCount = await db.loggedSets
        .where('[workoutSessionId+exerciseId+setNumber]')
        .between(
          [sessionId, fromExerciseId, Dexie.minKey],
          [sessionId, fromExerciseId, Dexie.maxKey],
        )
        .count()
      const toAlreadyInSnap = s.exerciseSnapshot.some(
        (x) => x.exerciseId === toExerciseId,
      )

      let snap = s.exerciseSnapshot
      if (fromSetCount === 0) {
        snap = snap.filter((x) => x.exerciseId !== fromExerciseId)
      }
      if (!toAlreadyInSnap) {
        const nextOrder = snap.length
          ? Math.max(...snap.map((x) => x.order)) + 1
          : 0
        snap = [
          ...snap,
          {
            exerciseId: toExerciseId,
            order: nextOrder,
            targetSets: 0,
            targetRepRange: '',
          },
        ]
      }
      await db.workoutSessions.update(sessionId, { exerciseSnapshot: snap })
    },
  )
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
