import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { playBeep, vibrate } from '../lib/audio'
import {
  MAX_REST_SECONDS,
  isValidRestSeconds,
} from '../lib/restTimer'
import { releaseWakeLock, requestWakeLock } from '../lib/wakeLock'

export interface PersistedTimerState {
  expiresAt: number | null
  originalSeconds: number
  exerciseId: string | null
}

interface TimerState extends PersistedTimerState {
  start: (seconds: number, exerciseId: string) => void
  stop: () => void
  fireExpiry: () => void
}

const IDLE_TIMER: PersistedTimerState = {
  expiresAt: null,
  originalSeconds: 0,
  exerciseId: null,
}

export function normalizePersistedTimerState(
  value: unknown,
  now: number = Date.now(),
): PersistedTimerState {
  if (!value || typeof value !== 'object') return IDLE_TIMER
  const candidate = value as Partial<PersistedTimerState>
  if (
    typeof candidate.expiresAt !== 'number' ||
    !Number.isFinite(candidate.expiresAt) ||
    candidate.expiresAt <= now ||
    candidate.expiresAt > now + MAX_REST_SECONDS * 1000
  ) {
    return IDLE_TIMER
  }
  if (
    typeof candidate.originalSeconds !== 'number' ||
    !isValidRestSeconds(candidate.originalSeconds) ||
    candidate.expiresAt > now + candidate.originalSeconds * 1000 ||
    typeof candidate.exerciseId !== 'string' ||
    candidate.exerciseId.length === 0
  ) {
    return IDLE_TIMER
  }
  return {
    expiresAt: candidate.expiresAt,
    originalSeconds: candidate.originalSeconds,
    exerciseId: candidate.exerciseId,
  }
}

export const useTimer = create<TimerState>()(
  persist(
    (set, get) => ({
      ...IDLE_TIMER,
      start: (seconds, exerciseId) => {
        if (!isValidRestSeconds(seconds) || exerciseId.length === 0) return
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
        set(IDLE_TIMER)
      },
      fireExpiry: () => {
        const { expiresAt } = get()
        if (expiresAt === null) return
        playBeep()
        vibrate([200, 100, 200])
        releaseWakeLock()
        set(IDLE_TIMER)
      },
    }),
    {
      name: 'workout-rest-timer',
      version: 1,
      storage:
        typeof window === 'undefined'
          ? undefined
          : createJSONStorage(() => window.localStorage),
      partialize: ({ expiresAt, originalSeconds, exerciseId }) => ({
        expiresAt,
        originalSeconds,
        exerciseId,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...normalizePersistedTimerState(persisted),
      }),
      onRehydrateStorage: () => (state) => {
        if (state && state.expiresAt !== null) void requestWakeLock()
      },
    },
  ),
)
