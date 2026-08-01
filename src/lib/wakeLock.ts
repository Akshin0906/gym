// Screen Wake Lock for the rest timer. Without it, iOS auto-locks the screen
// during a 90-180s rest, which throttles/halts the foreground setInterval and
// suspends the AudioContext — so the expiry beep fires late or not at all.
// Holding a 'screen' wake lock while a timer runs keeps the display awake so the
// countdown, audio, and haptic all fire on time. Degrades silently where the
// API is unavailable (older iOS, unsupported browsers).

let sentinel: WakeLockSentinel | null = null
let wanted = false

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

export async function requestWakeLock(): Promise<void> {
  wanted = true
  if (!supported() || sentinel) return
  try {
    sentinel = await navigator.wakeLock.request('screen')
    // The OS auto-releases the lock when the page is hidden; drop our handle so
    // the visibility listener below re-acquires when we return to the foreground.
    sentinel.addEventListener('release', () => {
      sentinel = null
    })
  } catch {
    // Not visible, low battery, or unsupported — fall back to no lock.
    sentinel = null
  }
}

export function releaseWakeLock(): void {
  wanted = false
  const current = sentinel
  sentinel = null
  if (current) void current.release().catch(() => {})
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (wanted && !sentinel && document.visibilityState === 'visible') {
      void requestWakeLock()
    }
  })
}
