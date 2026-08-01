import { db } from '../schema'
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
    // Safety net: if a future Dexie table is added without being wired into
    // the export, surface it loudly instead of silently dropping it from
    // backups (the bug that lost dailyBriefings before schema v3).
    const missing = db.tables
      .map((t) => t.name)
      .filter((name) => !(name in data))
    if (missing.length > 0) {
      console.warn(
        `[export] tables missing from backup payload: ${missing.join(', ')}`,
      )
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: Date.now(),
      appVersion: APP_VERSION,
      data,
    }
  })
}

export function downloadExport(payload: ExportPayload): void {
  const json = JSON.stringify(payload, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const date = new Date(payload.exportedAt)
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
  return v !== null && typeof v === 'object'
}

function isArrayOf<T>(v: unknown, check: (x: unknown) => x is T): v is T[] {
  return Array.isArray(v) && v.every(check)
}

// Light validators — confirms tables are arrays of objects with an `id`.
// We're not type-checking every field; the type system trusts the export
// shape since it round-trips. A malformed file with missing tables will fail
// here, which is the actual risk we care about.
function hasStringId(x: unknown): x is { id: string } {
  return isObject(x) && typeof x.id === 'string'
}

function validatePayload(raw: unknown): ExportPayload {
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
  const requiredTables = [
    'exercises',
    'programs',
    'sessionTemplates',
    'templateExercises',
    'workoutSessions',
    'loggedSets',
  ] as const
  // Tables added after the original schema. Absent in older export files, so
  // they're optional, but if present they must be well-formed.
  const optionalTables = [
    'recommendations',
    'aiMemorySettings',
    'aiNotes',
    'aiMemorySummaries',
  ] as const
  for (const t of requiredTables) {
    if (!isArrayOf(data[t], hasStringId)) {
      throw new Error(`Import table "${t}" is missing or malformed`)
    }
  }
  for (const t of optionalTables) {
    if (data[t] !== undefined && !isArrayOf(data[t], hasStringId)) {
      throw new Error(`Import table "${t}" is malformed`)
    }
  }
  if (
    data.chatActionReceipts !== undefined &&
    !isArrayOf(
      data.chatActionReceipts,
      (x): x is { proposalId: string } =>
        isObject(x) && typeof x.proposalId === 'string',
    )
  ) {
    throw new Error('Import table "chatActionReceipts" is malformed')
  }
  // dailyBriefings is keyed by briefingDate (a date string), not id.
  if (
    data.dailyBriefings !== undefined &&
    !isArrayOf(
      data.dailyBriefings,
      (x): x is { briefingDate: string } =>
        isObject(x) && typeof x.briefingDate === 'string',
    )
  ) {
    throw new Error('Import table "dailyBriefings" is malformed')
  }
  return {
    schemaVersion: Number(raw.schemaVersion),
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
}

export async function importPayload(rawJson: string): Promise<{
  imported: Record<string, number>
}> {
  const parsed: unknown = JSON.parse(rawJson)
  const payload = validatePayload(parsed)
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
