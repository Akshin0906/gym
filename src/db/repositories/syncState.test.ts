import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../schema'
import {
  getLocalSyncState,
  mutateLocalData,
} from './syncState'
import { createCustomExercise, updateExercise } from './exercises'
import { normalizedExerciseName } from '../../lib/exerciseName'

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('local revision bumps exactly once per outermost mutation', () => {
  it('does not bump per nested layer', async () => {
    const before = (await getLocalSyncState()).localRevision

    await mutateLocalData([db.aiNotes], async () => {
      await db.aiNotes.add({ id: 'n1', body: 'a', createdAt: 1, updatedAt: 1 })
      // A repository function built from other repository functions.
      await mutateLocalData([db.aiNotes], async () => {
        await db.aiNotes.add({ id: 'n2', body: 'b', createdAt: 1, updatedAt: 1 })
        await mutateLocalData([db.aiNotes], async () => {
          await db.aiNotes.add({ id: 'n3', body: 'c', createdAt: 1, updatedAt: 1 })
        })
      })
    })

    expect((await getLocalSyncState()).localRevision).toBe(before + 1)
  })

  it('still bumps once per separate mutation', async () => {
    const before = (await getLocalSyncState()).localRevision
    await mutateLocalData([db.aiNotes], async () => {
      await db.aiNotes.add({ id: 'a', body: 'a', createdAt: 1, updatedAt: 1 })
    })
    await mutateLocalData([db.aiNotes], async () => {
      await db.aiNotes.add({ id: 'b', body: 'b', createdAt: 1, updatedAt: 1 })
    })
    expect((await getLocalSyncState()).localRevision).toBe(before + 2)
  })

  it('rolls the bump back with the transaction it belongs to', async () => {
    const before = (await getLocalSyncState()).localRevision
    await expect(
      mutateLocalData([db.aiNotes], async () => {
        await db.aiNotes.add({ id: 'x', body: 'x', createdAt: 1, updatedAt: 1 })
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')

    expect((await getLocalSyncState()).localRevision).toBe(before)
    expect(await db.aiNotes.get('x')).toBeUndefined()
  })
})

describe('normalized exercise name is always derived', () => {
  it('overwrites a normalizedName supplied directly in a patch', async () => {
    const id = await createCustomExercise({
      name: 'Cable Row',
      primaryMuscle: 'back',
      secondaryMuscles: [],
      notes: '',
      defaultRestSeconds: 90,
      hiddenFromLibrary: false,
    })

    // A caller that bypasses the repository must not be able to desynchronise
    // the uniqueness key from the name.
    await db.exercises.update(id, { normalizedName: 'something-else' })
    expect((await db.exercises.get(id))?.normalizedName).toBe(
      normalizedExerciseName('Cable Row'),
    )
  })

  it('derives the key from the effective name on any update', async () => {
    const id = await createCustomExercise({
      name: 'Cable Row',
      primaryMuscle: 'back',
      secondaryMuscles: [],
      notes: '',
      defaultRestSeconds: 90,
      hiddenFromLibrary: false,
    })

    await db.exercises.update(id, {
      name: 'Seated  CABLE Row',
      normalizedName: 'forged',
    })
    expect((await db.exercises.get(id))?.normalizedName).toBe('seated cable row')

    // And an unrelated patch leaves the derived key correct.
    await db.exercises.update(id, { notes: 'elbows tight' })
    expect((await db.exercises.get(id))?.normalizedName).toBe('seated cable row')
  })

  it('keeps the repository rename path consistent', async () => {
    const id = await createCustomExercise({
      name: 'Row A',
      primaryMuscle: 'back',
      secondaryMuscles: [],
      notes: '',
      defaultRestSeconds: 90,
      hiddenFromLibrary: false,
    })
    await updateExercise(id, {
      name: '  Row   B  ',
      primaryMuscle: 'back',
      secondaryMuscles: [],
      notes: '',
      defaultRestSeconds: 90,
      hiddenFromLibrary: false,
    })
    const row = await db.exercises.get(id)
    expect(row?.name).toBe('Row   B')
    expect(row?.normalizedName).toBe('row b')
  })
})
