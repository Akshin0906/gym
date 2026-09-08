import Dexie, { type Table, type Transaction } from 'dexie'
import { db } from '../schema'
import type { LocalSyncState, SyncFence } from '../types'

export const LOCAL_SYNC_STATE_ID = 'local'

const EMPTY_STATE: LocalSyncState = {
  id: LOCAL_SYNC_STATE_ID,
  localRevision: 0,
  syncedRevision: 0,
  lastMutationAt: null,
  lastSyncedAt: null,
  lastSyncedCloudUpdatedAt: null,
  lastSyncError: null,
  failedAttempts: 0,
  datasetEpoch: 0,
  authEpoch: 0,
  nextAutoAttemptAt: null,
}

// Legacy rows written before the fence fields existed read back without them.
function withDefaults(row: LocalSyncState | undefined): LocalSyncState {
  if (!row) return EMPTY_STATE
  return {
    ...EMPTY_STATE,
    ...row,
    datasetEpoch: row.datasetEpoch ?? 0,
    authEpoch: row.authEpoch ?? 0,
    nextAutoAttemptAt: row.nextAutoAttemptAt ?? null,
  }
}

const CHANGED_EVENT = 'workout-tracker:localSyncStateChanged'

// Why the sync row changed. The automatic scheduler must react only to new
// local work: waking it on every failure record turned a failing upload into a
// fixed-rate retry loop, because each failure emitted the event that scheduled
// the next attempt.
export type SyncStateChangeReason = 'mutation' | 'sync'

function notifyChanged(reason: SyncStateChangeReason): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { reason } }))
  } catch {
    // Notification is advisory; callers still poll on foreground.
  }
}

function subscribe(
  callback: (reason: SyncStateChangeReason) => void,
): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ reason?: SyncStateChangeReason }>)
      .detail
    callback(detail?.reason === 'mutation' ? 'mutation' : 'sync')
  }
  window.addEventListener(CHANGED_EVENT, handler)
  return () => window.removeEventListener(CHANGED_EVENT, handler)
}

// Any change at all — what the UI wants, so a status panel repaints after a
// failure as readily as after an edit.
export function subscribeLocalSyncState(callback: () => void): () => void {
  return subscribe(() => callback())
}

// New local work only. This is the scheduler's signal.
export function subscribeLocalMutations(callback: () => void): () => void {
  return subscribe((reason) => {
    if (reason === 'mutation') callback()
  })
}

export async function getLocalSyncState(): Promise<LocalSyncState> {
  return withDefaults(await db.syncState.get(LOCAL_SYNC_STATE_ID))
}

export async function hasPendingLocalChanges(): Promise<boolean> {
  const state = await getLocalSyncState()
  return state.localRevision > state.syncedRevision
}

export async function readSyncFence(): Promise<SyncFence> {
  const state = await getLocalSyncState()
  return { datasetEpoch: state.datasetEpoch, authEpoch: state.authEpoch }
}

export function fenceMatches(state: LocalSyncState, fence: SyncFence): boolean {
  return (
    state.datasetEpoch === fence.datasetEpoch &&
    state.authEpoch === fence.authEpoch
  )
}

// Advance the local revision. MUST be called from inside a read-write
// transaction that already covers `db.syncState` together with the tables the
// caller is mutating — that is what makes "the data changed" and "the mirror is
// behind" a single atomic fact rather than two writes that a crash can split.
export async function bumpLocalRevisionInTransaction(
  now = Date.now(),
): Promise<number> {
  const current = withDefaults(await db.syncState.get(LOCAL_SYNC_STATE_ID))
  const next: LocalSyncState = {
    ...current,
    id: LOCAL_SYNC_STATE_ID,
    localRevision: current.localRevision + 1,
    lastMutationAt: now,
    // New work is immediately eligible: backoff exists to stop a failing
    // upload from spinning, not to delay a fresh edit.
    nextAutoAttemptAt: null,
  }
  await db.syncState.put(next)
  return next.localRevision
}

// Tracks which outermost Dexie transaction has already advanced the revision.
//
// Dexie gives a nested transaction its own child Transaction object, so the
// marker has to live on the ROOT of the chain — otherwise a repository function
// built out of other repository functions bumps once per layer. Keyed on the
// transaction object rather than a module-level flag so two genuinely
// concurrent transactions still get one bump each.
const bumpedTransactions = new WeakSet<Transaction>()

function rootTransaction(tx: Transaction | null): Transaction | null {
  let current = tx
  while (current) {
    const parent = (current as Transaction & { parent?: Transaction | null })
      .parent
    if (!parent) return current
    current = parent
  }
  return null
}

export async function mutateLocalData<T>(
  tables: readonly Table[],
  body: () => Promise<T>,
): Promise<T> {
  const scope: Table[] = [...tables, db.syncState]
  const outermost = Dexie.currentTransaction === null
  const result = await db.transaction('rw', scope, async () => {
    const value = await body()
    const root = rootTransaction(Dexie.currentTransaction)
    if (root) {
      if (bumpedTransactions.has(root)) return value
      bumpedTransactions.add(root)
    }
    await bumpLocalRevisionInTransaction()
    return value
  })
  // Only announce once the outermost transaction has actually committed; an
  // enclosing transaction can still abort everything after the inner body runs.
  if (outermost) notifyChanged('mutation')
  return result
}

export interface SyncSuccessResult {
  applied: boolean
  state: LocalSyncState
}

// Record that the mirror accepted a payload captured at `capturedRevision`.
//
// The fence is the important half. Using the captured revision alone was not
// enough: a backup restore renumbers the dataset and a logout invalidates the
// mirror, so a reply that was already in flight across either event would
// otherwise mark data as mirrored that the current mirror has never seen.
export async function recordSyncSuccess(args: {
  capturedRevision: number
  cloudUpdatedAt: number
  fence: SyncFence
  now?: number
}): Promise<SyncSuccessResult> {
  const now = args.now ?? Date.now()
  const result = await db.transaction('rw', db.syncState, async () => {
    const current = withDefaults(await db.syncState.get(LOCAL_SYNC_STATE_ID))
    if (!fenceMatches(current, args.fence)) {
      // Stale reply from a superseded dataset or session. Discard it entirely:
      // the current data stays pending and will be uploaded on its own.
      return { applied: false, state: current }
    }
    const updated: LocalSyncState = {
      ...current,
      id: LOCAL_SYNC_STATE_ID,
      // Never move the watermark backwards: an out-of-order retry response for
      // an older payload must not un-sync newer confirmed work.
      syncedRevision: Math.max(current.syncedRevision, args.capturedRevision),
      lastSyncedAt: now,
      lastSyncedCloudUpdatedAt: args.cloudUpdatedAt,
      lastSyncError: null,
      failedAttempts: 0,
      nextAutoAttemptAt: null,
    }
    await db.syncState.put(updated)
    return { applied: true, state: updated }
  })
  notifyChanged('sync')
  return result
}

// Capped exponential backoff for the automatic scheduler. The first failure is
// retried quickly; a persistent outage settles at one attempt per BACKOFF_MAX
// instead of one every scheduler tick forever.
export const BACKOFF_BASE_MS = 15_000
export const BACKOFF_MAX_MS = 10 * 60 * 1000

export function backoffDelayMs(failedAttempts: number): number {
  const exponent = Math.max(0, Math.min(failedAttempts - 1, 12))
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS)
}

export async function recordSyncFailure(
  message: string,
  now = Date.now(),
): Promise<void> {
  await db.transaction('rw', db.syncState, async () => {
    const current = withDefaults(await db.syncState.get(LOCAL_SYNC_STATE_ID))
    const failedAttempts = current.failedAttempts + 1
    await db.syncState.put({
      ...current,
      id: LOCAL_SYNC_STATE_ID,
      lastSyncError: message.slice(0, 300),
      failedAttempts,
      nextAutoAttemptAt: now + backoffDelayMs(failedAttempts),
    })
  })
  // Deliberately a 'sync' change, not a 'mutation': the scheduler must not
  // treat a failure as a reason to try again immediately.
  notifyChanged('sync')
}

export async function isAutoSyncBackedOff(now = Date.now()): Promise<boolean> {
  const state = await getLocalSyncState()
  return state.nextAutoAttemptAt !== null && now < state.nextAutoAttemptAt
}

// A manual or reconnect trigger is an explicit signal that conditions changed,
// so it clears the backoff before attempting.
export async function clearAutoSyncBackoff(): Promise<void> {
  await db.transaction('rw', db.syncState, async () => {
    const current = withDefaults(await db.syncState.get(LOCAL_SYNC_STATE_ID))
    if (current.nextAutoAttemptAt === null && current.failedAttempts === 0) {
      return
    }
    await db.syncState.put({
      ...current,
      id: LOCAL_SYNC_STATE_ID,
      failedAttempts: 0,
      nextAutoAttemptAt: null,
    })
  })
}

// Pairing changes fence every in-flight cloud operation. The device keeps its
// local data and its local revision; it only forgets what it believed about a
// mirror it can no longer speak for. A reply from before the change carries the
// old authEpoch and is discarded by recordSyncSuccess.
export async function advanceAuthEpoch(): Promise<number> {
  const next = await db.transaction('rw', db.syncState, async () => {
    const current = withDefaults(await db.syncState.get(LOCAL_SYNC_STATE_ID))
    const updated: LocalSyncState = {
      ...current,
      id: LOCAL_SYNC_STATE_ID,
      authEpoch: current.authEpoch + 1,
      syncedRevision: 0,
      lastSyncedAt: null,
      lastSyncedCloudUpdatedAt: null,
      lastSyncError: null,
      failedAttempts: 0,
      nextAutoAttemptAt: null,
    }
    await db.syncState.put(updated)
    return updated.authEpoch
  })
  notifyChanged('sync')
  return next
}

// Fence only if the caller's session is still the current one. A 401 from a
// request issued before a re-pair must not invalidate the new session.
export async function advanceAuthEpochIfCurrent(
  fence: SyncFence,
): Promise<boolean> {
  const current = await getLocalSyncState()
  if (current.authEpoch !== fence.authEpoch) return false
  await advanceAuthEpoch()
  return true
}

// Called from inside the import transaction, after the tables have been cleared
// and repopulated, so the restored dataset and its "not yet mirrored" marker
// commit together. A crash between the two is impossible.
//
// `localRevision` continues from the pre-import value rather than restarting at
// 1: monotonic revisions mean an in-flight upload of an older revision can never
// out-number the restored dataset, and the dataset epoch fences it besides.
export async function markDatasetReplacedInTransaction(
  previous: LocalSyncState,
  now = Date.now(),
): Promise<void> {
  await db.syncState.put({
    ...EMPTY_STATE,
    id: LOCAL_SYNC_STATE_ID,
    localRevision: previous.localRevision + 1,
    syncedRevision: 0,
    lastMutationAt: now,
    datasetEpoch: previous.datasetEpoch + 1,
    // The session is unchanged by a restore, so the auth fence carries over.
    authEpoch: previous.authEpoch,
  })
}

export async function readLocalSyncStateInTransaction(): Promise<LocalSyncState> {
  return withDefaults(await db.syncState.get(LOCAL_SYNC_STATE_ID))
}

export function announceDatasetReplaced(): void {
  notifyChanged('mutation')
}
