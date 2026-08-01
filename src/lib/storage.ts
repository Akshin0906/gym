// Persistent storage via the StorageManager API.
//
// By default IndexedDB lives in a "best-effort" bucket the browser may evict
// under storage pressure or, on iOS, the 7-day script-writable-storage cap.
// Requesting persistence asks the engine to exempt our data from that eviction
// (MDN: persisted storage "will not be cleared except by explicit user action").
//
// WebKit (iOS 17+/Safari 17+) grants the request *heuristically* — running as a
// Home Screen Web App is the main positive signal — so persist() is a request,
// not a guarantee, and can resolve false. The manual JSON export remains the
// real recovery path; this is defense in depth, not a replacement for it.

export type PersistStatus = 'persisted' | 'transient' | 'unsupported'

function hasStorageManager(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.storage &&
    typeof navigator.storage.persisted === 'function' &&
    typeof navigator.storage.persist === 'function'
  )
}

// Read-only check. Never prompts; safe to call anywhere, including for display.
export async function getPersistStatus(): Promise<PersistStatus> {
  if (!hasStorageManager()) return 'unsupported'
  try {
    return (await navigator.storage.persisted()) ? 'persisted' : 'transient'
  } catch {
    return 'unsupported'
  }
}

// Explicit, user-initiated request (the Settings button). On Firefox this may
// surface a permission prompt, which is acceptable from a deliberate tap.
export async function requestPersist(): Promise<PersistStatus> {
  if (!hasStorageManager()) return 'unsupported'
  try {
    if (await navigator.storage.persisted()) return 'persisted'
    return (await navigator.storage.persist()) ? 'persisted' : 'transient'
  } catch {
    return 'unsupported'
  }
}

// Would an unsolicited persist() call pop a permission prompt? Firefox reports
// "prompt" here and shows UI on persist(), so we skip auto-requesting there.
// Safari has no Permissions API entry for this and rejects the unknown name —
// that rejection means "won't prompt", so we proceed. Chromium grants silently.
async function persistWouldPrompt(): Promise<boolean> {
  try {
    const perms = navigator.permissions
    if (!perms?.query) return false
    const status = await perms.query({
      name: 'persistent-storage' as PermissionName,
    })
    return status.state === 'prompt'
  } catch {
    return false
  }
}

// Fire-and-forget on startup. Silent on the platforms that matter here (iOS
// Home Screen Web App, Chromium); deferred to the explicit Settings control on
// engines where an unsolicited call would prompt.
export async function autoRequestPersist(): Promise<PersistStatus> {
  if (!hasStorageManager()) return 'unsupported'
  try {
    if (await navigator.storage.persisted()) return 'persisted'
    if (await persistWouldPrompt()) return 'transient'
    return (await navigator.storage.persist()) ? 'persisted' : 'transient'
  } catch {
    return 'unsupported'
  }
}

export interface StorageUsage {
  usageBytes: number | null
  quotaBytes: number | null
}

export async function getStorageUsage(): Promise<StorageUsage> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.estimate !== 'function'
  ) {
    return { usageBytes: null, quotaBytes: null }
  }
  try {
    const est = await navigator.storage.estimate()
    return {
      usageBytes: typeof est.usage === 'number' ? est.usage : null,
      quotaBytes: typeof est.quota === 'number' ? est.quota : null,
    }
  } catch {
    return { usageBytes: null, quotaBytes: null }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}
