import {
  format,
  getISOWeek,
  getISOWeekYear,
  startOfISOWeek,
  subWeeks,
} from 'date-fns'
import type {
  Exercise,
  LoadConvention,
  LoggedSet,
  MuscleGroup,
} from '../db/types'
import {
  exerciseLoadConvention,
  loadSemantics,
  resolveSetLoadConvention,
  setKindOf,
} from './measurement'

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

// Epley, with the single-rep case returned exactly rather than inflated by the
// 1/30 term (a 1-rep max is the measurement, not an estimate from one).
// automation/shared_fixtures/calculations.json pins this behaviour for the
// Python supervisor too; change both or neither.
export function estimated1RM(weightLbs: number, reps: number): number {
  if (!Number.isFinite(weightLbs) || !Number.isFinite(reps)) return 0
  if (reps < 1) return 0
  if (reps === 1) return weightLbs
  return weightLbs * (1 + reps / 30)
}

// Convention-aware wrapper. Returns null when weight x reps is not a valid
// one-rep-max input (machine settings, assistance, bodyweight-only work)
// instead of returning a number that looks comparable but is not.
export function estimated1RMForLoad(
  weightLbs: number,
  reps: number,
  convention: LoadConvention,
): number | null {
  if (!loadSemantics(convention).supportsOneRepMax) return null
  const value = estimated1RM(weightLbs, reps)
  return value > 0 ? value : null
}

export function setVolume(weightLbs: number, reps: number): number {
  return weightLbs * reps
}

// Tonnage is only defined for conventions whose number is a real external load.
export function setVolumeForLoad(
  weightLbs: number,
  reps: number,
  convention: LoadConvention,
): number | null {
  if (!loadSemantics(convention).supportsTonnage) return null
  return setVolume(weightLbs, reps)
}

export interface OneRMPoint {
  loggedAt: number
  est1rm: number
}

export function buildOneRMTrend(
  sets: LoggedSet[],
  options: { includeWarmups?: boolean } = {},
): OneRMPoint[] {
  // Working sets only by default: a warm-up single is not a strength data
  // point, and mixing it into a progression chart flattens or spikes the line
  // for reasons that have nothing to do with training.
  //
  // Each set is read with its OWN frozen convention — never the exercise's
  // current setting — so a metadata edit cannot reinterpret history, and sets
  // whose load is not a one-rep-max input are omitted rather than charted.
  const points: OneRMPoint[] = []
  for (const s of sets) {
    if (!options.includeWarmups && setKindOf(s) !== 'working') continue
    const est = estimated1RMForLoad(
      s.weightLbs,
      s.reps,
      resolveSetLoadConvention(s),
    )
    if (est === null) continue
    points.push({ loggedAt: s.loggedAt, est1rm: Math.round(est) })
  }
  return points.sort((a, b) => a.loggedAt - b.loggedAt)
}

export interface WeeklyVolumeRow {
  weekKey: string
  weekStart: number
  values: Partial<Record<MuscleGroup, number>>
}

export interface WeeklyVolumeResult {
  rows: WeeklyVolumeRow[]
  // Sets whose load convention has no meaningful tonnage (machine settings,
  // assistance, bodyweight-only). Reported so the chart can say what it left
  // out instead of silently under-reporting.
  excludedSetCount: number
  // True when at least one included set only *assumed* pounds (legacy row).
  includesAssumedUnits: boolean
}

export function buildWeeklyVolume(
  sets: LoggedSet[],
  exercises: Map<string, Exercise>,
): WeeklyVolumeRow[] {
  return buildWeeklyVolumeDetailed(sets, exercises).rows
}

export function buildWeeklyVolumeDetailed(
  sets: LoggedSet[],
  exercises: Map<string, Exercise>,
): WeeklyVolumeResult {
  const buckets = new Map<
    string,
    { weekStart: number; values: Partial<Record<MuscleGroup, number>> }
  >()
  let excludedSetCount = 0
  let includesAssumedUnits = false

  for (const s of sets) {
    const exercise = exercises.get(s.exerciseId)
    if (!exercise) continue
    const convention = resolveSetLoadConvention(s)
    const v = setVolumeForLoad(s.weightLbs, s.reps, convention)
    if (v === null) {
      excludedSetCount += 1
      continue
    }
    if (convention === 'unknown') includesAssumedUnits = true
    const key = `${getISOWeekYear(s.loggedAt)}-W${String(getISOWeek(s.loggedAt)).padStart(2, '0')}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        weekStart: startOfISOWeek(s.loggedAt).getTime(),
        values: {},
      }
      buckets.set(key, bucket)
    }
    bucket.values[exercise.primaryMuscle] =
      (bucket.values[exercise.primaryMuscle] ?? 0) + v
    for (const m of new Set(exercise.secondaryMuscles)) {
      if (m === exercise.primaryMuscle) continue
      bucket.values[m] =
        (bucket.values[m] ?? 0) + v * SECONDARY_VOLUME_WEIGHT
    }
  }

  return {
    rows: Array.from(buckets.entries())
      .map(([weekKey, b]) => ({ weekKey, ...b }))
      .sort((a, b) => a.weekStart - b.weekStart),
    excludedSetCount,
    includesAssumedUnits,
  }
}

export interface WeeklyTonnageRow {
  weekKey: string
  weekStart: number
  tonnage: number
  countedSets: number
  excludedSets: number
}

// True weekly tonnage: every qualifying set contributes exactly once. Summing
// the per-muscle volume table instead would count a compound lift's tonnage
// once for its primary mover and again (at 50%) for every secondary.
export function buildWeeklyTonnage(
  sets: LoggedSet[],
  exercises: Map<string, Exercise>,
): WeeklyTonnageRow[] {
  const buckets = new Map<string, Omit<WeeklyTonnageRow, 'weekKey'>>()
  for (const s of sets) {
    const exercise = exercises.get(s.exerciseId)
    if (!exercise) continue
    const key = `${getISOWeekYear(s.loggedAt)}-W${String(getISOWeek(s.loggedAt)).padStart(2, '0')}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        weekStart: startOfISOWeek(s.loggedAt).getTime(),
        tonnage: 0,
        countedSets: 0,
        excludedSets: 0,
      }
      buckets.set(key, bucket)
    }
    const v = setVolumeForLoad(s.weightLbs, s.reps, resolveSetLoadConvention(s))
    if (v === null) {
      bucket.excludedSets += 1
      continue
    }
    bucket.tonnage += v
    bucket.countedSets += 1
  }
  return Array.from(buckets.entries())
    .map(([weekKey, b]) => ({ weekKey, ...b }))
    .sort((a, b) => a.weekStart - b.weekStart)
}

export interface TonnageSummary {
  // Sum of weight x reps over sets whose convention supports tonnage. Each set
  // is counted exactly once — muscle attribution is never summed back up,
  // because primary + weighted secondary would double count the same work.
  tonnage: number
  countedSets: number
  excludedSets: number
  assumedUnitSets: number
}

export function summarizeTonnage(sets: LoggedSet[]): TonnageSummary {
  let tonnage = 0
  let countedSets = 0
  let excludedSets = 0
  let assumedUnitSets = 0
  for (const s of sets) {
    const convention = resolveSetLoadConvention(s)
    const v = setVolumeForLoad(s.weightLbs, s.reps, convention)
    if (v === null) {
      excludedSets += 1
      continue
    }
    if (convention === 'unknown') assumedUnitSets += 1
    tonnage += v
    countedSets += 1
  }
  return { tonnage, countedSets, excludedSets, assumedUnitSets }
}

export interface WeeklySetCountRow {
  weekKey: string
  weekStart: number
  // Whole sets where this muscle was the primary mover.
  direct: Partial<Record<MuscleGroup, number>>
  // Whole sets where this muscle was a listed secondary. Kept as an integer
  // count of real sets rather than a 0.5-weighted blend, so the label
  // ("3 direct + 4 secondary") means exactly what it says.
  secondary: Partial<Record<MuscleGroup, number>>
}

// Weekly set counts per muscle, split into direct and secondary exposure.
//
// `buildWeeklySetCounts` keeps the historical blended shape (primary 1.0 +
// secondary 0.5) for callers that already chart it; `buildWeeklySetCountsSplit`
// is the honest version that never mixes the two into one ambiguous number.
export function buildWeeklySetCountsSplit(
  sets: LoggedSet[],
  exercises: Map<string, Exercise>,
  options: { workingSetsOnly?: boolean } = {},
): WeeklySetCountRow[] {
  const buckets = new Map<
    string,
    Omit<WeeklySetCountRow, 'weekKey'>
  >()

  for (const s of sets) {
    const exercise = exercises.get(s.exerciseId)
    if (!exercise) continue
    if (options.workingSetsOnly && setKindOf(s) !== 'working') continue
    const key = `${getISOWeekYear(s.loggedAt)}-W${String(getISOWeek(s.loggedAt)).padStart(2, '0')}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        weekStart: startOfISOWeek(s.loggedAt).getTime(),
        direct: {},
        secondary: {},
      }
      buckets.set(key, bucket)
    }
    bucket.direct[exercise.primaryMuscle] =
      (bucket.direct[exercise.primaryMuscle] ?? 0) + 1
    for (const m of new Set(exercise.secondaryMuscles)) {
      if (m === exercise.primaryMuscle) continue
      bucket.secondary[m] = (bucket.secondary[m] ?? 0) + 1
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
  return buildWeeklySetCountsSplit(sets, exercises).map((row) => {
    const values: Partial<Record<MuscleGroup, number>> = {}
    for (const [muscle, count] of Object.entries(row.direct)) {
      values[muscle as MuscleGroup] = count
    }
    for (const [muscle, count] of Object.entries(row.secondary)) {
      values[muscle as MuscleGroup] =
        (values[muscle as MuscleGroup] ?? 0) + count * SECONDARY_VOLUME_WEIGHT
    }
    return { weekKey: row.weekKey, weekStart: row.weekStart, values }
  })
}

// Convention labelling for a single exercise, used by detail screens so a
// number is never shown without saying what it measures.
export function exerciseLoadLabel(
  exercise: Pick<Exercise, 'measurement'> | undefined,
): LoadConvention {
  return exerciseLoadConvention(exercise)
}

export function weekLabel(weekStart: number): string {
  return format(weekStart, 'MMM d')
}
