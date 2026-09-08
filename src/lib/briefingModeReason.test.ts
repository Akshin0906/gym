import { describe, expect, it } from 'vitest'
import { assertBriefingSections } from '../../functions/api/cloud/[[path]]'
import { parseCloudBriefingForTest } from './cloud'
import { BRIEFING_MODE_REASONS } from '../db/types'

const BASE = {
  todaysCall: 'Run the session as written.',
  why: ['One reason.'],
  ouraRecovery: 'Recovery estimates unavailable.',
  trainingTrend: 'Not enough comparable sessions to call a trend.',
  watchOuts: [] as string[],
}

describe('mode reason label', () => {
  it('survives the cloud round trip', () => {
    // `rest` alone is ambiguous — a deliberate day off, a stop on a reported
    // symptom, and a precautionary stop are different situations. The label is
    // supervisor-owned, so it must not be dropped between the runner and the app.
    for (const reason of BRIEFING_MODE_REASONS) {
      const stored = JSON.parse(
        assertBriefingSections({ ...BASE, modeReasonLabel: reason }),
      ) as Record<string, unknown>
      expect(stored.modeReasonLabel).toBe(reason)
      const parsed = parseCloudBriefingForTest({
        briefingDate: '2026-09-08',
        createdAt: 1,
        source: 'codex-local',
        snapshotUpdatedAt: 1,
        headline: 'Rest today',
        mode: 'rest',
        sections: stored,
        model: 'gpt-6-astra',
      })
      expect(parsed.sections.modeReasonLabel).toBe(reason)
    }
  })

  it('stays optional so older briefings remain valid', () => {
    const stored = JSON.parse(assertBriefingSections(BASE)) as Record<
      string,
      unknown
    >
    expect('modeReasonLabel' in stored).toBe(false)
    const parsed = parseCloudBriefingForTest({
      briefingDate: '2026-09-08',
      createdAt: 1,
      source: 'codex-local',
      snapshotUpdatedAt: 1,
      headline: 'Run it',
      mode: 'normal',
      sections: stored,
      model: 'gpt-5.6-sol',
    })
    expect(parsed.sections.modeReasonLabel).toBeUndefined()
  })

  it('rejects an unknown reason at the edge', () => {
    expect(() =>
      assertBriefingSections({ ...BASE, modeReasonLabel: 'because' }),
    ).toThrow(/modeReasonLabel/)
  })

  it('ignores an unknown reason on the way in', () => {
    // A value this build does not know is not rendered as one.
    const parsed = parseCloudBriefingForTest({
      briefingDate: '2026-09-08',
      createdAt: 1,
      source: 'codex-local',
      snapshotUpdatedAt: 1,
      headline: 'Rest today',
      mode: 'rest',
      sections: { ...BASE, modeReasonLabel: 'from-a-newer-runner' },
      model: 'gpt-6-astra',
    })
    expect(parsed.sections.modeReasonLabel).toBeUndefined()
  })
})
