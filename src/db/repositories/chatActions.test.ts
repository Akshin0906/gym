import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../schema'
import type { Exercise, WorkoutSession } from '../types'
import { buildLiveCoachContext } from '../../lib/chatContext'
import {
  applyCoachActionPlan as applyCoachActionPlanToDb,
  getAppliedCoachActionResult,
  listPendingCoachActionResults,
  markCoachActionSynced,
  parseCoachActionPlan,
  StaleCoachActionError,
} from './chatActions'

const HASH = 'a'.repeat(64)
const ACTION_HASH = 'c'.repeat(64)

type TestActionScope = keyof ReturnType<typeof actionStateHashes>

const TEST_ACTION_SCOPES: readonly TestActionScope[] = [
  'active_workout',
  'one_time_workout',
  'program',
  'exercise_library',
  'ai_memory',
]

const resolvedPlaceholderHashes = new Map<string, string>()

function actionStateHashes(
  overrides: Partial<
    Record<
      | 'active_workout'
      | 'one_time_workout'
      | 'program'
      | 'exercise_library'
      | 'ai_memory',
      string
    >
  > = {},
) {
  return {
    active_workout: ACTION_HASH,
    one_time_workout: ACTION_HASH,
    program: ACTION_HASH,
    exercise_library: ACTION_HASH,
    ai_memory: ACTION_HASH,
    ...overrides,
  }
}

function isTestActionScope(value: unknown): value is TestActionScope {
  return TEST_ACTION_SCOPES.includes(value as TestActionScope)
}

async function applyCoachActionPlan(
  args: Parameters<typeof applyCoachActionPlanToDb>[0],
): ReturnType<typeof applyCoachActionPlanToDb> {
  const rawPlan = args.rawPlan
  if (
    rawPlan === null ||
    typeof rawPlan !== 'object' ||
    Array.isArray(rawPlan) ||
    !isTestActionScope((rawPlan as { scope?: unknown }).scope) ||
    (rawPlan as { sourceActionStateHash?: unknown }).sourceActionStateHash !==
      ACTION_HASH
  ) {
    return applyCoachActionPlanToDb(args)
  }

  const typedPlan = rawPlan as {
    scope: TestActionScope
    sourceActionStateHash: string
    actions?: unknown[]
  }
  let sourceActionStateHash = resolvedPlaceholderHashes.get(args.proposalId)
  if (!sourceActionStateHash) {
    const firstAction = typedPlan.actions?.[0]
    const preferredSessionId =
      typedPlan.scope === 'active_workout' &&
      firstAction !== null &&
      typeof firstAction === 'object' &&
      !Array.isArray(firstAction) &&
      typeof (firstAction as { sessionId?: unknown }).sessionId === 'string'
        ? (firstAction as { sessionId: string }).sessionId
        : undefined
    sourceActionStateHash = (
      await buildLiveCoachContext(preferredSessionId)
    ).context.actionStateHashes[typedPlan.scope]
    resolvedPlaceholderHashes.set(args.proposalId, sourceActionStateHash)
  }

  const currentActionStateHashes =
    args.currentActionStateHashes[typedPlan.scope] === ACTION_HASH
      ? {
          ...args.currentActionStateHashes,
          [typedPlan.scope]: sourceActionStateHash,
        }
      : args.currentActionStateHashes
  return applyCoachActionPlanToDb({
    ...args,
    rawPlan: { ...typedPlan, sourceActionStateHash },
    currentActionStateHashes,
  })
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

function plan(
  action: unknown,
  scope = 'active_workout',
  sourceActionStateHash = ACTION_HASH,
) {
  return {
    title: 'Safe change',
    summary: 'Preview this exact change.',
    scope,
    sourceStateHash: HASH,
    sourceActionStateHash,
    actions: [action],
  }
}

async function programApplyInput(action: unknown) {
  const programHash = (await buildLiveCoachContext()).context.actionStateHashes
    .program
  return {
    rawPlan: plan(action, 'program', programHash),
    currentActionStateHashes: actionStateHashes({ program: programHash }),
  }
}

beforeEach(async () => {
  resolvedPlaceholderHashes.clear()
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

  it('rejects extra action fields', () => {
    expect(() =>
      parseCoachActionPlan(
        plan({
          type: 'add_active_exercise',
          sessionId: 'session',
          exerciseId: 'a',
          position: 0,
          targetSets: 3,
          repRange: '8-10',
          unexpected: true,
        }),
      ),
    ).toThrow('extra=unexpected')
  })

  it('rejects extra action-plan fields', () => {
    expect(() =>
      parseCoachActionPlan({
        ...plan({
          type: 'add_active_exercise',
          sessionId: 'session',
          exerciseId: 'a',
          position: 0,
          targetSets: 3,
          repRange: '8-10',
        }),
        unexpected: true,
      }),
    ).toThrow('extra=unexpected')
  })

  it('rejects extra fields in nested exercise and session specifications', () => {
    expect(() =>
      parseCoachActionPlan(
        plan(
          {
            type: 'create_program',
            name: 'Split',
            sessions: [
              {
                name: 'Day A',
                exercises: [
                  {
                    exerciseId: 'a',
                    targetSets: 3,
                    repRange: '8-10',
                    notes: 'not part of the contract',
                  },
                ],
              },
            ],
          },
          'program',
        ),
      ),
    ).toThrow('extra=notes')

    expect(() =>
      parseCoachActionPlan(
        plan(
          {
            type: 'replace_program',
            programId: 'program',
            name: 'Split',
            sessions: [
              {
                sessionTemplateId: null,
                name: 'Day A',
                exercises: [
                  { exerciseId: 'a', targetSets: 3, repRange: '8-10' },
                ],
                order: 0,
              },
            ],
          },
          'program',
        ),
      ),
    ).toThrow('extra=order')
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

  it('rejects duplicate names and retained IDs in a program replacement', () => {
    const base = {
      type: 'replace_program',
      programId: 'program',
      name: 'Replacement',
      sessions: [
        {
          sessionTemplateId: 'template',
          name: 'Day A',
          exercises: [
            { exerciseId: 'a', targetSets: 3, repRange: '8-10' },
          ],
        },
        {
          sessionTemplateId: 'template',
          name: 'day a',
          exercises: [
            { exerciseId: 'b', targetSets: 3, repRange: '8-10' },
          ],
        },
      ],
    }
    expect(() => parseCoachActionPlan(plan(base, 'program'))).toThrow(
      'duplicate names',
    )

    base.sessions[1].name = 'Day B'
    expect(() => parseCoachActionPlan(plan(base, 'program'))).toThrow(
      'duplicate session template IDs',
    )
  })

  it('validates custom-exercise muscles, notes, and rest', () => {
    const action = {
      type: 'create_custom_exercise',
      name: 'Cable Y Raise',
      primaryMuscle: 'shoulders',
      secondaryMuscles: ['shoulders'],
      notes: '',
      defaultRestSeconds: 90,
    }
    expect(() =>
      parseCoachActionPlan(plan(action, 'exercise_library')),
    ).toThrow('cannot include the primary muscle group')

    action.secondaryMuscles = []
    action.defaultRestSeconds = 3601
    expect(() =>
      parseCoachActionPlan(plan(action, 'exercise_library')),
    ).toThrow('whole number from 1 to 3600')

    action.defaultRestSeconds = 90
    action.notes = 'x'.repeat(2001)
    expect(() =>
      parseCoachActionPlan(plan(action, 'exercise_library')),
    ).toThrow('notes is too long')
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
    expect(first.sourceActionStateHash).toBe(
      resolvedPlaceholderHashes.get('proposal-add'),
    )
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
    const input = await programApplyInput({
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
    })
    const result = await applyCoachActionPlan({
      proposalId: 'proposal-program',
      ...input,
      currentStateHash: HASH,
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

describe('program and saved-workout Coach actions', () => {
  beforeEach(async () => {
    await db.exercises.bulkAdd([
      exercise('a', 'Bench Press'),
      exercise('b', 'Cable Fly'),
      {
        ...exercise('hidden', 'Legacy Machine Press'),
        hiddenFromLibrary: true,
      },
    ])
    await db.programs.add({
      id: 'program',
      name: 'Original Split',
      isActive: 1,
      createdAt: 1,
      archivedAt: null,
    })
    await db.sessionTemplates.bulkAdd([
      { id: 'template-a', programId: 'program', name: 'Day A', order: 0 },
      { id: 'template-b', programId: 'program', name: 'Day B', order: 1 },
    ])
    await db.templateExercises.bulkAdd([
      {
        id: 'te-a',
        sessionTemplateId: 'template-a',
        exerciseId: 'a',
        order: 0,
        targetSets: 3,
        targetRepRange: '8-10',
      },
      {
        id: 'te-hidden',
        sessionTemplateId: 'template-a',
        exerciseId: 'hidden',
        order: 1,
        targetSets: 2,
        targetRepRange: '10-12',
      },
      {
        id: 'te-b',
        sessionTemplateId: 'template-b',
        exerciseId: 'b',
        order: 0,
        targetSets: 3,
        targetRepRange: '12-15',
      },
    ])
  })

  it('renames a program without rewriting historical snapshots', async () => {
    await db.workoutSessions.add({
      id: 'history',
      sessionTemplateId: 'template-a',
      programId: 'program',
      name: 'Day A',
      programName: 'Original Split',
      exerciseSnapshot: [
        {
          exerciseId: 'a',
          order: 0,
          targetSets: 3,
          targetRepRange: '8-10',
        },
      ],
      startedAt: 2,
      completedAt: 3,
    })

    const input = await programApplyInput({
      type: 'rename_program',
      programId: 'program',
      name: 'Updated Split',
    })
    await applyCoachActionPlan({
      proposalId: 'proposal-rename-program',
      ...input,
      currentStateHash: HASH,
    })

    expect((await db.programs.get('program'))?.name).toBe('Updated Split')
    expect(await db.workoutSessions.get('history')).toMatchObject({
      name: 'Day A',
      programName: 'Original Split',
    })
  })

  it('revalidates the program hash inside the write transaction', async () => {
    const input = await programApplyInput({
      type: 'replace_program',
      programId: 'program',
      name: 'Stale replacement',
      sessions: [
        {
          sessionTemplateId: 'template-a',
          name: 'Day A',
          exercises: [
            { exerciseId: 'a', targetSets: 3, repRange: '8-10' },
            { exerciseId: 'hidden', targetSets: 2, repRange: '10-12' },
          ],
        },
      ],
    })
    await db.sessionTemplates.add({
      id: 'template-concurrent',
      programId: 'program',
      name: 'Concurrent Day',
      order: 2,
    })
    await db.templateExercises.add({
      id: 'te-concurrent',
      sessionTemplateId: 'template-concurrent',
      exerciseId: 'a',
      order: 0,
      targetSets: 2,
      targetRepRange: '12-15',
    })

    await expect(
      applyCoachActionPlan({
        proposalId: 'proposal-stale-inside-transaction',
        ...input,
        currentStateHash: HASH,
      }),
    ).rejects.toBeInstanceOf(StaleCoachActionError)

    expect((await db.programs.get('program'))?.name).toBe('Original Split')
    expect(await db.sessionTemplates.get('template-a')).toBeDefined()
    expect(await db.sessionTemplates.get('template-b')).toBeDefined()
    expect(await db.sessionTemplates.get('template-concurrent')).toBeDefined()
    expect(await db.templateExercises.get('te-concurrent')).toBeDefined()
    expect(
      await db.chatActionReceipts.get('proposal-stale-inside-transaction'),
    ).toBeUndefined()
  })

  it('archives and deactivates a program without deleting its graph or history', async () => {
    await db.programs.update('program', { isActive: 0 })
    await db.workoutSessions.add({
      id: 'history',
      sessionTemplateId: 'template-a',
      programId: 'program',
      name: 'Day A',
      programName: 'Original Split',
      exerciseSnapshot: [],
      startedAt: 2,
      completedAt: 3,
    })
    await db.loggedSets.add({
      id: 'history-set',
      workoutSessionId: 'history',
      exerciseId: 'a',
      setNumber: 1,
      weightLbs: 100,
      reps: 8,
      rpe: null,
      loggedAt: 2,
    })

    const input = await programApplyInput({
      type: 'archive_program',
      programId: 'program',
    })
    await applyCoachActionPlan({
      proposalId: 'proposal-archive-program',
      ...input,
      currentStateHash: HASH,
    })

    expect(await db.programs.get('program')).toMatchObject({ isActive: 0 })
    expect((await db.programs.get('program'))?.archivedAt).toEqual(
      expect.any(Number),
    )
    expect(await db.sessionTemplates.count()).toBe(2)
    expect(await db.templateExercises.count()).toBe(3)
    expect(await db.workoutSessions.get('history')).toBeDefined()
    expect(await db.loggedSets.get('history-set')).toBeDefined()
  })

  it('requires another program to be activated before archiving the active one', async () => {
    const input = await programApplyInput({
      type: 'archive_program',
      programId: 'program',
    })

    await expect(
      applyCoachActionPlan({
        proposalId: 'proposal-archive-active-program',
        ...input,
        currentStateHash: HASH,
      }),
    ).rejects.toThrow('Activate another program before archiving this one')

    expect(await db.programs.get('program')).toMatchObject({
      isActive: 1,
      archivedAt: null,
    })
    expect(
      await db.chatActionReceipts.get('proposal-archive-active-program'),
    ).toBeUndefined()
  })

  it('replaces one saved workout while retaining its ID and frozen history', async () => {
    const oldSnapshot = [
      {
        exerciseId: 'a',
        order: 0,
        targetSets: 3,
        targetRepRange: '8-10',
      },
      {
        exerciseId: 'hidden',
        order: 1,
        targetSets: 2,
        targetRepRange: '10-12',
      },
    ]
    await db.workoutSessions.add({
      id: 'history',
      sessionTemplateId: 'template-a',
      programId: 'program',
      name: 'Day A',
      programName: 'Original Split',
      exerciseSnapshot: oldSnapshot,
      startedAt: 2,
      completedAt: 3,
    })
    await db.loggedSets.add({
      id: 'history-set',
      workoutSessionId: 'history',
      exerciseId: 'a',
      setNumber: 1,
      weightLbs: 100,
      reps: 8,
      rpe: null,
      loggedAt: 2,
    })

    const input = await programApplyInput({
      type: 'replace_session_template',
      sessionTemplateId: 'template-a',
      name: 'Upper A',
      exercises: [
        { exerciseId: 'hidden', targetSets: 2, repRange: '10-12' },
        { exerciseId: 'b', targetSets: 4, repRange: '12-15' },
      ],
    })
    await applyCoachActionPlan({
      proposalId: 'proposal-replace-template',
      ...input,
      currentStateHash: HASH,
    })

    expect(await db.sessionTemplates.get('template-a')).toMatchObject({
      name: 'Upper A',
      order: 0,
    })
    expect(
      await db.templateExercises
        .where('sessionTemplateId')
        .equals('template-a')
        .sortBy('order'),
    ).toEqual([
      expect.objectContaining({ exerciseId: 'hidden', order: 0, targetSets: 2 }),
      expect.objectContaining({ exerciseId: 'b', order: 1, targetSets: 4 }),
    ])
    expect(await db.workoutSessions.get('history')).toMatchObject({
      sessionTemplateId: 'template-a',
      name: 'Day A',
      exerciseSnapshot: oldSnapshot,
    })
    expect(await db.loggedSets.get('history-set')).toBeDefined()
  })

  it('deletes a saved workout but preserves and detaches logged history', async () => {
    const snapshot = [
      {
        exerciseId: 'a',
        order: 0,
        targetSets: 3,
        targetRepRange: '8-10',
      },
    ]
    await db.workoutSessions.add({
      id: 'history',
      sessionTemplateId: 'template-a',
      programId: 'program',
      name: 'Day A',
      programName: 'Original Split',
      exerciseSnapshot: snapshot,
      startedAt: 2,
      completedAt: 3,
    })
    await db.loggedSets.add({
      id: 'history-set',
      workoutSessionId: 'history',
      exerciseId: 'a',
      setNumber: 1,
      weightLbs: 100,
      reps: 8,
      rpe: null,
      loggedAt: 2,
    })

    const input = await programApplyInput({
      type: 'delete_session_template',
      sessionTemplateId: 'template-a',
    })
    await applyCoachActionPlan({
      proposalId: 'proposal-delete-template',
      ...input,
      currentStateHash: HASH,
    })

    expect(await db.sessionTemplates.get('template-a')).toBeUndefined()
    expect(await db.templateExercises.get('te-a')).toBeUndefined()
    expect(await db.templateExercises.get('te-hidden')).toBeUndefined()
    expect(await db.sessionTemplates.get('template-b')).toMatchObject({ order: 0 })
    expect(await db.workoutSessions.get('history')).toMatchObject({
      sessionTemplateId: null,
      name: 'Day A',
      programName: 'Original Split',
      exerciseSnapshot: snapshot,
    })
    expect(await db.loggedSets.get('history-set')).toBeDefined()
  })

  it('does not remove the final saved workout from a program', async () => {
    await db.templateExercises.where('sessionTemplateId').equals('template-b').delete()
    await db.sessionTemplates.delete('template-b')
    const input = await programApplyInput({
      type: 'delete_session_template',
      sessionTemplateId: 'template-a',
    })

    await expect(
      applyCoachActionPlan({
        proposalId: 'proposal-delete-final-template',
        ...input,
        currentStateHash: HASH,
      }),
    ).rejects.toThrow('Add another saved workout before removing the final one')

    expect(await db.sessionTemplates.get('template-a')).toBeDefined()
    expect(await db.templateExercises.get('te-a')).toBeDefined()
    expect(
      await db.chatActionReceipts.get('proposal-delete-final-template'),
    ).toBeUndefined()
  })

  it('replaces a program graph while retaining selected IDs and detaching omitted history', async () => {
    const oldSnapshot = [
      {
        exerciseId: 'b',
        order: 0,
        targetSets: 3,
        targetRepRange: '12-15',
      },
    ]
    await db.workoutSessions.bulkAdd([
      {
        id: 'history-a',
        sessionTemplateId: 'template-a',
        programId: 'program',
        name: 'Day A',
        programName: 'Original Split',
        exerciseSnapshot: [],
        startedAt: 2,
        completedAt: 3,
      },
      {
        id: 'history-b',
        sessionTemplateId: 'template-b',
        programId: 'program',
        name: 'Day B',
        programName: 'Original Split',
        exerciseSnapshot: oldSnapshot,
        startedAt: 4,
        completedAt: 5,
      },
    ])
    await db.loggedSets.add({
      id: 'history-set',
      workoutSessionId: 'history-b',
      exerciseId: 'b',
      setNumber: 1,
      weightLbs: 50,
      reps: 12,
      rpe: null,
      loggedAt: 5,
    })

    const input = await programApplyInput({
      type: 'replace_program',
      programId: 'program',
      name: 'Rebuilt Split',
      sessions: [
        {
          sessionTemplateId: 'template-a',
          name: 'Upper',
          exercises: [
            { exerciseId: 'hidden', targetSets: 2, repRange: '10-12' },
            { exerciseId: 'b', targetSets: 3, repRange: '12-15' },
          ],
        },
        {
          sessionTemplateId: null,
          name: 'Lower',
          exercises: [
            { exerciseId: 'a', targetSets: 3, repRange: '8-10' },
          ],
        },
      ],
    })
    const result = await applyCoachActionPlan({
      proposalId: 'proposal-replace-program',
      ...input,
      currentStateHash: HASH,
    })

    expect(result.programId).toBe('program')
    expect(await db.programs.get('program')).toMatchObject({
      id: 'program',
      name: 'Rebuilt Split',
      isActive: 1,
      createdAt: 1,
      archivedAt: null,
    })
    const templates = await db.sessionTemplates
      .where('programId')
      .equals('program')
      .sortBy('order')
    expect(templates).toHaveLength(2)
    expect(templates[0]).toMatchObject({
      id: 'template-a',
      name: 'Upper',
      order: 0,
    })
    expect(templates[1]).toMatchObject({ name: 'Lower', order: 1 })
    expect(templates[1].id).not.toBe('template-b')
    expect(await db.sessionTemplates.get('template-b')).toBeUndefined()
    expect(await db.workoutSessions.get('history-a')).toMatchObject({
      sessionTemplateId: 'template-a',
      name: 'Day A',
      programName: 'Original Split',
    })
    expect(await db.workoutSessions.get('history-b')).toMatchObject({
      sessionTemplateId: null,
      name: 'Day B',
      programName: 'Original Split',
      exerciseSnapshot: oldSnapshot,
    })
    expect(await db.loggedSets.get('history-set')).toBeDefined()
  })

  it('rolls back prior program and history writes when a later add fails', async () => {
    await db.workoutSessions.add({
      id: 'history-b',
      sessionTemplateId: 'template-b',
      programId: 'program',
      name: 'Day B',
      programName: 'Original Split',
      exerciseSnapshot: [],
      startedAt: 2,
      completedAt: 3,
    })
    const input = await programApplyInput({
      type: 'replace_program',
      programId: 'program',
      name: 'Must roll back',
      sessions: [
        {
          sessionTemplateId: 'template-a',
          name: 'Retained Day',
          exercises: [
            { exerciseId: 'a', targetSets: 4, repRange: '6-8' },
          ],
        },
        {
          sessionTemplateId: null,
          name: 'New Day',
          exercises: [
            { exerciseId: 'b', targetSets: 3, repRange: '12-15' },
          ],
        },
      ],
    })
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('template-a' as ReturnType<typeof crypto.randomUUID>)

    try {
      await expect(
        applyCoachActionPlan({
          proposalId: 'proposal-late-add-failure',
          ...input,
          currentStateHash: HASH,
        }),
      ).rejects.toThrow()
    } finally {
      uuidSpy.mockRestore()
    }

    expect((await db.programs.get('program'))?.name).toBe('Original Split')
    expect(await db.sessionTemplates.get('template-a')).toMatchObject({
      name: 'Day A',
      order: 0,
    })
    expect(await db.sessionTemplates.get('template-b')).toMatchObject({
      name: 'Day B',
      order: 1,
    })
    expect(await db.templateExercises.count()).toBe(3)
    expect(await db.templateExercises.get('te-a')).toBeDefined()
    expect(await db.templateExercises.get('te-hidden')).toBeDefined()
    expect(await db.templateExercises.get('te-b')).toBeDefined()
    expect(await db.workoutSessions.get('history-b')).toMatchObject({
      sessionTemplateId: 'template-b',
    })
    expect(
      await db.chatActionReceipts.get('proposal-late-add-failure'),
    ).toBeUndefined()
  })

  it('rejects moving a hidden exercise to a new template and rolls back', async () => {
    const input = await programApplyInput({
      type: 'replace_program',
      programId: 'program',
      name: 'Should not save',
      sessions: [
        {
          sessionTemplateId: 'template-a',
          name: 'Day A',
          exercises: [
            { exerciseId: 'a', targetSets: 3, repRange: '8-10' },
          ],
        },
        {
          sessionTemplateId: null,
          name: 'New Day',
          exercises: [
            { exerciseId: 'hidden', targetSets: 2, repRange: '10-12' },
          ],
        },
      ],
    })
    await expect(
      applyCoachActionPlan({
        proposalId: 'proposal-hidden-move',
        ...input,
        currentStateHash: HASH,
      }),
    ).rejects.toThrow('hidden from the library')

    expect((await db.programs.get('program'))?.name).toBe('Original Split')
    expect(await db.sessionTemplates.count()).toBe(2)
    expect(await db.templateExercises.count()).toBe(3)
    expect(await db.chatActionReceipts.get('proposal-hidden-move')).toBeUndefined()
  })

  it('rejects edits to an archived program', async () => {
    await db.programs.update('program', { archivedAt: 10, isActive: 0 })
    const input = await programApplyInput({
      type: 'replace_session_template',
      sessionTemplateId: 'template-a',
      name: 'No change',
      exercises: [
        { exerciseId: 'a', targetSets: 2, repRange: '8-10' },
      ],
    })
    await expect(
      applyCoachActionPlan({
        proposalId: 'proposal-edit-archived',
        ...input,
        currentStateHash: HASH,
      }),
    ).rejects.toThrow('Restore that program')
    expect((await db.sessionTemplates.get('template-a'))?.name).toBe('Day A')
  })
})

describe('custom exercise Coach actions', () => {
  it('creates one visible custom exercise and replays idempotently', async () => {
    const rawPlan = plan(
      {
        type: 'create_custom_exercise',
        name: '  Cable Y Raise  ',
        primaryMuscle: 'shoulders',
        secondaryMuscles: ['traps'],
        notes: '  Keep the load light.  ',
        defaultRestSeconds: 75,
      },
      'exercise_library',
    )
    const first = await applyCoachActionPlan({
      proposalId: 'proposal-create-exercise',
      rawPlan,
      currentStateHash: HASH,
      currentActionStateHashes: actionStateHashes(),
    })
    const replay = await applyCoachActionPlan({
      proposalId: 'proposal-create-exercise',
      rawPlan,
      currentStateHash: HASH,
      currentActionStateHashes: actionStateHashes(),
    })

    expect(first.exerciseId).toEqual(expect.any(String))
    expect(replay.exerciseId).toBe(first.exerciseId)
    expect(replay.replayed).toBe(true)
    expect(await db.exercises.count()).toBe(1)
    expect(await db.exercises.get(first.exerciseId!)).toMatchObject({
      name: 'Cable Y Raise',
      primaryMuscle: 'shoulders',
      secondaryMuscles: ['traps'],
      notes: 'Keep the load light.',
      defaultRestSeconds: 75,
      isCustom: true,
      hiddenFromLibrary: false,
    })
  })

  it('rejects a case-insensitive duplicate even when the existing exercise is hidden', async () => {
    await db.exercises.add({
      ...exercise('existing', 'Cable Y Raise'),
      hiddenFromLibrary: true,
    })

    await expect(
      applyCoachActionPlan({
        proposalId: 'proposal-duplicate-exercise',
        rawPlan: plan(
          {
            type: 'create_custom_exercise',
            name: ' cable y raise ',
            primaryMuscle: 'shoulders',
            secondaryMuscles: [],
            notes: '',
            defaultRestSeconds: 90,
          },
          'exercise_library',
        ),
        currentStateHash: HASH,
        currentActionStateHashes: actionStateHashes(),
      }),
    ).rejects.toThrow('already exists')
    expect(await db.exercises.count()).toBe(1)
    expect(
      await db.chatActionReceipts.get('proposal-duplicate-exercise'),
    ).toBeUndefined()
  })

  it('rejects a stale exercise-library proposal', async () => {
    await expect(
      applyCoachActionPlan({
        proposalId: 'proposal-stale-exercise',
        rawPlan: plan(
          {
            type: 'create_custom_exercise',
            name: 'Cable Y Raise',
            primaryMuscle: 'shoulders',
            secondaryMuscles: [],
            notes: '',
            defaultRestSeconds: 90,
          },
          'exercise_library',
        ),
        currentStateHash: HASH,
        currentActionStateHashes: actionStateHashes({
          exercise_library: 'b'.repeat(64),
        }),
      }),
    ).rejects.toBeInstanceOf(StaleCoachActionError)
    expect(await db.exercises.count()).toBe(0)
  })
})

describe('transaction-time scoped action-state revalidation', () => {
  it('rejects an active-workout edit changed after the caller snapshot', async () => {
    await db.exercises.bulkAdd([exercise('a'), exercise('b'), exercise('c')])
    await db.workoutSessions.add(activeSession())
    const live = await buildLiveCoachContext('session')
    await db.workoutSessions.update('session', { name: 'Concurrent rename' })

    await expect(
      applyCoachActionPlanToDb({
        proposalId: 'proposal-active-race',
        rawPlan: plan(
          {
            type: 'add_active_exercise',
            sessionId: 'session',
            exerciseId: 'c',
            position: 2,
            targetSets: 2,
            repRange: '12-15',
          },
          'active_workout',
          live.context.actionStateHashes.active_workout,
        ),
        currentStateHash: live.stateHash,
        currentActionStateHashes: live.context.actionStateHashes,
      }),
    ).rejects.toBeInstanceOf(StaleCoachActionError)

    expect((await db.workoutSessions.get('session'))?.name).toBe(
      'Concurrent rename',
    )
    expect(
      (await db.workoutSessions.get('session'))?.exerciseSnapshot,
    ).toHaveLength(2)
    expect(await db.chatActionReceipts.get('proposal-active-race')).toBeUndefined()
  })

  it('rejects an active-workout edit after a set is logged', async () => {
    await db.exercises.bulkAdd([exercise('a'), exercise('b')])
    await db.workoutSessions.add(activeSession())
    const live = await buildLiveCoachContext('session')
    await db.loggedSets.add({
      id: 'concurrent-set',
      workoutSessionId: 'session',
      exerciseId: 'a',
      setNumber: 1,
      weightLbs: 100,
      reps: 8,
      rpe: null,
      loggedAt: 2,
    })

    await expect(
      applyCoachActionPlanToDb({
        proposalId: 'proposal-active-set-race',
        rawPlan: plan(
          {
            type: 'update_active_exercise_targets',
            sessionId: 'session',
            exerciseId: 'a',
            targetSets: 4,
            repRange: '6-8',
          },
          'active_workout',
          live.context.actionStateHashes.active_workout,
        ),
        currentStateHash: live.stateHash,
        currentActionStateHashes: live.context.actionStateHashes,
      }),
    ).rejects.toBeInstanceOf(StaleCoachActionError)

    expect(
      (await db.workoutSessions.get('session'))?.exerciseSnapshot[0],
    ).toMatchObject({ targetSets: 3, targetRepRange: '8-10' })
    expect(
      await db.chatActionReceipts.get('proposal-active-set-race'),
    ).toBeUndefined()
  })

  it('rejects an active-workout edit after its done markers change', async () => {
    await db.exercises.bulkAdd([
      exercise('a'),
      exercise('b'),
      exercise('c'),
    ])
    await db.workoutSessions.add(activeSession())
    const live = await buildLiveCoachContext('session')
    await db.workoutSessions.update('session', { doneExerciseIds: ['a'] })

    await expect(
      applyCoachActionPlanToDb({
        proposalId: 'proposal-active-done-race',
        rawPlan: plan(
          {
            type: 'add_active_exercise',
            sessionId: 'session',
            exerciseId: 'c',
            position: 2,
            targetSets: 2,
            repRange: '12-15',
          },
          'active_workout',
          live.context.actionStateHashes.active_workout,
        ),
        currentStateHash: live.stateHash,
        currentActionStateHashes: live.context.actionStateHashes,
      }),
    ).rejects.toBeInstanceOf(StaleCoachActionError)

    expect((await db.workoutSessions.get('session'))?.doneExerciseIds).toEqual([
      'a',
    ])
    expect(
      (await db.workoutSessions.get('session'))?.exerciseSnapshot,
    ).toHaveLength(2)
    expect(
      await db.chatActionReceipts.get('proposal-active-done-race'),
    ).toBeUndefined()
  })

  it('rejects creating a one-time workout after another workout starts', async () => {
    await db.exercises.add(exercise('a'))
    const live = await buildLiveCoachContext()
    await db.workoutSessions.add({
      id: 'concurrent-session',
      sessionTemplateId: null,
      programId: null,
      name: 'Concurrent workout',
      programName: null,
      exerciseSnapshot: [
        {
          exerciseId: 'a',
          order: 0,
          targetSets: 3,
          targetRepRange: '8-10',
        },
      ],
      startedAt: 2,
      completedAt: null,
    })

    await expect(
      applyCoachActionPlanToDb({
        proposalId: 'proposal-one-time-race',
        rawPlan: plan(
          {
            type: 'create_one_time_workout',
            name: 'Stale workout',
            exercises: [
              { exerciseId: 'a', targetSets: 2, repRange: '10-12' },
            ],
          },
          'one_time_workout',
          live.context.actionStateHashes.one_time_workout,
        ),
        currentStateHash: live.stateHash,
        currentActionStateHashes: live.context.actionStateHashes,
      }),
    ).rejects.toBeInstanceOf(StaleCoachActionError)

    expect(await db.workoutSessions.toArray()).toEqual([
      expect.objectContaining({ id: 'concurrent-session' }),
    ])
    expect(
      await db.chatActionReceipts.get('proposal-one-time-race'),
    ).toBeUndefined()
  })

  it('rejects a custom exercise after the library changes', async () => {
    const live = await buildLiveCoachContext()
    await db.exercises.add(exercise('concurrent', 'Concurrent exercise'))

    await expect(
      applyCoachActionPlanToDb({
        proposalId: 'proposal-library-race',
        rawPlan: plan(
          {
            type: 'create_custom_exercise',
            name: 'Cable Y Raise',
            primaryMuscle: 'shoulders',
            secondaryMuscles: [],
            notes: '',
            defaultRestSeconds: 90,
          },
          'exercise_library',
          live.context.actionStateHashes.exercise_library,
        ),
        currentStateHash: live.stateHash,
        currentActionStateHashes: live.context.actionStateHashes,
      }),
    ).rejects.toBeInstanceOf(StaleCoachActionError)

    expect(await db.exercises.toArray()).toEqual([
      expect.objectContaining({ id: 'concurrent' }),
    ])
    expect(await db.chatActionReceipts.get('proposal-library-race')).toBeUndefined()
  })

  it('rejects saving a note after AI Memory is paused', async () => {
    const live = await buildLiveCoachContext()
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
      applyCoachActionPlanToDb({
        proposalId: 'proposal-memory-race',
        rawPlan: plan(
          { type: 'save_ai_note', body: 'Remember this.' },
          'ai_memory',
          live.context.actionStateHashes.ai_memory,
        ),
        currentStateHash: live.stateHash,
        currentActionStateHashes: live.context.actionStateHashes,
      }),
    ).rejects.toBeInstanceOf(StaleCoachActionError)

    expect(await db.aiNotes.count()).toBe(0)
    expect(await db.chatActionReceipts.get('proposal-memory-race')).toBeUndefined()
  })
})

describe('stored Coach action receipts', () => {
  it('accepts a legacy receipt and upgrades its scoped hash on replay', async () => {
    const live = await buildLiveCoachContext()
    const sourceActionStateHash =
      live.context.actionStateHashes.exercise_library
    const legacyResult = {
      proposalId: 'proposal-legacy',
      appliedAt: 120,
      sourceStateHash: HASH,
      replayed: false,
      syncPending: false,
      changes: [
        {
          type: 'create_custom_exercise' as const,
          label: 'Created Legacy Exercise',
          entityId: 'legacy-exercise',
        },
      ],
    }
    await db.chatActionReceipts.add({
      proposalId: legacyResult.proposalId,
      appliedAt: legacyResult.appliedAt,
      sourceStateHash: legacyResult.sourceStateHash,
      resultJson: JSON.stringify(legacyResult),
    })

    await expect(
      getAppliedCoachActionResult('proposal-legacy'),
    ).resolves.toEqual(legacyResult)
    await expect(
      applyCoachActionPlanToDb({
        proposalId: 'proposal-legacy',
        rawPlan: plan(
          {
            type: 'create_custom_exercise',
            name: 'Legacy Exercise',
            primaryMuscle: 'chest',
            secondaryMuscles: [],
            notes: '',
            defaultRestSeconds: 90,
          },
          'exercise_library',
          sourceActionStateHash,
        ),
        currentStateHash: live.stateHash,
        currentActionStateHashes: live.context.actionStateHashes,
      }),
    ).resolves.toMatchObject({
      proposalId: 'proposal-legacy',
      replayed: true,
      sourceActionStateHash,
    })
    expect(await db.exercises.count()).toBe(0)
  })

  it('skips a corrupt legacy row while returning a good pending receipt', async () => {
    const goodResult = {
      proposalId: 'proposal-good',
      appliedAt: 123,
      sourceStateHash: HASH,
      sourceActionStateHash: ACTION_HASH,
      replayed: false,
      syncPending: true,
      changes: [
        {
          type: 'save_ai_note' as const,
          label: 'Saved a note for AI Insights',
          entityId: 'note-1',
        },
      ],
    }
    await db.chatActionReceipts.bulkAdd([
      {
        proposalId: 'proposal-bad',
        appliedAt: 122,
        sourceStateHash: HASH,
        resultJson: '{',
      },
      {
        proposalId: 'proposal-empty',
        appliedAt: 121,
        sourceStateHash: HASH,
        resultJson: JSON.stringify({
          ...goodResult,
          proposalId: 'proposal-empty',
          appliedAt: 121,
          changes: [],
        }),
      },
      {
        proposalId: 'proposal-uppercase',
        appliedAt: 120,
        sourceStateHash: HASH,
        resultJson: JSON.stringify({
          ...goodResult,
          proposalId: 'proposal-uppercase',
          appliedAt: 120,
          sourceActionStateHash: ACTION_HASH.toUpperCase(),
        }),
      },
      {
        proposalId: goodResult.proposalId,
        appliedAt: goodResult.appliedAt,
        sourceStateHash: goodResult.sourceStateHash,
        resultJson: JSON.stringify(goodResult),
      },
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(getAppliedCoachActionResult('proposal-bad')).resolves.toBeNull()
    await expect(getAppliedCoachActionResult('proposal-empty')).resolves.toBeNull()
    await expect(
      getAppliedCoachActionResult('proposal-uppercase'),
    ).resolves.toBeNull()
    await expect(listPendingCoachActionResults()).resolves.toEqual([goodResult])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('proposal-bad'),
      expect.any(Error),
    )
    expect(await db.chatActionReceipts.count()).toBe(4)

    warn.mockRestore()
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
