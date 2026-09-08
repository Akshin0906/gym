import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeCodexCloudMemory } from '../db/repositories/aiMemory'
import { upsertDailyBriefing } from '../db/repositories/dailyBriefings'
import {
  fetchCloudUpdates,
  fetchLatestCloudBriefing,
  getCloudSyncStatus,
  subscribeCloudSyncStatus,
} from './cloud'

vi.mock('../db/repositories/aiMemory', () => ({
  mergeCodexCloudMemory: vi.fn(),
}))

vi.mock('../db/repositories/dailyBriefings', () => ({
  upsertDailyBriefing: vi.fn(),
}))

vi.mock('../db/repositories/exportImport', () => ({
  buildExportPayload: vi.fn(),
  buildExportPayloadAtRevision: vi.fn(),
}))

// The cloud layer captures the sync fence before each request so a 401 can only
// tear down the session that issued it. These tests are about briefing/memory
// refresh, so the fence is stubbed rather than backed by IndexedDB.
vi.mock('../db/repositories/syncState', () => ({
  advanceAuthEpoch: vi.fn(async () => 1),
  advanceAuthEpochIfCurrent: vi.fn(async () => true),
  clearAutoSyncBackoff: vi.fn(async () => {}),
  getLocalSyncState: vi.fn(),
  isAutoSyncBackedOff: vi.fn(async () => false),
  readSyncFence: vi.fn(async () => ({ datasetEpoch: 0, authEpoch: 0 })),
  recordSyncFailure: vi.fn(async () => {}),
  recordSyncSuccess: vi.fn(),
  subscribeLocalMutations: vi.fn(() => () => {}),
  subscribeLocalSyncState: vi.fn(() => () => {}),
}))

vi.mock('../db/repositories/chatActions', () => ({
  listPendingCoachActionResults: vi.fn(async () => []),
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function briefingResponse() {
  return {
    briefing: {
      briefingDate: '2026-09-02',
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
    },
  }
}

describe('cloud briefing refresh', () => {
  const mockedUpsertDailyBriefing = vi.mocked(upsertDailyBriefing)
  const mockedMergeCodexCloudMemory = vi.mocked(mergeCodexCloudMemory)
  let storage: TestStorage
  let eventTarget: EventTarget

  beforeEach(() => {
    storage = new TestStorage()
    storage.setItem(AUTH_PAIRED_KEY, '1')
    eventTarget = new EventTarget()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('window', eventTarget)
    mockedUpsertDailyBriefing.mockReset()
    mockedMergeCodexCloudMemory.mockReset()
    mockedMergeCodexCloudMemory.mockResolvedValue({ summariesAdded: 0 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('notifies subscribers only after the downloaded briefing is cached', async () => {
    const order: string[] = []
    mockedUpsertDailyBriefing.mockImplementation(async () => {
      order.push('cached')
    })
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(briefingResponse())),
    )
    const unsubscribe = subscribeCloudSyncStatus(() => {
      order.push('notified')
    })

    await expect(fetchLatestCloudBriefing()).resolves.toMatchObject({
      headline: 'Train as planned',
    })

    expect(order).toEqual(['cached', 'notified'])
    unsubscribe()
  })

  it('refreshes briefing and memory independently and retains briefing errors', async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = String(input)
      if (url === '/api/cloud/briefing/latest') {
        return Promise.resolve(jsonResponse({ error: 'temporary' }, 503))
      }
      if (url === '/api/cloud/memory') {
        return Promise.resolve(jsonResponse({ state: null, items: [] }))
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchCloudUpdates()).rejects.toThrow(
      'Cloud briefing fetch failed (503)',
    )

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/cloud/briefing/latest',
      '/api/cloud/memory',
    ])
    expect(mockedMergeCodexCloudMemory).toHaveBeenCalledOnce()
    expect(getCloudSyncStatus()).toMatchObject({
      lastBriefingError: 'Cloud briefing fetch failed (503): {"error":"temporary"}',
      lastMemoryError: null,
      lastMemorySummaryCount: 0,
    })
  })
})
