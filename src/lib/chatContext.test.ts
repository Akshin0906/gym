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
    expect(first.context.actionStateHashes).toEqual(
      expect.objectContaining({
        active_workout: expect.stringMatching(/^[a-f0-9]{64}$/),
        one_time_workout: expect.stringMatching(/^[a-f0-9]{64}$/),
        program: expect.stringMatching(/^[a-f0-9]{64}$/),
        ai_memory: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    )
    expect(second.context.actionStateHashes).toEqual(
      first.context.actionStateHashes,
    )
  })

  it('keeps active plans valid when current or unrelated sets and done flags change', async () => {
    await db.workoutSessions.add({
      id: 'other-session',
      sessionTemplateId: null,
      programId: null,
      name: 'Other workout',
      programName: null,
      exerciseSnapshot: [
        {
          exerciseId: 'exercise',
          order: 0,
          targetSets: 2,
          targetRepRange: '12-15',
        },
      ],
      startedAt: 0,
      completedAt: null,
    })
    const before = await buildLiveCoachContext('session')
    await db.loggedSets.bulkAdd([
      {
        id: 'set',
        workoutSessionId: 'session',
        exerciseId: 'exercise',
        setNumber: 1,
        weightLbs: 100,
        reps: 8,
        rpe: null,
        loggedAt: 2,
      },
      {
        id: 'other-set',
        workoutSessionId: 'other-session',
        exerciseId: 'exercise',
        setNumber: 1,
        weightLbs: 50,
        reps: 12,
        rpe: null,
        loggedAt: 2,
      },
    ])
    await db.workoutSessions.update('session', {
      doneExerciseIds: ['exercise'],
    })
    const after = await buildLiveCoachContext('session')

    expect(after.context.activeWorkout?.exercises[0].sets).toHaveLength(1)
    expect(after.stateHash).not.toBe(before.stateHash)
    expect(after.context.actionStateHashes.active_workout).toBe(
      before.context.actionStateHashes.active_workout,
    )
    expect(after.context.actionStateHashes.program).toBe(
      before.context.actionStateHashes.program,
    )
    expect(after.context.actionStateHashes.one_time_workout).not.toBe(
      before.context.actionStateHashes.one_time_workout,
    )
  })

  it('invalidates an active plan when workout targets or roster change', async () => {
    await db.exercises.add({
      id: 'second-exercise',
      name: 'Cable Fly',
      primaryMuscle: 'chest',
      secondaryMuscles: [],
      notes: '',
      defaultRestSeconds: 60,
      isCustom: false,
      hiddenFromLibrary: false,
      createdAt: 2,
    })
    const before = await buildLiveCoachContext('session')

    await db.workoutSessions.update('session', {
      exerciseSnapshot: [
        {
          exerciseId: 'exercise',
          order: 0,
          targetSets: 4,
          targetRepRange: '6-8',
        },
      ],
    })
    const afterTargets = await buildLiveCoachContext('session')
    expect(afterTargets.context.actionStateHashes.active_workout).not.toBe(
      before.context.actionStateHashes.active_workout,
    )

    await db.workoutSessions.update('session', {
      exerciseSnapshot: [
        {
          exerciseId: 'exercise',
          order: 0,
          targetSets: 4,
          targetRepRange: '6-8',
        },
        {
          exerciseId: 'second-exercise',
          order: 1,
          targetSets: 3,
          targetRepRange: '10-12',
        },
      ],
    })
    const afterRoster = await buildLiveCoachContext('session')
    expect(afterRoster.context.actionStateHashes.active_workout).not.toBe(
      afterTargets.context.actionStateHashes.active_workout,
    )
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

  it('only invalidates memory proposals when memory availability changes', async () => {
    const before = await buildLiveCoachContext('session')
    await db.aiNotes.add({
      id: 'another-note',
      body: 'Prefer short sessions.',
      createdAt: 2,
      updatedAt: 2,
    })
    const afterNote = await buildLiveCoachContext('session')
    expect(afterNote.context.actionStateHashes.ai_memory).toBe(
      before.context.actionStateHashes.ai_memory,
    )

    await db.aiMemorySettings.add({
      id: 'default',
      currentContext: '',
      paused: true,
      windowStartedAt: 1,
      fourMonthStartedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    const afterPause = await buildLiveCoachContext('session')
    expect(afterPause.context.actionStateHashes.ai_memory).not.toBe(
      afterNote.context.actionStateHashes.ai_memory,
    )
  })
})
