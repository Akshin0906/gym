import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildOneRMTrend,
  buildOneRMTrendDetailed,
  buildWeeklySetCountsSplit,
  oneRepMaxEstimateNotes,
} from './analytics'
import { loadConventionsComparableForProgression } from './measurement'
import { db } from '../db/schema'
import { createCustomExercise } from '../db/repositories/exercises'
import {
  getRecentSessionE1RMsForExercise,
  logSet,
  recordPreWorkoutCheckIn,
  startSession,
} from '../db/repositories/sessions'
import {
  addSessionTemplate,
  addTemplateExercise,
  createProgram,
  setProgramActive,
} from '../db/repositories/programs'
import { RPE_ANCHOR_HINT } from '../components/SetLogger'
import { estimateUnavailableReason } from '../components/ExerciseDetailOverlay'
import type { Exercise, LoggedSet } from '../db/types'

function set(
  overrides: Partial<LoggedSet> & Pick<LoggedSet, 'id' | 'loggedAt'>,
): LoggedSet {
  return {
    workoutSessionId: 'session',
    exerciseId: 'exercise',
    setNumber: 1,
    weightLbs: 100,
    reps: 5,
    rpe: null,
    ...overrides,
  }
}

describe('progression comparability', () => {
  it('treats an unrecorded legacy load as its own measurement', () => {
    // Reading a legacy row as total pounds is the right description, and a
    // terrible basis for saying somebody got stronger: the old 20 may well
    // have been 20 per dumbbell.
    expect(loadConventionsComparableForProgression('unknown', 'total')).toBe(false)
    expect(loadConventionsComparableForProgression('unknown', 'unknown')).toBe(true)
    expect(loadConventionsComparableForProgression('total', 'total')).toBe(true)
    expect(
      loadConventionsComparableForProgression('per_dumbbell', 'total'),
    ).toBe(false)
  })
})

describe('one-rep-max trend', () => {
  it('never joins two conventions into one line', () => {
    const trend = buildOneRMTrendDetailed([
      set({ id: 'a', loggedAt: 1, weightLbs: 20, loadConvention: 'per_dumbbell' }),
      set({ id: 'b', loggedAt: 2, weightLbs: 40, loadConvention: 'total' }),
    ])
    expect(trend.convention).toBe('total')
    expect(trend.points).toHaveLength(1)
    expect(trend.excludedOtherConventionSetCount).toBe(1)
  })

  it('excludes a legacy row from a recorded-total trend', () => {
    const trend = buildOneRMTrendDetailed([
      set({ id: 'a', loggedAt: 1, weightLbs: 20 }),
      set({ id: 'b', loggedAt: 2, weightLbs: 40, loadConvention: 'total' }),
    ])
    expect(trend.points).toHaveLength(1)
    expect(trend.excludedOtherConventionSetCount).toBe(1)
    expect(trend.includesAssumedUnits).toBe(false)
  })

  it('still charts a wholly legacy history and says so', () => {
    const trend = buildOneRMTrendDetailed([
      set({ id: 'a', loggedAt: 1, weightLbs: 100 }),
      set({ id: 'b', loggedAt: 2, weightLbs: 105 }),
    ])
    expect(trend.points).toHaveLength(2)
    expect(trend.convention).toBe('unknown')
    expect(trend.includesAssumedUnits).toBe(true)
  })

  it('anchors on the newest set even when it cannot be charted', () => {
    // After a switch to assisted work there is no valid estimate at all.
    // Falling back to the newest *chartable* set would keep drawing a line for
    // a way of training the user has stopped.
    const trend = buildOneRMTrendDetailed([
      set({ id: 'a', loggedAt: 1, weightLbs: 100, loadConvention: 'total' }),
      set({ id: 'b', loggedAt: 2, weightLbs: 40, loadConvention: 'assistance' }),
    ])
    expect(trend.convention).toBe('assistance')
    expect(trend.points).toEqual([])
  })

  it('keeps warm-ups out by default', () => {
    const points = buildOneRMTrend([
      set({ id: 'a', loggedAt: 1, weightLbs: 315, setKind: 'warmup' }),
      set({ id: 'b', loggedAt: 2, weightLbs: 100, setKind: 'working' }),
    ])
    expect(points).toHaveLength(1)
    expect(points[0].est1rm).toBe(117)
  })
})

describe('estimate caveats', () => {
  it('reports heuristic flags rather than a confidence figure', () => {
    const notes = oneRepMaxEstimateNotes([
      set({ id: 'a', loggedAt: 1, reps: 12 }),
      set({ id: 'b', loggedAt: 2, reps: 11, rpe: 8 }),
    ])
    expect(notes.highestRepCountUsed).toBe(12)
    expect(notes.manyRepsExtrapolatedFrom).toBe(true)
    expect(notes.noSetEffortRecorded).toBe(false)
    expect(notes.setsWithRecordedEffort).toBe(1)
  })

  it('flags a session with no recorded effort at all', () => {
    const notes = oneRepMaxEstimateNotes([set({ id: 'a', loggedAt: 1, reps: 5 })])
    expect(notes.noSetEffortRecorded).toBe(true)
    expect(notes.manyRepsExtrapolatedFrom).toBe(false)
  })

  it('marks a logged single as a load rather than a verified maximum', () => {
    expect(
      oneRepMaxEstimateNotes([set({ id: 'a', loggedAt: 1, reps: 1 })])
        .hasSingleRepSet,
    ).toBe(true)
  })
})

describe('set logging effort anchors', () => {
  it('states the reps-in-reserve anchors and that RPE is optional', () => {
    expect(RPE_ANCHOR_HINT).toContain('optional')
    expect(RPE_ANCHOR_HINT).toContain('2 reps left')
    expect(RPE_ANCHOR_HINT).toContain('whole-session')
  })
})

describe('unavailable estimate wording', () => {
  const base = {
    points: [],
    convention: null,
    excludedOtherConventionSessionCount: 0,
    mixedConventionSessionCount: 0,
    excludedNoEstimateSessionCount: 0,
    includesAssumedUnits: false,
  }

  it('says an assisted or machine measurement has no estimate at all', () => {
    // "Need a couple more sessions" is wrong here: more assisted pull-up
    // sessions will never produce a one-rep-max estimate.
    const message = estimateUnavailableReason({
      ...base,
      convention: 'assistance',
      excludedNoEstimateSessionCount: 4,
    })
    expect(message).toMatch(/not defined/i)
    expect(message).toMatch(/more sessions will not change that/i)
  })

  it('distinguishes mixed units inside a session', () => {
    expect(
      estimateUnavailableReason({ ...base, mixedConventionSessionCount: 2 }),
    ).toMatch(/different units/i)
  })

  it('distinguishes a changed recording style', () => {
    expect(
      estimateUnavailableReason({
        ...base,
        convention: 'total',
        excludedOtherConventionSessionCount: 3,
      }),
    ).toMatch(/recorded load a different way/i)
  })

  it('still says "sparse" when the data really are sparse', () => {
    expect(estimateUnavailableReason({ ...base, convention: 'total' })).toMatch(
      /couple more sessions/i,
    )
  })
})

describe('weekly set credit', () => {
  const exercises = new Map<string, Exercise>([
    [
      'bench',
      {
        id: 'bench',
        name: 'Bench',
        primaryMuscle: 'chest',
        secondaryMuscles: ['triceps'],
        notes: '',
        defaultRestSeconds: 120,
        isCustom: false,
        hiddenFromLibrary: false,
        createdAt: 0,
      },
    ],
  ])

  it('counts working sets only, not warm-ups', () => {
    // Four sessions, each one working set and one warm-up. Counting the
    // warm-ups doubled every weekly figure for anyone who logs them.
    const sets: LoggedSet[] = []
    for (let session = 0; session < 4; session += 1) {
      const loggedAt = Date.UTC(2026, 8, 1 + session, 12)
      sets.push(
        set({
          id: `warm-${session}`,
          loggedAt,
          exerciseId: 'bench',
          setKind: 'warmup',
        }),
        set({
          id: `work-${session}`,
          loggedAt: loggedAt + 1,
          exerciseId: 'bench',
          setKind: 'working',
        }),
      )
    }
    const rows = buildWeeklySetCountsSplit(sets, exercises)
    const direct = rows.reduce((sum, row) => sum + (row.direct.chest ?? 0), 0)
    const secondary = rows.reduce(
      (sum, row) => sum + (row.secondary.triceps ?? 0),
      0,
    )
    expect(direct).toBe(4)
    expect(secondary).toBe(4)
  })

  it('counts an unclassified legacy set as working', () => {
    const rows = buildWeeklySetCountsSplit(
      [set({ id: 'legacy', loggedAt: Date.UTC(2026, 8, 1, 12), exerciseId: 'bench' })],
      exercises,
    )
    expect(rows[0].direct.chest).toBe(1)
  })

  it('can still include warm-ups when a caller asks', () => {
    const rows = buildWeeklySetCountsSplit(
      [
        set({
          id: 'warm',
          loggedAt: Date.UTC(2026, 8, 1, 12),
          exerciseId: 'bench',
          setKind: 'warmup',
        }),
      ],
      exercises,
      { includeWarmups: true },
    )
    expect(rows[0].direct.chest).toBe(1)
  })
})

describe('per-session estimate trend', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((table) => table.clear()))
  })

  async function sessionWith(
    exerciseId: string,
    weightLbs: number,
    reps: number,
  ): Promise<void> {
    const programId = await createProgram('P')
    const templateId = await addSessionTemplate(programId, 'S')
    await addTemplateExercise({
      sessionTemplateId: templateId,
      exerciseId,
      targetSets: 1,
      targetRepRange: '5',
    })
    await setProgramActive(programId)
    const template = await db.sessionTemplates.get(templateId)
    const program = await db.programs.get(programId)
    const sessionId = await startSession(template!, {
      ...program!,
      isActive: true,
    })
    await recordPreWorkoutCheckIn(sessionId, 7)
    await logSet({
      sessionId,
      exerciseId,
      weightLbs,
      reps,
      rpe: null,
      setKind: 'working',
    })
    await db.workoutSessions.update(sessionId, { completedAt: Date.now() })
  }

  it('drops sessions recorded under a different convention', async () => {
    const exerciseId = await createCustomExercise({
      name: 'Machine Row',
      primaryMuscle: 'back',
      secondaryMuscles: [],
      notes: '',
      defaultRestSeconds: 90,
      hiddenFromLibrary: false,
      measurement: { loadConvention: 'total' },
    })
    await sessionWith(exerciseId, 100, 5)
    // Retroactively mark the older session as a different measurement, the way
    // a real history that changed recording style would look.
    const sets = await db.loggedSets.where('exerciseId').equals(exerciseId).toArray()
    await db.loggedSets.update(sets[0].id, { loadConvention: 'per_dumbbell' })
    await sessionWith(exerciseId, 200, 5)

    const trend = await getRecentSessionE1RMsForExercise(exerciseId, undefined, 10)
    expect(trend.convention).toBe('total')
    expect(trend.points).toHaveLength(1)
    expect(trend.excludedOtherConventionSessionCount).toBe(1)
  })
})
