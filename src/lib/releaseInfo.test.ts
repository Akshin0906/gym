import { describe, expect, it } from 'vitest'
import type { DailyBriefing } from '../db/types'
import {
  EXPECTED_RUNNER_VERSION,
  RUNNER_STALE_AFTER_MS,
  parseBackendVersion,
  readRunnerRelease,
  runnerFreshness,
  runnerVersionState,
} from './releaseInfo'

function briefing(inputSummary: unknown, createdAt = 1_000): DailyBriefing {
  return {
    briefingDate: '2026-09-07',
    createdAt,
    source: 'codex-local',
    snapshotUpdatedAt: 1,
    headline: 'Train as planned',
    mode: 'normal',
    sections: {
      todaysCall: 'Run the session as written.',
      why: [],
      ouraRecovery: '',
      trainingTrend: '',
      watchOuts: [],
    },
    model: 'gpt-5.6-sol',
    inputSummary,
  }
}

describe('runner release identity', () => {
  it('reads the version the last briefing was produced by', () => {
    const release = readRunnerRelease(
      briefing({
        runnerVersion: '3.8',
        promptVersion: '2026-08-13-bounded-evidence-packet-v2',
        model: 'gpt-5.6-sol',
        codexVersion: '0.51.0',
      }),
    )

    expect(release.runnerVersion).toBe('3.8')
    expect(release.promptVersion).toBe(
      '2026-08-13-bounded-evidence-packet-v2',
    )
    expect(release.codexVersion).toBe('0.51.0')
    expect(release.lastSuccessfulRunAt).toBe(1_000)
    expect(release.lastSuccessfulBriefingDate).toBe('2026-09-07')
  })

  it('reports unavailable rather than guessing when there is no briefing', () => {
    const release = readRunnerRelease(null)
    expect(release.runnerVersion).toBeNull()
    expect(release.lastSuccessfulRunAt).toBeNull()
    expect(runnerFreshness(release)).toBe('unavailable')
    expect(runnerVersionState(release)).toBe('unknown')
  })

  it('ignores a malformed inputSummary', () => {
    expect(readRunnerRelease(briefing('not-an-object')).runnerVersion).toBeNull()
    expect(readRunnerRelease(briefing(null)).runnerVersion).toBeNull()
    expect(
      readRunnerRelease(briefing({ runnerVersion: 42 })).runnerVersion,
    ).toBeNull()
  })

  it('refuses to echo a value that is not a plain version marker', () => {
    // Guards the "sanitized operational metadata only" rule: anything with a
    // path separator or whitespace is dropped rather than rendered.
    const release = readRunnerRelease(
      briefing({ runnerVersion: '/Users/someone/.workout-tracker/current' }),
    )
    expect(release.runnerVersion).toBeNull()
  })

  it('flags an installed runner that is behind this build', () => {
    const behind = readRunnerRelease(briefing({ runnerVersion: '3.5' }))
    expect(runnerVersionState(behind)).toBe('behind')

    const matched = readRunnerRelease(
      briefing({ runnerVersion: EXPECTED_RUNNER_VERSION }),
    )
    expect(runnerVersionState(matched)).toBe('matched')
  })

  it('calls a run stale once it is older than the threshold', () => {
    const now = 10_000_000_000
    const fresh = readRunnerRelease(briefing({}, now - 1_000))
    const stale = readRunnerRelease(
      briefing({}, now - RUNNER_STALE_AFTER_MS - 1),
    )

    expect(runnerFreshness(fresh, now)).toBe('current')
    expect(runnerFreshness(stale, now)).toBe('stale')
  })
})

describe('backend version parsing', () => {
  it('accepts a sanitized deploy marker', () => {
    expect(
      parseBackendVersion({
        commit: 'a1b2c3d4e5f6',
        environment: 'production',
        apiContract: 'cloud-v1',
        serverTime: 5,
      }),
    ).toEqual({
      commit: 'a1b2c3d4e5f6',
      environment: 'production',
      apiContract: 'cloud-v1',
      serverTime: 5,
    })
  })

  it('reports nulls instead of echoing unexpected shapes', () => {
    expect(parseBackendVersion(null)).toEqual({
      commit: null,
      environment: null,
      apiContract: null,
      serverTime: null,
    })
    expect(
      parseBackendVersion({
        commit: '/srv/secret path',
        environment: { name: 'prod' },
        serverTime: 'now',
      }),
    ).toEqual({
      commit: null,
      environment: null,
      apiContract: null,
      serverTime: null,
    })
  })
})
