import Dexie, { type Table } from 'dexie'
import { normalizedExerciseName } from '../lib/exerciseName'
import type {
  Exercise,
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

export const db = new WorkoutDB()
