import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
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
  const recoveryStale =
    latest.sections.recoveryStatus === 'stale' ||
    latest.sections.recoveryStatus === 'unavailable'
  const dotColor = MODE_COLOR[latest.mode]
  const dateLabel = briefingDateLabel(latest)

  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-3 flex-1 text-left min-w-0"
          aria-expanded={expanded}
        >
          <span
            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ background: dotColor }}
            aria-label={`mode: ${latest.mode}`}
          />
          <span className="text-sm font-medium truncate flex-1">
            {renderInline(latest.headline)}
          </span>
          {recoveryStale && (
            <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] nums">
              Stale
            </span>
          )}
          {briefingStale && (
            <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] nums">
              {latest.briefingDate}
            </span>
          )}
          <ChevronDown
            size={14}
            className={`text-[var(--color-fg-faint)] transition-transform flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
      </div>
      {expanded && (
        <BriefingSections
          sections={latest.sections}
          dateLabel={dateLabel}
        />
      )}
    </div>
  )
}

function briefingDateLabel(briefing: DailyBriefing): string {
  const base = `${briefing.briefingDate} briefing`
  if (!briefing.snapshotUpdatedAt) return base

  const dataDate = pacificDate(new Date(briefing.snapshotUpdatedAt))
  if (!dataDate || dataDate === briefing.briefingDate) return base

  return `${base} - data ${dataDate}`
}

function BriefingSections({
  sections,
  dateLabel,
}: {
  sections: DailyBriefingSections
  dateLabel: string
}) {
  return (
    <div className="px-4 pb-3 pt-1 space-y-3 text-sm text-[var(--color-fg-dim)]">
      <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] nums">
        {dateLabel}
      </p>
      <Section title="Action">{sections.todaysCall}</Section>
      {sections.why.length > 0 && (
        <Section title="Signals">
          <BulletList items={sections.why} />
        </Section>
      )}
      {sections.ouraRecovery && (
        <Section title="Recovery">{sections.ouraRecovery}</Section>
      )}
      {sections.trainingTrend && (
        <Section title="Trend">{sections.trainingTrend}</Section>
      )}
      {sections.watchOuts.length > 0 && (
        <Section title="Guardrails">
          <BulletList items={sections.watchOuts} />
        </Section>
      )}
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
