import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionFeedback } from './SessionFeedback'

describe('SessionFeedback', () => {
  it('renders three explicit, initially unanswered post-workout questions', () => {
    const html = renderToStaticMarkup(
      createElement(SessionFeedback, {
        sessionName: 'Upper body',
        onSave: async () => undefined,
        onSkip: () => undefined,
      }),
    )

    expect(html).toContain(
      'Compared with what you expected today, how did you perform?',
    )
    expect(html).toContain('How hard was this workout overall?')
    expect(html).toContain(
      'Did you have pain or another physical problem during this workout?',
    )
    expect(html).toContain('Rate the whole session, not just the final set.')
    expect(html).toContain('Don’t count normal effort or muscle burn.')
    expect(html).toContain('Yes — stopped an exercise or workout')
    expect(html).toContain('aria-label="0 of 10 — Rest"')
    expect(html).toContain('aria-label="10 of 10 — Maximal"')
    expect(html).toContain('Save check-in')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('checked=""')
  })

  it('does not retain the ambiguous legacy question wording', () => {
    const html = renderToStaticMarkup(
      createElement(SessionFeedback, {
        sessionName: 'Workout',
        onSave: async () => undefined,
        onSkip: () => undefined,
      }),
    )

    expect(html).not.toContain('Did the session go as planned?')
    expect(html).not.toContain('How did that feel?')
  })
})
