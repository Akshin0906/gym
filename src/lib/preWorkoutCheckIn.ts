import type {
  PerceivedRecoveryScore,
  PreWorkoutCheckInV1,
} from '../db/types'

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isPerceivedRecoveryScore(
  value: unknown,
): value is PerceivedRecoveryScore {
  return (
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10
  )
}

export function preWorkoutCheckInValidationIssue(
  value: unknown,
): string | null {
  if (!isObject(value)) return 'must be an object'
  if (value.version !== 1) return 'has an unsupported version'
  const keys = Object.keys(value)
  if (
    keys.length !== 3 ||
    keys.some(
      (key) =>
        key !== 'version' &&
        key !== 'perceivedRecovery' &&
        key !== 'recordedAt',
    )
  ) {
    return 'has unexpected fields'
  }
  if (
    value.perceivedRecovery !== null &&
    !isPerceivedRecoveryScore(value.perceivedRecovery)
  ) {
    return 'perceivedRecovery must be null or a whole number from 0 to 10'
  }
  if (
    !Number.isSafeInteger(value.recordedAt) ||
    Number(value.recordedAt) < 0
  ) {
    return 'recordedAt must be a non-negative whole number'
  }
  return null
}

export function assertPreWorkoutCheckIn(
  value: unknown,
): asserts value is PreWorkoutCheckInV1 {
  const issue = preWorkoutCheckInValidationIssue(value)
  if (issue) throw new Error(`Invalid pre-workout check-in: ${issue}`)
}
