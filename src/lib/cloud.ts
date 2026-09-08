import {
  buildExportPayload,
  buildExportPayloadAtRevision,
} from '../db/repositories/exportImport'
import { upsertDailyBriefing } from '../db/repositories/dailyBriefings'
import { mergeCodexCloudMemory } from '../db/repositories/aiMemory'
import { listPendingCoachActionResults } from '../db/repositories/chatActions'
import {
  advanceAuthEpoch,
  advanceAuthEpochIfCurrent,
  clearAutoSyncBackoff,
  getLocalSyncState,
  isAutoSyncBackedOff,
  readSyncFence,
  recordSyncFailure,
  recordSyncSuccess,
  subscribeLocalMutations,
} from '../db/repositories/syncState'
import type { SyncFence } from '../db/types'
import { BRIEFING_MODE_REASONS } from '../db/types'
import type {
  AiMemorySummary,
  BriefingModeReason,
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

const NOT_PAIRED_MESSAGE =
  'Cloud device is not paired. Pair this device in Settings.'

export class CloudAuthLostError extends Error {
  constructor() {
    super(NOT_PAIRED_MESSAGE)
    this.name = 'CloudAuthLostError'
  }
}

// Handle a 401 that arrived under a specific session identity.
//
// A 401 only means "this session is gone" for the session that issued the
// request. A reply from a request made before a logout and re-pair must not
// tear down the new session, so the fence decides whether to act.
async function handleAuthLoss(fence: SyncFence): Promise<CloudAuthLostError> {
  try {
    const fenced = await advanceAuthEpochIfCurrent(fence)
    if (fenced) setCloudAuthPaired(false)
  } catch {
    // Best effort; the pending comparison fails safe towards "still pending".
  }
  return new CloudAuthLostError()
}

// Unfenced variant for call sites that have no captured identity because they
// are establishing one (the pairing status probe itself).
function authLostError(): Error {
  setCloudAuthPaired(false)
  void advanceAuthEpoch().catch(() => {})
  return new CloudAuthLostError()
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

// Apply a pairing verdict only if the session it was asked about is still the
// current one. A read issued before a re-pair can return `paired: false` long
// after the new session exists; applying it would unpair a live device.
async function applyPairedIfCurrent(
  fence: SyncFence,
  paired: boolean,
): Promise<boolean> {
  if (paired) {
    setCloudAuthPaired(true)
    return true
  }
  const current = await getLocalSyncState()
  if (current.authEpoch !== fence.authEpoch) return false
  setCloudAuthPaired(false)
  return true
}

export async function getCloudAuthStatus(): Promise<CloudAuthStatus> {
  const fence = await readSyncFence()
  const res = await fetch('/api/auth/cloud', { credentials: 'include' })
  if (!res.ok) {
    const detail = await responseDetail(res)
    throw new Error(
      `Cloud auth check failed (${res.status})${detail ? `: ${detail}` : ''}`,
    )
  }
  const status = parseAuthStatus(await res.json())
  await applyPairedIfCurrent(fence, status.paired)
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
  // A new session invalidates every operation started under the old one, and
  // this mirror has never seen this device's data. Both facts are the same
  // epoch bump, which also resets the watermark.
  await advanceAuthEpoch()
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
  await advanceAuthEpoch()
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
  // Unknown or absent stays absent: an older briefing simply does not carry
  // this, and a value the app does not recognize is not rendered as one.
  const modeReasonLabel = (
    BRIEFING_MODE_REASONS as readonly string[]
  ).includes(raw.modeReasonLabel as string)
    ? (raw.modeReasonLabel as BriefingModeReason)
    : undefined
  return {
    todaysCall: stringOrEmpty(raw.todaysCall),
    why: stringArray(raw.why),
    ...(recoveryStatus ? { recoveryStatus } : {}),
    ouraRecovery: stringOrEmpty(raw.ouraRecovery),
    trainingTrend: stringOrEmpty(raw.trainingTrend),
    watchOuts: stringArray(raw.watchOuts),
    ...(modeReasonLabel ? { modeReasonLabel } : {}),
  }
}

// Exported for tests: the parser is where an optional supervisor-owned field
// gets silently dropped, and that is exactly what needs asserting.
export function parseCloudBriefingForTest(raw: unknown): DailyBriefing {
  return parseBriefing(raw)
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

async function currentSnapshotUpdatedAt(
  fence: SyncFence,
): Promise<number | null> {
  const res = await fetch('/api/cloud/snapshot', {
    credentials: 'include',
    cache: 'no-store',
  })
  if (res.status === 401) throw await handleAuthLoss(fence)
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

async function currentCloudWorkoutSummary(
  fence: SyncFence,
): Promise<CompletedWorkoutSummary | null> {
  const res = await fetch('/api/cloud/snapshot', {
    credentials: 'include',
    cache: 'no-store',
  })
  if (res.status === 401) throw await handleAuthLoss(fence)
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
      // Re-read the identity on every attempt: a retry after a version
      // conflict is a fresh operation and must be judged on current state.
      const versionFence = await readSyncFence()
      const baseUpdatedAt = await currentSnapshotUpdatedAt(versionFence)
      const { payload, capturedRevision, fence } =
        await buildExportPayloadAtRevision()
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
      if (res.status === 401) throw await handleAuthLoss(fence)
      if (!res.ok) {
        const errorCode = res.status === 409 ? await responseErrorCode(res) : null
        // The backend refuses a generic snapshot while a Coach action owns a
        // reservation. That is the fence working, not a failure: surface it as
        // a distinct signal so callers can wait instead of showing an error.
        if (errorCode === 'coach_action_reservation_required') {
          throw new CoachReservationActiveError()
        }
        const retryableVersionConflict =
          errorCode === 'snapshot_version_changed'
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
      // Durable watermark: only the revision actually contained in the payload
      // the mirror accepted is marked synced, and only if the dataset and the
      // session it was captured under are still the current ones. Anything
      // written while this request was in flight has a higher revision and
      // stays pending; anything from a superseded dataset or session is
      // discarded outright.
      const recorded = await recordSyncSuccess({
        capturedRevision,
        cloudUpdatedAt: updatedAt,
        fence,
      })
      if (recorded.applied) clearPendingCloudSnapshot(pending)
      return { updatedAt }
    }
    throw new Error('Cloud snapshot failed after version retries')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    saveStatus({ lastSnapshotError: message })
    // Diagnostics must never replace the real failure: if IndexedDB itself is
    // what broke, recording that fact will fail too, and the caller needs the
    // original error.
    try {
      await recordSyncFailure(message)
    } catch {
      // The revision watermark is unchanged, so the work stays pending.
    }
    throw err
  }
}

export class CoachReservationActiveError extends Error {
  constructor() {
    super('A Coach change is still publishing. Sync will resume after it.')
    this.name = 'CoachReservationActiveError'
  }
}

export type LocalSyncOutcome =
  | 'uploaded'
  | 'up_to_date'
  | 'not_paired'
  | 'deferred_coach_reservation'
  | 'backing_off'

export interface LocalSyncOptions {
  // The automatic scheduler sets this so a persistently failing upload settles
  // into capped exponential backoff instead of retrying at a fixed rate.
  // Manual and reconnect triggers leave it false: an explicit user action or a
  // regained network is new information and should be tried immediately.
  respectBackoff?: boolean
  // Upload even when the revision says nothing is pending. Only the Settings
  // "sync now" button uses this; it never bypasses the reservation gate or the
  // single-flight guard.
  force?: boolean
}

let inFlightLocalSync: Promise<LocalSyncOutcome> | null = null

// The single coordinated entry point for pushing local edits to the mirror.
//
// Every generic caller goes through here — workout completion, foreground
// recovery, reconnect, the debounced scheduler, and the Settings button — so
// the rules live in one place rather than at each call site: one upload at a
// time, never during a Coach reservation, backoff when asked to respect it,
// and no upload at all when nothing local has changed.
//
// The Coach's own publish path deliberately does NOT come through here: it has
// a reservation, receipt proofs, and a different retry protocol, and calls
// uploadCloudSnapshot('chat_action_applied') directly.
export async function syncPendingLocalChanges(
  trigger: DurableCloudSnapshotTrigger = 'manual',
  options: LocalSyncOptions = {},
): Promise<LocalSyncOutcome> {
  if (inFlightLocalSync) return inFlightLocalSync
  const run = (async (): Promise<LocalSyncOutcome> => {
    if (!isCloudConfigured()) return 'not_paired'

    // A confirmed Coach action publishes through its own reservation-aware
    // protocol with receipt proofs. A generic snapshot PUT during that window
    // is rejected by the backend as `coach_action_reservation_required`, and
    // even if it were not, it would publish outside the reservation. Wait.
    const pendingCoachResults = await listPendingCoachActionResults()
    if (pendingCoachResults.length > 0) return 'deferred_coach_reservation'

    if (options.respectBackoff) {
      if (await isAutoSyncBackedOff()) return 'backing_off'
    } else {
      await clearAutoSyncBackoff()
    }

    const state = await getLocalSyncState()
    const legacyPending = hasPendingCloudSnapshotSync()
    if (
      !options.force &&
      state.localRevision <= state.syncedRevision &&
      !legacyPending
    ) {
      return 'up_to_date'
    }
    try {
      await uploadCloudSnapshot(trigger)
    } catch (err) {
      // A reservation can exist server-side without a local pending receipt —
      // for example when the app closed between reserving and writing one. The
      // backend fence still holds; treat it as a wait, not a failure.
      if (err instanceof CoachReservationActiveError) {
        return 'deferred_coach_reservation'
      }
      throw err
    }
    return 'uploaded'
  })()
  inFlightLocalSync = run
  try {
    return await run
  } finally {
    inFlightLocalSync = null
  }
}

export async function recoverCloudSnapshot(): Promise<boolean> {
  if (!isCloudConfigured()) return false

  // A queued marker from a previous run still goes through the gate: it is a
  // generic upload and must respect the single-flight guard and the Coach
  // reservation fence exactly like any other.
  const pending = readPendingCloudSnapshot()
  if (pending) {
    return (await syncPendingLocalChanges(pending.trigger)) === 'uploaded'
  }

  // The durable revision covers every relevant local mutation, not just a
  // completed workout: a corrected historical set, a deleted session, a program
  // edit, a note, or a restored backup all leave localRevision ahead.
  const outcome = await syncPendingLocalChanges('manual')
  if (outcome === 'uploaded') return true
  if (outcome !== 'up_to_date') return false

  // Fallback for a device upgraded from a build that had no revision counter:
  // its first post-upgrade revision is 0, so nothing above would fire. Only
  // move the mirror forward when this device has a newer completed workout; do
  // not overwrite a newer cloud source with an empty or older local database.
  const legacyFence = await readSyncFence()
  const [cloud, localPayload] = await Promise.all([
    currentCloudWorkoutSummary(legacyFence),
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

  // Still through the gate, so the legacy repair cannot bypass single-flight
  // or publish inside a Coach reservation window.
  return (
    (await syncPendingLocalChanges('workout_completed', { force: true })) ===
    'uploaded'
  )
}

export async function fetchLatestCloudBriefing(): Promise<DailyBriefing | null> {
  if (!isCloudConfigured()) return null
  try {
    const fence = await readSyncFence()
    const res = await fetch('/api/cloud/briefing/latest', {
      credentials: 'include',
    })
    if (res.status === 401) {
      // Only tear down the session that issued this request; a reply that
      // crossed a re-pair must not unpair the new one.
      await handleAuthLoss(fence)
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
    const fence = await readSyncFence()
    const res = await fetch('/api/cloud/memory', {
      credentials: 'include',
    })
    if (res.status === 401) {
      await handleAuthLoss(fence)
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

export async function fetchCloudUpdates(): Promise<void> {
  const results = await Promise.allSettled([
    fetchLatestCloudBriefing(),
    fetchCloudMemory(),
  ])
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (failed) throw failed.reason
}

let installedBriefingRefresh = false

// How long to wait after a local edit before pushing it. Long enough that a
// burst of set logging is one upload, short enough that a history correction
// reaches the daily coach without waiting for the next app launch.
export const LOCAL_SYNC_DEBOUNCE_MS = 8_000

// After a successful upload, work that arrived while that upload was in flight
// is still pending by design. It gets a short drain pass rather than waiting
// for the next user action — the case that used to strand an edit for good.
export const LOCAL_SYNC_DRAIN_MS = 500

// A Coach reservation is transient and is not a failure, so it is re-checked on
// a modest fixed interval rather than a tight loop or the failure backoff.
export const COACH_RESERVATION_RETRY_MS = 15_000

let installedScheduler: (() => void) | null = null

// The automatic sync scheduler.
//
// Three jobs, all of which were missing before:
//   1. debounce a burst of local edits into one upload;
//   2. actually wake at the backoff deadline, so a transient server failure
//      recovers on its own instead of waiting for the user to do something;
//   3. drain after a success, because an edit that landed while an upload was
//      in flight is deliberately left pending by the revision watermark and
//      would otherwise never get an automatic attempt.
//
// Every pass makes progress — it either uploads (advancing the watermark) or
// records a failure (advancing the backoff) — so rescheduling cannot spin.
export function startLocalSyncScheduler(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let running = false

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const scheduleIn = (delayMs: number) => {
    if (stopped) return
    cancel()
    timer = setTimeout(() => {
      timer = null
      void attempt()
    }, Math.max(0, delayMs))
  }

  const offline = () =>
    typeof navigator !== 'undefined' && navigator.onLine === false

  // Decide when — if ever — to wake next, from durable state rather than from
  // whatever the last call happened to return.
  const planNext = async (outcome: LocalSyncOutcome | 'failed') => {
    if (stopped) return
    if (outcome === 'not_paired') {
      cancel()
      return
    }
    if (outcome === 'deferred_coach_reservation') {
      scheduleIn(COACH_RESERVATION_RETRY_MS)
      return
    }
    const state = await getLocalSyncState()
    if (stopped) return
    if (state.localRevision <= state.syncedRevision) {
      cancel()
      return
    }
    // Offline: the 'online' listener takes over, so stop burning timers.
    if (offline()) {
      cancel()
      return
    }
    if (state.nextAutoAttemptAt !== null) {
      scheduleIn(state.nextAutoAttemptAt - Date.now())
      return
    }
    scheduleIn(LOCAL_SYNC_DRAIN_MS)
  }

  const attempt = async () => {
    if (stopped || running || offline()) return
    running = true
    let outcome: LocalSyncOutcome | 'failed' = 'failed'
    try {
      outcome = await syncPendingLocalChanges('manual', {
        respectBackoff: true,
      })
    } catch {
      // The failure is already recorded durably, together with its backoff.
    } finally {
      running = false
    }
    await planNext(outcome)
  }

  const stopMutations = subscribeLocalMutations(() => {
    scheduleIn(LOCAL_SYNC_DEBOUNCE_MS)
  })

  const onOnline = () => {
    // Regaining the network is new information, so it clears the backoff and
    // tries immediately rather than waiting out a deadline set while offline.
    void syncPendingLocalChanges('manual').then(
      (outcome) => planNext(outcome),
      () => planNext('failed'),
    )
  }
  const onOffline = () => cancel()

  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
  }

  // Pick up anything already pending from a previous run.
  void planNext('up_to_date')

  return () => {
    stopped = true
    cancel()
    stopMutations()
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }
}

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
      await fetchCloudUpdates()
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

  installedScheduler ??= startLocalSyncScheduler()
}
