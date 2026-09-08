import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/schema'
import {
  BACKOFF_MAX_MS,
  advanceAuthEpochIfCurrent,
  backoffDelayMs,
  getLocalSyncState,
  hasPendingLocalChanges,
  readSyncFence,
  recordSyncFailure,
  subscribeLocalMutations,
  subscribeLocalSyncState,
} from '../db/repositories/syncState'
import { createCustomExercise } from '../db/repositories/exercises'
import { createProgram, renameProgram } from '../db/repositories/programs'
import { addAiNote } from '../db/repositories/aiMemory'
import { upsertDailyBriefing } from '../db/repositories/dailyBriefings'
import { mergeCodexCloudMemory } from '../db/repositories/aiMemory'
import {
  deleteSession,
  deleteSet,
  logSet,
  updateSet,
} from '../db/repositories/sessions'
import {
  buildExportPayload,
  importPayload,
} from '../db/repositories/exportImport'
import {
  pairCloudDevice,
  recoverCloudSnapshot,
  syncPendingLocalChanges,
  unpairCloudDevice,
  uploadCloudSnapshot,
} from './cloud'
import type { CoachActionResult } from './chatTypes'

const AUTH_PAIRED_KEY = 'workout-tracker:cloudAuthPaired'

class TestStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// Minimal cloud stub: GET reports the current mirror version, PUT accepts and
// bumps it. Enough to exercise the CAS + revision watermark contract without a
// real backend or any production data.
function installCloudStub(options: { onPut?: () => void | Promise<void> } = {}) {
  const state = { updatedAt: 0, puts: 0 }
  // Resolves when a PUT handler is actually entered, so a test can be certain
  // the request is in flight before it changes state underneath it.
  let signalPutStarted: () => void = () => {}
  const putStarted = new Promise<void>((resolve) => {
    signalPutStarted = resolve
  })
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url === '/api/cloud/snapshot' && method === 'GET') {
      return state.updatedAt === 0
        ? jsonResponse({ error: 'snapshot_not_found' }, 404)
        : jsonResponse({ snapshot: { updatedAt: state.updatedAt } })
    }
    if (url === '/api/cloud/snapshot' && method === 'PUT') {
      signalPutStarted()
      await options.onPut?.()
      state.puts += 1
      state.updatedAt += 1000
      return jsonResponse({ snapshot: { updatedAt: state.updatedAt } })
    }
    if (url === '/api/auth/cloud' && method === 'DELETE') {
      return jsonResponse({ paired: false, device: null })
    }
    if (url === '/api/auth/cloud') {
      return jsonResponse({
        paired: true,
        device: {
          id: 'device-1',
          name: 'Phone',
          createdAt: 1,
          lastSeenAt: 1,
          expiresAt: 2,
        },
      })
    }
    return jsonResponse({ error: 'unexpected' }, 500)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { state, fetchMock, putStarted }
}

async function seedWorkoutWithOneSet(): Promise<{
  sessionId: string
  exerciseId: string
  setId: string
}> {
  const exerciseId = await createCustomExercise({
    name: 'Cable Lateral Raise',
    primaryMuscle: 'shoulders',
    secondaryMuscles: [],
    notes: '',
    defaultRestSeconds: 75,
    hiddenFromLibrary: false,
  })
  const sessionId = 'session-durable'
  await db.workoutSessions.add({
    id: sessionId,
    sessionTemplateId: null,
    programId: null,
    name: 'Pull',
    programName: null,
    exerciseSnapshot: [
      { exerciseId, order: 0, targetSets: 3, targetRepRange: '12-15' },
    ],
    startedAt: 1_000,
    completedAt: 2_000,
    preWorkoutCheckIn: null,
  })
  const logged = await logSet({
    sessionId,
    exerciseId,
    weightLbs: 20,
    reps: 12,
    rpe: 8,
  })
  return { sessionId, exerciseId, setId: logged.id }
}

async function clearAll() {
  await Promise.all(db.tables.map((t) => t.clear()))
}

describe('durable local sync revision', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', new TestStorage())
    // A real EventTarget so the mutation/sync event split can be observed.
    vi.stubGlobal('window', new EventTarget())
    localStorage.setItem(AUTH_PAIRED_KEY, '1')
    await clearAll()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks a corrected historical set as pending and uploads it', async () => {
    const { setId } = await seedWorkoutWithOneSet()
    const { state } = installCloudStub()

    // Baseline: get the mirror in step with the device.
    await expect(syncPendingLocalChanges()).resolves.toBe('uploaded')
    await expect(hasPendingLocalChanges()).resolves.toBe(false)
    await expect(syncPendingLocalChanges()).resolves.toBe('up_to_date')
    expect(state.puts).toBe(1)

    // The reproduced bug: correcting a historical set changes neither the
    // completed-workout count nor its timestamp, so the old comparison saw
    // nothing to do. The revision counter does.
    await updateSet(setId, { reps: 15 })

    await expect(hasPendingLocalChanges()).resolves.toBe(true)
    await expect(recoverCloudSnapshot()).resolves.toBe(true)
    expect(state.puts).toBe(2)
    await expect(hasPendingLocalChanges()).resolves.toBe(false)
  })

  it('treats deletions, program edits, and notes as pending work', async () => {
    const { sessionId, setId } = await seedWorkoutWithOneSet()
    installCloudStub()
    await syncPendingLocalChanges()

    await deleteSet(setId)
    await expect(hasPendingLocalChanges()).resolves.toBe(true)
    await syncPendingLocalChanges()

    await deleteSession(sessionId)
    await expect(hasPendingLocalChanges()).resolves.toBe(true)
    await syncPendingLocalChanges()

    const programId = await createProgram('Upper/Lower')
    await expect(hasPendingLocalChanges()).resolves.toBe(true)
    await syncPendingLocalChanges()

    await renameProgram(programId, 'Upper/Lower v2')
    await expect(hasPendingLocalChanges()).resolves.toBe(true)
    await syncPendingLocalChanges()

    await addAiNote('Left shoulder felt fine today.')
    await expect(hasPendingLocalChanges()).resolves.toBe(true)
    await expect(syncPendingLocalChanges()).resolves.toBe('uploaded')
    await expect(hasPendingLocalChanges()).resolves.toBe(false)
  })

  it('does not treat cloud-owned briefing and memory caching as local work', async () => {
    await seedWorkoutWithOneSet()
    installCloudStub()
    await syncPendingLocalChanges()
    const before = await getLocalSyncState()

    await upsertDailyBriefing({
      briefingDate: '2026-09-07',
      createdAt: 1,
      source: 'codex-local',
      snapshotUpdatedAt: 1,
      headline: 'Train as planned',
      mode: 'normal',
      sections: {
        todaysCall: 'Run the session as written.',
        why: [],
        ouraRecovery: '',
        trainingTrend: '',
        watchOuts: [],
      },
      model: 'gpt-5.6-sol',
      inputSummary: null,
    })
    await mergeCodexCloudMemory({
      state: {
        currentContext: 'context from the mirror',
        paused: false,
        windowStartedAt: 1,
        fourMonthStartedAt: 1,
      },
      summaries: [],
    })

    const after = await getLocalSyncState()
    expect(after.localRevision).toBe(before.localRevision)
    await expect(syncPendingLocalChanges()).resolves.toBe('up_to_date')
  })

  it('keeps an edit made during an upload pending after it completes', async () => {
    const { setId } = await seedWorkoutWithOneSet()
    let editDuringUpload: Promise<void> | null = null
    installCloudStub({
      onPut: () => {
        // Fires after the payload has been captured but before the mirror
        // acknowledges it, which is exactly the window that used to lose edits.
        editDuringUpload ??= updateSet(setId, { reps: 14 })
      },
    })

    await expect(syncPendingLocalChanges()).resolves.toBe('uploaded')
    await editDuringUpload

    const state = await getLocalSyncState()
    expect(state.localRevision).toBeGreaterThan(state.syncedRevision)
    await expect(hasPendingLocalChanges()).resolves.toBe(true)
    await expect(syncPendingLocalChanges()).resolves.toBe('uploaded')
    await expect(hasPendingLocalChanges()).resolves.toBe(false)
  })

  it('survives a reload and retries after an offline failure', async () => {
    const { setId } = await seedWorkoutWithOneSet()
    installCloudStub()
    await syncPendingLocalChanges()

    // Offline: the request rejects the way fetch does with no network.
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')),
    )
    await updateSet(setId, { weightLbs: 25 })
    await expect(syncPendingLocalChanges()).rejects.toThrow('Failed to fetch')

    const failed = await getLocalSyncState()
    expect(failed.lastSyncError).toContain('Failed to fetch')
    expect(failed.failedAttempts).toBeGreaterThan(0)

    // "Reload": the pending fact lives in IndexedDB, not in memory.
    db.close()
    await db.open()
    await expect(hasPendingLocalChanges()).resolves.toBe(true)

    const { state } = installCloudStub()
    await expect(syncPendingLocalChanges()).resolves.toBe('uploaded')
    expect(state.puts).toBe(1)
    await expect(hasPendingLocalChanges()).resolves.toBe(false)
    expect((await getLocalSyncState()).lastSyncError).toBeNull()
  })

  it('never uploads generically while a Coach action still owns a reservation', async () => {
    const { setId } = await seedWorkoutWithOneSet()
    const { state } = installCloudStub()
    await syncPendingLocalChanges()

    const result: CoachActionResult = {
      proposalId: 'proposal-reserved',
      appliedAt: 5,
      sourceStateHash: 'a'.repeat(64),
      replayed: false,
      syncPending: true,
      changes: [{ type: 'save_ai_note', label: 'Saved a note' }],
    }
    await db.chatActionReceipts.add({
      proposalId: result.proposalId,
      appliedAt: result.appliedAt,
      sourceStateHash: result.sourceStateHash,
      resultJson: JSON.stringify(result),
    })
    await updateSet(setId, { reps: 13 })

    await expect(syncPendingLocalChanges()).resolves.toBe(
      'deferred_coach_reservation',
    )
    expect(state.puts).toBe(1)
    await expect(recoverCloudSnapshot()).resolves.toBe(false)
    expect(state.puts).toBe(1)

    // The Coach's own reservation-aware upload is still allowed through.
    await expect(
      uploadCloudSnapshot('chat_action_applied'),
    ).resolves.toMatchObject({ updatedAt: expect.any(Number) })
    expect(state.puts).toBe(2)
  })

  it('fences the synced watermark when the device is signed out', async () => {
    await seedWorkoutWithOneSet()
    installCloudStub()
    await expect(syncPendingLocalChanges()).resolves.toBe('uploaded')
    await expect(hasPendingLocalChanges()).resolves.toBe(false)

    await unpairCloudDevice()

    const fenced = await getLocalSyncState()
    expect(fenced.syncedRevision).toBe(0)
    expect(fenced.lastSyncedAt).toBeNull()
    // Local data is untouched; only the claim about the mirror is dropped.
    expect(fenced.localRevision).toBeGreaterThan(0)
    await expect(hasPendingLocalChanges()).resolves.toBe(true)
    await expect(syncPendingLocalChanges()).resolves.toBe('not_paired')
  })

  it('marks a restored backup as pending so the mirror is repaired', async () => {
    await seedWorkoutWithOneSet()
    installCloudStub()
    await syncPendingLocalChanges()

    const { buildExportPayload } = await import(
      '../db/repositories/exportImport'
    )
    const before = await getLocalSyncState()
    const payload = await buildExportPayload()
    await importPayload(JSON.stringify(payload))

    const restored = await getLocalSyncState()
    // Monotonic across the restore rather than restarting at 1, and a new
    // dataset epoch, so an upload that was already in flight can neither
    // out-number nor be mistaken for this dataset.
    expect(restored.localRevision).toBeGreaterThan(before.localRevision)
    expect(restored.datasetEpoch).toBe(before.datasetEpoch + 1)
    expect(restored.syncedRevision).toBe(0)
    await expect(syncPendingLocalChanges()).resolves.toBe('uploaded')
  })

  it('waits rather than failing when the backend reports an active reservation', async () => {
    const { setId } = await seedWorkoutWithOneSet()
    installCloudStub()
    await syncPendingLocalChanges()
    await updateSet(setId, { reps: 12 })

    // The server-side fence with no local pending receipt: the reservation was
    // acquired but the receipt was never written.
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input)
        const method = (init?.method ?? 'GET').toUpperCase()
        if (url === '/api/cloud/snapshot' && method === 'GET') {
          return jsonResponse({ snapshot: { updatedAt: 5 } })
        }
        if (url === '/api/cloud/snapshot' && method === 'PUT') {
          return jsonResponse(
            { error: 'coach_action_reservation_required' },
            409,
          )
        }
        return jsonResponse({ error: 'unexpected' }, 500)
      }),
    )

    await expect(syncPendingLocalChanges()).resolves.toBe(
      'deferred_coach_reservation',
    )
    // Still pending, so a later trigger retries once the reservation clears.
    await expect(hasPendingLocalChanges()).resolves.toBe(true)
  })

  it('keeps a restored backup pending when an older upload resolves late', async () => {
    // Reproduces the reported loss: a PUT captured at the pre-import revision
    // resolves after a restore, and used to mark the freshly restored dataset
    // as mirrored because the watermark only compared revision numbers.
    const { setId } = await seedWorkoutWithOneSet()
    installCloudStub()
    await syncPendingLocalChanges()
    for (let i = 0; i < 8; i += 1) {
      await updateSet(setId, { reps: 10 + i })
    }
    const payload = await buildExportPayload()
    const beforeUpload = await getLocalSyncState()
    expect(beforeUpload.localRevision).toBeGreaterThan(8)

    let releasePut: () => void = () => {}
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve
    })
    const { state, putStarted } = installCloudStub({ onPut: () => putGate })

    const slowUpload = syncPendingLocalChanges()
    await putStarted

    // The restore lands while that PUT is still open.
    await importPayload(JSON.stringify(payload))
    const restored = await getLocalSyncState()
    expect(restored.datasetEpoch).toBe(beforeUpload.datasetEpoch + 1)

    releasePut()
    await slowUpload

    // The stale success is discarded: the restored dataset is still pending.
    const afterStaleReply = await getLocalSyncState()
    expect(afterStaleReply.syncedRevision).toBe(0)
    await expect(hasPendingLocalChanges()).resolves.toBe(true)

    // And it actually uploads on the next pass.
    await expect(syncPendingLocalChanges()).resolves.toBe('uploaded')
    await expect(hasPendingLocalChanges()).resolves.toBe(false)
    expect(state.puts).toBe(2)
  })

  it('discards an upload that resolves after logout and re-pairing', async () => {
    // Reproduces the reported loss: the watermark was reset on logout, then a
    // PUT from the old session resolved and restored a non-zero syncedRevision
    // against a mirror that had never received the data.
    const { setId } = await seedWorkoutWithOneSet()
    installCloudStub()
    await syncPendingLocalChanges()
    await updateSet(setId, { reps: 15 })

    let releasePut: () => void = () => {}
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve
    })
    const { putStarted } = installCloudStub({ onPut: () => putGate })
    const slowUpload = syncPendingLocalChanges()
    await putStarted

    await unpairCloudDevice()
    localStorage.setItem(AUTH_PAIRED_KEY, '1')
    await pairCloudDevice('secret', 'Phone')
    const afterPair = await getLocalSyncState()

    releasePut()
    await slowUpload

    const afterStaleReply = await getLocalSyncState()
    expect(afterStaleReply.syncedRevision).toBe(0)
    expect(afterStaleReply.authEpoch).toBe(afterPair.authEpoch)
    await expect(hasPendingLocalChanges()).resolves.toBe(true)
  })

  it('does not let a stale 401 unpair a newly paired session', async () => {
    await seedWorkoutWithOneSet()
    installCloudStub()
    await syncPendingLocalChanges()

    const staleFence = await readSyncFence()

    // A new pairing happens before the old request's 401 comes back.
    await pairCloudDevice('secret', 'Phone')
    const afterPair = await getLocalSyncState()
    expect(afterPair.authEpoch).toBeGreaterThan(staleFence.authEpoch)

    // The stale 401 must be ignored entirely.
    await expect(advanceAuthEpochIfCurrent(staleFence)).resolves.toBe(false)
    expect((await getLocalSyncState()).authEpoch).toBe(afterPair.authEpoch)

    // A 401 from the current session still fences it.
    await expect(
      advanceAuthEpochIfCurrent(await readSyncFence()),
    ).resolves.toBe(true)
    expect((await getLocalSyncState()).authEpoch).toBe(afterPair.authEpoch + 1)
  })

  it('backs the automatic scheduler off instead of retrying at a fixed rate', async () => {
    const { setId } = await seedWorkoutWithOneSet()
    installCloudStub()
    await syncPendingLocalChanges()
    await updateSet(setId, { reps: 9 })

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')),
    )

    await expect(
      syncPendingLocalChanges('manual', { respectBackoff: true }),
    ).rejects.toThrow('Failed to fetch')

    const first = await getLocalSyncState()
    expect(first.failedAttempts).toBe(1)
    expect(first.nextAutoAttemptAt).toBeGreaterThan(Date.now())

    // The scheduler's next tick is refused without touching the network.
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    await expect(
      syncPendingLocalChanges('manual', { respectBackoff: true }),
    ).resolves.toBe('backing_off')
    expect(fetchMock).not.toHaveBeenCalled()

    // Backoff grows rather than staying at a fixed interval.
    expect(backoffDelayMs(1)).toBeLessThan(backoffDelayMs(4))
    expect(backoffDelayMs(50)).toBe(BACKOFF_MAX_MS)

    // A manual or reconnect trigger stays responsive: it clears the backoff
    // and tries immediately.
    const { state } = installCloudStub()
    await expect(syncPendingLocalChanges('manual')).resolves.toBe('uploaded')
    expect(state.puts).toBe(1)
    const recovered = await getLocalSyncState()
    expect(recovered.failedAttempts).toBe(0)
    expect(recovered.nextAutoAttemptAt).toBeNull()
  })

  it('does not schedule a retry from recording a failure', async () => {
    // The feedback loop: recordSyncFailure used to emit the same event the
    // debounced scheduler listens on, so each failure booked the next attempt.
    await seedWorkoutWithOneSet()
    const mutations = vi.fn()
    const all = vi.fn()
    const stopMutations = subscribeLocalMutations(mutations)
    const stopAll = subscribeLocalSyncState(all)

    await recordSyncFailure('offline')

    expect(mutations).not.toHaveBeenCalled()
    // The UI still repaints, so status stays live.
    expect(all).toHaveBeenCalled()

    stopMutations()
    stopAll()
  })

  it('serialises concurrent manual, recovery, and workout triggers', async () => {
    const { setId } = await seedWorkoutWithOneSet()
    const { state } = installCloudStub()
    await syncPendingLocalChanges()
    await updateSet(setId, { reps: 12 })

    const outcomes = await Promise.all([
      syncPendingLocalChanges('manual'),
      recoverCloudSnapshot(),
      syncPendingLocalChanges('workout_completed'),
    ])

    // Exactly one upload for the three concurrent generic triggers.
    expect(state.puts).toBe(2)
    expect(outcomes[0]).toBe('uploaded')
    expect(outcomes[1]).toBe(true)
    expect(outcomes[2]).toBe('uploaded')
    await expect(hasPendingLocalChanges()).resolves.toBe(false)
  })

  it('routes a queued legacy marker through the reservation gate', async () => {
    const { setId } = await seedWorkoutWithOneSet()
    const { state } = installCloudStub()
    await syncPendingLocalChanges()

    // A Coach receipt is pending, and a legacy pending marker is queued.
    const result: CoachActionResult = {
      proposalId: 'proposal-legacy',
      appliedAt: 5,
      sourceStateHash: 'a'.repeat(64),
      replayed: false,
      syncPending: true,
      changes: [{ type: 'save_ai_note', label: 'Saved a note' }],
    }
    await db.chatActionReceipts.add({
      proposalId: result.proposalId,
      appliedAt: result.appliedAt,
      sourceStateHash: result.sourceStateHash,
      resultJson: JSON.stringify(result),
    })
    await updateSet(setId, { reps: 14 })
    localStorage.setItem(
      'workout-tracker:pendingCloudSnapshot',
      JSON.stringify({ id: 'queued', trigger: 'manual', queuedAt: 1 }),
    )

    // Previously this branch called uploadCloudSnapshot directly and published
    // straight through the reservation window.
    await expect(recoverCloudSnapshot()).resolves.toBe(false)
    expect(state.puts).toBe(1)
  })

  it('runs one upload at a time when several triggers fire together', async () => {
    const { setId } = await seedWorkoutWithOneSet()
    const { state } = installCloudStub()
    await syncPendingLocalChanges()
    await updateSet(setId, { reps: 11 })

    const outcomes = await Promise.all([
      syncPendingLocalChanges(),
      syncPendingLocalChanges(),
      syncPendingLocalChanges(),
    ])

    expect(outcomes).toEqual(['uploaded', 'uploaded', 'uploaded'])
    expect(state.puts).toBe(2)
    await expect(hasPendingLocalChanges()).resolves.toBe(false)
  })
})
