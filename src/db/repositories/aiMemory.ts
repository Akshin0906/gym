import { db } from '../schema'
import type {
  AiMemorySettings,
  AiMemorySummary,
  AiMemorySummaryType,
  AiNote,
} from '../types'

export const AI_MEMORY_SETTINGS_ID = 'default'

export function startOfLocalDayMs(epochMs = Date.now()): number {
  const d = new Date(epochMs)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function addCalendarDaysMs(epochMs: number, days: number): number {
  const d = new Date(epochMs)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

export function addCalendarMonthsMs(epochMs: number, months: number): number {
  const d = new Date(epochMs)
  d.setMonth(d.getMonth() + months)
  return d.getTime()
}

export async function ensureAiMemorySettings(
  now = Date.now(),
): Promise<AiMemorySettings> {
  const existing = await db.aiMemorySettings.get(AI_MEMORY_SETTINGS_ID)
  if (existing) return existing

  const start = startOfLocalDayMs(now)
  const row: AiMemorySettings = {
    id: AI_MEMORY_SETTINGS_ID,
    currentContext: '',
    paused: false,
    windowStartedAt: start,
    fourMonthStartedAt: start,
    createdAt: now,
    updatedAt: now,
  }

  try {
    await db.aiMemorySettings.add(row)
  } catch {
    const raced = await db.aiMemorySettings.get(AI_MEMORY_SETTINGS_ID)
    if (raced) return raced
    throw new Error('Could not initialize AI memory settings')
  }
  return row
}

export async function updateAiCurrentContext(
  currentContext: string,
): Promise<void> {
  const now = Date.now()
  await ensureAiMemorySettings(now)
  await db.aiMemorySettings.update(AI_MEMORY_SETTINGS_ID, {
    currentContext,
    updatedAt: now,
  })
}

export async function pauseAiMemory(): Promise<void> {
  const now = Date.now()
  await ensureAiMemorySettings(now)
  await db.aiMemorySettings.update(AI_MEMORY_SETTINGS_ID, {
    paused: true,
    updatedAt: now,
  })
}

export async function resumeAiMemory(now = Date.now()): Promise<void> {
  const start = startOfLocalDayMs(now)
  await ensureAiMemorySettings(now)
  await db.aiMemorySettings.update(AI_MEMORY_SETTINGS_ID, {
    paused: false,
    windowStartedAt: start,
    fourMonthStartedAt: start,
    updatedAt: now,
  })
}

export async function addAiNote(body: string): Promise<string> {
  const trimmed = body.trim()
  if (!trimmed) throw new Error('Note is required')
  const settings = await ensureAiMemorySettings()
  if (settings.paused) throw new Error('Resume AI memory before adding notes')

  const now = Date.now()
  const id = crypto.randomUUID()
  await db.aiNotes.add({ id, body: trimmed, createdAt: now, updatedAt: now })
  return id
}

export async function updateAiNote(id: string, body: string): Promise<void> {
  const trimmed = body.trim()
  if (!trimmed) throw new Error('Note is required')
  await db.aiNotes.update(id, { body: trimmed, updatedAt: Date.now() })
}

export async function deleteAiNote(id: string): Promise<void> {
  await db.aiNotes.delete(id)
}

export async function listAiNotesDesc(limit?: number): Promise<AiNote[]> {
  const q = db.aiNotes.orderBy('createdAt').reverse()
  return limit !== undefined ? q.limit(limit).toArray() : q.toArray()
}

export async function getAiNotesForPeriod(
  startAt: number,
  endAt: number,
): Promise<AiNote[]> {
  return db.aiNotes
    .where('createdAt')
    .between(startAt, endAt - 1)
    .sortBy('createdAt')
}

export async function listAiMemorySummariesDesc(
  limit?: number,
): Promise<AiMemorySummary[]> {
  const q = db.aiMemorySummaries.orderBy('periodEndAt').reverse()
  return limit !== undefined ? q.limit(limit).toArray() : q.toArray()
}

export async function getAiSummariesForPeriod(
  periodType: AiMemorySummaryType,
  startAt: number,
  endAt: number,
): Promise<AiMemorySummary[]> {
  const rows = await db.aiMemorySummaries
    .where('[periodType+periodStartAt]')
    .between([periodType, startAt], [periodType, endAt - 1])
    .toArray()
  return rows
    .filter((s) => s.periodEndAt <= endAt)
    .sort((a, b) => a.periodStartAt - b.periodStartAt)
}

export async function createAiMemorySummary(args: {
  periodType: AiMemorySummaryType
  periodStartAt: number
  periodEndAt: number
  bullets: string[]
  sourceSessionIds?: string[]
  sourceNoteIds?: string[]
  sourceSummaryIds?: string[]
  model: string
}): Promise<string> {
  const bullets = args.bullets.map((b) => b.trim()).filter(Boolean)
  if (args.periodType === 'two_week' && bullets.length !== 1) {
    throw new Error('Two-week summaries must have exactly one bullet')
  }
  if (args.periodType === 'four_month' && bullets.length !== 2) {
    throw new Error('Four-month summaries must have exactly two bullets')
  }
  const now = Date.now()
  const id = crypto.randomUUID()
  await db.aiMemorySummaries.add({
    id,
    periodType: args.periodType,
    periodStartAt: args.periodStartAt,
    periodEndAt: args.periodEndAt,
    bullets,
    sourceSessionIds: args.sourceSessionIds ?? [],
    sourceNoteIds: args.sourceNoteIds ?? [],
    sourceSummaryIds: args.sourceSummaryIds ?? [],
    model: args.model,
    createdAt: now,
    updatedAt: now,
  })
  return id
}

export async function updateAiMemorySummaryBullets(
  id: string,
  bullets: string[],
): Promise<void> {
  const row = await db.aiMemorySummaries.get(id)
  if (!row) throw new Error('Summary not found')
  const next = bullets.map((b) => b.trim()).filter(Boolean)
  if (row.periodType === 'two_week' && next.length !== 1) {
    throw new Error('Two-week summaries must have exactly one bullet')
  }
  if (row.periodType === 'four_month' && next.length !== 2) {
    throw new Error('Four-month summaries must have exactly two bullets')
  }
  await db.aiMemorySummaries.update(id, {
    bullets: next,
    updatedAt: Date.now(),
  })
}

export async function advanceTwoWeekWindow(nextStartAt: number): Promise<void> {
  await db.aiMemorySettings.update(AI_MEMORY_SETTINGS_ID, {
    windowStartedAt: nextStartAt,
    updatedAt: Date.now(),
  })
}

export async function advanceFourMonthEpoch(nextStartAt: number): Promise<void> {
  await db.aiMemorySettings.update(AI_MEMORY_SETTINGS_ID, {
    fourMonthStartedAt: nextStartAt,
    updatedAt: Date.now(),
  })
}

export async function saveTwoWeekSummaryAndAdvance(args: {
  periodStartAt: number
  periodEndAt: number
  bullet: string
  sourceSessionIds: string[]
  sourceNoteIds: string[]
  model: string
}): Promise<void> {
  await db.transaction(
    'rw',
    [db.aiMemorySummaries, db.aiMemorySettings],
    async () => {
      await createAiMemorySummary({
        periodType: 'two_week',
        periodStartAt: args.periodStartAt,
        periodEndAt: args.periodEndAt,
        bullets: [args.bullet],
        sourceSessionIds: args.sourceSessionIds,
        sourceNoteIds: args.sourceNoteIds,
        model: args.model,
      })
      await advanceTwoWeekWindow(args.periodEndAt)
    },
  )
}

export async function saveFourMonthSummaryAndAdvance(args: {
  periodStartAt: number
  periodEndAt: number
  bullets: string[]
  sourceSummaryIds: string[]
  model: string
}): Promise<void> {
  await db.transaction(
    'rw',
    [db.aiMemorySummaries, db.aiMemorySettings],
    async () => {
      await createAiMemorySummary({
        periodType: 'four_month',
        periodStartAt: args.periodStartAt,
        periodEndAt: args.periodEndAt,
        bullets: args.bullets,
        sourceSummaryIds: args.sourceSummaryIds,
        model: args.model,
      })
      await advanceFourMonthEpoch(args.periodEndAt)
    },
  )
}

export async function mergeCodexCloudMemory(args: {
  state: {
    currentContext: string
    paused: boolean
    windowStartedAt: number
    fourMonthStartedAt: number
  } | null
  summaries: AiMemorySummary[]
}): Promise<{ summariesAdded: number }> {
  const now = Date.now()
  let summariesAdded = 0
  await db.transaction(
    'rw',
    [db.aiMemorySettings, db.aiMemorySummaries],
    async () => {
      if (args.state) {
        const existing = await db.aiMemorySettings.get(AI_MEMORY_SETTINGS_ID)
        if (!existing) {
          await db.aiMemorySettings.add({
            id: AI_MEMORY_SETTINGS_ID,
            currentContext: args.state.currentContext,
            paused: args.state.paused,
            windowStartedAt: args.state.windowStartedAt,
            fourMonthStartedAt: args.state.fourMonthStartedAt,
            createdAt: now,
            updatedAt: now,
          })
        } else {
          const windowStartedAt = Math.max(
            existing.windowStartedAt,
            args.state.windowStartedAt,
          )
          const fourMonthStartedAt = Math.max(
            existing.fourMonthStartedAt,
            args.state.fourMonthStartedAt,
          )
          if (
            windowStartedAt !== existing.windowStartedAt ||
            fourMonthStartedAt !== existing.fourMonthStartedAt
          ) {
            await db.aiMemorySettings.update(AI_MEMORY_SETTINGS_ID, {
              windowStartedAt,
              fourMonthStartedAt,
              updatedAt: now,
            })
          }
        }
      }

      const ids = args.summaries.map((s) => s.id)
      if (ids.length === 0) return
      const existingRows = await db.aiMemorySummaries.bulkGet(ids)
      const missing = args.summaries.filter((_, index) => !existingRows[index])
      if (missing.length > 0) {
        await db.aiMemorySummaries.bulkAdd(missing)
        summariesAdded = missing.length
      }
    },
  )
  return { summariesAdded }
}

export async function deleteAiMemorySummary(id: string): Promise<void> {
  await db.aiMemorySummaries.delete(id)
}

export async function getRecentAiNotes(limit: number): Promise<AiNote[]> {
  return (await listAiNotesDesc(limit)).reverse()
}

export async function getRecentAiSummaries(args: {
  twoWeekLimit: number
  fourMonthLimit: number
}): Promise<AiMemorySummary[]> {
  const [twoWeek, fourMonth] = await Promise.all([
    db.aiMemorySummaries
      .where('periodType')
      .equals('two_week')
      .toArray()
      .then((rows) =>
        rows
          .sort((a, b) => b.periodEndAt - a.periodEndAt)
          .slice(0, args.twoWeekLimit),
      ),
    db.aiMemorySummaries
      .where('periodType')
      .equals('four_month')
      .toArray()
      .then((rows) =>
        rows
          .sort((a, b) => b.periodEndAt - a.periodEndAt)
          .slice(0, args.fourMonthLimit),
      ),
  ])
  return [...fourMonth.reverse(), ...twoWeek.reverse()]
}

export function nextTwoWeekEnd(windowStartedAt: number): number {
  return addCalendarDaysMs(windowStartedAt, 14)
}

export function nextFourMonthEnd(fourMonthStartedAt: number): number {
  return addCalendarMonthsMs(fourMonthStartedAt, 4)
}

export function isPeriodDue(periodEndAt: number, now = Date.now()): boolean {
  return periodEndAt <= now
}
