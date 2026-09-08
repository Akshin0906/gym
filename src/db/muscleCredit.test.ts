import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  HAMSTRING_CREDIT_CORRECTIONS,
  correctedStockExercise,
  db,
  sameMuscleList,
} from './schema'
import { SEED_EXERCISES } from './seed'
import {
  buildExportPayload,
  importPayload,
} from './repositories/exportImport'
import { normalizedExerciseName } from '../lib/exerciseName'
import type { Exercise } from './types'

const STOCK_SQUAT: Exercise = {
  id: 'squat-id',
  name: 'Barbell Back Squat',
  primaryMuscle: 'quads',
  secondaryMuscles: ['glutes', 'hamstrings'],
  notes: '',
  defaultRestSeconds: 210,
  isCustom: false,
  hiddenFromLibrary: false,
  createdAt: 1,
  normalizedName: normalizedExerciseName('Barbell Back Squat'),
}

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('seeded hamstring credit', () => {
  it('no longer credits squats, leg presses, or hip thrusts', () => {
    // Longitudinal measurement finds little or no hamstring growth from these
    // three, so listing the hamstrings overstated the work they represent.
    for (const name of [
      'Barbell Back Squat',
      'Leg Press',
      'Hip Thrust (Barbell)',
    ]) {
      const seeded = SEED_EXERCISES.find((item) => item.name === name)
      expect(seeded, name).toBeDefined()
      expect(seeded?.secondaryMuscles, name).not.toContain('hamstrings')
    }
  })

  it('leaves unmeasured movements alone rather than guessing', () => {
    // No direct evidence either way for these. Absence of a contradicting
    // study is not a reason to change the mapping — in either direction.
    for (const name of ['Walking Lunge', 'Sumo Deadlift']) {
      const seeded = SEED_EXERCISES.find((item) => item.name === name)
      expect(seeded?.secondaryMuscles, name).toContain('hamstrings')
    }
  })

  it('still credits the hamstrings where they are the primary mover', () => {
    const rdl = SEED_EXERCISES.find((item) => item.name === 'Romanian Deadlift')
    expect(rdl?.primaryMuscle).toBe('hamstrings')
  })
})

describe('correctedStockExercise', () => {
  it('corrects an untouched stock row', () => {
    expect(correctedStockExercise(STOCK_SQUAT)?.secondaryMuscles).toEqual([
      'glutes',
    ])
  })

  it('is idempotent', () => {
    const once = correctedStockExercise(STOCK_SQUAT)
    expect(once).not.toBeNull()
    expect(correctedStockExercise(once as Exercise)).toBeNull()
  })

  it('keeps a user-edited secondary list', () => {
    expect(
      correctedStockExercise({
        ...STOCK_SQUAT,
        secondaryMuscles: ['glutes', 'hamstrings', 'abs'],
      }),
    ).toBeNull()
  })

  it('keeps a user-edited primary muscle', () => {
    // Someone who re-pointed the exercise has a mapping of their own; the
    // stock correction has nothing to say about it.
    expect(
      correctedStockExercise({ ...STOCK_SQUAT, primaryMuscle: 'glutes' }),
    ).toBeNull()
  })

  it('never touches a custom exercise', () => {
    expect(correctedStockExercise({ ...STOCK_SQUAT, isCustom: true })).toBeNull()
  })

  it('ignores an unrelated exercise', () => {
    expect(
      correctedStockExercise({
        ...STOCK_SQUAT,
        name: 'Front Squat',
        normalizedName: normalizedExerciseName('Front Squat'),
      }),
    ).toBeNull()
  })

  it('matches the stock list regardless of muscle order', () => {
    expect(sameMuscleList(['hamstrings', 'glutes'], ['glutes', 'hamstrings'])).toBe(
      true,
    )
    expect(sameMuscleList(['glutes'], ['glutes', 'hamstrings'])).toBe(false)
    expect(sameMuscleList(undefined, [])).toBe(false)
  })
})

describe('version 7 to 8 upgrade', () => {
  it('corrects stock rows and preserves everything else', async () => {
    db.close()
    await Dexie.delete('workoutTracker')

    // A database as version 7 left it, with the pre-correction stock rows.
    const legacy = new Dexie('workoutTracker')
    legacy.version(7).stores({
      exercises: 'id, name, &normalizedName, primaryMuscle, isCustom',
      programs: 'id, isActive, archivedAt',
      sessionTemplates: 'id, programId, [programId+order]',
      templateExercises:
        'id, sessionTemplateId, exerciseId, [sessionTemplateId+order]',
      workoutSessions:
        'id, sessionTemplateId, programId, startedAt, completedAt',
      loggedSets:
        'id, workoutSessionId, exerciseId, [exerciseId+loggedAt], [workoutSessionId+exerciseId+setNumber]',
      recommendations: 'id, createdAt',
      aiMemorySettings: 'id',
      aiNotes: 'id, createdAt',
      aiMemorySummaries:
        'id, periodType, periodStartAt, periodEndAt, [periodType+periodStartAt]',
      dailyBriefings: 'briefingDate, createdAt',
      chatActionReceipts: 'proposalId, appliedAt',
      syncState: 'id',
    })
    await legacy.open()
    await legacy.table<Exercise, string>('exercises').bulkAdd([
      STOCK_SQUAT,
      {
        ...STOCK_SQUAT,
        id: 'press-id',
        name: 'Leg Press',
        normalizedName: normalizedExerciseName('Leg Press'),
        defaultRestSeconds: 180,
        notes: 'my own note',
      },
      {
        ...STOCK_SQUAT,
        id: 'edited-id',
        name: 'Hip Thrust (Barbell)',
        normalizedName: normalizedExerciseName('Hip Thrust (Barbell)'),
        primaryMuscle: 'glutes',
        // Deliberately kept by this user.
        secondaryMuscles: ['hamstrings', 'abs'],
      },
      {
        ...STOCK_SQUAT,
        id: 'custom-id',
        name: 'My Squat Variation',
        normalizedName: normalizedExerciseName('My Squat Variation'),
        isCustom: true,
      },
    ])
    await legacy.table('loggedSets').add({
      id: 'set-1',
      workoutSessionId: 'session-1',
      exerciseId: 'squat-id',
      setNumber: 1,
      weightLbs: 225,
      reps: 5,
      rpe: null,
      loggedAt: 10,
    })
    legacy.close()

    const { WorkoutDB } = await import('./schema')
    const upgraded = new WorkoutDB()
    await upgraded.open()
    const rows = await upgraded.exercises.toArray()
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get('squat-id')?.secondaryMuscles).toEqual(['glutes'])
    // Untouched fields, ids, and history survive the rewrite.
    expect(byId.get('press-id')?.secondaryMuscles).toEqual(['glutes'])
    expect(byId.get('press-id')?.notes).toBe('my own note')
    expect(byId.get('press-id')?.defaultRestSeconds).toBe(180)
    expect(await upgraded.loggedSets.count()).toBe(1)
    // The user's own mappings are left exactly as they were.
    expect(byId.get('edited-id')?.secondaryMuscles).toEqual([
      'hamstrings',
      'abs',
    ])
    expect(byId.get('custom-id')?.secondaryMuscles).toEqual([
      'glutes',
      'hamstrings',
    ])
    upgraded.close()

    await Dexie.delete('workoutTracker')
    await db.open()
  })
})

describe('legacy restore', () => {
  it('cannot reintroduce the old stock mapping', async () => {
    // Restore replaces the whole database, so a backup taken before the
    // correction would otherwise undo the one-time upgrade.
    await db.exercises.bulkAdd([STOCK_SQUAT])
    const payload = (await buildExportPayload()) as unknown as {
      data: { exercises: Exercise[] }
    }
    payload.data.exercises = [
      STOCK_SQUAT,
      {
        ...STOCK_SQUAT,
        id: 'kept-id',
        name: 'Leg Press',
        normalizedName: undefined,
        secondaryMuscles: ['glutes', 'hamstrings', 'calves'],
      },
    ]
    await importPayload(JSON.stringify(payload))
    const restored = await db.exercises.toArray()
    const byId = new Map(restored.map((row) => [row.id, row]))
    expect(byId.get('squat-id')?.secondaryMuscles).toEqual(['glutes'])
    // A customized row restores exactly as the user had it.
    expect(byId.get('kept-id')?.secondaryMuscles).toEqual([
      'glutes',
      'hamstrings',
      'calves',
    ])
  })
})

describe('correction table', () => {
  it('describes only the three evidenced corrections', () => {
    expect(HAMSTRING_CREDIT_CORRECTIONS.map((item) => item.name)).toEqual([
      'Barbell Back Squat',
      'Leg Press',
      'Hip Thrust (Barbell)',
    ])
    for (const correction of HAMSTRING_CREDIT_CORRECTIONS) {
      expect(correction.to).not.toContain('hamstrings')
      expect(correction.from).toContain('hamstrings')
    }
  })
})
