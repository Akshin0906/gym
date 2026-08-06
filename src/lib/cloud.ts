import { buildExportPayload } from '../db/repositories/exportImport'
import { upsertDailyBriefing } from '../db/repositories/dailyBriefings'
import { mergeCodexCloudMemory } from '../db/repositories/aiMemory'
import type {
  AiMemorySummary,
  AiMemorySummaryType,
  DailyBriefing,
  DailyBriefingSections,
  RecommendationMode,
  RecoveryStatus,
} from '../db/types'

const STATUS_KEY = 'workout-tracker:cloudSyncStatus'
const AUTH_PAIRED_KEY = 'workout-tracker:cloudAuthPaired'
const PENDING_SNAPSHOT_KEY = 'workout-tracker:pendingCloudSnapshot'
const STATUS_EVENT = 'workout-tracker:cloudSyncStatusChanged'
const MAX_SNAPSHOT_UPLOAD_ATTEMPTS = 3

export type CloudSnapshotTrigger =
  | 'workout_completed'
  | 'chat_action_applied'
  | 'manual'

type DurableCloudSnapshotTrigger = Exclude<
  CloudSnapshotTrigger,
  'chat_action_applied'
>

interface PendingCloudSnapshot {
  id: string
  trigger: DurableCloudSnapshotTrigger
  queuedAt: number
}

export interface CloudAuthStatus {
  paired: boolean
  device: {
    id: string
    name: string
    createdAt: number
    lastSeenAt: number
    expiresAt: number
  } | null
}

export interface CloudSyncStatus {
  lastSnapshotUploadAt: number | null
  lastSnapshotUpdatedAt: number | null
  lastSnapshotTrigger: CloudSnapshotTrigger | null
  lastSnapshotError: string | null
  lastBriefingFetchAt: number | null
  lastBriefingError: string | null
  lastMemoryFetchAt: number | null
  lastMemoryError: string | null
  lastMemorySummaryCount: number | null
}

const EMPTY_STATUS: CloudSyncStatus = {
  lastSnapshotUploadAt: null,
  lastSnapshotUpdatedAt: null,
  lastSnapshotTrigger: null,
  lastSnapshotError: null,
  lastBriefingFetchAt: null,
  lastBriefingError: null,
  lastMemoryFetchAt: null,
  lastMemoryError: null,
  lastMemorySummaryCount: null,
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

function isMode(v: unknown): v is RecommendationMode {
  return (
    v === 'push' ||
    v === 'normal' ||
    v === 'light' ||
    v === 'deload' ||
    v === 'rest'
  )
}

function stringOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : []
}

function isSummaryType(v: unknown): v is AiMemorySummaryType {
  return v === 'two_week' || v === 'four_month'
}

function readStatus(raw: string | null): CloudSyncStatus {
  if (!raw) return EMPTY_STATUS
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isObject(parsed)) return EMPTY_STATUS
    return {
      lastSnapshotUploadAt:
        typeof parsed.lastSnapshotUploadAt === 'number'
          ? parsed.lastSnapshotUploadAt
          : null,
      lastSnapshotUpdatedAt:
        typeof parsed.lastSnapshotUpdatedAt === 'number'
          ? parsed.lastSnapshotUpdatedAt
          : null,
      lastSnapshotTrigger:
        parsed.lastSnapshotTrigger === 'workout_completed' ||
        parsed.lastSnapshotTrigger === 'chat_action_applied' ||
        parsed.lastSnapshotTrigger === 'manual'
          ? parsed.lastSnapshotTrigger
          : null,
      lastSnapshotError:
        typeof parsed.lastSnapshotError === 'string'
          ? parsed.lastSnapshotError
          : null,
      lastBriefingFetchAt:
        typeof parsed.lastBriefingFetchAt === 'number'
          ? parsed.lastBriefingFetchAt
          : null,
      lastBriefingError:
        typeof parsed.lastBriefingError === 'string'
          ? parsed.lastBriefingError
          : null,
      lastMemoryFetchAt:
        typeof parsed.lastMemoryFetchAt === 'number'
          ? parsed.lastMemoryFetchAt
          : null,
      lastMemoryError:
        typeof parsed.lastMemoryError === 'string'
          ? parsed.lastMemoryError
          : null,
      lastMemorySummaryCount:
        typeof parsed.lastMemorySummaryCount === 'number'
          ? parsed.lastMemorySummaryCount
          : null,
    }
  } catch {
    return EMPTY_STATUS
  }
}

function saveStatus(patch: Partial<CloudSyncStatus>): CloudSyncStatus {
  const next = { ...getCloudSyncStatus(), ...patch }
  try {
    localStorage.setItem(STATUS_KEY, JSON.stringify(next))
    window.dispatchEvent(new Event(STATUS_EVENT))
  } catch {
    // localStorage may be unavailable; cloud sync itself can still work.
  }
  return next
}

export function getCloudSyncStatus(): CloudSyncStatus {
  try {
    return readStatus(localStorage.getItem(STATUS_KEY))
  } catch {
    return EMPTY_STATUS
  }
}

export function subscribeCloudSyncStatus(
  callback: () => void,
): () => void {
  window.addEventListener(STATUS_EVENT, callback)
  return () => window.removeEventListener(STATUS_EVENT, callback)
}

function readCloudAuthPaired(): boolean {
  try {
    return localStorage.getItem(AUTH_PAIRED_KEY) === '1'
  } catch {
    return false
  }
}

function setCloudAuthPaired(paired: boolean): void {
  try {
    if (paired) localStorage.setItem(AUTH_PAIRED_KEY, '1')
    else localStorage.removeItem(AUTH_PAIRED_KEY)
    window.dispatchEvent(new Event(STATUS_EVENT))
  } catch {
    // localStorage may be unavailable; the server cookie still controls auth.
  }
}

function readPendingCloudSnapshot(): PendingCloudSnapshot | null {
  try {
    const raw = localStorage.getItem(PENDING_SNAPSHOT_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      !isObject(parsed) ||
      typeof parsed.id !== 'string' ||
      !parsed.id ||
      (parsed.trigger !== 'workout_completed' && parsed.trigger !== 'manual') ||
      typeof parsed.queuedAt !== 'number' ||
      !Number.isFinite(parsed.queuedAt)
    ) {
      return null
    }
    return {
      id: parsed.id,
      trigger: parsed.trigger,
      queuedAt: parsed.queuedAt,
    }
  } catch {
    return null
  }
}

export function hasPendingCloudSnapshotSync(): boolean {
  return readPendingCloudSnapshot() !== null
}

function queueCloudSnapshotSync(
  trigger: CloudSnapshotTrigger,
): PendingCloudSnapshot | null {
  // Coach action receipts already provide their own durable, reservation-aware
  // retry protocol. A generic retry could outlive that reservation, so only
  // normal phone snapshots use this marker.
  if (trigger === 'chat_action_applied') return null
  const pending: PendingCloudSnapshot = {
    id: crypto.randomUUID(),
    trigger,
    queuedAt: Date.now(),
  }
  try {
    localStorage.setItem(PENDING_SNAPSHOT_KEY, JSON.stringify(pending))
    window.dispatchEvent(new Event(STATUS_EVENT))
    return pending
  } catch {
    // The upload may still succeed even when localStorage is unavailable.
    return null
  }
}

function clearPendingCloudSnapshot(pending: PendingCloudSnapshot | null): void {
  if (!pending) return
  try {
    if (readPendingCloudSnapshot()?.id !== pending.id) return
    localStorage.removeItem(PENDING_SNAPSHOT_KEY)
    window.dispatchEvent(new Event(STATUS_EVENT))
  } catch {
    // A completed upload is still valid when localStorage is unavailable.
  }
}

export function isCloudConfigured(): boolean {
  return readCloudAuthPaired()
}

function authLostError(): Error {
  setCloudAuthPaired(false)
  return new Error('Cloud device is not paired. Pair this device in Settings.')
}

function parseAuthStatus(raw: unknown): CloudAuthStatus {
  if (!isObject(raw) || raw.paired !== true) {
    return { paired: false, device: null }
  }
  const device = isObject(raw.device) ? raw.device : null
  if (
    !device ||
    typeof device.id !== 'string' ||
    typeof device.name !== 'string' ||
    typeof device.createdAt !== 'number' ||
    typeof device.lastSeenAt !== 'number' ||
    typeof device.expiresAt !== 'number'
  ) {
    return { paired: false, device: null }
  }
  return {
    paired: true,
    device: {
      id: device.id,
      name: device.name,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      expiresAt: device.expiresAt,
    },
  }
}

export async function getCloudAuthStatus(): Promise<CloudAuthStatus> {
  const res = await fetch('/api/auth/cloud', { credentials: 'include' })
  if (!res.ok) {
    const detail = await responseDetail(res)
    throw new Error(
      `Cloud auth check failed (${res.status})${detail ? `: ${detail}` : ''}`,
    )
  }
  const status = parseAuthStatus(await res.json())
  setCloudAuthPaired(status.paired)
  return status
}

export async function pairCloudDevice(
  pairingSecret: string,
  deviceName: string,
): Promise<CloudAuthStatus> {
  const res = await fetch('/api/auth/cloud', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingSecret, deviceName }),
  })
  if (!res.ok) {
    const detail = await responseDetail(res)
    throw new Error(
      `Cloud pairing failed (${res.status})${detail ? `: ${detail}` : ''}`,
    )
  }
  const status = parseAuthStatus(await res.json())
  setCloudAuthPaired(status.paired)
  return status
}

export async function unpairCloudDevice(): Promise<void> {
  const res = await fetch('/api/auth/cloud', {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) {
    const detail = await responseDetail(res)
    throw new Error(
      `Cloud sign-out failed (${res.status})${detail ? `: ${detail}` : ''}`,
    )
  }
  setCloudAuthPaired(false)
}

async function responseDetail(res: Response): Promise<string> {
  try {
    const raw = await res.text()
    return raw.slice(0, 220)
  } catch {
    return ''
  }
}

export function pacificDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const byType = new Map(parts.map((p) => [p.type, p.value]))
  return `${byType.get('year')}-${byType.get('month')}-${byType.get('day')}`
}

export function isBriefingStale(
  briefingDate: string,
  now = new Date(),
): boolean {
  return briefingDate < pacificDate(now)
}

function parseSections(raw: unknown): DailyBriefingSections {
  if (!isObject(raw)) {
    return {
      todaysCall: '',
      why: [],
      ouraRecovery: '',
      trainingTrend: '',
      watchOuts: [],
    }
  }
  const recoveryStatus =
    raw.recoveryStatus === 'fresh' ||
    raw.recoveryStatus === 'stale' ||
    raw.recoveryStatus === 'unavailable'
      ? (raw.recoveryStatus as RecoveryStatus)
      : undefined
  return {
    todaysCall: stringOrEmpty(raw.todaysCall),
    why: stringArray(raw.why),
    ...(recoveryStatus ? { recoveryStatus } : {}),
    ouraRecovery: stringOrEmpty(raw.ouraRecovery),
    trainingTrend: stringOrEmpty(raw.trainingTrend),
    watchOuts: stringArray(raw.watchOuts),
  }
}

function parseBriefing(raw: unknown): DailyBriefing {
  if (!isObject(raw)) throw new Error('Malformed briefing response')
  const mode = raw.mode
  if (!isMode(mode)) throw new Error('Malformed briefing mode')
  const briefingDate = stringOrEmpty(raw.briefingDate)
  const headline = stringOrEmpty(raw.headline)
  if (!briefingDate || !headline) throw new Error('Malformed briefing response')
  return {
    briefingDate,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    source: stringOrEmpty(raw.source) || 'codex',
    snapshotUpdatedAt:
      typeof raw.snapshotUpdatedAt === 'number' ? raw.snapshotUpdatedAt : 0,
    headline,
    mode,
    sections: parseSections(raw.sections),
    model: stringOrEmpty(raw.model) || 'codex',
    inputSummary:
      raw.inputSummary === undefined ? null : (raw.inputSummary as unknown),
  }
}

interface CloudMemoryState {
  currentContext: string
  paused: boolean
  windowStartedAt: number
  fourMonthStartedAt: number
}

function parseMemoryState(raw: unknown): CloudMemoryState | null {
  if (!isObject(raw)) return null
  if (
    typeof raw.windowStartedAt !== 'number' ||
    typeof raw.fourMonthStartedAt !== 'number'
  ) {
    return null
  }
  return {
    currentContext: stringOrEmpty(raw.currentContext),
    paused: raw.paused === true,
    windowStartedAt: raw.windowStartedAt,
    fourMonthStartedAt: raw.fourMonthStartedAt,
  }
}

function parseMemorySummary(raw: unknown): AiMemorySummary | null {
  if (!isObject(raw)) return null
  if (!isSummaryType(raw.memoryType)) return null
  const id = stringOrEmpty(raw.id)
  if (!id) return null
  if (
    typeof raw.periodStartAt !== 'number' ||
    typeof raw.periodEndAt !== 'number'
  ) {
    return null
  }
  const bullets = stringArray(raw.bullets)
    .map((b) => b.trim())
    .filter(Boolean)
  if (raw.memoryType === 'two_week' && bullets.length !== 1) return null
  if (raw.memoryType === 'four_month' && bullets.length !== 2) return null
  return {
    id,
    periodType: raw.memoryType,
    periodStartAt: raw.periodStartAt,
    periodEndAt: raw.periodEndAt,
    bullets,
    sourceSessionIds: stringArray(raw.sourceSessionIds),
    sourceNoteIds: stringArray(raw.sourceNoteIds),
    sourceSummaryIds: stringArray(raw.sourceSummaryIds),
    model: stringOrEmpty(raw.model) || 'codex',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  }
}

function parseMemoryPayload(raw: unknown): {
  state: CloudMemoryState | null
  summaries: AiMemorySummary[]
} {
  if (!isObject(raw)) throw new Error('Malformed memory response')
  const items = Array.isArray(raw.items) ? raw.items : []
  return {
    state: parseMemoryState(raw.state),
    summaries: items
      .map(parseMemorySummary)
      .filter((x): x is AiMemorySummary => x !== null),
  }
}

async function currentSnapshotUpdatedAt(): Promise<number | null> {
  const res = await fetch('/api/cloud/snapshot', {
    credentials: 'include',
    cache: 'no-store',
  })
  if (res.status === 401) throw authLostError()
  if (res.status === 404) return null
  if (!res.ok) {
    const detail = await responseDetail(res)
    throw new Error(
      `Cloud snapshot version check failed (${res.status})${detail ? `: ${detail}` : ''}`,
    )
  }

  const body: unknown = await res.json()
  const snapshot = isObject(body) ? body.snapshot : null
  const updatedAt = isObject(snapshot) ? snapshot.updatedAt : null
  if (
    typeof updatedAt !== 'number' ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0
  ) {
    throw new Error('Malformed cloud snapshot version response')
  }
  return updatedAt
}

interface CompletedWorkoutSummary {
  count: number
  latestCompletedAt: number | null
}

function completedWorkoutSummary(raw: unknown): CompletedWorkoutSummary {
  if (!Array.isArray(raw)) {
    throw new Error('Malformed cloud workout snapshot')
  }
  let count = 0
  let latestCompletedAt: number | null = null
  for (const item of raw) {
    if (!isObject(item)) continue
    const completedAt = item.completedAt
    if (typeof completedAt !== 'number' || !Number.isFinite(completedAt)) continue
    count += 1
    if (latestCompletedAt === null || completedAt > latestCompletedAt) {
      latestCompletedAt = completedAt
    }
  }
  return { count, latestCompletedAt }
}

async function currentCloudWorkoutSummary(): Promise<CompletedWorkoutSummary | null> {
  const res = await fetch('/api/cloud/snapshot', {
    credentials: 'include',
    cache: 'no-store',
  })
  if (res.status === 401) throw authLostError()
  if (res.status === 404) return null
  if (!res.ok) {
    const detail = await responseDetail(res)
    throw new Error(
      `Cloud snapshot recovery check failed (${res.status})${detail ? `: ${detail}` : ''}`,
    )
  }

  const body: unknown = await res.json()
  const snapshot = isObject(body) ? body.snapshot : null
  const payload = isObject(snapshot) ? snapshot.payload : null
  const data = isObject(payload) ? payload.data : null
  if (!isObject(data)) throw new Error('Malformed cloud workout snapshot')
  return completedWorkoutSummary(data.workoutSessions)
}

async function responseErrorCode(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.clone().json()
    return isObject(body) && typeof body.error === 'string' ? body.error : null
  } catch {
    return null
  }
}

export async function uploadCloudSnapshot(
  trigger: CloudSnapshotTrigger,
): Promise<{ updatedAt: number }> {
  const pending = queueCloudSnapshotSync(trigger)
  try {
    // The cached pairing bit is advisory. A valid secure server cookie can
    // outlive localStorage, so repair that state before abandoning an upload.
    if (!isCloudConfigured()) {
      const auth = await getCloudAuthStatus()
      if (!auth.paired) throw authLostError()
    }
    for (let attempt = 0; attempt < MAX_SNAPSHOT_UPLOAD_ATTEMPTS; attempt += 1) {
      const baseUpdatedAt = await currentSnapshotUpdatedAt()
      const payload = await buildExportPayload()
      const res = await fetch('/api/cloud/snapshot', {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'X-Source-Device': 'phone',
          'X-Snapshot-Base-Updated-At':
            baseUpdatedAt === null ? 'none' : String(baseUpdatedAt),
          ...(trigger === 'chat_action_applied'
            ? {
                'X-Coach-Protocol': 'proposal-reservation-v1',
                'X-Snapshot-Trigger': 'chat_action_applied',
              }
            : {}),
        },
        body: JSON.stringify(payload),
      })
      if (res.status === 401) throw authLostError()
      if (!res.ok) {
        const retryableVersionConflict =
          res.status === 409 &&
          (await responseErrorCode(res)) === 'snapshot_version_changed'
        if (
          retryableVersionConflict &&
          attempt + 1 < MAX_SNAPSHOT_UPLOAD_ATTEMPTS
        ) {
          continue
        }
        const detail = await responseDetail(res)
        throw new Error(
          `Cloud snapshot failed (${res.status})${detail ? `: ${detail}` : ''}`,
        )
      }
      const body: unknown = await res.json()
      const snapshot = isObject(body) ? body.snapshot : null
      const updatedAt =
        isObject(snapshot) && typeof snapshot.updatedAt === 'number'
          ? snapshot.updatedAt
          : Date.now()
      saveStatus({
        lastSnapshotUploadAt: Date.now(),
        lastSnapshotUpdatedAt: updatedAt,
        lastSnapshotTrigger: trigger,
        lastSnapshotError: null,
      })
      clearPendingCloudSnapshot(pending)
      return { updatedAt }
    }
    throw new Error('Cloud snapshot failed after version retries')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    saveStatus({ lastSnapshotError: message })
    throw err
  }
}

export async function recoverCloudSnapshot(): Promise<boolean> {
  if (!isCloudConfigured()) return false

  const pending = readPendingCloudSnapshot()
  if (pending) {
    await uploadCloudSnapshot(pending.trigger)
    return true
  }

  // This repairs workouts completed by an older app build, before durable
  // pending markers existed. Only move the mirror forward when this device has
  // a newer completed workout; do not overwrite a newer cloud source.
  const [cloud, localPayload] = await Promise.all([
    currentCloudWorkoutSummary(),
    buildExportPayload(),
  ])
  const local = completedWorkoutSummary(localPayload.data.workoutSessions)
  const cloudLatest = cloud?.latestCompletedAt ?? null
  const localIsNewer =
    local.latestCompletedAt !== null &&
    (cloudLatest === null || local.latestCompletedAt > cloudLatest)
  const localHasAdditionalLatestWorkout =
    local.latestCompletedAt !== null &&
    local.latestCompletedAt === cloudLatest &&
    local.count > (cloud?.count ?? 0)
  if (!localIsNewer && !localHasAdditionalLatestWorkout) return false

  await uploadCloudSnapshot('workout_completed')
  return true
}

export async function fetchLatestCloudBriefing(): Promise<DailyBriefing | null> {
  if (!isCloudConfigured()) return null
  try {
    const res = await fetch('/api/cloud/briefing/latest', {
      credentials: 'include',
    })
    if (res.status === 401) {
      setCloudAuthPaired(false)
      return null
    }
    if (res.status === 404) {
      saveStatus({
        lastBriefingFetchAt: Date.now(),
        lastBriefingError: null,
      })
      return null
    }
    if (!res.ok) {
      const detail = await responseDetail(res)
      throw new Error(
        `Cloud briefing fetch failed (${res.status})${detail ? `: ${detail}` : ''}`,
      )
    }
    const body: unknown = await res.json()
    const briefing = parseBriefing(isObject(body) ? body.briefing : body)
    await upsertDailyBriefing(briefing)
    saveStatus({
      lastBriefingFetchAt: Date.now(),
      lastBriefingError: null,
    })
    return briefing
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    saveStatus({ lastBriefingError: message })
    throw err
  }
}

export async function fetchCloudMemory(): Promise<{
  summariesAdded: number
  summaryCount: number
} | null> {
  if (!isCloudConfigured()) return null
  try {
    const res = await fetch('/api/cloud/memory', {
      credentials: 'include',
    })
    if (res.status === 401) {
      setCloudAuthPaired(false)
      return null
    }
    if (!res.ok) {
      const detail = await responseDetail(res)
      throw new Error(
        `Cloud memory fetch failed (${res.status})${detail ? `: ${detail}` : ''}`,
      )
    }
    const body: unknown = await res.json()
    const memory = parseMemoryPayload(body)
    const result = await mergeCodexCloudMemory(memory)
    saveStatus({
      lastMemoryFetchAt: Date.now(),
      lastMemoryError: null,
      lastMemorySummaryCount: memory.summaries.length,
    })
    return {
      summariesAdded: result.summariesAdded,
      summaryCount: memory.summaries.length,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    saveStatus({ lastMemoryError: message })
    throw err
  }
}

let installedBriefingRefresh = false

export function installCloudBriefingRefresh(): void {
  if (installedBriefingRefresh) return
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  installedBriefingRefresh = true

  let inFlight = false
  const refresh = async () => {
    if (inFlight || document.visibilityState !== 'visible') return
    inFlight = true
    try {
      try {
        const auth = await getCloudAuthStatus()
        if (auth.paired) await recoverCloudSnapshot()
      } catch {
        // Recovery status is persisted by the upload path. Briefing and memory
        // downloads remain independently useful during a transient failure.
      }
      await Promise.allSettled([
        fetchLatestCloudBriefing(),
        fetchCloudMemory(),
      ])
    } catch {
      // Foreground fetch is advisory; the cached briefing remains visible.
    } finally {
      inFlight = false
    }
  }

  void refresh()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh()
  })
  window.addEventListener('focus', () => void refresh())
  window.addEventListener('online', () => void refresh())
}
