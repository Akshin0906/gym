import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../schema'
import {
  addTemplateExercise,
  MAX_TARGET_SETS,
  updateTemplateExercise,
} from './programs'

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
  await db.programs.add({
    id: 'program',
    name: 'Program',
    isActive: 0,
    createdAt: 0,
    archivedAt: null,
  })
  await db.sessionTemplates.add({
    id: 'session',
    programId: 'program',
    name: 'Session',
    order: 0,
  })
})

describe('template exercise target bounds', () => {
  it('accepts the largest restorable target set count', async () => {
    const id = await addTemplateExercise({
      sessionTemplateId: 'session',
      exerciseId: 'exercise',
      targetSets: MAX_TARGET_SETS,
      targetRepRange: '8-12',
    })

    expect((await db.templateExercises.get(id))?.targetSets).toBe(
      MAX_TARGET_SETS,
    )
  })

  it.each([0, MAX_TARGET_SETS + 1, 1.5, Number.NaN])(
    'rejects a non-restorable target set count (%s)',
    async (targetSets) => {
      await expect(
        addTemplateExercise({
          sessionTemplateId: 'session',
          exerciseId: 'exercise',
          targetSets,
          targetRepRange: '8-12',
        }),
      ).rejects.toThrow('Target sets must be a whole number')
    },
  )

  it('rejects an out-of-range update without changing the stored target', async () => {
    const id = await addTemplateExercise({
      sessionTemplateId: 'session',
      exerciseId: 'exercise',
      targetSets: 3,
      targetRepRange: '8-12',
    })

    await expect(
      updateTemplateExercise(id, { targetSets: MAX_TARGET_SETS + 1 }),
    ).rejects.toThrow('Target sets must be a whole number')
    expect((await db.templateExercises.get(id))?.targetSets).toBe(3)
  })
})
