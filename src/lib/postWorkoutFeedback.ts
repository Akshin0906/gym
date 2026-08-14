import type { PostWorkoutFeedbackV2 } from '../db/types'

const PAIN_IMPACTS = new Set([
  'none',
  'present_no_effect',
  'modified',
  'stopped',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function postWorkoutFeedbackValidationIssue(
  value: unknown,
): string | null {
  if (!isObject(value)) return 'must be an object'
  if (value.version !== 2) return 'has an unsupported version'
  const keys = Object.keys(value)
  if (
    keys.length !== 4 ||
    keys.some(
      (key) =>
        key !== 'version' &&
        key !== 'performance' &&
        key !== 'sessionRpe' &&
        key !== 'painImpact',
    )
  ) {
    return 'has unexpected fields'
  }
  if (
    !Number.isSafeInteger(value.performance) ||
    Number(value.performance) < 1 ||
    Number(value.performance) > 5
  ) {
    return 'performance must be a whole number from 1 to 5'
  }
  if (
    !Number.isSafeInteger(value.sessionRpe) ||
    Number(value.sessionRpe) < 0 ||
    Number(value.sessionRpe) > 10
  ) {
    return 'sessionRpe must be a whole number from 0 to 10'
  }
  if (
    typeof value.painImpact !== 'string' ||
    !PAIN_IMPACTS.has(value.painImpact)
  ) {
    return 'painImpact is invalid'
  }
  return null
}

export function assertPostWorkoutFeedback(
  value: unknown,
): asserts value is PostWorkoutFeedbackV2 {
  const issue = postWorkoutFeedbackValidationIssue(value)
  if (issue) throw new Error(`Invalid post-workout feedback: ${issue}`)
}
