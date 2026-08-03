import { describe, expect, it, vi } from 'vitest'
import { isNewSetDraftDirty, shouldStartSetRowSwipe } from './SetLogger'

describe('SetLogger swipe targeting', () => {
  it('does not capture pointer input from nested action controls', () => {
    const action = {
      closest: vi.fn(() => ({ tagName: 'BUTTON' }) as unknown as Element),
    }

    expect(shouldStartSetRowSwipe(action as unknown as EventTarget)).toBe(false)
    expect(action.closest).toHaveBeenCalledWith(
      'button, input, select, textarea, a',
    )
  })

  it('still starts swiping from non-interactive row content', () => {
    const content = { closest: vi.fn(() => null) }

    expect(shouldStartSetRowSwipe(content as unknown as EventTarget)).toBe(true)
  })
})

describe('SetLogger draft tracking', () => {
  const committed = { w: '100', r: '8', rpe: '' }

  it('does not warn for untouched or just-committed prefilled values', () => {
    expect(isNewSetDraftDirty(committed, committed)).toBe(false)
  })

  it('warns when any unlogged field differs from its committed baseline', () => {
    expect(isNewSetDraftDirty({ ...committed, r: '9' }, committed)).toBe(true)
    expect(isNewSetDraftDirty({ ...committed, rpe: '8' }, committed)).toBe(true)
  })
})
