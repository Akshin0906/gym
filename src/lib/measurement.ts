import {
  LOAD_CONVENTIONS,
  type Exercise,
  type LoadConvention,
  type LoggedSet,
  type RepBounds,
  type SessionExerciseSnapshot,
  type SetKind,
  type TemplateExercise,
} from '../db/types'

export function isLoadConvention(value: unknown): value is LoadConvention {
  return (
    typeof value === 'string' &&
    (LOAD_CONVENTIONS as readonly string[]).includes(value)
  )
}

export function isSetKind(value: unknown): value is SetKind {
  return value === 'working' || value === 'warmup'
}

export interface LoadSemantics {
  convention: LoadConvention
  // True when `weightLbs` is an external load in pounds, so weight x reps is a
  // real tonnage figure that may be summed with other exercises.
  supportsTonnage: boolean
  // True when weight x reps can be turned into a one-rep-max estimate.
  supportsOneRepMax: boolean
  // True when a bigger number means harder work. Assistance inverts this.
  higherIsHarder: boolean
  // True when the convention was actually recorded rather than assumed from a
  // legacy row. Everything downstream must label assumptions as assumptions.
  recorded: boolean
  // Short honest label for the units the number carries.
  unitLabel: string
}

const SEMANTICS: Record<
  LoadConvention,
  Omit<LoadSemantics, 'convention' | 'recorded'>
> = {
  // Legacy rows: behave exactly like `total` so no historical chart changes
  // meaning, but never claim the unit was recorded.
  unknown: {
    supportsTonnage: true,
    supportsOneRepMax: true,
    higherIsHarder: true,
    unitLabel: 'lb (assumed)',
  },
  total: {
    supportsTonnage: true,
    supportsOneRepMax: true,
    higherIsHarder: true,
    unitLabel: 'lb total',
  },
  // Comparable against itself, but the implement count is not recorded, so it
  // must never be added into a cross-exercise tonnage total.
  per_dumbbell: {
    supportsTonnage: false,
    supportsOneRepMax: true,
    higherIsHarder: true,
    unitLabel: 'lb per dumbbell',
  },
  // A pin or stack number is an ordinal, not a mass.
  machine_setting: {
    supportsTonnage: false,
    supportsOneRepMax: false,
    higherIsHarder: true,
    unitLabel: 'machine setting',
  },
  // The recorded number is added load only; bodyweight is not in the database.
  bodyweight: {
    supportsTonnage: false,
    supportsOneRepMax: false,
    higherIsHarder: true,
    unitLabel: 'lb added',
  },
  // More assistance is less work, so ordinary progression logic is inverted.
  assistance: {
    supportsTonnage: false,
    supportsOneRepMax: false,
    higherIsHarder: false,
    unitLabel: 'lb assistance',
  },
}

export function loadSemantics(convention: LoadConvention): LoadSemantics {
  return {
    convention,
    recorded: convention !== 'unknown',
    ...SEMANTICS[convention],
  }
}

// What to freeze onto a row being written NOW. Only ever used at write time.
export function exerciseLoadConvention(
  exercise: Pick<Exercise, 'measurement'> | undefined,
): LoadConvention {
  const value = exercise?.measurement?.loadConvention
  return isLoadConvention(value) ? value : 'unknown'
}

// How to READ a row that already exists.
//
// Deliberately has no access to the exercise: the current Exercise.measurement
// describes the exercise as it is configured today, and consulting it here
// would let a single edit retroactively reinterpret every historical set. A row
// with no frozen convention stays `unknown` — the compatible legacy reading —
// forever.
export function resolveSetLoadConvention(
  set: Pick<LoggedSet, 'loadConvention'>,
  snapshot?: Pick<SessionExerciseSnapshot, 'loadConvention'>,
): LoadConvention {
  if (isLoadConvention(set.loadConvention)) return set.loadConvention
  if (isLoadConvention(snapshot?.loadConvention)) {
    return snapshot.loadConvention
  }
  return 'unknown'
}

// The convention a plan row froze, or `unknown` when it predates freezing.
export function resolveSnapshotLoadConvention(
  snapshot: Pick<SessionExerciseSnapshot, 'loadConvention'> | undefined,
): LoadConvention {
  return isLoadConvention(snapshot?.loadConvention)
    ? snapshot.loadConvention
    : 'unknown'
}

// A set of rows measures one thing only when every row agrees. Returns null for
// a mixed group, which callers must report as "no comparable trajectory"
// rather than silently picking one row's units for the whole group.
export function commonLoadConvention(
  sets: readonly Pick<LoggedSet, 'loadConvention'>[],
  snapshot?: Pick<SessionExerciseSnapshot, 'loadConvention'>,
): LoadConvention | null {
  if (sets.length === 0) return resolveSnapshotLoadConvention(snapshot)
  let resolved: LoadConvention | null = null
  for (const set of sets) {
    const convention = resolveSetLoadConvention(set, snapshot)
    if (resolved === null) {
      resolved = convention
      continue
    }
    if (resolved === convention) continue
    // `unknown` and `total` are the same measurement, so they merge to the
    // recorded one rather than poisoning the group.
    if (loadConventionsComparable(resolved, convention)) {
      resolved = resolved === 'unknown' ? convention : resolved
      continue
    }
    return null
  }
  return resolved
}

export function setKindOf(set: Pick<LoggedSet, 'setKind'>): SetKind {
  return isSetKind(set.setKind) ? set.setKind : 'working'
}

export function isClassifiedSet(set: Pick<LoggedSet, 'setKind'>): boolean {
  return isSetKind(set.setKind)
}

// Planned targets, progress rings, and progression comparisons are all about
// working sets. Legacy rows have no classification and count as working, which
// is the behaviour every existing view already assumed.
// Zero is a real recorded value only where the number is an adjustment rather
// than the load itself. Mirrors allowsZeroWeight in the sessions repository,
// which is the enforcement point; this copy exists so the UI can relax the
// input's `min` without importing the repository.
export function allowsZeroLoad(convention: LoadConvention): boolean {
  return convention === 'bodyweight' || convention === 'assistance'
}

export function countWorkingSets(
  sets: readonly Pick<LoggedSet, 'setKind'>[],
): number {
  let count = 0
  for (const set of sets) if (setKindOf(set) === 'working') count += 1
  return count
}

export function isValidRepBounds(value: unknown): value is RepBounds {
  if (value === null || typeof value !== 'object') return false
  const bounds = value as Record<string, unknown>
  return (
    Object.keys(bounds).length === 2 &&
    typeof bounds.min === 'number' &&
    typeof bounds.max === 'number' &&
    Number.isSafeInteger(bounds.min) &&
    Number.isSafeInteger(bounds.max) &&
    bounds.min >= 1 &&
    bounds.max >= bounds.min &&
    bounds.max <= 1000
  )
}

// Shared with the Python supervisor: see automation/shared_fixtures and
// src/lib/sharedFixtures.test.ts. Accepts "8-12", "8 to 12", en/em dashes, an
// optional trailing "reps", and a bare single number ("10" or "10 reps").
const REP_RANGE_RE = /^(\d{1,3})\s*(?:-|–|—|to)\s*(\d{1,3})(?:\s*reps?)?$/
const SINGLE_REP_RE = /^(\d{1,3})(?:\s*reps?)?$/

export function normalizeRepRangeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase().replace(/\s+/g, ' ')
  return text.length > 0 ? text : null
}

export function parseRepRangeText(value: unknown): RepBounds | null {
  const text = normalizeRepRangeText(value)
  if (text === null) return null
  const range = REP_RANGE_RE.exec(text)
  if (range) {
    const min = Number(range[1])
    const max = Number(range[2])
    if (min < 1 || max < min) return null
    return { min, max }
  }
  const single = SINGLE_REP_RE.exec(text)
  if (single) {
    const value = Number(single[1])
    if (value < 1) return null
    return { min: value, max: value }
  }
  return null
}

export type RepTargetSource =
  | 'structured'
  | 'parsed_text'
  | 'unparseable_text'
  | 'missing'

export interface ResolvedRepTarget {
  bounds: RepBounds | null
  source: RepTargetSource
}

// Structured bounds win when present. `repBounds: null` is an explicit "this
// plan has no machine-readable target" and is not overridden by re-parsing the
// display text, which keeps a deliberate free-text prescription honest.
export function resolveRepTarget(
  plan:
    | Pick<TemplateExercise, 'targetRepRange' | 'repBounds'>
    | Pick<SessionExerciseSnapshot, 'targetRepRange' | 'repBounds'>
    | undefined,
): ResolvedRepTarget {
  if (plan === undefined) return { bounds: null, source: 'missing' }
  if (isValidRepBounds(plan.repBounds)) {
    return { bounds: plan.repBounds, source: 'structured' }
  }
  if (plan.repBounds === null) {
    return { bounds: null, source: 'unparseable_text' }
  }
  const text = normalizeRepRangeText(plan.targetRepRange)
  if (text === null) return { bounds: null, source: 'missing' }
  const parsed = parseRepRangeText(text)
  return parsed
    ? { bounds: parsed, source: 'parsed_text' }
    : { bounds: null, source: 'unparseable_text' }
}

// Derive structured bounds from display text when saving a plan. Returns
// `undefined` (field omitted) when the text does not parse, so a legacy row
// keeps behaving like a legacy row instead of being pinned to a guessed range.
export function deriveRepBounds(targetRepRange: string): RepBounds | undefined {
  return parseRepRangeText(targetRepRange) ?? undefined
}

export type RepAttainment =
  | 'in_range'
  | 'below_min'
  | 'above_max'
  | 'no_target'

export function repAttainment(
  reps: number,
  bounds: RepBounds | null,
): RepAttainment {
  if (bounds === null) return 'no_target'
  if (reps < bounds.min) return 'below_min'
  if (reps > bounds.max) return 'above_max'
  return 'in_range'
}

// Two sets are load-comparable when their conventions agree. `unknown` is
// comparable with `unknown` and with `total`, because legacy rows are read as
// total load; nothing else is mixed.
export function loadConventionsComparable(
  a: LoadConvention,
  b: LoadConvention,
): boolean {
  if (a === b) return true
  const totals = new Set<LoadConvention>(['unknown', 'total'])
  return totals.has(a) && totals.has(b)
}

export const LOAD_CONVENTION_LABELS: Record<LoadConvention, string> = {
  unknown: 'Not recorded (read as total pounds)',
  total: 'Total weight lifted',
  per_dumbbell: 'Weight per dumbbell',
  machine_setting: 'Machine setting or pin number',
  bodyweight: 'Bodyweight (number is added weight)',
  assistance: 'Assisted (number is assistance)',
}

export const LOAD_CONVENTION_SHORT_LABELS: Record<LoadConvention, string> = {
  unknown: 'lb',
  total: 'lb',
  per_dumbbell: 'lb/dumbbell',
  machine_setting: 'setting',
  bodyweight: 'lb added',
  assistance: 'lb assist',
}
