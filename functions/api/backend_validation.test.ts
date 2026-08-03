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
  assertCompleteActionStateHashes,
  completionHashInput,
  discardConversationThreadStatement,
  onRequest as chatOnRequest,
  trustedActionStateHash,
  trustedActionStateHashForPlan,
  validateActionPlan,
} from './chat/[[path]]'
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from '../lib/cloudAuth'
import { sha256Hex } from '../lib/cloudAuth'
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

class RecordingStatement implements D1PreparedStatement {
  readonly values: unknown[] = []

  constructor(readonly query: string) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values.splice(0, this.values.length, ...values)
    return this
  }

  async first<T>(): Promise<T | null> {
    return null
  }

  async all<T>(): Promise<{ results?: T[] }> {
    return { results: [] }
  }

  async run(): Promise<D1Result> {
    return { success: true, meta: { changes: 1 } }
  }
}

class RecordingDb implements D1Database {
  readonly statements: RecordingStatement[] = []

  prepare(query: string): D1PreparedStatement {
    const statement = new RecordingStatement(query)
    this.statements.push(statement)
    return statement
  }

  async batch<T>(): Promise<D1Result<T>[]> {
    return []
  }
}

class LostLeaseFailStatement implements D1PreparedStatement {
  readonly values: unknown[] = []

  constructor(
    readonly db: LostLeaseFailDb,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values.splice(0, this.values.length, ...values)
    return this
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes('FROM codex_chat_jobs')) {
      return { ...this.db.job } as T
    }
    return null
  }

  async all<T>(): Promise<{ results?: T[] }> {
    return { results: [] }
  }

  async run(): Promise<D1Result> {
    throw new Error('lost-lease test unexpectedly called run()')
  }
}

class LostLeaseFailDb implements D1Database {
  canonicalThreadId: string | null = 'thread-old'
  readonly batchStatements: LostLeaseFailStatement[] = []
  readonly job = {
    id: 'job-1',
    conversation_id: 'primary',
    user_message_id: 'message-1',
    assistant_message_id: null,
    context_id: 'context-1',
    reasoning_effort: 'medium',
    status: 'leased',
    attempts: 1,
    max_attempts: 3,
    available_at: 0,
    worker_id: 'worker-original',
    lease_token: 'lease-original',
    lease_expires_at: Date.now() + 60_000,
    claimed_at: Date.now(),
    completed_at: null,
    last_error: null,
    completion_hash: null,
    created_at: 1,
    updated_at: 1,
  }

  prepare(query: string): D1PreparedStatement {
    return new LostLeaseFailStatement(this, query)
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batchStatements.push(...(statements as LostLeaseFailStatement[]))

    // Simulate another worker taking ownership after readJob but before the
    // transactional failure update begins.
    this.job.worker_id = 'worker-new'
    this.job.lease_token = 'lease-new'

    return this.batchStatements.map((statement) => {
      let changes = 0
      if (statement.query.includes('SET codex_thread_id = NULL')) {
        const [, expectedThreadId, jobId, conversationId, status, marker] =
          statement.values
        if (
          this.canonicalThreadId === expectedThreadId &&
          this.job.id === jobId &&
          this.job.conversation_id === conversationId &&
          this.job.status === status &&
          this.job.worker_id === marker &&
          this.job.lease_token === null
        ) {
          this.canonicalThreadId = null
          changes = 1
        }
      }
      return { success: true, meta: { changes } }
    }) as D1Result<T>[]
  }
}

class ThreadCasStatement implements D1PreparedStatement {
  readonly values: unknown[] = []

  constructor(
    readonly db: ThreadCasDb,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values.splice(0, this.values.length, ...values)
    return this
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes('FROM codex_chat_conversations')) {
      return {
        id: 'primary',
        created_at: 1,
        updated_at: 1,
        codex_thread_id: this.db.threadId,
      } as T
    }
    return null
  }

  async all<T>(): Promise<{ results?: T[] }> {
    return { results: [] }
  }

  async run(): Promise<D1Result> {
    if (this.query.includes('SET codex_thread_id = NULL')) {
      const expected = this.values[2]
      if (this.db.threadId === expected) {
        this.db.threadId = null
        return { success: true, meta: { changes: 1 } }
      }
      return { success: true, meta: { changes: 0 } }
    }
    throw new Error('thread CAS test received an unexpected write')
  }
}

class ThreadCasDb implements D1Database {
  constructor(public threadId: string | null) {}

  prepare(query: string): D1PreparedStatement {
    return new ThreadCasStatement(this, query)
  }

  async batch<T>(): Promise<D1Result<T>[]> {
    throw new Error('thread CAS test unexpectedly called batch()')
  }
}

class HeartbeatMigrationStatement implements D1PreparedStatement {
  readonly values: unknown[] = []

  constructor(
    readonly db: HeartbeatMigrationDb,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values.splice(0, this.values.length, ...values)
    return this
  }

  async first<T>(): Promise<T | null> {
    return null
  }

  async all<T>(): Promise<{ results?: T[] }> {
    return { results: [] }
  }

  async run(): Promise<D1Result> {
    throw new Error('heartbeat migration test unexpectedly called run()')
  }
}

class HeartbeatMigrationDb implements D1Database {
  threadId: string | null = 'thread-v13'
  bridgeVersion: string | null = '1.3'
  threadMigrationCompletedAt: number | null = null
  readonly transcript = ['user', 'assistant']
  readonly queries: string[] = []

  prepare(query: string): D1PreparedStatement {
    this.queries.push(query)
    return new HeartbeatMigrationStatement(this, query)
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const [migration, marker, heartbeat] =
      statements as HeartbeatMigrationStatement[]
    const markerWasPending = this.threadMigrationCompletedAt === null
    let migrationChanges = 0
    if (
      migration.query.includes('SET codex_thread_id = NULL') &&
      migration.query.includes('bridge_v14_thread_detached_at IS NULL') &&
      migration.values[2] === '1.4' &&
      markerWasPending &&
      this.threadId !== null
    ) {
      this.threadId = null
      migrationChanges = 1
    }

    let markerChanges = 0
    if (
      marker.query.includes('UPDATE codex_chat_maintenance') &&
      marker.query.includes('SET bridge_v14_thread_detached_at = ?') &&
      marker.values[2] === '1.4' &&
      markerWasPending
    ) {
      this.threadMigrationCompletedAt = Number(marker.values[0])
      markerChanges = 1
    }

    const incomingVersion = heartbeat.values[3] as string | null
    if (!(
      this.bridgeVersion === '1.4' &&
      (incomingVersion === null || incomingVersion === '1.3')
    )) {
      this.bridgeVersion = incomingVersion
    }
    return [
      { success: true, meta: { changes: migrationChanges } },
      { success: true, meta: { changes: markerChanges } },
      { success: true, meta: { changes: 1 } },
    ] as D1Result<T>[]
  }
}

class LegacyReplayStatement implements D1PreparedStatement {
  readonly values: unknown[] = []

  constructor(
    readonly db: LegacyReplayDb,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values.splice(0, this.values.length, ...values)
    return this
  }

  async first<T>(): Promise<T | null> {
    const now = Date.now()
    if (this.query.includes('FROM cloud_auth_sessions')) {
      return {
        id: 'session-1',
        token_hash: 'unused',
        device_name: 'Legacy phone',
        created_at: 1,
        last_seen_at: now,
        expires_at: now + 60_000,
        revoked_at: null,
        user_agent: null,
      } as T
    }
    if (this.query.includes('JOIN codex_chat_contexts')) {
      return {
        sequence: 1,
        id: 'message-1',
        conversation_id: 'primary',
        role: 'user',
        text: this.db.text,
        client_message_id: this.db.clientMessageId,
        reasoning_effort: 'medium',
        model: null,
        created_at: 1,
        job_id: 'job-1',
        job_status: 'queued',
        state_hash: this.db.stateHash,
        context_json: this.db.contextJson,
      } as T
    }
    if (this.query.includes('FROM codex_chat_jobs')) {
      return { ...this.db.job } as T
    }
    return null
  }

  async all<T>(): Promise<{ results?: T[] }> {
    return { results: [] }
  }

  async run(): Promise<D1Result> {
    this.db.writeCount += 1
    return { success: true, meta: { changes: 1 } }
  }
}

class LegacyReplayDb implements D1Database {
  readonly clientMessageId = 'legacy-message-1'
  readonly text = 'Exact legacy retry'
  readonly stateHash = 'a'.repeat(64)
  readonly context = { legacyContext: true }
  readonly contextJson = JSON.stringify(this.context)
  writeCount = 0
  readonly job = {
    id: 'job-1',
    conversation_id: 'primary',
    user_message_id: 'message-1',
    assistant_message_id: null,
    context_id: 'context-1',
    reasoning_effort: 'medium',
    status: 'queued',
    attempts: 0,
    max_attempts: 3,
    available_at: 1,
    worker_id: null,
    lease_token: null,
    lease_expires_at: null,
    claimed_at: null,
    completed_at: null,
    last_error: null,
    completion_hash: null,
    created_at: 1,
    updated_at: 1,
  }

  prepare(query: string): D1PreparedStatement {
    return new LegacyReplayStatement(this, query)
  }

  async batch<T>(): Promise<D1Result<T>[]> {
    this.writeCount += 1
    return []
  }
}

type ProtocolProposalStatus = 'proposed' | 'applied' | 'failed' | 'dismissed'

interface ProtocolProposalRow {
  id: string
  conversation_id: string
  job_id: string
  assistant_message_id: string
  status: ProtocolProposalStatus
  action_plan_json: string
  result_json: string | null
  created_at: number
  updated_at: number
  state_hash: string
}

class ProposalProtocolStatement implements D1PreparedStatement {
  readonly values: unknown[] = []

  constructor(
    readonly db: ProposalProtocolDb,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values.splice(0, this.values.length, ...values)
    return this
  }

  async first<T>(): Promise<T | null> {
    return this.db.first(this.query, this.values) as T | null
  }

  async all<T>(): Promise<{ results?: T[] }> {
    return { results: this.db.all(this.query) as T[] }
  }

  async run(): Promise<D1Result> {
    return this.db.run(this.query, this.values)
  }
}

class ProposalProtocolDb implements D1Database {
  readonly queries: string[] = []
  conversationExists = true
  finalizeReservationAfterBlockedClear = false
  revokeSessionBeforeReserve = false
  readonly revokedSessionIds = new Set<string>()
  snapshotPayload: unknown | null = null
  readonly actionPlan = {
    title: 'Remember week one',
    summary: 'Save the confirmed start date.',
    scope: 'ai_memory',
    sourceStateHash: 'a'.repeat(64),
    sourceActionStateHash: 'b'.repeat(64),
    actions: [{ type: 'save_ai_note', body: 'Week 1 starts August 3, 2026.' }],
  }
  readonly proposals: ProtocolProposalRow[] = [
    {
      id: 'proposal-1',
      conversation_id: 'primary',
      job_id: 'job-1',
      assistant_message_id: 'message-1',
      status: 'proposed',
      action_plan_json: JSON.stringify(this.actionPlan),
      result_json: null,
      created_at: 10,
      updated_at: 20,
      state_hash: 'a'.repeat(64),
    },
  ]

  constructor(readonly sessionsByTokenHash: Map<string, string>) {}

  get proposal(): ProtocolProposalRow | null {
    return this.proposals.find((proposal) => proposal.id === 'proposal-1') ?? null
  }

  set proposal(value: ProtocolProposalRow | null) {
    const index = this.proposals.findIndex(
      (proposal) => proposal.id === 'proposal-1',
    )
    if (value === null) {
      if (index >= 0) this.proposals.splice(index, 1)
    } else if (index >= 0) {
      this.proposals[index] = value
    } else {
      this.proposals.push(value)
    }
  }

  addProposal(id: string, updatedAt: number): ProtocolProposalRow {
    const proposal: ProtocolProposalRow = {
      id,
      conversation_id: 'primary',
      job_id: `job-${id}`,
      assistant_message_id: `message-${id}`,
      status: 'proposed',
      action_plan_json: JSON.stringify(this.actionPlan),
      result_json: null,
      created_at: updatedAt - 10,
      updated_at: updatedAt,
      state_hash: 'a'.repeat(64),
    }
    this.proposals.push(proposal)
    return proposal
  }

  prepare(query: string): D1PreparedStatement {
    this.queries.push(query)
    return new ProposalProtocolStatement(this, query)
  }

  private reservation(
    proposal: ProtocolProposalRow,
  ): Record<string, unknown> | null {
    if (!proposal.result_json || proposal.status !== 'proposed') {
      return null
    }
    try {
      const parsed = JSON.parse(proposal.result_json) as unknown
      return parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }

  private activeReservations(): Array<{
    proposal: ProtocolProposalRow
    reservation: Record<string, unknown> | null
  }> {
    return this.proposals
      .filter(
        (proposal) =>
          proposal.status === 'proposed' && proposal.result_json !== null,
      )
      .map((proposal) => ({
        proposal,
        reservation: this.reservation(proposal),
      }))
  }

  first(query: string, values: unknown[]): unknown | null {
    if (query.includes('FROM cloud_auth_sessions')) {
      const id = this.sessionsByTokenHash.get(String(values[0]))
      if (!id || this.revokedSessionIds.has(id)) return null
      const now = Date.now()
      return {
        id,
        token_hash: values[0],
        device_name: id,
        created_at: 1,
        last_seen_at: now,
        expires_at: now + 60_000,
        revoked_at: null,
        user_agent: null,
      }
    }
    if (query.includes('FROM codex_chat_action_proposals p')) {
      const proposal = this.proposals.find(
        (candidate) => candidate.id === values[0],
      )
      return proposal ? { ...proposal } : null
    }
    if (
      query.includes('SELECT id') &&
      query.includes('FROM codex_chat_action_proposals') &&
      query.includes('result_json IS NOT NULL')
    ) {
      const active = this.activeReservations()[0]
      return active
        ? { id: active.proposal.id }
        : null
    }
    if (query.includes('FROM workout_snapshots')) {
      return this.snapshotPayload === null
        ? null
        : { payload_json: JSON.stringify(this.snapshotPayload) }
    }
    if (query.includes('FROM codex_chat_conversations')) {
      return this.conversationExists
        ? {
            id: 'primary',
            created_at: 1,
            updated_at: 1,
            codex_thread_id: null,
          }
        : null
    }
    if (query.includes('FROM codex_chat_maintenance')) {
      return { last_retention_at: Date.now() }
    }
    return null
  }

  all(query: string): unknown[] {
    if (
      query.includes('FROM codex_chat_messages m') &&
      query.includes('LEFT JOIN codex_chat_jobs')
    ) {
      return [
        {
          sequence: 1,
          id: 'message-1',
          conversation_id: 'primary',
          role: 'assistant',
          text: 'I can save that after you confirm.',
          client_message_id: null,
          reasoning_effort: 'medium',
          model: 'gpt-test',
          created_at: 10,
          job_id: 'job-1',
          job_status: 'completed',
        },
      ]
    }
    if (
      query.includes('FROM codex_chat_action_proposals p') &&
      query.includes('JOIN codex_chat_messages m')
    ) {
      return this.proposals.map((proposal) => ({ ...proposal }))
    }
    return []
  }

  run(query: string, values: unknown[]): D1Result {
    if (
      query.includes('UPDATE codex_chat_action_proposals') &&
      query.includes('SET result_json = ?, updated_at = ?')
    ) {
      const proposal = this.proposals.find(
        (candidate) => candidate.id === values[2],
      )
      if (!proposal) return { success: true, meta: { changes: 0 } }
      const [resultJson, updatedAt, proposalId, conversationId, expected] =
        values
      const ownerSessionId = values[7]
      const liveSessionId = String(values[8])
      if (this.revokeSessionBeforeReserve) {
        this.revokedSessionIds.add(liveSessionId)
        this.revokeSessionBeforeReserve = false
      }
      const sessionIsLive =
        Array.from(this.sessionsByTokenHash.values()).includes(liveSessionId) &&
        !this.revokedSessionIds.has(liveSessionId)
      const foreignOrInvalidReservation = this.activeReservations().some(
        ({ reservation }) =>
          reservation?._kind !== 'coach_apply_reservation_v1' ||
          reservation.ownerSessionId !== ownerSessionId,
      )
      if (
        proposal.id === proposalId &&
        proposal.conversation_id === conversationId &&
        proposal.status === 'proposed' &&
        proposal.result_json === null &&
        proposal.updated_at === expected &&
        sessionIsLive &&
        !foreignOrInvalidReservation
      ) {
        proposal.result_json = String(resultJson)
        proposal.updated_at = Number(updatedAt)
        return { success: true, meta: { changes: 1 } }
      }
      return { success: true, meta: { changes: 0 } }
    }
    if (
      query.includes('UPDATE codex_chat_action_proposals') &&
      query.includes('SET status = ?, result_json = ?, updated_at = ?')
    ) {
      const proposal = this.proposals.find(
        (candidate) => candidate.id === values[3],
      )
      if (!proposal) return { success: true, meta: { changes: 0 } }
      const [
        status,
        resultJson,
        updatedAt,
        proposalId,
        conversationId,
        reservedJson,
      ] = values
      if (
        proposal.id === proposalId &&
        proposal.conversation_id === conversationId &&
        proposal.status === 'proposed' &&
        proposal.result_json === reservedJson
      ) {
        proposal.status = status as ProtocolProposalStatus
        proposal.result_json = resultJson as string | null
        proposal.updated_at = Number(updatedAt)
        return { success: true, meta: { changes: 1 } }
      }
      return { success: true, meta: { changes: 0 } }
    }
    if (
      query.includes('UPDATE codex_chat_action_proposals') &&
      query.includes("SET status = 'dismissed'")
    ) {
      const proposal = this.proposals.find(
        (candidate) => candidate.id === values[1],
      )
      if (
        proposal?.status === 'proposed' &&
        proposal.result_json === null
      ) {
        proposal.status = 'dismissed'
        proposal.updated_at = Number(values[0])
        return { success: true, meta: { changes: 1 } }
      }
      return { success: true, meta: { changes: 0 } }
    }
    return { success: true, meta: { changes: 1 } }
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const protocolStatements = statements as ProposalProtocolStatement[]
    const isGuardedClear = protocolStatements.some(
      (statement) =>
        statement.query.includes('DELETE FROM codex_chat_action_proposals') &&
        statement.query.includes('reserved.result_json IS NOT NULL'),
    )
    if (!isGuardedClear) {
      return protocolStatements.map(() => ({
        success: true,
        meta: { changes: 0 },
      })) as D1Result<T>[]
    }

    const blocked = this.activeReservations().length > 0
    if (!blocked) {
      this.proposals.splice(0, this.proposals.length)
      this.conversationExists = false
    }
    const results = protocolStatements.map((statement) => ({
      success: true,
      meta: {
        changes: blocked
          ? 0
          : statement.query.includes('DELETE FROM codex_chat_conversations')
            ? 1
            : 1,
      },
    })) as D1Result<T>[]
    if (blocked && this.finalizeReservationAfterBlockedClear && this.proposal) {
      this.proposal.status = 'applied'
      this.proposal.result_json = JSON.stringify({ applied: true })
    }
    return results
  }
}

async function proposalProtocolDb(): Promise<ProposalProtocolDb> {
  return new ProposalProtocolDb(
    new Map([
      [await sha256Hex('phone-a-token'), 'session-a'],
      [await sha256Hex('phone-b-token'), 'session-b'],
    ]),
  )
}

function appliedProtocolResult(proposalId = 'proposal-1') {
  return {
    proposalId,
    appliedAt: 30,
    sourceStateHash: 'a'.repeat(64),
    sourceActionStateHash: 'b'.repeat(64),
    replayed: false,
    syncPending: false,
    changes: [
      {
        type: 'save_ai_note',
        label: 'Saved a note for AI Insights',
        entityId: 'note-1',
      },
    ],
  }
}

type AppliedProtocolResult = Omit<
  ReturnType<typeof appliedProtocolResult>,
  'sourceActionStateHash'
> & { sourceActionStateHash?: string }

function setMatchingProtocolSnapshot(
  db: ProposalProtocolDb,
  result: AppliedProtocolResult = appliedProtocolResult(),
  receiptResult = { ...result, syncPending: true },
): void {
  db.snapshotPayload = {
    schemaVersion: 4,
    data: {
      chatActionReceipts: [
        {
          proposalId: result.proposalId,
          appliedAt: result.appliedAt,
          sourceStateHash: result.sourceStateHash,
          resultJson: JSON.stringify(receiptResult),
        },
      ],
    },
  }
}

function proposalProtocolRequest(args: {
  db: ProposalProtocolDb
  token: 'phone-a-token' | 'phone-b-token'
  path: string
  method?: 'GET' | 'POST' | 'DELETE'
  body?: unknown
  transcriptProtocol?: boolean
}): Promise<Response> {
  const method = args.method ?? 'POST'
  const route = args.path.split('?', 1)[0]
  return chatOnRequest({
    request: new Request(`https://gym.test/api/chat/${args.path}`, {
      method,
      headers: {
        cookie: `gym_cloud_session=${args.token}`,
        ...(args.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
        ...(args.transcriptProtocol
          ? { 'X-Coach-Protocol': 'proposal-reservation-v1' }
          : {}),
      },
      ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
    }),
    env: { WORKOUT_DB: args.db },
    params: { path: route },
  })
}

interface SerializedClaimJob {
  id: string
  conversation_id: string
  user_message_id: string
  assistant_message_id: null
  context_id: string
  reasoning_effort: 'medium'
  status: 'queued' | 'leased'
  attempts: number
  max_attempts: number
  available_at: number
  worker_id: string | null
  lease_token: string | null
  lease_expires_at: number | null
  claimed_at: number | null
  completed_at: null
  last_error: string | null
  completion_hash: null
  created_at: number
  updated_at: number
  sequence: number
}

class SerializedClaimStatement implements D1PreparedStatement {
  readonly values: unknown[] = []

  constructor(
    readonly db: SerializedClaimDb,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values.splice(0, this.values.length, ...values)
    return this
  }

  async first<T>(): Promise<T | null> {
    return (await this.db.first(this.query, this.values)) as T | null
  }

  async all<T>(): Promise<{ results?: T[] }> {
    return { results: this.db.all(this.query, this.values) as T[] }
  }

  async run(): Promise<D1Result> {
    return this.db.run(this.query, this.values)
  }
}

class SerializedClaimDb implements D1Database {
  readonly queries: string[] = []
  readonly jobs: SerializedClaimJob[] = [1, 2].map((sequence) => ({
    id: `job-${sequence}`,
    conversation_id: 'primary',
    user_message_id: `message-${sequence}`,
    assistant_message_id: null,
    context_id: `context-${sequence}`,
    reasoning_effort: 'medium',
    status: 'queued',
    attempts: 0,
    max_attempts: 3,
    available_at: 0,
    worker_id: null,
    lease_token: null,
    lease_expires_at: null,
    claimed_at: null,
    completed_at: null,
    last_error: null,
    completion_hash: null,
    created_at: sequence,
    updated_at: sequence,
    sequence,
  }))
  private candidateCalls = 0
  private readonly initialCandidateResolvers: Array<() => void> = []

  prepare(query: string): D1PreparedStatement {
    this.queries.push(query)
    return new SerializedClaimStatement(this, query)
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return statements.map(() => ({
      success: true,
      meta: { changes: 0 },
    })) as D1Result<T>[]
  }

  async first(query: string, values: unknown[]): Promise<unknown | null> {
    if (query.includes('SELECT last_retention_at')) {
      return { last_retention_at: Date.now() }
    }
    if (query.includes('SELECT candidate.id')) {
      const call = this.candidateCalls
      this.candidateCalls += 1
      if (call < 2) {
        await new Promise<void>((resolve) => {
          this.initialCandidateResolvers.push(resolve)
          if (this.initialCandidateResolvers.length === 2) {
            for (const release of this.initialCandidateResolvers.splice(0)) {
              release()
            }
          }
        })
        return { id: this.jobs[call].id }
      }
      return null
    }
    if (
      query.includes('FROM codex_chat_jobs') &&
      query.includes('WHERE id = ?')
    ) {
      return { ...this.jobs.find((job) => job.id === values[0]) }
    }
    if (query.includes('FROM codex_chat_contexts')) {
      return {
        id: values[0],
        conversation_id: 'primary',
        state_hash: 'a'.repeat(64),
        context_json: JSON.stringify({}),
        created_at: 1,
      }
    }
    if (query.includes('FROM codex_chat_conversations')) {
      return {
        id: 'primary',
        created_at: 1,
        updated_at: 1,
        codex_thread_id: 'thread-1',
      }
    }
    if (query.includes('SELECT sequence FROM codex_chat_messages')) {
      const job = this.jobs.find((item) => item.user_message_id === values[0])
      return job ? { sequence: job.sequence } : null
    }
    return null
  }

  all(query: string, values: unknown[]): unknown[] {
    if (!query.includes('FROM codex_chat_messages')) return []
    const sequence = Number(values[1])
    return this.jobs
      .filter((job) => job.sequence <= sequence)
      .map((job) => ({
        sequence: job.sequence,
        id: job.user_message_id,
        conversation_id: 'primary',
        role: 'user',
        text: `Message ${job.sequence}`,
        client_message_id: `client-${job.sequence}`,
        reasoning_effort: 'medium',
        model: null,
        created_at: job.created_at,
      }))
  }

  async run(query: string, values: unknown[]): Promise<D1Result> {
    if (!query.includes("SET status = 'leased'")) {
      throw new Error('serialized claim test received an unexpected write')
    }
    await Promise.resolve()
    const job = this.jobs.find((item) => item.id === values[5])
    if (!job) return { success: true, meta: { changes: 0 } }
    const hasActiveGuard = query.includes("active.status = 'leased'")
    const hasEarlierGuard = query.includes("earlier.status = 'queued'")
    const blockedByActive =
      hasActiveGuard &&
      this.jobs.some((item) => item.id !== job.id && item.status === 'leased')
    const blockedByEarlier =
      hasEarlierGuard &&
      this.jobs.some(
        (item) =>
          item.id !== job.id &&
          item.status === 'queued' &&
          item.sequence < job.sequence,
      )
    if (job.status !== 'queued' || blockedByActive || blockedByEarlier) {
      return { success: true, meta: { changes: 0 } }
    }
    job.status = 'leased'
    job.attempts += 1
    job.worker_id = String(values[0])
    job.lease_token = String(values[1])
    job.lease_expires_at = Number(values[2])
    job.claimed_at = Number(values[3])
    return { success: true, meta: { changes: 1 } }
  }
}

type LeaseTransitionStatus =
  'queued' | 'leased' | 'completed' | 'failed' | 'cancelled'

interface LeaseTransitionJob {
  id: string
  conversation_id: string
  user_message_id: string
  assistant_message_id: string | null
  context_id: string
  reasoning_effort: 'medium'
  status: LeaseTransitionStatus
  attempts: number
  max_attempts: number
  available_at: number
  worker_id: string | null
  lease_token: string | null
  lease_expires_at: number | null
  claimed_at: number | null
  completed_at: number | null
  last_error: string | null
  completion_hash: string | null
  created_at: number
  updated_at: number
  sequence: number
}

class LeaseTransitionStatement implements D1PreparedStatement {
  readonly values: unknown[] = []

  constructor(
    readonly db: LeaseTransitionDb,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values.splice(0, this.values.length, ...values)
    return this
  }

  async first<T>(): Promise<T | null> {
    return this.db.first(this.query, this.values) as T | null
  }

  async all<T>(): Promise<{ results?: T[] }> {
    return { results: this.db.all(this.query, this.values) as T[] }
  }

  async run(): Promise<D1Result> {
    return this.db.run(this.query, this.values)
  }
}

class LeaseTransitionDb implements D1Database {
  readonly queries: string[] = []
  canonicalThreadId: string | null = 'thread-old'
  readonly jobs: LeaseTransitionJob[]

  constructor(
    readonly sessionTokenHash: string,
    expired: boolean,
  ) {
    const now = Date.now()
    this.jobs = [
      {
        id: 'job-old',
        conversation_id: 'primary',
        user_message_id: 'message-old',
        assistant_message_id: null,
        context_id: 'context-old',
        reasoning_effort: 'medium',
        status: 'leased',
        attempts: 1,
        max_attempts: 3,
        available_at: 0,
        worker_id: 'worker-old',
        lease_token: 'lease-old',
        lease_expires_at: expired ? now - 1 : now + 60_000,
        claimed_at: now - 1_000,
        completed_at: null,
        last_error: null,
        completion_hash: null,
        created_at: 1,
        updated_at: 1,
        sequence: 1,
      },
      {
        id: 'job-new',
        conversation_id: 'primary',
        user_message_id: 'message-new',
        assistant_message_id: null,
        context_id: 'context-new',
        reasoning_effort: 'medium',
        status: 'queued',
        attempts: 0,
        max_attempts: 3,
        available_at: 0,
        worker_id: null,
        lease_token: null,
        lease_expires_at: null,
        claimed_at: null,
        completed_at: null,
        last_error: null,
        completion_hash: null,
        created_at: 2,
        updated_at: 2,
        sequence: 2,
      },
    ]
  }

  prepare(query: string): D1PreparedStatement {
    this.queries.push(query)
    return new LeaseTransitionStatement(this, query)
  }

  first(query: string, values: unknown[]): unknown | null {
    if (query.includes('FROM cloud_auth_sessions')) {
      if (values[0] !== this.sessionTokenHash) return null
      const now = Date.now()
      return {
        id: 'session-phone',
        token_hash: this.sessionTokenHash,
        device_name: 'Phone',
        created_at: 1,
        last_seen_at: now,
        expires_at: now + 60_000,
        revoked_at: null,
        user_agent: null,
      }
    }
    if (query.includes('SELECT last_retention_at')) {
      return { last_retention_at: Date.now() }
    }
    if (query.includes('SELECT candidate.id')) {
      const now = Number(values[0])
      const active = this.jobs.some(
        (job) => job.status === 'leased' && (job.lease_expires_at ?? 0) > now,
      )
      if (active) return null
      const candidate = this.jobs
        .filter(
          (job) =>
            job.status === 'queued' &&
            job.attempts < job.max_attempts &&
            job.available_at <= now,
        )
        .sort((left, right) => left.sequence - right.sequence)[0]
      return candidate ? { id: candidate.id } : null
    }
    if (
      query.includes('FROM codex_chat_jobs') &&
      query.includes('WHERE id = ?')
    ) {
      const job = this.jobs.find((item) => item.id === values[0])
      return job ? { ...job } : null
    }
    if (query.includes('FROM codex_chat_conversations')) {
      return {
        id: 'primary',
        created_at: 1,
        updated_at: 1,
        codex_thread_id: this.canonicalThreadId,
      }
    }
    if (query.includes('FROM codex_chat_contexts')) {
      return {
        id: values[0],
        conversation_id: 'primary',
        state_hash: 'a'.repeat(64),
        context_json: JSON.stringify({}),
        created_at: 1,
      }
    }
    if (query.includes('SELECT sequence FROM codex_chat_messages')) {
      const job = this.jobs.find((item) => item.user_message_id === values[0])
      return job ? { sequence: job.sequence } : null
    }
    return null
  }

  all(query: string, values: unknown[]): unknown[] {
    if (!query.includes('FROM codex_chat_messages')) return []
    const maximumSequence = Number(values[1])
    return this.jobs
      .filter((job) => job.sequence <= maximumSequence)
      .map((job) => ({
        sequence: job.sequence,
        id: job.user_message_id,
        conversation_id: 'primary',
        role: 'user',
        text: job.id,
        client_message_id: `client-${job.id}`,
        reasoning_effort: 'medium',
        model: null,
        created_at: job.created_at,
      }))
  }

  run(query: string, values: unknown[]): D1Result {
    if (query.includes("SET status = 'leased', attempts = attempts + 1")) {
      const job = this.jobs.find((item) => item.id === values[5])
      if (!job || job.status !== 'queued') {
        return { success: true, meta: { changes: 0 } }
      }
      job.status = 'leased'
      job.attempts += 1
      job.worker_id = String(values[0])
      job.lease_token = String(values[1])
      job.lease_expires_at = Number(values[2])
      job.claimed_at = Number(values[3])
      job.updated_at = Number(values[4])
      return { success: true, meta: { changes: 1 } }
    }
    return { success: true, meta: { changes: 1 } }
  }

  private applyBatchStatement(statement: LeaseTransitionStatement): D1Result {
    const { query, values } = statement
    if (
      query.includes('SET worker_id = ?, lease_token = ?') &&
      query.includes("status = 'leased'")
    ) {
      const [workerMarker, leaseMarker, conversationId, expiresAt] = values
      let changes = 0
      for (const job of this.jobs) {
        if (
          job.conversation_id === conversationId &&
          job.status === 'leased' &&
          (job.lease_expires_at ?? 0) <= Number(expiresAt)
        ) {
          job.worker_id = String(workerMarker)
          job.lease_token = String(leaseMarker)
          changes += 1
        }
      }
      return { success: true, meta: { changes } }
    }
    if (query.includes("SET status = 'cancelled'")) {
      const [marker, completedAt, updatedAt, jobId, conversationId] = values
      const job = this.jobs.find(
        (item) => item.id === jobId && item.conversation_id === conversationId,
      )
      if (!job || (job.status !== 'queued' && job.status !== 'leased')) {
        return { success: true, meta: { changes: 0 } }
      }
      job.worker_id = job.status === 'leased' ? String(marker) : null
      job.status = 'cancelled'
      job.lease_token = null
      job.lease_expires_at = null
      job.claimed_at = null
      job.completed_at = Number(completedAt)
      job.updated_at = Number(updatedAt)
      return { success: true, meta: { changes: 1 } }
    }
    if (
      query.includes('SET codex_thread_id = NULL') &&
      query.includes('worker_id = ?')
    ) {
      const expectedThread = values[1]
      const marker = String(values.at(-1))
      const requiresLeaseMarker = query.includes('lease_token = ?')
      const marked = this.jobs.some(
        (job) =>
          job.worker_id === marker &&
          (requiresLeaseMarker
            ? job.lease_token === marker
            : job.lease_token === null),
      )
      if (marked && this.canonicalThreadId === expectedThread) {
        this.canonicalThreadId = null
        return { success: true, meta: { changes: 1 } }
      }
      return { success: true, meta: { changes: 0 } }
    }
    if (
      query.includes("SET status = 'failed'") &&
      query.includes("status = 'leased'")
    ) {
      const marker = String(values.at(-1))
      let changes = 0
      for (const job of this.jobs) {
        if (
          job.status === 'leased' &&
          job.worker_id === marker &&
          job.lease_token === marker &&
          job.attempts >= job.max_attempts
        ) {
          job.status = 'failed'
          job.worker_id = null
          job.lease_token = null
          job.lease_expires_at = null
          job.claimed_at = null
          changes += 1
        }
      }
      return { success: true, meta: { changes } }
    }
    if (
      query.includes("SET status = 'queued'") &&
      query.includes("status = 'leased'")
    ) {
      const marker = String(values.at(-1))
      let changes = 0
      for (const job of this.jobs) {
        if (
          job.status === 'leased' &&
          job.worker_id === marker &&
          job.lease_token === marker &&
          job.attempts < job.max_attempts
        ) {
          job.status = 'queued'
          job.available_at = Number(values[0])
          job.worker_id = null
          job.lease_token = null
          job.lease_expires_at = null
          job.claimed_at = null
          job.last_error = 'lease_expired'
          changes += 1
        }
      }
      return { success: true, meta: { changes } }
    }
    if (query.includes('SET worker_id = NULL')) {
      const [jobId, marker] = values
      const job = this.jobs.find(
        (item) => item.id === jobId && item.worker_id === marker,
      )
      if (job) job.worker_id = null
      return { success: true, meta: { changes: job ? 1 : 0 } }
    }
    return { success: true, meta: { changes: 0 } }
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return (statements as LeaseTransitionStatement[]).map((statement) =>
      this.applyBatchStatement(statement),
    ) as D1Result<T>[]
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

class LogoutFenceDb implements D1Database {
  revoked = false

  constructor(
    readonly sessionTokenHash: string,
    readonly hasOwnedReservation: boolean,
  ) {}

  prepare(query: string): D1PreparedStatement {
    const db = this
    const values: unknown[] = []
    const statement: D1PreparedStatement = {
      bind(...next: unknown[]) {
        values.splice(0, values.length, ...next)
        return statement
      },
      async first<T>() {
        if (!query.includes('FROM cloud_auth_sessions')) return null
        if (String(values[0]) !== db.sessionTokenHash || db.revoked) return null
        const now = Date.now()
        return {
          id: 'logout-session',
          token_hash: db.sessionTokenHash,
          device_name: 'Phone',
          created_at: 1,
          last_seen_at: now,
          expires_at: now + 60_000,
          revoked_at: null,
          user_agent: null,
        } as T
      },
      async all<T>() {
        return { results: [] as T[] }
      },
      async run() {
        if (query.includes('SET revoked_at = ?')) {
          if (db.hasOwnedReservation) {
            return { success: true, meta: { changes: 0 } }
          }
          db.revoked = true
        }
        return { success: true, meta: { changes: 1 } }
      },
    }
    return statement
  }

  async batch<T>(): Promise<D1Result<T>[]> {
    return []
  }
}

describe('cloud logout reservation fence', () => {
  async function logout(hasOwnedReservation: boolean) {
    const db = new LogoutFenceDb(
      await sha256Hex('logout-token'),
      hasOwnedReservation,
    )
    const response = await authOnRequest({
      request: new Request('https://gym.test/api/auth/cloud', {
        method: 'DELETE',
        headers: { cookie: 'gym_cloud_session=logout-token' },
      }),
      env: {
        WORKOUT_DB: db,
        CLOUD_PAIRING_SECRET: 'pairing-secret',
      },
      params: { path: 'cloud' },
    })
    return { db, response }
  }

  it('keeps the session and cookie while it owns an active Coach reservation', async () => {
    const { db, response } = await logout(true)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'coach_action_reservation_active',
    })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(db.revoked).toBe(false)
  })

  it('revokes and clears the session after its Coach reservation is finalized', async () => {
    const { db, response } = await logout(false)

    expect(response.status).toBe(200)
    expect(db.revoked).toBe(true)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
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

interface SnapshotFenceReservation {
  id: string
  result_json: string
  action_plan_json: string
  created_at: number
}

class SnapshotFenceStatement implements D1PreparedStatement {
  readonly values: unknown[] = []

  constructor(
    readonly db: SnapshotFenceDb,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values.splice(0, this.values.length, ...values)
    return this
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes('FROM cloud_auth_sessions')) {
      if (this.values[0] !== this.db.sessionTokenHash) return null
      const now = Date.now()
      return {
        id: this.db.sessionId,
        token_hash: this.db.sessionTokenHash,
        device_name: 'Snapshot test phone',
        created_at: 1,
        last_seen_at: now,
        expires_at: now + 60_000,
        revoked_at: null,
        user_agent: null,
      } as T
    }
    if (
      this.query.includes('FROM workout_snapshots') &&
      this.query.includes('WHERE id = ?')
    ) {
      return (this.db.snapshot ? { ...this.db.snapshot } : null) as T | null
    }
    return null
  }

  async all<T>(): Promise<{ results?: T[] }> {
    if (
      this.query.includes('FROM codex_chat_action_proposals') &&
      this.query.includes("status = 'proposed'")
    ) {
      return {
        results: this.db.reservations.map((row) => ({ ...row })) as T[],
      }
    }
    return { results: [] }
  }

  async run(): Promise<D1Result> {
    if (!this.query.includes('INSERT INTO workout_snapshots')) {
      return { success: true, meta: { changes: 1 } }
    }
    this.db.beforeSnapshotWrite?.()
    const chatActionUpload = this.query.includes(
      "json_extract(reserved.result_json, '$.ownerSessionId') = ?",
    )
    const reservationCount = chatActionUpload ? Number(this.values[6]) : 0
    const expectedReservationIds = chatActionUpload
      ? this.values
          .slice(7, 7 + reservationCount)
          .map((value) => String(value))
      : []
    const expectedOwner = chatActionUpload
      ? String(this.values[8 + reservationCount])
      : null
    const validOwners = this.db.reservations.map((row) => {
      try {
        const parsed = JSON.parse(row.result_json) as Record<string, unknown>
        if (
          parsed._kind !== 'coach_apply_reservation_v1' ||
          typeof parsed.ownerSessionId !== 'string' ||
          !parsed.ownerSessionId ||
          typeof parsed.reservedAt !== 'number' ||
          !Number.isSafeInteger(parsed.reservedAt) ||
          parsed.reservedAt < 0
        ) {
          return null
        }
        return parsed.ownerSessionId
      } catch {
        return null
      }
    })
    const actualReservationIds = this.db.reservations.map((row) => row.id).sort()
    const allowed = chatActionUpload
      ? validOwners.length === reservationCount &&
        validOwners.every((owner) => owner === expectedOwner) &&
        actualReservationIds.join('\u0000') ===
          expectedReservationIds.slice().sort().join('\u0000')
      : validOwners.length === 0
    if (!allowed) return { success: true, meta: { changes: 0 } }

    const versionValueIndex = chatActionUpload
      ? 9 + reservationCount
      : 7
    const expectsExistingSnapshot = this.query.includes(
      'current_snapshot.updated_at = ?',
    )
    const versionAllowed = expectsExistingSnapshot
      ? this.db.snapshot !== null &&
        this.db.snapshot.updated_at === Number(this.values[versionValueIndex])
      : this.db.snapshot === null
    if (!versionAllowed) return { success: true, meta: { changes: 0 } }

    const now = Number(this.values[2])
    const updatedAt =
      this.db.snapshot && this.db.snapshot.updated_at >= now
        ? this.db.snapshot.updated_at + 1
        : now
    this.db.snapshot = {
      id: String(this.values[0]),
      created_at: Number(this.values[1]),
      updated_at: updatedAt,
      source_device: String(this.values[3]),
      schema_version: Number(this.values[4]),
      payload_json: String(this.values[5]),
    }
    this.db.snapshotWrites += 1
    return { success: true, meta: { changes: 1 } }
  }
}

class SnapshotFenceDb implements D1Database {
  readonly queries: string[] = []
  readonly sessionId = 'session-owner'
  readonly reservations: SnapshotFenceReservation[] = []
  snapshot: {
    id: string
    created_at: number
    updated_at: number
    source_device: string
    schema_version: number
    payload_json: string
  } | null = null
  snapshotWrites = 0
  beforeSnapshotWrite: (() => void) | null = null

  constructor(readonly sessionTokenHash: string) {}

  prepare(query: string): D1PreparedStatement {
    this.queries.push(query)
    return new SnapshotFenceStatement(this, query)
  }

  async batch<T>(): Promise<D1Result<T>[]> {
    return []
  }
}

function snapshotReceipt(
  proposalId: string,
  sourceStateHash = 'a'.repeat(64),
  sourceActionStateHash: string | undefined = 'b'.repeat(64),
): Record<string, unknown> {
  const result = {
    proposalId,
    appliedAt: 2,
    sourceStateHash,
    ...(sourceActionStateHash ? { sourceActionStateHash } : {}),
    replayed: false,
    syncPending: true,
    changes: [],
  }
  return {
    proposalId,
    appliedAt: 2,
    sourceStateHash,
    resultJson: JSON.stringify(result),
  }
}

function validSnapshotPayload(
  proposalIds: string[] = [],
): Record<string, unknown> {
  return {
    schemaVersion: proposalIds.length > 0 ? 4 : 1,
    data: {
      exercises: [],
      programs: [],
      sessionTemplates: [],
      templateExercises: [],
      workoutSessions: [],
      loggedSets: [],
      ...(proposalIds.length > 0
        ? { chatActionReceipts: proposalIds.map((id) => snapshotReceipt(id)) }
        : {}),
    },
  }
}

function coachReservation(
  id: string,
  ownerSessionId: string,
): SnapshotFenceReservation {
  return {
    id,
    created_at: 1,
    result_json: JSON.stringify({
      _kind: 'coach_apply_reservation_v1',
      ownerSessionId,
      reservedAt: 1,
    }),
    action_plan_json: JSON.stringify({
      sourceStateHash: 'a'.repeat(64),
      sourceActionStateHash: 'b'.repeat(64),
    }),
  }
}

function snapshotFenceRequest(
  db: SnapshotFenceDb,
  headers: Record<string, string> = {},
  payload: Record<string, unknown> = validSnapshotPayload(
    db.reservations.map((reservation) => reservation.id),
  ),
): Promise<Response> {
  return cloudOnRequest({
    request: new Request('https://gym.test/api/cloud/snapshot', {
      method: 'PUT',
      headers: {
        cookie: 'gym_cloud_session=snapshot-token',
        'content-type': 'application/json',
        'X-Snapshot-Base-Updated-At': db.snapshot
          ? String(db.snapshot.updated_at)
          : 'none',
        ...headers,
      },
      body: JSON.stringify(payload),
    }),
    env: { WORKOUT_DB: db },
    params: { path: 'snapshot' },
  })
}

describe('Coach snapshot reservation fence', () => {
  async function db(): Promise<SnapshotFenceDb> {
    return new SnapshotFenceDb(await sha256Hex('snapshot-token'))
  }

  const chatHeaders = {
    'X-Coach-Protocol': 'proposal-reservation-v1',
    'X-Snapshot-Trigger': 'chat_action_applied',
  }

  it('accepts a chat-action snapshot when every reservation belongs to this session', async () => {
    const database = await db()
    database.reservations.push(
      coachReservation('proposal-1', database.sessionId),
      coachReservation('proposal-2', database.sessionId),
    )

    const response = await snapshotFenceRequest(database, chatHeaders)

    expect(response.status).toBe(200)
    expect(database.snapshotWrites).toBe(1)
  })

  it('requires every snapshot PUT to name the exact base revision', async () => {
    const database = await db()

    const response = await snapshotFenceRequest(database, {
      'X-Snapshot-Base-Updated-At': '',
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'snapshot_version_required' })
    expect(database.snapshotWrites).toBe(0)
  })

  it('rejects a stale base revision before replacing the current snapshot', async () => {
    const database = await db()
    database.snapshot = {
      id: 'primary',
      created_at: 1,
      updated_at: 9,
      source_device: 'phone',
      schema_version: 1,
      payload_json: JSON.stringify(validSnapshotPayload()),
    }

    const response = await snapshotFenceRequest(database, {
      'X-Snapshot-Base-Updated-At': '8',
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'snapshot_version_changed' })
    expect(database.snapshotWrites).toBe(0)
    expect(database.snapshot.updated_at).toBe(9)
  })

  it('rejects a fresh-base snapshot that drops a previously uploaded Coach receipt', async () => {
    const database = await db()
    database.snapshot = {
      id: 'primary',
      created_at: 1,
      updated_at: 9,
      source_device: 'phone',
      schema_version: 4,
      payload_json: JSON.stringify(validSnapshotPayload(['proposal-1'])),
    }

    const response = await snapshotFenceRequest(
      database,
      {},
      validSnapshotPayload(),
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'snapshot_receipt_history_changed',
    })
    expect(database.snapshotWrites).toBe(0)
  })

  it('rejects a fresh-base snapshot that changes an accepted receipt result', async () => {
    const database = await db()
    database.snapshot = {
      id: 'primary',
      created_at: 1,
      updated_at: 9,
      source_device: 'phone',
      schema_version: 4,
      payload_json: JSON.stringify(validSnapshotPayload(['proposal-1'])),
    }
    const next = validSnapshotPayload(['proposal-1'])
    const receipts = (next.data as Record<string, unknown>)
      .chatActionReceipts as Array<Record<string, unknown>>
    const changedResult = JSON.parse(String(receipts[0]?.resultJson)) as Record<
      string,
      unknown
    >
    changedResult.changes = [{ type: 'save_ai_note', label: 'different' }]
    receipts[0].resultJson = JSON.stringify(changedResult)

    const response = await snapshotFenceRequest(database, {}, next)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'snapshot_receipt_history_changed',
    })
    expect(database.snapshotWrites).toBe(0)
  })

  it('allows only transport flags to change on a previously uploaded receipt', async () => {
    const database = await db()
    database.snapshot = {
      id: 'primary',
      created_at: 1,
      updated_at: 9,
      source_device: 'phone',
      schema_version: 4,
      payload_json: JSON.stringify(validSnapshotPayload(['proposal-1'])),
    }
    const next = validSnapshotPayload(['proposal-1'])
    const receipts = (next.data as Record<string, unknown>)
      .chatActionReceipts as Array<Record<string, unknown>>
    const syncedResult = JSON.parse(String(receipts[0]?.resultJson)) as Record<
      string,
      unknown
    >
    syncedResult.syncPending = false
    syncedResult.replayed = true
    receipts[0].resultJson = JSON.stringify(syncedResult)

    const response = await snapshotFenceRequest(database, {}, next)

    expect(response.status).toBe(200)
    expect(database.snapshotWrites).toBe(1)
  })

  it('rejects a chat-action payload missing any active reservation receipt', async () => {
    const database = await db()
    database.reservations.push(
      coachReservation('proposal-1', database.sessionId),
      coachReservation('proposal-2', database.sessionId),
    )

    const response = await snapshotFenceRequest(
      database,
      chatHeaders,
      validSnapshotPayload(['proposal-1']),
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'coach_action_snapshot_receipt_missing',
    })
    expect(database.snapshotWrites).toBe(0)
  })

  it('rejects a chat-action receipt whose state hash does not match its proposal', async () => {
    const database = await db()
    database.reservations.push(
      coachReservation('proposal-1', database.sessionId),
    )
    const payload = validSnapshotPayload(['proposal-1'])
    ;(payload.data as Record<string, unknown>).chatActionReceipts = [
      snapshotReceipt('proposal-1', 'c'.repeat(64)),
    ]

    const response = await snapshotFenceRequest(database, chatHeaders, payload)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'coach_action_snapshot_receipt_mismatch',
    })
    expect(database.snapshotWrites).toBe(0)
  })

  it('rejects a chat-action receipt whose scoped hash does not match its proposal', async () => {
    const database = await db()
    database.reservations.push(
      coachReservation('proposal-1', database.sessionId),
    )
    const payload = validSnapshotPayload(['proposal-1'])
    ;(payload.data as Record<string, unknown>).chatActionReceipts = [
      snapshotReceipt('proposal-1', 'a'.repeat(64), 'c'.repeat(64)),
    ]

    const response = await snapshotFenceRequest(database, chatHeaders, payload)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'coach_action_snapshot_receipt_mismatch',
    })
    expect(database.snapshotWrites).toBe(0)
  })

  it('rejects a chat-action snapshot if any reservation has a foreign owner', async () => {
    const database = await db()
    database.reservations.push(
      coachReservation('proposal-1', database.sessionId),
      coachReservation('proposal-2', 'session-foreign'),
    )

    const response = await snapshotFenceRequest(database, chatHeaders)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'coach_action_reservation_owned_by_another_device',
    })
    expect(database.snapshotWrites).toBe(0)
  })

  it('rejects an unidentified legacy snapshot while a reservation is active', async () => {
    const database = await db()
    database.reservations.push(
      coachReservation('proposal-1', database.sessionId),
    )

    const response = await snapshotFenceRequest(database)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'coach_action_reservation_required',
    })
    expect(database.snapshotWrites).toBe(0)
  })

  it('rejects a chat-action snapshot when there is no active reservation', async () => {
    const database = await db()

    const response = await snapshotFenceRequest(database, chatHeaders)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'coach_action_reservation_required',
    })
    expect(database.snapshotWrites).toBe(0)
  })

  it('allows an ordinary snapshot when there is no active reservation', async () => {
    const database = await db()

    const response = await snapshotFenceRequest(database)

    expect(response.status).toBe(200)
    expect(database.snapshotWrites).toBe(1)
  })

  it('fails closed on malformed reservation state', async () => {
    const database = await db()
    database.reservations.push({
      id: 'proposal-corrupt',
      created_at: 1,
      result_json: '{"_kind":"coach_apply_reservation_v1"}',
      action_plan_json: JSON.stringify({
        sourceStateHash: 'a'.repeat(64),
        sourceActionStateHash: 'b'.repeat(64),
      }),
    })

    const response = await snapshotFenceRequest(database, chatHeaders)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'coach_action_reservation_state_invalid',
    })
    expect(database.snapshotWrites).toBe(0)
  })

  it('atomically rejects a foreign reservation created after preflight', async () => {
    const database = await db()
    database.reservations.push(
      coachReservation('proposal-1', database.sessionId),
    )
    database.beforeSnapshotWrite = () => {
      database.reservations.push(
        coachReservation('proposal-racing', 'session-foreign'),
      )
    }

    const response = await snapshotFenceRequest(database, chatHeaders)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'coach_action_reservation_changed',
    })
    expect(database.snapshotWrites).toBe(0)
  })

  it('atomically rejects a same-owner reservation missing from the built payload', async () => {
    const database = await db()
    database.reservations.push(
      coachReservation('proposal-1', database.sessionId),
    )
    database.beforeSnapshotWrite = () => {
      database.reservations.push(
        coachReservation('proposal-racing', database.sessionId),
      )
    }

    const response = await snapshotFenceRequest(database, chatHeaders)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'coach_action_reservation_changed',
    })
    expect(database.snapshotWrites).toBe(0)
  })

  it('atomically rejects a base revision changed after preflight', async () => {
    const database = await db()
    database.snapshot = {
      id: 'primary',
      created_at: 1,
      updated_at: 10,
      source_device: 'phone',
      schema_version: 1,
      payload_json: JSON.stringify(validSnapshotPayload()),
    }
    database.beforeSnapshotWrite = () => {
      if (database.snapshot) database.snapshot.updated_at = 11
    }

    const response = await snapshotFenceRequest(database)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'snapshot_version_changed' })
    expect(database.snapshotWrites).toBe(0)
    expect(database.snapshot.updated_at).toBe(11)
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

  it('rejects AI-memory plans from a paused trusted context', () => {
    const aiMemoryHash = 'e'.repeat(64)
    const pausedContext = JSON.stringify({
      actionStateHashes: { ai_memory: aiMemoryHash },
      memory: { paused: true },
    })
    expect(() =>
      trustedActionStateHashForPlan(pausedContext, 'ai_memory'),
    ).toThrow('ai_memory_paused')

    expect(
      trustedActionStateHashForPlan(
        JSON.stringify({
          actionStateHashes: { ai_memory: aiMemoryHash },
          memory: { paused: false },
        }),
        'ai_memory',
      ),
    ).toBe(aiMemoryHash)
  })

  it('requires every action capability before a Coach message is enqueued', () => {
    const actionStateHashes = {
      active_workout: 'a'.repeat(64),
      one_time_workout: 'b'.repeat(64),
      program: 'c'.repeat(64),
      exercise_library: 'd'.repeat(64),
      ai_memory: 'e'.repeat(64),
    }
    expect(() =>
      assertCompleteActionStateHashes({ actionStateHashes }),
    ).not.toThrow()
    expect(() =>
      assertCompleteActionStateHashes({
        actionStateHashes: { ...actionStateHashes, ai_memory: undefined },
      }),
    ).toThrow('coach_context_update_required')
    expect(() =>
      assertCompleteActionStateHashes({
        actionStateHashes: { ...actionStateHashes, program: 'INVALID' },
      }),
    ).toThrow('coach_context_update_required')
  })

  it('preserves the legacy completion hash input for normal completions', () => {
    const input = {
      assistantText: 'Done.',
      model: 'gpt-test',
      effort: 'medium' as const,
      codexThreadId: 'thread-1',
      actionPlan: null,
      discardCodexThread: false,
      expectedCodexThreadId: null,
    }
    expect(completionHashInput(input)).toBe(
      JSON.stringify({
        assistantText: input.assistantText,
        model: input.model,
        effort: input.effort,
        codexThreadId: input.codexThreadId,
        actionPlan: input.actionPlan,
      }),
    )
    expect(
      completionHashInput({
        ...input,
        codexThreadId: null,
        discardCodexThread: true,
        expectedCodexThreadId: 'thread-1',
      }),
    ).toContain('"discardCodexThread":true')
  })

  it('discards only the canonical Codex thread that the failed turn resumed', async () => {
    const db = new RecordingDb()
    const statement = discardConversationThreadStatement(
      db,
      'thread-old',
      'job-1',
      'queued',
      'failed:marker',
    )
    await statement.run()

    expect(db.statements).toHaveLength(1)
    expect(db.statements[0].query).toContain('codex_thread_id IS ?')
    expect(db.statements[0].query).toContain('worker_id = ?')
    expect(db.statements[0].query).toContain('lease_token IS NULL')
    expect(db.statements[0].values).toEqual([
      'primary',
      'thread-old',
      'job-1',
      'primary',
      'queued',
      'failed:marker',
    ])
  })

  it('keeps the canonical thread when the failing worker loses its lease', async () => {
    const db = new LostLeaseFailDb()
    const response = await chatOnRequest({
      request: new Request(
        'https://gym.test/api/chat/automation/jobs/job-1/fail',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Cloud-Automation-Secret': 'test-secret',
          },
          body: JSON.stringify({
            leaseToken: 'lease-original',
            error: 'invalid model output',
            retryable: true,
            retryAfterMs: 0,
            discardCodexThread: true,
            expectedCodexThreadId: 'thread-old',
          }),
        },
      ),
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
      params: { path: 'automation/jobs/job-1/fail' },
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'lease_lost' })
    expect(db.canonicalThreadId).toBe('thread-old')
    const discard = db.batchStatements.find((statement) =>
      statement.query.includes('SET codex_thread_id = NULL'),
    )
    expect(discard?.query).toContain('worker_id = ?')
    expect(discard?.query).toContain('lease_token IS NULL')
  })

  it('acknowledges an expired-lease-independent thread CAS without clearing a newer thread', async () => {
    const db = new ThreadCasDb('thread-old')
    const discard = (expectedCodexThreadId: string | null) =>
      chatOnRequest({
        request: new Request(
          'https://gym.test/api/chat/automation/conversation/discard-thread',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'X-Cloud-Automation-Secret': 'test-secret',
            },
            body: JSON.stringify({ expectedCodexThreadId }),
          },
        ),
        env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
        params: { path: 'automation/conversation/discard-thread' },
      })

    const detached = await discard('thread-old')
    expect(detached.status).toBe(200)
    expect(db.threadId).toBeNull()
    expect(await detached.json()).toMatchObject({
      acknowledged: true,
      detached: true,
      codexThreadId: null,
    })

    db.threadId = 'thread-new'
    const obsoleteReplay = await discard('thread-old')
    expect(obsoleteReplay.status).toBe(200)
    expect(db.threadId).toBe('thread-new')
    expect(await obsoleteReplay.json()).toMatchObject({
      acknowledged: true,
      detached: false,
      codexThreadId: 'thread-new',
    })
  })

  it('durably detaches exactly once even when an old edge recorded v1.4 first', async () => {
    const db = new HeartbeatMigrationDb()
    const heartbeat = (bridgeVersion: string) =>
      chatOnRequest({
        request: new Request('https://gym.test/api/chat/automation/heartbeat', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Cloud-Automation-Secret': 'test-secret',
          },
          body: JSON.stringify({
            status: 'idle',
            bridgeVersion,
            model: 'gpt-test',
          }),
        }),
        env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
        params: { path: 'automation/heartbeat' },
      })

    // A rolling old edge can persist the new bridge version without knowing
    // about (or completing) the one-time canonical-thread migration.
    db.bridgeVersion = '1.4'
    expect(db.threadId).toBe('thread-v13')
    expect(db.threadMigrationCompletedAt).toBeNull()

    const first = await heartbeat('1.4')
    expect(first.status).toBe(200)
    expect(db.threadId).toBeNull()
    expect(db.bridgeVersion).toBe('1.4')
    expect(db.threadMigrationCompletedAt).not.toBeNull()
    expect(db.transcript).toEqual(['user', 'assistant'])
    expect(await first.json()).toMatchObject({
      heartbeat: { threadDetachedForUpgrade: true },
    })
    const detachQuery = db.queries.find((query) =>
      query.includes('SET codex_thread_id = NULL'),
    )
    expect(detachQuery).toContain('FROM codex_chat_maintenance')
    expect(detachQuery).toContain('bridge_v14_thread_detached_at IS NULL')
    expect(detachQuery).not.toContain("bridge_version = '1.3'")

    db.threadId = 'thread-after-upgrade'
    const completedAt = db.threadMigrationCompletedAt
    const second = await heartbeat('1.4')
    expect(await second.json()).toMatchObject({
      heartbeat: { threadDetachedForUpgrade: false },
    })
    expect(db.threadId).toBe('thread-after-upgrade')
    expect(db.threadMigrationCompletedAt).toBe(completedAt)

    await heartbeat('1.3')
    expect(db.bridgeVersion).toBe('1.4')
    await heartbeat('1.4')
    expect(db.threadId).toBe('thread-after-upgrade')
  })

  it('preserves an exact predeploy message replay before capability enforcement', async () => {
    const db = new LegacyReplayDb()
    const response = await chatOnRequest({
      request: new Request('https://gym.test/api/chat/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'gym_cloud_session=legacy-token',
        },
        body: JSON.stringify({
          clientMessageId: db.clientMessageId,
          text: db.text,
          reasoningEffort: 'medium',
          stateHash: db.stateHash,
          context: db.context,
        }),
      }),
      env: { WORKOUT_DB: db },
      params: { path: 'messages' },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ replayed: true })
    expect(db.writeCount).toBe(0)
  })

  it('withholds actionable plans unless the reservation transcript protocol is present', async () => {
    const db = await proposalProtocolDb()
    const legacy = await proposalProtocolRequest({
      db,
      token: 'phone-a-token',
      path: 'messages?after=0&limit=100',
      method: 'GET',
    })
    const current = await proposalProtocolRequest({
      db,
      token: 'phone-a-token',
      path: 'messages?after=0&limit=100',
      method: 'GET',
      transcriptProtocol: true,
    })
    const legacyBody = (await legacy.json()) as {
      proposals: Array<{ actionPlan: unknown }>
    }
    const currentBody = (await current.json()) as {
      proposals: Array<{ actionPlan: unknown }>
    }

    expect(legacy.status).toBe(200)
    expect(legacyBody.proposals[0]?.actionPlan).toBeNull()
    expect(current.status).toBe(200)
    expect(currentBody.proposals[0]?.actionPlan).toEqual(db.actionPlan)
  })

  it('atomically fences two sessions racing to reserve one proposal', async () => {
    const db = await proposalProtocolDb()
    const reserve = (token: 'phone-a-token' | 'phone-b-token') =>
      proposalProtocolRequest({
        db,
        token,
        path: 'proposals/proposal-1/reserve',
        body: { expectedUpdatedAt: 20 },
      })

    const responses = await Promise.all([
      reserve('phone-a-token'),
      reserve('phone-b-token'),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ])
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    )
    expect(JSON.stringify(bodies)).not.toContain('session-a')
    expect(JSON.stringify(bodies)).not.toContain('session-b')

    const winner =
      responses[0].status === 200 ? 'phone-a-token' : 'phone-b-token'
    const replay = await reserve(winner)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ replayed: true })
  })

  it('atomically fences two sessions racing to reserve different proposals', async () => {
    const db = await proposalProtocolDb()
    db.addProposal('proposal-2', 30)
    const reserve = (
      token: 'phone-a-token' | 'phone-b-token',
      proposalId: string,
      expectedUpdatedAt: number,
    ) =>
      proposalProtocolRequest({
        db,
        token,
        path: `proposals/${proposalId}/reserve`,
        body: { expectedUpdatedAt },
      })

    const responses = await Promise.all([
      reserve('phone-a-token', 'proposal-1', 20),
      reserve('phone-b-token', 'proposal-2', 30),
    ])

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ])
    expect(
      db.proposals.filter(
        (proposal) =>
          proposal.status === 'proposed' && proposal.result_json !== null,
      ),
    ).toHaveLength(1)
    const reserveQueries = db.queries.filter(
      (query) =>
        query.includes('UPDATE codex_chat_action_proposals') &&
        query.includes('SET result_json = ?, updated_at = ?'),
    )
    expect(reserveQueries).toHaveLength(2)
    for (const query of reserveQueries) {
      expect(query).toContain('AND NOT EXISTS')
      expect(query).toContain('reserved.conversation_id = ?')
      expect(query).toContain('COALESCE(')
      expect(query).toContain(
        "json_extract(reserved.result_json, '$.ownerSessionId') = ?",
      )
      expect(query).toContain('FROM cloud_auth_sessions live_session')
      expect(query).toContain('live_session.expires_at > ?')
    }
  })

  it('fails closed when an existing proposed result is malformed', async () => {
    const db = await proposalProtocolDb()
    db.addProposal('proposal-malformed', 30).result_json = '{}'

    const response = await proposalProtocolRequest({
      db,
      token: 'phone-a-token',
      path: 'proposals/proposal-1/reserve',
      body: { expectedUpdatedAt: 20 },
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'proposal_reserved' })
    expect(db.proposal?.result_json).toBeNull()
  })

  it('does not reserve after its authenticated session loses a logout race', async () => {
    const db = await proposalProtocolDb()
    db.revokeSessionBeforeReserve = true

    const response = await proposalProtocolRequest({
      db,
      token: 'phone-a-token',
      path: 'proposals/proposal-1/reserve',
      body: { expectedUpdatedAt: 20 },
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
    expect(db.proposal?.result_json).toBeNull()
  })

  it('allows one session to reserve multiple proposals', async () => {
    const db = await proposalProtocolDb()
    db.addProposal('proposal-2', 30)
    const responses = await Promise.all([
      proposalProtocolRequest({
        db,
        token: 'phone-a-token',
        path: 'proposals/proposal-1/reserve',
        body: { expectedUpdatedAt: 20 },
      }),
      proposalProtocolRequest({
        db,
        token: 'phone-a-token',
        path: 'proposals/proposal-2/reserve',
        body: { expectedUpdatedAt: 30 },
      }),
    ])

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(
      db.proposals.filter(
        (proposal) =>
          proposal.status === 'proposed' && proposal.result_json !== null,
      ),
    ).toHaveLength(2)
  })

  it('recovers a same-session reservation after a lost response and later finalizes', async () => {
    const db = await proposalProtocolDb()
    const request = () =>
      proposalProtocolRequest({
        db,
        token: 'phone-a-token',
        path: 'proposals/proposal-1/reserve',
        body: { expectedUpdatedAt: 20 },
      })

    expect((await request()).status).toBe(200)
    const crashRetry = await request()
    expect(crashRetry.status).toBe(200)
    expect(await crashRetry.json()).toMatchObject({ replayed: true })

    const appliedResult = appliedProtocolResult()
    const resultBody = {
      status: 'applied',
      result: appliedResult,
    }
    const beforeSnapshot = await proposalProtocolRequest({
      db,
      token: 'phone-a-token',
      path: 'proposals/proposal-1/result',
      body: resultBody,
    })
    expect(beforeSnapshot.status).toBe(409)
    expect(await beforeSnapshot.json()).toMatchObject({
      error: 'proposal_result_unverified',
    })
    expect(db.proposal?.status).toBe('proposed')

    setMatchingProtocolSnapshot(db, appliedResult, {
      ...appliedResult,
      syncPending: true,
      changes: [
        {
          ...appliedResult.changes[0],
          label: 'A different local mutation',
        },
      ],
    })
    const mismatchedSnapshot = await proposalProtocolRequest({
      db,
      token: 'phone-a-token',
      path: 'proposals/proposal-1/result',
      body: resultBody,
    })
    expect(mismatchedSnapshot.status).toBe(409)
    expect(await mismatchedSnapshot.json()).toMatchObject({
      error: 'proposal_result_unverified',
    })

    const mismatchedStateHash = await proposalProtocolRequest({
      db,
      token: 'phone-a-token',
      path: 'proposals/proposal-1/result',
      body: {
        status: 'applied',
        result: {
          ...appliedResult,
          sourceActionStateHash: 'c'.repeat(64),
        },
      },
    })
    expect(mismatchedStateHash.status).toBe(409)

    setMatchingProtocolSnapshot(db)
    const finalized = await proposalProtocolRequest({
      db,
      token: 'phone-a-token',
      path: 'proposals/proposal-1/result',
      body: resultBody,
    })
    expect(finalized.status).toBe(200)

    const exactTerminalReplay = await proposalProtocolRequest({
      db,
      token: 'phone-b-token',
      path: 'proposals/proposal-1/result',
      body: resultBody,
    })
    expect(exactTerminalReplay.status).toBe(200)
  })

  it('accepts a matching legacy receipt when both results omit the scoped hash', async () => {
    const db = await proposalProtocolDb()
    const fullResult = appliedProtocolResult()
    const legacyResult: AppliedProtocolResult = {
      proposalId: fullResult.proposalId,
      appliedAt: fullResult.appliedAt,
      sourceStateHash: fullResult.sourceStateHash,
      replayed: fullResult.replayed,
      syncPending: fullResult.syncPending,
      changes: fullResult.changes,
    }
    const reserved = await proposalProtocolRequest({
      db,
      token: 'phone-a-token',
      path: 'proposals/proposal-1/reserve',
      body: { expectedUpdatedAt: 20 },
    })
    expect(reserved.status).toBe(200)
    setMatchingProtocolSnapshot(db, legacyResult)

    const finalized = await proposalProtocolRequest({
      db,
      token: 'phone-a-token',
      path: 'proposals/proposal-1/result',
      body: { status: 'applied', result: legacyResult },
    })

    expect(finalized.status).toBe(200)
    expect(db.proposal?.status).toBe('applied')
  })

  it('requires the reservation owner for result and refuses dismiss while reserved', async () => {
    const db = await proposalProtocolDb()
    await proposalProtocolRequest({
      db,
      token: 'phone-a-token',
      path: 'proposals/proposal-1/reserve',
      body: { expectedUpdatedAt: 20 },
    })

    const foreignResult = await proposalProtocolRequest({
      db,
      token: 'phone-b-token',
      path: 'proposals/proposal-1/result',
      body: { status: 'applied', result: { saved: true } },
    })
    const dismiss = await proposalProtocolRequest({
      db,
      token: 'phone-b-token',
      path: 'proposals/proposal-1/dismiss',
      body: {},
    })

    expect(foreignResult.status).toBe(409)
    expect(await foreignResult.json()).toMatchObject({
      error: 'proposal_reserved',
    })
    expect(dismiss.status).toBe(409)
    expect(await dismiss.json()).toMatchObject({ error: 'proposal_reserved' })
    expect(db.proposal?.status).toBe('proposed')
  })

  it('serializes reserve against clear and never deletes a reserved proposal', async () => {
    const db = await proposalProtocolDb()
    const [reserve, clear] = await Promise.all([
      proposalProtocolRequest({
        db,
        token: 'phone-a-token',
        path: 'proposals/proposal-1/reserve',
        body: { expectedUpdatedAt: 20 },
      }),
      proposalProtocolRequest({
        db,
        token: 'phone-b-token',
        path: 'conversation',
        method: 'DELETE',
      }),
    ])

    expect(
      [reserve.status, clear.status].filter((status) => status === 200),
    ).toHaveLength(1)
    if (reserve.status === 200) {
      expect(clear.status).toBe(409)
      expect(db.conversationExists).toBe(true)
      expect(db.proposal?.status).toBe('proposed')
    } else {
      expect(clear.status).toBe(200)
      expect(reserve.status).toBe(404)
      expect(db.conversationExists).toBe(false)
    }
  })

  it('fails closed when clear encounters a malformed proposed result', async () => {
    const db = await proposalProtocolDb()
    if (!db.proposal) throw new Error('proposal fixture missing')
    db.proposal.result_json = '{}'

    const clear = await proposalProtocolRequest({
      db,
      token: 'phone-a-token',
      path: 'conversation',
      method: 'DELETE',
    })

    expect(clear.status).toBe(409)
    expect(await clear.json()).toMatchObject({ error: 'proposal_reserved' })
    expect(db.conversationExists).toBe(true)
    expect(db.proposal).not.toBeNull()
  })

  it('returns retryable conflict if a blocked clear loses its reservation diagnostic race', async () => {
    const db = await proposalProtocolDb()
    await proposalProtocolRequest({
      db,
      token: 'phone-a-token',
      path: 'proposals/proposal-1/reserve',
      body: { expectedUpdatedAt: 20 },
    })
    db.finalizeReservationAfterBlockedClear = true

    const clear = await proposalProtocolRequest({
      db,
      token: 'phone-b-token',
      path: 'conversation',
      method: 'DELETE',
    })
    expect(clear.status).toBe(409)
    expect(await clear.json()).toMatchObject({ error: 'conversation_changed' })
    expect(db.conversationExists).toBe(true)
  })

  it('serializes concurrent claims for one conversation in both SQL phases', async () => {
    const db = new SerializedClaimDb()
    const claim = (workerId: string) =>
      chatOnRequest({
        request: new Request(
          'https://gym.test/api/chat/automation/jobs/claim',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'X-Cloud-Automation-Secret': 'test-secret',
            },
            body: JSON.stringify({ workerId, leaseDurationMs: 30_000 }),
          },
        ),
        env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
        params: { path: 'automation/jobs/claim' },
      })

    const responses = await Promise.all([claim('worker-a'), claim('worker-b')])
    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<{ job: unknown }>),
    )
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(bodies.filter((body) => body.job !== null)).toHaveLength(1)
    expect(db.jobs.filter((job) => job.status === 'leased')).toHaveLength(1)
    expect(db.jobs[0].status).toBe('leased')
    expect(db.jobs[1].status).toBe('queued')

    const candidateQueries = db.queries.filter((query) =>
      query.includes('SELECT candidate.id'),
    )
    const updateQueries = db.queries.filter((query) =>
      query.includes("SET status = 'leased'"),
    )
    expect(candidateQueries.length).toBeGreaterThanOrEqual(2)
    expect(updateQueries.length).toBeGreaterThanOrEqual(2)
    for (const query of [...candidateQueries, ...updateQueries]) {
      expect(query).toContain("active.status = 'leased'")
      expect(query).toContain("earlier.status = 'queued'")
    }
    expect(candidateQueries[0]).toContain('candidate_message.sequence')
    expect(candidateQueries[0]).not.toContain('earlier.available_at')
    expect(updateQueries[0]).not.toContain('earlier.available_at')
  })

  it('atomically detaches a leased thread before cancellation allows an immediate claim', async () => {
    const token = 'lease-phone-token'
    const db = new LeaseTransitionDb(await sha256Hex(token), false)
    const cancelled = await chatOnRequest({
      request: new Request('https://gym.test/api/chat/jobs/job-old/cancel', {
        method: 'POST',
        headers: { cookie: `gym_cloud_session=${token}` },
      }),
      env: { WORKOUT_DB: db },
      params: { path: 'jobs/job-old/cancel' },
    })
    expect(cancelled.status).toBe(200)
    expect(db.jobs[0].status).toBe('cancelled')
    expect(db.canonicalThreadId).toBeNull()

    const claimed = await chatOnRequest({
      request: new Request('https://gym.test/api/chat/automation/jobs/claim', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Cloud-Automation-Secret': 'test-secret',
        },
        body: JSON.stringify({
          workerId: 'worker-new',
          leaseDurationMs: 30_000,
        }),
      }),
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
      params: { path: 'automation/jobs/claim' },
    })
    const body = (await claimed.json()) as {
      job: { id: string } | null
      codexThreadId: string | null
    }
    expect(claimed.status).toBe(200)
    expect(body.job?.id).toBe('job-new')
    expect(body.codexThreadId).toBeNull()
  })

  it('detaches an expired lease before atomically requeueing and reclaiming it', async () => {
    const db = new LeaseTransitionDb(
      await sha256Hex('unused-phone-token'),
      true,
    )
    const claimed = await chatOnRequest({
      request: new Request('https://gym.test/api/chat/automation/jobs/claim', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Cloud-Automation-Secret': 'test-secret',
        },
        body: JSON.stringify({
          workerId: 'worker-retry',
          leaseDurationMs: 30_000,
        }),
      }),
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: db },
      params: { path: 'automation/jobs/claim' },
    })
    const body = (await claimed.json()) as {
      job: { id: string } | null
      codexThreadId: string | null
    }

    expect(claimed.status).toBe(200)
    expect(body.job?.id).toBe('job-old')
    expect(body.codexThreadId).toBeNull()
    expect(db.canonicalThreadId).toBeNull()
    const scopedTransitions = db.queries.filter(
      (query) =>
        query.includes('UPDATE codex_chat_jobs') &&
        !query.includes('attempts = attempts + 1') &&
        (query.includes('lease_expires_at <= ?') ||
          query.includes("status = 'leased'") ||
          query.includes("status = 'queued' AND attempts")),
    )
    expect(scopedTransitions.length).toBeGreaterThanOrEqual(3)
    for (const query of scopedTransitions) {
      expect(query).toContain('conversation_id = ?')
    }
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
