import {
  UNFINISHED_WORK_REASONS,
  type UnfinishedWorkNoteV1,
  type UnfinishedWorkReason,
} from '../db/types'

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isUnfinishedWorkReason(
  value: unknown,
): value is UnfinishedWorkReason {
  return (
    typeof value === 'string' &&
    (UNFINISHED_WORK_REASONS as readonly string[]).includes(value)
  )
}

export function unfinishedWorkValidationIssue(value: unknown): string | null {
  if (!isObject(value)) return 'must be an object'
  if (value.version !== 1) return 'has an unsupported version'
  const keys = Object.keys(value)
  if (
    keys.length !== 3 ||
    keys.some(
      (key) => key !== 'version' && key !== 'reason' && key !== 'recordedAt',
    )
  ) {
    return 'has unexpected fields'
  }
  if (!isUnfinishedWorkReason(value.reason)) {
    return 'reason must be a known unfinished-work reason'
  }
  if (!Number.isSafeInteger(value.recordedAt) || Number(value.recordedAt) < 0) {
    return 'recordedAt must be a non-negative whole number'
  }
  return null
}

export function assertUnfinishedWorkNote(
  value: unknown,
): asserts value is UnfinishedWorkNoteV1 {
  const issue = unfinishedWorkValidationIssue(value)
  if (issue) throw new Error(`Invalid unfinished-work note: ${issue}`)
}

// Deliberately neutral wording. The app records what the athlete says; it does
// not diagnose, and "Discomfort" is context for the athlete, not a finding.
export const UNFINISHED_WORK_REASON_LABELS: Record<
  UnfinishedWorkReason,
  string
> = {
  time: 'Ran out of time',
  equipment: 'Equipment unavailable',
  deliberate_change: 'Changed the plan on purpose',
  discomfort: 'Discomfort or feeling off',
  not_recorded: 'Prefer not to say',
}
