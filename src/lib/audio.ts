// Audio unlock pattern for iOS. AudioContext must be created/resumed inside a
// user gesture handler. We lazily instantiate the context, then resume it on
// every user gesture: iOS suspends the context whenever the PWA is backgrounded,
// so a one-shot "primed" latch would leave the first post-resume beep silent.
// Wiring primeAudio() to a persistent gesture listener re-primes it for free.

let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (ctx) return ctx
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  } catch {
    return null
  }
  return ctx
}

export function primeAudio(): void {
  const c = getCtx()
  if (c && c.state === 'suspended') void c.resume()
}

export function playBeep(): void {
  const ctx = getCtx()
  if (!ctx) return
  try {
    if (ctx.state === 'suspended') void ctx.resume()
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    gain.gain.value = 0
    gain.gain.linearRampToValueAtTime(0.25, now + 0.02)
    gain.gain.linearRampToValueAtTime(0, now + 0.45)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.5)
  } catch {
    // ignored
  }
}

export function vibrate(pattern: number | number[]): void {
  if ('vibrate' in navigator) {
    try {
      navigator.vibrate(pattern)
    } catch {
      // ignored
    }
  }
}
