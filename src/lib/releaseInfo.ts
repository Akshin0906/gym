import type { DailyBriefing } from '../db/types'

// Everything here is sanitized operational metadata: version markers, a short
// commit id, and timestamps. No secrets, no file system paths, no request data.

export interface AppBuildInfo {
  version: string
  commit: string
  builtAt: number | null
  // True when the build could not record an identity (for example a tarball
  // build with no git metadata). Rendered as an explicit unavailable state.
  unknownCommit: boolean
  locallyModified: boolean
}

// `define` substitutes literals at build time; the fallbacks keep unit tests
// and any non-Vite consumer working.
export function readAppBuildInfo(): AppBuildInfo {
  const commit =
    typeof __APP_COMMIT__ === 'string' && __APP_COMMIT__ ? __APP_COMMIT__ : 'unknown'
  const version =
    typeof __APP_VERSION__ === 'string' && __APP_VERSION__
      ? __APP_VERSION__
      : 'unknown'
  const builtAtRaw = typeof __APP_BUILT_AT__ === 'string' ? __APP_BUILT_AT__ : ''
  const builtAt = Date.parse(builtAtRaw)
  return {
    version,
    commit,
    builtAt: Number.isNaN(builtAt) ? null : builtAt,
    unknownCommit: commit === 'unknown',
    locallyModified: commit.endsWith('+local'),
  }
}

export interface BackendVersion {
  commit: string | null
  environment: string | null
  apiContract: string | null
  serverTime: number | null
}

const COMMIT_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/

function sanitizedMarker(value: unknown): string | null {
  return typeof value === 'string' && COMMIT_PATTERN.test(value.trim())
    ? value.trim()
    : null
}

export function parseBackendVersion(raw: unknown): BackendVersion {
  if (raw === null || typeof raw !== 'object') {
    return { commit: null, environment: null, apiContract: null, serverTime: null }
  }
  const body = raw as Record<string, unknown>
  return {
    commit: sanitizedMarker(body.commit),
    environment: sanitizedMarker(body.environment),
    apiContract: sanitizedMarker(body.apiContract),
    serverTime:
      typeof body.serverTime === 'number' && Number.isFinite(body.serverTime)
        ? body.serverTime
        : null,
  }
}

export interface RunnerRelease {
  runnerVersion: string | null
  promptVersion: string | null
  model: string | null
  codexVersion: string | null
  lastSuccessfulRunAt: number | null
  lastSuccessfulBriefingDate: string | null
}

const EMPTY_RUNNER: RunnerRelease = {
  runnerVersion: null,
  promptVersion: null,
  model: null,
  codexVersion: null,
  lastSuccessfulRunAt: null,
  lastSuccessfulBriefingDate: null,
}

// The daily runner stamps its own version into every briefing it publishes, so
// the most recent cached briefing is a trustworthy record of which runner
// actually produced output and when. The phone never reads the local
// filesystem, so this is the only honest source available to it.
export function readRunnerRelease(
  briefing: DailyBriefing | null | undefined,
): RunnerRelease {
  if (!briefing) return EMPTY_RUNNER
  const summary = briefing.inputSummary
  const fields =
    summary !== null && typeof summary === 'object'
      ? (summary as Record<string, unknown>)
      : {}
  return {
    runnerVersion: sanitizedMarker(fields.runnerVersion),
    promptVersion: sanitizedMarker(fields.promptVersion),
    model: sanitizedMarker(fields.model) ?? sanitizedMarker(briefing.model),
    codexVersion: sanitizedMarker(fields.codexVersion),
    lastSuccessfulRunAt:
      typeof briefing.createdAt === 'number' && briefing.createdAt > 0
        ? briefing.createdAt
        : null,
    lastSuccessfulBriefingDate: briefing.briefingDate || null,
  }
}

export type ReleaseFreshness = 'current' | 'stale' | 'unavailable'

// A run is "stale" once it is more than this old. The daily briefing runs once
// per morning, so two missed days is the first unambiguous signal that the
// local automation has stopped producing output.
export const RUNNER_STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000

export function runnerFreshness(
  release: RunnerRelease,
  now = Date.now(),
): ReleaseFreshness {
  if (release.lastSuccessfulRunAt === null) return 'unavailable'
  return now - release.lastSuccessfulRunAt > RUNNER_STALE_AFTER_MS
    ? 'stale'
    : 'current'
}

// The version the working tree ships. Compared against the version the last
// briefing reported so Settings can say "installed runner is behind this build".
export const EXPECTED_RUNNER_VERSION = '3.8'

export function runnerVersionState(
  release: RunnerRelease,
  expected: string = EXPECTED_RUNNER_VERSION,
): 'matched' | 'behind' | 'unknown' {
  if (release.runnerVersion === null) return 'unknown'
  return release.runnerVersion === expected ? 'matched' : 'behind'
}
