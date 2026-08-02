import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './schema'
import { importPayload } from './repositories/exportImport'
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
