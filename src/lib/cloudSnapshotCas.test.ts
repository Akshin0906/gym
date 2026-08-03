import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildExportPayload,
  type ExportPayload,
} from '../db/repositories/exportImport'
import {
  getCloudSyncStatus,
  unpairCloudDevice,
  uploadCloudSnapshot,
} from './cloud'

vi.mock('../db/repositories/exportImport', () => ({
  buildExportPayload: vi.fn(),
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

function payload(exportedAt: number): ExportPayload {
  return {
    schemaVersion: 4,
    exportedAt,
    appVersion: 'test',
    data: {
      exercises: [],
      programs: [],
      sessionTemplates: [],
      templateExercises: [],
      workoutSessions: [],
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

describe('cloud snapshot version CAS', () => {
  const mockedBuildExportPayload = vi.mocked(buildExportPayload)
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
})
