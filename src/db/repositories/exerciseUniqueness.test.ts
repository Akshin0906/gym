import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Dexie from 'dexie'
import { assignUniqueNormalizedNames, db } from '../schema'
import { normalizedExerciseName } from '../../lib/exerciseName'
import {
  createCustomExercise,
  findExerciseByName,
  updateExercise,
} from './exercises'
import { importPayload } from './exportImport'
import type { Exercise } from '../types'

const base = {
  primaryMuscle: 'shoulders' as const,
  secondaryMuscles: [],
  notes: '',
  defaultRestSeconds: 75,
  hiddenFromLibrary: false,
}

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('exercise name uniqueness', () => {
  it('lets only one of two simultaneous creates with the same name win', async () => {
    // The reproduced bug: both calls read "no duplicate" before either wrote.
    const results = await Promise.allSettled([
      createCustomExercise({ ...base, name: 'Cable Lateral Raise' }),
      createCustomExercise({ ...base, name: 'cable lateral raise' }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(await db.exercises.count()).toBe(1)
  })

  it('holds under a wider burst of concurrent creates', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        createCustomExercise({
          ...base,
          // Same normalized name, different surface spelling each time.
          name: index % 2 === 0 ? 'Pendlay  Row' : 'PENDLAY ROW',
        }),
      ),
    )

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await db.exercises.count()).toBe(1)
  })

  it('rejects a rename onto an existing normalized name', async () => {
    const first = await createCustomExercise({ ...base, name: 'Cable Row' })
    await createCustomExercise({ ...base, name: 'Barbell Row' })

    await expect(
      updateExercise(first, { ...base, name: 'barbell   row' }),
    ).rejects.toThrow('already exists')
    expect(await db.exercises.count()).toBe(2)
  })

  it('lets an exercise be renamed to a different casing of its own name', async () => {
    const id = await createCustomExercise({ ...base, name: 'Cable Row' })
    await updateExercise(id, { ...base, name: 'CABLE ROW' })
    expect((await db.exercises.get(id))?.name).toBe('CABLE ROW')
    expect((await db.exercises.get(id))?.normalizedName).toBe('cable row')
  })

  it('keeps the normalized index in step with concurrent renames', async () => {
    const first = await createCustomExercise({ ...base, name: 'Row A' })
    const second = await createCustomExercise({ ...base, name: 'Row B' })

    const results = await Promise.allSettled([
      updateExercise(first, { ...base, name: 'Shared Row' }),
      updateExercise(second, { ...base, name: 'shared row' }),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const names = (await db.exercises.toArray()).map((e) => e.normalizedName)
    expect(new Set(names).size).toBe(2)
  })

  it('finds an exercise regardless of case and spacing', async () => {
    await createCustomExercise({ ...base, name: 'Reverse  Pec Deck' })
    expect((await findExerciseByName('reverse pec deck'))?.name).toBe(
      'Reverse  Pec Deck',
    )
    expect(await findExerciseByName('Reverse Pec')).toBeUndefined()
  })

  it('does not fold punctuation, so distinct exercises stay distinct', async () => {
    await createCustomExercise({ ...base, name: 'Row (Left)' })
    await expect(
      createCustomExercise({ ...base, name: 'Row Left' }),
    ).resolves.toBeTypeOf('string')
    expect(await db.exercises.count()).toBe(2)
  })
})

describe('duplicate disambiguation', () => {
  it('renames later duplicates deterministically without dropping any row', () => {
    const rows: Exercise[] = [
      {
        id: 'a',
        name: 'Cable Row',
        ...base,
        isCustom: false,
        createdAt: 1,
      },
      { id: 'b', name: 'cable row', ...base, isCustom: false, createdAt: 2 },
      { id: 'c', name: 'CABLE ROW', ...base, isCustom: false, createdAt: 3 },
    ]

    const changed = assignUniqueNormalizedNames(rows)
    const byId = new Map(changed.map((row) => [row.id, row]))

    expect(byId.get('a')?.name).toBe('Cable Row')
    expect(byId.get('b')?.name).toBe('cable row (2)')
    // "(2)" is already taken by the previous row, so the suffix keeps counting
    // rather than colliding again.
    expect(byId.get('c')?.name).toBe('CABLE ROW (3)')
    // Every id survives; only the display name is disambiguated.
    expect(new Set(changed.map((r) => r.normalizedName)).size).toBe(3)
    expect(changed.map((r) => r.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('is stable when run twice', () => {
    const rows: Exercise[] = [
      { id: 'a', name: 'Row', ...base, isCustom: false, createdAt: 1 },
      { id: 'b', name: 'row', ...base, isCustom: false, createdAt: 2 },
    ]
    const first = assignUniqueNormalizedNames(rows)
    const merged = rows.map(
      (row) => first.find((changed) => changed.id === row.id) ?? row,
    )
    expect(assignUniqueNormalizedNames(merged)).toEqual([])
  })
})

describe('backup import with historical duplicates', () => {
  it('imports a legacy backup containing case-variant duplicates', async () => {
    const legacy = {
      schemaVersion: 1,
      exportedAt: 1,
      appVersion: 'legacy',
      data: {
        exercises: [
          {
            id: 'ex-1',
            name: 'Cable Lateral Raise',
            primaryMuscle: 'shoulders',
            secondaryMuscles: [],
            notes: '',
            defaultRestSeconds: 75,
            isCustom: false,
            hiddenFromLibrary: false,
            createdAt: 1,
          },
          {
            id: 'ex-2',
            name: 'cable lateral raise',
            primaryMuscle: 'shoulders',
            secondaryMuscles: [],
            notes: '',
            defaultRestSeconds: 75,
            isCustom: true,
            hiddenFromLibrary: false,
            createdAt: 2,
          },
        ],
        programs: [],
        sessionTemplates: [],
        templateExercises: [],
        workoutSessions: [
          {
            id: 'session-1',
            sessionTemplateId: null,
            programId: null,
            name: 'Push',
            programName: null,
            exerciseSnapshot: [],
            startedAt: 10,
            completedAt: 20,
          },
        ],
        loggedSets: [
          {
            id: 'set-1',
            workoutSessionId: 'session-1',
            exerciseId: 'ex-2',
            setNumber: 1,
            weightLbs: 20,
            reps: 12,
            rpe: 8,
            loggedAt: 15,
          },
        ],
      },
    }

    const result = await importPayload(JSON.stringify(legacy))

    expect(result.imported.exercises).toBe(2)
    expect(result.renamedExerciseCount).toBe(1)
    // Nothing is lost: both ids survive and the logged set still resolves.
    const stored = await db.exercises.toArray()
    expect(stored.map((row) => row.id).sort()).toEqual(['ex-1', 'ex-2'])
    expect(new Set(stored.map((row) => row.normalizedName)).size).toBe(2)
    const set = await db.loggedSets.get('set-1')
    expect(set?.exerciseId).toBe('ex-2')
    expect(await db.exercises.get('ex-2')).toMatchObject({
      name: 'cable lateral raise (2)',
    })
  })
})

describe('schema migration from a pre-index database', () => {
  const DB_NAME = 'workoutTracker-migration-fixture'

  afterEach(async () => {
    await Dexie.delete(DB_NAME)
  })

  it('backfills normalized names and disambiguates existing duplicates', async () => {
    // A fresh IndexedDB so the migration runs against a version-5 database
    // that predates the normalizedName index entirely.
    const factory = new IDBFactory()
    const legacy = new Dexie(DB_NAME, { indexedDB: factory })
    legacy.version(5).stores({
      exercises: 'id, name, primaryMuscle, isCustom',
      loggedSets: 'id, exerciseId',
    })
    await legacy.open()
    await legacy.table('exercises').bulkAdd([
      {
        id: 'ex-1',
        name: 'Cable Row',
        ...base,
        isCustom: false,
        createdAt: 1,
      },
      {
        id: 'ex-2',
        name: 'CABLE ROW',
        ...base,
        isCustom: true,
        createdAt: 2,
      },
    ])
    await legacy.table('loggedSets').add({ id: 'set-1', exerciseId: 'ex-2' })
    legacy.close()

    const upgraded = new Dexie(DB_NAME, { indexedDB: factory })
    upgraded.version(5).stores({
      exercises: 'id, name, primaryMuscle, isCustom',
      loggedSets: 'id, exerciseId',
    })
    upgraded
      .version(7)
      .stores({ exercises: 'id, name, &normalizedName, primaryMuscle, isCustom' })
      .upgrade(async (tx) => {
        const table = tx.table<Exercise, string>('exercises')
        for (const row of assignUniqueNormalizedNames(await table.toArray())) {
          await table.put(row)
        }
      })
    await upgraded.open()

    const rows = await upgraded.table<Exercise, string>('exercises').toArray()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.normalizedName)).size).toBe(2)
    expect(rows.find((r) => r.id === 'ex-1')?.name).toBe('Cable Row')
    expect(rows.find((r) => r.id === 'ex-2')?.name).toBe('CABLE ROW (2)')
    expect(rows.find((r) => r.id === 'ex-2')?.normalizedName).toBe(
      normalizedExerciseName('CABLE ROW (2)'),
    )
    // History survives the migration untouched.
    expect(await upgraded.table('loggedSets').get('set-1')).toMatchObject({
      exerciseId: 'ex-2',
    })
    upgraded.close()
  })
})
