import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './schema'
import {
  assertImportByteLength,
  importPayload,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS_PER_TABLE,
} from './repositories/exportImport'
import type { Exercise } from './types'

function exercise(id = 'exercise-1'): Exercise {
  return {
    id,
    name: 'Bench Press',
    primaryMuscle: 'chest',
    secondaryMuscles: ['triceps'],
    notes: '',
    defaultRestSeconds: 120,
    isCustom: false,
    hiddenFromLibrary: false,
    createdAt: 1,
  }
}

function payload() {
  return {
    schemaVersion: 4,
    exportedAt: 1,
    appVersion: '0.1.0',
    data: {
      exercises: [] as unknown[],
      programs: [] as unknown[],
      sessionTemplates: [] as unknown[],
      templateExercises: [] as unknown[],
      workoutSessions: [] as unknown[],
      loggedSets: [] as unknown[],
      recommendations: [] as unknown[],
      dailyBriefings: [] as unknown[],
      aiMemorySettings: [] as unknown[],
      aiNotes: [] as unknown[],
      aiMemorySummaries: [] as unknown[],
      chatActionReceipts: [] as unknown[],
    },
  }
}

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('import semantic validation', () => {
  it('rejects oversized files and oversized tables before changing data', async () => {
    expect(() => assertImportByteLength(MAX_IMPORT_BYTES + 1)).toThrow(
      '20 MB or smaller',
    )

    await db.exercises.add(exercise('existing'))
    const value = payload()
    value.data.exercises = new Array(MAX_IMPORT_ROWS_PER_TABLE + 1).fill(null)

    await expect(importPayload(JSON.stringify(value))).rejects.toThrow(
      '100,000-row limit',
    )
    expect(await db.exercises.get('existing')).toBeDefined()
  })

  it('rejects arrays where an object is required', async () => {
    await expect(importPayload(JSON.stringify([]))).rejects.toThrow(
      'Import file is not an object',
    )
  })

  it('rejects malformed values instead of trusting string ids', async () => {
    const value = payload()
    value.data.exercises.push({
      ...exercise(),
      defaultRestSeconds: -1,
    })
    await expect(importPayload(JSON.stringify(value))).rejects.toThrow(
      'Import table "exercises" is missing or malformed',
    )
  })

  it('rejects malformed post-workout feedback before changing local data', async () => {
    await db.exercises.add(exercise('existing'))
    const value = payload()
    value.data.workoutSessions.push({
      id: 'bad-feedback',
      sessionTemplateId: null,
      programId: null,
      name: 'Bad feedback',
      programName: null,
      exerciseSnapshot: [],
      startedAt: 1,
      completedAt: 2,
      postWorkoutFeedback: {
        version: 2,
        performance: 3,
        sessionRpe: 5,
        painImpact: 'unknown',
      },
    })

    await expect(importPayload(JSON.stringify(value))).rejects.toThrow(
      'postWorkoutFeedback painImpact is invalid',
    )
    expect(await db.exercises.get('existing')).toBeDefined()
  })

  it('does not coerce a non-string pain impact during import', async () => {
    const value = payload()
    value.data.workoutSessions.push({
      id: 'coerced-feedback',
      sessionTemplateId: null,
      programId: null,
      name: 'Coerced feedback',
      programName: null,
      exerciseSnapshot: [],
      startedAt: 1,
      completedAt: 2,
      postWorkoutFeedback: {
        version: 2,
        performance: 3,
        sessionRpe: 5,
        painImpact: ['none'],
      },
    })

    await expect(importPayload(JSON.stringify(value))).rejects.toThrow(
      'postWorkoutFeedback painImpact is invalid',
    )
  })

  it('rejects post-workout feedback on an unfinished session', async () => {
    await db.exercises.add(exercise('existing'))
    const value = payload()
    value.data.workoutSessions.push({
      id: 'unfinished-feedback',
      sessionTemplateId: null,
      programId: null,
      name: 'Unfinished feedback',
      programName: null,
      exerciseSnapshot: [],
      startedAt: 1,
      completedAt: null,
      postWorkoutFeedback: {
        version: 2,
        performance: 3,
        sessionRpe: 5,
        painImpact: 'none',
      },
    })

    await expect(importPayload(JSON.stringify(value))).rejects.toThrow(
      'postWorkoutFeedback requires a completed session',
    )
    expect(await db.exercises.get('existing')).toBeDefined()
  })

  it.each([
    [
      'wrong version',
      { version: 2, perceivedRecovery: 5, recordedAt: 2 },
      'has an unsupported version',
    ],
    [
      'fractional score',
      { version: 1, perceivedRecovery: 4.5, recordedAt: 2 },
      'perceivedRecovery must be null or a whole number from 0 to 10',
    ],
    [
      'out-of-range score',
      { version: 1, perceivedRecovery: 11, recordedAt: 2 },
      'perceivedRecovery must be null or a whole number from 0 to 10',
    ],
    [
      'unexpected field',
      {
        version: 1,
        perceivedRecovery: 5,
        recordedAt: 2,
        invented: true,
      },
      'has unexpected fields',
    ],
    [
      'timestamp before the session',
      { version: 1, perceivedRecovery: 5, recordedAt: 0 },
      'recordedAt precedes startedAt',
    ],
    [
      'timestamp after completion',
      { version: 1, perceivedRecovery: 5, recordedAt: 4 },
      'recordedAt follows completedAt',
    ],
  ])(
    'rejects a pre-workout check-in with %s before changing local data',
    async (_caseName, preWorkoutCheckIn, expectedIssue) => {
      await db.exercises.add(exercise('existing'))
      const value = payload()
      value.data.workoutSessions.push({
        id: 'bad-pre-check-in',
        sessionTemplateId: null,
        programId: null,
        name: 'Bad pre-check-in',
        programName: null,
        exerciseSnapshot: [],
        startedAt: 1,
        completedAt: 3,
        preWorkoutCheckIn,
      })

      await expect(importPayload(JSON.stringify(value))).rejects.toThrow(
        `preWorkoutCheckIn ${expectedIssue}`,
      )
      expect(await db.exercises.get('existing')).toBeDefined()
    },
  )

  it('accepts an unanswered sentinel completed by a stale app release', async () => {
    const value = payload()
    value.data.exercises.push(exercise())
    value.data.workoutSessions.push({
      id: 'pending-completed-check-in',
      sessionTemplateId: null,
      programId: null,
      name: 'Pending completed check-in',
      programName: null,
      exerciseSnapshot: [
        {
          exerciseId: 'exercise-1',
          order: 0,
          targetSets: 1,
          targetRepRange: '8-10',
        },
      ],
      startedAt: 1,
      completedAt: 3,
      preWorkoutCheckIn: null,
    })
    value.data.loggedSets.push({
      id: 'stale-release-set',
      workoutSessionId: 'pending-completed-check-in',
      exerciseId: 'exercise-1',
      setNumber: 1,
      weightLbs: 100,
      reps: 8,
      rpe: null,
      loggedAt: 2,
    })

    await expect(importPayload(JSON.stringify(value))).resolves.toEqual(
      expect.objectContaining({
        imported: expect.objectContaining({ workoutSessions: 1 }),
      }),
    )
    expect(
      (await db.workoutSessions.get('pending-completed-check-in'))
        ?.preWorkoutCheckIn,
    ).toBeNull()
  })

  it('accepts active logged work from a stale release with no recovery answer', async () => {
    await db.exercises.add(exercise('existing'))
    const value = payload()
    value.data.exercises.push(exercise())
    value.data.workoutSessions.push({
      id: 'pending-with-set',
      sessionTemplateId: null,
      programId: null,
      name: 'Pending with work',
      programName: null,
      exerciseSnapshot: [
        {
          exerciseId: 'exercise-1',
          order: 0,
          targetSets: 1,
          targetRepRange: '8-10',
        },
      ],
      startedAt: 1,
      completedAt: null,
      preWorkoutCheckIn: null,
    })
    value.data.loggedSets.push({
      id: 'set-on-pending-session',
      workoutSessionId: 'pending-with-set',
      exerciseId: 'exercise-1',
      setNumber: 1,
      weightLbs: 100,
      reps: 8,
      rpe: null,
      loggedAt: 2,
    })

    await expect(importPayload(JSON.stringify(value))).resolves.toEqual(
      expect.objectContaining({
        imported: expect.objectContaining({
          workoutSessions: 1,
          loggedSets: 1,
        }),
      }),
    )
    expect(
      (await db.workoutSessions.get('pending-with-set'))?.preWorkoutCheckIn,
    ).toBeNull()
  })

  it('rejects logged work that predates the pre-workout check-in', async () => {
    const value = payload()
    value.data.exercises.push(exercise())
    value.data.workoutSessions.push({
      id: 'session-with-late-check-in',
      sessionTemplateId: null,
      programId: null,
      name: 'Late check-in',
      programName: null,
      exerciseSnapshot: [
        {
          exerciseId: 'exercise-1',
          order: 0,
          targetSets: 1,
          targetRepRange: '8-10',
        },
      ],
      startedAt: 1,
      completedAt: 5,
      preWorkoutCheckIn: {
        version: 1,
        perceivedRecovery: 5,
        recordedAt: 3,
      },
    })
    value.data.loggedSets.push({
      id: 'set-before-check-in',
      workoutSessionId: 'session-with-late-check-in',
      exerciseId: 'exercise-1',
      setNumber: 1,
      weightLbs: 100,
      reps: 8,
      rpe: null,
      loggedAt: 2,
    })

    await expect(importPayload(JSON.stringify(value))).rejects.toThrow(
      'precedes its pre-workout check-in',
    )
  })

  it('rejects duplicate primary keys', async () => {
    const value = payload()
    value.data.exercises.push(exercise(), exercise())
    await expect(importPayload(JSON.stringify(value))).rejects.toThrow(
      'duplicate key',
    )
  })

  it('rejects multiple active programs', async () => {
    const value = payload()
    value.data.programs.push(
      {
        id: 'program-1',
        name: 'One',
        isActive: 1,
        createdAt: 1,
        archivedAt: null,
      },
      {
        id: 'program-2',
        name: 'Two',
        isActive: 1,
        createdAt: 2,
        archivedAt: null,
      },
    )
    await expect(importPayload(JSON.stringify(value))).rejects.toThrow(
      'more than one active program',
    )
  })

  it('rejects broken references and non-dense ordering', async () => {
    const missingProgram = payload()
    missingProgram.data.sessionTemplates.push({
      id: 'template-1',
      programId: 'missing',
      name: 'Push',
      order: 0,
    })
    await expect(importPayload(JSON.stringify(missingProgram))).rejects.toThrow(
      'references a missing program',
    )

    const badOrder = payload()
    badOrder.data.programs.push({
      id: 'program-1',
      name: 'Program',
      isActive: 0,
      createdAt: 1,
      archivedAt: null,
    })
    badOrder.data.sessionTemplates.push({
      id: 'template-1',
      programId: 'program-1',
      name: 'Push',
      order: 2,
    })
    await expect(importPayload(JSON.stringify(badOrder))).rejects.toThrow(
      'invalid order',
    )
  })

  it('rejects impossible briefing dates and blank required text', async () => {
    const value = payload()
    value.data.dailyBriefings.push({
      briefingDate: '2026-13-40',
      createdAt: 1,
      source: 'codex',
      snapshotUpdatedAt: 1,
      headline: 'Train',
      mode: 'normal',
      sections: {
        todaysCall: 'Train',
        why: [],
        ouraRecovery: '',
        trainingTrend: '',
        watchOuts: [],
      },
      model: 'codex',
      inputSummary: null,
    })
    await expect(importPayload(JSON.stringify(value))).rejects.toThrow(
      'dailyBriefings',
    )
  })

  it('accepts the explicit rest safety mode', async () => {
    const value = payload()
    value.data.dailyBriefings.push({
      briefingDate: '2026-08-01',
      createdAt: 1,
      source: 'codex-local',
      snapshotUpdatedAt: 1,
      headline: 'Rest today and get the pain assessed',
      mode: 'rest',
      sections: {
        todaysCall: 'Do not train today.',
        why: ['Recent context reports severe unexplained pain.'],
        recoveryStatus: 'unavailable',
        ouraRecovery: 'Oura unavailable; use workout history only.',
        trainingTrend: 'Training history does not override the safety flag.',
        watchOuts: ['Seek urgent care if symptoms are severe or worsening.'],
      },
      model: 'gpt-5.6-sol',
      inputSummary: null,
    })

    await expect(importPayload(JSON.stringify(value))).resolves.toBeDefined()
    expect((await db.dailyBriefings.get('2026-08-01'))?.mode).toBe('rest')
  })

  it('validates fully before clearing existing data', async () => {
    await db.exercises.add(exercise('existing'))
    const value = payload()
    value.data.loggedSets.push({
      id: 'set-1',
      workoutSessionId: 'missing-session',
      exerciseId: 'missing-exercise',
      setNumber: 1,
      weightLbs: 100,
      reps: 8,
      rpe: null,
      loggedAt: 1,
    })

    await expect(importPayload(JSON.stringify(value))).rejects.toThrow(
      'broken reference',
    )
    expect(await db.exercises.get('existing')).toBeDefined()
  })
})
