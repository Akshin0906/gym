import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { getLatestDailyBriefing } from '../db/repositories/dailyBriefings'
import { getLocalSyncState } from '../db/repositories/syncState'
import { subscribeLocalSyncState } from '../db/repositories/syncState'
import { isCloudConfigured } from '../lib/cloud'
import {
  EXPECTED_RUNNER_VERSION,
  parseBackendVersion,
  readAppBuildInfo,
  readRunnerRelease,
  runnerFreshness,
  runnerVersionState,
  type BackendVersion,
  type RunnerRelease,
} from '../lib/releaseInfo'

function formatTimestamp(epochMs: number | null): string {
  if (epochMs === null) return 'Unavailable'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(epochMs)
}

type Tone = 'neutral' | 'warn'

function Row({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string
  value: string
  detail?: string | null
  tone?: Tone
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <dt className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-fg-faint)] shrink-0 pt-0.5">
        {label}
      </dt>
      <dd className="min-w-0 text-right">
        <span
          className="block text-sm nums break-words"
          style={{
            color:
              tone === 'warn' ? 'oklch(0.80 0.14 60)' : 'var(--color-fg)',
          }}
        >
          {tone === 'warn' && (
            <AlertTriangle
              size={12}
              aria-hidden
              className="inline-block mr-1 -mt-0.5"
            />
          )}
          {value}
        </span>
        {detail && (
          <span className="block text-[11px] text-[var(--color-fg-faint)]">
            {detail}
          </span>
        )}
      </dd>
    </div>
  )
}

export interface ReleaseSectionState {
  runner: RunnerRelease
  backend: BackendVersion | null
  backendError: string | null
  pendingLocalChanges: boolean
}

// Sanitized operational metadata only. Everything shown here is a version
// marker or a timestamp; no secrets, no credentials, and no file system paths.
export function ReleaseSection() {
  const build = readAppBuildInfo()
  const [state, setState] = useState<ReleaseSectionState | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    const [briefing, sync] = await Promise.all([
      getLatestDailyBriefing(),
      getLocalSyncState(),
    ])
    let backend: BackendVersion | null = null
    let backendError: string | null = null
    if (isCloudConfigured()) {
      try {
        const res = await fetch('/api/cloud/version', {
          credentials: 'include',
          cache: 'no-store',
        })
        if (res.ok) backend = parseBackendVersion(await res.json())
        else backendError = `Backend version check failed (${res.status})`
      } catch (err) {
        backendError = err instanceof Error ? err.message : String(err)
      }
    }
    setState({
      runner: readRunnerRelease(briefing ?? null),
      backend,
      backendError,
      pendingLocalChanges: sync.localRevision > sync.syncedRevision,
    })
  }, [])

  useEffect(() => {
    void load()
    return subscribeLocalSyncState(() => void load())
  }, [load])

  async function refresh() {
    if (refreshing) return
    setRefreshing(true)
    try {
      await load()
    } finally {
      setRefreshing(false)
    }
  }

  const runner = state?.runner
  const freshness = runner ? runnerFreshness(runner) : 'unavailable'
  const versionState = runner ? runnerVersionState(runner) : 'unknown'

  return (
    <section className="space-y-3 pt-4 border-t border-[var(--color-border)]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
          Release
        </h2>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="btn-ghost text-[11px] py-1.5 px-2.5"
        >
          <RefreshCw
            size={12}
            aria-hidden
            className={refreshing ? 'animate-spin' : undefined}
          />
          Refresh
        </button>
      </div>

      <dl className="card px-4 py-1 divide-y divide-[var(--color-border)]">
        <Row
          label="App"
          value={`v${build.version} · ${build.unknownCommit ? 'commit unavailable' : build.commit}`}
          detail={
            build.builtAt === null
              ? 'Build time unavailable'
              : `Built ${formatTimestamp(build.builtAt)}`
          }
          tone={build.unknownCommit || build.locallyModified ? 'warn' : 'neutral'}
        />
        <Row
          label="Backend"
          value={
            state === null
              ? 'Checking…'
              : !isCloudConfigured()
                ? 'Not paired'
                : state.backend === null
                  ? 'Unavailable'
                  : (state.backend.commit ??
                    state.backend.apiContract ??
                    'Version not reported')
          }
          detail={
            state?.backendError ??
            (state?.backend?.environment
              ? `Environment ${state.backend.environment}`
              : state?.backend?.apiContract
                ? `Contract ${state.backend.apiContract}`
                : null)
          }
          tone={
            state !== null && isCloudConfigured() && state.backend === null
              ? 'warn'
              : 'neutral'
          }
        />
        <Row
          label="Daily runner"
          value={
            state === null
              ? 'Checking…'
              : (runner?.runnerVersion ?? 'Unavailable')
          }
          detail={
            versionState === 'behind'
              ? `This build expects ${EXPECTED_RUNNER_VERSION}; the last briefing came from ${runner?.runnerVersion}`
              : versionState === 'unknown'
                ? 'No briefing has reported a runner version yet'
                : `Matches the expected ${EXPECTED_RUNNER_VERSION}`
          }
          tone={versionState === 'matched' ? 'neutral' : 'warn'}
        />
        <Row
          label="Last run"
          value={
            state === null
              ? 'Checking…'
              : formatTimestamp(runner?.lastSuccessfulRunAt ?? null)
          }
          detail={
            freshness === 'unavailable'
              ? 'No successful briefing has been received'
              : freshness === 'stale'
                ? `Last briefing was for ${runner?.lastSuccessfulBriefingDate ?? 'an unknown date'} — the local automation may have stopped`
                : `Briefing for ${runner?.lastSuccessfulBriefingDate ?? 'an unknown date'}`
          }
          tone={freshness === 'current' ? 'neutral' : 'warn'}
        />
        <Row
          label="Local changes"
          value={
            state === null
              ? 'Checking…'
              : state.pendingLocalChanges
                ? 'Waiting to sync'
                : 'Synced'
          }
          detail={
            state?.pendingLocalChanges
              ? 'Edits on this device have not reached the cloud mirror yet'
              : null
          }
          tone={state?.pendingLocalChanges ? 'warn' : 'neutral'}
        />
        {runner?.model && (
          <Row
            label="Model"
            value={runner.model}
            detail={
              runner.promptVersion ? `Prompt ${runner.promptVersion}` : null
            }
          />
        )}
      </dl>
    </section>
  )
}
