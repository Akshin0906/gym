import {
  readCloudSession,
  requireAutomationSecret,
  requireDeviceSession,
  sha256Hex,
  type CloudAuthSessionRow,
  type D1Database,
  type D1PreparedStatement,
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
const SNAPSHOT_ID = 'primary'
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
export const COACH_TRANSCRIPT_PROTOCOL = 'proposal-reservation-v1'
const COACH_TRANSCRIPT_PROTOCOL_HEADER = 'X-Coach-Protocol'
const PROPOSAL_RESERVATION_KIND = 'coach_apply_reservation_v1'
const ACTION_SCOPES = [
  'active_workout',
  'one_time_workout',
  'program',
  'exercise_library',
  'ai_memory',
] as const
const COACH_RESULT_ACTION_TYPES = new Set([
  'swap_active_exercise',
  'add_active_exercise',
  'update_active_exercise_targets',
  'create_one_time_workout',
  'create_session_template',
  'create_program',
  'rename_program',
  'replace_program',
  'archive_program',
  'replace_session_template',
  'delete_session_template',
  'create_custom_exercise',
  'save_ai_note',
])
const COACH_RESULT_KEYS = new Set([
  'proposalId',
  'appliedAt',
  'sourceStateHash',
  'sourceActionStateHash',
  'replayed',
  'syncPending',
  'changes',
  'activeSessionId',
  'programId',
  'sessionTemplateId',
  'exerciseId',
])
const COACH_RESULT_CHANGE_KEYS = new Set(['type', 'label', 'entityId'])
const COACH_RECEIPT_KEYS = new Set([
  'proposalId',
  'appliedAt',
  'sourceStateHash',
  'resultJson',
])
type ActionScope = (typeof ACTION_SCOPES)[number]
type ValidatedAction = Record<string, unknown> & { type: string }
const MUSCLE_GROUPS = [
  'chest',
  'back',
  'shoulders',
  'biceps',
  'triceps',
  'forearms',
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'abs',
  'traps',
] as const
type MuscleGroup = (typeof MUSCLE_GROUPS)[number]

interface ValidatedActionPlan {
  title: string
  summary: string
  scope: ActionScope
  actions: ValidatedAction[]
}

interface ProposalReservation {
  _kind: typeof PROPOSAL_RESERVATION_KIND
  ownerSessionId: string
  reservedAt: number
}

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

function parseProposalReservation(
  raw: string | null,
): ProposalReservation | null {
  if (!raw) return null
  const parsed = parseJson(raw)
  if (
    !isObject(parsed) ||
    parsed._kind !== PROPOSAL_RESERVATION_KIND ||
    typeof parsed.ownerSessionId !== 'string' ||
    !parsed.ownerSessionId ||
    typeof parsed.reservedAt !== 'number' ||
    !Number.isSafeInteger(parsed.reservedAt) ||
    parsed.reservedAt < 0
  ) {
    return null
  }
  return {
    _kind: PROPOSAL_RESERVATION_KIND,
    ownerSessionId: parsed.ownerSessionId,
    reservedAt: parsed.reservedAt,
  }
}

function reservationUnavailableError(): ApiError {
  return new ApiError(
    409,
    'proposal_reserved',
    'This proposal is reserved by another paired device. Return to the device that started Apply. Reservations do not expire automatically; if that session was lost, manual operator recovery is required after verifying the device\'s local workout data.',
  )
}

function reservationLockedError(): ApiError {
  return new ApiError(
    409,
    'proposal_reserved',
    'This proposal is reserved for application. Retry Apply or finish syncing it on the same paired device. Reservations do not expire automatically; if that session was lost, manual operator recovery is required after verifying the device\'s local workout data.',
  )
}

async function currentDeviceSession(
  ctx: PagesContext,
): Promise<CloudAuthSessionRow> {
  const session = await readCloudSession(ctx.request, ctx.env)
  if (!session) throw new ApiError(401, 'unauthorized')
  return session
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

function isBoundedNonEmptyString(
  value: unknown,
  maximum: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum
  )
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isCoachActionResult(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || !hasOnlyKeys(value, COACH_RESULT_KEYS)) return false
  if (
    !isBoundedNonEmptyString(value.proposalId, 200) ||
    typeof value.appliedAt !== 'number' ||
    !Number.isSafeInteger(value.appliedAt) ||
    value.appliedAt < 0 ||
    !validSha256Hex(value.sourceStateHash) ||
    (value.sourceActionStateHash !== undefined &&
      !validSha256Hex(value.sourceActionStateHash)) ||
    typeof value.replayed !== 'boolean' ||
    (value.syncPending !== undefined &&
      typeof value.syncPending !== 'boolean') ||
    !Array.isArray(value.changes) ||
    value.changes.length < 1 ||
    value.changes.length > 12
  ) {
    return false
  }
  for (const change of value.changes) {
    if (
      !isObject(change) ||
      !hasOnlyKeys(change, COACH_RESULT_CHANGE_KEYS) ||
      typeof change.type !== 'string' ||
      !COACH_RESULT_ACTION_TYPES.has(change.type) ||
      !isBoundedNonEmptyString(change.label, 1000) ||
      (change.entityId !== undefined &&
        !isBoundedNonEmptyString(change.entityId, 200))
    ) {
      return false
    }
  }
  for (const key of [
    'activeSessionId',
    'programId',
    'sessionTemplateId',
    'exerciseId',
  ]) {
    if (
      value[key] !== undefined &&
      !isBoundedNonEmptyString(value[key], 200)
    ) {
      return false
    }
  }
  return true
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

function comparableCoachResult(result: Record<string, unknown>): string {
  const comparable = { ...result }
  // The uploaded receipt is intentionally pending until that exact snapshot
  // succeeds; the client flips only this transport flag before reporting.
  // `replayed` is also execution metadata, not part of the saved mutation.
  delete comparable.syncPending
  delete comparable.replayed
  return canonicalJson(comparable)
}

function isActionScope(value: unknown): value is ActionScope {
  return (
    typeof value === 'string' &&
    (ACTION_SCOPES as readonly string[]).includes(value)
  )
}

export function assertCompleteActionStateHashes(context: unknown): void {
  const hashes = isObject(context) ? context.actionStateHashes : null
  const missing = ACTION_SCOPES.filter(
    (scope) => !isObject(hashes) || !validSha256Hex(hashes[scope]),
  )
  if (missing.length > 0) {
    throw new ApiError(
      409,
      'coach_context_update_required',
      `Update or refresh the app before using Coach; missing capabilities: ${missing.join(', ')}`,
    )
  }
}

function invalidActionPlan(detail: string): never {
  throw new ApiError(400, 'invalid_action_plan', detail)
}

function actionString(
  value: unknown,
  field: string,
  maxLength = 120,
): string {
  if (typeof value !== 'string') invalidActionPlan(`${field} must be text`)
  const trimmed = value.trim()
  if (!trimmed) invalidActionPlan(`${field} is required`)
  if (trimmed.length > maxLength) invalidActionPlan(`${field} is too long`)
  return trimmed
}

function actionPositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 20) {
    invalidActionPlan(`${field} must be a whole number from 1 to 20`)
  }
  return value as number
}

function actionNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1000) {
    invalidActionPlan(`${field} must be a whole number from 0 to 1000`)
  }
  return value as number
}

function actionBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    invalidActionPlan(
      `${field} must be a whole number from ${minimum} to ${maximum}`,
    )
  }
  return value as number
}

function actionBoundedText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') invalidActionPlan(`${field} must be text`)
  const trimmed = value.trim()
  if (trimmed.length > maxLength) invalidActionPlan(`${field} is too long`)
  return trimmed
}

function actionNullableId(value: unknown, field: string): string | null {
  if (value === null) return null
  return actionString(value, field, 200)
}

function actionMuscleGroup(value: unknown, field: string): MuscleGroup {
  if (
    typeof value !== 'string' ||
    !(MUSCLE_GROUPS as readonly string[]).includes(value)
  ) {
    invalidActionPlan(`${field} is not a supported muscle group`)
  }
  return value as MuscleGroup
}

function actionSecondaryMuscles(
  value: unknown,
  field: string,
  primaryMuscle: MuscleGroup,
): MuscleGroup[] {
  if (!Array.isArray(value) || value.length > MUSCLE_GROUPS.length - 1) {
    invalidActionPlan(`${field} must be a list of muscle groups`)
  }
  const parsed = value.map((item, index) =>
    actionMuscleGroup(item, `${field}[${index}]`),
  )
  if (new Set(parsed).size !== parsed.length) {
    invalidActionPlan(`${field} contains a duplicate muscle group`)
  }
  if (parsed.includes(primaryMuscle)) {
    invalidActionPlan(`${field} cannot include the primary muscle group`)
  }
  return parsed
}

function validatePlannedExercises(
  value: unknown,
  field: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) {
    invalidActionPlan(`${field} must contain 1 to 30 exercises`)
  }
  const exercises = value.map((raw, index) => {
    if (!isObject(raw)) invalidActionPlan(`${field}[${index}] must be an object`)
    return {
      exerciseId: actionString(raw.exerciseId, `${field}[${index}].exerciseId`, 200),
      targetSets: actionPositiveInteger(
        raw.targetSets,
        `${field}[${index}].targetSets`,
      ),
      repRange: actionString(raw.repRange, `${field}[${index}].repRange`, 50),
    }
  })
  if (new Set(exercises.map((exercise) => exercise.exerciseId)).size !== exercises.length) {
    invalidActionPlan(`${field} contains a duplicate exercise`)
  }
  return exercises
}

function validateReplacementSessions(
  value: unknown,
  field: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    invalidActionPlan(`${field} must contain 1 to 20 sessions`)
  }
  const sessions = value.map((raw, index) => {
    if (!isObject(raw)) invalidActionPlan(`${field}[${index}] must be an object`)
    return {
      sessionTemplateId: actionNullableId(
        raw.sessionTemplateId,
        `${field}[${index}].sessionTemplateId`,
      ),
      name: actionString(raw.name, `${field}[${index}].name`),
      exercises: validatePlannedExercises(
        raw.exercises,
        `${field}[${index}].exercises`,
      ),
    }
  })
  const names = sessions.map((session) =>
    (session.name as string).toLocaleLowerCase(),
  )
  if (new Set(names).size !== names.length) {
    invalidActionPlan(`${field} has duplicate names`)
  }
  const retainedIds = sessions
    .map((session) => session.sessionTemplateId)
    .filter((id): id is string => id !== null)
  if (new Set(retainedIds).size !== retainedIds.length) {
    invalidActionPlan(`${field} has duplicate session template IDs`)
  }
  return sessions
}

function validateAction(raw: unknown, index: number): ValidatedAction {
  if (!isObject(raw)) invalidActionPlan(`actions[${index}] must be an object`)
  const field = `actions[${index}]`
  const type = actionString(raw.type, `${field}.type`)
  switch (type) {
    case 'swap_active_exercise':
      return {
        type,
        sessionId: actionString(raw.sessionId, `${field}.sessionId`, 200),
        fromExerciseId: actionString(
          raw.fromExerciseId,
          `${field}.fromExerciseId`,
          200,
        ),
        toExerciseId: actionString(raw.toExerciseId, `${field}.toExerciseId`, 200),
        targetSets: actionPositiveInteger(raw.targetSets, `${field}.targetSets`),
        repRange: actionString(raw.repRange, `${field}.repRange`, 50),
      }
    case 'add_active_exercise':
      return {
        type,
        sessionId: actionString(raw.sessionId, `${field}.sessionId`, 200),
        exerciseId: actionString(raw.exerciseId, `${field}.exerciseId`, 200),
        position: actionNonNegativeInteger(raw.position, `${field}.position`),
        targetSets: actionPositiveInteger(raw.targetSets, `${field}.targetSets`),
        repRange: actionString(raw.repRange, `${field}.repRange`, 50),
      }
    case 'update_active_exercise_targets':
      return {
        type,
        sessionId: actionString(raw.sessionId, `${field}.sessionId`, 200),
        exerciseId: actionString(raw.exerciseId, `${field}.exerciseId`, 200),
        targetSets: actionPositiveInteger(raw.targetSets, `${field}.targetSets`),
        repRange: actionString(raw.repRange, `${field}.repRange`, 50),
      }
    case 'create_one_time_workout':
      return {
        type,
        name: actionString(raw.name, `${field}.name`),
        exercises: validatePlannedExercises(raw.exercises, `${field}.exercises`),
      }
    case 'create_session_template':
      return {
        type,
        programId: actionString(raw.programId, `${field}.programId`, 200),
        name: actionString(raw.name, `${field}.name`),
        exercises: validatePlannedExercises(raw.exercises, `${field}.exercises`),
      }
    case 'create_program': {
      if (!Array.isArray(raw.sessions) || raw.sessions.length < 1 || raw.sessions.length > 20) {
        invalidActionPlan(`${field}.sessions must contain 1 to 20 sessions`)
      }
      const sessions = raw.sessions.map((session, sessionIndex) => {
        if (!isObject(session)) {
          invalidActionPlan(`${field}.sessions[${sessionIndex}] must be an object`)
        }
        return {
          name: actionString(
            session.name,
            `${field}.sessions[${sessionIndex}].name`,
          ),
          exercises: validatePlannedExercises(
            session.exercises,
            `${field}.sessions[${sessionIndex}].exercises`,
          ),
        }
      })
      const names = sessions.map((session) => session.name.toLocaleLowerCase())
      if (new Set(names).size !== names.length) {
        invalidActionPlan(`${field}.sessions has duplicate names`)
      }
      return {
        type,
        name: actionString(raw.name, `${field}.name`),
        sessions,
      }
    }
    case 'rename_program':
      return {
        type,
        programId: actionString(raw.programId, `${field}.programId`, 200),
        name: actionString(raw.name, `${field}.name`),
      }
    case 'replace_program':
      return {
        type,
        programId: actionString(raw.programId, `${field}.programId`, 200),
        name: actionString(raw.name, `${field}.name`),
        sessions: validateReplacementSessions(raw.sessions, `${field}.sessions`),
      }
    case 'archive_program':
      return {
        type,
        programId: actionString(raw.programId, `${field}.programId`, 200),
      }
    case 'replace_session_template':
      return {
        type,
        sessionTemplateId: actionString(
          raw.sessionTemplateId,
          `${field}.sessionTemplateId`,
          200,
        ),
        name: actionString(raw.name, `${field}.name`),
        exercises: validatePlannedExercises(raw.exercises, `${field}.exercises`),
      }
    case 'delete_session_template':
      return {
        type,
        sessionTemplateId: actionString(
          raw.sessionTemplateId,
          `${field}.sessionTemplateId`,
          200,
        ),
      }
    case 'create_custom_exercise': {
      const primaryMuscle = actionMuscleGroup(
        raw.primaryMuscle,
        `${field}.primaryMuscle`,
      )
      return {
        type,
        name: actionString(raw.name, `${field}.name`),
        primaryMuscle,
        secondaryMuscles: actionSecondaryMuscles(
          raw.secondaryMuscles,
          `${field}.secondaryMuscles`,
          primaryMuscle,
        ),
        notes: actionBoundedText(raw.notes, `${field}.notes`, 2000),
        defaultRestSeconds: actionBoundedInteger(
          raw.defaultRestSeconds,
          `${field}.defaultRestSeconds`,
          1,
          3600,
        ),
      }
    }
    case 'save_ai_note':
      return {
        type,
        body: actionString(raw.body, `${field}.body`, 1000),
      }
    default:
      return invalidActionPlan(`Unsupported Coach action: ${type}`)
  }
}

export function validateActionPlan(value: unknown): ValidatedActionPlan {
  if (!isObject(value)) invalidActionPlan('actionPlan must be an object')
  if (!isActionScope(value.scope)) invalidActionPlan('actionPlan has an invalid scope')
  if (!Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 12) {
    invalidActionPlan('actionPlan must contain 1 to 12 actions')
  }
  const plan: ValidatedActionPlan = {
    title: actionString(value.title, 'actionPlan.title'),
    summary: actionString(value.summary, 'actionPlan.summary', 1000),
    scope: value.scope,
    actions: value.actions.map(validateAction),
  }
  const activeTypes = new Set([
    'swap_active_exercise',
    'add_active_exercise',
    'update_active_exercise_targets',
  ])
  if (plan.scope === 'active_workout') {
    if (!plan.actions.every((action) => activeTypes.has(action.type))) {
      invalidActionPlan('active_workout scope may only modify the active workout')
    }
    const sessionIds = new Set(plan.actions.map((action) => action.sessionId))
    if (sessionIds.size !== 1) {
      invalidActionPlan('active_workout actions must target the same session')
    }
  } else if (plan.scope === 'ai_memory') {
    if (plan.actions.length !== 1 || plan.actions[0]?.type !== 'save_ai_note') {
      invalidActionPlan('ai_memory scope requires exactly one save_ai_note action')
    }
  } else if (plan.scope === 'exercise_library') {
    if (
      plan.actions.length !== 1 ||
      plan.actions[0]?.type !== 'create_custom_exercise'
    ) {
      invalidActionPlan(
        'exercise_library scope requires exactly one create_custom_exercise action',
      )
    }
  } else {
    if (plan.actions.length !== 1) {
      invalidActionPlan('workout and program creation plans require exactly one action')
    }
    const type = plan.actions[0]?.type
    if (plan.scope === 'one_time_workout' && type !== 'create_one_time_workout') {
      invalidActionPlan('one_time_workout scope requires a create_one_time_workout action')
    }
    const programTypes = new Set([
      'create_session_template',
      'create_program',
      'rename_program',
      'replace_program',
      'archive_program',
      'replace_session_template',
      'delete_session_template',
    ])
    if (plan.scope === 'program' && !programTypes.has(type ?? '')) {
      invalidActionPlan(
        'program scope may only create, rename, replace, archive, or delete a saved program workout',
      )
    }
  }
  return plan
}

export function trustedActionStateHash(
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

export function trustedActionStateHashForPlan(
  contextJson: string,
  scope: ActionScope,
): string {
  const hash = trustedActionStateHash(contextJson, scope)
  const payload = parseJson(contextJson)
  const memory = isObject(payload) ? payload.memory : null
  if (scope === 'ai_memory' && isObject(memory) && memory.paused === true) {
    throw new ApiError(
      409,
      'ai_memory_paused',
      'Resume AI Memory before saving a Coach note',
    )
  }
  return hash
}

export function completionHashInput({
  assistantText,
  model,
  effort,
  codexThreadId,
  actionPlan,
  discardCodexThread,
  expectedCodexThreadId,
}: {
  assistantText: string
  model: string
  effort: ReasoningEffort
  codexThreadId: string | null
  actionPlan: Record<string, unknown> | null
  discardCodexThread: boolean
  expectedCodexThreadId: string | null
}): string {
  const legacyPayload = {
    assistantText,
    model,
    effort,
    codexThreadId,
    actionPlan,
  }
  return JSON.stringify(
    discardCodexThread
      ? { ...legacyPayload, discardCodexThread, expectedCodexThreadId }
      : legacyPayload,
  )
}

export function discardConversationThreadStatement(
  db: D1Database,
  expectedCodexThreadId: string | null,
  jobId: string,
  nextStatus: JobStatus,
  failureTransitionId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE codex_chat_conversations
       SET codex_thread_id = NULL
       WHERE id = ? AND codex_thread_id IS ?
         AND EXISTS (
           SELECT 1 FROM codex_chat_jobs
           WHERE id = ? AND conversation_id = ? AND status = ?
             AND worker_id = ? AND lease_token IS NULL
         )`,
    )
    .bind(
      CONVERSATION_ID,
      expectedCodexThreadId,
      jobId,
      CONVERSATION_ID,
      nextStatus,
      failureTransitionId,
    )
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

function proposalResponse(
  row: ProposalRow,
  options: { includeActionPlan?: boolean } = {},
): unknown {
  const reservation = parseProposalReservation(row.result_json)
  const includeActionPlan = options.includeActionPlan !== false
  return {
    id: row.id,
    messageId: row.assistant_message_id,
    jobId: row.job_id,
    status: row.status,
    actionPlan:
      includeActionPlan || row.status !== 'proposed'
        ? parseJson(row.action_plan_json)
        : null,
    sourceStateHash:
      row.state_hash ??
      (isObject(parseJson(row.action_plan_json))
        ? (parseJson(row.action_plan_json) as Record<string, unknown>)
            .sourceStateHash ?? null
        : null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    result:
      row.result_json && !reservation ? parseJson(row.result_json) : null,
    reserved: reservation !== null,
    reservedAt: reservation?.reservedAt ?? null,
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

function proposalResultUnverifiedError(): ApiError {
  return new ApiError(
    409,
    'proposal_result_unverified',
    'Sync the applied Coach change before finalizing its proposal result.',
  )
}

async function requireMatchingSnapshotReceipt(
  db: D1Database,
  proposal: ProposalRow,
  submittedResult: unknown,
): Promise<void> {
  if (!isCoachActionResult(submittedResult)) {
    throw proposalResultUnverifiedError()
  }
  const plan = parseJson(proposal.action_plan_json)
  if (
    !isObject(plan) ||
    !validSha256Hex(plan.sourceStateHash) ||
    !validSha256Hex(plan.sourceActionStateHash) ||
    submittedResult.proposalId !== proposal.id ||
    submittedResult.sourceStateHash !== plan.sourceStateHash ||
    (submittedResult.sourceActionStateHash !== undefined &&
      submittedResult.sourceActionStateHash !== plan.sourceActionStateHash) ||
    submittedResult.syncPending === true ||
    (proposal.state_hash !== undefined &&
      proposal.state_hash !== plan.sourceStateHash)
  ) {
    throw proposalResultUnverifiedError()
  }

  const snapshot = await db
    .prepare(
      `SELECT payload_json
       FROM workout_snapshots
       WHERE id = ?`,
    )
    .bind(SNAPSHOT_ID)
    .first<{ payload_json: string }>()
  if (!snapshot || typeof snapshot.payload_json !== 'string') {
    throw proposalResultUnverifiedError()
  }
  const payload = parseJson(snapshot.payload_json)
  const data = isObject(payload) ? payload.data : null
  const receipts = isObject(data) ? data.chatActionReceipts : null
  if (!Array.isArray(receipts)) throw proposalResultUnverifiedError()
  const matching = receipts.filter(
    (receipt) => isObject(receipt) && receipt.proposalId === proposal.id,
  )
  if (matching.length !== 1) throw proposalResultUnverifiedError()

  const receipt = matching[0]
  if (
    !isObject(receipt) ||
    !hasOnlyKeys(receipt, COACH_RECEIPT_KEYS) ||
    receipt.proposalId !== proposal.id ||
    typeof receipt.appliedAt !== 'number' ||
    !Number.isSafeInteger(receipt.appliedAt) ||
    receipt.appliedAt < 0 ||
    receipt.sourceStateHash !== plan.sourceStateHash ||
    typeof receipt.resultJson !== 'string' ||
    new TextEncoder().encode(receipt.resultJson).byteLength > MAX_RESULT_BYTES
  ) {
    throw proposalResultUnverifiedError()
  }
  const receiptResult = parseJson(receipt.resultJson)
  if (
    !isCoachActionResult(receiptResult) ||
    receiptResult.proposalId !== receipt.proposalId ||
    receiptResult.appliedAt !== receipt.appliedAt ||
    receiptResult.sourceStateHash !== receipt.sourceStateHash ||
    (receiptResult.sourceActionStateHash !== undefined &&
      receiptResult.sourceActionStateHash !== plan.sourceActionStateHash) ||
    receiptResult.appliedAt !== submittedResult.appliedAt ||
    comparableCoachResult(receiptResult) !==
      comparableCoachResult(submittedResult)
  ) {
    throw proposalResultUnverifiedError()
  }
}

async function normalizeExpiredLeases(
  db: D1Database,
  now: number,
): Promise<void> {
  const conversation = await readConversation(db)
  const expirationTransitionId = `expired:${crypto.randomUUID()}`
  await db.batch([
    db
      .prepare(
        `UPDATE codex_chat_jobs
         SET worker_id = ?, lease_token = ?
         WHERE conversation_id = ? AND status = 'leased'
           AND lease_expires_at <= ?`,
      )
      .bind(
        expirationTransitionId,
        expirationTransitionId,
        CONVERSATION_ID,
        now,
      ),
    db
      .prepare(
        `UPDATE codex_chat_conversations
         SET codex_thread_id = NULL
         WHERE id = ? AND codex_thread_id IS ?
           AND EXISTS (
             SELECT 1 FROM codex_chat_jobs
             WHERE conversation_id = ? AND status = 'leased'
               AND worker_id = ? AND lease_token = ?
           )`,
      )
      .bind(
        CONVERSATION_ID,
        conversation?.codex_thread_id ?? null,
        CONVERSATION_ID,
        expirationTransitionId,
        expirationTransitionId,
      ),
    db
      .prepare(
        `UPDATE codex_chat_jobs
         SET status = 'failed', worker_id = NULL, lease_token = NULL,
             lease_expires_at = NULL, claimed_at = NULL, completed_at = ?,
             updated_at = ?,
             last_error = COALESCE(last_error, 'max_attempts_exhausted')
         WHERE conversation_id = ? AND status = 'leased'
           AND worker_id = ? AND lease_token = ?
           AND attempts >= max_attempts`,
      )
      .bind(
        now,
        now,
        CONVERSATION_ID,
        expirationTransitionId,
        expirationTransitionId,
      ),
    db
      .prepare(
        `UPDATE codex_chat_jobs
         SET status = 'queued', available_at = ?, worker_id = NULL,
             lease_token = NULL, lease_expires_at = NULL, claimed_at = NULL,
             updated_at = ?, last_error = 'lease_expired'
         WHERE conversation_id = ? AND status = 'leased'
           AND worker_id = ? AND lease_token = ?
           AND attempts < max_attempts`,
      )
      .bind(
        now,
        now,
        CONVERSATION_ID,
        expirationTransitionId,
        expirationTransitionId,
      ),
    db
      .prepare(
        `UPDATE codex_chat_jobs
         SET status = 'failed', worker_id = NULL, lease_token = NULL,
             lease_expires_at = NULL, claimed_at = NULL, completed_at = ?,
             updated_at = ?,
             last_error = COALESCE(last_error, 'max_attempts_exhausted')
         WHERE conversation_id = ? AND status = 'queued'
           AND attempts >= max_attempts`,
      )
      .bind(now, now, CONVERSATION_ID),
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
  const includeActionPlans =
    ctx.request.headers.get(COACH_TRANSCRIPT_PROTOCOL_HEADER) ===
    COACH_TRANSCRIPT_PROTOCOL
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
    proposals: proposals.map((proposal) =>
      proposalResponse(proposal, { includeActionPlan: includeActionPlans }),
    ),
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

  // Preserve exact idempotent replays from clients that enqueued work before
  // capability hashes became mandatory. Only newly enqueued work needs the
  // complete trusted capability set.
  assertCompleteActionStateHashes(body.context)

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

async function handleReserveProposal(
  ctx: PagesContext,
  proposalId: string,
): Promise<Response> {
  if (!validOpaqueId(proposalId)) throw new ApiError(400, 'invalid_proposal_id')
  const body = await readJsonBody(ctx.request)
  const expectedUpdatedAt = body.expectedUpdatedAt
  if (
    typeof expectedUpdatedAt !== 'number' ||
    !Number.isSafeInteger(expectedUpdatedAt) ||
    expectedUpdatedAt < 0
  ) {
    throw new ApiError(
      400,
      'invalid_request',
      'expectedUpdatedAt must be a non-negative safe integer',
    )
  }
  const session = await currentDeviceSession(ctx)
  const existing = await readProposal(ctx.env.WORKOUT_DB, proposalId)
  if (!existing) throw new ApiError(404, 'proposal_not_found')
  if (existing.status !== 'proposed') {
    throw new ApiError(409, 'proposal_already_resolved')
  }
  const existingReservation = parseProposalReservation(existing.result_json)
  if (existingReservation) {
    if (existingReservation.ownerSessionId !== session.id) {
      throw reservationUnavailableError()
    }
    return json(200, {
      proposal: proposalResponse(existing),
      replayed: true,
    })
  }
  if (existing.result_json !== null) {
    throw new ApiError(409, 'proposal_state_invalid')
  }
  if (existing.updated_at !== expectedUpdatedAt) {
    throw new ApiError(
      409,
      'proposal_changed',
      'This Coach proposal changed. Refresh and review it before applying.',
    )
  }

  const now = Date.now()
  const reservationJson = JSON.stringify({
    _kind: PROPOSAL_RESERVATION_KIND,
    ownerSessionId: session.id,
    reservedAt: now,
  } satisfies ProposalReservation)
  const result = await ctx.env.WORKOUT_DB.prepare(
    `UPDATE codex_chat_action_proposals
     SET result_json = ?, updated_at = ?
     WHERE id = ? AND conversation_id = ? AND status = 'proposed'
       AND result_json IS NULL AND updated_at = ?
       AND NOT EXISTS (
         SELECT 1
         FROM codex_chat_action_proposals reserved
         WHERE reserved.conversation_id = ?
           AND reserved.status = 'proposed'
           AND reserved.result_json IS NOT NULL
           AND CASE
             WHEN json_valid(reserved.result_json) THEN
               COALESCE(
                 json_extract(reserved.result_json, '$._kind') = ?
                 AND json_type(reserved.result_json, '$.ownerSessionId') = 'text'
                 AND json_extract(reserved.result_json, '$.ownerSessionId') = ?
                 AND json_type(reserved.result_json, '$.reservedAt') = 'integer'
                 AND json_extract(reserved.result_json, '$.reservedAt') >= 0,
                 0
               )
             ELSE 0
           END = 0
       )
       AND EXISTS (
         SELECT 1
         FROM cloud_auth_sessions live_session
         WHERE live_session.id = ?
           AND live_session.revoked_at IS NULL
           AND live_session.expires_at > ?
       )`,
  )
    .bind(
      reservationJson,
      now,
      proposalId,
      CONVERSATION_ID,
      expectedUpdatedAt,
      CONVERSATION_ID,
      PROPOSAL_RESERVATION_KIND,
      session.id,
      session.id,
      now,
    )
    .run()

  if ((result.meta?.changes ?? 0) !== 1) {
    // A logout/expiry can race the authenticated preflight. Re-authenticate
    // before diagnosing proposal contention so a revoked session cannot leave
    // an orphan reservation behind.
    await currentDeviceSession(ctx)
    const current = await readProposal(ctx.env.WORKOUT_DB, proposalId)
    if (!current) throw new ApiError(404, 'proposal_not_found')
    const currentReservation = parseProposalReservation(current.result_json)
    if (
      current.status === 'proposed' &&
      currentReservation?.ownerSessionId === session.id
    ) {
      return json(200, {
        proposal: proposalResponse(current),
        replayed: true,
      })
    }
    if (current.status === 'proposed' && currentReservation) {
      throw reservationUnavailableError()
    }
    if (
      current.status === 'proposed' &&
      current.result_json === null &&
      current.updated_at === expectedUpdatedAt
    ) {
      // The target remained unchanged, so the atomic global-owner predicate
      // was the only guard that could have rejected this reservation.
      throw reservationUnavailableError()
    }
    throw new ApiError(409, 'proposal_already_resolved')
  }

  await ctx.env.WORKOUT_DB.prepare(
    `UPDATE codex_chat_conversations SET updated_at = ? WHERE id = ?`,
  )
    .bind(now, CONVERSATION_ID)
    .run()
  const reserved = await readProposal(ctx.env.WORKOUT_DB, proposalId)
  if (!reserved) throw new ApiError(404, 'proposal_not_found')
  return json(200, {
    proposal: proposalResponse(reserved),
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
  const session = await currentDeviceSession(ctx)
  const reservation = parseProposalReservation(existing.result_json)
  if (!reservation) {
    throw new ApiError(
      409,
      'proposal_not_reserved',
      'Refresh the app and reserve this proposal before applying it.',
    )
  }
  if (reservation.ownerSessionId !== session.id) {
    throw reservationUnavailableError()
  }
  if (body.status === 'applied') {
    await requireMatchingSnapshotReceipt(
      ctx.env.WORKOUT_DB,
      existing,
      persistedResult,
    )
  }
  const now = Date.now()
  const result = await ctx.env.WORKOUT_DB.prepare(
    `UPDATE codex_chat_action_proposals
     SET status = ?, result_json = ?, updated_at = ?
     WHERE id = ? AND conversation_id = ? AND status = 'proposed'
       AND result_json = ?`,
  )
    .bind(
      body.status,
      resultJson,
      now,
      proposalId,
      CONVERSATION_ID,
      existing.result_json,
    )
    .run()
  if ((result.meta?.changes ?? 0) !== 1) {
    const current = await readProposal(ctx.env.WORKOUT_DB, proposalId)
    if (
      current?.status === body.status &&
      current.result_json === resultJson
    ) {
      return json(200, { proposal: proposalResponse(current) })
    }
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
  if (existing.result_json !== null) {
    if (parseProposalReservation(existing.result_json)) {
      throw reservationLockedError()
    }
    throw new ApiError(409, 'proposal_state_invalid')
  }
  const now = Date.now()
  const result = await ctx.env.WORKOUT_DB.prepare(
    `UPDATE codex_chat_action_proposals
     SET status = 'dismissed', updated_at = ?
     WHERE id = ? AND conversation_id = ? AND status = 'proposed'
       AND result_json IS NULL`,
  )
    .bind(now, proposalId, CONVERSATION_ID)
    .run()
  if ((result.meta?.changes ?? 0) !== 1) {
    const current = await readProposal(ctx.env.WORKOUT_DB, proposalId)
    if (current?.status === 'dismissed') {
      return json(200, { proposal: proposalResponse(current) })
    }
    if (
      current?.status === 'proposed' &&
      parseProposalReservation(current.result_json)
    ) {
      throw reservationLockedError()
    }
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
  const existing = await readJob(ctx.env.WORKOUT_DB, jobId)
  if (!existing || existing.conversation_id !== CONVERSATION_ID) {
    throw new ApiError(404, 'job_not_found')
  }
  if (existing.status === 'cancelled') {
    return json(200, { job: jobResponse(existing), replayed: true })
  }
  if (existing.status !== 'queued' && existing.status !== 'leased') {
    throw new ApiError(409, 'job_not_cancellable')
  }
  const conversation = await readConversation(ctx.env.WORKOUT_DB)
  const now = Date.now()
  const cancellationTransitionId = `cancelled:${crypto.randomUUID()}`
  const cancelStatement = ctx.env.WORKOUT_DB.prepare(
    `UPDATE codex_chat_jobs
     SET status = 'cancelled',
         worker_id = CASE WHEN status = 'leased' THEN ? ELSE NULL END,
         lease_token = NULL,
         lease_expires_at = NULL, claimed_at = NULL, completed_at = ?,
         last_error = NULL, completion_hash = NULL, updated_at = ?
     WHERE id = ? AND conversation_id = ?
       AND status IN ('queued', 'leased')`,
  )
    .bind(
      cancellationTransitionId,
      now,
      now,
      jobId,
      CONVERSATION_ID,
    )

  const [result] = await ctx.env.WORKOUT_DB.batch([
    cancelStatement,
    discardConversationThreadStatement(
      ctx.env.WORKOUT_DB,
      conversation?.codex_thread_id ?? null,
      jobId,
      'cancelled',
      cancellationTransitionId,
    ),
    ctx.env.WORKOUT_DB
      .prepare(
        `UPDATE codex_chat_jobs
         SET worker_id = NULL
         WHERE id = ? AND status = 'cancelled' AND worker_id = ?`,
      )
      .bind(jobId, cancellationTransitionId),
    ctx.env.WORKOUT_DB.prepare(
      `UPDATE codex_chat_conversations
       SET updated_at = ?
       WHERE id = ? AND EXISTS (
         SELECT 1 FROM codex_chat_jobs
         WHERE id = ? AND status = 'cancelled'
       )`,
    ).bind(now, CONVERSATION_ID, jobId),
    ctx.env.WORKOUT_DB.prepare(
      `UPDATE codex_chat_bridge_heartbeat
       SET status = CASE WHEN status = 'working' THEN 'idle' ELSE status END,
           active_job_id = NULL
       WHERE id = ? AND active_job_id = ?`,
    ).bind(CONVERSATION_ID, jobId),
  ])
  if ((result.meta?.changes ?? 0) !== 1) {
    const current = await readJob(ctx.env.WORKOUT_DB, jobId)
    if (!current || current.conversation_id !== CONVERSATION_ID) {
      throw new ApiError(404, 'job_not_found')
    }
    if (current.status === 'cancelled') {
      return json(200, { job: jobResponse(current), replayed: true })
    }
    throw new ApiError(409, 'job_not_cancellable')
  }
  const cancelled = await readJob(ctx.env.WORKOUT_DB, jobId)
  return json(200, {
    job: cancelled ? jobResponse(cancelled) : null,
    replayed: false,
  })
}

const NO_RESERVED_PROPOSAL_SQL = `NOT EXISTS (
  SELECT 1
  FROM codex_chat_action_proposals reserved
  WHERE reserved.conversation_id = ?
    AND reserved.status = 'proposed'
    AND reserved.result_json IS NOT NULL
)`

async function readReservedProposalId(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id
       FROM codex_chat_action_proposals
       WHERE conversation_id = ? AND status = 'proposed'
         AND result_json IS NOT NULL
       LIMIT 1`,
    )
    .bind(CONVERSATION_ID)
    .first<{ id: string }>()
  return row?.id ?? null
}

async function handleDeleteConversation(db: D1Database): Promise<Response> {
  const guardValues = [CONVERSATION_ID] as const
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM codex_chat_action_proposals
         WHERE conversation_id = ? AND ${NO_RESERVED_PROPOSAL_SQL}`,
      )
      .bind(CONVERSATION_ID, ...guardValues),
    db
      .prepare(
        `DELETE FROM codex_chat_jobs
         WHERE conversation_id = ? AND ${NO_RESERVED_PROPOSAL_SQL}`,
      )
      .bind(CONVERSATION_ID, ...guardValues),
    db
      .prepare(
        `DELETE FROM codex_chat_messages
         WHERE conversation_id = ? AND ${NO_RESERVED_PROPOSAL_SQL}`,
      )
      .bind(CONVERSATION_ID, ...guardValues),
    db
      .prepare(
        `DELETE FROM codex_chat_contexts
         WHERE conversation_id = ? AND ${NO_RESERVED_PROPOSAL_SQL}`,
      )
      .bind(CONVERSATION_ID, ...guardValues),
    db
      .prepare(
        `DELETE FROM codex_chat_conversations
         WHERE id = ? AND ${NO_RESERVED_PROPOSAL_SQL}`,
      )
      .bind(CONVERSATION_ID, ...guardValues),
    db.prepare(
      `UPDATE codex_chat_bridge_heartbeat
       SET status = 'idle', active_job_id = NULL
       WHERE id = ? AND ${NO_RESERVED_PROPOSAL_SQL}`,
    ).bind(CONVERSATION_ID, ...guardValues),
  ])
  const conversationDelete = results[4]
  if ((conversationDelete?.meta?.changes ?? 0) !== 1) {
    const reservedProposalId = await readReservedProposalId(db)
    if (reservedProposalId) throw reservationLockedError()
    const remainingConversation = await readConversation(db)
    if (remainingConversation) {
      throw new ApiError(
        409,
        'conversation_changed',
        'The Coach conversation changed while it was being cleared. Refresh and retry.',
      )
    }
  }
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
  // The marker is independent of heartbeat version so a rolling old edge
  // cannot make the new edge mistake an unperformed migration for completion.
  // D1 batches commit atomically: detach first, then durably mark it complete.
  const [migration] = await ctx.env.WORKOUT_DB.batch([
    ctx.env.WORKOUT_DB.prepare(
      `UPDATE codex_chat_conversations
       SET codex_thread_id = NULL, updated_at = ?
       WHERE id = ? AND codex_thread_id IS NOT NULL AND ? = '1.4'
         AND EXISTS (
           SELECT 1 FROM codex_chat_maintenance
           WHERE id = ? AND bridge_v14_thread_detached_at IS NULL
         )`,
    ).bind(now, CONVERSATION_ID, bridgeVersion, CONVERSATION_ID),
    ctx.env.WORKOUT_DB.prepare(
      `UPDATE codex_chat_maintenance
       SET bridge_v14_thread_detached_at = ?
       WHERE id = ? AND bridge_v14_thread_detached_at IS NULL
         AND ? = '1.4'`,
    ).bind(now, CONVERSATION_ID, bridgeVersion),
    ctx.env.WORKOUT_DB.prepare(
      `INSERT INTO codex_chat_bridge_heartbeat
       (id, last_seen_at, status, bridge_version, model, active_job_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         status = excluded.status,
         bridge_version = CASE
           WHEN codex_chat_bridge_heartbeat.bridge_version = '1.4'
             AND (excluded.bridge_version IS NULL OR excluded.bridge_version = '1.3')
           THEN codex_chat_bridge_heartbeat.bridge_version
           ELSE excluded.bridge_version
         END,
         model = excluded.model,
         active_job_id = excluded.active_job_id`,
    ).bind(CONVERSATION_ID, now, status, bridgeVersion, model, activeJobId),
  ])
  return json(200, {
    heartbeat: {
      lastSeenAt: now,
      status,
      bridgeVersion,
      model,
      activeJobId,
      threadDetachedForUpgrade: (migration.meta?.changes ?? 0) === 1,
    },
  })
}

async function handleDiscardConversationThread(
  ctx: PagesContext,
): Promise<Response> {
  const body = await readJsonBody(ctx.request)
  if (!('expectedCodexThreadId' in body)) {
    throw new ApiError(400, 'invalid_request', 'expectedCodexThreadId is required')
  }
  const expectedCodexThreadId = optionalString(
    body.expectedCodexThreadId,
    'expectedCodexThreadId',
    300,
  )
  const now = Date.now()
  const result = await ctx.env.WORKOUT_DB.prepare(
    `UPDATE codex_chat_conversations
     SET codex_thread_id = NULL, updated_at = ?
     WHERE id = ? AND codex_thread_id IS ?`,
  )
    .bind(now, CONVERSATION_ID, expectedCodexThreadId)
    .run()
  const current = await readConversation(ctx.env.WORKOUT_DB)
  return json(200, {
    acknowledged: true,
    detached: (result.meta?.changes ?? 0) === 1,
    expectedCodexThreadId,
    codexThreadId: current?.codex_thread_id ?? null,
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
      `SELECT candidate.id
       FROM codex_chat_jobs AS candidate
       JOIN codex_chat_messages AS candidate_message
         ON candidate_message.id = candidate.user_message_id
       WHERE candidate.attempts < candidate.max_attempts
         AND candidate.status = 'queued'
         AND candidate.available_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM codex_chat_jobs AS active
           WHERE active.conversation_id = candidate.conversation_id
             AND active.status = 'leased'
             AND active.lease_expires_at > ?
         )
         AND NOT EXISTS (
           SELECT 1
           FROM codex_chat_jobs AS earlier
           JOIN codex_chat_messages AS earlier_message
             ON earlier_message.id = earlier.user_message_id
           WHERE earlier.conversation_id = candidate.conversation_id
             AND earlier.id <> candidate.id
             AND earlier.status = 'queued'
             AND earlier.attempts < earlier.max_attempts
             AND earlier_message.sequence < candidate_message.sequence
         )
       ORDER BY candidate_message.sequence ASC
       LIMIT 1`,
    )
      .bind(now, now)
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
         AND available_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM codex_chat_jobs AS active
           WHERE active.conversation_id = codex_chat_jobs.conversation_id
             AND active.id <> codex_chat_jobs.id
             AND active.status = 'leased'
             AND active.lease_expires_at > ?
         )
         AND NOT EXISTS (
           SELECT 1
           FROM codex_chat_jobs AS earlier
           JOIN codex_chat_messages AS earlier_message
             ON earlier_message.id = earlier.user_message_id
           JOIN codex_chat_messages AS candidate_message
             ON candidate_message.id = codex_chat_jobs.user_message_id
           WHERE earlier.conversation_id = codex_chat_jobs.conversation_id
             AND earlier.id <> codex_chat_jobs.id
             AND earlier.status = 'queued'
             AND earlier.attempts < earlier.max_attempts
             AND earlier_message.sequence < candidate_message.sequence
         )`,
    )
      .bind(
        workerId,
        leaseToken,
        leaseExpiresAt,
        now,
        now,
        candidate.id,
        now,
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
  if (
    body.discardCodexThread !== undefined &&
    typeof body.discardCodexThread !== 'boolean'
  ) {
    throw new ApiError(400, 'invalid_request', 'discardCodexThread must be boolean')
  }
  const discardCodexThread = body.discardCodexThread === true
  if (discardCodexThread && !('expectedCodexThreadId' in body)) {
    throw new ApiError(
      400,
      'invalid_request',
      'expectedCodexThreadId is required when discarding a thread',
    )
  }
  const expectedCodexThreadId = optionalString(
    body.expectedCodexThreadId,
    'expectedCodexThreadId',
    300,
  )
  if (discardCodexThread && codexThreadId !== null) {
    throw new ApiError(
      400,
      'invalid_request',
      'A discarded thread cannot become the resumable thread',
    )
  }

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
    const validatedPlan = validateActionPlan(body.actionPlan)
    if (!validSha256Hex(context.state_hash)) {
      throw new ApiError(409, 'state_hash_unavailable')
    }
    actionPlan = {
      ...validatedPlan,
      sourceStateHash: context.state_hash,
      sourceActionStateHash: trustedActionStateHashForPlan(
        context.context_json,
        validatedPlan.scope,
      ),
    }
    if (jsonByteLength(actionPlan) > MAX_ACTION_PLAN_BYTES) {
      throw new ApiError(413, 'action_plan_too_large')
    }
  }
  const completionHash = await sha256Hex(
    completionHashInput({
      assistantText,
      model,
      effort,
      codexThreadId,
      actionPlan,
      discardCodexThread,
      expectedCodexThreadId,
    }),
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
       SET updated_at = ?,
           codex_thread_id = CASE
             WHEN ? = 1 AND codex_thread_id IS ? THEN NULL
             ELSE COALESCE(?, codex_thread_id)
           END
       WHERE id = ? AND EXISTS (
         SELECT 1 FROM codex_chat_jobs
         WHERE id = ? AND status = 'completed' AND lease_token = ?
           AND completion_hash = ?
       )`,
    ).bind(
      now,
      discardCodexThread ? 1 : 0,
      expectedCodexThreadId,
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
  if (
    body.discardCodexThread !== undefined &&
    typeof body.discardCodexThread !== 'boolean'
  ) {
    throw new ApiError(400, 'invalid_request', 'discardCodexThread must be boolean')
  }
  const discardCodexThread = body.discardCodexThread === true
  if (discardCodexThread && !('expectedCodexThreadId' in body)) {
    throw new ApiError(
      400,
      'invalid_request',
      'expectedCodexThreadId is required when discarding a thread',
    )
  }
  const expectedCodexThreadId = optionalString(
    body.expectedCodexThreadId,
    'expectedCodexThreadId',
    300,
  )
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
  const failureTransitionId = `failed:${crypto.randomUUID()}`
  const failStatement = ctx.env.WORKOUT_DB.prepare(
    `UPDATE codex_chat_jobs
     SET status = ?, available_at = ?, worker_id = ?, lease_token = NULL,
         lease_expires_at = NULL, claimed_at = NULL, completed_at = ?,
         last_error = ?, updated_at = ?
     WHERE id = ? AND status = 'leased' AND lease_token = ?
       AND lease_expires_at > ?`,
  )
    .bind(
      nextStatus,
      availableAt,
      failureTransitionId,
      shouldRetry ? null : now,
      error,
      now,
      job.id,
      leaseToken,
      now,
    )
  const statements = [failStatement]
  if (discardCodexThread) {
    statements.push(
      discardConversationThreadStatement(
        ctx.env.WORKOUT_DB,
        expectedCodexThreadId,
        job.id,
        nextStatus,
        failureTransitionId,
      ),
    )
  }
  statements.push(
    ctx.env.WORKOUT_DB
      .prepare(
        `UPDATE codex_chat_jobs
         SET worker_id = NULL
         WHERE id = ? AND worker_id = ? AND status = ?`,
      )
      .bind(job.id, failureTransitionId, nextStatus),
  )
  const [result] = await ctx.env.WORKOUT_DB.batch(statements)
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

    const proposalReserveMatch = path.match(/^proposals\/([^/]+)\/reserve$/)
    if (proposalReserveMatch && method === 'POST') {
      return await handleReserveProposal(ctx, proposalReserveMatch[1])
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
    if (
      path === 'automation/conversation/discard-thread' &&
      method === 'POST'
    ) {
      return await handleDiscardConversationThread(ctx)
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
