import { db } from '../schema'
import { parseCoachActionResultJson } from '../../lib/coachActionResult'
import type {
  AiMemorySettings,
  AiMemorySummary,
  AiNote,
  ChatActionReceipt,
  DailyBriefing,
  Exercise,
  LoggedSet,
  ProgramRow,
  Recommendation,
  SessionTemplate,
  TemplateExercise,
  WorkoutSession,
} from '../types'

// Bump whenever the exported table set changes. v4 added Coach action receipts.
const SCHEMA_VERSION = 4
const APP_VERSION = '0.1.0'
export const MAX_IMPORT_BYTES = 20_000_000
export const MAX_IMPORT_SIZE_LABEL = '20 MB'
export const MAX_IMPORT_ROWS_PER_TABLE = 100_000

export interface ExportPayload {
  schemaVersion: number
  exportedAt: number
  appVersion: string
  data: {
    exercises: Exercise[]
    programs: ProgramRow[]
    sessionTemplates: SessionTemplate[]
    templateExercises: TemplateExercise[]
    workoutSessions: WorkoutSession[]
    loggedSets: LoggedSet[]
    recommendations: Recommendation[]
    dailyBriefings: DailyBriefing[]
    aiMemorySettings: AiMemorySettings[]
    aiNotes: AiNote[]
    aiMemorySummaries: AiMemorySummary[]
    chatActionReceipts: ChatActionReceipt[]
  }
}

type ExportTableName = keyof ExportPayload['data']

// Export schema history intentionally differs from the Dexie version number:
// v1 was the original workout graph, v2 added recommendations and AI memory,
// v3 added daily briefings, and v4 added Coach action receipts.
const EXPORT_TABLE_INTRODUCED_IN: Readonly<Record<ExportTableName, number>> = {
  exercises: 1,
  programs: 1,
  sessionTemplates: 1,
  templateExercises: 1,
  workoutSessions: 1,
  loggedSets: 1,
  recommendations: 2,
  aiMemorySettings: 2,
  aiNotes: 2,
  aiMemorySummaries: 2,
  dailyBriefings: 3,
  chatActionReceipts: 4,
}

const EXPORT_TABLE_NAMES = Object.keys(
  EXPORT_TABLE_INTRODUCED_IN,
) as ExportTableName[]

export function assertExportTableCoverage(
  dexieTableNames: readonly string[],
  data: Readonly<Record<string, unknown>>,
): void {
  const missing = dexieTableNames.filter((name) => !(name in data))
  if (missing.length > 0) {
    throw new Error(
      `Export payload is missing Dexie tables: ${missing.join(', ')}`,
    )
  }
}

export async function buildExportPayload(): Promise<ExportPayload> {
  return db.transaction('r', db.tables, async () => {
    const data = {
      exercises: await db.exercises.toArray(),
      programs: await db.programs.toArray(),
      sessionTemplates: await db.sessionTemplates.toArray(),
      templateExercises: await db.templateExercises.toArray(),
      workoutSessions: await db.workoutSessions.toArray(),
      loggedSets: await db.loggedSets.toArray(),
      recommendations: await db.recommendations.toArray(),
      dailyBriefings: await db.dailyBriefings.toArray(),
      aiMemorySettings: await db.aiMemorySettings.toArray(),
      aiNotes: await db.aiNotes.toArray(),
      aiMemorySummaries: await db.aiMemorySummaries.toArray(),
      chatActionReceipts: await db.chatActionReceipts.toArray(),
    }
    assertExportTableCoverage(
      db.tables.map((table) => table.name),
      data,
    )
    return validatePayload({
      schemaVersion: SCHEMA_VERSION,
      exportedAt: Date.now(),
      appVersion: APP_VERSION,
      data,
    })
  })
}

export function downloadExport(payload: ExportPayload): void {
  const validated = validatePayload(payload)
  const json = JSON.stringify(validated, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const date = new Date(validated.exportedAt)
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const a = document.createElement('a')
  a.href = url
  a.download = `workout-tracker-export-${yyyy}-${mm}-${dd}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isArrayOf(v: unknown, check: (x: unknown) => boolean): v is unknown[] {
  return Array.isArray(v) && v.every(check)
}

const MUSCLE_GROUPS = new Set([
  'chest',
  'back',
  'shoulders',
  'biceps',
  'triceps',
  'forearms',
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'abs',
  'traps',
])
const RECOMMENDATION_MODES = new Set([
  'push',
  'normal',
  'light',
  'deload',
  'rest',
])
const RECOVERY_STATUSES = new Set(['fresh', 'stale', 'unavailable'])
const SUMMARY_TYPES = new Set(['two_week', 'four_month'])

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || (isFiniteNumber(value) && value >= 0)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function hasUniqueStrings(values: string[]): boolean {
  return new Set(values).size === values.length
}

function hasUniqueNumbers(values: number[]): boolean {
  return new Set(values).size === values.length
}

function isRealDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function isExercise(value: unknown): value is Exercise {
  if (!isObject(value) || !isNonEmptyString(value.id)) return false
  if (!isNonEmptyString(value.name) || !MUSCLE_GROUPS.has(String(value.primaryMuscle))) {
    return false
  }
  if (
    !isStringArray(value.secondaryMuscles) ||
    !value.secondaryMuscles.every((muscle) => MUSCLE_GROUPS.has(muscle)) ||
    !hasUniqueStrings(value.secondaryMuscles) ||
    value.secondaryMuscles.includes(String(value.primaryMuscle))
  ) {
    return false
  }
  return (
    typeof value.notes === 'string' &&
    isPositiveInteger(value.defaultRestSeconds) &&
    value.defaultRestSeconds <= 3600 &&
    typeof value.isCustom === 'boolean' &&
    typeof value.hiddenFromLibrary === 'boolean' &&
    isFiniteNumber(value.createdAt) &&
    value.createdAt >= 0
  )
}

function isProgram(value: unknown): value is ProgramRow {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    (value.isActive === 0 || value.isActive === 1) &&
    isFiniteNumber(value.createdAt) &&
    value.createdAt >= 0 &&
    isNullableTimestamp(value.archivedAt) &&
    !(value.isActive === 1 && value.archivedAt !== null)
  )
}

function isSessionTemplate(value: unknown): value is SessionTemplate {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.programId) &&
    isNonEmptyString(value.name) &&
    isNonNegativeInteger(value.order)
  )
}

function isTemplateExercise(value: unknown): value is TemplateExercise {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.sessionTemplateId) &&
    isNonEmptyString(value.exerciseId) &&
    isNonNegativeInteger(value.order) &&
    isPositiveInteger(value.targetSets) &&
    value.targetSets <= 100 &&
    isNonEmptyString(value.targetRepRange)
  )
}

function isSessionSnapshot(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const exerciseIds: string[] = []
  const orders: number[] = []
  for (const item of value) {
    if (
      !isObject(item) ||
      !isNonEmptyString(item.exerciseId) ||
      !isNonNegativeInteger(item.order) ||
      !isNonNegativeInteger(item.targetSets) ||
      item.targetSets > 100 ||
      typeof item.targetRepRange !== 'string'
    ) {
      return false
    }
    exerciseIds.push(item.exerciseId)
    orders.push(item.order)
  }
  // Historical workout snapshots preserve their original sort positions.
  // Those positions can legitimately contain gaps after a workout was edited,
  // so require uniqueness without rewriting history into a dense sequence.
  return hasUniqueStrings(exerciseIds) && hasUniqueNumbers(orders)
}

function isWorkoutSession(value: unknown): value is WorkoutSession {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.id) ||
    !(value.sessionTemplateId === null || isNonEmptyString(value.sessionTemplateId)) ||
    !(value.programId === null || isNonEmptyString(value.programId)) ||
    !isNonEmptyString(value.name) ||
    !(value.programName === null || typeof value.programName === 'string') ||
    !isSessionSnapshot(value.exerciseSnapshot) ||
    !isFiniteNumber(value.startedAt) ||
    value.startedAt < 0 ||
    !isNullableTimestamp(value.completedAt) ||
    (value.completedAt !== null && value.completedAt < value.startedAt)
  ) {
    return false
  }
  const sliderValues = [value.sessionPlanned, value.sessionFeel]
  if (
    sliderValues.some(
      (slider) =>
        slider !== undefined &&
        slider !== null &&
        (!isPositiveInteger(slider) || slider > 5),
    )
  ) {
    return false
  }
  if (value.doneExerciseIds !== undefined) {
    if (!isStringArray(value.doneExerciseIds) || !hasUniqueStrings(value.doneExerciseIds)) {
      return false
    }
    const snapshotIds = new Set(
      (value.exerciseSnapshot as Array<{ exerciseId: string }>).map(
        (item) => item.exerciseId,
      ),
    )
    if (value.doneExerciseIds.some((id) => !snapshotIds.has(id))) return false
  }
  return true
}

function isLoggedSet(value: unknown): value is LoggedSet {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.workoutSessionId) &&
    isNonEmptyString(value.exerciseId) &&
    isPositiveInteger(value.setNumber) &&
    isFiniteNumber(value.weightLbs) &&
    value.weightLbs > 0 &&
    isPositiveInteger(value.reps) &&
    (value.rpe === null ||
      (isFiniteNumber(value.rpe) && value.rpe >= 1 && value.rpe <= 10)) &&
    isFiniteNumber(value.loggedAt) &&
    value.loggedAt >= 0
  )
}

function isRecommendation(value: unknown): value is Recommendation {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isFiniteNumber(value.createdAt) &&
    value.createdAt >= 0 &&
    isNonEmptyString(value.headline) &&
    RECOMMENDATION_MODES.has(String(value.mode)) &&
    isStringArray(value.bullets) &&
    isNonEmptyString(value.model)
  )
}

function isDailyBriefing(value: unknown): value is DailyBriefing {
  if (
    !isObject(value) ||
    !isRealDate(value.briefingDate) ||
    !isFiniteNumber(value.createdAt) ||
    value.createdAt < 0 ||
    !isNonEmptyString(value.source) ||
    !isFiniteNumber(value.snapshotUpdatedAt) ||
    value.snapshotUpdatedAt < 0 ||
    !isNonEmptyString(value.headline) ||
    !RECOMMENDATION_MODES.has(String(value.mode)) ||
    !isNonEmptyString(value.model) ||
    !isObject(value.sections)
  ) {
    return false
  }
  const sections = value.sections
  return (
    isNonEmptyString(sections.todaysCall) &&
    isStringArray(sections.why) &&
    typeof sections.ouraRecovery === 'string' &&
    typeof sections.trainingTrend === 'string' &&
    isStringArray(sections.watchOuts) &&
    (sections.recoveryStatus === undefined ||
      RECOVERY_STATUSES.has(String(sections.recoveryStatus)))
  )
}

function isAiMemorySettings(value: unknown): value is AiMemorySettings {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    typeof value.currentContext === 'string' &&
    typeof value.paused === 'boolean' &&
    isFiniteNumber(value.windowStartedAt) &&
    value.windowStartedAt >= 0 &&
    isFiniteNumber(value.fourMonthStartedAt) &&
    value.fourMonthStartedAt >= 0 &&
    isFiniteNumber(value.createdAt) &&
    value.createdAt >= 0 &&
    isFiniteNumber(value.updatedAt) &&
    value.updatedAt >= value.createdAt
  )
}

function isAiNote(value: unknown): value is AiNote {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.body) &&
    isFiniteNumber(value.createdAt) &&
    value.createdAt >= 0 &&
    isFiniteNumber(value.updatedAt) &&
    value.updatedAt >= value.createdAt
  )
}

function isAiMemorySummary(value: unknown): value is AiMemorySummary {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    SUMMARY_TYPES.has(String(value.periodType)) &&
    isFiniteNumber(value.periodStartAt) &&
    value.periodStartAt >= 0 &&
    isFiniteNumber(value.periodEndAt) &&
    value.periodEndAt >= value.periodStartAt &&
    isStringArray(value.bullets) &&
    isStringArray(value.sourceSessionIds) &&
    isStringArray(value.sourceNoteIds) &&
    isStringArray(value.sourceSummaryIds) &&
    isNonEmptyString(value.model) &&
    isFiniteNumber(value.createdAt) &&
    value.createdAt >= 0 &&
    isFiniteNumber(value.updatedAt) &&
    value.updatedAt >= value.createdAt
  )
}

function isChatActionReceipt(value: unknown): value is ChatActionReceipt {
  if (!(
    isObject(value) &&
    isNonEmptyString(value.proposalId) &&
    isFiniteNumber(value.appliedAt) &&
    value.appliedAt >= 0 &&
    isNonEmptyString(value.sourceStateHash) &&
    typeof value.resultJson === 'string'
  )) {
    return false
  }
  try {
    const result = parseCoachActionResultJson(value.resultJson)
    return (
      result.proposalId === value.proposalId &&
      result.appliedAt === value.appliedAt &&
      result.sourceStateHash === value.sourceStateHash
    )
  } catch {
    return false
  }
}

function hasDenseOrder(values: number[]): boolean {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted.every((value, index) => value === index)
}

function assertUnique<T>(table: string, rows: T[], key: (row: T) => string): void {
  const seen = new Set<string>()
  for (const row of rows) {
    const id = key(row)
    if (seen.has(id)) throw new Error(`Import table "${table}" has duplicate key "${id}"`)
    seen.add(id)
  }
}

function assertDenseGroupOrders<T>(
  table: string,
  rows: T[],
  group: (row: T) => string,
  order: (row: T) => number,
): void {
  const groups = new Map<string, number[]>()
  for (const row of rows) {
    const groupId = group(row)
    const values = groups.get(groupId) ?? []
    values.push(order(row))
    groups.set(groupId, values)
  }
  for (const [groupId, orders] of groups) {
    if (!hasDenseOrder(orders)) {
      throw new Error(`Import table "${table}" has invalid order for "${groupId}"`)
    }
  }
}

function assertRelationships(data: ExportPayload['data']): void {
  const exerciseIds = new Set(data.exercises.map((row) => row.id))
  const programIds = new Set(data.programs.map((row) => row.id))
  const templateIds = new Set(data.sessionTemplates.map((row) => row.id))
  const workoutIds = new Set(data.workoutSessions.map((row) => row.id))

  if (data.programs.filter((row) => row.isActive === 1).length > 1) {
    throw new Error('Import contains more than one active program')
  }
  for (const row of data.sessionTemplates) {
    if (!programIds.has(row.programId)) {
      throw new Error(`Session template "${row.id}" references a missing program`)
    }
  }
  for (const row of data.templateExercises) {
    if (!templateIds.has(row.sessionTemplateId) || !exerciseIds.has(row.exerciseId)) {
      throw new Error(`Template exercise "${row.id}" has a broken reference`)
    }
  }
  for (const row of data.workoutSessions) {
    if (row.programId !== null && !programIds.has(row.programId)) {
      throw new Error(`Workout session "${row.id}" references a missing program`)
    }
    if (row.sessionTemplateId !== null && !templateIds.has(row.sessionTemplateId)) {
      throw new Error(`Workout session "${row.id}" references a missing template`)
    }
    if (row.exerciseSnapshot.some((item) => !exerciseIds.has(item.exerciseId))) {
      throw new Error(`Workout session "${row.id}" has a missing exercise snapshot`)
    }
  }
  for (const row of data.loggedSets) {
    if (!workoutIds.has(row.workoutSessionId) || !exerciseIds.has(row.exerciseId)) {
      throw new Error(`Logged set "${row.id}" has a broken reference`)
    }
  }

  assertDenseGroupOrders(
    'sessionTemplates',
    data.sessionTemplates,
    (row) => row.programId,
    (row) => row.order,
  )
  assertDenseGroupOrders(
    'templateExercises',
    data.templateExercises,
    (row) => row.sessionTemplateId,
    (row) => row.order,
  )
  assertDenseGroupOrders(
    'loggedSets',
    data.loggedSets,
    (row) => `${row.workoutSessionId}\u0000${row.exerciseId}`,
    (row) => row.setNumber - 1,
  )
}

function validatePayload(
  raw: unknown,
  maxRowsPerTable?: number,
): ExportPayload {
  if (!isObject(raw)) throw new Error('Import file is not an object')
  if (
    raw.schemaVersion !== 1 &&
    raw.schemaVersion !== 2 &&
    raw.schemaVersion !== 3 &&
    raw.schemaVersion !== 4
  )
    throw new Error(`Unsupported schemaVersion: ${String(raw.schemaVersion)}`)
  const data = raw.data
  if (!isObject(data)) throw new Error('Import is missing `data`')
  const tableValidators = {
    exercises: isExercise,
    programs: isProgram,
    sessionTemplates: isSessionTemplate,
    templateExercises: isTemplateExercise,
    workoutSessions: isWorkoutSession,
    loggedSets: isLoggedSet,
    recommendations: isRecommendation,
    dailyBriefings: isDailyBriefing,
    aiMemorySettings: isAiMemorySettings,
    aiNotes: isAiNote,
    aiMemorySummaries: isAiMemorySummary,
    chatActionReceipts: isChatActionReceipt,
  } as const
  const schemaVersion = Number(raw.schemaVersion)
  for (const table of EXPORT_TABLE_NAMES) {
    const value = data[table]
    if (value === undefined) {
      if (schemaVersion >= EXPORT_TABLE_INTRODUCED_IN[table]) {
        throw new Error(
          `Import table "${table}" is missing for schemaVersion ${schemaVersion}`,
        )
      }
      continue
    }
    if (
      maxRowsPerTable !== undefined &&
      Array.isArray(value) &&
      value.length > maxRowsPerTable
    ) {
      throw new Error(
        `Import table "${table}" exceeds the ${maxRowsPerTable.toLocaleString('en-US')}-row limit`,
      )
    }
    const validator: (item: unknown) => boolean = tableValidators[table]
    if (!isArrayOf(value, validator)) {
      const detail =
        EXPORT_TABLE_INTRODUCED_IN[table] === 1
          ? 'is missing or malformed'
          : 'is malformed'
      throw new Error(`Import table "${table}" ${detail}`)
    }
  }
  const payload: ExportPayload = {
    schemaVersion,
    exportedAt:
      typeof raw.exportedAt === 'number' ? raw.exportedAt : Date.now(),
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
    data: {
      exercises: data.exercises as Exercise[],
      programs: data.programs as ProgramRow[],
      sessionTemplates: data.sessionTemplates as SessionTemplate[],
      templateExercises: data.templateExercises as TemplateExercise[],
      workoutSessions: data.workoutSessions as WorkoutSession[],
      loggedSets: data.loggedSets as LoggedSet[],
      recommendations: (data.recommendations ?? []) as Recommendation[],
      dailyBriefings: (data.dailyBriefings ?? []) as DailyBriefing[],
      aiMemorySettings: (data.aiMemorySettings ?? []) as AiMemorySettings[],
      aiNotes: (data.aiNotes ?? []) as AiNote[],
      aiMemorySummaries: (data.aiMemorySummaries ?? []) as AiMemorySummary[],
      chatActionReceipts: (data.chatActionReceipts ?? []) as ChatActionReceipt[],
    },
  }
  assertUnique('exercises', payload.data.exercises, (row) => row.id)
  assertUnique('programs', payload.data.programs, (row) => row.id)
  assertUnique('sessionTemplates', payload.data.sessionTemplates, (row) => row.id)
  assertUnique('templateExercises', payload.data.templateExercises, (row) => row.id)
  assertUnique('workoutSessions', payload.data.workoutSessions, (row) => row.id)
  assertUnique('loggedSets', payload.data.loggedSets, (row) => row.id)
  assertUnique('recommendations', payload.data.recommendations, (row) => row.id)
  assertUnique('dailyBriefings', payload.data.dailyBriefings, (row) => row.briefingDate)
  assertUnique('aiMemorySettings', payload.data.aiMemorySettings, (row) => row.id)
  assertUnique('aiNotes', payload.data.aiNotes, (row) => row.id)
  assertUnique('aiMemorySummaries', payload.data.aiMemorySummaries, (row) => row.id)
  assertUnique('chatActionReceipts', payload.data.chatActionReceipts, (row) => row.proposalId)
  assertRelationships(payload.data)
  return payload
}

export function assertImportByteLength(byteLength: number): void {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > MAX_IMPORT_BYTES
  ) {
    throw new Error(`Import file must be ${MAX_IMPORT_SIZE_LABEL} or smaller`)
  }
}

export async function importPayload(rawJson: string): Promise<{
  imported: Record<string, number>
}> {
  // Reject obviously oversized strings before asking TextEncoder for another
  // allocation. UTF-8 is never smaller than the JavaScript string length.
  if (rawJson.length > MAX_IMPORT_BYTES) {
    assertImportByteLength(rawJson.length)
  }
  assertImportByteLength(new TextEncoder().encode(rawJson).byteLength)
  const parsed: unknown = JSON.parse(rawJson)
  const payload = validatePayload(parsed, MAX_IMPORT_ROWS_PER_TABLE)
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()))
    await db.exercises.bulkAdd(payload.data.exercises)
    await db.programs.bulkAdd(payload.data.programs)
    await db.sessionTemplates.bulkAdd(payload.data.sessionTemplates)
    await db.templateExercises.bulkAdd(payload.data.templateExercises)
    await db.workoutSessions.bulkAdd(payload.data.workoutSessions)
    await db.loggedSets.bulkAdd(payload.data.loggedSets)
    await db.recommendations.bulkAdd(payload.data.recommendations)
    await db.dailyBriefings.bulkAdd(payload.data.dailyBriefings)
    await db.aiMemorySettings.bulkAdd(payload.data.aiMemorySettings)
    await db.aiNotes.bulkAdd(payload.data.aiNotes)
    await db.aiMemorySummaries.bulkAdd(payload.data.aiMemorySummaries)
    await db.chatActionReceipts.bulkAdd(payload.data.chatActionReceipts)
  })
  return {
    imported: {
      exercises: payload.data.exercises.length,
      programs: payload.data.programs.length,
      sessionTemplates: payload.data.sessionTemplates.length,
      templateExercises: payload.data.templateExercises.length,
      workoutSessions: payload.data.workoutSessions.length,
      loggedSets: payload.data.loggedSets.length,
      recommendations: payload.data.recommendations.length,
      dailyBriefings: payload.data.dailyBriefings.length,
      aiMemorySettings: payload.data.aiMemorySettings.length,
      aiNotes: payload.data.aiNotes.length,
      aiMemorySummaries: payload.data.aiMemorySummaries.length,
      chatActionReceipts: payload.data.chatActionReceipts.length,
    },
  }
}
