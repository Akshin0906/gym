import { create } from 'zustand'
import { playBeep, vibrate } from '../lib/audio'
import { releaseWakeLock, requestWakeLock } from '../lib/wakeLock'

interface TimerState {
  expiresAt: number | null
  originalSeconds: number
  exerciseId: string | null
  start: (seconds: number, exerciseId: string) => void
  stop: () => void
  fireExpiry: () => void
}

export const useTimer = create<TimerState>((set, get) => ({
  expiresAt: null,
  originalSeconds: 0,
  exerciseId: null,
  start: (seconds, exerciseId) => {
    if (seconds <= 0) return
    set({
      expiresAt: Date.now() + seconds * 1000,
      originalSeconds: seconds,
      exerciseId,
    })
    // Keep the screen awake for the rest so the expiry beep/flash/haptic
    // actually fire instead of being throttled by an auto-locked screen.
    void requestWakeLock()
  },
  stop: () => {
    releaseWakeLock()
    set({ expiresAt: null, originalSeconds: 0, exerciseId: null })
  },
  fireExpiry: () => {
    const { expiresAt } = get()
    if (expiresAt === null) return
    playBeep()
    vibrate([200, 100, 200])
    releaseWakeLock()
    set({ expiresAt: null, originalSeconds: 0, exerciseId: null })
  },
}))
