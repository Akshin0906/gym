import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ChevronDown, Moon, TrendingUp } from 'lucide-react'
import { db } from '../db/schema'
import { getLatestDailyBriefing } from '../db/repositories/dailyBriefings'
import type {
  DailyBriefing,
  DailyBriefingSections,
  RecommendationMode,
} from '../db/types'
import {
  fetchLatestCloudBriefing,
  isBriefingStale,
  pacificDate,
} from '../lib/cloud'

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
}

export function RecommendationBanner() {
  const [state, setState] = useState<State | null>(null)
  const [expanded, setExpanded] = useState(false)

  const load = useCallback(async () => {
    const [briefing, hasWorkouts] = await Promise.all([
      getLatestDailyBriefing(),
      db.workoutSessions
        .filter((s) => s.completedAt !== null)
        .count()
        .then((n) => n > 0),
    ])
    setState({ briefing: briefing ?? null, hasWorkouts })
  }, [])

  useEffect(() => {
    void load()
    void fetchLatestCloudBriefing()
      .then((briefing) => {
        if (briefing) {
          setState((prev) => ({
            briefing,
            hasWorkouts: prev?.hasWorkouts ?? true,
          }))
        }
      })
      .catch(() => {
        // Cached briefing remains visible when cloud fetch fails.
      })
    const onVis = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [load])

  if (state === null) return null
  if (!state.hasWorkouts) return null
  if (!state.briefing) return null

  const latest = state.briefing
  const briefingStale = isBriefingStale(latest.briefingDate)
  const dotColor = MODE_COLOR[latest.mode]
  const dateLabel = briefingDateLabel(latest)
  const recoveryLabel = recoveryStatusLabel(latest.sections.recoveryStatus)

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
            {recoveryLabel && (
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-fg-faint)]">
                {recoveryLabel}
              </span>
            )}
            {briefingStale && (
              <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-fg-faint)] nums">
                Briefing {displayDate(latest.briefingDate)}
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
      {expanded && (
        <BriefingSections
          sections={latest.sections}
          dateLabel={dateLabel}
        />
      )}
    </div>
  )
}

export function recoveryStatusLabel(
  status: DailyBriefingSections['recoveryStatus'],
): string | null {
  if (status === 'stale') return 'Oura stale'
  if (status === 'unavailable') return 'No Oura'
  return null
}

function displayDate(value: string): string {
  const parsed = new Date(`${value}T12:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parsed)
}

export function briefingDateLabel(briefing: DailyBriefing): string {
  const labels = [`${displayDate(briefing.briefingDate)} briefing`]
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
      labels.push(`workout data through ${displayDate(workoutDate)}`)
    }
  }

  if (briefing.snapshotUpdatedAt) {
    const snapshotDate = pacificDate(new Date(briefing.snapshotUpdatedAt))
    if (snapshotDate && snapshotDate !== briefing.briefingDate) {
      labels.push(`snapshot synced ${displayDate(snapshotDate)}`)
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
