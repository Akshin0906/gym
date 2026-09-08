import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/schema'
import {
  getLocalSyncState,
  hasPendingLocalChanges,
} from '../db/repositories/syncState'
import { createCustomExercise } from '../db/repositories/exercises'
import { logSet, updateSet } from '../db/repositories/sessions'
import {
  COACH_RESERVATION_RETRY_MS,
  LOCAL_SYNC_DEBOUNCE_MS,
  LOCAL_SYNC_DRAIN_MS,
  startLocalSyncScheduler,
  syncPendingLocalChanges,
} from './cloud'

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

interface StubOptions {
  onPut?: () => void | Promise<void>
  putStatus?: () => number
}

function installCloudStub(options: StubOptions = {}) {
  const state = { updatedAt: 0, puts: 0 }
  let signalPutStarted: () => void = () => {}
  const putStarted = new Promise<void>((resolve) => {
    signalPutStarted = resolve
  })
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
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
        const status = options.putStatus?.() ?? 200
        if (status !== 200) {
          return jsonResponse({ error: 'server_error' }, status)
        }
        state.puts += 1
        state.updatedAt += 1000
        return jsonResponse({ snapshot: { updatedAt: state.updatedAt } })
      }
      if (url === '/api/auth/cloud') {
        return jsonResponse({ paired: true, device: null })
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    }),
  )
  return { state, putStarted }
}

async function seed(): Promise<{ sessionId: string; exerciseId: string; setId: string }> {
  const exerciseId = await createCustomExercise({
    name: 'Cable Lateral Raise',
    primaryMuscle: 'shoulders',
    secondaryMuscles: [],
    notes: '',
    defaultRestSeconds: 75,
    hiddenFromLibrary: false,
  })
  const sessionId = 'scheduler-session'
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

// Lets the scheduler's promise chain settle between timer advances.
//
// IndexedDB work runs on real event-loop turns, and setTimeout is faked here,
// so yielding through setImmediate is what actually lets a queued DB read or a
// stubbed fetch complete. Draining microtasks alone is not enough.
async function settle(turns = 40): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe('automatic sync scheduler', () => {
  let stop: (() => void) | null = null

  beforeEach(async () => {
    // Only the timers the scheduler uses. fake-indexeddb drives its own work
    // through setImmediate/microtasks, so faking those would deadlock the DB.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.stubGlobal('localStorage', new TestStorage())
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('navigator', { onLine: true })
    localStorage.setItem(AUTH_PAIRED_KEY, '1')
    await Promise.all(db.tables.map((t) => t.clear()))
  })

  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('drains work that arrived while an upload was already in flight', async () => {
    // The reported sequence. PUT A hangs; edit B lands and its debounce fires,
    // joining A rather than starting a second upload; A succeeds with B still
    // pending. Nothing used to schedule an attempt for B ever again, because a
    // success emits only a 'sync' event and the scheduler listens to mutations.
    const { setId } = await seed()
    let releaseA: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    let gateArmed = true
    const { state, putStarted } = installCloudStub({
      onPut: () => (gateArmed ? gate : undefined),
    })

    stop = startLocalSyncScheduler()

    const uploadA = syncPendingLocalChanges()
    await putStarted

    // B lands while A is open.
    await updateSet(setId, { reps: 15 })
    const pendingRevision = (await getLocalSyncState()).localRevision

    // B's debounce fires and joins the in-flight A.
    await vi.advanceTimersByTimeAsync(LOCAL_SYNC_DEBOUNCE_MS)
    await settle()

    gateArmed = false
    releaseA()
    await uploadA
    await settle()

    // A's payload predates B, so B is still pending — by design.
    expect((await getLocalSyncState()).syncedRevision).toBeLessThan(
      pendingRevision,
    )
    await expect(hasPendingLocalChanges()).resolves.toBe(true)

    // The drain pass is what must now pick it up, with no further user action.
    await vi.advanceTimersByTimeAsync(LOCAL_SYNC_DRAIN_MS)
    await settle()

    await expect(hasPendingLocalChanges()).resolves.toBe(false)
    expect(state.puts).toBe(2)
  })

  it('wakes at the backoff deadline after a transient server failure', async () => {
    const { setId } = await seed()
    let failing = true
    const { state } = installCloudStub({
      putStatus: () => (failing ? 503 : 200),
    })

    stop = startLocalSyncScheduler()
    await updateSet(setId, { reps: 11 })

    await vi.advanceTimersByTimeAsync(LOCAL_SYNC_DEBOUNCE_MS)
    await settle()

    const failed = await getLocalSyncState()
    expect(failed.failedAttempts).toBe(1)
    expect(failed.nextAutoAttemptAt).not.toBeNull()
    expect(state.puts).toBe(0)
    await expect(hasPendingLocalChanges()).resolves.toBe(true)

    // Still online, no user action: the scheduler must come back by itself.
    failing = false
    await vi.advanceTimersByTimeAsync(
      (failed.nextAutoAttemptAt ?? 0) - Date.now() + 1,
    )
    await settle()

    expect(state.puts).toBe(1)
    await expect(hasPendingLocalChanges()).resolves.toBe(false)
  })

  it('grows the retry interval instead of hammering a failing server', async () => {
    const { setId } = await seed()
    const { state } = installCloudStub({ putStatus: () => 503 })

    stop = startLocalSyncScheduler()
    await updateSet(setId, { reps: 11 })
    await vi.advanceTimersByTimeAsync(LOCAL_SYNC_DEBOUNCE_MS)
    await settle()

    const delays: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const state = await getLocalSyncState()
      const wait = (state.nextAutoAttemptAt ?? 0) - Date.now()
      delays.push(wait)
      await vi.advanceTimersByTimeAsync(wait + 1)
      await settle()
    }

    expect(delays[1]).toBeGreaterThan(delays[0])
    expect(delays[2]).toBeGreaterThan(delays[1])
    // One attempt per scheduled wake, not a storm.
    expect((await getLocalSyncState()).failedAttempts).toBe(4)
    expect(state.puts).toBe(0)
  })

  it('stops scheduling while offline and retries immediately on reconnect', async () => {
    const { setId } = await seed()
    const { state } = installCloudStub()

    stop = startLocalSyncScheduler()
    vi.stubGlobal('navigator', { onLine: false })
    await updateSet(setId, { reps: 13 })
    await vi.advanceTimersByTimeAsync(LOCAL_SYNC_DEBOUNCE_MS * 4)
    await settle()

    expect(state.puts).toBe(0)
    await expect(hasPendingLocalChanges()).resolves.toBe(true)

    vi.stubGlobal('navigator', { onLine: true })
    window.dispatchEvent(new Event('online'))
    await settle(20)

    expect(state.puts).toBe(1)
    await expect(hasPendingLocalChanges()).resolves.toBe(false)
  })

  it('re-checks on a fixed interval while a Coach reservation is open', async () => {
    const { setId } = await seed()
    const { state } = installCloudStub()
    await db.chatActionReceipts.add({
      proposalId: 'proposal-open',
      appliedAt: 5,
      sourceStateHash: 'a'.repeat(64),
      resultJson: JSON.stringify({
        proposalId: 'proposal-open',
        appliedAt: 5,
        sourceStateHash: 'a'.repeat(64),
        replayed: false,
        syncPending: true,
        changes: [{ type: 'save_ai_note', label: 'Saved a note' }],
      }),
    })

    stop = startLocalSyncScheduler()
    await updateSet(setId, { reps: 14 })
    await vi.advanceTimersByTimeAsync(LOCAL_SYNC_DEBOUNCE_MS)
    await settle()

    expect(state.puts).toBe(0)
    // No failure was recorded: waiting for a reservation is not an error.
    expect((await getLocalSyncState()).failedAttempts).toBe(0)

    // Reservation clears; the next scheduled re-check uploads.
    await db.chatActionReceipts.clear()
    await vi.advanceTimersByTimeAsync(COACH_RESERVATION_RETRY_MS + 1)
    await settle()

    expect(state.puts).toBe(1)
  })

  it('stops all timers once the scheduler is torn down', async () => {
    const { setId } = await seed()
    const { state } = installCloudStub()

    stop = startLocalSyncScheduler()
    await updateSet(setId, { reps: 12 })
    stop()
    stop = null

    await vi.advanceTimersByTimeAsync(LOCAL_SYNC_DEBOUNCE_MS * 10)
    await settle()

    expect(state.puts).toBe(0)
  })
})
