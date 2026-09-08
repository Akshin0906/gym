import { describe, expect, it } from 'vitest'
import type {
  Exercise,
  LoggedSet,
  SessionExerciseSnapshot,
  WorkoutSession,
} from '../db/types'
import {
  buildComparableProgression,
  buildSessionAttainment,
} from './plannedVsPerformed'

function exercise(id: string, overrides: Partial<Exercise> = {}): Exercise {
  return {
    id,
    name: id,
    primaryMuscle: 'shoulders',
    secondaryMuscles: [],
    notes: '',
    defaultRestSeconds: 75,
    isCustom: false,
    hiddenFromLibrary: false,
    createdAt: 0,
    ...overrides,
  }
}

function session(
  overrides: Partial<WorkoutSession> & {
    exerciseSnapshot: SessionExerciseSnapshot[]
  },
): WorkoutSession {
  return {
    id: 'session-1',
    sessionTemplateId: null,
    programId: null,
    name: 'Push',
    programName: null,
    startedAt: 1_000,
    completedAt: 2_000,
    ...overrides,
  }
}

function set(overrides: Partial<LoggedSet> & { id: string }): LoggedSet {
  return {
    workoutSessionId: 'session-1',
    exerciseId: 'lateral-raise',
    setNumber: 1,
    weightLbs: 20,
    reps: 12,
    rpe: 8,
    loggedAt: 1_500,
    ...overrides,
  }
}

const exercises = new Map([
  ['lateral-raise', exercise('lateral-raise', { name: 'Cable Lateral Raise' })],
  ['dip', exercise('dip', { name: 'Assisted Dip' })],
])

describe('session attainment', () => {
  it('counts sets below the minimum reps of a parsed target', () => {
    // The reviewed snapshot's shape: a 12-15 prescription logged at 10 reps.
    const attainment = buildSessionAttainment(
      session({
        exerciseSnapshot: [
          {
            exerciseId: 'lateral-raise',
            order: 0,
            targetSets: 4,
            targetRepRange: '12-15',
          },
        ],
      }),
      [
        set({ id: 's1', setNumber: 1, reps: 10 }),
        set({ id: 's2', setNumber: 2, reps: 10 }),
        set({ id: 's3', setNumber: 3, reps: 16 }),
        set({ id: 's4', setNumber: 4, reps: 13 }),
      ],
      exercises,
    )

    const row = attainment.exercises[0]
    expect(row.repTargetSource).toBe('parsed_text')
    expect(row.repTarget).toEqual({ min: 12, max: 15 })
    expect(row.setsBelowMinReps).toBe(2)
    expect(row.setsAboveMaxReps).toBe(1)
    expect(row.setsInRepRange).toBe(1)
    expect(row.unfinishedSets).toBe(0)
  })

  it('reports unfinished planned sets without calling them skipped', () => {
    // The reviewed session: 8 logged against 19 planned.
    const attainment = buildSessionAttainment(
      session({
        exerciseSnapshot: [
          {
            exerciseId: 'lateral-raise',
            order: 0,
            targetSets: 12,
            targetRepRange: '12-15',
          },
          { exerciseId: 'dip', order: 1, targetSets: 7, targetRepRange: '6-8' },
        ],
      }),
      [
        set({ id: 's1', setNumber: 1 }),
        set({ id: 's2', setNumber: 2 }),
        set({ id: 's3', setNumber: 3 }),
        set({ id: 's4', setNumber: 4 }),
        set({ id: 's5', setNumber: 5 }),
        set({ id: 's6', setNumber: 6 }),
        set({ id: 's7', setNumber: 7 }),
        set({ id: 's8', setNumber: 8 }),
      ],
      exercises,
    )

    expect(attainment.plannedSetTotal).toBe(19)
    expect(attainment.workingSetTotal).toBe(8)
    expect(attainment.unfinishedSetTotal).toBe(11)
    expect(attainment.unstartedExerciseCount).toBe(1)
  })

  it('distinguishes a missing target from an unparseable one', () => {
    const attainment = buildSessionAttainment(
      session({
        exerciseSnapshot: [
          {
            exerciseId: 'lateral-raise',
            order: 0,
            targetSets: 2,
            targetRepRange: 'as many as feel good',
          },
          { exerciseId: 'dip', order: 1, targetSets: 2, targetRepRange: '' },
        ],
      }),
      [
        set({ id: 's1', setNumber: 1 }),
        set({ id: 's2', exerciseId: 'dip', setNumber: 1 }),
      ],
      exercises,
    )

    expect(attainment.exercises[0].repTargetSource).toBe('unparseable_text')
    expect(attainment.exercises[1].repTargetSource).toBe('missing')
    expect(attainment.exercises[0].setsWithoutRepTarget).toBe(1)
  })

  it('honours explicit structured bounds over the display text', () => {
    const attainment = buildSessionAttainment(
      session({
        exerciseSnapshot: [
          {
            exerciseId: 'lateral-raise',
            order: 0,
            targetSets: 1,
            targetRepRange: 'top set then back-offs',
            repBounds: { min: 6, max: 8 },
          },
        ],
      }),
      [set({ id: 's1', reps: 7 })],
      exercises,
    )

    expect(attainment.exercises[0].repTargetSource).toBe('structured')
    expect(attainment.exercises[0].setsInRepRange).toBe(1)
  })

  it('treats mid-session additions as freestyle rather than a plan of zero', () => {
    const attainment = buildSessionAttainment(
      session({
        exerciseSnapshot: [
          { exerciseId: 'dip', order: 0, targetSets: 0, targetRepRange: '' },
        ],
      }),
      [set({ id: 's1', exerciseId: 'dip' })],
      exercises,
    )

    expect(attainment.exercises[0].planKind).toBe('freestyle')
    expect(attainment.exercises[0].plannedSets).toBeNull()
    expect(attainment.exercises[0].unfinishedSets).toBeNull()
    expect(attainment.plannedSetTotal).toBeNull()
  })

  it('separates warm-up sets from working sets and leaves legacy sets working', () => {
    const attainment = buildSessionAttainment(
      session({
        exerciseSnapshot: [
          {
            exerciseId: 'lateral-raise',
            order: 0,
            targetSets: 3,
            targetRepRange: '12-15',
          },
        ],
      }),
      [
        set({ id: 'w1', setNumber: 1, setKind: 'warmup', reps: 8 }),
        set({ id: 's1', setNumber: 2, setKind: 'working', reps: 13 }),
        set({ id: 'legacy', setNumber: 3, reps: 13 }),
      ],
      exercises,
    )

    const row = attainment.exercises[0]
    expect(row.warmupSets).toBe(1)
    expect(row.workingSets).toBe(2)
    expect(row.unclassifiedSets).toBe(1)
    expect(row.unfinishedSets).toBe(1)
  })

  it('omits a one-rep-max estimate for assistance loads', () => {
    const attainment = buildSessionAttainment(
      session({
        exerciseSnapshot: [
          {
            exerciseId: 'dip',
            order: 0,
            targetSets: 2,
            targetRepRange: '6-8',
            loadConvention: 'assistance',
          },
        ],
      }),
      [set({ id: 's1', exerciseId: 'dip', weightLbs: 60, reps: 7 })],
      exercises,
    )

    expect(attainment.exercises[0].loadConvention).toBe('assistance')
    expect(attainment.exercises[0].bestEstimated1RM).toBeNull()
  })
})

describe('comparable progression', () => {
  function completedSession(
    id: string,
    completedAt: number,
    snapshot: SessionExerciseSnapshot,
  ): WorkoutSession {
    return {
      id,
      sessionTemplateId: null,
      programId: null,
      name: 'Push',
      programName: null,
      exerciseSnapshot: [snapshot],
      startedAt: completedAt - 1,
      completedAt,
    }
  }

  it('keeps only sessions with the same rep target and load convention', () => {
    const sessions = [
      completedSession('a', 3_000, {
        exerciseId: 'lateral-raise',
        order: 0,
        targetSets: 3,
        targetRepRange: '12-15',
      }),
      completedSession('b', 2_000, {
        exerciseId: 'lateral-raise',
        order: 0,
        targetSets: 3,
        targetRepRange: '12-15',
      }),
      completedSession('c', 1_000, {
        exerciseId: 'lateral-raise',
        order: 0,
        targetSets: 3,
        targetRepRange: '8-10',
      }),
    ]
    const sets = [
      set({ id: 'a1', workoutSessionId: 'a', weightLbs: 25, reps: 13 }),
      set({ id: 'b1', workoutSessionId: 'b', weightLbs: 22.5, reps: 13 }),
      set({ id: 'c1', workoutSessionId: 'c', weightLbs: 30, reps: 9 }),
    ]

    const progression = buildComparableProgression({
      exerciseId: 'lateral-raise',
      exercise: exercises.get('lateral-raise'),
      sessions,
      sets,
    })

    expect(progression.points.map((p) => p.sessionId)).toEqual(['b', 'a'])
    expect(progression.excludedSessionCount).toBe(1)
    expect(progression.excludedReasons.repTarget).toBe(1)
    expect(progression.repTarget).toEqual({ min: 12, max: 15 })
  })

  it('excludes sessions whose load convention differs', () => {
    const sessions = [
      completedSession('a', 3_000, {
        exerciseId: 'dip',
        order: 0,
        targetSets: 3,
        targetRepRange: '6-8',
        loadConvention: 'assistance',
      }),
      completedSession('b', 2_000, {
        exerciseId: 'dip',
        order: 0,
        targetSets: 3,
        targetRepRange: '6-8',
        loadConvention: 'total',
      }),
    ]
    const sets = [
      set({
        id: 'a1',
        exerciseId: 'dip',
        workoutSessionId: 'a',
        loadConvention: 'assistance',
      }),
      set({
        id: 'b1',
        exerciseId: 'dip',
        workoutSessionId: 'b',
        loadConvention: 'total',
      }),
    ]

    const progression = buildComparableProgression({
      exerciseId: 'dip',
      exercise: exercises.get('dip'),
      sessions,
      sets,
    })

    expect(progression.points.map((p) => p.sessionId)).toEqual(['a'])
    expect(progression.excludedReasons.loadConvention).toBe(1)
    expect(progression.points[0].bestEstimated1RM).toBeNull()
  })

  it('treats legacy sets with no recorded convention as comparable with total', () => {
    const sessions = [
      completedSession('a', 3_000, {
        exerciseId: 'lateral-raise',
        order: 0,
        targetSets: 3,
        targetRepRange: '12-15',
        loadConvention: 'total',
      }),
      completedSession('b', 2_000, {
        exerciseId: 'lateral-raise',
        order: 0,
        targetSets: 3,
        targetRepRange: '12-15',
      }),
    ]
    const sets = [
      set({ id: 'a1', workoutSessionId: 'a', loadConvention: 'total' }),
      set({ id: 'b1', workoutSessionId: 'b' }),
    ]

    const progression = buildComparableProgression({
      exerciseId: 'lateral-raise',
      exercise: exercises.get('lateral-raise'),
      sessions,
      sets,
    })

    expect(progression.points).toHaveLength(2)
    expect(progression.excludedSessionCount).toBe(0)
  })
})
