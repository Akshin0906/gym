export const APP_VIEWPORT_HEIGHT_VAR = '--app-viewport-height'
export const APP_VIEWPORT_TOP_VAR = '--app-viewport-top'
export const APP_SAFE_AREA_BOTTOM_VAR = '--app-safe-area-bottom'

type ViewportWindow = Pick<
  Window,
  | 'innerHeight'
  | 'scrollY'
  | 'visualViewport'
  | 'requestAnimationFrame'
  | 'cancelAnimationFrame'
  | 'addEventListener'
  | 'removeEventListener'
>

type ViewportStyle = Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>

export interface AppViewportFrame {
  height: number
  top: number
  keyboardOpen: boolean
}

export function measureAppViewport(
  windowTarget: ViewportWindow,
  editableFocused = false,
): AppViewportFrame {
  const viewport = windowTarget.visualViewport
  if (!viewport) {
    return {
      height: windowTarget.innerHeight,
      top: 0,
      keyboardOpen: false,
    }
  }

  // pageTop - scrollY is normally identical to offsetTop. Recent iOS WebKit
  // versions can under-report offsetTop while the keyboard pans the visual
  // viewport, so keep the larger of the two measurements.
  const pageOffsetTop = viewport.pageTop - windowTarget.scrollY

  const top = Math.max(0, viewport.offsetTop, pageOffsetTop)

  return {
    height: viewport.height,
    top,
    keyboardOpen:
      editableFocused && (viewport.height < windowTarget.innerHeight || top > 0),
  }
}

function isEditable(element: Element | null): boolean {
  if (!element) return false
  return (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT' ||
    (element as HTMLElement).isContentEditable
  )
}

export function installAppViewportSizing(
  windowTarget: ViewportWindow = window,
  style: ViewportStyle = document.documentElement.style,
  getActiveElement: () => Element | null = () =>
    typeof document === 'undefined' ? null : document.activeElement,
): () => void {
  const viewport = windowTarget.visualViewport
  let frameId: number | null = null

  const update = () => {
    frameId = null
    const frame = measureAppViewport(windowTarget, isEditable(getActiveElement()))
    style.setProperty(APP_VIEWPORT_HEIGHT_VAR, `${frame.height}px`)
    style.setProperty(APP_VIEWPORT_TOP_VAR, `${frame.top}px`)
    style.setProperty(
      APP_SAFE_AREA_BOTTOM_VAR,
      frame.keyboardOpen ? '0px' : 'env(safe-area-inset-bottom, 0px)',
    )
  }

  const schedule = () => {
    if (frameId !== null) return
    frameId = windowTarget.requestAnimationFrame(update)
  }

  update()
  viewport?.addEventListener('resize', schedule)
  viewport?.addEventListener('scroll', schedule)
  windowTarget.addEventListener('resize', schedule)
  windowTarget.addEventListener('pageshow', schedule)

  return () => {
    viewport?.removeEventListener('resize', schedule)
    viewport?.removeEventListener('scroll', schedule)
    windowTarget.removeEventListener('resize', schedule)
    windowTarget.removeEventListener('pageshow', schedule)
    if (frameId !== null) windowTarget.cancelAnimationFrame(frameId)
    style.removeProperty(APP_VIEWPORT_HEIGHT_VAR)
    style.removeProperty(APP_VIEWPORT_TOP_VAR)
    style.removeProperty(APP_SAFE_AREA_BOTTOM_VAR)
  }
}
