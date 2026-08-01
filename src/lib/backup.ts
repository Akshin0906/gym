const LAST_EXPORT_KEY = 'workout-tracker:lastExportAt'

const REMIND_AFTER_MS = 35 * 24 * 60 * 60 * 1000 // 5 weeks; iOS evicts at ~7

export function getLastExportAt(): number | null {
  try {
    const raw = localStorage.getItem(LAST_EXPORT_KEY)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export function markExportedNow(): void {
  try {
    localStorage.setItem(LAST_EXPORT_KEY, String(Date.now()))
  } catch {
    // localStorage may be unavailable (rare); silent failure is fine.
  }
}

export function shouldRemindToBackup(
  lastExportAt: number | null,
  hasAnyData: boolean,
  now = Date.now(),
): boolean {
  if (!hasAnyData) return false
  if (lastExportAt === null) return true
  return now - lastExportAt > REMIND_AFTER_MS
}

export function daysSince(epochMs: number, now = Date.now()): number {
  return Math.max(0, Math.floor((now - epochMs) / (24 * 60 * 60 * 1000)))
}
