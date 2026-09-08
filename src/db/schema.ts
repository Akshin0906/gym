import Dexie, { type Table } from 'dexie'
import { normalizedExerciseName } from '../lib/exerciseName'
import type {
  Exercise,
  MuscleGroup,
  ProgramRow,
  SessionTemplate,
  TemplateExercise,
  WorkoutSession,
  LoggedSet,
  LocalSyncState,
  Recommendation,
  DailyBriefing,
  AiMemorySettings,
  AiNote,
  AiMemorySummary,
  ChatActionReceipt,
} from './types'

// Tables that hold device-local derived state rather than trusted training
// data. They are excluded from exports, cloud snapshots, and imports.
export const LOCAL_ONLY_TABLE_NAMES: ReadonlySet<string> = new Set([
  'syncState',
])

export class WorkoutDB extends Dexie {
  exercises!: Table<Exercise, string>
  programs!: Table<ProgramRow, string>
  sessionTemplates!: Table<SessionTemplate, string>
  templateExercises!: Table<TemplateExercise, string>
  workoutSessions!: Table<WorkoutSession, string>
  loggedSets!: Table<LoggedSet, string>
  recommendations!: Table<Recommendation, string>
  dailyBriefings!: Table<DailyBriefing, string>
  aiMemorySettings!: Table<AiMemorySettings, string>
  aiNotes!: Table<AiNote, string>
  aiMemorySummaries!: Table<AiMemorySummary, string>
  chatActionReceipts!: Table<ChatActionReceipt, string>
  syncState!: Table<LocalSyncState, string>

  constructor() {
    super('workoutTracker')
    this.version(1).stores({
      exercises: 'id, name, primaryMuscle, isCustom',
      programs: 'id, isActive, archivedAt',
      sessionTemplates: 'id, programId, [programId+order]',
      templateExercises:
        'id, sessionTemplateId, exerciseId, [sessionTemplateId+order]',
      workoutSessions:
        'id, sessionTemplateId, programId, startedAt, completedAt',
      loggedSets:
        'id, workoutSessionId, exerciseId, [exerciseId+loggedAt], [workoutSessionId+exerciseId+setNumber]',
    })
    this.version(2).stores({
      recommendations: 'id, createdAt',
    })
    this.version(3).stores({
      aiMemorySettings: 'id',
      aiNotes: 'id, createdAt',
      aiMemorySummaries:
        'id, periodType, periodStartAt, periodEndAt, [periodType+periodStartAt]',
    })
    this.version(4).stores({
      dailyBriefings: 'briefingDate, createdAt',
    })
    this.version(5).stores({
      chatActionReceipts: 'proposalId, appliedAt',
    })
    this.version(6).stores({
      syncState: 'id',
    })
    // A unique index makes "one exercise per normalized name" a storage
    // invariant instead of a read-then-write race. Existing rows have no
    // `normalizedName` at all, so IndexedDB indexes none of them while the
    // index is being created; the upgrade below then fills the field in and
    // disambiguates any pre-existing collision by renaming — ids are never
    // changed, so no logged set, template, or snapshot loses its exercise.
    this.version(7)
      .stores({
        exercises: 'id, name, &normalizedName, primaryMuscle, isCustom',
      })
      .upgrade(async (tx) => {
        const table = tx.table<Exercise, string>('exercises')
        const rows = await table.toArray()
        for (const row of assignUniqueNormalizedNames(rows)) {
          await table.put(row)
        }
      })

    // Narrow, idempotent correction of three stock exercises that credited the
    // hamstrings for work that longitudinal measurement does not support (see
    // src/db/seed.ts). `seedIfEmpty` only ever populates an empty library, so
    // an existing install would otherwise keep the old mapping forever.
    //
    // It rewrites a row ONLY when that row is still exactly the stock entry it
    // shipped as: not custom, the same name, and the same secondary list. A
    // user who edited the muscles — in either direction — keeps their edit, and
    // no id, note, rest time, logged set, snapshot or history is touched. After
    // the change the old list no longer matches, so re-running is a no-op.
    this.version(8).upgrade(async (tx) => {
      const table = tx.table<Exercise, string>('exercises')
      for (const correction of HAMSTRING_CREDIT_CORRECTIONS) {
        const rows = await table
          .where('normalizedName')
          .equals(normalizedExerciseName(correction.name))
          .toArray()
        for (const row of rows) {
          const corrected = correctedStockExercise(row)
          if (corrected !== null) await table.put(corrected)
        }
      }
    })

    // Derive the uniqueness key inside Dexie rather than at each call site, so
    // no write path — repository, import, Coach action, seed, or a future one —
    // can insert an exercise that the uniqueness lookup would not see.
    this.exercises.hook('creating', (_primaryKey, row) => {
      row.normalizedName = normalizedExerciseName(row.name ?? '')
    })
    // Always derived, never accepted from the caller. Returning the key on
    // every update — not only when `name` is in the patch — is what makes it
    // unforgeable: a patch that sets `normalizedName` directly, or one that
    // changes the name through some future code path, is overwritten with the
    // value derived from the effective name.
    this.exercises.hook('updating', (modifications, _primaryKey, row) => {
      const patched = modifications as Partial<Exercise>
      const nextName =
        'name' in modifications && typeof patched.name === 'string'
          ? patched.name
          : row.name
      return { normalizedName: normalizedExerciseName(nextName) }
    })
  }
}

// Deterministically give every row a unique normalized name, renaming only the
// later duplicates (stable by createdAt then id) and only by adding a numeric
// suffix. Shared by the Dexie upgrade and by backup import so a historical
// backup containing case-variant duplicates stays importable.
export function assignUniqueNormalizedNames(rows: Exercise[]): Exercise[] {
  const ordered = rows
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const taken = new Set<string>()
  const changed: Exercise[] = []
  for (const row of ordered) {
    let name = row.name
    let normalized = normalizedExerciseName(name)
    if (taken.has(normalized)) {
      let suffix = 2
      while (taken.has(normalizedExerciseName(`${row.name} (${suffix})`))) {
        suffix += 1
      }
      name = `${row.name} (${suffix})`
      normalized = normalizedExerciseName(name)
    }
    taken.add(normalized)
    if (row.name !== name || row.normalizedName !== normalized) {
      changed.push({ ...row, name, normalizedName: normalized })
    }
  }
  return changed
}

// The exact stock rows this correction applies to. `from` is the list the seed
// shipped; anything else means the user changed it and the row is left alone.
export const HAMSTRING_CREDIT_CORRECTIONS: readonly {
  name: string
  primaryMuscle: MuscleGroup
  from: readonly MuscleGroup[]
  to: readonly MuscleGroup[]
}[] = [
  {
    name: 'Barbell Back Squat',
    primaryMuscle: 'quads',
    from: ['glutes', 'hamstrings'],
    to: ['glutes'],
  },
  {
    name: 'Leg Press',
    primaryMuscle: 'quads',
    from: ['glutes', 'hamstrings'],
    to: ['glutes'],
  },
  {
    name: 'Hip Thrust (Barbell)',
    primaryMuscle: 'glutes',
    from: ['hamstrings'],
    to: [],
  },
]

// The corrected row, or null when this row is not the untouched stock entry.
// Shared by the version-8 upgrade and by backup/cloud restore, so a legacy
// payload cannot reintroduce the old mapping after the one-time upgrade has
// already run. Every check is a reason to LEAVE the row alone: a custom row, a
// changed primary muscle, or a changed secondary list is the user's mapping.
export function correctedStockExercise(row: Exercise): Exercise | null {
  if (row.isCustom) return null
  const normalized = normalizedExerciseName(row.name)
  for (const correction of HAMSTRING_CREDIT_CORRECTIONS) {
    if (normalizedExerciseName(correction.name) !== normalized) continue
    if (row.primaryMuscle !== correction.primaryMuscle) return null
    if (!sameMuscleList(row.secondaryMuscles, correction.from)) return null
    return { ...row, secondaryMuscles: [...correction.to] }
  }
  return null
}

// Order-insensitive comparison: the stored list is a set of muscles, and a row
// that merely lists the same muscles in another order is still the stock row.
export function sameMuscleList(
  actual: readonly MuscleGroup[] | undefined,
  expected: readonly MuscleGroup[],
): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false
  const remaining = [...expected]
  for (const muscle of actual) {
    const index = remaining.indexOf(muscle)
    if (index === -1) return false
    remaining.splice(index, 1)
  }
  return remaining.length === 0
}

export const db = new WorkoutDB()
