// Cloudflare Pages Function for the single-user cloud mirror.
// The paired phone writes full export snapshots; laptop Codex reads snapshots
// and writes one fixed daily briefing per America/Los_Angeles date.

import {
  readCloudSession,
  requireAutomationSecret,
  requireCloudAuth,
  requireDeviceSession,
  sha256Hex,
  type D1Database,
  type D1PreparedStatement,
} from '../../lib/cloudAuth'

type Mode = 'push' | 'normal' | 'light' | 'deload' | 'rest'
type MemoryType = 'workout' | 'two_week' | 'four_month'

interface Env {
  CLOUD_AUTOMATION_SECRET?: string
  WORKOUT_DB: D1Database
}

interface PagesContext {
  request: Request
  env: Env
  params: { path?: string | string[] }
}

interface SnapshotRow {
  id: string
  created_at: number
  updated_at: number
  source_device: string
  schema_version: number
  payload_json: string
}

interface BriefingRow {
  briefing_date: string
  created_at: number
  source: string
  snapshot_updated_at: number
  headline: string
  mode: Mode
  sections_json: string
  model: string
  input_summary_json: string | null
}

interface MemoryStateRow {
  id: string
  updated_at: number
  current_context: string
  paused: 0 | 1
  window_started_at: number
  four_month_started_at: number
  source_snapshot_updated_at: number | null
}

interface MemoryItemRow {
  id: string
  memory_type: MemoryType
  period_start_at: number
  period_end_at: number
  source_workout_session_id: string | null
  bullets_json: string
  source_session_ids_json: string
  source_note_ids_json: string
  source_summary_ids_json: string
  model: string
  created_at: number
  updated_at: number
  snapshot_updated_at: number | null
}

interface PublishRevisionRow {
  revision: number
  publish_token: string
  write_token: string
}

interface PublishReceiptRow {
  publish_id: string
  revision: number
  publish_fingerprint: string
  briefing_date: string
  briefing_created_at: number
  briefing_source: string
  briefing_snapshot_updated_at: number
  headline: string
  mode: Mode
  sections_json: string
  model: string
  input_summary_json: string | null
  memory_updated_at: number
  current_context: string
  paused: 0 | 1
  window_started_at: number
  four_month_started_at: number
  memory_snapshot_updated_at: number | null
}

const PUBLISH_RECEIPT_SELECT = `
  SELECT publish_id, committed_memory_revision AS revision, publish_fingerprint,
         briefing_date, briefing_created_at, briefing_source,
         briefing_snapshot_updated_at, headline, mode, sections_json, model,
         input_summary_json, memory_updated_at, current_context, paused,
         window_started_at, four_month_started_at, memory_snapshot_updated_at
  FROM codex_publish_receipts
  WHERE publish_id = ?
    AND publish_fingerprint = ?
    AND briefing_date = ?
    AND expected_snapshot_updated_at = ?
    AND base_memory_revision = ?`

const SNAPSHOT_ID = 'primary'
const MEMORY_STATE_ID = 'primary'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const COACH_PROTOCOL_HEADER = 'X-Coach-Protocol'
const COACH_PROTOCOL = 'proposal-reservation-v1'
const SNAPSHOT_TRIGGER_HEADER = 'X-Snapshot-Trigger'
const CHAT_ACTION_SNAPSHOT_TRIGGER = 'chat_action_applied'
const SNAPSHOT_BASE_UPDATED_AT_HEADER = 'X-Snapshot-Base-Updated-At'
const SNAPSHOT_BASE_MISSING = 'none'
const COACH_RESERVATION_KIND = 'coach_apply_reservation_v1'
const MAX_ACTIVE_COACH_RESERVATIONS = 100
const MAX_COACH_RESERVATION_JSON_BYTES = 2_048
// D1 caps a string/BLOB/row at 2,000,000 bytes. Leave room for the row's other
// columns so every body accepted here can be persisted instead of failing with
// SQLITE_TOOBIG. A normal single-user export is far below this threshold.
export const MAX_BODY_BYTES = 1_900_000

export class PayloadTooLargeError extends Error {
  constructor() {
    super('payload_too_large')
    this.name = 'PayloadTooLargeError'
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

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isMode(v: unknown): v is Mode {
  return (
    v === 'push' ||
    v === 'normal' ||
    v === 'light' ||
    v === 'deload' ||
    v === 'rest'
  )
}

function isMemoryType(v: unknown): v is MemoryType {
  return v === 'workout' || v === 'two_week' || v === 'four_month'
}

function assertTrimmedString(
  value: unknown,
  field: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const trimmed = value.trim()
  if (!allowEmpty && !trimmed) throw new Error(`${field} must not be empty`)
  if (trimmed.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`)
  }
  return trimmed
}

function assertTrimmedStringArray(
  value: unknown,
  field: string,
  itemMaxLength: number,
): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value.map((item, index) =>
    assertTrimmedString(item, `${field}[${index}]`, itemMaxLength),
  )
}

export function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const [yearText, monthText, dayText] = value.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  if (month < 1 || month > 12 || day < 1) return false
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  return day <= (daysInMonth[month - 1] ?? 0)
}

function routePath(ctx: PagesContext): string {
  const raw = ctx.params.path
  return Array.isArray(raw) ? raw.join('/') : (raw ?? '')
}

function requireSameOriginForMutation(request: Request): Response | null {
  const origin = request.headers.get('origin')
  if (!origin) return null
  try {
    if (new URL(origin).origin === new URL(request.url).origin) return null
  } catch {
    // Malformed and opaque origins are not valid for cookie-authenticated writes.
  }
  return json(403, { error: 'cross_origin_request_rejected' })
}

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (isObject(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function comparableSnapshotReceiptResult(
  result: Record<string, unknown>,
): string {
  const comparable = { ...result }
  // These fields describe transport/idempotent replay, not the mutation that
  // the durable receipt proves. All other result fields must remain immutable.
  delete comparable.syncPending
  delete comparable.replayed
  return canonicalJson(comparable)
}

interface CoachReservationRow {
  id: string
  result_json: string
  action_plan_json: string
}

interface CoachReservation {
  id: string
  ownerSessionId: string
  sourceStateHash: string
  sourceActionStateHash: string
}

type SnapshotUploadMode = 'normal' | 'chat_action'

class CoachReservationStateError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CoachReservationStateError'
  }
}

function snapshotUploadMode(request: Request): SnapshotUploadMode {
  const protocol = request.headers.get(COACH_PROTOCOL_HEADER)
  const trigger = request.headers.get(SNAPSHOT_TRIGGER_HEADER)
  if (protocol === null && trigger === null) return 'normal'
  if (
    protocol?.trim() === COACH_PROTOCOL &&
    trigger?.trim() === CHAT_ACTION_SNAPSHOT_TRIGGER
  ) {
    return 'chat_action'
  }
  throw new CoachReservationStateError('coach_snapshot_protocol_invalid')
}

function parseCoachReservation(row: CoachReservationRow): CoachReservation {
  if (
    typeof row.id !== 'string' ||
    !row.id ||
    row.id.length > 200 ||
    typeof row.result_json !== 'string' ||
    typeof row.action_plan_json !== 'string' ||
    new TextEncoder().encode(row.result_json).byteLength >
      MAX_COACH_RESERVATION_JSON_BYTES
  ) {
    throw new CoachReservationStateError(
      'coach_action_reservation_state_invalid',
    )
  }
  const parsed = parseJson(row.result_json)
  const actionPlan = parseJson(row.action_plan_json)
  if (
    !isObject(parsed) ||
    parsed._kind !== COACH_RESERVATION_KIND ||
    typeof parsed.ownerSessionId !== 'string' ||
    !parsed.ownerSessionId ||
    parsed.ownerSessionId.length > 200 ||
    typeof parsed.reservedAt !== 'number' ||
    !Number.isSafeInteger(parsed.reservedAt) ||
    parsed.reservedAt < 0 ||
    !isObject(actionPlan) ||
    typeof actionPlan.sourceStateHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(actionPlan.sourceStateHash) ||
    typeof actionPlan.sourceActionStateHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(actionPlan.sourceActionStateHash)
  ) {
    throw new CoachReservationStateError(
      'coach_action_reservation_state_invalid',
    )
  }
  return {
    id: row.id,
    ownerSessionId: parsed.ownerSessionId,
    sourceStateHash: actionPlan.sourceStateHash,
    sourceActionStateHash: actionPlan.sourceActionStateHash,
  }
}

async function readActiveCoachReservations(
  db: D1Database,
): Promise<CoachReservation[]> {
  const result = await db
    .prepare(
      `SELECT id, result_json, action_plan_json
       FROM codex_chat_action_proposals
       WHERE status = 'proposed' AND result_json IS NOT NULL
       ORDER BY created_at, id
       LIMIT ?`,
    )
    .bind(MAX_ACTIVE_COACH_RESERVATIONS + 1)
    .all<CoachReservationRow>()
  const rows = result.results ?? []
  if (rows.length > MAX_ACTIVE_COACH_RESERVATIONS) {
    throw new CoachReservationStateError(
      'coach_action_reservation_state_unavailable',
    )
  }
  return rows.map(parseCoachReservation)
}

function snapshotBaseUpdatedAt(request: Request): number | null {
  const raw = request.headers.get(SNAPSHOT_BASE_UPDATED_AT_HEADER)?.trim()
  if (!raw) {
    throw new CoachReservationStateError('snapshot_version_required')
  }
  if (raw === SNAPSHOT_BASE_MISSING) return null
  if (!/^\d+$/.test(raw)) {
    throw new CoachReservationStateError('snapshot_version_invalid')
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CoachReservationStateError('snapshot_version_invalid')
  }
  return parsed
}

function readSnapshotReceiptProofs(
  raw: unknown,
  required: boolean,
): Map<
  string,
  {
    sourceStateHash: string
    sourceActionStateHash?: string
    comparableResult: string
  }
> {
  if (!isObject(raw) || !isObject(raw.data)) {
    throw new CoachReservationStateError(
      'coach_action_snapshot_receipt_invalid',
    )
  }
  const rawReceipts = raw.data.chatActionReceipts
  if (!Array.isArray(rawReceipts)) {
    if (!required && rawReceipts === undefined) return new Map()
    throw new CoachReservationStateError(
      'coach_action_snapshot_receipt_missing',
    )
  }
  const receipts = new Map<
    string,
    {
      sourceStateHash: string
      sourceActionStateHash?: string
      comparableResult: string
    }
  >()
  for (const rawReceipt of rawReceipts) {
    if (
      !isObject(rawReceipt) ||
      typeof rawReceipt.proposalId !== 'string' ||
      !rawReceipt.proposalId ||
      rawReceipt.proposalId.length > 200 ||
      typeof rawReceipt.appliedAt !== 'number' ||
      !Number.isSafeInteger(rawReceipt.appliedAt) ||
      rawReceipt.appliedAt < 0 ||
      typeof rawReceipt.sourceStateHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(rawReceipt.sourceStateHash) ||
      typeof rawReceipt.resultJson !== 'string' ||
      rawReceipt.resultJson.length > 100_000 ||
      receipts.has(rawReceipt.proposalId)
    ) {
      throw new CoachReservationStateError(
        'coach_action_snapshot_receipt_invalid',
      )
    }
    const result = parseJson(rawReceipt.resultJson)
    if (
      !isObject(result) ||
      result.proposalId !== rawReceipt.proposalId ||
      result.appliedAt !== rawReceipt.appliedAt ||
      result.sourceStateHash !== rawReceipt.sourceStateHash ||
      (result.sourceActionStateHash !== undefined &&
        (typeof result.sourceActionStateHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(result.sourceActionStateHash)))
    ) {
      throw new CoachReservationStateError(
        'coach_action_snapshot_receipt_invalid',
      )
    }
    receipts.set(rawReceipt.proposalId, {
      sourceStateHash: rawReceipt.sourceStateHash,
      comparableResult: comparableSnapshotReceiptResult(result),
      ...(typeof result.sourceActionStateHash === 'string'
        ? { sourceActionStateHash: result.sourceActionStateHash }
        : {}),
    })
  }
  return receipts
}

function assertChatActionSnapshotReceipts(
  raw: unknown,
  reservations: CoachReservation[],
): void {
  const receipts = readSnapshotReceiptProofs(raw, true)
  for (const reservation of reservations) {
    const receipt = receipts.get(reservation.id)
    if (!receipt) {
      throw new CoachReservationStateError(
        'coach_action_snapshot_receipt_missing',
      )
    }
    if (
      receipt.sourceStateHash !== reservation.sourceStateHash ||
      (receipt.sourceActionStateHash !== undefined &&
        receipt.sourceActionStateHash !== reservation.sourceActionStateHash)
    ) {
      throw new CoachReservationStateError(
        'coach_action_snapshot_receipt_mismatch',
      )
    }
  }
}

function assertSnapshotReceiptHistoryPreserved(
  previous: unknown | null,
  next: unknown,
): void {
  if (previous === null) return
  let previousReceipts: Map<
    string,
    {
      sourceStateHash: string
      sourceActionStateHash?: string
      comparableResult: string
    }
  >
  let nextReceipts: Map<
    string,
    {
      sourceStateHash: string
      sourceActionStateHash?: string
      comparableResult: string
    }
  >
  try {
    previousReceipts = readSnapshotReceiptProofs(previous, false)
    nextReceipts = readSnapshotReceiptProofs(next, false)
  } catch {
    throw new CoachReservationStateError('snapshot_receipt_history_invalid')
  }
  for (const [proposalId, previousReceipt] of previousReceipts) {
    const nextReceipt = nextReceipts.get(proposalId)
    if (
      !nextReceipt ||
      nextReceipt.sourceStateHash !== previousReceipt.sourceStateHash ||
      nextReceipt.comparableResult !== previousReceipt.comparableResult ||
      (previousReceipt.sourceActionStateHash !== undefined &&
        nextReceipt.sourceActionStateHash !== previousReceipt.sourceActionStateHash)
    ) {
      throw new CoachReservationStateError('snapshot_receipt_history_changed')
    }
  }
}

function reservationConflict(code: string): Response {
  return json(409, { error: code })
}

function assertExportPayload(raw: unknown): { schemaVersion: number } {
  if (!isObject(raw)) throw new Error('payload must be an object')
  if (typeof raw.schemaVersion !== 'number') {
    throw new Error('schemaVersion must be a number')
  }
  if (!isObject(raw.data)) throw new Error('data must be an object')
  const required = [
    'exercises',
    'programs',
    'sessionTemplates',
    'templateExercises',
    'workoutSessions',
    'loggedSets',
  ]
  for (const table of required) {
    if (!Array.isArray(raw.data[table])) {
      throw new Error(`${table} must be an array`)
    }
  }
  return { schemaVersion: raw.schemaVersion }
}

function snapshotResponse(row: SnapshotRow): unknown {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceDevice: row.source_device,
    schemaVersion: row.schema_version,
    payload: parseJson(row.payload_json),
  }
}

function briefingResponse(row: BriefingRow): unknown {
  return {
    briefingDate: row.briefing_date,
    createdAt: row.created_at,
    source: row.source,
    snapshotUpdatedAt: row.snapshot_updated_at,
    headline: row.headline,
    mode: row.mode,
    sections: parseJson(row.sections_json),
    model: row.model,
    inputSummary: row.input_summary_json
      ? parseJson(row.input_summary_json)
      : null,
  }
}

function memoryStateResponse(row: MemoryStateRow): unknown {
  return {
    updatedAt: row.updated_at,
    currentContext: row.current_context,
    paused: row.paused === 1,
    windowStartedAt: row.window_started_at,
    fourMonthStartedAt: row.four_month_started_at,
    sourceSnapshotUpdatedAt: row.source_snapshot_updated_at,
  }
}

function memoryItemResponse(row: MemoryItemRow): unknown {
  return {
    id: row.id,
    memoryType: row.memory_type,
    periodStartAt: row.period_start_at,
    periodEndAt: row.period_end_at,
    sourceWorkoutSessionId: row.source_workout_session_id,
    bullets: parseJson(row.bullets_json),
    sourceSessionIds: parseJson(row.source_session_ids_json),
    sourceNoteIds: parseJson(row.source_note_ids_json),
    sourceSummaryIds: parseJson(row.source_summary_ids_json),
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    snapshotUpdatedAt: row.snapshot_updated_at,
  }
}

async function readSnapshot(db: D1Database): Promise<SnapshotRow | null> {
  return db
    .prepare(
      `SELECT id, created_at, updated_at, source_device, schema_version, payload_json
       FROM workout_snapshots
       WHERE id = ?`,
    )
    .bind(SNAPSHOT_ID)
    .first<SnapshotRow>()
}

async function readSnapshotUpdatedAt(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT updated_at
       FROM workout_snapshots
       WHERE id = ?`,
    )
    .bind(SNAPSHOT_ID)
    .first<{ updated_at: number }>()
  return row?.updated_at ?? null
}

async function handleGetSnapshot(db: D1Database): Promise<Response> {
  const row = await readSnapshot(db)
  if (!row) return json(404, { error: 'snapshot_not_found' })
  return json(200, { snapshot: snapshotResponse(row) })
}

export async function readJsonBodyWithLimit(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<unknown> {
  const declaredHeader = request.headers.get('content-length')
  if (declaredHeader !== null) {
    const declaredLength = Number(declaredHeader)
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new PayloadTooLargeError()
    }
  }

  const reader = request.body?.getReader()
  if (!reader) return JSON.parse('') as unknown
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          // The response is already fixed at 413; cancellation is best effort.
        }
        throw new PayloadTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

async function handlePutSnapshot(ctx: PagesContext): Promise<Response> {
  const session = await readCloudSession(ctx.request, ctx.env)
  if (!session) return json(401, { error: 'unauthorized' })

  let uploadMode: SnapshotUploadMode
  let reservations: CoachReservation[]
  let expectedSnapshotUpdatedAt: number | null
  let currentSnapshot: SnapshotRow | null
  try {
    uploadMode = snapshotUploadMode(ctx.request)
    expectedSnapshotUpdatedAt = snapshotBaseUpdatedAt(ctx.request)
    ;[reservations, currentSnapshot] = await Promise.all([
      readActiveCoachReservations(ctx.env.WORKOUT_DB),
      readSnapshot(ctx.env.WORKOUT_DB),
    ])
  } catch (err) {
    if (err instanceof CoachReservationStateError) {
      return reservationConflict(err.code)
    }
    throw err
  }
  if ((currentSnapshot?.updated_at ?? null) !== expectedSnapshotUpdatedAt) {
    return reservationConflict('snapshot_version_changed')
  }

  if (uploadMode === 'normal' && reservations.length > 0) {
    return reservationConflict('coach_action_reservation_required')
  }
  if (uploadMode === 'chat_action') {
    if (reservations.length === 0) {
      return reservationConflict('coach_action_reservation_required')
    }
    if (
      reservations.some(
        (reservation) => reservation.ownerSessionId !== session.id,
      )
    ) {
      return reservationConflict(
        'coach_action_reservation_owned_by_another_device',
      )
    }
  }

  let body: unknown
  try {
    body = await readJsonBodyWithLimit(ctx.request)
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return json(413, { error: 'payload_too_large' })
    }
    return json(400, { error: 'invalid_json' })
  }

  let schemaVersion: number
  try {
    schemaVersion = assertExportPayload(body).schemaVersion
  } catch (err) {
    return json(400, {
      error: 'invalid_snapshot',
      detail: err instanceof Error ? err.message : String(err),
    })
  }
  if (uploadMode === 'chat_action') {
    try {
      assertChatActionSnapshotReceipts(body, reservations)
    } catch (err) {
      if (err instanceof CoachReservationStateError) {
        return reservationConflict(err.code)
      }
      throw err
    }
  }
  try {
    const previousPayload = currentSnapshot
      ? parseJson(currentSnapshot.payload_json)
      : null
    if (currentSnapshot && previousPayload === null) {
      throw new CoachReservationStateError('snapshot_receipt_history_invalid')
    }
    assertSnapshotReceiptHistoryPreserved(
      previousPayload,
      body,
    )
  } catch (err) {
    if (err instanceof CoachReservationStateError) {
      return reservationConflict(err.code)
    }
    throw err
  }

  const now = Date.now()
  const sourceDevice =
    ctx.request.headers.get('X-Source-Device')?.trim().slice(0, 80) || 'phone'
  const reservationWriteGuard =
    uploadMode === 'chat_action'
      ? `(SELECT COUNT(*)
           FROM codex_chat_action_proposals reserved
           WHERE reserved.status = 'proposed'
             AND reserved.result_json IS NOT NULL
         ) = ?
         AND NOT EXISTS (
           SELECT 1
           FROM codex_chat_action_proposals reserved
           WHERE reserved.status = 'proposed'
             AND reserved.result_json IS NOT NULL
             AND reserved.id NOT IN (${reservations.map(() => '?').join(', ')})
         )
         AND NOT EXISTS (
           SELECT 1
           FROM codex_chat_action_proposals reserved
           WHERE reserved.status = 'proposed'
             AND reserved.result_json IS NOT NULL
             AND CASE
               WHEN json_valid(reserved.result_json) THEN
                 json_extract(reserved.result_json, '$._kind') = ?
                 AND json_type(reserved.result_json, '$.ownerSessionId') = 'text'
                 AND json_extract(reserved.result_json, '$.ownerSessionId') = ?
                 AND json_type(reserved.result_json, '$.reservedAt') = 'integer'
                 AND json_extract(reserved.result_json, '$.reservedAt') >= 0
               ELSE 0
             END = 0
         )`
      : `NOT EXISTS (
           SELECT 1
           FROM codex_chat_action_proposals reserved
           WHERE reserved.status = 'proposed'
             AND reserved.result_json IS NOT NULL
         )`
  const reservationWriteValues =
    uploadMode === 'chat_action'
      ? ([
          reservations.length,
          ...reservations.map((reservation) => reservation.id),
          COACH_RESERVATION_KIND,
          session.id,
        ] as const)
      : ([] as const)
  const snapshotVersionWriteGuard =
    expectedSnapshotUpdatedAt === null
      ? `NOT EXISTS (
           SELECT 1 FROM workout_snapshots current_snapshot WHERE current_snapshot.id = ?
         )`
      : `EXISTS (
           SELECT 1
           FROM workout_snapshots current_snapshot
           WHERE current_snapshot.id = ? AND current_snapshot.updated_at = ?
         )`
  const snapshotVersionWriteValues =
    expectedSnapshotUpdatedAt === null
      ? ([SNAPSHOT_ID] as const)
      : ([SNAPSHOT_ID, expectedSnapshotUpdatedAt] as const)
  const writeResult = await ctx.env.WORKOUT_DB.prepare(
    `INSERT INTO workout_snapshots
       (id, created_at, updated_at, source_device, schema_version, payload_json)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE (${reservationWriteGuard})
       AND (${snapshotVersionWriteGuard})
     ON CONFLICT(id) DO UPDATE SET
       updated_at = CASE
         WHEN workout_snapshots.updated_at >= excluded.updated_at
           THEN workout_snapshots.updated_at + 1
         ELSE excluded.updated_at
       END,
       source_device = excluded.source_device,
       schema_version = excluded.schema_version,
       payload_json = excluded.payload_json`,
  )
    .bind(
      SNAPSHOT_ID,
      now,
      now,
      sourceDevice,
      schemaVersion,
      JSON.stringify(body),
      ...reservationWriteValues,
      ...snapshotVersionWriteValues,
    )
    .run()

  // The conditional write closes the check/write race: if a reservation was
  // created, finalized, corrupted, or transferred after preflight, this upload
  // must be retried from fresh Coach state instead of publishing stale data.
  if ((writeResult.meta?.changes ?? 0) !== 1) {
    const latestSnapshotUpdatedAt = await readSnapshotUpdatedAt(
      ctx.env.WORKOUT_DB,
    )
    if (latestSnapshotUpdatedAt !== expectedSnapshotUpdatedAt) {
      return reservationConflict('snapshot_version_changed')
    }
    return reservationConflict('coach_action_reservation_changed')
  }

  const row = await readSnapshot(ctx.env.WORKOUT_DB)
  return json(200, { snapshot: row ? snapshotResponse(row) : null })
}

export function assertBriefingSections(raw: unknown): string {
  if (!isObject(raw)) throw new Error('sections must be an object')
  // Keep the cloud envelope backward-compatible with installed runner
  // rollbacks. The current model schema and supervisor enforce tighter copy
  // limits before publishing.
  const todaysCall = assertTrimmedString(
    raw.todaysCall,
    'sections.todaysCall',
    600,
  )
  const why = assertTrimmedStringArray(raw.why, 'sections.why', 400)
  const recoveryStatus = raw.recoveryStatus
  const ouraRecovery = assertTrimmedString(
    raw.ouraRecovery,
    'sections.ouraRecovery',
    500,
  )
  const trainingTrend = assertTrimmedString(
    raw.trainingTrend,
    'sections.trainingTrend',
    500,
  )
  const watchOuts = assertTrimmedStringArray(
    raw.watchOuts,
    'sections.watchOuts',
    400,
  )
  if (why.length < 1 || why.length > 3) {
    throw new Error('sections.why must have 1-3 items')
  }
  if (watchOuts.length > 3) {
    throw new Error('sections.watchOuts must have at most 3 items')
  }
  if (
    recoveryStatus !== undefined &&
    recoveryStatus !== 'fresh' &&
    recoveryStatus !== 'stale' &&
    recoveryStatus !== 'unavailable'
  ) {
    throw new Error('sections.recoveryStatus must be fresh, stale, or unavailable')
  }
  return JSON.stringify({
    todaysCall,
    why,
    ...(recoveryStatus ? { recoveryStatus } : {}),
    ouraRecovery,
    trainingTrend,
    watchOuts,
  })
}

async function readBriefing(
  db: D1Database,
  date: string,
): Promise<BriefingRow | null> {
  return db
    .prepare(
      `SELECT briefing_date, created_at, source, snapshot_updated_at, headline,
              mode, sections_json, model, input_summary_json
       FROM daily_briefings
       WHERE briefing_date = ?`,
    )
    .bind(date)
    .first<BriefingRow>()
}

async function handleGetBriefing(
  db: D1Database,
  date: string,
): Promise<Response> {
  if (!isCalendarDate(date)) return json(400, { error: 'invalid_date' })
  const row = await readBriefing(db, date)
  if (!row) return json(404, { error: 'briefing_not_found' })
  return json(200, { briefing: briefingResponse(row) })
}

async function handleGetLatestBriefing(db: D1Database): Promise<Response> {
  const row = await db
    .prepare(
      `SELECT briefing_date, created_at, source, snapshot_updated_at, headline,
              mode, sections_json, model, input_summary_json
       FROM daily_briefings
       ORDER BY briefing_date DESC
       LIMIT 1`,
    )
    .first<BriefingRow>()
  if (!row) return json(404, { error: 'briefing_not_found' })
  return json(200, { briefing: briefingResponse(row) })
}

async function handlePutBriefing(
  ctx: PagesContext,
  date: string,
): Promise<Response> {
  if (!isCalendarDate(date)) return json(400, { error: 'invalid_date' })

  let body: unknown
  try {
    body = await ctx.request.json()
  } catch {
    return json(400, { error: 'invalid_json' })
  }
  if (!isObject(body)) return json(400, { error: 'invalid_briefing' })

  const mode = body.mode
  const snapshotUpdatedAt = body.snapshotUpdatedAt
  let headline: string
  let model: string
  let source = 'codex'
  try {
    headline = assertTrimmedString(body.headline, 'headline', 200)
    model = assertTrimmedString(body.model, 'model', 120)
    if (body.source !== undefined) {
      source = assertTrimmedString(body.source, 'source', 80)
    }
  } catch (err) {
    return json(400, {
      error: 'invalid_briefing',
      detail: err instanceof Error ? err.message : String(err),
    })
  }
  if (!isMode(mode)) return json(400, { error: 'invalid_mode' })
  if (typeof snapshotUpdatedAt !== 'number' || !Number.isFinite(snapshotUpdatedAt)) {
    return json(400, { error: 'snapshotUpdatedAt_required' })
  }
  if (
    body.inputSummary !== undefined &&
    body.inputSummary !== null &&
    !isObject(body.inputSummary)
  ) {
    return json(400, { error: 'invalid_input_summary' })
  }

  let sectionsJson: string
  try {
    sectionsJson = assertBriefingSections(body.sections)
  } catch (err) {
    return json(400, {
      error: 'invalid_sections',
      detail: err instanceof Error ? err.message : String(err),
    })
  }

  const existing = await readBriefing(ctx.env.WORKOUT_DB, date)

  const inputSummaryJson =
    body.inputSummary === undefined ? null : JSON.stringify(body.inputSummary)
  const createdAt = Date.now()

  // Idempotent PUT: a retried or corrected briefing for the same date replaces
  // the existing one rather than failing with 409 (which previously stranded a
  // bad briefing until a manual DB edit). created_at is preserved on update.
  await ctx.env.WORKOUT_DB.prepare(
    `INSERT INTO daily_briefings
       (briefing_date, created_at, source, snapshot_updated_at, headline,
        mode, sections_json, model, input_summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(briefing_date) DO UPDATE SET
       source = excluded.source,
       snapshot_updated_at = excluded.snapshot_updated_at,
       headline = excluded.headline,
       mode = excluded.mode,
       sections_json = excluded.sections_json,
       model = excluded.model,
       input_summary_json = excluded.input_summary_json`,
  )
    .bind(
      date,
      createdAt,
      source,
      snapshotUpdatedAt,
      headline,
      mode,
      sectionsJson,
      model,
      inputSummaryJson,
    )
    .run()

  const row = await readBriefing(ctx.env.WORKOUT_DB, date)
  return json(existing ? 200 : 201, { briefing: row ? briefingResponse(row) : null })
}

async function readMemoryState(
  db: D1Database,
): Promise<MemoryStateRow | null> {
  return db
    .prepare(
      `SELECT id, updated_at, current_context, paused, window_started_at,
              four_month_started_at, source_snapshot_updated_at
       FROM codex_memory_state
       WHERE id = ?`,
    )
    .bind(MEMORY_STATE_ID)
    .first<MemoryStateRow>()
}

async function readMemoryItems(db: D1Database): Promise<MemoryItemRow[]> {
  const result = await db
    .prepare(
      `SELECT id, memory_type, period_start_at, period_end_at,
              source_workout_session_id, bullets_json, source_session_ids_json,
              source_note_ids_json, source_summary_ids_json, model, created_at,
              updated_at, snapshot_updated_at
       FROM codex_memory_items
       ORDER BY period_start_at ASC, created_at ASC`,
    )
    .all<MemoryItemRow>()
  return result.results ?? []
}

async function handleGetMemory(db: D1Database): Promise<Response> {
  // Keep the state, items, and revision on one transactional read snapshot.
  // Separate concurrent reads could otherwise pair a new revision with old
  // state and let a later compare-and-set publish from a torn base.
  const [stateResult, itemsResult, revisionResult] = await db.batch([
    db.prepare(
      `SELECT id, updated_at, current_context, paused, window_started_at,
              four_month_started_at, source_snapshot_updated_at
       FROM codex_memory_state
       WHERE id = ?`,
    ).bind(MEMORY_STATE_ID),
    db.prepare(
      `SELECT id, memory_type, period_start_at, period_end_at,
              source_workout_session_id, bullets_json, source_session_ids_json,
              source_note_ids_json, source_summary_ids_json, model, created_at,
              updated_at, snapshot_updated_at
       FROM codex_memory_items
       ORDER BY period_start_at ASC, created_at ASC`,
    ),
    db.prepare(
      `SELECT revision, publish_token, write_token
       FROM codex_publish_revision
       WHERE id = ?`,
    ).bind(MEMORY_STATE_ID),
  ])
  const state = (stateResult?.results?.[0] as MemoryStateRow | undefined) ?? null
  const items = (itemsResult?.results ?? []) as MemoryItemRow[]
  const publishRevision =
    (revisionResult?.results?.[0] as PublishRevisionRow | undefined) ?? null
  return json(200, {
    revision: publishRevision?.revision ?? 0,
    state: state ? memoryStateResponse(state) : null,
    items: items.map(memoryItemResponse),
  })
}

async function readPublishRevision(
  db: D1Database,
): Promise<PublishRevisionRow | null> {
  return db
    .prepare(
      `SELECT revision, publish_token, write_token
       FROM codex_publish_revision
       WHERE id = ?`,
    )
    .bind(MEMORY_STATE_ID)
    .first<PublishRevisionRow>()
}

function assertNumber(v: unknown, field: string): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`)
  }
  return v as number
}

function assertMemoryBullets(
  memoryType: MemoryType,
  raw: unknown,
): string[] {
  const bullets = assertTrimmedStringArray(raw, 'memory item bullets', 500)
  if (memoryType === 'two_week' && bullets.length !== 1) {
    throw new Error('two_week memory must have exactly one bullet')
  }
  if (memoryType === 'four_month' && bullets.length !== 2) {
    throw new Error('four_month memory must have exactly two bullets')
  }
  if (memoryType === 'workout' && (bullets.length < 1 || bullets.length > 3)) {
    throw new Error('workout memory must have 1-3 bullets')
  }
  return bullets
}

export function assertMemoryItem(raw: unknown): {
  id: string
  memoryType: MemoryType
  periodStartAt: number
  periodEndAt: number
  sourceWorkoutSessionId: string | null
  bullets: string[]
  sourceSessionIds: string[]
  sourceNoteIds: string[]
  sourceSummaryIds: string[]
  model: string
  createdAt: number
  updatedAt: number
  snapshotUpdatedAt: number | null
} {
  if (!isObject(raw)) throw new Error('memory item must be an object')
  const id = assertTrimmedString(raw.id, 'memory item id', 180)
  if (!isMemoryType(raw.memoryType)) {
    throw new Error(`invalid memory type for ${id}`)
  }
  const memoryType = raw.memoryType
  const periodStartAt = assertNumber(raw.periodStartAt, `${id}.periodStartAt`)
  const periodEndAt = assertNumber(raw.periodEndAt, `${id}.periodEndAt`)
  if (periodEndAt < periodStartAt) {
    throw new Error(`${id}.periodEndAt must be >= periodStartAt`)
  }
  const model = assertTrimmedString(raw.model, `${id}.model`, 120)
  const createdAt = assertNumber(raw.createdAt, `${id}.createdAt`)
  const updatedAt = assertNumber(raw.updatedAt, `${id}.updatedAt`)
  const snapshotUpdatedAt = assertNullableNumber(
    raw.snapshotUpdatedAt,
    `${id}.snapshotUpdatedAt`,
  )
  const sourceWorkoutSessionId =
    raw.sourceWorkoutSessionId === null
      ? null
      : assertTrimmedString(
          raw.sourceWorkoutSessionId,
          `${id}.sourceWorkoutSessionId`,
          180,
        )
  return {
    id,
    memoryType,
    periodStartAt,
    periodEndAt,
    sourceWorkoutSessionId,
    bullets: assertMemoryBullets(memoryType, raw.bullets),
    sourceSessionIds: assertTrimmedStringArray(
      raw.sourceSessionIds,
      `${id}.sourceSessionIds`,
      180,
    ),
    sourceNoteIds: assertTrimmedStringArray(
      raw.sourceNoteIds,
      `${id}.sourceNoteIds`,
      180,
    ),
    sourceSummaryIds: assertTrimmedStringArray(
      raw.sourceSummaryIds,
      `${id}.sourceSummaryIds`,
      180,
    ),
    model,
    createdAt,
    updatedAt,
    snapshotUpdatedAt,
  }
}

function assertUniqueMemoryItemIds(
  items: ReturnType<typeof assertMemoryItem>[],
): void {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new Error(`duplicate memory item id: ${item.id}`)
    }
    seen.add(item.id)
  }
}

function assertNullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null
  return assertNumber(value, field)
}

export function assertMemoryState(raw: unknown): {
  currentContext: string
  paused: boolean
  windowStartedAt: number
  fourMonthStartedAt: number
  sourceSnapshotUpdatedAt: number | null
} {
  if (!isObject(raw)) throw new Error('state must be an object')
  const windowStartedAt = assertNumber(
    raw.windowStartedAt,
    'state.windowStartedAt',
  )
  const fourMonthStartedAt = assertNumber(
    raw.fourMonthStartedAt,
    'state.fourMonthStartedAt',
  )
  const currentContext = assertTrimmedString(
    raw.currentContext,
    'state.currentContext',
    4000,
    true,
  )
  if (typeof raw.paused !== 'boolean') {
    throw new Error('state.paused must be a boolean')
  }
  const sourceSnapshotUpdatedAt = assertNullableNumber(
    raw.sourceSnapshotUpdatedAt,
    'state.sourceSnapshotUpdatedAt',
  )
  return {
    currentContext,
    paused: raw.paused,
    windowStartedAt,
    fourMonthStartedAt,
    sourceSnapshotUpdatedAt,
  }
}

async function handlePutMemory(ctx: PagesContext): Promise<Response> {
  let body: unknown
  try {
    body = await ctx.request.json()
  } catch {
    return json(400, { error: 'invalid_json' })
  }
  if (!isObject(body)) return json(400, { error: 'invalid_memory' })
  if (body.state === undefined && body.items === undefined) {
    return json(400, {
      error: 'invalid_memory',
      detail: 'state or items is required',
    })
  }

  let state:
    | ReturnType<typeof assertMemoryState>
    | null = null
  let items: ReturnType<typeof assertMemoryItem>[] = []
  try {
    if (body.state !== undefined) {
      state = assertMemoryState(body.state)
    }
    if (body.items !== undefined) {
      if (!Array.isArray(body.items)) throw new Error('items must be an array')
      items = body.items.map(assertMemoryItem)
      assertUniqueMemoryItemIds(items)
    }
  } catch (err) {
    return json(400, {
      error: 'invalid_memory',
      detail: err instanceof Error ? err.message : String(err),
    })
  }

  const now = Date.now()
  const mutationToken = crypto.randomUUID()
  const statements: D1PreparedStatement[] = [
    ctx.env.WORKOUT_DB.prepare(
      `INSERT INTO codex_publish_revision
         (id, revision, publish_token, publish_fingerprint, write_token)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         revision = codex_publish_revision.revision + 1,
         publish_token = excluded.publish_token,
         publish_fingerprint = excluded.publish_fingerprint,
         write_token = excluded.write_token`,
    ).bind(MEMORY_STATE_ID, mutationToken, mutationToken, mutationToken),
  ]

  if (state) {
    statements.push(
      ctx.env.WORKOUT_DB.prepare(
        `INSERT INTO codex_memory_state
         (id, updated_at, current_context, paused, window_started_at,
          four_month_started_at, source_snapshot_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         updated_at = excluded.updated_at,
         current_context = excluded.current_context,
         paused = excluded.paused,
         window_started_at = excluded.window_started_at,
         four_month_started_at = excluded.four_month_started_at,
         source_snapshot_updated_at = excluded.source_snapshot_updated_at`,
      ).bind(
        MEMORY_STATE_ID,
        now,
        state.currentContext,
        state.paused ? 1 : 0,
        state.windowStartedAt,
        state.fourMonthStartedAt,
        state.sourceSnapshotUpdatedAt,
      ),
    )
  }

  if (items.length > 0) {
    statements.push(
      ctx.env.WORKOUT_DB.prepare(
        `INSERT INTO codex_memory_items
         (id, memory_type, period_start_at, period_end_at,
          source_workout_session_id, bullets_json, source_session_ids_json,
          source_note_ids_json, source_summary_ids_json, model, created_at,
          updated_at, snapshot_updated_at)
       SELECT
         json_extract(value, '$.id'),
         json_extract(value, '$.memoryType'),
         json_extract(value, '$.periodStartAt'),
         json_extract(value, '$.periodEndAt'),
         json_extract(value, '$.sourceWorkoutSessionId'),
         json_extract(value, '$.bullets'),
         json_extract(value, '$.sourceSessionIds'),
         json_extract(value, '$.sourceNoteIds'),
         json_extract(value, '$.sourceSummaryIds'),
         json_extract(value, '$.model'),
         json_extract(value, '$.createdAt'),
         json_extract(value, '$.updatedAt'),
         json_extract(value, '$.snapshotUpdatedAt')
       FROM json_each(?)
       WHERE 1
       ON CONFLICT(id) DO UPDATE SET
         memory_type = excluded.memory_type,
         period_start_at = excluded.period_start_at,
         period_end_at = excluded.period_end_at,
         source_workout_session_id = excluded.source_workout_session_id,
         bullets_json = excluded.bullets_json,
         source_session_ids_json = excluded.source_session_ids_json,
         source_note_ids_json = excluded.source_note_ids_json,
         source_summary_ids_json = excluded.source_summary_ids_json,
         model = excluded.model,
         updated_at = excluded.updated_at,
         snapshot_updated_at = excluded.snapshot_updated_at`,
      ).bind(JSON.stringify(items)),
    )
  }

  await ctx.env.WORKOUT_DB.batch(statements)

  const [nextState, nextItems, nextRevision] = await Promise.all([
    readMemoryState(ctx.env.WORKOUT_DB),
    readMemoryItems(ctx.env.WORKOUT_DB),
    readPublishRevision(ctx.env.WORKOUT_DB),
  ])
  return json(200, {
    revision: nextRevision?.revision ?? null,
    state: nextState ? memoryStateResponse(nextState) : null,
    items: nextItems.map(memoryItemResponse),
  })
}

interface ValidatedAtomicBriefing {
  headline: string
  mode: Mode
  snapshotUpdatedAt: number
  source: string
  sectionsJson: string
  model: string
  inputSummaryJson: string | null
}

function validateAtomicBriefing(raw: unknown): ValidatedAtomicBriefing {
  if (!isObject(raw)) throw new Error('briefing must be an object')
  const mode = raw.mode
  if (!isMode(mode)) throw new Error('briefing.mode is invalid')
  const snapshotUpdatedAt = assertNumber(
    raw.snapshotUpdatedAt,
    'briefing.snapshotUpdatedAt',
  )
  if (
    raw.inputSummary !== undefined &&
    raw.inputSummary !== null &&
    !isObject(raw.inputSummary)
  ) {
    throw new Error('briefing.inputSummary must be an object or null')
  }
  return {
    headline: assertTrimmedString(raw.headline, 'briefing.headline', 200),
    mode,
    snapshotUpdatedAt,
    source:
      raw.source === undefined
        ? 'codex'
        : assertTrimmedString(raw.source, 'briefing.source', 80),
    sectionsJson: assertBriefingSections(raw.sections),
    model: assertTrimmedString(raw.model, 'briefing.model', 120),
    inputSummaryJson:
      raw.inputSummary === undefined || raw.inputSummary === null
        ? null
        : JSON.stringify(raw.inputSummary),
  }
}

async function readCommittedPublish(
  db: D1Database,
  date: string,
  publishId: string,
  publishFingerprint: string,
  expectedSnapshotUpdatedAt: number,
  expectedMemoryRevision: number,
): Promise<{
  publishId: string
  briefing: unknown
  memoryState: unknown
  memoryRevision: number
} | null> {
  const row = await db
    .prepare(PUBLISH_RECEIPT_SELECT)
    .bind(
      publishId,
      publishFingerprint,
      date,
      expectedSnapshotUpdatedAt,
      expectedMemoryRevision,
    )
    .first<PublishReceiptRow>()
  return row ? committedPublishResponse(row) : null
}

function committedPublishResponse(row: PublishReceiptRow): {
  publishId: string
  briefing: unknown
  memoryState: unknown
  memoryRevision: number
} {
  return {
    publishId: row.publish_id,
    briefing: briefingResponse({
      briefing_date: row.briefing_date,
      created_at: row.briefing_created_at,
      source: row.briefing_source,
      snapshot_updated_at: row.briefing_snapshot_updated_at,
      headline: row.headline,
      mode: row.mode,
      sections_json: row.sections_json,
      model: row.model,
      input_summary_json: row.input_summary_json,
    }),
    memoryState: memoryStateResponse({
      id: MEMORY_STATE_ID,
      updated_at: row.memory_updated_at,
      current_context: row.current_context,
      paused: row.paused,
      window_started_at: row.window_started_at,
      four_month_started_at: row.four_month_started_at,
      source_snapshot_updated_at: row.memory_snapshot_updated_at,
    }),
    memoryRevision: row.revision,
  }
}

async function handleAtomicPublish(
  ctx: PagesContext,
  date: string,
): Promise<Response> {
  if (!isCalendarDate(date)) return json(400, { error: 'invalid_date' })

  let body: unknown
  try {
    body = await readJsonBodyWithLimit(ctx.request)
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return json(413, { error: 'payload_too_large' })
    }
    return json(400, { error: 'invalid_json' })
  }
  if (!isObject(body)) return json(400, { error: 'invalid_publish' })

  const expectedSnapshotUpdatedAt = body.expectedSnapshotUpdatedAt
  const expectedMemoryRevision = body.expectedMemoryRevision
  if (
    !Number.isSafeInteger(expectedSnapshotUpdatedAt) ||
    (expectedSnapshotUpdatedAt as number) < 0
  ) {
    return json(400, { error: 'expectedSnapshotUpdatedAt_required' })
  }
  if (
    !Number.isSafeInteger(expectedMemoryRevision) ||
    (expectedMemoryRevision as number) < 0 ||
    (expectedMemoryRevision as number) >= Number.MAX_SAFE_INTEGER
  ) {
    return json(400, { error: 'expectedMemoryRevision_required' })
  }
  if (!isObject(body.memory)) return json(400, { error: 'invalid_memory' })

  let state: ReturnType<typeof assertMemoryState>
  let items: ReturnType<typeof assertMemoryItem>[]
  let briefing: ValidatedAtomicBriefing
  let publishId: string
  try {
    publishId = assertTrimmedString(body.publishId, 'publishId', 200)
    state = assertMemoryState(body.memory.state)
    if (!Array.isArray(body.memory.items)) {
      throw new Error('memory.items must be an array')
    }
    items = body.memory.items.map(assertMemoryItem)
    assertUniqueMemoryItemIds(items)
    briefing = validateAtomicBriefing(body.briefing)
  } catch (err) {
    return json(400, {
      error: 'invalid_publish',
      detail: err instanceof Error ? err.message : String(err),
    })
  }

  if (
    state.sourceSnapshotUpdatedAt !== expectedSnapshotUpdatedAt ||
    briefing.snapshotUpdatedAt !== expectedSnapshotUpdatedAt ||
    items.some((item) => item.snapshotUpdatedAt !== expectedSnapshotUpdatedAt)
  ) {
    return json(400, { error: 'publish_snapshot_mismatch' })
  }

  const memoryRevision = expectedMemoryRevision as number
  const publishFingerprint = await sha256Hex(
    JSON.stringify({
      date,
      expectedSnapshotUpdatedAt,
      expectedMemoryRevision: memoryRevision,
      memory: { state, items },
      briefing,
    }),
  )
  const replay = await readCommittedPublish(
    ctx.env.WORKOUT_DB,
    date,
    publishId,
    publishFingerprint,
    expectedSnapshotUpdatedAt,
    memoryRevision,
  )
  if (replay) return json(200, replay)

  const now = Date.now()
  const writeToken = crypto.randomUUID()
  const guard = `
    EXISTS (
      SELECT 1 FROM codex_publish_revision
      WHERE id = ? AND write_token = ?
    )
    AND EXISTS (
      SELECT 1 FROM workout_snapshots
      WHERE id = ? AND updated_at = ?
    )`

  const statements = [
    ctx.env.WORKOUT_DB.prepare(
      `UPDATE codex_publish_revision
       SET revision = revision + 1, publish_token = ?,
           publish_fingerprint = ?, write_token = ?
       WHERE id = ? AND revision = ?
         AND EXISTS (
           SELECT 1 FROM workout_snapshots
           WHERE id = ? AND updated_at = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM codex_publish_receipts
           WHERE publish_id = ?
         )`,
    ).bind(
      publishId,
      publishFingerprint,
      writeToken,
      MEMORY_STATE_ID,
      memoryRevision,
      SNAPSHOT_ID,
      expectedSnapshotUpdatedAt,
      publishId,
    ),
    ctx.env.WORKOUT_DB.prepare(
      `INSERT INTO codex_memory_state
         (id, updated_at, current_context, paused, window_started_at,
          four_month_started_at, source_snapshot_updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE ${guard}
       ON CONFLICT(id) DO UPDATE SET
         updated_at = excluded.updated_at,
         current_context = excluded.current_context,
         paused = excluded.paused,
         window_started_at = excluded.window_started_at,
         four_month_started_at = excluded.four_month_started_at,
         source_snapshot_updated_at = excluded.source_snapshot_updated_at`,
    ).bind(
      MEMORY_STATE_ID,
      now,
      state.currentContext,
      state.paused ? 1 : 0,
      state.windowStartedAt,
      state.fourMonthStartedAt,
      state.sourceSnapshotUpdatedAt,
      MEMORY_STATE_ID,
      writeToken,
      SNAPSHOT_ID,
      expectedSnapshotUpdatedAt,
    ),
    ctx.env.WORKOUT_DB.prepare(
      `INSERT INTO codex_memory_items
         (id, memory_type, period_start_at, period_end_at,
          source_workout_session_id, bullets_json, source_session_ids_json,
          source_note_ids_json, source_summary_ids_json, model, created_at,
          updated_at, snapshot_updated_at)
       SELECT
         json_extract(value, '$.id'),
         json_extract(value, '$.memoryType'),
         json_extract(value, '$.periodStartAt'),
         json_extract(value, '$.periodEndAt'),
         json_extract(value, '$.sourceWorkoutSessionId'),
         json_extract(value, '$.bullets'),
         json_extract(value, '$.sourceSessionIds'),
         json_extract(value, '$.sourceNoteIds'),
         json_extract(value, '$.sourceSummaryIds'),
         json_extract(value, '$.model'),
         json_extract(value, '$.createdAt'),
         json_extract(value, '$.updatedAt'),
         json_extract(value, '$.snapshotUpdatedAt')
       FROM json_each(?)
       WHERE ${guard}
       ON CONFLICT(id) DO UPDATE SET
         memory_type = excluded.memory_type,
         period_start_at = excluded.period_start_at,
         period_end_at = excluded.period_end_at,
         source_workout_session_id = excluded.source_workout_session_id,
         bullets_json = excluded.bullets_json,
         source_session_ids_json = excluded.source_session_ids_json,
         source_note_ids_json = excluded.source_note_ids_json,
         source_summary_ids_json = excluded.source_summary_ids_json,
         model = excluded.model,
         updated_at = excluded.updated_at,
         snapshot_updated_at = excluded.snapshot_updated_at`,
    ).bind(
      JSON.stringify(items),
      MEMORY_STATE_ID,
      writeToken,
      SNAPSHOT_ID,
      expectedSnapshotUpdatedAt,
    ),
    ctx.env.WORKOUT_DB.prepare(
      `INSERT INTO daily_briefings
         (briefing_date, created_at, source, snapshot_updated_at, headline,
          mode, sections_json, model, input_summary_json)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${guard}
       ON CONFLICT(briefing_date) DO UPDATE SET
         source = excluded.source,
         snapshot_updated_at = excluded.snapshot_updated_at,
         headline = excluded.headline,
         mode = excluded.mode,
         sections_json = excluded.sections_json,
         model = excluded.model,
         input_summary_json = excluded.input_summary_json`,
    ).bind(
      date,
      now,
      briefing.source,
      briefing.snapshotUpdatedAt,
      briefing.headline,
      briefing.mode,
      briefing.sectionsJson,
      briefing.model,
      briefing.inputSummaryJson,
      MEMORY_STATE_ID,
      writeToken,
      SNAPSHOT_ID,
      expectedSnapshotUpdatedAt,
    ),
    ctx.env.WORKOUT_DB.prepare(
      `INSERT INTO codex_publish_receipts
         (publish_id, publish_fingerprint, briefing_date,
          expected_snapshot_updated_at, base_memory_revision,
          committed_memory_revision, briefing_created_at, briefing_source,
          briefing_snapshot_updated_at, headline, mode, sections_json, model,
          input_summary_json, memory_updated_at, current_context, paused,
          window_started_at, four_month_started_at, memory_snapshot_updated_at,
          receipt_created_at)
       SELECT ?, ?, ?, ?, ?, revision.revision, briefing.created_at,
              briefing.source, briefing.snapshot_updated_at,
              briefing.headline, briefing.mode, briefing.sections_json,
              briefing.model, briefing.input_summary_json, memory.updated_at,
              memory.current_context, memory.paused, memory.window_started_at,
              memory.four_month_started_at, memory.source_snapshot_updated_at,
              ?
       FROM codex_publish_revision AS revision
       JOIN daily_briefings AS briefing ON briefing.briefing_date = ?
       JOIN codex_memory_state AS memory ON memory.id = ?
       WHERE revision.id = ?
         AND revision.write_token = ?
         AND revision.publish_token = ?
         AND revision.publish_fingerprint = ?
         AND revision.revision = ?
         AND briefing.snapshot_updated_at = ?
         AND memory.source_snapshot_updated_at = ?
       ON CONFLICT(publish_id) DO NOTHING`,
    ).bind(
      publishId,
      publishFingerprint,
      date,
      expectedSnapshotUpdatedAt,
      memoryRevision,
      now,
      date,
      MEMORY_STATE_ID,
      MEMORY_STATE_ID,
      writeToken,
      publishId,
      publishFingerprint,
      memoryRevision + 1,
      expectedSnapshotUpdatedAt,
      expectedSnapshotUpdatedAt,
    ),
    ctx.env.WORKOUT_DB.prepare(PUBLISH_RECEIPT_SELECT).bind(
      publishId,
      publishFingerprint,
      date,
      expectedSnapshotUpdatedAt,
      memoryRevision,
    ),
  ]

  const results = await ctx.env.WORKOUT_DB.batch(statements)
  const committedRow = results[5]?.results?.[0] as
    | PublishReceiptRow
    | undefined
  if (committedRow) return json(200, committedPublishResponse(committedRow))
  if (results[0]?.meta?.changes !== 1) {
    return json(409, { error: 'stale_publish_state' })
  }
  throw new Error('atomic publish verification failed')
}

export const onRequest = async (ctx: PagesContext): Promise<Response> => {
  try {
    const path = routePath(ctx)
    const method = ctx.request.method.toUpperCase()

    if (path === 'snapshot' && method === 'PUT') {
      const originError = requireSameOriginForMutation(ctx.request)
      if (originError) return originError
      const authError = await requireDeviceSession(ctx.request, ctx.env)
      if (authError) return authError
    } else if (
      (path === 'memory' && method === 'PUT') ||
      (path.match(/^briefing\/[^/]+$/) && method === 'PUT') ||
      (path.match(/^publish\/[^/]+$/) && method === 'PUT')
    ) {
      const authError = requireAutomationSecret(ctx.request, ctx.env)
      if (authError) return authError
    } else {
      // Read routes are consumed by both the paired app and the local
      // automation. The automation secret cannot mutate the phone snapshot.
      const authError = await requireCloudAuth(ctx.request, ctx.env)
      if (authError) return authError
    }

    if (path === 'snapshot' && method === 'GET') {
      return await handleGetSnapshot(ctx.env.WORKOUT_DB)
    }
    if (path === 'snapshot' && method === 'PUT') {
      return await handlePutSnapshot(ctx)
    }
    if (path === 'briefing/latest' && method === 'GET') {
      return await handleGetLatestBriefing(ctx.env.WORKOUT_DB)
    }
    if (path === 'memory' && method === 'GET') {
      return await handleGetMemory(ctx.env.WORKOUT_DB)
    }
    if (path === 'memory' && method === 'PUT') {
      return await handlePutMemory(ctx)
    }

    const publishMatch = path.match(/^publish\/([^/]+)$/)
    if (publishMatch && method === 'PUT') {
      return await handleAtomicPublish(ctx, publishMatch[1])
    }

    const briefingMatch = path.match(/^briefing\/([^/]+)$/)
    if (briefingMatch && method === 'GET') {
      return await handleGetBriefing(ctx.env.WORKOUT_DB, briefingMatch[1])
    }
    if (briefingMatch && method === 'PUT') {
      return await handlePutBriefing(ctx, briefingMatch[1])
    }

    return json(404, { error: 'not_found' })
  } catch (err) {
    // D1 / runtime failures would otherwise escape as a non-JSON HTML 500.
    // Keep the client on a parseable contract.
    console.error('cloud api failure', err)
    return json(500, { error: 'internal_error' })
  }
}
