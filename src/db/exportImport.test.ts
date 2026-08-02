import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './schema'
import {
  buildExportPayload,
  importPayload,
} from './repositories/exportImport'
import {
  deleteSet,
  isResumable,
  restoreSet,
} from './repositories/sessions'
import type {
  DailyBriefing,
  Exercise,
  LoggedSet,
  ProgramRow,
} from './types'

function exercise(id: string): Exercise {
  return {
    id,
    name: id,
    primaryMuscle: 'chest',
    secondaryMuscles: [],
    notes: '',
    defaultRestSeconds: 90,
    isCustom: false,
    hiddenFromLibrary: false,
    createdAt: 0,
  }
}

function program(id: string): ProgramRow {
  return { id, name: id, isActive: 1, createdAt: 0, archivedAt: null }
}

function briefing(date: string): DailyBriefing {
  return {
    briefingDate: date,
    createdAt: 0,
    source: 'codex',
    snapshotUpdatedAt: 0,
    headline: 'Push the bench',
    mode: 'normal',
    sections: {
      todaysCall: 'Train chest',
      why: ['fresh'],
      ouraRecovery: 'Recovery data unavailable.',
      trainingTrend: 'Training is on track.',
      watchOuts: [],
    },
    model: 'codex',
    inputSummary: null,
  }
}

function loggedSet(
  id: string,
  setNumber: number,
  loggedAt: number,
): LoggedSet {
  return {
    id,
    workoutSessionId: 'sess',
    exerciseId: 'ex',
    setNumber,
    weightLbs: 100,
    reps: 8,
    rpe: null,
    loggedAt,
  }
}

async function clearAll() {
  await Promise.all(db.tables.map((t) => t.clear()))
}

beforeEach(clearAll)

describe('export/import round-trip', () => {
  it('includes every Dexie table in the export payload', async () => {
    const payload = await buildExportPayload()
    const exportedTables = Object.keys(payload.data)
    for (const table of db.tables) {
      expect(exportedTables).toContain(table.name)
    }
  })

  it('preserves dailyBriefings across a backup → restore round-trip', async () => {
    await db.exercises.add(exercise('ex'))
    await db.programs.add(program('p'))
    await db.dailyBriefings.add(briefing('2026-06-01'))

    const payload = await buildExportPayload()
    // The bug: dailyBriefings was absent from the export payload entirely.
    expect(payload.data.dailyBriefings).toHaveLength(1)
    expect(payload.data.dailyBriefings[0].briefingDate).toBe('2026-06-01')

    const json = JSON.stringify(payload)
    // Import clears every table first; a missing table here = permanent data loss.
    await importPayload(json)

    const restored = await db.dailyBriefings.toArray()
    expect(restored).toHaveLength(1)
    expect(restored[0].headline).toBe('Push the bench')
    expect(await db.exercises.count()).toBe(1)
    expect(await db.programs.count()).toBe(1)
  })

  it('round-trips an export from a file that predates dailyBriefings (v2)', async () => {
    // A legacy v2 file has no dailyBriefings key; import must not throw.
    const legacy = {
      schemaVersion: 2,
      exportedAt: 0,
      appVersion: '0.1.0',
      data: {
        exercises: [exercise('ex')],
        programs: [program('p')],
        sessionTemplates: [],
        templateExercises: [],
        workoutSessions: [],
        loggedSets: [],
      },
    }
    await importPayload(JSON.stringify(legacy))
    expect(await db.exercises.count()).toBe(1)
    expect(await db.dailyBriefings.count()).toBe(0)
  })

  it('preserves Coach action receipts so retries stay idempotent', async () => {
    await db.chatActionReceipts.add({
      proposalId: 'proposal-1',
      appliedAt: 123,
      sourceStateHash: 'state-hash',
      resultJson: '{"sessionId":"session-1"}',
    })

    const payload = await buildExportPayload()
    expect(payload.data.chatActionReceipts).toHaveLength(1)

    await importPayload(JSON.stringify(payload))
    expect(await db.chatActionReceipts.get('proposal-1')).toMatchObject({
      sourceStateHash: 'state-hash',
      resultJson: '{"sessionId":"session-1"}',
    })
  })
})

describe('isResumable (same local calendar day)', () => {
  const now = new Date(2026, 5, 21, 8, 0).getTime() // 8:00am

  it('does not resume a session from the previous calendar day', () => {
    const lastNight = new Date(2026, 5, 20, 23, 50).getTime() // 11:50pm prior day
    expect(isResumable(lastNight, now)).toBe(false)
  })

  it('resumes an earlier session from today', () => {
    const earlierToday = new Date(2026, 5, 21, 0, 1).getTime()
    expect(isResumable(earlierToday, now)).toBe(true)
  })

  it('does not resume a future timestamp', () => {
    const laterToday = new Date(2026, 5, 21, 9, 0).getTime()
    expect(isResumable(laterToday, now)).toBe(false)
  })
})

describe('restoreSet (undo delete)', () => {
  it('re-inserts a deleted set and renumbers the group densely by time', async () => {
    await db.loggedSets.bulkAdd([
      loggedSet('s1', 1, 100),
      loggedSet('s2', 2, 200),
      loggedSet('s3', 3, 300),
    ])

    const deleted = await db.loggedSets.get('s2')
    await deleteSet('s2')
    // After delete, remaining sets renumber to a dense 1..2.
    let nums = (await db.loggedSets.toArray())
      .sort((a, b) => a.loggedAt - b.loggedAt)
      .map((s) => s.setNumber)
    expect(nums).toEqual([1, 2])

    await restoreSet(deleted!)
    const all = (await db.loggedSets.toArray()).sort(
      (a, b) => a.loggedAt - b.loggedAt,
    )
    expect(all.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    nums = all.map((s) => s.setNumber)
    expect(nums).toEqual([1, 2, 3])
  })
})
