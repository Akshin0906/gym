import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  AlertTriangle,
  ChevronDown,
  CloudUpload,
  Moon,
  RefreshCw,
  TrendingUp,
} from 'lucide-react'
import { db } from '../db/schema'
import { getLatestDailyBriefing } from '../db/repositories/dailyBriefings'
import {
  hasPendingLocalChanges,
  subscribeLocalSyncState,
} from '../db/repositories/syncState'
import type {
  BriefingModeReason,
  DailyBriefing,
  DailyBriefingSections,
  RecommendationMode,
} from '../db/types'
import {
  fetchLatestCloudBriefing,
  isCloudConfigured,
  pacificDate,
  subscribeCloudSyncStatus,
  syncPendingLocalChanges,
} from '../lib/cloud'
import {
  evaluateBriefingFreshness,
  displayShortDate,
  type BriefingFreshness,
} from '../lib/briefingFreshness'

// Pinned mode colors — push and deload sit at opposite ends of the warmth
// axis so they don't read as the same color in a glanceable dot.
const MODE_COLOR: Record<RecommendationMode, string> = {
  push: 'oklch(0.74 0.18 50)',
  normal: 'oklch(0.68 0.02 250)',
  light: 'oklch(0.72 0.10 220)',
  deload: 'oklch(0.55 0.04 250)',
  rest: 'oklch(0.66 0.17 25)',
}

const MODE_LABEL: Record<RecommendationMode, string> = {
  push: 'Push',
  normal: 'Normal',
  light: 'Light',
  deload: 'Deload',
  rest: 'Rest',
}

// `Rest` alone is ambiguous: a deliberate day off, a stop on a medical report,
// and a precautionary stop on something unclassified are different situations
// and should not read the same. The supervisor decides which; the app only
// renders it. Absent on briefings published before the field existed.
const MODE_REASON_LABEL: Record<BriefingModeReason, string> = {
  medical_stop: 'Reported symptom',
  planned_rest: 'Planned rest day',
  precautionary_stop: 'Precaution',
  planned_deload: 'Planned deload',
  reactive_deload: 'In response to recent sessions',
  temporary_training_adjustment: 'Today only',
}

// The system prompt forbids markdown, but the model occasionally leaks
// **bold**, *italic*, or leading "- "/"* ". Render inline emphasis as real
// tags and drop leading bullet chars so output reads cleanly either way.
const INLINE_MD = /\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g
function renderInline(text: string): ReactNode[] {
  const stripped = text.replace(/^\s*[-*•]\s+/, '')
  const parts: ReactNode[] = []
  let lastIndex = 0
  let key = 0
  INLINE_MD.lastIndex = 0
  for (
    let match = INLINE_MD.exec(stripped);
    match !== null;
    match = INLINE_MD.exec(stripped)
  ) {
    if (match.index > lastIndex) parts.push(stripped.slice(lastIndex, match.index))
    const bold = match[1] ?? match[2]
    const italic = match[3] ?? match[4]
    if (bold !== undefined) parts.push(<strong key={key++}>{bold}</strong>)
    else if (italic !== undefined) parts.push(<em key={key++}>{italic}</em>)
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < stripped.length) parts.push(stripped.slice(lastIndex))
  return parts.length > 0 ? parts : [stripped]
}

interface State {
  briefing: DailyBriefing | null
  hasWorkouts: boolean
  freshness: BriefingFreshness | null
}

export function RecommendationBanner() {
  const [state, setState] = useState<State | null>(null)
  const [expanded, setExpanded] = useState(false)
  const loadGeneration = useRef(0)
  const mounted = useRef(false)

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    const [briefing, completed, pendingLocal] = await Promise.all([
      getLatestDailyBriefing(),
      // The newest completed workout is the trustworthy local counterpart to
      // the briefing's own snapshot metadata.
      db.workoutSessions
        .filter((s) => s.completedAt !== null)
        .toArray()
        .then((rows) =>
          rows.reduce<number | null>(
            (latest, row) =>
              row.completedAt !== null && (latest === null || row.completedAt > latest)
                ? row.completedAt
                : latest,
            null,
          ),
        ),
      hasPendingLocalChanges(),
    ])
    if (!mounted.current || generation !== loadGeneration.current) return
    setState({
      briefing: briefing ?? null,
      hasWorkouts: completed !== null,
      freshness: briefing
        ? evaluateBriefingFreshness({
            briefing,
            localLatestCompletedAt: completed,
            hasPendingLocalChanges: pendingLocal,
          })
        : null,
    })
  }, [])

  useEffect(() => {
    mounted.current = true
    let cancelled = false

    void load()
    void fetchLatestCloudBriefing()
      .catch(() => {
        // Cached briefing remains visible when cloud fetch fails.
      })
      .finally(() => {
        // Re-read IndexedDB after the download. This also makes the newest
        // generation win if the initial cache read finishes out of order.
        if (!cancelled) void load()
      })

    // The global foreground refresh may repair the cached auth flag and write
    // the briefing after this component's first fetch has already returned.
    // Its status event is emitted only after the IndexedDB upsert completes.
    const unsubscribeStatus = subscribeCloudSyncStatus(() => void load())
    // A local edit changes the training-freshness verdict even when the
    // briefing itself has not changed.
    const unsubscribeLocal = subscribeLocalSyncState(() => void load())
    const onVis = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      mounted.current = false
      loadGeneration.current += 1
      unsubscribeStatus()
      unsubscribeLocal()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [load])

  if (state === null) return null
  if (!state.hasWorkouts) return null
  if (!state.briefing) return null

  const latest = state.briefing
  const freshness = state.freshness
  const dotColor = MODE_COLOR[latest.mode]
  const dateLabel = briefingDateLabel(latest)

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-4 py-3.5 flex items-center gap-3 text-left transition-colors hover:bg-[var(--color-surface-2)]"
        aria-expanded={expanded}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)]">
              AI briefing
            </span>
            <span
              className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
              style={{ color: dotColor, borderColor: dotColor }}
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: dotColor }}
              />
              {MODE_LABEL[latest.mode]}
            </span>
            {latest.sections.modeReasonLabel && (
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-fg-faint)]">
                {MODE_REASON_LABEL[latest.sections.modeReasonLabel]}
              </span>
            )}
            {freshness?.recovery.label && (
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-fg-faint)]">
                {freshness.recovery.label}
              </span>
            )}
          </span>
          <span className="mt-1.5 block text-[15px] font-semibold leading-snug text-[var(--color-fg)]">
            {renderInline(latest.headline)}
          </span>
        </span>
        <ChevronDown
          size={16}
          className={`text-[var(--color-fg-faint)] transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      {freshness && <FreshnessRow freshness={freshness} />}
      {expanded && (
        <BriefingSections
          sections={latest.sections}
          dateLabel={dateLabel}
        />
      )}
    </div>
  )
}

const TRAINING_TONE: Record<
  BriefingFreshness['training']['level'],
  { fg: string; border: string; background: string }
> = {
  current: {
    fg: 'var(--color-fg-faint)',
    border: 'var(--color-border)',
    background: 'transparent',
  },
  behind: {
    fg: 'oklch(0.80 0.14 60)',
    border: 'oklch(0.55 0.15 60 / 0.45)',
    background: 'oklch(0.25 0.08 60 / 0.35)',
  },
  unknown: {
    fg: 'var(--color-fg-dim)',
    border: 'var(--color-border)',
    background: 'transparent',
  },
}

// Always visible, above the fold: when the briefing is for, when it was
// generated, and how current the training data behind it is. These are three
// separate facts and the card never lets one stand in for another.
export function FreshnessRow({ freshness }: { freshness: BriefingFreshness }) {
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const tone = TRAINING_TONE[freshness.training.level]

  async function syncNow() {
    if (syncing) return
    setSyncing(true)
    setSyncMessage(null)
    try {
      const outcome = await syncPendingLocalChanges('manual')
      setSyncMessage(
        outcome === 'uploaded'
          ? 'Training data sent. A new briefing follows the next run.'
          : outcome === 'up_to_date'
            ? 'Training data already sent; waiting on the next briefing.'
            : outcome === 'deferred_coach_reservation'
              ? 'Waiting for a Coach change to finish syncing.'
              : 'Pair this device in Settings to sync.',
      )
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div
      className="border-t px-4 py-2.5 space-y-2"
      style={{ borderColor: 'var(--color-border)', background: tone.background }}
    >
      <dl className="flex items-center gap-x-4 gap-y-1 flex-wrap text-[11px] leading-tight">
        <div className="flex items-baseline gap-1.5">
          <dt className="font-bold uppercase tracking-wider text-[var(--color-fg-faint)]">
            Briefing
          </dt>
          <dd className="nums text-[var(--color-fg-dim)]">
            {freshness.briefingDateLabel}
            {freshness.briefingDateIsStale && ' (not today)'}
          </dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="font-bold uppercase tracking-wider text-[var(--color-fg-faint)]">
            Generated
          </dt>
          <dd className="nums text-[var(--color-fg-dim)]">
            {freshness.generatedAtLabel ?? 'Unknown'}
          </dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="font-bold uppercase tracking-wider text-[var(--color-fg-faint)]">
            Training data
          </dt>
          <dd className="nums" style={{ color: tone.fg }}>
            {freshness.training.level === 'behind' && (
              <AlertTriangle
                size={11}
                aria-hidden
                className="inline-block mr-1 -mt-0.5"
              />
            )}
            {freshness.training.summary}
          </dd>
        </div>
      </dl>
      {freshness.offerSyncAction && isCloudConfigured() && (
        <button
          type="button"
          onClick={() => void syncNow()}
          disabled={syncing}
          className="btn-ghost text-[11px] py-1.5 px-2.5"
        >
          {syncing ? (
            <RefreshCw size={12} className="animate-spin" aria-hidden />
          ) : (
            <CloudUpload size={12} aria-hidden />
          )}
          {syncing ? 'Syncing training data…' : 'Sync training data now'}
        </button>
      )}
      {syncMessage && (
        <p
          role="status"
          className="text-[11px] leading-snug text-[var(--color-fg-dim)]"
        >
          {syncMessage}
        </p>
      )}
    </div>
  )
}

export function briefingDateLabel(briefing: DailyBriefing): string {
  const labels = [`${displayShortDate(briefing.briefingDate)} briefing`]
  const input = briefing.inputSummary
  const latestCompletedWorkoutAt =
    input !== null &&
    typeof input === 'object' &&
    'latestCompletedWorkoutAt' in input &&
    typeof input.latestCompletedWorkoutAt === 'number' &&
    Number.isFinite(input.latestCompletedWorkoutAt)
      ? input.latestCompletedWorkoutAt
      : null

  if (latestCompletedWorkoutAt !== null) {
    const workoutDate = pacificDate(new Date(latestCompletedWorkoutAt))
    if (workoutDate && workoutDate !== briefing.briefingDate) {
      labels.push(`workout data through ${displayShortDate(workoutDate)}`)
    }
  }

  if (briefing.snapshotUpdatedAt) {
    const snapshotDate = pacificDate(new Date(briefing.snapshotUpdatedAt))
    if (snapshotDate && snapshotDate !== briefing.briefingDate) {
      labels.push(`snapshot synced ${displayShortDate(snapshotDate)}`)
    }
  }

  return labels.join(' · ')
}

export function BriefingSections({
  sections,
  dateLabel,
}: {
  sections: DailyBriefingSections
  dateLabel: string
}) {
  return (
    <div className="border-t border-[var(--color-border)] px-4 py-4 space-y-4 text-sm text-[var(--color-fg-dim)]">
      <section className="space-y-1.5">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
          Today&apos;s plan
        </h3>
        <p className="text-base leading-relaxed text-[var(--color-fg)]">
          {renderInline(sections.todaysCall)}
        </p>
      </section>
      {sections.why.length > 0 && (
        <Section title="Why this call">
          <BulletList items={sections.why} />
        </Section>
      )}
      {(sections.ouraRecovery || sections.trainingTrend) && (
        <section className="space-y-2">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)]">
            Data context
          </h3>
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] divide-y divide-[var(--color-border)]">
            {sections.ouraRecovery && (
              <ContextRow icon={<Moon size={15} />} label="Recovery">
                {sections.ouraRecovery}
              </ContextRow>
            )}
            {sections.trainingTrend && (
              <ContextRow icon={<TrendingUp size={15} />} label="Training">
                {sections.trainingTrend}
              </ContextRow>
            )}
          </div>
        </section>
      )}
      {sections.watchOuts.length > 0 && (
        <section
          className="rounded-xl border p-3"
          style={{
            background: 'oklch(0.25 0.08 60 / 0.35)',
            borderColor: 'oklch(0.55 0.15 60 / 0.45)',
          }}
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle
              size={16}
              className="mt-0.5 shrink-0 text-[var(--color-accent)]"
            />
            <div className="min-w-0 space-y-1.5">
              <h3 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
                Watch
              </h3>
              <BulletList items={sections.watchOuts} />
            </div>
          </div>
        </section>
      )}
      <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] nums">
        {dateLabel}
      </p>
    </div>
  )
}

function ContextRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode
  label: string
  children: string
}) {
  return (
    <div className="flex items-start gap-2.5 p-3">
      <span className="mt-0.5 shrink-0 text-[var(--color-fg-faint)]">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-fg-faint)]">
          {label}
        </p>
        <p className="mt-0.5 leading-relaxed">{renderInline(children)}</p>
      </div>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="space-y-1">
      <h3 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)]">
        {title}
      </h3>
      {typeof children === 'string' ? (
        <p>{renderInline(children)}</p>
      ) : (
        children
      )}
    </section>
  )
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2">
          <span
            aria-hidden
            className="text-[var(--color-fg-faint)] flex-shrink-0"
          >
            •
          </span>
          <span>{renderInline(item)}</span>
        </li>
      ))}
    </ul>
  )
}
