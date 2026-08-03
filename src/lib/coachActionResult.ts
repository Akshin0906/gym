import type {
  CoachAction,
  CoachActionChange,
  CoachActionResult,
} from './chatTypes'

export const MAX_COACH_ACTION_RESULT_JSON_LENGTH = 64 * 1024

const MAX_ID_LENGTH = 200
const MAX_CHANGE_LABEL_LENGTH = 1000
const MAX_CHANGES = 12
const SHA256_PATTERN = /^[a-f0-9]{64}$/

const ACTION_TYPES = new Set<CoachAction['type']>([
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

const RESULT_KEYS = new Set([
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isBoundedNonEmptyString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength
  )
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isCoachActionChange(value: unknown): value is CoachActionChange {
  if (!isObject(value)) return false
  const keys = new Set(['type', 'label', 'entityId'])
  return (
    hasOnlyKeys(value, keys) &&
    ACTION_TYPES.has(value.type as CoachAction['type']) &&
    isBoundedNonEmptyString(value.label, MAX_CHANGE_LABEL_LENGTH) &&
    (value.entityId === undefined ||
      isBoundedNonEmptyString(value.entityId, MAX_ID_LENGTH))
  )
}

function isOptionalId(value: unknown): boolean {
  return value === undefined || isBoundedNonEmptyString(value, MAX_ID_LENGTH)
}

export function isCoachActionResult(value: unknown): value is CoachActionResult {
  if (!isObject(value) || !hasOnlyKeys(value, RESULT_KEYS)) return false
  if (
    !isBoundedNonEmptyString(value.proposalId, MAX_ID_LENGTH) ||
    typeof value.appliedAt !== 'number' ||
    !Number.isSafeInteger(value.appliedAt) ||
    value.appliedAt < 0 ||
    typeof value.sourceStateHash !== 'string' ||
    !SHA256_PATTERN.test(value.sourceStateHash) ||
    (value.sourceActionStateHash !== undefined &&
      (typeof value.sourceActionStateHash !== 'string' ||
        !SHA256_PATTERN.test(value.sourceActionStateHash))) ||
    typeof value.replayed !== 'boolean' ||
    (value.syncPending !== undefined && typeof value.syncPending !== 'boolean') ||
    !Array.isArray(value.changes) ||
    value.changes.length < 1 ||
    value.changes.length > MAX_CHANGES ||
    !value.changes.every(isCoachActionChange)
  ) {
    return false
  }
  return (
    isOptionalId(value.activeSessionId) &&
    isOptionalId(value.programId) &&
    isOptionalId(value.sessionTemplateId) &&
    isOptionalId(value.exerciseId)
  )
}

export function parseCoachActionResultJson(raw: string): CoachActionResult {
  if (raw.length > MAX_COACH_ACTION_RESULT_JSON_LENGTH) {
    throw new Error('Saved Coach action receipt is too large')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Saved Coach action receipt is malformed')
  }
  if (!isCoachActionResult(parsed)) {
    throw new Error('Saved Coach action receipt has an invalid result')
  }
  return parsed
}
