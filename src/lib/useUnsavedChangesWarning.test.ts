import { describe, expect, it } from 'vitest'
import { shouldBlockUnsavedNavigation } from './useUnsavedChangesWarning'

const current = {
  pathname: '/programs/program-1',
  search: '',
  hash: '',
}

describe('shouldBlockUnsavedNavigation', () => {
  it('allows navigation after a draft has been saved or cancelled', () => {
    expect(
      shouldBlockUnsavedNavigation(false, current, {
        pathname: '/programs',
        search: '',
        hash: '',
      }),
    ).toBe(false)
  })

  it('blocks dirty drafts from leaving through a different route', () => {
    expect(
      shouldBlockUnsavedNavigation(true, current, {
        pathname: '/programs',
        search: '',
        hash: '',
      }),
    ).toBe(true)
  })

  it('blocks search and hash navigation that changes the location', () => {
    expect(
      shouldBlockUnsavedNavigation(true, current, {
        ...current,
        search: '?view=compact',
      }),
    ).toBe(true)
    expect(
      shouldBlockUnsavedNavigation(true, current, {
        ...current,
        hash: '#sessions',
      }),
    ).toBe(true)
  })

  it('does not prompt for navigation to the identical location', () => {
    expect(shouldBlockUnsavedNavigation(true, current, current)).toBe(false)
  })
})
