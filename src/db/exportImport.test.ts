import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './schema'
import {
  assertExportTableCoverage,
  buildExportPayload,
  importPayload,
} from './repositories/exportImport'
import {
  deleteSet,
  isResumable,
  restoreSet,
} from './repositories/sessions'
import type {
  ChatActionReceipt,
  DailyBriefing,
  Exercise,
  LoggedSet,
  ProgramRow,
} from './types'
import type { CoachActionResult } from '../lib/chatTypes'

const HASH = 'a'.repeat(64)
const ACTION_HASH = 'b'.repeat(64)
const CURRENT_EXPORT_TABLES = [
  'exercises',
  'programs',
  'sessionTemplates',
  'templateExercises',
  'workoutSessions',
  'loggedSets',
  'recommendations',
  'dailyBriefings',
  'aiMemorySettings',
  'aiNotes',
  'aiMemorySummaries',
  'chatActionReceipts',
] as const

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

function actionResult(
  proposalId = 'proposal-1',
  overrides: Partial<CoachActionResult> = {},
): CoachActionResult {
  return {
    proposalId,
    appliedAt: 123,
    sourceStateHash: HASH,
    sourceActionStateHash: ACTION_HASH,
    replayed: false,
    syncPending: true,
    changes: [
      {
        type: 'save_ai_note',
        label: 'Saved a note for AI Insights',
        entityId: 'note-1',
      },
    ],
    ...overrides,
  }
}

function actionReceipt(
  result = actionResult(),
  overrides: Partial<ChatActionReceipt> = {},
): ChatActionReceipt {
  return {
    proposalId: result.proposalId,
    appliedAt: result.appliedAt,
    sourceStateHash: result.sourceStateHash,
    resultJson: JSON.stringify(result),
    ...overrides,
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

  it('throws when a Dexie table is not wired into the export payload', () => {
    expect(() =>
      assertExportTableCoverage(
        ['exercises', 'futureTable'],
        { exercises: [] },
      ),
    ).toThrow('futureTable')
  })

  it('round-trips a historical workout with sparse exercise order values', async () => {
    await db.exercises.bulkAdd([exercise('ex-a'), exercise('ex-b')])
    await db.workoutSessions.add({
      id: 'session-sparse-history',
      sessionTemplateId: null,
      programId: null,
      name: 'Historical workout',
      programName: null,
      exerciseSnapshot: [
        {
          exerciseId: 'ex-a',
          order: 0,
          targetSets: 3,
          targetRepRange: '8-10',
        },
        {
          exerciseId: 'ex-b',
          order: 2,
          targetSets: 3,
          targetRepRange: '10-12',
        },
      ],
      startedAt: 1,
      completedAt: 2,
    })

    const payload = await buildExportPayload()
    expect(
      payload.data.workoutSessions[0].exerciseSnapshot.map((row) => row.order),
    ).toEqual([0, 2])

    await importPayload(JSON.stringify(payload))
    expect(
      (await db.workoutSessions.get('session-sparse-history'))?.exerciseSnapshot.map(
        (row) => row.order,
      ),
    ).toEqual([0, 2])
  })

  it('rejects duplicate exercise order values within a workout snapshot', async () => {
    await db.exercises.bulkAdd([exercise('ex-a'), exercise('ex-b')])
    await db.workoutSessions.add({
      id: 'session-duplicate-order',
      sessionTemplateId: null,
      programId: null,
      name: 'Malformed workout',
      programName: null,
      exerciseSnapshot: [
        {
          exerciseId: 'ex-a',
          order: 0,
          targetSets: 3,
          targetRepRange: '8-10',
        },
        {
          exerciseId: 'ex-b',
          order: 0,
          targetSets: 3,
          targetRepRange: '10-12',
        },
      ],
      startedAt: 1,
      completedAt: 2,
    })

    await expect(buildExportPayload()).rejects.toThrow(
      'Import table "workoutSessions" is missing or malformed',
    )
  })

  it('refuses to produce a backup containing a corrupt local receipt', async () => {
    await db.chatActionReceipts.add({
      proposalId: 'proposal-corrupt',
      appliedAt: 123,
      sourceStateHash: HASH,
      resultJson: '{',
    })

    await expect(buildExportPayload()).rejects.toThrow(
      'Import table "chatActionReceipts" is malformed',
    )
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
        recommendations: [],
        aiMemorySettings: [],
        aiNotes: [],
        aiMemorySummaries: [],
      },
    }
    await importPayload(JSON.stringify(legacy))
    expect(await db.exercises.count()).toBe(1)
    expect(await db.dailyBriefings.count()).toBe(0)
  })

  it('allows a v3 backup to omit receipts that were introduced in v4', async () => {
    const payload = await buildExportPayload()
    payload.schemaVersion = 3
    Reflect.deleteProperty(payload.data, 'chatActionReceipts')

    await expect(importPayload(JSON.stringify(payload))).resolves.toBeDefined()
    expect(await db.chatActionReceipts.count()).toBe(0)
  })

  it.each(CURRENT_EXPORT_TABLES)(
    'rejects a current backup missing %s before clearing local data',
    async (table) => {
      await db.exercises.add(exercise('keep'))
      const payload = await buildExportPayload()
      Reflect.deleteProperty(payload.data, table)

      await expect(importPayload(JSON.stringify(payload))).rejects.toThrow(
        `Import table "${table}" is missing for schemaVersion 4`,
      )
      expect(await db.exercises.get('keep')).toBeDefined()
    },
  )

  it('preserves Coach action receipts so retries stay idempotent', async () => {
    await db.chatActionReceipts.add(actionReceipt())

    const payload = await buildExportPayload()
    expect(payload.data.chatActionReceipts).toHaveLength(1)

    await importPayload(JSON.stringify(payload))
    expect(await db.chatActionReceipts.get('proposal-1')).toMatchObject({
      sourceStateHash: HASH,
      resultJson: JSON.stringify(actionResult()),
    })
  })

  it('accepts a validated legacy Coach receipt without a scoped hash', async () => {
    const legacyResult = actionResult('proposal-legacy')
    delete legacyResult.sourceActionStateHash
    const payload = await buildExportPayload()
    payload.data.chatActionReceipts = [actionReceipt(legacyResult)]

    await importPayload(JSON.stringify(payload))

    expect(await db.chatActionReceipts.get('proposal-legacy')).toMatchObject({
      proposalId: 'proposal-legacy',
      resultJson: JSON.stringify(legacyResult),
    })
  })

  it.each([
    ['malformed JSON', '{'],
    ['valid JSON with the wrong shape', JSON.stringify({ proposalId: 'proposal-1' })],
    ['an empty changes list', JSON.stringify(actionResult('proposal-1', { changes: [] }))],
    [
      'an uppercase action hash',
      JSON.stringify(
        actionResult('proposal-1', {
          sourceActionStateHash: ACTION_HASH.toUpperCase(),
        }),
      ),
    ],
    ['an oversized result', 'x'.repeat(70_000)],
  ])('rejects %s in a Coach receipt before replacing local data', async (_, resultJson) => {
    await db.exercises.add(exercise('keep'))
    const payload = await buildExportPayload()
    payload.data.exercises = [exercise('replacement')]
    payload.data.chatActionReceipts = [actionReceipt(actionResult(), { resultJson })]

    await expect(importPayload(JSON.stringify(payload))).rejects.toThrow(
      'Import table "chatActionReceipts" is malformed',
    )
    expect(await db.exercises.toArray()).toEqual([exercise('keep')])
  })

  it('rejects a Coach receipt whose row metadata does not match its result', async () => {
    await db.exercises.add(exercise('keep'))
    const payload = await buildExportPayload()
    payload.data.exercises = [exercise('replacement')]
    payload.data.chatActionReceipts = [
      actionReceipt(actionResult(), { proposalId: 'different-proposal' }),
    ]

    await expect(importPayload(JSON.stringify(payload))).rejects.toThrow(
      'Import table "chatActionReceipts" is malformed',
    )
    expect(await db.exercises.toArray()).toEqual([exercise('keep')])
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
