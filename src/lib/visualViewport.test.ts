import { describe, expect, it, vi } from 'vitest'
import {
  APP_SAFE_AREA_BOTTOM_VAR,
  APP_VIEWPORT_HEIGHT_VAR,
  APP_VIEWPORT_TOP_VAR,
  installAppViewportSizing,
  measureAppViewport,
} from './visualViewport'

function viewportWindow(overrides: {
  innerHeight: number
  scrollY?: number
  viewport?: Partial<VisualViewport> | null
}): Window {
  const viewport =
    overrides.viewport === null
      ? null
      : ({
          height: overrides.innerHeight,
          offsetTop: 0,
          pageTop: 0,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          ...overrides.viewport,
        } as unknown as VisualViewport)

  return {
    innerHeight: overrides.innerHeight,
    scrollY: overrides.scrollY ?? 0,
    visualViewport: viewport,
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    }),
    cancelAnimationFrame: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as Window
}

describe('measureAppViewport', () => {
  it('falls back to the layout viewport when VisualViewport is unavailable', () => {
    expect(
      measureAppViewport(viewportWindow({ innerHeight: 844, viewport: null })),
    ).toEqual({ height: 844, top: 0, keyboardOpen: false })
  })

  it('uses the keyboard-sized visual viewport and compensates for its pan', () => {
    expect(
      measureAppViewport(
        viewportWindow({
          innerHeight: 844,
          viewport: { height: 510, offsetTop: 250, pageTop: 334 },
        }),
        true,
      ),
    ).toEqual({ height: 510, top: 334, keyboardOpen: true })
  })

  it('removes ordinary document scroll from pageTop', () => {
    expect(
      measureAppViewport(
        viewportWindow({
          innerHeight: 844,
          scrollY: 120,
          viewport: { height: 844, offsetTop: 0, pageTop: 120 },
        }),
      ),
    ).toEqual({ height: 844, top: 0, keyboardOpen: false })
  })
})

describe('installAppViewportSizing', () => {
  it('writes the shell variables and restores CSS fallbacks on cleanup', () => {
    const values = new Map<string, string>()
    const style = {
      setProperty: vi.fn((name: string, value: string) => values.set(name, value)),
      removeProperty: vi.fn((name: string) => values.delete(name)),
    } as unknown as CSSStyleDeclaration
    const cleanup = installAppViewportSizing(
      viewportWindow({
        innerHeight: 844,
        viewport: { height: 510, offsetTop: 334, pageTop: 334 },
      }),
      style,
      () => ({ tagName: 'TEXTAREA' }) as Element,
    )

    expect(values.get(APP_VIEWPORT_HEIGHT_VAR)).toBe('510px')
    expect(values.get(APP_VIEWPORT_TOP_VAR)).toBe('334px')
    expect(values.get(APP_SAFE_AREA_BOTTOM_VAR)).toBe('0px')

    cleanup()
    expect(values.size).toBe(0)
  })

  it('updates on visual viewport events and cancels queued work on cleanup', () => {
    let viewportHeight = 844
    let viewportTop = 0
    let queuedFrame: FrameRequestCallback | null = null
    const viewportListeners = new Map<string, EventListenerOrEventListenerObject>()
    const windowListeners = new Map<string, EventListenerOrEventListenerObject>()
    const viewport = {
      get height() {
        return viewportHeight
      },
      get offsetTop() {
        return viewportTop
      },
      get pageTop() {
        return viewportTop
      },
      addEventListener: vi.fn(
        (type: string, listener: EventListenerOrEventListenerObject) =>
          viewportListeners.set(type, listener),
      ),
      removeEventListener: vi.fn((type: string) => viewportListeners.delete(type)),
    } as unknown as VisualViewport
    const cancelAnimationFrame = vi.fn()
    const windowTarget = {
      innerHeight: 844,
      scrollY: 0,
      visualViewport: viewport,
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        queuedFrame = callback
        return 7
      }),
      cancelAnimationFrame,
      addEventListener: vi.fn(
        (type: string, listener: EventListenerOrEventListenerObject) =>
          windowListeners.set(type, listener),
      ),
      removeEventListener: vi.fn((type: string) => windowListeners.delete(type)),
    } as unknown as Window
    const values = new Map<string, string>()
    const style = {
      setProperty: (name: string, value: string) => values.set(name, value),
      removeProperty: (name: string) => values.delete(name),
    } as unknown as CSSStyleDeclaration
    const cleanup = installAppViewportSizing(
      windowTarget,
      style,
      () => ({ tagName: 'TEXTAREA' }) as Element,
    )

    viewportHeight = 510
    viewportTop = 334
    const resizeListener = viewportListeners.get('resize') as EventListener
    resizeListener(new Event('resize'))
    expect(values.get(APP_VIEWPORT_HEIGHT_VAR)).toBe('844px')

    const runFrame = queuedFrame as FrameRequestCallback | null
    runFrame?.(0)
    expect(values.get(APP_VIEWPORT_HEIGHT_VAR)).toBe('510px')
    expect(values.get(APP_VIEWPORT_TOP_VAR)).toBe('334px')
    expect(values.get(APP_SAFE_AREA_BOTTOM_VAR)).toBe('0px')

    const scrollListener = viewportListeners.get('scroll') as EventListener
    scrollListener(new Event('scroll'))
    cleanup()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7)
    expect(viewportListeners.size).toBe(0)
    expect(windowListeners.size).toBe(0)
  })
})
