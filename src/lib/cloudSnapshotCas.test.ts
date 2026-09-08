import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildExportPayload,
  buildExportPayloadAtRevision,
  type ExportPayload,
} from '../db/repositories/exportImport'
import { listPendingCoachActionResults } from '../db/repositories/chatActions'
import {
  advanceAuthEpoch,
  advanceAuthEpochIfCurrent,
  clearAutoSyncBackoff,
  getLocalSyncState,
  isAutoSyncBackedOff,
  readSyncFence,
  recordSyncFailure,
  recordSyncSuccess,
} from '../db/repositories/syncState'
import {
  getCloudSyncStatus,
  hasPendingCloudSnapshotSync,
  installCloudBriefingRefresh,
  recoverCloudSnapshot,
  unpairCloudDevice,
  uploadCloudSnapshot,
} from './cloud'

vi.mock('../db/repositories/exportImport', () => ({
  buildExportPayload: vi.fn(),
  buildExportPayloadAtRevision: vi.fn(),
}))

vi.mock('../db/repositories/chatActions', () => ({
  listPendingCoachActionResults: vi.fn(),
}))

vi.mock('../db/repositories/syncState', () => ({
  advanceAuthEpoch: vi.fn(),
  advanceAuthEpochIfCurrent: vi.fn(),
  clearAutoSyncBackoff: vi.fn(),
  getLocalSyncState: vi.fn(),
  isAutoSyncBackedOff: vi.fn(),
  readSyncFence: vi.fn(),
  recordSyncFailure: vi.fn(),
  recordSyncSuccess: vi.fn(),
  subscribeLocalMutations: vi.fn(() => () => {}),
  subscribeLocalSyncState: vi.fn(() => () => {}),
}))

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

function payload(exportedAt: number, completedAt?: number): ExportPayload {
  return {
    schemaVersion: 4,
    exportedAt,
    appVersion: 'test',
    data: {
      exercises: [],
      programs: [],
      sessionTemplates: [],
      templateExercises: [],
      workoutSessions:
        completedAt === undefined
          ? []
          : [
              {
                id: `workout-${completedAt}`,
                sessionTemplateId: null,
                programId: null,
                name: 'Upper',
                programName: null,
                exerciseSnapshot: [],
                startedAt: completedAt,
                completedAt,
              },
            ],
      loggedSets: [],
      recommendations: [],
      dailyBriefings: [],
      aiMemorySettings: [],
      aiNotes: [],
      aiMemorySummaries: [],
      chatActionReceipts: [],
    },
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function requestHeaders(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined
  return new Headers(init?.headers)
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// The upload path captures the payload and the local revision together. Tests
// drive `buildExportPayload` and this shim keeps the captured revision in step,
// so revision bookkeeping is exercised rather than bypassed.
function revisionFromPayload(payload: ExportPayload): number {
  return payload.exportedAt
}

describe('cloud snapshot version CAS', () => {
  const mockedBuildExportPayload = vi.mocked(buildExportPayload)
  const mockedBuildAtRevision = vi.mocked(buildExportPayloadAtRevision)
  const mockedPendingCoachResults = vi.mocked(listPendingCoachActionResults)
  const mockedGetLocalSyncState = vi.mocked(getLocalSyncState)
  const mockedRecordSyncSuccess = vi.mocked(recordSyncSuccess)
  const mockedRecordSyncFailure = vi.mocked(recordSyncFailure)
  const mockedAdvanceAuthEpoch = vi.mocked(advanceAuthEpoch)
  const mockedAdvanceAuthEpochIfCurrent = vi.mocked(advanceAuthEpochIfCurrent)
  const mockedClearBackoff = vi.mocked(clearAutoSyncBackoff)
  const mockedIsBackedOff = vi.mocked(isAutoSyncBackedOff)
  const mockedReadSyncFence = vi.mocked(readSyncFence)
  let storage: TestStorage

  beforeEach(() => {
    storage = new TestStorage()
    storage.setItem(AUTH_PAIRED_KEY, '1')
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    mockedBuildExportPayload.mockReset()
    mockedBuildAtRevision.mockReset()
    mockedBuildAtRevision.mockImplementation(async () => {
      const payload = await mockedBuildExportPayload()
      return {
        payload,
        capturedRevision: revisionFromPayload(payload),
        fence: { datasetEpoch: 0, authEpoch: 0 },
      }
    })
    mockedPendingCoachResults.mockReset()
    mockedPendingCoachResults.mockResolvedValue([])
    mockedGetLocalSyncState.mockReset()
    mockedGetLocalSyncState.mockResolvedValue({
      id: 'local',
      // 0/0 models a device upgraded from a build with no revision counter,
      // which is exactly what the legacy recovery fallback exists for.
      localRevision: 0,
      syncedRevision: 0,
      lastMutationAt: null,
      lastSyncedAt: null,
      lastSyncedCloudUpdatedAt: null,
      lastSyncError: null,
      failedAttempts: 0,
      datasetEpoch: 0,
      authEpoch: 0,
      nextAutoAttemptAt: null,
    })
    mockedRecordSyncSuccess.mockReset()
    mockedRecordSyncSuccess.mockResolvedValue({
      applied: true,
      state: {
        id: 'local',
        localRevision: 0,
        syncedRevision: 0,
        lastMutationAt: null,
        lastSyncedAt: null,
        lastSyncedCloudUpdatedAt: null,
        lastSyncError: null,
        failedAttempts: 0,
        datasetEpoch: 0,
        authEpoch: 0,
        nextAutoAttemptAt: null,
      },
    })
    mockedRecordSyncFailure.mockReset()
    mockedRecordSyncFailure.mockResolvedValue(undefined)
    mockedAdvanceAuthEpoch.mockReset()
    mockedAdvanceAuthEpoch.mockResolvedValue(1)
    mockedAdvanceAuthEpochIfCurrent.mockReset()
    mockedAdvanceAuthEpochIfCurrent.mockResolvedValue(true)
    mockedClearBackoff.mockReset()
    mockedClearBackoff.mockResolvedValue(undefined)
    mockedIsBackedOff.mockReset()
    mockedIsBackedOff.mockResolvedValue(false)
    mockedReadSyncFence.mockReset()
    mockedReadSyncFence.mockResolvedValue({ datasetEpoch: 0, authEpoch: 0 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('gets a fresh base and rebuilds the payload after a version conflict', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    mockedBuildExportPayload
      .mockResolvedValueOnce(payload(1))
      .mockResolvedValueOnce(payload(2))
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'snapshot_not_found' }, 404))
      .mockResolvedValueOnce(
        jsonResponse({ error: 'snapshot_version_changed' }, 409),
      )
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 7 } }))
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 8 } }))

    await expect(uploadCloudSnapshot('chat_action_applied')).resolves.toEqual({
      updatedAt: 8,
    })

    expect(mockedBuildExportPayload).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/cloud/snapshot',
      '/api/cloud/snapshot',
      '/api/cloud/snapshot',
      '/api/cloud/snapshot',
    ])
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'include',
      cache: 'no-store',
    })
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      credentials: 'include',
      cache: 'no-store',
    })
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify(payload(1)),
    })
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify(payload(2)),
    })
    expect(requestHeaders(fetchMock, 1).get('X-Snapshot-Base-Updated-At')).toBe(
      'none',
    )
    expect(requestHeaders(fetchMock, 3).get('X-Snapshot-Base-Updated-At')).toBe(
      '7',
    )
    expect(requestHeaders(fetchMock, 3).get('X-Coach-Protocol')).toBe(
      'proposal-reservation-v1',
    )
    expect(requestHeaders(fetchMock, 3).get('X-Snapshot-Trigger')).toBe(
      'chat_action_applied',
    )
    expect(getCloudSyncStatus()).toMatchObject({
      lastSnapshotUpdatedAt: 8,
      lastSnapshotTrigger: 'chat_action_applied',
      lastSnapshotError: null,
    })
  })

  it.each([
    ['malformed conflict response', 409, 'not-json'],
    ['unrelated server failure', 500, JSON.stringify({ error: 'internal_error' })],
  ])('does not retry a %s', async (_, status, body) => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    mockedBuildExportPayload.mockResolvedValue(payload(1))
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 3 } }))
      .mockResolvedValueOnce(new Response(body, { status }))

    await expect(uploadCloudSnapshot('manual')).rejects.toThrow(
      `Cloud snapshot failed (${status})`,
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(mockedBuildExportPayload).toHaveBeenCalledTimes(1)
  })

  it('does not build or PUT after a malformed version response', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ snapshot: { updatedAt: 'not-a-number' } }),
    )

    await expect(uploadCloudSnapshot('manual')).rejects.toThrow(
      'Malformed cloud snapshot version response',
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mockedBuildExportPayload).not.toHaveBeenCalled()
  })

  it('bounds repeated version conflicts and rebuilds on every attempt', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    mockedBuildExportPayload
      .mockResolvedValueOnce(payload(1))
      .mockResolvedValueOnce(payload(2))
      .mockResolvedValueOnce(payload(3))
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 1 } }))
      .mockResolvedValueOnce(
        jsonResponse({ error: 'snapshot_version_changed' }, 409),
      )
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 2 } }))
      .mockResolvedValueOnce(
        jsonResponse({ error: 'snapshot_version_changed' }, 409),
      )
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 3 } }))
      .mockResolvedValueOnce(
        jsonResponse({ error: 'snapshot_version_changed' }, 409),
      )

    await expect(uploadCloudSnapshot('manual')).rejects.toThrow(
      'snapshot_version_changed',
    )

    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(mockedBuildExportPayload).toHaveBeenCalledTimes(3)
  })

  it('preserves authentication loss handling during the version read', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401))

    await expect(uploadCloudSnapshot('manual')).rejects.toThrow(
      'Cloud device is not paired',
    )

    expect(storage.getItem(AUTH_PAIRED_KEY)).toBeNull()
    expect(mockedBuildExportPayload).not.toHaveBeenCalled()
    expect(hasPendingCloudSnapshotSync()).toBe(true)
  })

  it('self-heals a valid server session when the cached pairing flag is missing', async () => {
    storage.removeItem(AUTH_PAIRED_KEY)
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    mockedBuildExportPayload.mockResolvedValue(payload(1))
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          paired: true,
          device: {
            id: 'phone',
            name: 'Phone PWA',
            createdAt: 1,
            lastSeenAt: 2,
            expiresAt: 3,
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 7 } }))
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 8 } }))

    await expect(uploadCloudSnapshot('workout_completed')).resolves.toEqual({
      updatedAt: 8,
    })

    expect(storage.getItem(AUTH_PAIRED_KEY)).toBe('1')
    expect(hasPendingCloudSnapshotSync()).toBe(false)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/auth/cloud',
      '/api/cloud/snapshot',
      '/api/cloud/snapshot',
    ])
  })

  it('keeps a failed workout snapshot pending and retries it later', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    mockedBuildExportPayload.mockResolvedValue(payload(1, 20))
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 7 } }))
      .mockResolvedValueOnce(
        jsonResponse({ error: 'temporary_failure' }, 500),
      )
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 7 } }))
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 8 } }))

    await expect(uploadCloudSnapshot('workout_completed')).rejects.toThrow(
      'Cloud snapshot failed (500)',
    )
    expect(hasPendingCloudSnapshotSync()).toBe(true)

    await expect(recoverCloudSnapshot()).resolves.toBe(true)

    expect(hasPendingCloudSnapshotSync()).toBe(false)
    expect(mockedBuildExportPayload).toHaveBeenCalledTimes(2)
  })

  it('recovers a newer local workout completed by an older app build', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    mockedBuildExportPayload.mockResolvedValue(payload(1, 200))
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          snapshot: {
            payload: {
              data: {
                workoutSessions: [{ id: 'older', completedAt: 100 }],
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 7 } }))
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 8 } }))

    await expect(recoverCloudSnapshot()).resolves.toBe(true)

    expect(mockedBuildExportPayload).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(hasPendingCloudSnapshotSync()).toBe(false)
  })

  it('does not overwrite a cloud mirror with a newer completed workout', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    mockedBuildExportPayload.mockResolvedValue(payload(1, 100))
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        snapshot: {
          payload: {
            data: {
              workoutSessions: [{ id: 'newer', completedAt: 200 }],
            },
          },
        },
      }),
    )

    await expect(recoverCloudSnapshot()).resolves.toBe(false)

    expect(mockedBuildExportPayload).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(hasPendingCloudSnapshotSync()).toBe(false)
  })

  it('keeps newer feedback durable and converges after an older upload wins', async () => {
    const firstPut = deferred<Response>()
    const secondPut = deferred<Response>()
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const beforeFeedback = payload(1, 200)
    const withFeedback = payload(2, 200)
    withFeedback.data.workoutSessions[0].postWorkoutFeedback = {
      version: 2,
      performance: 4,
      sessionRpe: 7,
      painImpact: 'none',
    }
    mockedBuildExportPayload
      .mockResolvedValueOnce(beforeFeedback)
      .mockResolvedValueOnce(withFeedback)
      .mockResolvedValueOnce(withFeedback)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 7 } }))
      .mockImplementationOnce(() => firstPut.promise)
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 7 } }))
      .mockImplementationOnce(() => secondPut.promise)
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 8 } }))
      .mockResolvedValueOnce(jsonResponse({ snapshot: { updatedAt: 9 } }))

    const first = uploadCloudSnapshot('workout_completed')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const second = uploadCloudSnapshot('workout_completed')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))

    firstPut.resolve(jsonResponse({ snapshot: { updatedAt: 8 } }))
    await expect(first).resolves.toEqual({ updatedAt: 8 })
    expect(hasPendingCloudSnapshotSync()).toBe(true)

    secondPut.resolve(
      jsonResponse({ error: 'snapshot_version_changed' }, 409),
    )
    await expect(second).resolves.toEqual({ updatedAt: 9 })
    expect(hasPendingCloudSnapshotSync()).toBe(false)
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify(beforeFeedback),
    })
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      body: JSON.stringify(withFeedback),
    })
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({
      body: JSON.stringify(withFeedback),
    })
  })

  it('keeps the local pairing active when sign-out is blocked by a reserved action', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'coach_action_reservation_active' }, 409),
    )

    await expect(unpairCloudDevice()).rejects.toThrow(
      'Cloud sign-out failed (409)',
    )

    expect(storage.getItem(AUTH_PAIRED_KEY)).toBe('1')
  })

  it('registers snapshot recovery for foreground and online transitions', () => {
    const addDocumentListener = vi.fn()
    const addWindowListener = vi.fn()
    vi.stubGlobal('document', {
      visibilityState: 'hidden',
      addEventListener: addDocumentListener,
    })
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      addEventListener: addWindowListener,
      removeEventListener: vi.fn(),
    })

    installCloudBriefingRefresh()

    expect(addDocumentListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    )
    expect(addWindowListener).toHaveBeenCalledWith(
      'focus',
      expect.any(Function),
    )
    expect(addWindowListener).toHaveBeenCalledWith(
      'online',
      expect.any(Function),
    )
  })
})
