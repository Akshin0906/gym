import { describe, expect, it } from 'vitest'

import {
  isWithinPairAttemptLimit,
  onRequest as authOnRequest,
} from './auth/[[path]]'
import {
  assertBriefingSections,
  assertMemoryItem,
  assertMemoryState,
  isCalendarDate,
  MAX_BODY_BYTES,
  onRequest as cloudOnRequest,
  PayloadTooLargeError,
  readJsonBodyWithLimit,
} from './cloud/[[path]]'
import {
  trustedActionStateHash,
  validateActionPlan,
} from './chat/[[path]]'
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from '../lib/cloudAuth'
import type { CoachAction, CoachActionScope } from '../../src/lib/chatTypes'

class AtomicCounterDb implements D1Database {
  count = 0
  readonly queries: string[] = []

  prepare(query: string): D1PreparedStatement {
    this.queries.push(query)
    const db = this
    const statement: D1PreparedStatement = {
      bind: () => statement,
      async first<T>() {
        await Promise.resolve()
        db.count += 1
        return { attempt_count: db.count } as T
      },
      async all<T>() {
        return { results: [] as T[] }
      },
      async run() {
        return { success: true }
      },
    }
    return statement
  }

  async batch<T>(): Promise<D1Result<T>[]> {
    return []
  }
}

const failDb: D1Database = {
  prepare() {
    throw new Error('validation unexpectedly reached D1')
  },
  async batch() {
    throw new Error('validation unexpectedly reached D1')
  },
}

class AtomicPublishStatement implements D1PreparedStatement {
  readonly values: unknown[] = []

  constructor(
    readonly db: AtomicPublishDb,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values.splice(0, this.values.length, ...values)
    return this
  }

  async first<T = unknown>(): Promise<T | null> {
    return this.db.first(this.query, this.values) as T | null
  }

  async all<T = unknown>(): Promise<{ results?: T[] }> {
    return { results: this.db.all(this.query) as T[] }
  }

  async run(): Promise<D1Result> {
    throw new Error('atomic publish test unexpectedly called run()')
  }
}

class AtomicPublishDb implements D1Database {
  readonly writes: string[] = []
  batchCalls = 0
  memoryState: Record<string, unknown> | null = null
  readonly memoryItems = new Map<string, Record<string, unknown>>()
  readonly briefings = new Map<string, Record<string, unknown>>()
  readonly receipts = new Map<string, Record<string, unknown>>()
  publishToken = 'initial'
  publishFingerprint = 'initial'
  writeToken = 'initial'

  constructor(
    readonly snapshotUpdatedAt = 5,
    public revision = 0,
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new AtomicPublishStatement(this, query)
  }

  first(query: string, values: unknown[]): unknown | null {
    if (query.includes('FROM codex_publish_receipts')) {
      const receipt = this.receipts.get(String(values[0]))
      if (
        !receipt ||
        receipt.publish_fingerprint !== values[1] ||
        receipt.briefing_date !== values[2] ||
        receipt.expected_snapshot_updated_at !== values[3] ||
        receipt.base_memory_revision !== values[4]
      ) {
        return null
      }
      return receipt
    }
    if (query.includes('JOIN daily_briefings AS briefing')) {
      const briefing = this.briefings.get(String(values[0]))
      if (
        !briefing ||
        !this.memoryState ||
        values[3] !== this.publishToken ||
        values[4] !== this.publishFingerprint ||
        values[5] !== this.revision ||
        values[6] !== briefing.snapshot_updated_at ||
        values[7] !== this.memoryState.source_snapshot_updated_at
      ) {
        return null
      }
      return {
        revision: this.revision,
        publish_token: this.publishToken,
        publish_fingerprint: this.publishFingerprint,
        briefing_date: briefing.briefing_date,
        briefing_created_at: briefing.created_at,
        briefing_source: briefing.source,
        briefing_snapshot_updated_at: briefing.snapshot_updated_at,
        headline: briefing.headline,
        mode: briefing.mode,
        sections_json: briefing.sections_json,
        model: briefing.model,
        input_summary_json: briefing.input_summary_json,
        memory_updated_at: this.memoryState.updated_at,
        current_context: this.memoryState.current_context,
        paused: this.memoryState.paused,
        window_started_at: this.memoryState.window_started_at,
        four_month_started_at: this.memoryState.four_month_started_at,
        memory_snapshot_updated_at:
          this.memoryState.source_snapshot_updated_at,
      }
    }
    if (query.includes('FROM daily_briefings')) {
      return this.briefings.get(String(values[0])) ?? null
    }
    if (query.includes('FROM codex_memory_state')) return this.memoryState
    if (query.includes('FROM codex_publish_revision')) {
      return {
        revision: this.revision,
        publish_token: this.publishToken,
        write_token: this.writeToken,
      }
    }
    throw new Error(`unexpected atomic publish query: ${query}`)
  }

  all(query: string): unknown[] {
    if (query.includes('FROM codex_memory_items')) {
      return [...this.memoryItems.values()]
    }
    throw new Error(`unexpected atomic publish query: ${query}`)
  }

  async batch<T = unknown>(
    rawStatements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    this.batchCalls += 1
    const statements = rawStatements as AtomicPublishStatement[]
    const firstStatement = statements[0]
    if (
      statements.length === 3 &&
      firstStatement?.query.includes('FROM codex_memory_state')
    ) {
      return [
        { success: true, results: this.memoryState ? [this.memoryState] : [] },
        { success: true, results: [...this.memoryItems.values()] },
        {
          success: true,
          results: [
            {
              revision: this.revision,
              publish_token: this.publishToken,
              write_token: this.writeToken,
            },
          ],
        },
      ] as D1Result<T>[]
    }
    if (firstStatement?.query.includes('INSERT INTO codex_publish_revision')) {
      if (!firstStatement.query.includes('revision + 1')) {
        throw new Error('legacy memory mutation does not advance the revision')
      }
      this.publishToken = String(firstStatement.values[1])
      this.publishFingerprint = String(firstStatement.values[2])
      this.writeToken = String(firstStatement.values[3])
      this.revision += 1
      this.writes.push('revision')
      return statements.map(() => ({
        success: true,
        meta: { changes: 1 },
      }))
    }
    if (statements.length !== 6) {
      throw new Error(`expected six atomic statements, received ${statements.length}`)
    }
    const [revision, state, items, briefing, receipt, verification] = statements
    if (
      !revision.query.includes('revision = ?') ||
      !revision.query.includes('workout_snapshots')
    ) {
      throw new Error('revision compare-and-set guard is missing')
    }
    for (const statement of [state, items, briefing]) {
      if (
        !statement.query.includes('write_token = ?') ||
        !statement.query.includes('workout_snapshots')
      ) {
        throw new Error('atomic write guard is missing')
      }
    }
    const expectedRevision = revision.values[4]
    const expectedSnapshotUpdatedAt = revision.values[6]
    if (
      expectedRevision !== this.revision ||
      expectedSnapshotUpdatedAt !== this.snapshotUpdatedAt ||
      this.receipts.has(String(revision.values[7]))
    ) {
      const committed = this.first(verification.query, verification.values)
      return [
        ...statements.slice(0, 5).map(() => ({
          success: true,
          meta: { changes: 0 },
        })),
        { success: true, results: committed ? [committed] : [] },
      ] as D1Result<T>[]
    }

    const parsedItems = JSON.parse(String(items.values[0])) as Array<
      Record<string, unknown>
    >
    const nextState = {
      id: state.values[0],
      updated_at: state.values[1],
      current_context: state.values[2],
      paused: state.values[3],
      window_started_at: state.values[4],
      four_month_started_at: state.values[5],
      source_snapshot_updated_at: state.values[6],
    }
    const nextBriefing = {
      briefing_date: briefing.values[0],
      created_at: briefing.values[1],
      source: briefing.values[2],
      snapshot_updated_at: briefing.values[3],
      headline: briefing.values[4],
      mode: briefing.values[5],
      sections_json: briefing.values[6],
      model: briefing.values[7],
      input_summary_json: briefing.values[8],
    }

    this.publishToken = String(revision.values[0])
    this.publishFingerprint = String(revision.values[1])
    this.writeToken = String(revision.values[2])
    this.revision += 1
    this.memoryState = nextState
    for (const item of parsedItems) {
      this.memoryItems.set(String(item.id), item)
    }
    this.briefings.set(String(nextBriefing.briefing_date), nextBriefing)
    this.receipts.set(String(receipt.values[0]), {
      publish_id: receipt.values[0],
      publish_fingerprint: receipt.values[1],
      briefing_date: nextBriefing.briefing_date,
      expected_snapshot_updated_at: receipt.values[3],
      base_memory_revision: receipt.values[4],
      revision: this.revision,
      briefing_created_at: nextBriefing.created_at,
      briefing_source: nextBriefing.source,
      briefing_snapshot_updated_at: nextBriefing.snapshot_updated_at,
      headline: nextBriefing.headline,
      mode: nextBriefing.mode,
      sections_json: nextBriefing.sections_json,
      model: nextBriefing.model,
      input_summary_json: nextBriefing.input_summary_json,
      memory_updated_at: nextState.updated_at,
      current_context: nextState.current_context,
      paused: nextState.paused,
      window_started_at: nextState.window_started_at,
      four_month_started_at: nextState.four_month_started_at,
      memory_snapshot_updated_at: nextState.source_snapshot_updated_at,
    })
    this.writes.push(
      'revision',
      'memory-state',
      ...parsedItems.map((item) => `memory-item:${String(item.id)}`),
      'briefing',
      'receipt',
    )

    return [
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: parsedItems.length } },
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } },
      {
        success: true,
        results: [this.first(verification.query, verification.values)],
      },
    ] as D1Result<T>[]
  }
}

class ConcurrentReplayDb extends AtomicPublishDb {
  override async batch<T = unknown>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    const committedByOtherRequest = await super.batch<T>(statements)
    return committedByOtherRequest.map((result, index) =>
      index === 5
        ? result
        : { success: true, meta: { changes: 0 } },
    )
  }
}

class ImmediatelySupersededPublishDb extends AtomicPublishDb {
  override async batch<T = unknown>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    const committedResult = await super.batch<T>(statements)
    this.revision += 1
    this.publishToken = 'newer-publish'
    this.publishFingerprint = 'newer-fingerprint'
    return committedResult
  }
}

function automationRequest(path: string, payload: unknown): Request {
  return new Request(`https://gym.test/api/cloud/${path}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'X-Cloud-Automation-Secret': 'test-secret',
    },
    body: JSON.stringify(payload),
  })
}

function validMemoryItem(): Record<string, unknown> {
  return {
    id: 'workout:1',
    memoryType: 'workout',
    periodStartAt: 1,
    periodEndAt: 2,
    sourceWorkoutSessionId: 'session-1',
    bullets: [' Completed three sets. '],
    sourceSessionIds: ['session-1'],
    sourceNoteIds: [],
    sourceSummaryIds: [],
    model: 'gpt-test',
    createdAt: 3,
    updatedAt: 4,
    snapshotUpdatedAt: 5,
  }
}

function atomicPublishPayload(options: {
  stateSnapshotUpdatedAt?: number
  itemSnapshotUpdatedAt?: number
  briefingSnapshotUpdatedAt?: number
  mode?: string
} = {}): Record<string, unknown> {
  return {
    publishId: 'run-2026-08-01-1',
    expectedSnapshotUpdatedAt: 5,
    expectedMemoryRevision: 0,
    memory: {
      state: {
        currentContext: 'Current training block',
        paused: false,
        windowStartedAt: 1,
        fourMonthStartedAt: 2,
        sourceSnapshotUpdatedAt: options.stateSnapshotUpdatedAt ?? 5,
      },
      items: [
        {
          ...validMemoryItem(),
          snapshotUpdatedAt: options.itemSnapshotUpdatedAt ?? 5,
        },
      ],
    },
    briefing: {
      headline: 'Recover today',
      mode: options.mode ?? 'rest',
      snapshotUpdatedAt: options.briefingSnapshotUpdatedAt ?? 5,
      source: 'codex-local',
      sections: {
        todaysCall: 'Rest and recover.',
        why: ['Acute symptoms make training inappropriate.'],
        recoveryStatus: 'fresh',
        ouraRecovery: 'Recovery metrics are suppressed by symptoms.',
        trainingTrend: 'Training can resume after symptoms resolve.',
        watchOuts: ['Seek medical help for severe symptoms.'],
      },
      model: 'gpt-test',
      inputSummary: { recoveryStatus: 'fresh' },
    },
  }
}

describe('atomic pairing rate limit', () => {
  it('allows only the first five concurrent attempts', async () => {
    const db = new AtomicCounterDb()
    const request = new Request('https://gym.test/api/auth/cloud', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    })
    const results = await Promise.all(
      Array.from({ length: 12 }, () => isWithinPairAttemptLimit(db, request)),
    )

    expect(results.filter(Boolean)).toHaveLength(5)
    expect(results.filter((allowed) => !allowed)).toHaveLength(7)
    expect(db.queries.every((query) => query.includes('ON CONFLICT'))).toBe(true)
    expect(db.queries.every((query) => query.includes('RETURNING attempt_count'))).toBe(true)
  })

  it('rejects an array pairing body instead of treating it as an object', async () => {
    const db = new AtomicCounterDb()
    const response = await authOnRequest({
      request: new Request('https://gym.test/api/auth/cloud', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '[]',
      }),
      env: { CLOUD_PAIRING_SECRET: 'secret', WORKOUT_DB: db },
      params: { path: 'cloud' },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_pairing_request' })
  })
})

describe('snapshot byte limiting', () => {
  function streamedRequest(body: string): Request {
    const bytes = new TextEncoder().encode(body)
    const midpoint = Math.floor(bytes.byteLength / 2)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, midpoint))
        controller.enqueue(bytes.slice(midpoint))
        controller.close()
      },
    })
    const init: RequestInit & { duplex: 'half' } = {
      method: 'PUT',
      body: stream,
      duplex: 'half',
    }
    return new Request('https://gym.test/api/cloud/snapshot', init)
  }

  it('accepts a chunked JSON body exactly at the byte limit', async () => {
    expect(MAX_BODY_BYTES).toBe(1_900_000)
    await expect(readJsonBodyWithLimit(streamedRequest('"1234"'), 6)).resolves.toBe(
      '1234',
    )
  })

  it('rejects a chunked body that crosses the real byte limit', async () => {
    const request = streamedRequest('"12345"')
    expect(request.headers.get('content-length')).toBeNull()
    await expect(readJsonBodyWithLimit(request, 6)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    )
  })

  it('rejects an oversized declared length without consuming JSON', async () => {
    const request = new Request('https://gym.test/api/cloud/snapshot', {
      method: 'PUT',
      headers: { 'content-length': '7' },
      body: 'not json',
    })
    await expect(readJsonBodyWithLimit(request, 6)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    )
  })
})

describe('briefing validation', () => {
  it('recognizes real Gregorian calendar dates', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true)
    expect(isCalendarDate('2026-02-29')).toBe(false)
    expect(isCalendarDate('2026-13-40')).toBe(false)
    expect(isCalendarDate('2026-04-31')).toBe(false)
  })

  it('trims valid text without filtering invalid entries', () => {
    expect(
      JSON.parse(
        assertBriefingSections({
          todaysCall: ' Train ',
          why: [' Ready '],
          recoveryStatus: 'fresh',
          ouraRecovery: ' Good ',
          trainingTrend: ' Stable ',
          watchOuts: [],
        }),
      ),
    ).toEqual({
      todaysCall: 'Train',
      why: ['Ready'],
      recoveryStatus: 'fresh',
      ouraRecovery: 'Good',
      trainingTrend: 'Stable',
      watchOuts: [],
    })
    expect(() =>
      assertBriefingSections({
        todaysCall: 'Train',
        why: ['   '],
        ouraRecovery: 'Good',
        trainingTrend: 'Stable',
        watchOuts: [],
      }),
    ).toThrow('sections.why[0] must not be empty')
    expect(() =>
      assertBriefingSections({
        todaysCall: 'Train',
        why: ['Ready'],
        ouraRecovery: '   ',
        trainingTrend: 'Stable',
        watchOuts: [],
      }),
    ).toThrow('sections.ouraRecovery must not be empty')
  })

  it('rejects impossible dates and array request objects before D1', async () => {
    const invalidDate = await cloudOnRequest({
      request: automationRequest('briefing/2026-13-40', {}),
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: failDb },
      params: { path: ['briefing', '2026-13-40'] },
    })
    expect(invalidDate.status).toBe(400)
    expect(await invalidDate.json()).toEqual({ error: 'invalid_date' })

    const arrayBody = await cloudOnRequest({
      request: automationRequest('briefing/2026-08-01', []),
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: failDb },
      params: { path: ['briefing', '2026-08-01'] },
    })
    expect(arrayBody.status).toBe(400)
    expect(await arrayBody.json()).toEqual({ error: 'invalid_briefing' })
  })
})

describe('memory validation', () => {
  it('reads state, items, and revision from one transactional batch', async () => {
    const db = new AtomicPublishDb(5, 7)
    db.memoryState = {
      id: 'primary',
      updated_at: 9,
      current_context: 'Consistent context',
      paused: 0,
      window_started_at: 1,
      four_month_started_at: 2,
      source_snapshot_updated_at: 5,
    }
    db.memoryItems.set('workout:1', {
      id: 'workout:1',
      memory_type: 'workout',
      period_start_at: 1,
      period_end_at: 2,
      source_workout_session_id: 'session-1',
      bullets_json: '["Completed three sets."]',
      source_session_ids_json: '["session-1"]',
      source_note_ids_json: '[]',
      source_summary_ids_json: '[]',
      model: 'gpt-test',
      created_at: 3,
      updated_at: 4,
      snapshot_updated_at: 5,
    })
    const response = await cloudOnRequest({
      request: new Request('https://gym.test/api/cloud/memory', {
        headers: { 'X-Cloud-Automation-Secret': 'test-secret' },
      }),
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
      params: { path: 'memory' },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      revision: 7,
      state: { currentContext: 'Consistent context' },
      items: [{ id: 'workout:1' }],
    })
    expect(db.batchCalls).toBe(1)
    expect(db.writes).toEqual([])
  })

  it('accepts and trims a complete valid item and state', () => {
    expect(assertMemoryItem(validMemoryItem())).toMatchObject({
      id: 'workout:1',
      bullets: ['Completed three sets.'],
      createdAt: 3,
      updatedAt: 4,
      snapshotUpdatedAt: 5,
    })
    expect(
      assertMemoryState({
        currentContext: ' Context ',
        paused: false,
        windowStartedAt: 1,
        fourMonthStartedAt: 2,
        sourceSnapshotUpdatedAt: 3,
      }),
    ).toEqual({
      currentContext: 'Context',
      paused: false,
      windowStartedAt: 1,
      fourMonthStartedAt: 2,
      sourceSnapshotUpdatedAt: 3,
    })
  })

  it('rejects malformed present values rather than coercing or filtering', () => {
    expect(() =>
      assertMemoryItem({ ...validMemoryItem(), createdAt: 'now' }),
    ).toThrow('createdAt must be a non-negative safe integer')
    expect(() =>
      assertMemoryItem({
        ...validMemoryItem(),
        periodStartAt: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow('periodStartAt must be a non-negative safe integer')
    expect(() =>
      assertMemoryItem({ ...validMemoryItem(), updatedAt: 1.5 }),
    ).toThrow('updatedAt must be a non-negative safe integer')
    expect(() =>
      assertMemoryItem({ ...validMemoryItem(), snapshotUpdatedAt: '5' }),
    ).toThrow('snapshotUpdatedAt must be a non-negative safe integer')
    expect(() =>
      assertMemoryItem({
        ...validMemoryItem(),
        sourceSessionIds: ['session-1', 2],
      }),
    ).toThrow('sourceSessionIds[1] must be a string')
    expect(() =>
      assertMemoryItem({ ...validMemoryItem(), bullets: [''] }),
    ).toThrow('memory item bullets[0] must not be empty')
    expect(() =>
      assertMemoryState({
        currentContext: 7,
        paused: 'false',
        windowStartedAt: 1,
        fourMonthStartedAt: 2,
        sourceSnapshotUpdatedAt: null,
      }),
    ).toThrow('state.currentContext must be a string')
    expect(() =>
      assertMemoryState({
        currentContext: '',
        paused: 'false',
        windowStartedAt: 1,
        fourMonthStartedAt: 2,
        sourceSnapshotUpdatedAt: null,
      }),
    ).toThrow('state.paused must be a boolean')
  })

  it('rejects array and empty envelopes before D1', async () => {
    for (const payload of [[], {}]) {
      const response = await cloudOnRequest({
        request: automationRequest('memory', payload),
        env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: failDb },
        params: { path: 'memory' },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_memory' })
    }
  })

  it('advances the memory revision in the same batch as a legacy mutation', async () => {
    const db = new AtomicPublishDb()
    const response = await cloudOnRequest({
      request: automationRequest('memory', { items: [] }),
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
      params: { path: 'memory' },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ revision: 1 })
    expect(db.batchCalls).toBe(1)
    expect(db.writes).toEqual(['revision'])
  })
})

describe('atomic briefing publish', () => {
  it('accepts rest and stores memory plus briefing in one batch', async () => {
    const db = new AtomicPublishDb()
    const response = await cloudOnRequest({
      request: automationRequest(
        'publish/2026-08-01',
        atomicPublishPayload(),
      ),
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
      params: { path: ['publish', '2026-08-01'] },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      briefing: {
        briefingDate: '2026-08-01',
        headline: 'Recover today',
        mode: 'rest',
        snapshotUpdatedAt: 5,
      },
      memoryState: {
        currentContext: 'Current training block',
        sourceSnapshotUpdatedAt: 5,
      },
      memoryRevision: 1,
    })
    expect(db.batchCalls).toBe(1)
    expect(db.writes).toContain('revision')
    expect(db.writes).toContain('memory-state')
    expect(db.writes).toContain('memory-item:workout:1')
    expect(db.writes).toContain('briefing')
    expect(db.memoryItems.has('workout:1')).toBe(true)
  })

  it('returns an already committed publishId without writing again', async () => {
    const db = new AtomicPublishDb()
    const payload = atomicPublishPayload()
    const context = {
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
      params: { path: ['publish', '2026-08-01'] },
    }

    const first = await cloudOnRequest({
      request: automationRequest('publish/2026-08-01', payload),
      ...context,
    })
    expect(first.status).toBe(200)
    const firstBody = await first.json()
    const writesAfterFirstPublish = [...db.writes]

    const replay = await cloudOnRequest({
      request: automationRequest('publish/2026-08-01', payload),
      ...context,
    })

    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(firstBody)
    expect(db.batchCalls).toBe(1)
    expect(db.revision).toBe(1)
    expect(db.writes).toEqual(writesAfterFirstPublish)
  })

  it('replays a receipt after a later legacy memory PUT', async () => {
    const db = new AtomicPublishDb()
    const payload = atomicPublishPayload()
    const context = {
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
      params: { path: ['publish', '2026-08-01'] },
    }
    const first = await cloudOnRequest({
      request: automationRequest('publish/2026-08-01', payload),
      ...context,
    })
    const firstBody = await first.json()

    const memoryPut = await cloudOnRequest({
      request: automationRequest('memory', { items: [] }),
      env: context.env,
      params: { path: 'memory' },
    })
    expect(memoryPut.status).toBe(200)
    expect(db.revision).toBe(2)

    const replay = await cloudOnRequest({
      request: automationRequest('publish/2026-08-01', payload),
      ...context,
    })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(firstBody)
    expect(db.batchCalls).toBe(2)
  })

  it('rejects a publishId replay with different validated content', async () => {
    const db = new AtomicPublishDb()
    const firstPayload = atomicPublishPayload()
    const conflictingPayload = atomicPublishPayload()
    conflictingPayload.expectedMemoryRevision = 1
    ;(conflictingPayload.briefing as Record<string, unknown>).headline =
      'Different content under the same publish ID'
    const context = {
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
      params: { path: ['publish', '2026-08-01'] },
    }

    const first = await cloudOnRequest({
      request: automationRequest('publish/2026-08-01', firstPayload),
      ...context,
    })
    expect(first.status).toBe(200)
    const writesAfterFirstPublish = [...db.writes]

    const conflict = await cloudOnRequest({
      request: automationRequest('publish/2026-08-01', conflictingPayload),
      ...context,
    })

    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: 'stale_publish_state' })
    expect(db.revision).toBe(1)
    expect(db.writes).toEqual(writesAfterFirstPublish)
  })

  it('returns and durably replays its receipt after a newer mutation', async () => {
    const db = new ImmediatelySupersededPublishDb()
    const payload = atomicPublishPayload()
    const context = {
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
      params: { path: ['publish', '2026-08-01'] },
    }
    const response = await cloudOnRequest({
      request: automationRequest('publish/2026-08-01', payload),
      ...context,
    })

    expect(response.status).toBe(200)
    const firstBody = await response.json()
    expect(firstBody).toMatchObject({
      publishId: 'run-2026-08-01-1',
      briefing: { headline: 'Recover today' },
      memoryRevision: 1,
    })
    expect(db.publishToken).toBe('newer-publish')
    expect(db.revision).toBe(2)

    const replay = await cloudOnRequest({
      request: automationRequest('publish/2026-08-01', payload),
      ...context,
    })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(firstBody)
    expect(db.batchCalls).toBe(1)
  })

  it('returns the committed result when an identical request wins the CAS race', async () => {
    const db = new ConcurrentReplayDb()
    const response = await cloudOnRequest({
      request: automationRequest(
        'publish/2026-08-01',
        atomicPublishPayload(),
      ),
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
      params: { path: ['publish', '2026-08-01'] },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      briefing: { headline: 'Recover today', mode: 'rest' },
      memoryRevision: 1,
    })
    expect(db.batchCalls).toBe(1)
    expect(db.revision).toBe(1)
  })

  it('rejects malformed envelopes before preparing a batch', async () => {
    const malformedMemory = atomicPublishPayload()
    malformedMemory.memory = {
      ...(malformedMemory.memory as Record<string, unknown>),
      items: 'not-an-array',
    }
    const oversizedId = atomicPublishPayload()
    oversizedId.publishId = 'x'.repeat(201)

    for (const payload of [malformedMemory, oversizedId]) {
      const response = await cloudOnRequest({
        request: automationRequest('publish/2026-08-01', payload),
        env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: failDb },
        params: { path: ['publish', '2026-08-01'] },
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_publish' })
    }
  })

  it('rejects every internal snapshot timestamp mismatch before D1', async () => {
    const mismatches = [
      atomicPublishPayload({ stateSnapshotUpdatedAt: 6 }),
      atomicPublishPayload({ itemSnapshotUpdatedAt: 6 }),
      atomicPublishPayload({ briefingSnapshotUpdatedAt: 6 }),
    ]

    for (const payload of mismatches) {
      const response = await cloudOnRequest({
        request: automationRequest('publish/2026-08-01', payload),
        env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: failDb },
        params: { path: ['publish', '2026-08-01'] },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'publish_snapshot_mismatch',
      })
    }
  })

  it('makes zero writes when the cloud snapshot is stale', async () => {
    const db = new AtomicPublishDb(6, 0)
    const response = await cloudOnRequest({
      request: automationRequest(
        'publish/2026-08-01',
        atomicPublishPayload(),
      ),
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
      params: { path: ['publish', '2026-08-01'] },
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'stale_publish_state' })
    expect(db.batchCalls).toBe(1)
    expect(db.writes).toEqual([])
    expect(db.memoryState).toBeNull()
    expect(db.memoryItems.size).toBe(0)
    expect(db.briefings.size).toBe(0)
    expect(db.revision).toBe(0)
  })

  it('makes zero writes when the memory revision is stale', async () => {
    const db = new AtomicPublishDb(5, 1)
    const response = await cloudOnRequest({
      request: automationRequest(
        'publish/2026-08-01',
        atomicPublishPayload(),
      ),
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
      params: { path: ['publish', '2026-08-01'] },
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'stale_publish_state' })
    expect(db.batchCalls).toBe(1)
    expect(db.writes).toEqual([])
    expect(db.memoryState).toBeNull()
    expect(db.memoryItems.size).toBe(0)
    expect(db.briefings.size).toBe(0)
    expect(db.revision).toBe(1)
  })
})

describe('chat action-plan validation', () => {
  const plannedExercise = {
    exerciseId: 'exercise-1',
    targetSets: 3,
    repRange: '8-10',
  }
  const validPlan = {
    title: 'Save note',
    summary: 'Remember the constraint.',
    scope: 'ai_memory',
    actions: [{ type: 'save_ai_note', body: 'Avoid overhead pressing.' }],
  }

  const supportedActions: Array<
    [label: string, scope: CoachActionScope, action: CoachAction]
  > = [
    [
      'swap_active_exercise',
      'active_workout',
      {
        type: 'swap_active_exercise',
        sessionId: 'session-1',
        fromExerciseId: 'exercise-1',
        toExerciseId: 'exercise-2',
        targetSets: 3,
        repRange: '8-10',
      },
    ],
    [
      'add_active_exercise',
      'active_workout',
      {
        type: 'add_active_exercise',
        sessionId: 'session-1',
        exerciseId: 'exercise-1',
        position: 0,
        targetSets: 3,
        repRange: '8-10',
      },
    ],
    [
      'update_active_exercise_targets',
      'active_workout',
      {
        type: 'update_active_exercise_targets',
        sessionId: 'session-1',
        exerciseId: 'exercise-1',
        targetSets: 3,
        repRange: '8-10',
      },
    ],
    [
      'create_one_time_workout',
      'one_time_workout',
      {
        type: 'create_one_time_workout',
        name: 'Test workout',
        exercises: [plannedExercise],
      },
    ],
    [
      'create_session_template',
      'program',
      {
        type: 'create_session_template',
        programId: 'program-1',
        name: 'Push',
        exercises: [plannedExercise],
      },
    ],
    [
      'create_program',
      'program',
      {
        type: 'create_program',
        name: 'Test program',
        sessions: [{ name: 'Push', exercises: [plannedExercise] }],
      },
    ],
    [
      'rename_program',
      'program',
      { type: 'rename_program', programId: 'program-1', name: 'Renamed' },
    ],
    [
      'replace_program',
      'program',
      {
        type: 'replace_program',
        programId: 'program-1',
        name: 'Replacement',
        sessions: [
          {
            sessionTemplateId: 'session-template-1',
            name: 'Push',
            exercises: [plannedExercise],
          },
          {
            sessionTemplateId: null,
            name: 'Pull',
            exercises: [{ ...plannedExercise, exerciseId: 'exercise-2' }],
          },
        ],
      },
    ],
    [
      'archive_program',
      'program',
      { type: 'archive_program', programId: 'program-1' },
    ],
    [
      'replace_session_template',
      'program',
      {
        type: 'replace_session_template',
        sessionTemplateId: 'session-template-1',
        name: 'Updated Push',
        exercises: [plannedExercise],
      },
    ],
    [
      'delete_session_template',
      'program',
      {
        type: 'delete_session_template',
        sessionTemplateId: 'session-template-1',
      },
    ],
    [
      'create_custom_exercise',
      'exercise_library',
      {
        type: 'create_custom_exercise',
        name: 'Cable Y Raise',
        primaryMuscle: 'shoulders',
        secondaryMuscles: ['traps'],
        notes: '',
        defaultRestSeconds: 90,
      },
    ],
    [
      'save_ai_note',
      'ai_memory',
      { type: 'save_ai_note', body: 'Avoid overhead pressing.' },
    ],
  ]

  it.each(supportedActions)(
    'accepts and sanitizes the supported %s action',
    (_label, scope, action) => {
      const input = {
        title: 'Safe change',
        summary: 'Preview this exact change.',
        scope,
        sourceStateHash: 'f'.repeat(64),
        sourceActionStateHash: 'e'.repeat(64),
        ignored: true,
        actions: [{ ...action, ignored: true }],
      }
      expect(validateActionPlan(input)).toEqual({
        title: input.title,
        summary: input.summary,
        scope,
        actions: [action],
      })
    },
  )

  it('strips unknown nested fields while preserving the client contract', () => {
    const raw = {
      title: 'Replace program',
      summary: 'Replace the exact program structure.',
      scope: 'program',
      actions: [
        {
          type: 'replace_program',
          programId: 'program-1',
          name: 'Replacement',
          ignored: true,
          sessions: [
            {
              sessionTemplateId: null,
              name: 'Push',
              ignored: true,
              exercises: [{ ...plannedExercise, ignored: true }],
            },
          ],
        },
      ],
    }
    expect(validateActionPlan(raw)).toEqual({
      title: raw.title,
      summary: raw.summary,
      scope: raw.scope,
      actions: [
        {
          type: 'replace_program',
          programId: 'program-1',
          name: 'Replacement',
          sessions: [
            {
              sessionTemplateId: null,
              name: 'Push',
              exercises: [plannedExercise],
            },
          ],
        },
      ],
    })

    const createProgram = {
      title: 'Create program',
      summary: 'Create the exact program structure.',
      scope: 'program',
      actions: [
        {
          type: 'create_program',
          name: 'New program',
          sessions: [
            {
              name: 'Push',
              ignored: true,
              exercises: [{ ...plannedExercise, ignored: true }],
            },
          ],
        },
      ],
    }
    expect(validateActionPlan(createProgram)).toEqual({
      title: createProgram.title,
      summary: createProgram.summary,
      scope: createProgram.scope,
      actions: [
        {
          type: 'create_program',
          name: 'New program',
          sessions: [{ name: 'Push', exercises: [plannedExercise] }],
        },
      ],
    })
  })

  it('accepts exact client maxima and rejects the first values over them', () => {
    const boundaryAction = {
      type: 'update_active_exercise_targets',
      sessionId: 'session-1',
      exerciseId: 'exercise-1',
      targetSets: 20,
      repRange: '8-10',
    }
    const boundaryPlan = {
      title: 't'.repeat(120),
      summary: 's'.repeat(1000),
      scope: 'active_workout',
      actions: Array.from({ length: 12 }, () => ({ ...boundaryAction })),
    }
    expect(validateActionPlan(boundaryPlan)).toEqual(boundaryPlan)
    const validationDetail = (value: unknown): unknown => {
      try {
        validateActionPlan(value)
        return null
      } catch (error) {
        return (error as { detail?: unknown }).detail
      }
    }
    expect(
      validationDetail({ ...boundaryPlan, title: 't'.repeat(121) }),
    ).toBe('actionPlan.title is too long')
    expect(
      validationDetail({ ...boundaryPlan, summary: 's'.repeat(1001) }),
    ).toBe('actionPlan.summary is too long')
    expect(
      validationDetail({
        ...boundaryPlan,
        actions: [...boundaryPlan.actions, boundaryAction],
      }),
    ).toBe('actionPlan must contain 1 to 12 actions')
    expect(
      validationDetail({
        ...boundaryPlan,
        actions: [{ ...boundaryAction, targetSets: 21 }],
      }),
    ).toContain('targetSets must be a whole number from 1 to 20')
  })

  it('uses only the context-derived fingerprint for the selected scope', () => {
    const actionStateHashes = {
      active_workout: 'a'.repeat(64),
      one_time_workout: 'b'.repeat(64),
      program: 'c'.repeat(64),
      exercise_library: 'd'.repeat(64),
      ai_memory: 'e'.repeat(64),
    }
    const contextJson = JSON.stringify({ actionStateHashes })
    for (const [scope, expected] of Object.entries(actionStateHashes)) {
      expect(
        trustedActionStateHash(
          contextJson,
          scope as keyof typeof actionStateHashes,
        ),
      ).toBe(expected)
    }
    expect(() =>
      trustedActionStateHash(
        JSON.stringify({
          actionStateHashes: { ...actionStateHashes, program: 'not-a-hash' },
        }),
        'program',
      ),
    ).toThrow('action_state_hash_unavailable')
  })

  it.each([
    [
      'different active sessions',
      {
        title: 'Update workout',
        summary: 'Update two sessions.',
        scope: 'active_workout',
        actions: [
          {
            type: 'update_active_exercise_targets',
            sessionId: 'session-1',
            exerciseId: 'exercise-1',
            targetSets: 3,
            repRange: '8-10',
          },
          {
            type: 'update_active_exercise_targets',
            sessionId: 'session-2',
            exerciseId: 'exercise-2',
            targetSets: 3,
            repRange: '8-10',
          },
        ],
      },
    ],
    [
      'program action under exercise-library scope',
      {
        title: 'Wrong scope',
        summary: 'This scope does not match.',
        scope: 'exercise_library',
        actions: [{ type: 'archive_program', programId: 'program-1' }],
      },
    ],
    [
      'exercise-library action under program scope',
      {
        title: 'Wrong scope',
        summary: 'This scope does not match.',
        scope: 'program',
        actions: [
          {
            type: 'create_custom_exercise',
            name: 'Cable Y Raise',
            primaryMuscle: 'shoulders',
            secondaryMuscles: [],
            notes: '',
            defaultRestSeconds: 90,
          },
        ],
      },
    ],
    [
      'multiple program actions',
      {
        title: 'Too broad',
        summary: 'This changes two program entities.',
        scope: 'program',
        actions: [
          { type: 'archive_program', programId: 'program-1' },
          { type: 'archive_program', programId: 'program-2' },
        ],
      },
    ],
  ])('rejects invalid scope semantics: %s', (_label, plan) => {
    expect(() => validateActionPlan(plan)).toThrow()
  })

  it.each([
    [
      'duplicate replacement names',
      {
        type: 'replace_program',
        programId: 'program-1',
        name: 'Replacement',
        sessions: [
          {
            sessionTemplateId: 'session-template-1',
            name: 'Push',
            exercises: [plannedExercise],
          },
          {
            sessionTemplateId: 'session-template-2',
            name: 'push',
            exercises: [{ ...plannedExercise, exerciseId: 'exercise-2' }],
          },
        ],
      },
    ],
    [
      'duplicate replacement IDs',
      {
        type: 'replace_program',
        programId: 'program-1',
        name: 'Replacement',
        sessions: [
          {
            sessionTemplateId: 'session-template-1',
            name: 'Push',
            exercises: [plannedExercise],
          },
          {
            sessionTemplateId: 'session-template-1',
            name: 'Pull',
            exercises: [{ ...plannedExercise, exerciseId: 'exercise-2' }],
          },
        ],
      },
    ],
    [
      'missing replacement ID field',
      {
        type: 'replace_program',
        programId: 'program-1',
        name: 'Replacement',
        sessions: [
          { name: 'Push', exercises: [plannedExercise] },
        ],
      },
    ],
    [
      'unsupported muscle',
      {
        type: 'create_custom_exercise',
        name: 'Cable Y Raise',
        primaryMuscle: 'neck',
        secondaryMuscles: [],
        notes: '',
        defaultRestSeconds: 90,
      },
    ],
    [
      'primary repeated as secondary',
      {
        type: 'create_custom_exercise',
        name: 'Cable Y Raise',
        primaryMuscle: 'shoulders',
        secondaryMuscles: ['shoulders'],
        notes: '',
        defaultRestSeconds: 90,
      },
    ],
    [
      'duplicate secondary muscle',
      {
        type: 'create_custom_exercise',
        name: 'Cable Y Raise',
        primaryMuscle: 'shoulders',
        secondaryMuscles: ['traps', 'traps'],
        notes: '',
        defaultRestSeconds: 90,
      },
    ],
    [
      'rest duration below client minimum',
      {
        type: 'create_custom_exercise',
        name: 'Cable Y Raise',
        primaryMuscle: 'shoulders',
        secondaryMuscles: [],
        notes: '',
        defaultRestSeconds: 0,
      },
    ],
    [
      'oversized custom-exercise notes',
      {
        type: 'create_custom_exercise',
        name: 'Cable Y Raise',
        primaryMuscle: 'shoulders',
        secondaryMuscles: [],
        notes: 'x'.repeat(2001),
        defaultRestSeconds: 90,
      },
    ],
  ])('rejects malformed action payloads: %s', (_label, action) => {
    const scope = action.type === 'create_custom_exercise'
      ? 'exercise_library'
      : 'program'
    expect(() =>
      validateActionPlan({
        title: 'Malformed action',
        summary: 'This should not be persisted.',
        scope,
        actions: [action],
      }),
    ).toThrow()
  })

  it.each([
    ['array root', []],
    ['blank title', { ...validPlan, title: '  ' }],
    ['blank summary', { ...validPlan, summary: '' }],
    ['no actions', { ...validPlan, actions: [] }],
    [
      'blank action text',
      { ...validPlan, actions: [{ type: 'save_ai_note', body: '  ' }] },
    ],
    [
      'scope mismatch',
      { ...validPlan, scope: 'program' },
    ],
    [
      'invalid target',
      {
        title: 'Update',
        summary: 'Update target.',
        scope: 'active_workout',
        actions: [
          {
            type: 'update_active_exercise_targets',
            sessionId: 'session-1',
            exerciseId: 'exercise-1',
            targetSets: 0,
            repRange: '8-10',
          },
        ],
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(() => validateActionPlan(value)).toThrow()
  })
})
