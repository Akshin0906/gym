import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DailyBriefing, DailyBriefingSections } from '../db/types'
import {
  BriefingSections,
  briefingDateLabel,
  recoveryStatusLabel,
} from './RecommendationBanner'

const sections: DailyBriefingSections = {
  todaysCall: 'Run Upper as written and let the first set confirm the load.',
  why: [
    'The July 30 session was rated 4/5 planned and 5/5 feel.',
    'The last comparable top set held reps and effort.',
  ],
  recoveryStatus: 'fresh',
  ouraRecovery:
    'Oura estimate: 7.2 h sleep and readiness score 80; use as context, not a diagnosis.',
  trainingTrend: 'Comparable upper-body work is stable across two sessions.',
  watchOuts: ['Hold load if the first set misses the target range.'],
}

describe('RecommendationBanner presentation', () => {
  it('uses an action-first hierarchy with compact supporting context', () => {
    const html = renderToStaticMarkup(
      createElement(BriefingSections, {
        sections,
        dateLabel: 'Aug 5 briefing · workout data through Aug 1',
      }),
    )

    expect(html).toContain('Today&#x27;s plan')
    expect(html).toContain('Why this call')
    expect(html).toContain('Data context')
    expect(html).toContain('Recovery')
    expect(html).toContain('Training')
    expect(html).toContain('Watch')
    expect(html).toContain('workout data through Aug 1')
    expect(html).not.toContain('>Signals<')
    expect(html).not.toContain('>Guardrails<')
  })

  it('does not render an empty data-context container for legacy briefings', () => {
    const html = renderToStaticMarkup(
      createElement(BriefingSections, {
        sections: { ...sections, ouraRecovery: '', trainingTrend: '' },
        dateLabel: 'Aug 5 briefing',
      }),
    )

    expect(html).not.toContain('Data context')
  })

  it('distinguishes stale recovery from unavailable recovery', () => {
    expect(recoveryStatusLabel('fresh')).toBeNull()
    expect(recoveryStatusLabel('stale')).toBe('Oura stale')
    expect(recoveryStatusLabel('unavailable')).toBe('No Oura')
    expect(recoveryStatusLabel(undefined)).toBeNull()
  })

  it('humanizes briefing and workout-data dates without timezone drift', () => {
    const briefing: DailyBriefing = {
      briefingDate: '2026-08-05',
      createdAt: Date.parse('2026-08-05T19:00:00Z'),
      source: 'codex-local',
      snapshotUpdatedAt: Date.parse('2026-08-01T19:00:00Z'),
      headline: 'Run Upper as written',
      mode: 'normal',
      sections,
      model: 'gpt-5.6-sol',
      inputSummary: null,
    }

    expect(briefingDateLabel(briefing)).toBe(
      'Aug 5 briefing · workout data through Aug 1',
    )
  })
})
