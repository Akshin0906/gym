import {
  format,
  getISOWeek,
  getISOWeekYear,
  startOfISOWeek,
  subWeeks,
} from 'date-fns'
import type { Exercise, LoggedSet, MuscleGroup } from '../db/types'

export const SECONDARY_VOLUME_WEIGHT = 0.5

function isoWeekKey(epochMs: number): string {
  return `${getISOWeekYear(epochMs)}-W${String(getISOWeek(epochMs)).padStart(2, '0')}`
}

// Start-of-ISO-week timestamp that yields exactly `weeks` whole ISO weeks ending
// in the week containing `now`. Snapping to the Monday boundary avoids a partial
// oldest week (the rolling N-weeks-ago instant lands mid-week and understates it).
export function isoWeekCutoff(now: number, weeks: number): number {
  return startOfISOWeek(subWeeks(now, weeks - 1)).getTime()
}

// Backfill a contiguous run of the last `n` ISO weeks ending in the week of
// `now`, pulling values from `rows` where present and emitting empty buckets for
// weeks with no data. Without this, "last N weeks" silently means "last N weeks
// that happen to contain a set", collapsing layoffs/deloads into adjacent columns.
export function lastNIsoWeeks(
  rows: WeeklyVolumeRow[],
  n: number,
  now: number = Date.now(),
): WeeklyVolumeRow[] {
  const byKey = new Map(rows.map((r) => [r.weekKey, r]))
  const out: WeeklyVolumeRow[] = []
  for (let i = n - 1; i >= 0; i--) {
    const weekStartDate = startOfISOWeek(subWeeks(now, i))
    const weekStart = weekStartDate.getTime()
    const weekKey = isoWeekKey(weekStart)
    out.push(byKey.get(weekKey) ?? { weekKey, weekStart, values: {} })
  }
  return out
}

export function estimated1RM(weightLbs: number, reps: number): number {
  if (reps < 1) return 0
  if (reps === 1) return weightLbs
  return weightLbs * (1 + reps / 30)
}

export function setVolume(weightLbs: number, reps: number): number {
  return weightLbs * reps
}

export interface OneRMPoint {
  loggedAt: number
  est1rm: number
}

export function buildOneRMTrend(sets: LoggedSet[]): OneRMPoint[] {
  // Plot every set's est 1RM, ordered by time.
  return sets
    .map((s) => ({
      loggedAt: s.loggedAt,
      est1rm: Math.round(estimated1RM(s.weightLbs, s.reps)),
    }))
    .sort((a, b) => a.loggedAt - b.loggedAt)
}

export interface WeeklyVolumeRow {
  weekKey: string
  weekStart: number
  values: Partial<Record<MuscleGroup, number>>
}

export function buildWeeklyVolume(
  sets: LoggedSet[],
  exercises: Map<string, Exercise>,
): WeeklyVolumeRow[] {
  const buckets = new Map<
    string,
    { weekStart: number; values: Partial<Record<MuscleGroup, number>> }
  >()

  for (const s of sets) {
    const exercise = exercises.get(s.exerciseId)
    if (!exercise) continue
    const key = `${getISOWeekYear(s.loggedAt)}-W${String(getISOWeek(s.loggedAt)).padStart(2, '0')}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        weekStart: startOfISOWeek(s.loggedAt).getTime(),
        values: {},
      }
      buckets.set(key, bucket)
    }
    const v = setVolume(s.weightLbs, s.reps)
    bucket.values[exercise.primaryMuscle] =
      (bucket.values[exercise.primaryMuscle] ?? 0) + v
    for (const m of new Set(exercise.secondaryMuscles)) {
      if (m === exercise.primaryMuscle) continue
      bucket.values[m] =
        (bucket.values[m] ?? 0) + v * SECONDARY_VOLUME_WEIGHT
    }
  }

  return Array.from(buckets.entries())
    .map(([weekKey, b]) => ({ weekKey, ...b }))
    .sort((a, b) => a.weekStart - b.weekStart)
}

// Weekly "effective sets" per muscle: 1 per set for the primary mover, and
// SECONDARY_VOLUME_WEIGHT (0.5) per set for each secondary muscle. Mirrors
// buildWeeklyVolume's bucketing but counts sets instead of tonnage, so load
// and reps don't affect the total — only how many sets touched the muscle.
export function buildWeeklySetCounts(
  sets: LoggedSet[],
  exercises: Map<string, Exercise>,
): WeeklyVolumeRow[] {
  const buckets = new Map<
    string,
    { weekStart: number; values: Partial<Record<MuscleGroup, number>> }
  >()

  for (const s of sets) {
    const exercise = exercises.get(s.exerciseId)
    if (!exercise) continue
    const key = `${getISOWeekYear(s.loggedAt)}-W${String(getISOWeek(s.loggedAt)).padStart(2, '0')}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { weekStart: startOfISOWeek(s.loggedAt).getTime(), values: {} }
      buckets.set(key, bucket)
    }
    bucket.values[exercise.primaryMuscle] =
      (bucket.values[exercise.primaryMuscle] ?? 0) + 1
    for (const m of new Set(exercise.secondaryMuscles)) {
      if (m === exercise.primaryMuscle) continue
      bucket.values[m] = (bucket.values[m] ?? 0) + SECONDARY_VOLUME_WEIGHT
    }
  }

  return Array.from(buckets.entries())
    .map(([weekKey, b]) => ({ weekKey, ...b }))
    .sort((a, b) => a.weekStart - b.weekStart)
}

export function weekLabel(weekStart: number): string {
  return format(weekStart, 'MMM d')
}
