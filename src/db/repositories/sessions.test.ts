import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../schema'
import type {
  Exercise,
  Program,
  SessionTemplate,
  WorkoutSession,
} from '../types'
import {
  getAllSetsForExercise,
  logSet,
  SessionTemplateUnavailableError,
  startSession,
  swapExerciseInSession,
  UnfinishedWorkoutError,
  updateSet,
} from './sessions'

async function clearAll() {
  await Promise.all(db.tables.map((table) => table.clear()))
}

function session(
  id: string,
  exerciseSnapshot: WorkoutSession['exerciseSnapshot'] = [],
): WorkoutSession {
  return {
    id,
    sessionTemplateId: null,
    programId: null,
    name: id,
    programName: null,
    exerciseSnapshot,
    startedAt: 100,
    completedAt: null,
  }
}

function exercise(id: string): Exercise {
  return {
    id,
    name: id,
    primaryMuscle: 'chest',
    secondaryMuscles: [],
    notes: '',
    defaultRestSeconds: 90,
    isCustom: false,
    hiddenFromLibrary: false,
    createdAt: 0,
  }
}

beforeEach(clearAll)
afterEach(() => vi.restoreAllMocks())

describe('startSession', () => {
  it('requires explicit resolution before replacing an unfinished workout', async () => {
    const firstId = await startSession(null, null)

    await expect(startSession(null, null)).rejects.toBeInstanceOf(
      UnfinishedWorkoutError,
    )
    expect((await db.workoutSessions.get(firstId))?.completedAt).toBeNull()
    expect(await db.workoutSessions.count()).toBe(1)

    const secondId = await startSession(null, null, { resolveExisting: true })
    expect(await db.workoutSessions.get(firstId)).toBeUndefined()
    expect((await db.workoutSessions.get(secondId))?.completedAt).toBeNull()
  })

  it('preserves worked sets and ends the old workout at its last set after confirmation', async () => {
    const firstId = await startSession(null, null)
    await logSet({
      sessionId: firstId,
      exerciseId: 'bench',
      weightLbs: 100,
      reps: 8,
      rpe: null,
    })
    const logged = (await db.loggedSets.toArray())[0]

    await startSession(null, null, { resolveExisting: true })

    expect((await db.workoutSessions.get(firstId))?.completedAt).toBe(
      logged.loggedAt,
    )
    expect(await db.loggedSets.get(logged.id)).toBeDefined()
  })

  it('rejects inactive and archived template deep links', async () => {
    const template: SessionTemplate = {
      id: 'template',
      programId: 'program',
      name: 'Push',
      order: 0,
    }
    const inactiveProgram: Program = {
      id: 'program',
      name: 'Plan',
      isActive: false,
      createdAt: 1,
      archivedAt: null,
    }
    await db.programs.add({ ...inactiveProgram, isActive: 0 })
    await db.sessionTemplates.add(template)

    await expect(startSession(template, inactiveProgram)).rejects.toBeInstanceOf(
      SessionTemplateUnavailableError,
    )

    await db.programs.update('program', {
      isActive: 1,
      archivedAt: null,
      name: 'Current Plan',
    })
    await db.sessionTemplates.update('template', { name: 'Current Push' })
    const startedId = await startSession(
      { ...template, name: 'Stale Push' },
      { ...inactiveProgram, name: 'Stale Plan', isActive: true },
    )
    expect(await db.workoutSessions.get(startedId)).toMatchObject({
      name: 'Current Push',
      programName: 'Current Plan',
    })
    await db.workoutSessions.delete(startedId)

    await db.programs.update('program', { isActive: 1, archivedAt: 10 })
    await expect(
      startSession(template, {
        ...inactiveProgram,
        isActive: true,
        archivedAt: 10,
      }),
    ).rejects.toBeInstanceOf(SessionTemplateUnavailableError)
  })
})

describe('logSet chronology', () => {
  it('uses a completed session timestamp for a historical correction', async () => {
    await db.workoutSessions.add({
      ...session('historical'),
      startedAt: 1_000,
      completedAt: 2_000,
    })

    const result = await logSet({
      sessionId: 'historical',
      exerciseId: 'bench',
      weightLbs: 135,
      reps: 10,
      rpe: 8,
    })

    expect((await db.loggedSets.get(result.id))?.loggedAt).toBe(2_000)
  })

  it('keeps a correction to an older unfinished session on its original day', async () => {
    const now = new Date(2026, 5, 21, 12).getTime()
    const startedAt = new Date(2026, 5, 20, 18).getTime()
    const lastLoggedAt = new Date(2026, 5, 20, 19).getTime()
    await db.workoutSessions.add({
      ...session('abandoned'),
      startedAt,
      completedAt: null,
    })
    await db.loggedSets.add({
      id: 'older-set',
      workoutSessionId: 'abandoned',
      exerciseId: 'bench',
      setNumber: 1,
      weightLbs: 100,
      reps: 8,
      rpe: null,
      loggedAt: lastLoggedAt,
    })
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)

    const result = await logSet({
      sessionId: 'abandoned',
      exerciseId: 'bench',
      weightLbs: 105,
      reps: 8,
      rpe: null,
    })
    nowSpy.mockRestore()

    expect((await db.loggedSets.get(result.id))?.loggedAt).toBe(lastLoggedAt)
  })
})

describe('logged set value validation', () => {
  beforeEach(async () => {
    await db.workoutSessions.add(session('validation'))
  })

  it.each([
    { weightLbs: Number.NaN, reps: 8, rpe: null },
    { weightLbs: Number.POSITIVE_INFINITY, reps: 8, rpe: null },
    { weightLbs: 100, reps: 1.5, rpe: null },
    { weightLbs: 100, reps: Number.NaN, rpe: null },
    { weightLbs: 100, reps: 8, rpe: Number.POSITIVE_INFINITY },
  ])('rejects a non-restorable set payload', async (values) => {
    await expect(
      logSet({
        sessionId: 'validation',
        exerciseId: 'bench',
        ...values,
      }),
    ).rejects.toThrow()
    expect(await db.loggedSets.count()).toBe(0)
  })

  it('rejects an invalid update without changing the stored set', async () => {
    const { id } = await logSet({
      sessionId: 'validation',
      exerciseId: 'bench',
      weightLbs: 100,
      reps: 8,
      rpe: 7.5,
    })

    await expect(updateSet(id, { reps: 2.5 })).rejects.toThrow(
      'Reps must be a whole number',
    )
    expect(await db.loggedSets.get(id)).toMatchObject({
      weightLbs: 100,
      reps: 8,
      rpe: 7.5,
    })
  })
})

describe('swapExerciseInSession', () => {
  beforeEach(async () => {
    await db.exercises.add(exercise('c'))
  })

  it('replaces an unperformed exercise in place with its order and targets', async () => {
    await db.workoutSessions.add({
      ...session('swap-empty', [
        { exerciseId: 'a', order: 0, targetSets: 4, targetRepRange: '6-8' },
        { exerciseId: 'b', order: 1, targetSets: 3, targetRepRange: '10-12' },
      ]),
      doneExerciseIds: ['a'],
    })

    await swapExerciseInSession('swap-empty', 'a', 'c')

    const updated = await db.workoutSessions.get('swap-empty')
    expect(updated?.exerciseSnapshot).toEqual([
      { exerciseId: 'c', order: 0, targetSets: 4, targetRepRange: '6-8' },
      { exerciseId: 'b', order: 1, targetSets: 3, targetRepRange: '10-12' },
    ])
    expect(updated?.doneExerciseIds).toEqual([])
  })

  it('keeps performed work visible and inserts a dense remaining-work replacement next', async () => {
    await db.workoutSessions.add(
      session('swap-worked', [
        { exerciseId: 'a', order: 3, targetSets: 4, targetRepRange: '6-8' },
        { exerciseId: 'b', order: 9, targetSets: 3, targetRepRange: '10-12' },
      ]),
    )
    await db.loggedSets.add({
      id: 'performed',
      workoutSessionId: 'swap-worked',
      exerciseId: 'a',
      setNumber: 1,
      weightLbs: 100,
      reps: 8,
      rpe: null,
      loggedAt: 150,
    })

    await swapExerciseInSession('swap-worked', 'a', 'c')

    const updated = await db.workoutSessions.get('swap-worked')
    expect(updated?.exerciseSnapshot).toEqual([
      { exerciseId: 'a', order: 0, targetSets: 1, targetRepRange: '6-8' },
      { exerciseId: 'c', order: 1, targetSets: 3, targetRepRange: '6-8' },
      { exerciseId: 'b', order: 2, targetSets: 3, targetRepRange: '10-12' },
    ])
    expect(updated?.doneExerciseIds).toEqual(['a'])
    expect(await db.loggedSets.get('performed')).toBeDefined()
  })

  it('prescribes no duplicate work when the original target was already met', async () => {
    await db.workoutSessions.add(
      session('swap-complete', [
        { exerciseId: 'a', order: 0, targetSets: 2, targetRepRange: '8-10' },
      ]),
    )
    await db.loggedSets.bulkAdd(
      [1, 2].map((setNumber) => ({
        id: `complete-${setNumber}`,
        workoutSessionId: 'swap-complete',
        exerciseId: 'a',
        setNumber,
        weightLbs: 100,
        reps: 8,
        rpe: null,
        loggedAt: 100 + setNumber,
      })),
    )

    await swapExerciseInSession('swap-complete', 'a', 'c')

    expect((await db.workoutSessions.get('swap-complete'))?.exerciseSnapshot).toEqual([
      { exerciseId: 'a', order: 0, targetSets: 2, targetRepRange: '8-10' },
      { exerciseId: 'c', order: 1, targetSets: 0, targetRepRange: '8-10' },
    ])
  })

  it('rejects a replacement exercise that no longer exists', async () => {
    await db.workoutSessions.add(
      session('swap-missing', [
        { exerciseId: 'a', order: 0, targetSets: 2, targetRepRange: '8-10' },
      ]),
    )

    await expect(
      swapExerciseInSession('swap-missing', 'a', 'missing'),
    ).rejects.toThrow('Replacement exercise not found')
    expect((await db.workoutSessions.get('swap-missing'))?.exerciseSnapshot[0])
      .toMatchObject({ exerciseId: 'a', targetSets: 2 })
  })
})

describe('getAllSetsForExercise', () => {
  it('returns every set newest first across sessions', async () => {
    await db.loggedSets.bulkAdd(
      [100, 300, 200].map((loggedAt, index) => ({
        id: `set-${loggedAt}`,
        workoutSessionId: `session-${index}`,
        exerciseId: 'bench',
        setNumber: 1,
        weightLbs: 100,
        reps: 8,
        rpe: null,
        loggedAt,
      })),
    )

    expect((await getAllSetsForExercise('bench')).map((set) => set.loggedAt)).toEqual([
      300, 200, 100,
    ])
  })
})
