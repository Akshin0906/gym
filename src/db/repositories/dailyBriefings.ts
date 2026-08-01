import { db } from '../schema'
import type { DailyBriefing } from '../types'

export async function upsertDailyBriefing(
  briefing: DailyBriefing,
): Promise<void> {
  await db.dailyBriefings.put(briefing)
}

export async function getLatestDailyBriefing(): Promise<
  DailyBriefing | undefined
> {
  return db.dailyBriefings.orderBy('briefingDate').reverse().first()
}
