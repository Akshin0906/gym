import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../schema'
import { createCustomExercise, updateExercise } from './exercises'

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('exercise muscle normalization', () => {
  it('removes duplicate secondaries and the primary muscle on write', async () => {
    const id = await createCustomExercise({
      name: 'Test Press',
      primaryMuscle: 'chest',
      secondaryMuscles: ['chest', 'triceps', 'triceps'],
      notes: '',
      defaultRestSeconds: 210,
      hiddenFromLibrary: false,
    })

    expect((await db.exercises.get(id))?.secondaryMuscles).toEqual(['triceps'])
  })

  it('does not report success when the exercise id is missing', async () => {
    await expect(
      updateExercise('missing', {
        name: 'Missing',
        primaryMuscle: 'back',
        secondaryMuscles: [],
        notes: '',
        defaultRestSeconds: 90,
        hiddenFromLibrary: false,
      }),
    ).rejects.toThrow('Exercise not found')
  })

  it('rejects timer defaults that cannot survive persistence', async () => {
    const base = {
      name: 'Invalid Timer Exercise',
      primaryMuscle: 'back' as const,
      secondaryMuscles: [],
      notes: '',
      hiddenFromLibrary: false,
    }
    await expect(
      createCustomExercise({ ...base, defaultRestSeconds: 3_601 }),
    ).rejects.toThrow('1 to 3600')
    await expect(
      createCustomExercise({ ...base, defaultRestSeconds: 90.5 }),
    ).rejects.toThrow('whole number')
  })
})
