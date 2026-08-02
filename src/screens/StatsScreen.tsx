import { useEffect, useMemo, useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Header, SettingsLink } from '../components/Header'
import { CountUp } from '../components/CountUp'
import { StatsCardSkeleton } from '../components/Skeleton'
import { listAllExercises } from '../db/repositories/exercises'
import { listAllSets } from '../db/repositories/sessions'
import type { Exercise, LoggedSet, MuscleGroup } from '../db/types'
import {
  buildWeeklyVolume,
  estimated1RM,
  lastNIsoWeeks,
} from '../lib/analytics'
import { MUSCLE_LABEL, MUSCLE_ORDER } from '../lib/muscles'
import {
  getDailyReadiness,
  getOuraToken,
  isOuraTokenExpired,
  ymd,
  type OuraDailyReadiness,
} from '../lib/oura'
import {
  format,
  isWithinInterval,
  parseISO,
  startOfDay,
  subDays,
} from 'date-fns'

const MUSCLE_COLORS: Record<MuscleGroup, string> = {
  chest: '#f87171',
  back: '#60a5fa',
  shoulders: '#fbbf24',
  biceps: '#a78bfa',
  triceps: '#f472b6',
  forearms: '#94a3b8',
  quads: '#34d399',
  hamstrings: '#22d3ee',
  glutes: '#fb923c',
  calves: '#a3e635',
  abs: '#e879f9',
  traps: '#facc15',
}

// Distinct hues for overlaid 1RM lines. Order keeps the most common picks
// (first eligible exercise) on the brand accent.
const LINE_COLORS = [
  'oklch(0.74 0.18 50)',
  '#60a5fa',
  '#34d399',
  '#a78bfa',
  '#f472b6',
  '#fbbf24',
  '#22d3ee',
  '#fb923c',
]

const MIN_DAYS_FOR_TREND = 3
const RECENT_WEEKS = 4
type TrendRow = { day: number } & Record<string, number>

function fmtVolume(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

export function StatsScreen() {
  const [allSets, setAllSets] = useState<LoggedSet[]>([])
  const [exMap, setExMap] = useState<Map<string, Exercise>>(new Map())
  const [eligibleExs, setEligibleExs] = useState<Exercise[]>([])
  const [selectedExIds, setSelectedExIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      const [sets, exs] = await Promise.all([listAllSets(), listAllExercises()])
      const m = new Map<string, Exercise>()
      for (const e of exs) m.set(e.id, e)
      setAllSets(sets)
      setExMap(m)
      // Count distinct training days per exercise — only those with 3+
      // qualify for the multi-select 1RM chart. Set logging often spans
      // multiple sets per day, so we de-dupe by startOfDay.
      const daysByEx = new Map<string, Set<number>>()
      for (const s of sets) {
        const day = startOfDay(s.loggedAt).getTime()
        let days = daysByEx.get(s.exerciseId)
        if (!days) {
          days = new Set()
          daysByEx.set(s.exerciseId, days)
        }
        days.add(day)
      }
      const eligible = exs
        .filter((e) => (daysByEx.get(e.id)?.size ?? 0) >= MIN_DAYS_FOR_TREND)
        .sort((a, b) => a.name.localeCompare(b.name))
      setEligibleExs(eligible)
      if (eligible.length > 0) setSelectedExIds(new Set([eligible[0].id]))
      setLoading(false)
    })()
  }, [])

  const trendData = useMemo<TrendRow[]>(() => {
    if (selectedExIds.size === 0) return []
    // Bucket by day, take the best (max) est-1RM for each (day, exercise).
    // Keys in each row are exercise IDs; <Line dataKey={id}> picks them up.
    const dayMap = new Map<number, Record<string, number>>()
    for (const s of allSets) {
      if (!selectedExIds.has(s.exerciseId)) continue
      const day = startOfDay(s.loggedAt).getTime()
      const e1 = Math.round(estimated1RM(s.weightLbs, s.reps))
      let row = dayMap.get(day)
      if (!row) {
        row = {}
        dayMap.set(day, row)
      }
      if ((row[s.exerciseId] ?? 0) < e1) row[s.exerciseId] = e1
    }
    return Array.from(dayMap.entries())
      .map(([day, values]) => ({ day, ...values }) as TrendRow)
      .sort((a, b) => a.day - b.day)
  }, [allSets, selectedExIds])

  const selectedExs = useMemo(
    () => eligibleExs.filter((e) => selectedExIds.has(e.id)),
    [eligibleExs, selectedExIds],
  )

  function toggleExercise(id: string) {
    setSelectedExIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const volumeWeeks = useMemo(
    // Contiguous last-N ISO weeks (gaps shown as 0) rather than the last N weeks
    // that contain data, so a layoff/deload reads as a dip instead of vanishing.
    () => lastNIsoWeeks(buildWeeklyVolume(allSets, exMap), RECENT_WEEKS),
    [allSets, exMap],
  )

  const tableMuscles = useMemo(() => {
    const present = new Set<MuscleGroup>()
    for (const row of volumeWeeks) {
      for (const m of Object.keys(row.values) as MuscleGroup[]) {
        if ((row.values[m] ?? 0) > 0) present.add(m)
      }
    }
    return MUSCLE_ORDER.filter((m) => present.has(m))
  }, [volumeWeeks])

  const summary = useMemo(() => {
    const now = new Date()
    const weekAgo = subDays(now, 7)
    const inWeek = allSets.filter((s) =>
      isWithinInterval(s.loggedAt, { start: weekAgo, end: now }),
    )
    const volume7d = inWeek.reduce((sum, s) => sum + s.weightLbs * s.reps, 0)
    const sessions7d = new Set(inWeek.map((s) => s.workoutSessionId)).size
    const sets7d = inWeek.length
    return { volume7d, sessions7d, sets7d }
  }, [allSets])

  if (loading) {
    return (
      <>
        <Header title="Stats" right={<SettingsLink />} />
        <div className="px-4 py-4 grid grid-cols-3 gap-2">
          <StatsCardSkeleton />
          <StatsCardSkeleton />
          <StatsCardSkeleton />
        </div>
      </>
    )
  }

  return (
    <>
      <Header title="Stats" right={<SettingsLink />} />
      <div className="px-4 py-4 space-y-8">
        <section>
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] mb-2 px-1">
            Last 7 days
          </h2>
          <div className="grid grid-cols-3 gap-2">
            <SummaryCard
              label="Sessions"
              value={summary.sessions7d}
            />
            <SummaryCard
              label="Sets"
              value={summary.sets7d}
            />
            <SummaryCard
              label="Volume"
              value={summary.volume7d}
              suffix=" lb·reps"
              format={(n) => n.toLocaleString()}
            />
          </div>
        </section>

        <RecoverySection />

        <section className="space-y-3">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
            Estimated 1RM
          </h2>
          {eligibleExs.length === 0 ? (
            <p className="text-sm text-[var(--color-fg-faint)] p-4 text-center card">
              No exercises with {MIN_DAYS_FOR_TREND}+ days of data yet.
            </p>
          ) : (
            <>
              <div className="card p-1 max-h-44 overflow-y-auto">
                <ul className="space-y-0.5">
                  {eligibleExs.map((e, i) => {
                    const checked = selectedExIds.has(e.id)
                    const colorIdx = selectedExs.findIndex((s) => s.id === e.id)
                    const swatchColor =
                      colorIdx >= 0
                        ? LINE_COLORS[colorIdx % LINE_COLORS.length]
                        : 'transparent'
                    return (
                      <li key={e.id}>
                        <label
                          className="flex items-center gap-2.5 px-2.5 py-2 rounded-md cursor-pointer hover:bg-[var(--color-surface-2)]"
                          htmlFor={`ex-${i}`}
                        >
                          <input
                            id={`ex-${i}`}
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleExercise(e.id)}
                            className="w-4 h-4 accent-[var(--color-accent)] cursor-pointer"
                          />
                          <span
                            aria-hidden
                            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                            style={{
                              background: swatchColor,
                              border:
                                colorIdx >= 0
                                  ? 'none'
                                  : '1px dashed var(--color-border)',
                            }}
                          />
                          <span className="text-sm flex-1 truncate">
                            {e.name}
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </div>
              <div className="card p-2">
                {selectedExs.length === 0 || trendData.length === 0 ? (
                  <p className="text-sm text-[var(--color-fg-faint)] p-4 text-center">
                    Select one or more exercises to see progression.
                  </p>
                ) : (
                  <>
                    <ResponsiveContainer width="100%" height={240}>
                      <LineChart
                        data={trendData}
                        margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                      >
                        <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
                        <XAxis
                          dataKey="day"
                          type="number"
                          domain={['dataMin', 'dataMax']}
                          tickFormatter={(t) => format(t, 'M/d')}
                          stroke="#737373"
                          fontSize={11}
                          interval="preserveStartEnd"
                          minTickGap={28}
                        />
                        <YAxis
                          stroke="#737373"
                          fontSize={11}
                          width={40}
                          domain={['auto', 'auto']}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: '#171717',
                            border: '1px solid #404040',
                            borderRadius: 4,
                            fontSize: 12,
                          }}
                          labelFormatter={(t) =>
                            format(t as number, 'MMM d, yyyy')
                          }
                          formatter={(v: number) => [`${v} lb`, undefined]}
                        />
                        {selectedExs.length > 1 && (
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                        )}
                        {selectedExs.map((ex, i) => (
                          <Line
                            key={ex.id}
                            type="monotone"
                            dataKey={ex.id}
                            name={ex.name}
                            stroke={LINE_COLORS[i % LINE_COLORS.length]}
                            strokeWidth={2}
                            dot={{ r: 3 }}
                            connectNulls
                            isAnimationActive={false}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                    <table className="sr-only">
                      <caption>Estimated one-rep max trend data</caption>
                      <thead>
                        <tr>
                          <th>Date</th>
                          {selectedExs.map((exercise) => (
                            <th key={exercise.id}>{exercise.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {trendData.map((row) => (
                          <tr key={row.day}>
                            <td>{format(row.day, 'MMM d, yyyy')}</td>
                            {selectedExs.map((exercise) => (
                              <td key={exercise.id}>
                                {row[exercise.id] === undefined
                                  ? 'No data'
                                  : `${row[exercise.id]} pounds`}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </div>
            </>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
            Weekly volume per muscle
          </h2>
          <div className="card overflow-x-auto">
            {volumeWeeks.length === 0 || tableMuscles.length === 0 ? (
              <p className="text-sm text-[var(--color-fg-faint)] p-4 text-center">
                No data.
              </p>
            ) : (
              <table className="w-full text-sm border-collapse">
                <caption className="sr-only">
                  Weekly lifting volume in pound-repetitions by muscle group
                </caption>
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 bg-[var(--color-surface)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--color-fg-faint)] py-2 pl-3 pr-2">
                      Muscle
                    </th>
                    {volumeWeeks.map((w) => (
                      <th
                        key={w.weekKey}
                        className="nums text-right text-[11px] font-bold uppercase tracking-wider text-[var(--color-fg-faint)] py-2 px-3 whitespace-nowrap"
                      >
                        {format(w.weekStart, 'M/d')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableMuscles.map((m) => (
                    <tr key={m} className="border-t border-[var(--color-border)]">
                      <th
                        scope="row"
                        className="sticky left-0 z-10 bg-[var(--color-surface)] text-left font-normal py-2 pl-3 pr-2 whitespace-nowrap"
                      >
                        <span className="inline-flex items-center gap-2">
                          <span
                            aria-hidden
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ background: MUSCLE_COLORS[m] }}
                          />
                          {MUSCLE_LABEL[m]}
                        </span>
                      </th>
                      {volumeWeeks.map((w) => {
                        const v = w.values[m] ?? 0
                        return (
                          <td
                            key={w.weekKey}
                            className="nums text-right py-2 px-3"
                          >
                            {v > 0 ? (
                              fmtVolume(v)
                            ) : (
                              <span className="text-[var(--color-fg-faint)]">
                                –
                              </span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-[var(--color-border)]">
                    <th
                      scope="row"
                      className="sticky left-0 z-10 bg-[var(--color-surface)] text-left font-semibold py-2 pl-3 pr-2"
                    >
                      Total
                    </th>
                    {volumeWeeks.map((w) => {
                      const total = tableMuscles.reduce(
                        (sum, m) => sum + (w.values[m] ?? 0),
                        0,
                      )
                      return (
                        <td
                          key={w.weekKey}
                          className="nums text-right py-2 px-3 font-semibold"
                        >
                          {fmtVolume(total)}
                        </td>
                      )
                    })}
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
          <p className="text-[11px] text-[var(--color-fg-faint)] px-1">
            Volume in lb·reps. Secondary muscles receive 50% credit.
          </p>
        </section>
      </div>
    </>
  )
}

function RecoverySection() {
  const [readiness, setReadiness] = useState<OuraDailyReadiness[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const connected = !!getOuraToken() && !isOuraTokenExpired()

  useEffect(() => {
    if (!connected) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const end = new Date()
    const start = subDays(end, 9)
    void getDailyReadiness(ymd(start), ymd(end))
      .then((data) => {
        if (cancelled) return
        setReadiness(
          [...data].sort((a, b) => a.day.localeCompare(b.day)),
        )
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [connected])

  if (!getOuraToken()) return null

  return (
    <section className="space-y-3">
      <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
        Recovery
      </h2>
      <div className="card p-2">
        {!connected ? (
          <p className="text-sm text-[var(--color-fg-faint)] p-4 text-center">
            Oura token expired — reconnect in Settings.
          </p>
        ) : error ? (
          <p className="text-sm text-red-400 p-4 text-center">{error}</p>
        ) : loading || readiness === null ? (
          <p className="text-sm text-[var(--color-fg-faint)] p-4 text-center">
            Loading readiness…
          </p>
        ) : readiness.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-faint)] p-4 text-center">
            No readiness data in last 10 days.
          </p>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart
                data={readiness}
                margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              >
                <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
                <XAxis
                  dataKey="day"
                  tickFormatter={(d) => format(parseISO(d as string), 'M/d')}
                  stroke="#737373"
                  fontSize={11}
                  interval="preserveStartEnd"
                  minTickGap={28}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 25, 50, 75, 100]}
                  stroke="#737373"
                  fontSize={11}
                  width={32}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#171717',
                    border: '1px solid #404040',
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                  labelFormatter={(d) =>
                    format(parseISO(d as string), 'MMM d, yyyy')
                  }
                  formatter={(v) => [
                    v === null || v === undefined ? '—' : (v as number),
                    'readiness',
                  ]}
                />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="oklch(0.74 0.18 50)"
                  strokeWidth={2}
                  dot={{ r: 3, fill: 'oklch(0.74 0.18 50)' }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
            <table className="sr-only">
              <caption>Oura readiness trend data</caption>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Readiness score</th>
                </tr>
              </thead>
              <tbody>
                {readiness.map((day) => (
                  <tr key={day.day}>
                    <td>{format(parseISO(day.day), 'MMM d, yyyy')}</td>
                    <td>{day.score ?? 'No score'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </section>
  )
}

function SummaryCard({
  label,
  value,
  suffix,
  format,
}: {
  label: string
  value: number
  suffix?: string
  format?: (n: number) => string
}) {
  return (
    <div className="card p-3">
      <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)]">
        {label}
      </div>
      <div className="text-lg font-bold nums mt-1">
        <CountUp value={value} format={format} />
        {suffix && (
          <span className="text-xs font-medium text-[var(--color-fg-faint)] ml-0.5">
            {suffix}
          </span>
        )}
      </div>
    </div>
  )
}
