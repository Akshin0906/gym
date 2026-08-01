import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/schema'
import { buildLiveCoachContext } from './chatContext'

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
  await db.exercises.add({
    id: 'exercise',
    name: 'Chest Press',
    primaryMuscle: 'chest',
    secondaryMuscles: ['triceps'],
    notes: '',
    defaultRestSeconds: 90,
    isCustom: false,
    hiddenFromLibrary: false,
    createdAt: 1,
  })
  await db.workoutSessions.add({
    id: 'session',
    sessionTemplateId: null,
    programId: null,
    name: 'Live workout',
    programName: null,
    exerciseSnapshot: [
      {
        exerciseId: 'exercise',
        order: 0,
        targetSets: 3,
        targetRepRange: '8-10',
      },
    ],
    startedAt: 1,
    completedAt: null,
  })
})

describe('buildLiveCoachContext', () => {
  it('includes the active phone workout and produces a stable action hash', async () => {
    const first = await buildLiveCoachContext('session')
    const second = await buildLiveCoachContext('session')

    expect(first.context.activeWorkout?.name).toBe('Live workout')
    expect(first.context.activeWorkout?.exercises[0]).toMatchObject({
      exerciseId: 'exercise',
      exerciseName: 'Chest Press',
      targetSets: 3,
    })
    expect(first.stateHash).toHaveLength(64)
    expect(second.stateHash).toBe(first.stateHash)
  })

  it('changes the state hash when a live set is logged', async () => {
    const before = await buildLiveCoachContext('session')
    await db.loggedSets.add({
      id: 'set',
      workoutSessionId: 'session',
      exerciseId: 'exercise',
      setNumber: 1,
      weightLbs: 100,
      reps: 8,
      rpe: null,
      loggedAt: 2,
    })
    const after = await buildLiveCoachContext('session')

    expect(after.context.activeWorkout?.exercises[0].sets).toHaveLength(1)
    expect(after.stateHash).not.toBe(before.stateHash)
  })

  it('does not expose paused AI memory content to Coach', async () => {
    await db.aiMemorySettings.add({
      id: 'default',
      currentContext: 'private context',
      paused: true,
      windowStartedAt: 1,
      fourMonthStartedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    await db.aiNotes.add({
      id: 'note',
      body: 'private note',
      createdAt: 1,
      updatedAt: 1,
    })
    await db.aiMemorySummaries.add({
      id: 'summary',
      periodType: 'two_week',
      periodStartAt: 1,
      periodEndAt: 2,
      bullets: ['private summary'],
      sourceSessionIds: [],
      sourceNoteIds: [],
      sourceSummaryIds: [],
      model: 'test',
      createdAt: 2,
      updatedAt: 2,
    })

    const live = await buildLiveCoachContext('session')
    expect(live.context.memory).toEqual({
      currentContext: '',
      paused: true,
      recentNotes: [],
      recentSummaries: [],
    })
  })
})
