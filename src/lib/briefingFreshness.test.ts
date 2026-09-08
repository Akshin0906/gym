import { describe, expect, it } from 'vitest'
import type { DailyBriefing } from '../db/types'
import { evaluateBriefingFreshness } from './briefingFreshness'

// Pacific noon so the UTC date and the Pacific date agree in every assertion.
function pacificNoon(isoDate: string): number {
  return Date.parse(`${isoDate}T19:00:00Z`)
}

function briefing(overrides: Partial<DailyBriefing> = {}): DailyBriefing {
  return {
    briefingDate: '2026-09-07',
    createdAt: pacificNoon('2026-09-07'),
    source: 'codex-local',
    snapshotUpdatedAt: pacificNoon('2026-09-07'),
    headline: 'Run Upper as written',
    mode: 'normal',
    sections: {
      todaysCall: 'Run the session as written.',
      why: [],
      recoveryStatus: 'fresh',
      ouraRecovery: 'Readiness 80.',
      trainingTrend: 'Stable.',
      watchOuts: [],
    },
    model: 'gpt-5.6-sol',
    inputSummary: { latestCompletedWorkoutAt: pacificNoon('2026-09-07') },
    ...overrides,
  }
}

const NOW = new Date(pacificNoon('2026-09-07'))

describe('briefing freshness', () => {
  it('reports current training data when the snapshot matches the briefing day', () => {
    const result = evaluateBriefingFreshness({
      briefing: briefing(),
      localLatestCompletedAt: pacificNoon('2026-09-07'),
      hasPendingLocalChanges: false,
      now: NOW,
    })

    expect(result.training.level).toBe('current')
    expect(result.training.reason).toBe('current')
    expect(result.briefingDateIsStale).toBe(false)
    expect(result.offerSyncAction).toBe(false)
    expect(result.generatedAtLabel).toBe('Sep 7')
  })

  it('flags the reproduced case: a Sep 7 briefing built on a Sep 2 snapshot', () => {
    const result = evaluateBriefingFreshness({
      briefing: briefing({
        snapshotUpdatedAt: pacificNoon('2026-09-02'),
        inputSummary: { latestCompletedWorkoutAt: pacificNoon('2026-09-02') },
      }),
      localLatestCompletedAt: pacificNoon('2026-09-02'),
      hasPendingLocalChanges: false,
      now: NOW,
    })

    expect(result.training.level).toBe('behind')
    expect(result.training.reason).toBe('snapshot_older_than_briefing')
    expect(result.training.behindByDays).toBe(5)
    expect(result.training.summary).toBe('Training synced Sep 2 (5 days old)')
    // Nothing local is pending, so another upload would not change the answer.
    expect(result.offerSyncAction).toBe(false)
  })

  it('offers a sync action when this device has a workout the briefing never saw', () => {
    const result = evaluateBriefingFreshness({
      briefing: briefing({
        snapshotUpdatedAt: pacificNoon('2026-09-02'),
        inputSummary: { latestCompletedWorkoutAt: pacificNoon('2026-09-02') },
      }),
      localLatestCompletedAt: pacificNoon('2026-09-06'),
      hasPendingLocalChanges: true,
      now: NOW,
    })

    expect(result.training.reason).toBe('workout_newer_than_briefing')
    expect(result.training.summary).toBe('Missing training through Sep 6')
    expect(result.offerSyncAction).toBe(true)
  })

  it('flags pending local edits even when no new workout was completed', () => {
    const result = evaluateBriefingFreshness({
      briefing: briefing(),
      localLatestCompletedAt: pacificNoon('2026-09-07'),
      hasPendingLocalChanges: true,
      now: NOW,
    })

    expect(result.training.reason).toBe('local_changes_pending')
    expect(result.training.summary).toBe('Local changes not synced yet')
    expect(result.offerSyncAction).toBe(true)
  })

  it('says the training sync date is unknown rather than guessing', () => {
    const result = evaluateBriefingFreshness({
      briefing: briefing({ snapshotUpdatedAt: 0, inputSummary: null }),
      localLatestCompletedAt: null,
      hasPendingLocalChanges: false,
      now: NOW,
    })

    expect(result.training.level).toBe('unknown')
    expect(result.training.reason).toBe('missing_metadata')
    expect(result.training.summary).toBe('Training sync date unknown')
    expect(result.offerSyncAction).toBe(false)
  })

  it('ignores a malformed inputSummary instead of trusting it', () => {
    const result = evaluateBriefingFreshness({
      briefing: briefing({
        snapshotUpdatedAt: 0,
        inputSummary: { latestCompletedWorkoutAt: 'yesterday' },
      }),
      localLatestCompletedAt: pacificNoon('2026-09-07'),
      hasPendingLocalChanges: false,
      now: NOW,
    })

    expect(result.training.reason).toBe('missing_metadata')
    expect(result.training.briefingWorkoutDateLabel).toBeNull()
  })

  it('keeps fresh Oura data from implying fresh training data', () => {
    const result = evaluateBriefingFreshness({
      briefing: briefing({
        snapshotUpdatedAt: pacificNoon('2026-09-02'),
        inputSummary: { latestCompletedWorkoutAt: pacificNoon('2026-09-02') },
        sections: { ...briefing().sections, recoveryStatus: 'fresh' },
      }),
      localLatestCompletedAt: pacificNoon('2026-09-02'),
      hasPendingLocalChanges: false,
      now: NOW,
    })

    expect(result.recovery.status).toBe('fresh')
    expect(result.recovery.label).toBe('Oura fresh')
    expect(result.training.level).toBe('behind')
  })

  it('marks a briefing from an earlier day as not today', () => {
    const result = evaluateBriefingFreshness({
      briefing: briefing({ briefingDate: '2026-09-05' }),
      localLatestCompletedAt: null,
      hasPendingLocalChanges: false,
      now: NOW,
    })

    expect(result.briefingDateIsStale).toBe(true)
    expect(result.briefingDateLabel).toBe('Sep 5')
  })
})
