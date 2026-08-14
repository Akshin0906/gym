import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PreWorkoutCheckIn } from './PreWorkoutCheckIn'

describe('PreWorkoutCheckIn', () => {
  it('renders one deliberately unanswered recovery question', () => {
    const html = renderToStaticMarkup(
      createElement(PreWorkoutCheckIn, {
        sessionName: 'Lower body',
        onSave: async () => undefined,
        onSkip: async () => undefined,
      }),
    )

    expect(html).toContain('Pre-workout check-in')
    expect(html).toContain(
      'Answer after a short warm-up and before your first work set.',
    )
    expect(html).toContain(
      'How recovered do you feel for today’s workout?',
    )
    expect(html).toContain(
      'aria-label="0 of 10 — Very poorly recovered / extremely tired"',
    )
    expect(html).toContain(
      'aria-label="10 of 10 — Very well recovered / highly energetic"',
    )
    expect(html).toContain('5 Adequately recovered')
    expect(html).toContain('Continue to workout')
    expect(html).toContain('Skip check-in')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('checked=""')
    expect((html.match(/type="radio"/g) ?? [])).toHaveLength(11)
  })

  it('asks no additional wellness questions', () => {
    const html = renderToStaticMarkup(
      createElement(PreWorkoutCheckIn, {
        sessionName: 'Workout',
        onSave: async () => undefined,
        onSkip: async () => undefined,
      }),
    )

    expect(html).not.toContain('pain, illness')
    expect(html).not.toContain('most limiting')
    expect(html).not.toContain('motivated')
    expect((html.match(/<fieldset/g) ?? [])).toHaveLength(1)
  })
})
