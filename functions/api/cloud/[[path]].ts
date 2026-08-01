// Cloudflare Pages Function for the single-user cloud mirror.
// The paired phone writes full export snapshots; laptop Codex reads snapshots
// and writes one fixed daily briefing per America/Los_Angeles date.

import {
  requireAutomationSecret,
  requireCloudAuth,
  requireDeviceSession,
  type D1Database,
} from '../../lib/cloudAuth'

type Mode = 'push' | 'normal' | 'light' | 'deload'
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

const SNAPSHOT_ID = 'primary'
const MEMORY_STATE_ID = 'primary'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// Cap the snapshot body so a runaway client export can't exhaust Worker memory
// or blow past D1 row limits. A full single-user export is well under this.
const MAX_BODY_BYTES = 8 * 1024 * 1024

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
  return v !== null && typeof v === 'object'
}

function isMode(v: unknown): v is Mode {
  return v === 'push' || v === 'normal' || v === 'light' || v === 'deload'
}

function isMemoryType(v: unknown): v is MemoryType {
  return v === 'workout' || v === 'two_week' || v === 'four_month'
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : []
}

function trimmedString(v: unknown, maxLength: number): string {
  return typeof v === 'string' ? v.trim().slice(0, maxLength) : ''
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

async function handleGetSnapshot(db: D1Database): Promise<Response> {
  const row = await readSnapshot(db)
  if (!row) return json(404, { error: 'snapshot_not_found' })
  return json(200, { snapshot: snapshotResponse(row) })
}

function exceedsBodyCap(request: Request): boolean {
  const len = Number(request.headers.get('content-length') ?? '')
  return Number.isFinite(len) && len > MAX_BODY_BYTES
}

async function handlePutSnapshot(ctx: PagesContext): Promise<Response> {
  if (exceedsBodyCap(ctx.request)) {
    return json(413, { error: 'payload_too_large' })
  }

  let body: unknown
  try {
    body = await ctx.request.json()
  } catch {
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

  const now = Date.now()
  const sourceDevice =
    ctx.request.headers.get('X-Source-Device')?.trim().slice(0, 80) || 'phone'
  await ctx.env.WORKOUT_DB.prepare(
    `INSERT INTO workout_snapshots
       (id, created_at, updated_at, source_device, schema_version, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       updated_at = excluded.updated_at,
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
    )
    .run()

  const row = await readSnapshot(ctx.env.WORKOUT_DB)
  return json(200, { snapshot: row ? snapshotResponse(row) : null })
}

function assertBriefingSections(raw: unknown): string {
  if (!isObject(raw)) throw new Error('sections must be an object')
  const todaysCall = raw.todaysCall
  const why = raw.why
  const recoveryStatus = raw.recoveryStatus
  const ouraRecovery = raw.ouraRecovery
  const trainingTrend = raw.trainingTrend
  const watchOuts = raw.watchOuts
  if (typeof todaysCall !== 'string' || !todaysCall.trim()) {
    throw new Error('sections.todaysCall is required')
  }
  if (!Array.isArray(why) || !why.every((x) => typeof x === 'string')) {
    throw new Error('sections.why must be an array of strings')
  }
  if (typeof ouraRecovery !== 'string') {
    throw new Error('sections.ouraRecovery is required')
  }
  if (
    recoveryStatus !== undefined &&
    recoveryStatus !== 'fresh' &&
    recoveryStatus !== 'stale' &&
    recoveryStatus !== 'unavailable'
  ) {
    throw new Error('sections.recoveryStatus must be fresh, stale, or unavailable')
  }
  if (typeof trainingTrend !== 'string') {
    throw new Error('sections.trainingTrend is required')
  }
  if (
    !Array.isArray(watchOuts) ||
    !watchOuts.every((x) => typeof x === 'string')
  ) {
    throw new Error('sections.watchOuts must be an array of strings')
  }
  return JSON.stringify({
    todaysCall: todaysCall.trim().slice(0, 600),
    why: why.map((x) => x.trim().slice(0, 400)).filter(Boolean).slice(0, 3),
    ...(recoveryStatus ? { recoveryStatus } : {}),
    ouraRecovery: ouraRecovery.trim().slice(0, 500),
    trainingTrend: trainingTrend.trim().slice(0, 500),
    watchOuts: watchOuts
      .map((x) => x.trim().slice(0, 400))
      .filter(Boolean)
      .slice(0, 3),
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
  if (!DATE_RE.test(date)) return json(400, { error: 'invalid_date' })
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
  if (!DATE_RE.test(date)) return json(400, { error: 'invalid_date' })

  let body: unknown
  try {
    body = await ctx.request.json()
  } catch {
    return json(400, { error: 'invalid_json' })
  }
  if (!isObject(body)) return json(400, { error: 'invalid_briefing' })

  const headline = body.headline
  const mode = body.mode
  const snapshotUpdatedAt = body.snapshotUpdatedAt
  const model = body.model
  if (typeof headline !== 'string' || !headline.trim()) {
    return json(400, { error: 'headline_required' })
  }
  if (!isMode(mode)) return json(400, { error: 'invalid_mode' })
  if (typeof snapshotUpdatedAt !== 'number') {
    return json(400, { error: 'snapshotUpdatedAt_required' })
  }
  if (typeof model !== 'string' || !model.trim()) {
    return json(400, { error: 'model_required' })
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

  const source =
    typeof body.source === 'string' && body.source.trim()
      ? body.source.trim().slice(0, 80)
      : 'codex'
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
      headline.trim().slice(0, 200),
      mode,
      sectionsJson,
      model.trim().slice(0, 120),
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
  const [state, items] = await Promise.all([
    readMemoryState(db),
    readMemoryItems(db),
  ])
  return json(200, {
    state: state ? memoryStateResponse(state) : null,
    items: items.map(memoryItemResponse),
  })
}

function assertNumber(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${field} must be a finite number`)
  }
  return v
}

function assertMemoryBullets(
  memoryType: MemoryType,
  raw: unknown,
): string[] {
  const bullets = stringArray(raw)
    .map((x) => x.trim().slice(0, 500))
    .filter(Boolean)
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

function assertMemoryItem(raw: unknown): {
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
  const id = trimmedString(raw.id, 180)
  if (!id) throw new Error('memory item id is required')
  if (!isMemoryType(raw.memoryType)) {
    throw new Error(`invalid memory type for ${id}`)
  }
  const memoryType = raw.memoryType
  const periodStartAt = assertNumber(raw.periodStartAt, `${id}.periodStartAt`)
  const periodEndAt = assertNumber(raw.periodEndAt, `${id}.periodEndAt`)
  if (periodEndAt < periodStartAt) {
    throw new Error(`${id}.periodEndAt must be >= periodStartAt`)
  }
  const model = trimmedString(raw.model, 120)
  if (!model) throw new Error(`${id}.model is required`)
  const createdAt =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : Date.now()
  const updatedAt =
    typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : createdAt
  const snapshotUpdatedAt =
    typeof raw.snapshotUpdatedAt === 'number' &&
    Number.isFinite(raw.snapshotUpdatedAt)
      ? raw.snapshotUpdatedAt
      : null
  return {
    id,
    memoryType,
    periodStartAt,
    periodEndAt,
    sourceWorkoutSessionId:
      typeof raw.sourceWorkoutSessionId === 'string' &&
      raw.sourceWorkoutSessionId.trim()
        ? raw.sourceWorkoutSessionId.trim().slice(0, 180)
        : null,
    bullets: assertMemoryBullets(memoryType, raw.bullets),
    sourceSessionIds: stringArray(raw.sourceSessionIds)
      .map((x) => x.trim().slice(0, 180))
      .filter(Boolean),
    sourceNoteIds: stringArray(raw.sourceNoteIds)
      .map((x) => x.trim().slice(0, 180))
      .filter(Boolean),
    sourceSummaryIds: stringArray(raw.sourceSummaryIds)
      .map((x) => x.trim().slice(0, 180))
      .filter(Boolean),
    model,
    createdAt,
    updatedAt,
    snapshotUpdatedAt,
  }
}

function assertMemoryState(raw: unknown): {
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
  const sourceSnapshotUpdatedAt =
    typeof raw.sourceSnapshotUpdatedAt === 'number' &&
    Number.isFinite(raw.sourceSnapshotUpdatedAt)
      ? raw.sourceSnapshotUpdatedAt
      : null
  return {
    currentContext: trimmedString(raw.currentContext, 4000),
    paused: raw.paused === true,
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

  let state:
    | ReturnType<typeof assertMemoryState>
    | null = null
  let items: ReturnType<typeof assertMemoryItem>[] = []
  try {
    if (body.state !== undefined && body.state !== null) {
      state = assertMemoryState(body.state)
    }
    if (body.items !== undefined) {
      if (!Array.isArray(body.items)) throw new Error('items must be an array')
      items = body.items.map(assertMemoryItem)
    }
  } catch (err) {
    return json(400, {
      error: 'invalid_memory',
      detail: err instanceof Error ? err.message : String(err),
    })
  }

  const now = Date.now()
  if (state) {
    await ctx.env.WORKOUT_DB.prepare(
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
    )
      .bind(
        MEMORY_STATE_ID,
        now,
        state.currentContext,
        state.paused ? 1 : 0,
        state.windowStartedAt,
        state.fourMonthStartedAt,
        state.sourceSnapshotUpdatedAt,
      )
      .run()
  }

  for (const item of items) {
    await ctx.env.WORKOUT_DB.prepare(
      `INSERT INTO codex_memory_items
         (id, memory_type, period_start_at, period_end_at,
          source_workout_session_id, bullets_json, source_session_ids_json,
          source_note_ids_json, source_summary_ids_json, model, created_at,
          updated_at, snapshot_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    )
      .bind(
        item.id,
        item.memoryType,
        item.periodStartAt,
        item.periodEndAt,
        item.sourceWorkoutSessionId,
        JSON.stringify(item.bullets),
        JSON.stringify(item.sourceSessionIds),
        JSON.stringify(item.sourceNoteIds),
        JSON.stringify(item.sourceSummaryIds),
        item.model,
        item.createdAt,
        item.updatedAt,
        item.snapshotUpdatedAt,
      )
      .run()
  }

  const [nextState, nextItems] = await Promise.all([
    readMemoryState(ctx.env.WORKOUT_DB),
    readMemoryItems(ctx.env.WORKOUT_DB),
  ])
  return json(200, {
    state: nextState ? memoryStateResponse(nextState) : null,
    items: nextItems.map(memoryItemResponse),
  })
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
      (path.match(/^briefing\/[^/]+$/) && method === 'PUT')
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
