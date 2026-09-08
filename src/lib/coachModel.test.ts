import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  COACH_MODEL,
  COACH_REASONING_EFFORT_LABELS,
  COACH_REQUEST_REASONING_EFFORT,
  isCoachReasoningEffort,
} from './chatTypes'
import { parseCoachStateForTest } from './chatApi'
import { CoachComposer } from '../components/CoachComposer'

describe('coach model and effort', () => {
  it('composes new messages at the product default', () => {
    expect(COACH_REQUEST_REASONING_EFFORT).toBe('high')
    expect(COACH_MODEL).toBe('gpt-6-astra')
  })

  it('keeps historical efforts readable', () => {
    // `medium` and `xhigh` were the defaults of the previous bridge. History is
    // not rewritten, and a transcript row carrying one still renders.
    for (const effort of ['medium', 'high', 'xhigh']) {
      expect(isCoachReasoningEffort(effort)).toBe(true)
      expect(COACH_REASONING_EFFORT_LABELS[effort as 'high']).toBeTruthy()
    }
    expect(isCoachReasoningEffort('ultra')).toBe(false)
    expect(isCoachReasoningEffort(null)).toBe(false)
  })

  it('parses a legacy transcript row without losing its effort', () => {
    const state = parseCoachStateForTest({
      messages: [
        {
          id: 'm1',
          sequence: 1,
          role: 'assistant',
          text: 'Older answer',
          createdAt: 1,
          reasoningEffort: 'xhigh',
          model: 'gpt-5.6-sol',
        },
        {
          id: 'm2',
          sequence: 2,
          role: 'assistant',
          text: 'New answer',
          createdAt: 2,
          reasoningEffort: 'high',
          model: 'gpt-6-astra',
        },
      ],
    })
    expect(state.messages.map((m) => m.reasoningEffort)).toEqual([
      'xhigh',
      'high',
    ])
    expect(state.messages.map((m) => m.model)).toEqual([
      'gpt-5.6-sol',
      'gpt-6-astra',
    ])
  })

  it('sends the single supported effort from the composer', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    const html = renderToStaticMarkup(
      createElement(CoachComposer, {
        hasActiveWorkout: false,
        disabled: false,
        onSend,
        onDraftChange: vi.fn(),
      }),
    )
    // The effort is presented rather than chosen, so the user can see what
    // their message will run at.
    expect(html).toContain('High reasoning')
    expect(html).toContain(COACH_MODEL)
  })
})
