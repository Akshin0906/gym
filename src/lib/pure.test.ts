import { describe, it, expect } from 'vitest'
import { getISOWeek, startOfISOWeek, subWeeks } from 'date-fns'
import {
  estimated1RM,
  buildWeeklyVolume,
  buildWeeklySetCounts,
  isoWeekCutoff,
  lastNIsoWeeks,
} from './analytics'
import { shouldRemindToBackup } from './backup'
import type { Exercise, LoggedSet, MuscleGroup } from '../db/types'

const DAY = 24 * 60 * 60 * 1000

function ex(
  id: string,
  primaryMuscle: MuscleGroup,
  secondaryMuscles: MuscleGroup[] = [],
): Exercise {
  return {
    id,
    name: id,
    primaryMuscle,
    secondaryMuscles,
    notes: '',
    defaultRestSeconds: 90,
    isCustom: false,
    hiddenFromLibrary: false,
    createdAt: 0,
  }
}

function set(
  exerciseId: string,
  weightLbs: number,
  reps: number,
  loggedAt: number,
): LoggedSet {
  return {
    id: `${exerciseId}-${loggedAt}`,
    workoutSessionId: 'w',
    exerciseId,
    setNumber: 1,
    weightLbs,
    reps,
    rpe: null,
    loggedAt,
  }
}

describe('estimated1RM (Epley)', () => {
  it('returns the weight unchanged for a single rep', () => {
    expect(estimated1RM(225, 1)).toBe(225)
  })

  it('applies weight * (1 + reps/30) for multi-rep sets', () => {
    // 100 * (1 + 10/30) = 133.33…
    expect(estimated1RM(100, 10)).toBeCloseTo(133.333, 2)
  })

  it('returns 0 for non-positive reps rather than a bogus estimate', () => {
    expect(estimated1RM(100, 0)).toBe(0)
    expect(estimated1RM(100, -3)).toBe(0)
  })
})

describe('buildWeeklyVolume', () => {
  // Local-time constructor keeps ISO-week bucketing stable across timezones.
  const week1a = new Date(2024, 0, 1, 12).getTime() // Mon, ISO week 1
  const week1b = new Date(2024, 0, 3, 12).getTime() // Wed, same ISO week
  const week2 = new Date(2024, 0, 8, 12).getTime() // Mon, ISO week 2

  it('credits the primary muscle full volume and secondaries at 0.5', () => {
    const exercises = new Map([['bench', ex('bench', 'chest', ['triceps'])]])
    const rows = buildWeeklyVolume([set('bench', 100, 10, week1a)], exercises)
    expect(rows).toHaveLength(1)
    expect(rows[0].values.chest).toBe(1000) // 100 * 10
    expect(rows[0].values.triceps).toBe(500) // half-credit
  })

  it('sums within an ISO week and splits across weeks, sorted ascending', () => {
    const exercises = new Map([['bench', ex('bench', 'chest', ['triceps'])]])
    const rows = buildWeeklyVolume(
      [
        set('bench', 100, 10, week1a),
        set('bench', 100, 10, week1b),
        set('bench', 50, 10, week2),
      ],
      exercises,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].weekStart).toBeLessThan(rows[1].weekStart)
    expect(rows[0].values.chest).toBe(2000)
    expect(rows[0].values.triceps).toBe(1000)
    expect(rows[1].values.chest).toBe(500)
    expect(rows[1].values.triceps).toBe(250)
  })

  it('skips sets whose exercise is not in the map', () => {
    const exercises = new Map([['bench', ex('bench', 'chest')]])
    const rows = buildWeeklyVolume(
      [set('bench', 100, 10, week1a), set('ghost', 999, 10, week1a)],
      exercises,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].values.chest).toBe(1000)
  })
})

describe('buildWeeklySetCounts', () => {
  const week1a = new Date(2024, 0, 1, 12).getTime() // Mon, ISO week 1
  const week1b = new Date(2024, 0, 3, 12).getTime() // Wed, same ISO week
  const week2 = new Date(2024, 0, 8, 12).getTime() // Mon, ISO week 2

  it('counts 1 set for the primary muscle and 0.5 per secondary', () => {
    const exercises = new Map([
      ['bench', ex('bench', 'chest', ['triceps', 'shoulders'])],
    ])
    const rows = buildWeeklySetCounts([set('bench', 225, 5, week1a)], exercises)
    expect(rows).toHaveLength(1)
    expect(rows[0].values.chest).toBe(1)
    expect(rows[0].values.triceps).toBe(0.5)
    expect(rows[0].values.shoulders).toBe(0.5)
  })

  it('ignores load and reps — only the count of sets matters', () => {
    const exercises = new Map([['bench', ex('bench', 'chest', ['triceps'])]])
    const rows = buildWeeklySetCounts(
      [
        set('bench', 225, 5, week1a),
        set('bench', 95, 20, week1b), // far lighter/higher-rep, still one set
        set('bench', 135, 8, week2),
      ],
      exercises,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].values.chest).toBe(2) // two sets in ISO week 1
    expect(rows[0].values.triceps).toBe(1) // 0.5 + 0.5
    expect(rows[1].values.chest).toBe(1)
    expect(rows[1].values.triceps).toBe(0.5)
  })

  it('skips sets whose exercise is not in the map', () => {
    const exercises = new Map([['bench', ex('bench', 'chest')]])
    const rows = buildWeeklySetCounts(
      [set('bench', 100, 10, week1a), set('ghost', 999, 10, week1a)],
      exercises,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].values.chest).toBe(1)
  })
})

describe('isoWeekCutoff', () => {
  it('snaps to a Monday (ISO week start) regardless of the current weekday', () => {
    // A Thursday — the old rolling cutoff would have landed mid-week.
    const thursday = new Date(2024, 0, 4, 15).getTime()
    const cutoff = isoWeekCutoff(thursday, 8)
    expect(cutoff).toBe(startOfISOWeek(cutoff).getTime())
  })

  it('spans exactly `weeks` ISO weeks inclusive of the current week', () => {
    const now = new Date(2024, 2, 14, 9).getTime()
    const cutoff = isoWeekCutoff(now, 8)
    // cutoff week + 7 later weeks === the week containing `now`.
    expect(getISOWeek(cutoff)).toBe(getISOWeek(subWeeks(now, 7)))
  })
})

describe('lastNIsoWeeks', () => {
  const exercises = new Map([['bench', ex('bench', 'chest')]])
  const now = new Date(2024, 0, 22, 12).getTime() // Mon, ISO week 4

  it('emits N contiguous weeks, filling gaps with empty buckets', () => {
    // Sets only in ISO week 1 and ISO week 4 — weeks 2 and 3 are gaps.
    const rows = buildWeeklySetCounts(
      [
        set('bench', 100, 5, new Date(2024, 0, 1, 12).getTime()), // week 1
        set('bench', 100, 5, new Date(2024, 0, 22, 12).getTime()), // week 4
      ],
      exercises,
    )
    const filled = lastNIsoWeeks(rows, 4, now)
    expect(filled).toHaveLength(4)
    // Ascending, contiguous, with the two middle weeks present but empty.
    expect(filled[0].values.chest).toBe(1) // week 1
    expect(filled[1].values.chest ?? 0).toBe(0) // week 2 (gap)
    expect(filled[2].values.chest ?? 0).toBe(0) // week 3 (gap)
    expect(filled[3].values.chest).toBe(1) // week 4
    for (let i = 1; i < filled.length; i++) {
      expect(filled[i].weekStart).toBeGreaterThan(filled[i - 1].weekStart)
    }
  })

  it('returns N empty weeks when there is no data at all', () => {
    const filled = lastNIsoWeeks([], 4, now)
    expect(filled).toHaveLength(4)
    expect(filled.every((w) => Object.keys(w.values).length === 0)).toBe(true)
  })
})

describe('shouldRemindToBackup', () => {
  const NOW = new Date(2024, 5, 1, 12).getTime()

  it('never reminds when there is no data to lose', () => {
    expect(shouldRemindToBackup(null, false, NOW)).toBe(false)
    expect(shouldRemindToBackup(NOW, false, NOW)).toBe(false)
  })

  it('reminds when data exists but no export has ever happened', () => {
    expect(shouldRemindToBackup(null, true, NOW)).toBe(true)
  })

  it('stays quiet for a recent export', () => {
    expect(shouldRemindToBackup(NOW - 10 * DAY, true, NOW)).toBe(false)
  })

  it('reminds only once strictly past the 35-day threshold', () => {
    expect(shouldRemindToBackup(NOW - 35 * DAY, true, NOW)).toBe(false)
    expect(shouldRemindToBackup(NOW - 36 * DAY, true, NOW)).toBe(true)
  })
})
