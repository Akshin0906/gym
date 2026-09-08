import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db/schema'
import {
  createCustomExercise,
  updateExercise,
} from '../db/repositories/exercises'
import {
  addSessionTemplate,
  addTemplateExercise,
  createProgram,
  setProgramActive,
} from '../db/repositories/programs'
import {
  appendExerciseToSession,
  endSession,
  getAllSetsForExercise,
  getRecentSessionE1RMsForExercise,
  logSet,
  recordPreWorkoutCheckIn,
  startSession,
  updateSet,
} from '../db/repositories/sessions'
import {
  buildExportPayload,
  importPayload,
} from '../db/repositories/exportImport'
import { buildOneRMTrend } from './analytics'
import { resolveSetLoadConvention } from './measurement'
import { buildSessionAttainment } from './plannedVsPerformed'

const baseExercise = {
  primaryMuscle: 'shoulders' as const,
  secondaryMuscles: [],
  notes: '',
  defaultRestSeconds: 75,
  hiddenFromLibrary: false,
}

async function startProgramSession(exerciseId: string): Promise<string> {
  const programId = await createProgram('P')
  const templateId = await addSessionTemplate(programId, 'S')
  await addTemplateExercise({
    sessionTemplateId: templateId,
    exerciseId,
    targetSets: 3,
    targetRepRange: '8-12',
  })
  await setProgramActive(programId)
  const template = await db.sessionTemplates.get(templateId)
  const program = await db.programs.get(programId)
  const sessionId = await startSession(template!, { ...program!, isActive: true })
  await recordPreWorkoutCheckIn(sessionId, 7)
  return sessionId
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('historical measurement is frozen', () => {
  it('does not reinterpret legacy sets when the exercise is edited later', async () => {
    // The reported regression: a legacy row with no recorded convention read
    // back through the exercise's CURRENT setting, so one edit rewrote how
    // every past set was measured.
    const exerciseId = await createCustomExercise({
      ...baseExercise,
      name: 'Machine Press',
    })
    await db.workoutSessions.add({
      id: 'legacy-session',
      sessionTemplateId: null,
      programId: null,
      name: 'Legacy',
      programName: null,
      // No frozen convention: exactly what a pre-upgrade session looks like.
      exerciseSnapshot: [
        { exerciseId, order: 0, targetSets: 3, targetRepRange: '8-12' },
      ],
      startedAt: 1_000,
      completedAt: 2_000,
    })
    await db.loggedSets.add({
      id: 'legacy-set',
      workoutSessionId: 'legacy-session',
      exerciseId,
      setNumber: 1,
      weightLbs: 100,
      reps: 5,
      rpe: null,
      loggedAt: 1_500,
    })

    const before = await db.loggedSets.get('legacy-set')
    expect(resolveSetLoadConvention(before!)).toBe('unknown')
    expect(buildOneRMTrend([before!])).toHaveLength(1)

    // Reconfigure the exercise today.
    await updateExercise(exerciseId, {
      ...baseExercise,
      name: 'Machine Press',
      measurement: { loadConvention: 'machine_setting' },
    })

    const after = await db.loggedSets.get('legacy-set')
    expect(resolveSetLoadConvention(after!)).toBe('unknown')
    // Still charted exactly as before the edit.
    expect(buildOneRMTrend([after!])).toEqual(buildOneRMTrend([before!]))

    const session = await db.workoutSessions.get('legacy-session')
    const attainment = buildSessionAttainment(
      session!,
      [after!],
      new Map([[exerciseId, (await db.exercises.get(exerciseId))!]]),
    )
    expect(attainment.exercises[0].loadConvention).toBe('unknown')
    expect(attainment.exercises[0].bestEstimated1RM).toBe(117)
  })

  it('writes an explicit convention on new sessions and sets', async () => {
    const exerciseId = await createCustomExercise({
      ...baseExercise,
      name: 'Assisted Dip',
      measurement: { loadConvention: 'assistance' },
    })
    const sessionId = await startProgramSession(exerciseId)

    const session = await db.workoutSessions.get(sessionId)
    expect(session?.exerciseSnapshot[0].loadConvention).toBe('assistance')

    const logged = await logSet({
      sessionId,
      exerciseId,
      weightLbs: 60,
      reps: 8,
      rpe: 8,
    })
    expect((await db.loggedSets.get(logged.id))?.loadConvention).toBe(
      'assistance',
    )
  })

  it('freezes an explicit unknown so a later edit cannot claim it', async () => {
    const exerciseId = await createCustomExercise({
      ...baseExercise,
      name: 'Lateral Raise',
    })
    const sessionId = await startProgramSession(exerciseId)
    const logged = await logSet({
      sessionId,
      exerciseId,
      weightLbs: 20,
      reps: 12,
      rpe: 8,
    })

    expect(
      (await db.workoutSessions.get(sessionId))?.exerciseSnapshot[0]
        .loadConvention,
    ).toBe('unknown')

    await updateExercise(exerciseId, {
      ...baseExercise,
      name: 'Lateral Raise',
      measurement: { loadConvention: 'per_dumbbell' },
    })

    expect((await db.loggedSets.get(logged.id))?.loadConvention).toBe('unknown')
  })

  it('logs into an existing session under the session plan, not today’s exercise', async () => {
    const exerciseId = await createCustomExercise({
      ...baseExercise,
      name: 'Row',
      measurement: { loadConvention: 'total' },
    })
    const sessionId = await startProgramSession(exerciseId)

    // The exercise is reconfigured mid-session.
    await updateExercise(exerciseId, {
      ...baseExercise,
      name: 'Row',
      measurement: { loadConvention: 'machine_setting' },
    })

    const logged = await logSet({
      sessionId,
      exerciseId,
      weightLbs: 100,
      reps: 8,
      rpe: 8,
    })
    // The session froze `total`, so this set belongs to that measurement.
    expect((await db.loggedSets.get(logged.id))?.loadConvention).toBe('total')
  })

  it('freezes the current convention for an exercise added mid-session', async () => {
    const planned = await createCustomExercise({
      ...baseExercise,
      name: 'Planned',
    })
    const added = await createCustomExercise({
      ...baseExercise,
      name: 'Added',
      measurement: { loadConvention: 'bodyweight' },
    })
    const sessionId = await startProgramSession(planned)
    await appendExerciseToSession(sessionId, added)

    const row = (await db.workoutSessions.get(sessionId))?.exerciseSnapshot.find(
      (item) => item.exerciseId === added,
    )
    expect(row?.loadConvention).toBe('bodyweight')
  })
})

describe('zero load end to end', () => {
  it('accepts, exports, and re-imports a zero-load bodyweight set', async () => {
    const exerciseId = await createCustomExercise({
      ...baseExercise,
      name: 'Pull-up',
      measurement: { loadConvention: 'bodyweight' },
    })
    const sessionId = await startProgramSession(exerciseId)
    const logged = await logSet({
      sessionId,
      exerciseId,
      weightLbs: 0,
      reps: 10,
      rpe: 8,
    })
    await endSession(sessionId)

    const payload = await buildExportPayload()
    expect(payload.data.loggedSets[0]).toMatchObject({
      weightLbs: 0,
      loadConvention: 'bodyweight',
    })

    await importPayload(JSON.stringify(payload))
    expect((await db.loggedSets.get(logged.id))?.weightLbs).toBe(0)
  })

  it('accepts a zero assistance load and allows editing to zero', async () => {
    const exerciseId = await createCustomExercise({
      ...baseExercise,
      name: 'Assisted Pull-up',
      measurement: { loadConvention: 'assistance' },
    })
    const sessionId = await startProgramSession(exerciseId)
    const logged = await logSet({
      sessionId,
      exerciseId,
      weightLbs: 40,
      reps: 8,
      rpe: 8,
    })

    await updateSet(logged.id, { weightLbs: 0 })
    expect((await db.loggedSets.get(logged.id))?.weightLbs).toBe(0)
  })

  it('still rejects a zero load for total, legacy, and machine measurements', async () => {
    const exerciseId = await createCustomExercise({
      ...baseExercise,
      name: 'Barbell Row',
      measurement: { loadConvention: 'total' },
    })
    const sessionId = await startProgramSession(exerciseId)

    await expect(
      logSet({ sessionId, exerciseId, weightLbs: 0, reps: 8, rpe: null }),
    ).rejects.toThrow('greater than 0')

    const legacyId = await createCustomExercise({
      ...baseExercise,
      name: 'Legacy Row',
    })
    await appendExerciseToSession(sessionId, legacyId)
    await expect(
      logSet({ sessionId, exerciseId: legacyId, weightLbs: 0, reps: 8, rpe: null }),
    ).rejects.toThrow('greater than 0')
  })

  it('always rejects a negative or non-finite load', async () => {
    const exerciseId = await createCustomExercise({
      ...baseExercise,
      name: 'Dip',
      measurement: { loadConvention: 'bodyweight' },
    })
    const sessionId = await startProgramSession(exerciseId)

    await expect(
      logSet({ sessionId, exerciseId, weightLbs: -5, reps: 8, rpe: null }),
    ).rejects.toThrow('negative')
    await expect(
      logSet({ sessionId, exerciseId, weightLbs: Number.NaN, reps: 8, rpe: null }),
    ).rejects.toThrow('finite')
  })

  it('rejects a zero total-load set in a restored backup', async () => {
    const payload = {
      schemaVersion: 4,
      exportedAt: 1,
      appVersion: 'test',
      data: {
        exercises: [],
        programs: [],
        sessionTemplates: [],
        templateExercises: [],
        workoutSessions: [],
        loggedSets: [
          {
            id: 's1',
            workoutSessionId: 'w1',
            exerciseId: 'e1',
            setNumber: 1,
            weightLbs: 0,
            reps: 8,
            rpe: null,
            loggedAt: 1,
            loadConvention: 'total',
          },
        ],
        recommendations: [],
        dailyBriefings: [],
        aiMemorySettings: [],
        aiNotes: [],
        aiMemorySummaries: [],
        chatActionReceipts: [],
      },
    }
    await expect(importPayload(JSON.stringify(payload))).rejects.toThrow(
      'loggedSets',
    )
  })
})

describe('warm-up sets stay out of performance comparisons', () => {
  it('excludes warm-ups from the one-rep-max trend', async () => {
    const exerciseId = await createCustomExercise({
      ...baseExercise,
      name: 'Bench',
    })
    const sessionId = await startProgramSession(exerciseId)
    await logSet({
      sessionId,
      exerciseId,
      weightLbs: 315,
      reps: 5,
      rpe: null,
      setKind: 'warmup',
    })
    await logSet({
      sessionId,
      exerciseId,
      weightLbs: 100,
      reps: 5,
      rpe: null,
      setKind: 'working',
    })

    const sets = await getAllSetsForExercise(exerciseId)
    const trend = buildOneRMTrend(sets)
    expect(trend).toHaveLength(1)
    expect(trend[0].est1rm).toBe(117)
    // Opt-in for a view that genuinely wants everything.
    expect(buildOneRMTrend(sets, { includeWarmups: true })).toHaveLength(2)
  })

  it('excludes warm-ups from the per-session best estimate', async () => {
    const exerciseId = await createCustomExercise({
      ...baseExercise,
      name: 'Squat',
    })
    const sessionId = await startProgramSession(exerciseId)
    await logSet({
      sessionId,
      exerciseId,
      weightLbs: 405,
      reps: 3,
      rpe: null,
      setKind: 'warmup',
    })
    await logSet({
      sessionId,
      exerciseId,
      weightLbs: 200,
      reps: 5,
      rpe: null,
      setKind: 'working',
    })
    await endSession(sessionId)

    const trend = await getRecentSessionE1RMsForExercise(
      exerciseId,
      undefined,
      5,
    )
    expect(trend.points).toHaveLength(1)
    expect(trend.points[0].e1rm).toBe(233)
  })
})
