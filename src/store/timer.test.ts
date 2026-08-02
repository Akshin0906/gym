import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizePersistedTimerState } from './timer'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('rest timer persistence validation', () => {
  const now = 1_000_000

  it('restores a valid configured 210-second timer', () => {
    expect(
      normalizePersistedTimerState(
        {
          expiresAt: now + 200_000,
          originalSeconds: 210,
          exerciseId: 'squat',
        },
        now,
      ),
    ).toEqual({
      expiresAt: now + 200_000,
      originalSeconds: 210,
      exerciseId: 'squat',
    })
  })

  it('discards expired and malformed persisted timers', () => {
    expect(
      normalizePersistedTimerState(
        { expiresAt: now, originalSeconds: 210, exerciseId: 'squat' },
        now,
      ),
    ).toEqual({ expiresAt: null, originalSeconds: 0, exerciseId: null })
    expect(
      normalizePersistedTimerState(
        { expiresAt: 'later', originalSeconds: -1, exerciseId: '' },
        now,
      ),
    ).toEqual({ expiresAt: null, originalSeconds: 0, exerciseId: null })
  })

  it('persists through an actual Zustand store reload and enforces boundaries', async () => {
    const storage = new MemoryStorage()
    vi.stubGlobal('window', { localStorage: storage })
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.resetModules()
    const firstModule = await import('./timer')

    firstModule.useTimer.getState().start(3_601, 'squat')
    expect(firstModule.useTimer.getState().expiresAt).toBeNull()
    firstModule.useTimer.getState().start(90.5, 'squat')
    expect(firstModule.useTimer.getState().expiresAt).toBeNull()
    firstModule.useTimer.getState().start(210, 'squat')
    expect(firstModule.useTimer.getState()).toMatchObject({
      expiresAt: now + 210_000,
      originalSeconds: 210,
      exerciseId: 'squat',
    })
    expect(storage.getItem('workout-rest-timer')).not.toBeNull()

    vi.resetModules()
    const reloadedModule = await import('./timer')
    expect(reloadedModule.useTimer.getState()).toMatchObject({
      expiresAt: now + 210_000,
      originalSeconds: 210,
      exerciseId: 'squat',
    })
    reloadedModule.useTimer.getState().stop()
  })
})
