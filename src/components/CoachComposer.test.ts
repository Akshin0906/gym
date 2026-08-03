import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CoachComposer } from './CoachComposer'

describe('CoachComposer', () => {
  it('disables suggestions, drafting, effort, and send during initial load', () => {
    const html = renderToStaticMarkup(
      createElement(CoachComposer, {
        hasActiveWorkout: false,
        disabled: true,
        onSend: vi.fn(),
        onDraftChange: vi.fn(),
      }),
    )
    const buttons = html.match(/<button[^>]*>/g) ?? []

    expect(buttons.length).toBeGreaterThan(2)
    expect(buttons.every((button) => button.includes('disabled=""'))).toBe(true)
    expect(html).toMatch(/<textarea[^>]*disabled=""/)
  })
})
