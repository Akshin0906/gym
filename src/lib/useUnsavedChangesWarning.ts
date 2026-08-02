import { useCallback, useEffect } from 'react'
import {
  type BlockerFunction,
  type Location,
  useBlocker,
} from 'react-router-dom'

const DEFAULT_MESSAGE =
  'You have unsaved changes. Leave this page and discard them?'

type ComparableLocation = Pick<Location, 'pathname' | 'search' | 'hash'>

export function shouldBlockUnsavedNavigation(
  when: boolean,
  currentLocation: ComparableLocation,
  nextLocation: ComparableLocation,
): boolean {
  return (
    when &&
    (currentLocation.pathname !== nextLocation.pathname ||
      currentLocation.search !== nextLocation.search ||
      currentLocation.hash !== nextLocation.hash)
  )
}

/**
 * Protects a page-level draft from both client-side navigation and closing or
 * reloading the tab/PWA. Call this once per route and aggregate nested editor
 * state before passing `when`; React Router supports a single active blocker.
 */
export function useUnsavedChangesWarning(
  when: boolean,
  message = DEFAULT_MESSAGE,
) {
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      shouldBlockUnsavedNavigation(when, currentLocation, nextLocation),
    [when],
  )
  const blocker = useBlocker(shouldBlock)

  useEffect(() => {
    if (blocker.state !== 'blocked') return
    if (window.confirm(message)) blocker.proceed()
    else blocker.reset()
  }, [blocker, message])

  useEffect(() => {
    if (!when) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [when])
}
