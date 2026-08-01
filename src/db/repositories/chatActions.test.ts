import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../schema'
import type { Exercise, WorkoutSession } from '../types'
import {
  applyCoachActionPlan,
  getAppliedCoachActionResult,
  listPendingCoachActionResults,
  markCoachActionSynced,
  parseCoachActionPlan,
  StaleCoachActionError,
} from './chatActions'

const HASH = 'a'.repeat(64)
const ACTION_HASH = 'c'.repeat(64)

function actionStateHashes(
  overrides: Partial<
    Record<'active_workout' | 'one_time_workout' | 'program' | 'ai_memory', string>
  > = {},
) {
  return {
    active_workout: ACTION_HASH,
    one_time_workout: ACTION_HASH,
    program: ACTION_HASH,
    ai_memory: ACTION_HASH,
    ...overrides,
  }
}

function exercise(id: string, name = id): Exercise {
  return {
    id,
    name,
    primaryMuscle: 'chest',
    secondaryMuscles: [],
    notes: '',
    defaultRestSeconds: 90,
    isCustom: false,
    hiddenFromLibrary: false,
    createdAt: 1,
  }
}

function activeSession(): WorkoutSession {
  return {
    id: 'session',
    sessionTemplateId: null,
    programId: null,
    name: 'Today',
    programName: null,
    exerciseSnapshot: [
      {
        exerciseId: 'a',
        order: 0,
        targetSets: 3,
        targetRepRange: '8-10',
      },
      {
        exerciseId: 'b',
        order: 1,
        targetSets: 3,
        targetRepRange: '10-12',
      },
    ],
    startedAt: 1,
    completedAt: null,
  }
}

function plan(action: unknown, scope = 'active_workout') {
  return {
    title: 'Safe change',
    summary: 'Preview this exact change.',
    scope,
    sourceStateHash: HASH,
    sourceActionStateHash: ACTION_HASH,
    actions: [action],
  }
}

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('Coach action plan validation', () => {
  it('requires replacement targets for a swap', () => {
    expect(() =>
      parseCoachActionPlan(
        plan({
          type: 'swap_active_exercise',
          sessionId: 'session',
          fromExerciseId: 'a',
          toExerciseId: 'c',
        }),
      ),
    ).toThrow('targetSets')
  })

  it('rejects unknown model-authored operations', () => {
    expect(() =>
      parseCoachActionPlan(plan({ type: 'delete_everything' })),
    ).toThrow('Unsupported Coach action')
  })

  it('accepts one bounded AI-memory note in its dedicated scope', () => {
    expect(
      parseCoachActionPlan(
        plan(
          {
            type: 'save_ai_note',
            body: 'Avoid overhead pressing while my right shoulder is irritated.',
          },
          'ai_memory',
        ),
      ),
    ).toMatchObject({
      scope: 'ai_memory',
      actions: [
        {
          type: 'save_ai_note',
          body: 'Avoid overhead pressing while my right shoulder is irritated.',
        },
      ],
    })
  })

  it('does not allow a memory action under a workout scope', () => {
    expect(() =>
      parseCoachActionPlan(
        plan({ type: 'save_ai_note', body: 'Prefer dumbbells.' }),
      ),
    ).toThrow('active-workout plan')
  })

  it('rejects blank and oversized AI-memory notes', () => {
    expect(() =>
      parseCoachActionPlan(
        plan({ type: 'save_ai_note', body: '   ' }, 'ai_memory'),
      ),
    ).toThrow('body is required')
    expect(() =>
      parseCoachActionPlan(
        plan({ type: 'save_ai_note', body: 'x'.repeat(1001) }, 'ai_memory'),
      ),
    ).toThrow('body is too long')
  })
})

describe('active workout Coach actions', () => {
  beforeEach(async () => {
    await db.exercises.bulkAdd([
      exercise('a', 'Bench Press'),
      exercise('b', 'Cable Fly'),
      exercise('c', 'Machine Press'),
    ])
    await db.workoutSessions.add(activeSession())
  })

  it('adds an exercise at the requested position and is idempotent by proposal', async () => {
    const rawPlan = plan({
      type: 'add_active_exercise',
      sessionId: 'session',
      exerciseId: 'c',
      position: 1,
      targetSets: 4,
      repRange: '6-8',
    })
    const first = await applyCoachActionPlan({
      proposalId: 'proposal-add',
      rawPlan,
      currentStateHash: 'b'.repeat(64),
      currentActionStateHashes: actionStateHashes(),
    })
    const replay = await applyCoachActionPlan({
      proposalId: 'proposal-add',
      rawPlan,
      currentStateHash: 'b'.repeat(64),
      currentActionStateHashes: actionStateHashes(),
    })

    const session = await db.workoutSessions.get('session')
    expect(session?.exerciseSnapshot).toEqual([
      expect.objectContaining({ exerciseId: 'a', order: 0 }),
      expect.objectContaining({
        exerciseId: 'c',
        order: 1,
        targetSets: 4,
        targetRepRange: '6-8',
      }),
      expect.objectContaining({ exerciseId: 'b', order: 2 }),
    ])
    expect(first.replayed).toBe(false)
    expect(first.sourceStateHash).toBe(HASH)
    expect(first.sourceActionStateHash).toBe(ACTION_HASH)
    expect(replay.replayed).toBe(true)
    expect(await db.chatActionReceipts.count()).toBe(1)
    expect(
      (await db.chatActionReceipts.get('proposal-add'))?.sourceStateHash,
    ).toBe(HASH)
  })

  it('replaces an unperformed exercise in place with new targets', async () => {
    await applyCoachActionPlan({
      proposalId: 'proposal-swap-empty',
      rawPlan: plan({
        type: 'swap_active_exercise',
        sessionId: 'session',
        fromExerciseId: 'a',
        toExerciseId: 'c',
        targetSets: 2,
        repRange: '12-15',
      }),
      currentStateHash: HASH,
      currentActionStateHashes: actionStateHashes(),
    })

    const session = await db.workoutSessions.get('session')
    expect(session?.exerciseSnapshot).toEqual([
      {
        exerciseId: 'c',
        order: 0,
        targetSets: 2,
        targetRepRange: '12-15',
      },
      expect.objectContaining({ exerciseId: 'b', order: 1 }),
    ])
  })

  it('preserves performed work, caps its target, and inserts the replacement next', async () => {
    await db.loggedSets.add({
      id: 'set-a-1',
      workoutSessionId: 'session',
      exerciseId: 'a',
      setNumber: 1,
      weightLbs: 100,
      reps: 8,
      rpe: 7,
      loggedAt: 2,
    })
    await applyCoachActionPlan({
      proposalId: 'proposal-swap-logged',
      rawPlan: plan({
        type: 'swap_active_exercise',
        sessionId: 'session',
        fromExerciseId: 'a',
        toExerciseId: 'c',
        targetSets: 2,
        repRange: '12-15',
      }),
      currentStateHash: HASH,
      currentActionStateHashes: actionStateHashes(),
    })

    const session = await db.workoutSessions.get('session')
    expect(session?.exerciseSnapshot).toEqual([
      expect.objectContaining({ exerciseId: 'a', order: 0, targetSets: 1 }),
      expect.objectContaining({
        exerciseId: 'c',
        order: 1,
        targetSets: 2,
        targetRepRange: '12-15',
      }),
      expect.objectContaining({ exerciseId: 'b', order: 2 }),
    ])
    expect(session?.doneExerciseIds).toContain('a')
    expect(await db.loggedSets.get('set-a-1')).toBeDefined()
  })

  it('will not reduce a target below the number of logged sets', async () => {
    await db.loggedSets.bulkAdd([
      {
        id: 'set-1',
        workoutSessionId: 'session',
        exerciseId: 'a',
        setNumber: 1,
        weightLbs: 100,
        reps: 8,
        rpe: null,
        loggedAt: 2,
      },
      {
        id: 'set-2',
        workoutSessionId: 'session',
        exerciseId: 'a',
        setNumber: 2,
        weightLbs: 100,
        reps: 8,
        rpe: null,
        loggedAt: 3,
      },
    ])

    await expect(
      applyCoachActionPlan({
        proposalId: 'proposal-low-target',
        rawPlan: plan({
          type: 'update_active_exercise_targets',
          sessionId: 'session',
          exerciseId: 'a',
          targetSets: 1,
          repRange: '8-10',
        }),
        currentStateHash: HASH,
        currentActionStateHashes: actionStateHashes(),
      }),
    ).rejects.toThrow('already has 2 logged sets')
    expect(await db.chatActionReceipts.get('proposal-low-target')).toBeUndefined()
  })

  it('rejects a proposal when its scoped action fingerprint changed', async () => {
    await expect(
      applyCoachActionPlan({
        proposalId: 'proposal-stale',
        rawPlan: plan({
          type: 'update_active_exercise_targets',
          sessionId: 'session',
          exerciseId: 'a',
          targetSets: 2,
          repRange: '8-10',
        }),
        currentStateHash: HASH,
        currentActionStateHashes: actionStateHashes({
          active_workout: 'b'.repeat(64),
        }),
      }),
    ).rejects.toBeInstanceOf(StaleCoachActionError)
  })
})

describe('workout and program creation', () => {
  beforeEach(async () => {
    await db.exercises.bulkAdd([
      exercise('a', 'Bench Press'),
      exercise('b', 'Cable Fly'),
    ])
  })

  it('creates a complete one-time workout atomically', async () => {
    const result = await applyCoachActionPlan({
      proposalId: 'proposal-one-time',
      rawPlan: plan(
        {
          type: 'create_one_time_workout',
          name: 'Quick chest',
          exercises: [
            { exerciseId: 'a', targetSets: 3, repRange: '6-8' },
            { exerciseId: 'b', targetSets: 2, repRange: '12-15' },
          ],
        },
        'one_time_workout',
      ),
      currentStateHash: HASH,
      currentActionStateHashes: actionStateHashes(),
    })

    const session = await db.workoutSessions.get(result.activeSessionId!)
    expect(session).toMatchObject({
      name: 'Quick chest',
      sessionTemplateId: null,
      programId: null,
      completedAt: null,
    })
    expect(session?.exerciseSnapshot).toHaveLength(2)
  })

  it('atomically replaces an incomplete workout that has no logged work', async () => {
    await db.workoutSessions.add(activeSession())
    const result = await applyCoachActionPlan({
      proposalId: 'proposal-replace-empty',
      rawPlan: plan(
        {
          type: 'create_one_time_workout',
          name: 'Another workout',
          exercises: [{ exerciseId: 'a', targetSets: 3, repRange: '8-10' }],
        },
        'one_time_workout',
      ),
      currentStateHash: HASH,
      currentActionStateHashes: actionStateHashes(),
    })

    expect(await db.workoutSessions.get('session')).toBeUndefined()
    expect(await db.workoutSessions.count()).toBe(1)
    expect((await db.workoutSessions.get(result.activeSessionId!))?.name).toBe(
      'Another workout',
    )
  })

  it('will not replace an incomplete workout that contains logged work', async () => {
    await db.workoutSessions.add(activeSession())
    await db.loggedSets.add({
      id: 'worked-set',
      workoutSessionId: 'session',
      exerciseId: 'a',
      setNumber: 1,
      weightLbs: 100,
      reps: 8,
      rpe: null,
      loggedAt: 2,
    })

    await expect(
      applyCoachActionPlan({
        proposalId: 'proposal-worked-conflict',
        rawPlan: plan(
          {
            type: 'create_one_time_workout',
            name: 'Another workout',
            exercises: [{ exerciseId: 'a', targetSets: 3, repRange: '8-10' }],
          },
          'one_time_workout',
        ),
        currentStateHash: HASH,
        currentActionStateHashes: actionStateHashes(),
      }),
    ).rejects.toThrow('before starting another workout')

    expect(await db.workoutSessions.get('session')).toBeDefined()
    expect(await db.loggedSets.get('worked-set')).toBeDefined()
    expect(await db.chatActionReceipts.get('proposal-worked-conflict')).toBeUndefined()
  })

  it('creates a whole inactive program graph in one transaction', async () => {
    const result = await applyCoachActionPlan({
      proposalId: 'proposal-program',
      rawPlan: plan(
        {
          type: 'create_program',
          name: 'Two day split',
          sessions: [
            {
              name: 'Day A',
              exercises: [{ exerciseId: 'a', targetSets: 3, repRange: '6-8' }],
            },
            {
              name: 'Day B',
              exercises: [{ exerciseId: 'b', targetSets: 3, repRange: '10-12' }],
            },
          ],
        },
        'program',
      ),
      currentStateHash: HASH,
      currentActionStateHashes: actionStateHashes(),
    })

    const program = await db.programs.get(result.programId!)
    const sessions = await db.sessionTemplates
      .where('programId')
      .equals(result.programId!)
      .toArray()
    expect(program?.isActive).toBe(0)
    expect(sessions.map((session) => session.order).sort()).toEqual([0, 1])
    expect(await db.templateExercises.count()).toBe(2)
  })
})

describe('AI-memory Coach actions', () => {
  it('saves a note atomically and replays without creating a duplicate', async () => {
    const rawPlan = plan(
      {
        type: 'save_ai_note',
        body: '  I train at lunch on weekdays and usually have 45 minutes.  ',
      },
      'ai_memory',
    )
    const first = await applyCoachActionPlan({
      proposalId: 'proposal-memory',
      rawPlan,
      currentStateHash: HASH,
      currentActionStateHashes: actionStateHashes(),
    })
    const replay = await applyCoachActionPlan({
      proposalId: 'proposal-memory',
      rawPlan,
      currentStateHash: HASH,
      currentActionStateHashes: actionStateHashes(),
    })

    expect(await db.aiNotes.count()).toBe(1)
    expect((await db.aiNotes.toArray())[0]?.body).toBe(
      'I train at lunch on weekdays and usually have 45 minutes.',
    )
    expect(first.changes[0]).toMatchObject({
      type: 'save_ai_note',
      label: 'Saved a note for AI Insights',
    })
    expect(first.syncPending).toBe(true)
    expect(replay.replayed).toBe(true)
    expect(replay.syncPending).toBe(true)
    expect(await db.chatActionReceipts.count()).toBe(1)
    expect(await listPendingCoachActionResults()).toEqual([
      expect.objectContaining({ proposalId: 'proposal-memory' }),
    ])

    const synced = await markCoachActionSynced('proposal-memory')
    expect(synced.syncPending).toBe(false)
    expect(
      (await getAppliedCoachActionResult('proposal-memory'))?.syncPending,
    ).toBe(false)
    expect(await listPendingCoachActionResults()).toEqual([])
  })

  it('refuses to save while AI Memory is paused', async () => {
    await db.aiMemorySettings.add({
      id: 'default',
      currentContext: '',
      paused: true,
      windowStartedAt: 1,
      fourMonthStartedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })

    await expect(
      applyCoachActionPlan({
        proposalId: 'proposal-paused-memory',
        rawPlan: plan(
          { type: 'save_ai_note', body: 'Remember this.' },
          'ai_memory',
        ),
        currentStateHash: HASH,
        currentActionStateHashes: actionStateHashes(),
      }),
    ).rejects.toThrow('Resume AI memory')
    expect(await db.aiNotes.count()).toBe(0)
    expect(
      await db.chatActionReceipts.get('proposal-paused-memory'),
    ).toBeUndefined()
  })

  it('rejects a memory proposal when memory availability changed', async () => {
    await expect(
      applyCoachActionPlan({
        proposalId: 'proposal-stale-memory',
        rawPlan: plan(
          { type: 'save_ai_note', body: 'Remember this.' },
          'ai_memory',
        ),
        currentStateHash: HASH,
        currentActionStateHashes: actionStateHashes({
          ai_memory: 'b'.repeat(64),
        }),
      }),
    ).rejects.toBeInstanceOf(StaleCoachActionError)
    expect(await db.aiNotes.count()).toBe(0)
  })
})
