import {
  requireAutomationSecret,
  requireDeviceSession,
  sha256Hex,
  type D1Database,
} from '../../lib/cloudAuth'

type ReasoningEffort = 'medium' | 'xhigh'
type MessageRole = 'user' | 'assistant'
type JobStatus = 'queued' | 'leased' | 'completed' | 'failed' | 'cancelled'
type ProposalStatus = 'proposed' | 'applied' | 'failed' | 'dismissed'

interface Env {
  CLOUD_AUTOMATION_SECRET?: string
  WORKOUT_DB: D1Database
}

interface PagesContext {
  request: Request
  env: Env
  params: { path?: string | string[] }
}

interface ConversationRow {
  id: string
  created_at: number
  updated_at: number
  codex_thread_id: string | null
}

interface ContextRow {
  id: string
  conversation_id: string
  state_hash: string
  context_json: string
  created_at: number
}

interface MessageRow {
  sequence: number
  id: string
  conversation_id: string
  role: MessageRole
  text: string
  client_message_id: string | null
  reasoning_effort: ReasoningEffort | null
  model: string | null
  created_at: number
}

interface MessageWithJobRow extends MessageRow {
  job_id: string | null
  job_status: JobStatus | null
}

interface JobRow {
  id: string
  conversation_id: string
  user_message_id: string
  assistant_message_id: string | null
  context_id: string
  reasoning_effort: ReasoningEffort
  status: JobStatus
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
}

interface ProposalRow {
  id: string
  conversation_id: string
  job_id: string
  assistant_message_id: string
  status: ProposalStatus
  action_plan_json: string
  result_json: string | null
  created_at: number
  updated_at: number
  state_hash?: string
}

interface HeartbeatRow {
  id: string
  last_seen_at: number
  status: 'idle' | 'working' | 'error'
  bridge_version: string | null
  model: string | null
  active_job_id: string | null
}

const CONVERSATION_ID = 'primary'
const MAX_REQUEST_BYTES = 1048576
const MAX_CONTEXT_BYTES = 524288
const MAX_ACTION_PLAN_BYTES = 131072
const MAX_RESULT_BYTES = 65536
const MAX_USER_TEXT_LENGTH = 6000
const MAX_ASSISTANT_TEXT_LENGTH = 24000
const BRIDGE_ONLINE_WINDOW_MS = 45000
const DEFAULT_LEASE_MS = 180000
const MIN_LEASE_MS = 30000
const MAX_LEASE_MS = 600000
const DEFAULT_RETRY_MS = 5000
const MAX_RETRY_MS = 300000
const TRANSCRIPT_LIMIT = 60
const STATE_PENDING_JOB_LIMIT = 10
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000
const RETAIN_TERMINAL_JOBS = 500
const RETAIN_RESOLVED_PROPOSALS = 500
const RETAIN_TRANSCRIPT_MESSAGES = 120
const ACTION_SCOPES = [
  'active_workout',
  'one_time_workout',
  'program',
  'exercise_library',
  'ai_memory',
] as const
type ActionScope = (typeof ACTION_SCOPES)[number]

class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly detail?: string

  constructor(status: number, code: string, detail?: string) {
    super(code)
    this.status = status
    this.code = code
    this.detail = detail
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function jsonByteLength(value: unknown): number {
  let raw: string
  try {
    raw = JSON.stringify(value)
  } catch {
    throw new ApiError(400, 'invalid_json_value')
  }
  if (raw === undefined) throw new ApiError(400, 'invalid_json_value')
  return new TextEncoder().encode(raw).byteLength
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new ApiError(413, 'payload_too_large')
  }
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new ApiError(413, 'payload_too_large')
  }
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    throw new ApiError(400, 'invalid_json')
  }
  if (!isObject(value)) throw new ApiError(400, 'body_must_be_an_object')
  return value
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, 'invalid_request', `${field} is required`)
  }
  const result = value.trim()
  if (result.length > maxLength) {
    throw new ApiError(400, 'invalid_request', `${field} is too long`)
  }
  return result
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null || value === '') return null
  return requiredString(value, field, maxLength)
}

function assertReasoningEffort(value: unknown): ReasoningEffort {
  if (value !== 'medium' && value !== 'xhigh') {
    throw new ApiError(
      400,
      'invalid_reasoning_effort',
      'reasoningEffort must be medium or xhigh',
    )
  }
  return value
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || typeof value !== 'number') {
    throw new ApiError(400, 'invalid_request', `${field} must be an integer`)
  }
  if (value < min || value > max) {
    throw new ApiError(
      400,
      'invalid_request',
      `${field} must be between ${min} and ${max}`,
    )
  }
  return value
}

function routePath(ctx: PagesContext): string {
  const raw = ctx.params.path
  return Array.isArray(raw) ? raw.join('/') : (raw ?? '')
}

function validOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,160}$/.test(value)
}

function validClientMessageId(value: string): boolean {
  return value.length >= 8 && validOpaqueId(value)
}

function validSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isActionScope(value: unknown): value is ActionScope {
  return (
    typeof value === 'string' &&
    (ACTION_SCOPES as readonly string[]).includes(value)
  )
}

function trustedActionStateHash(
  contextJson: string,
  scope: ActionScope,
): string {
  const payload = parseJson(contextJson)
  const hashes = isObject(payload) ? payload.actionStateHashes : null
  const hash = isObject(hashes) ? hashes[scope] : null
  if (!validSha256Hex(hash)) {
    throw new ApiError(409, 'action_state_hash_unavailable')
  }
  return hash
}

function requireSameOriginForMutation(request: Request): Response | null {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null
  const origin = request.headers.get('origin')
  if (!origin) return null
  try {
    if (new URL(origin).origin === new URL(request.url).origin) return null
  } catch {
    // Malformed and opaque origins are not valid for cookie-authenticated writes.
  }
  return json(403, { error: 'cross_origin_request_rejected' })
}

function conversationResponse(row: ConversationRow): unknown {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function messageResponse(row: MessageWithJobRow | MessageRow): unknown {
  const withJob = row as MessageWithJobRow
  return {
    id: row.id,
    sequence: row.sequence,
    role: row.role,
    text: row.text,
    createdAt: row.created_at,
    reasoningEffort: row.reasoning_effort,
    model: row.model,
    jobId: withJob.job_id ?? null,
    jobStatus: withJob.job_status ?? null,
  }
}

function jobResponse(row: JobRow): unknown {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    reasoningEffort: row.reasoning_effort,
    status: row.status,
    attempt: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    error: row.last_error,
  }
}

function proposalResponse(row: ProposalRow): unknown {
  return {
    id: row.id,
    messageId: row.assistant_message_id,
    jobId: row.job_id,
    status: row.status,
    actionPlan: parseJson(row.action_plan_json),
    sourceStateHash:
      row.state_hash ??
      (isObject(parseJson(row.action_plan_json))
        ? (parseJson(row.action_plan_json) as Record<string, unknown>)
            .sourceStateHash ?? null
        : null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    result: row.result_json ? parseJson(row.result_json) : null,
  }
}

async function readConversation(db: D1Database): Promise<ConversationRow | null> {
  return db
    .prepare(
      `SELECT id, created_at, updated_at, codex_thread_id
       FROM codex_chat_conversations
       WHERE id = ?`,
    )
    .bind(CONVERSATION_ID)
    .first<ConversationRow>()
}

async function readJob(db: D1Database, id: string): Promise<JobRow | null> {
  return db
    .prepare(
      `SELECT id, conversation_id, user_message_id, assistant_message_id,
              context_id, reasoning_effort, status, attempts, max_attempts,
              available_at, worker_id, lease_token, lease_expires_at,
              claimed_at, completed_at, last_error, completion_hash,
              created_at, updated_at
       FROM codex_chat_jobs
       WHERE id = ?`,
    )
    .bind(id)
    .first<JobRow>()
}

async function readProposal(
  db: D1Database,
  id: string,
): Promise<ProposalRow | null> {
  return db
    .prepare(
      `SELECT p.id, p.conversation_id, p.job_id, p.assistant_message_id,
              p.status, p.action_plan_json, p.result_json, p.created_at,
              p.updated_at, c.state_hash
       FROM codex_chat_action_proposals p
       JOIN codex_chat_jobs j ON j.id = p.job_id
       JOIN codex_chat_contexts c ON c.id = j.context_id
       WHERE p.id = ? AND p.conversation_id = ?`,
    )
    .bind(id, CONVERSATION_ID)
    .first<ProposalRow>()
}

async function normalizeExpiredLeases(
  db: D1Database,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE codex_chat_jobs
         SET status = 'failed', worker_id = NULL, lease_token = NULL,
             lease_expires_at = NULL, claimed_at = NULL, completed_at = ?,
             updated_at = ?,
             last_error = COALESCE(last_error, 'max_attempts_exhausted')
         WHERE attempts >= max_attempts
           AND (
             status = 'queued' OR
             (status = 'leased' AND lease_expires_at <= ?)
           )`,
      )
      .bind(now, now, now),
    db
      .prepare(
        `UPDATE codex_chat_jobs
         SET status = 'queued', available_at = ?, worker_id = NULL,
             lease_token = NULL, lease_expires_at = NULL, claimed_at = NULL,
             updated_at = ?, last_error = 'lease_expired'
         WHERE status = 'leased'
           AND lease_expires_at <= ?
           AND attempts < max_attempts`,
      )
      .bind(now, now, now),
    db
      .prepare(
        `UPDATE codex_chat_bridge_heartbeat
         SET status = CASE WHEN status = 'working' THEN 'idle' ELSE status END,
             active_job_id = NULL
         WHERE id = ?
           AND active_job_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM codex_chat_jobs j
             WHERE j.id = codex_chat_bridge_heartbeat.active_job_id
               AND j.status = 'leased'
               AND j.lease_expires_at > ?
           )`,
      )
      .bind(CONVERSATION_ID, now),
  ])
}

async function pruneRetainedChatData(
  db: D1Database,
  now: number,
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT last_retention_at
       FROM codex_chat_maintenance
       WHERE id = ?`,
    )
    .bind(CONVERSATION_ID)
    .first<{ last_retention_at: number }>()
  if (row && now - row.last_retention_at < RETENTION_INTERVAL_MS) return

  await db.batch([
    db
      .prepare(
        `DELETE FROM codex_chat_action_proposals
         WHERE conversation_id = ?
           AND status IN ('applied', 'failed', 'dismissed')
           AND id NOT IN (
             SELECT id
             FROM codex_chat_action_proposals
             WHERE conversation_id = ?
               AND status IN ('applied', 'failed', 'dismissed')
             ORDER BY updated_at DESC, created_at DESC
             LIMIT ?
           )`,
      )
      .bind(
        CONVERSATION_ID,
        CONVERSATION_ID,
        RETAIN_RESOLVED_PROPOSALS,
      ),
    db
      .prepare(
        `DELETE FROM codex_chat_jobs
         WHERE conversation_id = ?
           AND status IN ('completed', 'failed', 'cancelled')
           AND NOT EXISTS (
             SELECT 1
             FROM codex_chat_action_proposals p
             WHERE p.job_id = codex_chat_jobs.id
               AND p.status = 'proposed'
           )
           AND id NOT IN (
             SELECT j.id
             FROM codex_chat_jobs j
             WHERE j.conversation_id = ?
               AND j.status IN ('completed', 'failed', 'cancelled')
               AND NOT EXISTS (
                 SELECT 1
                 FROM codex_chat_action_proposals p2
                 WHERE p2.job_id = j.id
                   AND p2.status = 'proposed'
               )
             ORDER BY j.updated_at DESC, j.created_at DESC
             LIMIT ?
           )`,
      )
      .bind(CONVERSATION_ID, CONVERSATION_ID, RETAIN_TERMINAL_JOBS),
    db
      .prepare(
        `DELETE FROM codex_chat_contexts
         WHERE conversation_id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM codex_chat_jobs j
             WHERE j.context_id = codex_chat_contexts.id
           )`,
      )
      .bind(CONVERSATION_ID),
    db
      .prepare(
        `DELETE FROM codex_chat_messages
         WHERE conversation_id = ?
           AND sequence NOT IN (
             SELECT sequence
             FROM codex_chat_messages
             WHERE conversation_id = ?
             ORDER BY sequence DESC
             LIMIT ?
           )
           AND NOT EXISTS (
             SELECT 1
             FROM codex_chat_jobs j
             WHERE j.user_message_id = codex_chat_messages.id
                OR j.assistant_message_id = codex_chat_messages.id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM codex_chat_action_proposals p
             WHERE p.assistant_message_id = codex_chat_messages.id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM codex_chat_jobs pending
             JOIN codex_chat_messages anchor
               ON anchor.id = pending.user_message_id
             WHERE pending.conversation_id = ?
               AND pending.status IN ('queued', 'leased')
               AND codex_chat_messages.sequence IN (
                 SELECT tail.sequence
                 FROM codex_chat_messages tail
                 WHERE tail.conversation_id = pending.conversation_id
                   AND tail.sequence <= anchor.sequence
                 ORDER BY tail.sequence DESC
                 LIMIT ?
               )
           )`,
      )
      .bind(
        CONVERSATION_ID,
        CONVERSATION_ID,
        RETAIN_TRANSCRIPT_MESSAGES,
        CONVERSATION_ID,
        TRANSCRIPT_LIMIT,
      ),
    db
      .prepare(
        `INSERT INTO codex_chat_maintenance (id, last_retention_at)
         VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_retention_at = excluded.last_retention_at`,
      )
      .bind(CONVERSATION_ID, now),
  ])
}

async function maintainChatData(db: D1Database, now: number): Promise<void> {
  await normalizeExpiredLeases(db, now)
  await pruneRetainedChatData(db, now)
}

async function handleGetState(db: D1Database): Promise<Response> {
  const now = Date.now()
  await maintainChatData(db, now)
  const [conversation, heartbeat, counts, latest, pendingJobs] = await Promise.all([
    readConversation(db),
    db
      .prepare(
        `SELECT id, last_seen_at, status, bridge_version, model, active_job_id
         FROM codex_chat_bridge_heartbeat
         WHERE id = ?`,
      )
      .bind(CONVERSATION_ID)
      .first<HeartbeatRow>(),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0)
             AS queued_count,
           COALESCE(SUM(CASE
             WHEN status = 'leased' AND lease_expires_at > ? THEN 1
             ELSE 0
           END), 0)
             AS processing_count
         FROM codex_chat_jobs
         WHERE conversation_id = ?`,
      )
      .bind(now, CONVERSATION_ID)
      .first<{ queued_count: number; processing_count: number }>(),
    db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS latest_sequence
         FROM codex_chat_messages
         WHERE conversation_id = ?`,
      )
      .bind(CONVERSATION_ID)
      .first<{ latest_sequence: number }>(),
    db
      .prepare(
        `SELECT id, status, created_at
         FROM codex_chat_jobs
         WHERE conversation_id = ? AND status IN ('queued', 'leased')
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .bind(CONVERSATION_ID, STATE_PENDING_JOB_LIMIT)
      .all<{ id: string; status: 'queued' | 'leased'; created_at: number }>(),
  ])

  const proposalState = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'proposed' THEN 1 ELSE 0 END), 0)
           AS proposal_count,
         COALESCE(MAX(updated_at), 0) AS latest_proposal_updated_at
       FROM codex_chat_action_proposals
       WHERE conversation_id = ?`,
    )
    .bind(CONVERSATION_ID)
    .first<{
      proposal_count: number
      latest_proposal_updated_at: number
    }>()

  return json(200, {
    conversation: conversation ? conversationResponse(conversation) : null,
    bridge: heartbeat
      ? {
          online: now - heartbeat.last_seen_at <= BRIDGE_ONLINE_WINDOW_MS,
          lastSeenAt: heartbeat.last_seen_at,
          status: heartbeat.status,
          bridgeVersion: heartbeat.bridge_version,
          model: heartbeat.model,
          activeJobId: heartbeat.active_job_id,
        }
      : null,
    counts: {
      queued: Number(counts?.queued_count ?? 0),
      processing: Number(counts?.processing_count ?? 0),
      proposed: Number(proposalState?.proposal_count ?? 0),
    },
    pendingJobs: (pendingJobs.results ?? []).map((job) => ({
      id: job.id,
      status: job.status,
      createdAt: job.created_at,
    })),
    latestMessageSequence: Number(latest?.latest_sequence ?? 0),
    latestProposalUpdatedAt: Number(
      proposalState?.latest_proposal_updated_at ?? 0,
    ),
  })
}

async function handleGetMessages(ctx: PagesContext): Promise<Response> {
  await maintainChatData(ctx.env.WORKOUT_DB, Date.now())
  const url = new URL(ctx.request.url)
  const rawAfter = url.searchParams.get('after') ?? '0'
  const rawLimit = url.searchParams.get('limit') ?? '50'
  const after = Number(rawAfter)
  const limit = Number(rawLimit)
  if (!Number.isInteger(after) || after < 0) {
    throw new ApiError(400, 'invalid_cursor')
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(400, 'invalid_limit', 'limit must be between 1 and 100')
  }

  const result = await ctx.env.WORKOUT_DB.prepare(
    `SELECT m.sequence, m.id, m.conversation_id, m.role, m.text,
            m.client_message_id, m.reasoning_effort, m.model, m.created_at,
            j.id AS job_id, j.status AS job_status
     FROM codex_chat_messages m
     LEFT JOIN codex_chat_jobs j
       ON j.user_message_id = m.id OR j.assistant_message_id = m.id
     WHERE m.conversation_id = ? AND m.sequence > ?
     ORDER BY m.sequence ASC
     LIMIT ?`,
  )
    .bind(CONVERSATION_ID, after, limit + 1)
    .all<MessageWithJobRow>()

  const allRows = result.results ?? []
  const hasMore = allRows.length > limit
  const rows = allRows.slice(0, limit)
  const nextCursor = rows.length > 0 ? rows[rows.length - 1].sequence : after
  const messageIds = new Set(rows.map((row) => row.id))

  let proposals: ProposalRow[] = []
  if (messageIds.size > 0) {
    const proposalResult = await ctx.env.WORKOUT_DB.prepare(
      `SELECT p.id, p.conversation_id, p.job_id, p.assistant_message_id,
              p.status, p.action_plan_json, p.result_json, p.created_at,
              p.updated_at, c.state_hash
       FROM codex_chat_action_proposals p
       JOIN codex_chat_jobs j ON j.id = p.job_id
       JOIN codex_chat_contexts c ON c.id = j.context_id
       JOIN codex_chat_messages m ON m.id = p.assistant_message_id
       WHERE p.conversation_id = ? AND m.sequence > ?
       ORDER BY m.sequence ASC
       LIMIT ?`,
    )
      .bind(CONVERSATION_ID, after, limit + 1)
      .all<ProposalRow>()
    proposals = (proposalResult.results ?? []).filter((proposal) =>
      messageIds.has(proposal.assistant_message_id),
    )
  }

  return json(200, {
    messages: rows.map(messageResponse),
    proposals: proposals.map(proposalResponse),
    nextCursor,
    hasMore,
  })
}

async function readMessageAndJobByClientId(
  db: D1Database,
  clientMessageId: string,
): Promise<
  | {
      message: MessageWithJobRow
      job: JobRow
      stateHash: string
      contextJson: string
    }
  | null
> {
  const row = await db
    .prepare(
      `SELECT m.sequence, m.id, m.conversation_id, m.role, m.text,
              m.client_message_id, m.reasoning_effort, m.model, m.created_at,
              j.id AS job_id, j.status AS job_status,
              c.state_hash, c.context_json
       FROM codex_chat_messages m
       JOIN codex_chat_jobs j ON j.user_message_id = m.id
       JOIN codex_chat_contexts c ON c.id = j.context_id
       WHERE m.conversation_id = ? AND m.client_message_id = ?`,
    )
    .bind(CONVERSATION_ID, clientMessageId)
    .first<MessageWithJobRow & { state_hash: string; context_json: string }>()
  if (!row || !row.job_id) return null
  const job = await readJob(db, row.job_id)
  if (!job) return null
  return {
    message: row,
    job,
    stateHash: row.state_hash,
    contextJson: row.context_json,
  }
}

async function handlePostMessage(ctx: PagesContext): Promise<Response> {
  const body = await readJsonBody(ctx.request)
  const clientMessageId = requiredString(
    body.clientMessageId,
    'clientMessageId',
    160,
  )
  if (!validClientMessageId(clientMessageId)) {
    throw new ApiError(400, 'invalid_client_message_id')
  }
  const text = requiredString(body.text, 'text', MAX_USER_TEXT_LENGTH)
  const reasoningEffort = assertReasoningEffort(body.reasoningEffort)
  const stateHash = requiredString(body.stateHash, 'stateHash', 64)
  if (!/^[a-f0-9]{64}$/.test(stateHash)) {
    throw new ApiError(
      400,
      'invalid_state_hash',
      'stateHash must be a 64-character lowercase SHA-256 hex digest',
    )
  }
  if (!isObject(body.context)) {
    throw new ApiError(400, 'invalid_context', 'context must be an object')
  }
  if (jsonByteLength(body.context) > MAX_CONTEXT_BYTES) {
    throw new ApiError(413, 'context_too_large')
  }
  const contextJson = JSON.stringify(body.context)

  const existing = await readMessageAndJobByClientId(
    ctx.env.WORKOUT_DB,
    clientMessageId,
  )
  if (existing) {
    if (
      existing.message.text !== text ||
      existing.message.reasoning_effort !== reasoningEffort ||
      existing.stateHash !== stateHash ||
      existing.contextJson !== contextJson
    ) {
      throw new ApiError(409, 'idempotency_conflict')
    }
    return json(200, {
      message: messageResponse(existing.message),
      job: jobResponse(existing.job),
      replayed: true,
    })
  }

  const digest = await sha256Hex(`${CONVERSATION_ID}:${clientMessageId}`)
  const contextId = `ctx_${digest}`
  const messageId = `msg_u_${digest}`
  const jobId = `job_${digest}`
  const now = Date.now()

  await ctx.env.WORKOUT_DB.batch([
    ctx.env.WORKOUT_DB.prepare(
      `INSERT INTO codex_chat_conversations
         (id, created_at, updated_at, codex_thread_id)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).bind(CONVERSATION_ID, now, now),
    ctx.env.WORKOUT_DB.prepare(
      `INSERT INTO codex_chat_contexts
         (id, conversation_id, state_hash, context_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(contextId, CONVERSATION_ID, stateHash, contextJson, now),
    ctx.env.WORKOUT_DB.prepare(
      `INSERT INTO codex_chat_messages
         (id, conversation_id, role, text, client_message_id,
          reasoning_effort, model, created_at)
       VALUES (?, ?, 'user', ?, ?, ?, NULL, ?)
       ON CONFLICT(conversation_id, client_message_id) DO NOTHING`,
    ).bind(
      messageId,
      CONVERSATION_ID,
      text,
      clientMessageId,
      reasoningEffort,
      now,
    ),
    ctx.env.WORKOUT_DB.prepare(
      `INSERT INTO codex_chat_jobs
         (id, conversation_id, user_message_id, assistant_message_id,
          context_id, reasoning_effort, status, attempts, max_attempts,
          available_at, worker_id, lease_token, lease_expires_at, claimed_at,
          completed_at, last_error, completion_hash, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, 'queued', 0, 3, ?, NULL, NULL, NULL,
               NULL, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(user_message_id) DO NOTHING`,
    ).bind(
      jobId,
      CONVERSATION_ID,
      messageId,
      contextId,
      reasoningEffort,
      now,
      now,
      now,
    ),
  ])

  const created = await readMessageAndJobByClientId(
    ctx.env.WORKOUT_DB,
    clientMessageId,
  )
  if (!created) throw new ApiError(500, 'message_enqueue_failed')
  if (
    created.message.text !== text ||
    created.message.reasoning_effort !== reasoningEffort ||
    created.stateHash !== stateHash ||
    created.contextJson !== contextJson
  ) {
    throw new ApiError(409, 'idempotency_conflict')
  }
  return json(202, {
    message: messageResponse(created.message),
    job: jobResponse(created.job),
    replayed: false,
  })
}

async function handleProposalResult(
  ctx: PagesContext,
  proposalId: string,
): Promise<Response> {
  if (!validOpaqueId(proposalId)) throw new ApiError(400, 'invalid_proposal_id')
  const body = await readJsonBody(ctx.request)
  if (body.status !== 'applied' && body.status !== 'failed') {
    throw new ApiError(
      400,
      'invalid_proposal_status',
      'status must be applied or failed',
    )
  }
  const failureError =
    body.status === 'failed'
      ? optionalString(body.error, 'error', 1000)
      : null
  let persistedResult = body.result
  if (failureError) {
    persistedResult = isObject(persistedResult)
      ? { ...persistedResult, error: failureError }
      : { ...(persistedResult === undefined ? {} : { result: persistedResult }), error: failureError }
  }
  if (
    persistedResult !== undefined &&
    jsonByteLength(persistedResult) > MAX_RESULT_BYTES
  ) {
    throw new ApiError(413, 'result_too_large')
  }
  const resultJson =
    persistedResult === undefined ? null : JSON.stringify(persistedResult)
  const existing = await readProposal(ctx.env.WORKOUT_DB, proposalId)
  if (!existing) throw new ApiError(404, 'proposal_not_found')
  if (existing.status !== 'proposed') {
    if (existing.status === body.status) {
      if (existing.result_json !== resultJson) {
        throw new ApiError(409, 'proposal_result_conflict')
      }
      return json(200, { proposal: proposalResponse(existing) })
    }
    throw new ApiError(409, 'proposal_already_resolved')
  }
  const now = Date.now()
  const result = await ctx.env.WORKOUT_DB.prepare(
    `UPDATE codex_chat_action_proposals
     SET status = ?, result_json = ?, updated_at = ?
     WHERE id = ? AND conversation_id = ? AND status = 'proposed'`,
  )
    .bind(body.status, resultJson, now, proposalId, CONVERSATION_ID)
    .run()
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new ApiError(409, 'proposal_already_resolved')
  }
  await ctx.env.WORKOUT_DB.prepare(
    `UPDATE codex_chat_conversations SET updated_at = ? WHERE id = ?`,
  )
    .bind(now, CONVERSATION_ID)
    .run()
  const proposal = await readProposal(ctx.env.WORKOUT_DB, proposalId)
  return json(200, { proposal: proposal ? proposalResponse(proposal) : null })
}

async function handleDismissProposal(
  ctx: PagesContext,
  proposalId: string,
): Promise<Response> {
  if (!validOpaqueId(proposalId)) throw new ApiError(400, 'invalid_proposal_id')
  const existing = await readProposal(ctx.env.WORKOUT_DB, proposalId)
  if (!existing) throw new ApiError(404, 'proposal_not_found')
  if (existing.status === 'dismissed') {
    return json(200, { proposal: proposalResponse(existing) })
  }
  if (existing.status !== 'proposed') {
    throw new ApiError(409, 'proposal_already_resolved')
  }
  const now = Date.now()
  const result = await ctx.env.WORKOUT_DB.prepare(
    `UPDATE codex_chat_action_proposals
     SET status = 'dismissed', updated_at = ?
     WHERE id = ? AND conversation_id = ? AND status = 'proposed'`,
  )
    .bind(now, proposalId, CONVERSATION_ID)
    .run()
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new ApiError(409, 'proposal_already_resolved')
  }
  const proposal = await readProposal(ctx.env.WORKOUT_DB, proposalId)
  return json(200, { proposal: proposal ? proposalResponse(proposal) : null })
}

async function handleCancelJob(
  ctx: PagesContext,
  jobId: string,
): Promise<Response> {
  if (!validOpaqueId(jobId)) throw new ApiError(400, 'invalid_job_id')
  const now = Date.now()
  const result = await ctx.env.WORKOUT_DB.prepare(
    `UPDATE codex_chat_jobs
     SET status = 'cancelled', worker_id = NULL, lease_token = NULL,
         lease_expires_at = NULL, claimed_at = NULL, completed_at = ?,
         last_error = NULL, completion_hash = NULL, updated_at = ?
     WHERE id = ? AND conversation_id = ?
       AND status IN ('queued', 'leased')`,
  )
    .bind(now, now, jobId, CONVERSATION_ID)
    .run()

  if ((result.meta?.changes ?? 0) !== 1) {
    const existing = await readJob(ctx.env.WORKOUT_DB, jobId)
    if (!existing || existing.conversation_id !== CONVERSATION_ID) {
      throw new ApiError(404, 'job_not_found')
    }
    if (existing.status === 'cancelled') {
      return json(200, { job: jobResponse(existing), replayed: true })
    }
    throw new ApiError(409, 'job_not_cancellable')
  }

  await ctx.env.WORKOUT_DB.batch([
    ctx.env.WORKOUT_DB.prepare(
      `UPDATE codex_chat_conversations
       SET updated_at = ?
       WHERE id = ?`,
    ).bind(now, CONVERSATION_ID),
    ctx.env.WORKOUT_DB.prepare(
      `UPDATE codex_chat_bridge_heartbeat
       SET status = CASE WHEN status = 'working' THEN 'idle' ELSE status END,
           active_job_id = NULL
       WHERE id = ? AND active_job_id = ?`,
    ).bind(CONVERSATION_ID, jobId),
  ])
  const cancelled = await readJob(ctx.env.WORKOUT_DB, jobId)
  return json(200, {
    job: cancelled ? jobResponse(cancelled) : null,
    replayed: false,
  })
}

async function handleDeleteConversation(db: D1Database): Promise<Response> {
  await db.batch([
    db
      .prepare(`DELETE FROM codex_chat_action_proposals WHERE conversation_id = ?`)
      .bind(CONVERSATION_ID),
    db
      .prepare(`DELETE FROM codex_chat_jobs WHERE conversation_id = ?`)
      .bind(CONVERSATION_ID),
    db
      .prepare(`DELETE FROM codex_chat_messages WHERE conversation_id = ?`)
      .bind(CONVERSATION_ID),
    db
      .prepare(`DELETE FROM codex_chat_contexts WHERE conversation_id = ?`)
      .bind(CONVERSATION_ID),
    db
      .prepare(`DELETE FROM codex_chat_conversations WHERE id = ?`)
      .bind(CONVERSATION_ID),
    db.prepare(
      `UPDATE codex_chat_bridge_heartbeat
       SET status = 'idle', active_job_id = NULL
       WHERE id = ?`,
    ).bind(CONVERSATION_ID),
  ])
  return json(200, { cleared: true, conversationId: CONVERSATION_ID })
}

async function handleHeartbeat(ctx: PagesContext): Promise<Response> {
  const body = await readJsonBody(ctx.request)
  const status = body.status ?? 'idle'
  if (status !== 'idle' && status !== 'working' && status !== 'error') {
    throw new ApiError(400, 'invalid_heartbeat_status')
  }
  const bridgeVersion = optionalString(body.bridgeVersion, 'bridgeVersion', 120)
  const model = optionalString(body.model, 'model', 120)
  const activeJobId = optionalString(body.activeJobId, 'activeJobId', 160)
  if (activeJobId && !validOpaqueId(activeJobId)) {
    throw new ApiError(400, 'invalid_active_job_id')
  }
  const now = Date.now()
  await ctx.env.WORKOUT_DB.prepare(
    `INSERT INTO codex_chat_bridge_heartbeat
       (id, last_seen_at, status, bridge_version, model, active_job_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       status = excluded.status,
       bridge_version = excluded.bridge_version,
       model = excluded.model,
       active_job_id = excluded.active_job_id`,
  )
    .bind(CONVERSATION_ID, now, status, bridgeVersion, model, activeJobId)
    .run()
  return json(200, {
    heartbeat: {
      lastSeenAt: now,
      status,
      bridgeVersion,
      model,
      activeJobId,
    },
  })
}

async function handleClaimJob(ctx: PagesContext): Promise<Response> {
  const body = await readJsonBody(ctx.request)
  const workerId = requiredString(body.workerId, 'workerId', 120)
  if (!validOpaqueId(workerId)) throw new ApiError(400, 'invalid_worker_id')
  const leaseDurationMs = boundedInteger(
    body.leaseDurationMs,
    DEFAULT_LEASE_MS,
    MIN_LEASE_MS,
    MAX_LEASE_MS,
    'leaseDurationMs',
  )
  const now = Date.now()
  await maintainChatData(ctx.env.WORKOUT_DB, now)

  let claimed: JobRow | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = await ctx.env.WORKOUT_DB.prepare(
      `SELECT id
       FROM codex_chat_jobs
       WHERE attempts < max_attempts
         AND status = 'queued'
         AND available_at <= ?
       ORDER BY created_at ASC
       LIMIT 1`,
    )
      .bind(now)
      .first<{ id: string }>()
    if (!candidate) break

    const leaseToken = crypto.randomUUID()
    const leaseExpiresAt = now + leaseDurationMs
    const update = await ctx.env.WORKOUT_DB.prepare(
      `UPDATE codex_chat_jobs
       SET status = 'leased', attempts = attempts + 1, worker_id = ?,
           lease_token = ?, lease_expires_at = ?, claimed_at = ?,
           updated_at = ?, last_error = NULL
       WHERE id = ? AND attempts < max_attempts
         AND status = 'queued'
         AND available_at <= ?`,
    )
      .bind(
        workerId,
        leaseToken,
        leaseExpiresAt,
        now,
        now,
        candidate.id,
        now,
      )
      .run()
    if ((update.meta?.changes ?? 0) === 1) {
      claimed = await readJob(ctx.env.WORKOUT_DB, candidate.id)
      break
    }
  }

  if (!claimed) return json(200, { job: null })
  const [context, conversation, userMessage] = await Promise.all([
    ctx.env.WORKOUT_DB.prepare(
      `SELECT id, conversation_id, state_hash, context_json, created_at
       FROM codex_chat_contexts WHERE id = ?`,
    )
      .bind(claimed.context_id)
      .first<ContextRow>(),
    readConversation(ctx.env.WORKOUT_DB),
    ctx.env.WORKOUT_DB.prepare(
      `SELECT sequence FROM codex_chat_messages WHERE id = ?`,
    )
      .bind(claimed.user_message_id)
      .first<{ sequence: number }>(),
  ])
  if (!context || !userMessage) {
    throw new ApiError(500, 'job_context_missing')
  }
  const transcriptResult = await ctx.env.WORKOUT_DB.prepare(
    `SELECT sequence, id, conversation_id, role, text, client_message_id,
            reasoning_effort, model, created_at
     FROM (
       SELECT sequence, id, conversation_id, role, text, client_message_id,
              reasoning_effort, model, created_at
       FROM codex_chat_messages
       WHERE conversation_id = ? AND sequence <= ?
       ORDER BY sequence DESC
       LIMIT ?
     )
     ORDER BY sequence ASC`,
  )
    .bind(CONVERSATION_ID, userMessage.sequence, TRANSCRIPT_LIMIT)
    .all<MessageRow>()

  return json(200, {
    job: {
      ...jobResponse(claimed) as Record<string, unknown>,
      leaseToken: claimed.lease_token,
    },
    context: {
      id: context.id,
      stateHash: context.state_hash,
      payload: parseJson(context.context_json),
      createdAt: context.created_at,
    },
    transcript: (transcriptResult.results ?? []).map(messageResponse),
    codexThreadId: conversation?.codex_thread_id ?? null,
  })
}

async function handleRenewLease(
  ctx: PagesContext,
  jobId: string,
): Promise<Response> {
  if (!validOpaqueId(jobId)) throw new ApiError(400, 'invalid_job_id')
  const body = await readJsonBody(ctx.request)
  const leaseToken = requiredString(body.leaseToken, 'leaseToken', 160)
  const leaseDurationMs = boundedInteger(
    body.leaseDurationMs,
    DEFAULT_LEASE_MS,
    MIN_LEASE_MS,
    MAX_LEASE_MS,
    'leaseDurationMs',
  )
  const now = Date.now()
  const leaseExpiresAt = now + leaseDurationMs
  const result = await ctx.env.WORKOUT_DB.prepare(
    `UPDATE codex_chat_jobs
     SET lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND status = 'leased' AND lease_token = ?
       AND lease_expires_at > ?`,
  )
    .bind(leaseExpiresAt, now, jobId, leaseToken, now)
    .run()
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new ApiError(409, 'lease_lost')
  }
  const job = await readJob(ctx.env.WORKOUT_DB, jobId)
  return json(200, { job: job ? jobResponse(job) : null })
}

async function completionResponse(
  db: D1Database,
  job: JobRow,
): Promise<Response> {
  const message = job.assistant_message_id
    ? await db
        .prepare(
          `SELECT m.sequence, m.id, m.conversation_id, m.role, m.text,
                  m.client_message_id, m.reasoning_effort, m.model,
                  m.created_at, j.id AS job_id, j.status AS job_status
           FROM codex_chat_messages m
           LEFT JOIN codex_chat_jobs j ON j.assistant_message_id = m.id
           WHERE m.id = ?`,
        )
        .bind(job.assistant_message_id)
        .first<MessageWithJobRow>()
    : null
  const proposal = await db
    .prepare(
      `SELECT p.id, p.conversation_id, p.job_id, p.assistant_message_id,
              p.status, p.action_plan_json, p.result_json, p.created_at,
              p.updated_at, c.state_hash
       FROM codex_chat_action_proposals p
       JOIN codex_chat_jobs j ON j.id = p.job_id
       JOIN codex_chat_contexts c ON c.id = j.context_id
       WHERE p.job_id = ?`,
    )
    .bind(job.id)
    .first<ProposalRow>()
  return json(200, {
    job: jobResponse(job),
    message: message ? messageResponse(message) : null,
    proposal: proposal ? proposalResponse(proposal) : null,
  })
}

async function handleCompleteJob(
  ctx: PagesContext,
  jobId: string,
): Promise<Response> {
  if (!validOpaqueId(jobId)) throw new ApiError(400, 'invalid_job_id')
  const body = await readJsonBody(ctx.request)
  const leaseToken = requiredString(body.leaseToken, 'leaseToken', 160)
  const assistantText = requiredString(
    body.assistantText,
    'assistantText',
    MAX_ASSISTANT_TEXT_LENGTH,
  )
  const model = requiredString(body.model, 'model', 120)
  const effort = assertReasoningEffort(body.effort)
  const codexThreadId = optionalString(body.codexThreadId, 'codexThreadId', 300)

  const job = await readJob(ctx.env.WORKOUT_DB, jobId)
  if (!job) throw new ApiError(404, 'job_not_found')
  if (job.reasoning_effort !== effort) {
    throw new ApiError(409, 'reasoning_effort_mismatch')
  }
  const context = await ctx.env.WORKOUT_DB.prepare(
    `SELECT id, conversation_id, state_hash, context_json, created_at
     FROM codex_chat_contexts WHERE id = ?`,
  )
    .bind(job.context_id)
    .first<ContextRow>()
  if (!context) throw new ApiError(500, 'job_context_missing')

  let actionPlan: Record<string, unknown> | null = null
  if (body.actionPlan !== undefined && body.actionPlan !== null) {
    if (!isObject(body.actionPlan)) {
      throw new ApiError(400, 'invalid_action_plan', 'actionPlan must be an object')
    }
    if (!isActionScope(body.actionPlan.scope)) {
      throw new ApiError(400, 'invalid_action_scope')
    }
    if (!validSha256Hex(context.state_hash)) {
      throw new ApiError(409, 'state_hash_unavailable')
    }
    actionPlan = {
      ...body.actionPlan,
      sourceStateHash: context.state_hash,
      sourceActionStateHash: trustedActionStateHash(
        context.context_json,
        body.actionPlan.scope,
      ),
    }
    if (jsonByteLength(actionPlan) > MAX_ACTION_PLAN_BYTES) {
      throw new ApiError(413, 'action_plan_too_large')
    }
  }
  const completionHash = await sha256Hex(
    JSON.stringify({ assistantText, model, effort, codexThreadId, actionPlan }),
  )

  if (job.status === 'completed') {
    if (
      job.lease_token === leaseToken &&
      job.completion_hash === completionHash
    ) {
      return completionResponse(ctx.env.WORKOUT_DB, job)
    }
    throw new ApiError(409, 'completion_conflict')
  }
  if (job.status !== 'leased' || job.lease_token !== leaseToken) {
    throw new ApiError(409, 'lease_lost')
  }
  if (job.lease_expires_at === null || job.lease_expires_at <= Date.now()) {
    throw new ApiError(409, 'lease_lost')
  }

  const assistantMessageId = `msg_a_${job.id}`
  const proposalId = `proposal_${job.id}`
  const now = Date.now()
  const statements = [
    ctx.env.WORKOUT_DB.prepare(
      `INSERT INTO codex_chat_messages
         (id, conversation_id, role, text, client_message_id,
          reasoning_effort, model, created_at)
       SELECT ?, ?, 'assistant', ?, NULL, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM codex_chat_jobs
         WHERE id = ? AND status = 'leased' AND lease_token = ?
           AND lease_expires_at > ?
       )
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      assistantMessageId,
      CONVERSATION_ID,
      assistantText,
      effort,
      model,
      now,
      job.id,
      leaseToken,
      now,
    ),
  ]
  if (actionPlan) {
    statements.push(
      ctx.env.WORKOUT_DB.prepare(
        `INSERT INTO codex_chat_action_proposals
           (id, conversation_id, job_id, assistant_message_id, status,
            action_plan_json, result_json, created_at, updated_at)
         SELECT ?, ?, ?, ?, 'proposed', ?, NULL, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM codex_chat_jobs
           WHERE id = ? AND status = 'leased' AND lease_token = ?
             AND lease_expires_at > ?
         )
         ON CONFLICT(job_id) DO NOTHING`,
      ).bind(
        proposalId,
        CONVERSATION_ID,
        job.id,
        assistantMessageId,
        JSON.stringify(actionPlan),
        now,
        now,
        job.id,
        leaseToken,
        now,
      ),
    )
  }
  statements.push(
    ctx.env.WORKOUT_DB.prepare(
      `UPDATE codex_chat_jobs
       SET status = 'completed', assistant_message_id = ?, completed_at = ?,
           updated_at = ?, completion_hash = ?
       WHERE id = ? AND status = 'leased' AND lease_token = ?
         AND lease_expires_at > ?`,
    ).bind(
      assistantMessageId,
      now,
      now,
      completionHash,
      job.id,
      leaseToken,
      now,
    ),
    ctx.env.WORKOUT_DB.prepare(
      `UPDATE codex_chat_conversations
       SET updated_at = ?, codex_thread_id = COALESCE(?, codex_thread_id)
       WHERE id = ? AND EXISTS (
         SELECT 1 FROM codex_chat_jobs
         WHERE id = ? AND status = 'completed' AND lease_token = ?
           AND completion_hash = ?
       )`,
    ).bind(
      now,
      codexThreadId,
      CONVERSATION_ID,
      job.id,
      leaseToken,
      completionHash,
    ),
  )
  await ctx.env.WORKOUT_DB.batch(statements)

  const completed = await readJob(ctx.env.WORKOUT_DB, job.id)
  if (
    !completed ||
    completed.status !== 'completed' ||
    completed.lease_token !== leaseToken ||
    completed.completion_hash !== completionHash ||
    completed.assistant_message_id !== assistantMessageId
  ) {
    throw new ApiError(409, 'lease_lost')
  }
  return completionResponse(ctx.env.WORKOUT_DB, completed)
}

async function handleFailJob(
  ctx: PagesContext,
  jobId: string,
): Promise<Response> {
  if (!validOpaqueId(jobId)) throw new ApiError(400, 'invalid_job_id')
  const body = await readJsonBody(ctx.request)
  const leaseToken = requiredString(body.leaseToken, 'leaseToken', 160)
  const error = requiredString(body.error, 'error', 1000)
  const retryable = body.retryable === true
  const retryAfterMs = boundedInteger(
    body.retryAfterMs,
    DEFAULT_RETRY_MS,
    0,
    MAX_RETRY_MS,
    'retryAfterMs',
  )
  const job = await readJob(ctx.env.WORKOUT_DB, jobId)
  if (!job) throw new ApiError(404, 'job_not_found')
  if (job.status !== 'leased' || job.lease_token !== leaseToken) {
    throw new ApiError(409, 'lease_lost')
  }
  const now = Date.now()
  if (job.lease_expires_at === null || job.lease_expires_at <= now) {
    throw new ApiError(409, 'lease_lost')
  }
  const shouldRetry = retryable && job.attempts < job.max_attempts
  const nextStatus: JobStatus = shouldRetry ? 'queued' : 'failed'
  const availableAt = shouldRetry ? now + retryAfterMs : job.available_at
  const result = await ctx.env.WORKOUT_DB.prepare(
    `UPDATE codex_chat_jobs
     SET status = ?, available_at = ?, worker_id = NULL, lease_token = NULL,
         lease_expires_at = NULL, claimed_at = NULL, completed_at = ?,
         last_error = ?, updated_at = ?
     WHERE id = ? AND status = 'leased' AND lease_token = ?
       AND lease_expires_at > ?`,
  )
    .bind(
      nextStatus,
      availableAt,
      shouldRetry ? null : now,
      error,
      now,
      job.id,
      leaseToken,
      now,
    )
    .run()
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new ApiError(409, 'lease_lost')
  }
  const updated = await readJob(ctx.env.WORKOUT_DB, job.id)
  return json(200, { job: updated ? jobResponse(updated) : null })
}

export const onRequest = async (ctx: PagesContext): Promise<Response> => {
  try {
    const path = routePath(ctx)
    const method = ctx.request.method.toUpperCase()
    const automationRoute = path.startsWith('automation/')
    if (automationRoute) {
      const authError = requireAutomationSecret(ctx.request, ctx.env)
      if (authError) return authError
    } else {
      const originError = requireSameOriginForMutation(ctx.request)
      if (originError) return originError
      const authError = await requireDeviceSession(ctx.request, ctx.env)
      if (authError) return authError
    }

    if (path === 'state' && method === 'GET') {
      return await handleGetState(ctx.env.WORKOUT_DB)
    }
    if (path === 'messages' && method === 'GET') {
      return await handleGetMessages(ctx)
    }
    if (path === 'messages' && method === 'POST') {
      return await handlePostMessage(ctx)
    }
    if (path === 'conversation' && method === 'DELETE') {
      return await handleDeleteConversation(ctx.env.WORKOUT_DB)
    }

    const proposalResultMatch = path.match(/^proposals\/([^/]+)\/result$/)
    if (proposalResultMatch && method === 'POST') {
      return await handleProposalResult(ctx, proposalResultMatch[1])
    }
    const proposalDismissMatch = path.match(/^proposals\/([^/]+)\/dismiss$/)
    if (proposalDismissMatch && method === 'POST') {
      return await handleDismissProposal(ctx, proposalDismissMatch[1])
    }
    const cancelMatch = path.match(/^jobs\/([^/]+)\/cancel$/)
    if (cancelMatch && method === 'POST') {
      return await handleCancelJob(ctx, cancelMatch[1])
    }

    if (path === 'automation/heartbeat' && method === 'POST') {
      return await handleHeartbeat(ctx)
    }
    if (path === 'automation/jobs/claim' && method === 'POST') {
      return await handleClaimJob(ctx)
    }
    const leaseMatch = path.match(/^automation\/jobs\/([^/]+)\/lease$/)
    if (leaseMatch && method === 'POST') {
      return await handleRenewLease(ctx, leaseMatch[1])
    }
    const completeMatch = path.match(/^automation\/jobs\/([^/]+)\/complete$/)
    if (completeMatch && method === 'POST') {
      return await handleCompleteJob(ctx, completeMatch[1])
    }
    const failMatch = path.match(/^automation\/jobs\/([^/]+)\/fail$/)
    if (failMatch && method === 'POST') {
      return await handleFailJob(ctx, failMatch[1])
    }

    return json(404, { error: 'not_found' })
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status >= 500) {
        console.error('chat api failure', error)
        return json(500, { error: 'internal_error' })
      }
      return json(error.status, {
        error: error.code,
        ...(error.detail ? { detail: error.detail } : {}),
      })
    }
    console.error('chat api failure', error)
    return json(500, { error: 'internal_error' })
  }
}
