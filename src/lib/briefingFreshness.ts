import type { DailyBriefing, DailyBriefingSections } from '../db/types'
import { pacificDate } from './cloud'

export type TrainingFreshnessLevel = 'current' | 'behind' | 'unknown'

export type TrainingFreshnessReason =
  | 'current'
  // The briefing itself says which training snapshot it read, and that
  // snapshot predates the day the briefing is for.
  | 'snapshot_older_than_briefing'
  // This device has completed work the briefing's snapshot did not contain.
  | 'workout_newer_than_briefing'
  // This device has local edits the mirror has not accepted yet.
  | 'local_changes_pending'
  // The briefing carries no usable snapshot metadata at all.
  | 'missing_metadata'

export interface BriefingFreshness {
  briefingDate: string
  briefingDateLabel: string
  // True when the briefing is for an earlier Pacific day than today.
  briefingDateIsStale: boolean
  // When the supervisor produced the briefing, from `createdAt`.
  generatedAtLabel: string | null
  training: {
    level: TrainingFreshnessLevel
    reason: TrainingFreshnessReason
    // Pacific day of the training snapshot the briefing actually read.
    snapshotDateLabel: string | null
    // Pacific day of the newest completed workout in that snapshot.
    briefingWorkoutDateLabel: string | null
    // Pacific day of the newest completed workout on this device.
    localWorkoutDateLabel: string | null
    // Whole Pacific days between the training snapshot and the briefing day.
    behindByDays: number | null
    summary: string
  }
  // Recovery is reported on its own line and never folded into the training
  // verdict: fresh Oura data says nothing about whether training data synced.
  recovery: {
    status: DailyBriefingSections['recoveryStatus']
    label: string | null
  }
  // Whether offering a "sync training data" action would actually help.
  offerSyncAction: boolean
}

export interface BriefingFreshnessInputs {
  briefing: DailyBriefing
  // Newest completed workout on this device, or null when there is none.
  localLatestCompletedAt: number | null
  // True when the durable local revision is ahead of the synced watermark.
  hasPendingLocalChanges: boolean
  now?: Date
}

export function displayShortDate(value: string): string {
  const parsed = new Date(`${value}T12:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parsed)
}

function pacificDateOrNull(epochMs: number | null | undefined): string | null {
  if (
    typeof epochMs !== 'number' ||
    !Number.isFinite(epochMs) ||
    epochMs <= 0
  ) {
    return null
  }
  const date = new Date(epochMs)
  return Number.isNaN(date.getTime()) ? null : pacificDate(date)
}

function daysBetweenIsoDates(from: string, to: string): number | null {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  return Math.round((end - start) / 86_400_000)
}

// The supervisor records the newest completed workout it saw in `inputSummary`.
// It is untrusted-shaped JSON, so read it defensively and treat anything else
// as "no metadata" rather than guessing.
export function briefingLatestCompletedWorkoutAt(
  briefing: DailyBriefing,
): number | null {
  const input = briefing.inputSummary
  if (input === null || typeof input !== 'object') return null
  if (!('latestCompletedWorkoutAt' in input)) return null
  const value = (input as { latestCompletedWorkoutAt: unknown })
    .latestCompletedWorkoutAt
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

export function recoveryStatusLabel(
  status: DailyBriefingSections['recoveryStatus'],
): string | null {
  if (status === 'stale') return 'Oura stale'
  if (status === 'unavailable') return 'No Oura'
  if (status === 'fresh') return 'Oura fresh'
  return null
}

export function evaluateBriefingFreshness(
  inputs: BriefingFreshnessInputs,
): BriefingFreshness {
  const { briefing } = inputs
  const now = inputs.now ?? new Date()
  const today = pacificDate(now)

  const snapshotDate = pacificDateOrNull(briefing.snapshotUpdatedAt)
  const briefingWorkoutAt = briefingLatestCompletedWorkoutAt(briefing)
  const briefingWorkoutDate = pacificDateOrNull(briefingWorkoutAt)
  const localWorkoutDate = pacificDateOrNull(inputs.localLatestCompletedAt)
  const generatedDate = pacificDateOrNull(briefing.createdAt)

  const behindByDays = snapshotDate
    ? daysBetweenIsoDates(snapshotDate, briefing.briefingDate)
    : null

  let level: TrainingFreshnessLevel
  let reason: TrainingFreshnessReason

  if (snapshotDate === null && briefingWorkoutDate === null) {
    level = 'unknown'
    reason = 'missing_metadata'
  } else if (
    briefingWorkoutAt !== null &&
    inputs.localLatestCompletedAt !== null &&
    inputs.localLatestCompletedAt > briefingWorkoutAt
  ) {
    // Strongest signal: this device finished work the briefing never saw.
    level = 'behind'
    reason = 'workout_newer_than_briefing'
  } else if (inputs.hasPendingLocalChanges) {
    level = 'behind'
    reason = 'local_changes_pending'
  } else if (behindByDays !== null && behindByDays > 0) {
    level = 'behind'
    reason = 'snapshot_older_than_briefing'
  } else {
    level = 'current'
    reason = 'current'
  }

  return {
    briefingDate: briefing.briefingDate,
    briefingDateLabel: displayShortDate(briefing.briefingDate),
    briefingDateIsStale: briefing.briefingDate < today,
    generatedAtLabel:
      generatedDate === null ? null : displayShortDate(generatedDate),
    training: {
      level,
      reason,
      snapshotDateLabel:
        snapshotDate === null ? null : displayShortDate(snapshotDate),
      briefingWorkoutDateLabel:
        briefingWorkoutDate === null
          ? null
          : displayShortDate(briefingWorkoutDate),
      localWorkoutDateLabel:
        localWorkoutDate === null ? null : displayShortDate(localWorkoutDate),
      behindByDays,
      summary: trainingSummary({
        reason,
        snapshotDate,
        briefingWorkoutDate,
        localWorkoutDate,
        behindByDays,
      }),
    },
    recovery: {
      status: briefing.sections.recoveryStatus,
      label: recoveryStatusLabel(briefing.sections.recoveryStatus),
    },
    // Only offer the action when uploading could change the answer. A briefing
    // built from an old snapshot with nothing new locally needs a new briefing,
    // not another upload of the same data.
    offerSyncAction:
      reason === 'workout_newer_than_briefing' ||
      reason === 'local_changes_pending',
  }
}

function trainingSummary(args: {
  reason: TrainingFreshnessReason
  snapshotDate: string | null
  briefingWorkoutDate: string | null
  localWorkoutDate: string | null
  behindByDays: number | null
}): string {
  switch (args.reason) {
    case 'missing_metadata':
      return 'Training sync date unknown'
    case 'workout_newer_than_briefing':
      return args.localWorkoutDate
        ? `Missing training through ${displayShortDate(args.localWorkoutDate)}`
        : 'Missing your newest workout'
    case 'local_changes_pending':
      return 'Local changes not synced yet'
    case 'snapshot_older_than_briefing': {
      const label = args.snapshotDate
        ? displayShortDate(args.snapshotDate)
        : 'an earlier day'
      const days = args.behindByDays
      const suffix =
        days !== null && days > 0 ? ` (${days} day${days === 1 ? '' : 's'} old)` : ''
      return `Training synced ${label}${suffix}`
    }
    default:
      return args.snapshotDate
        ? `Training synced ${displayShortDate(args.snapshotDate)}`
        : 'Training data current'
  }
}
