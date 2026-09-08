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
import { LoadFailure } from '../components/Feedback'
import { StatsCardSkeleton } from '../components/Skeleton'
import { listAllExercises } from '../db/repositories/exercises'
import { listAllSets } from '../db/repositories/sessions'
import type {
  Exercise,
  LoadConvention,
  LoggedSet,
  MuscleGroup,
} from '../db/types'
import {
  buildWeeklySetCountsSplit,
  buildWeeklyTonnage,
  buildWeeklyVolume,
  estimated1RMForLoad,
  lastNIsoWeeks,
  summarizeTonnage,
} from '../lib/analytics'
import {
  countWorkingSets,
  loadConventionsComparableForProgression,
  resolveSetLoadConvention,
  setKindOf,
} from '../lib/measurement'
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
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    void (async () => {
      try {
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
      setLoadError(null)
      } catch (err) {
        // A rejected IndexedDB read previously left the skeleton up forever.
        setLoadError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [reloadToken])

  const trend = useMemo<{
    rows: TrendRow[]
    excludedOtherConventionSetCount: number
    excludedNoEstimateSetCount: number
    assumedUnitSetCount: number
  }>(() => {
    if (selectedExIds.size === 0) {
      return {
        rows: [],
        excludedOtherConventionSetCount: 0,
        excludedNoEstimateSetCount: 0,
        assumedUnitSetCount: 0,
      }
    }
    // One line per exercise measures ONE thing. An exercise whose recording
    // changed — 20 lb per dumbbell then 40 lb total — would otherwise draw a
    // doubling that never happened, so each exercise is anchored to how its
    // most recent working set was recorded and sets recorded another way are
    // excluded and counted. There is no conversion between conventions.
    // Anchored on the most recent working set, whether or not that set is
    // chartable: after a switch to machine or assisted work there is no valid
    // estimate at all, and falling back to an older convention would keep
    // drawing a line that no longer describes the exercise.
    const anchorByExercise = new Map<string, LoadConvention>()
    const newestByExercise = new Map<string, number>()
    for (const s of allSets) {
      if (!selectedExIds.has(s.exerciseId)) continue
      if (setKindOf(s) !== 'working') continue
      const seen = newestByExercise.get(s.exerciseId)
      if (seen === undefined || s.loggedAt >= seen) {
        newestByExercise.set(s.exerciseId, s.loggedAt)
        anchorByExercise.set(s.exerciseId, resolveSetLoadConvention(s))
      }
    }
    // Bucket by day, take the best (max) est-1RM for each (day, exercise).
    // Keys in each row are exercise IDs; <Line dataKey={id}> picks them up.
    const dayMap = new Map<number, Record<string, number>>()
    let excludedOtherConventionSetCount = 0
    let excludedNoEstimateSetCount = 0
    let assumedUnitSetCount = 0
    for (const s of allSets) {
      if (!selectedExIds.has(s.exerciseId)) continue
      const day = startOfDay(s.loggedAt).getTime()
      // Machine settings, assistance, and bodyweight-only loads have no valid
      // one-rep-max estimate, so they are left off the chart entirely.
      // Working sets only, read with the set's own frozen convention.
      if (setKindOf(s) !== 'working') continue
      const convention = resolveSetLoadConvention(s)
      const estimate = estimated1RMForLoad(s.weightLbs, s.reps, convention)
      if (estimate === null) {
        // A machine setting, an assistance weight, or added bodyweight. The
        // count exists so the chart can say why it is empty instead of
        // implying nothing was selected.
        excludedNoEstimateSetCount += 1
        continue
      }
      const anchor = anchorByExercise.get(s.exerciseId)
      if (anchor === undefined) continue
      // Strict equality: an unrecorded legacy load is never joined to a
      // recorded one to imply the number went up.
      if (!loadConventionsComparableForProgression(convention, anchor)) {
        excludedOtherConventionSetCount += 1
        continue
      }
      if (convention === 'unknown') assumedUnitSetCount += 1
      const e1 = Math.round(estimate)
      let row = dayMap.get(day)
      if (!row) {
        row = {}
        dayMap.set(day, row)
      }
      if ((row[s.exerciseId] ?? 0) < e1) row[s.exerciseId] = e1
    }
    return {
      rows: Array.from(dayMap.entries())
        .map(([day, values]) => ({ day, ...values }) as TrendRow)
        .sort((a, b) => a.day - b.day),
      excludedOtherConventionSetCount,
      excludedNoEstimateSetCount,
      assumedUnitSetCount,
    }
  }, [allSets, selectedExIds])
  const trendData = trend.rows

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

  const setCountWeeks = useMemo(
    () => buildWeeklySetCountsSplit(allSets, exMap),
    [allSets, exMap],
  )

  const tonnageWeeks = useMemo(() => {
    const byKey = new Map(
      buildWeeklyTonnage(allSets, exMap).map((row) => [row.weekKey, row]),
    )
    return volumeWeeks.map((week) => byKey.get(week.weekKey) ?? null)
  }, [allSets, exMap, volumeWeeks])

  const setCountMuscles = useMemo(() => {
    const present = new Set<MuscleGroup>()
    for (const row of setCountWeeks) {
      for (const m of Object.keys(row.direct) as MuscleGroup[]) present.add(m)
      for (const m of Object.keys(row.secondary) as MuscleGroup[]) present.add(m)
    }
    return MUSCLE_ORDER.filter((m) => present.has(m))
  }, [setCountWeeks])

  const recentSetCountWeeks = useMemo(() => {
    const byKey = new Map(setCountWeeks.map((row) => [row.weekKey, row]))
    return volumeWeeks.map(
      (week) =>
        byKey.get(week.weekKey) ?? {
          weekKey: week.weekKey,
          weekStart: week.weekStart,
          direct: {},
          secondary: {},
        },
    )
  }, [setCountWeeks, volumeWeeks])

  const summary = useMemo(() => {
    const now = new Date()
    const weekAgo = subDays(now, 7)
    const inWeek = allSets.filter((s) =>
      isWithinInterval(s.loggedAt, { start: weekAgo, end: now }),
    )
    const tonnage = summarizeTonnage(inWeek)
    const sessions7d = new Set(inWeek.map((s) => s.workoutSessionId)).size
    const workingSets7d = countWorkingSets(inWeek)
    const warmupSets7d = inWeek.length - workingSets7d
    return { tonnage, sessions7d, workingSets7d, warmupSets7d }
  }, [allSets])

  if (loadError) {
    return (
      <>
        <Header title="Stats" right={<SettingsLink />} />
        <LoadFailure
          message={`Could not load your training data: ${loadError}`}
          onRetry={() => {
            setLoading(true)
            setReloadToken((n) => n + 1)
          }}
        />
      </>
    )
  }

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
              label="Working sets"
              value={summary.workingSets7d}
            />
            <SummaryCard
              label="Volume"
              value={summary.tonnage.tonnage}
              suffix=" lb·reps"
              format={(n) => n.toLocaleString()}
            />
          </div>
          <p className="text-[11px] text-[var(--color-fg-faint)] px-1 mt-2">
            Volume counts each set once.
            {summary.warmupSets7d > 0 &&
              ` ${summary.warmupSets7d} warm-up set${summary.warmupSets7d === 1 ? '' : 's'} excluded from the set count.`}
            {summary.tonnage.excludedSets > 0 &&
              ` ${summary.tonnage.excludedSets} set${summary.tonnage.excludedSets === 1 ? '' : 's'} excluded from volume (recorded per dumbbell, as a machine setting, as assistance, or as added bodyweight).`}
            {summary.tonnage.assumedUnitSets > 0 &&
              ` ${summary.tonnage.assumedUnitSets} set${summary.tonnage.assumedUnitSets === 1 ? '' : 's'} assume pounds because no load unit was recorded.`}
          </p>
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
                    {selectedExs.length === 0
                      ? 'Select one or more exercises to see progression.'
                      : trend.excludedNoEstimateSetCount > 0
                        ? 'These sets record a machine setting, assistance, or added bodyweight rather than the weight lifted, so there is no one-rep-max estimate. Compare reps at the same setting instead.'
                        : 'No comparable sets yet for the selected exercises.'}
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
              <p className="text-[11px] text-[var(--color-fg-faint)] px-1">
                Estimated from load and reps only — it has no term for how hard
                a set felt, and it describes recorded work rather than recovery
                or fatigue.
                {trend.excludedOtherConventionSetCount > 0 &&
                  ` ${trend.excludedOtherConventionSetCount} set${trend.excludedOtherConventionSetCount === 1 ? '' : 's'} recorded a different way (per dumbbell, machine setting, assistance, added bodyweight, or no recorded unit) are left out; there is no conversion between them.`}
                {trend.assumedUnitSetCount > 0 &&
                  ` ${trend.assumedUnitSetCount} set${trend.assumedUnitSetCount === 1 ? '' : 's'} have no recorded unit and are read as total pounds.`}
              </p>
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
                  {/* Not the sum of the rows above. Adding the muscle rows
                      would count a compound lift's tonnage once for its primary
                      mover and again at 50% for every secondary. */}
                  <tr className="border-t border-[var(--color-border)]">
                    <th
                      scope="row"
                      className="sticky left-0 z-10 bg-[var(--color-surface)] text-left font-semibold py-2 pl-3 pr-2 whitespace-nowrap"
                    >
                      Total lifted
                    </th>
                    {tonnageWeeks.map((row, index) => (
                      <td
                        key={volumeWeeks[index].weekKey}
                        className="nums text-right py-2 px-3 font-semibold"
                      >
                        {fmtVolume(row?.tonnage ?? 0)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
          <p className="text-[11px] text-[var(--color-fg-faint)] px-1">
            Volume in lb·reps. Splitting a lift&rsquo;s pound-reps 100% to the
            primary mover and 50% to each secondary is bookkeeping, not a
            measured stimulus: there is no validated equivalence between a
            weighted pound-rep figure and muscle growth. Rows overlap;
            &ldquo;Total lifted&rdquo; counts each set once and is not the sum
            of the rows above. Tonnage is not a cross-exercise score of muscle
            growth.
            {tonnageWeeks.some((row) => (row?.excludedSets ?? 0) > 0) &&
              ' Sets recorded per dumbbell, as a machine setting, as assistance, or as added bodyweight are excluded, because those numbers are not a total weight lifted.'}
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
            Weekly working sets per muscle
          </h2>
          <div className="card overflow-x-auto">
            {setCountMuscles.length === 0 ? (
              <p className="text-sm text-[var(--color-fg-faint)] p-4 text-center">
                No data.
              </p>
            ) : (
              <table className="w-full text-sm border-collapse">
                <caption className="sr-only">
                  Weekly working-set counts by muscle group, shown as direct sets where
                  the muscle was the primary mover plus secondary sets
                </caption>
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 bg-[var(--color-surface)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--color-fg-faint)] py-2 pl-3 pr-2">
                      Muscle
                    </th>
                    {recentSetCountWeeks.map((w) => (
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
                  {setCountMuscles.map((m) => (
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
                      {recentSetCountWeeks.map((w) => {
                        const direct = w.direct[m] ?? 0
                        const secondary = w.secondary[m] ?? 0
                        return (
                          <td
                            key={w.weekKey}
                            className="nums text-right py-2 px-3 whitespace-nowrap"
                          >
                            {direct === 0 && secondary === 0 ? (
                              <span className="text-[var(--color-fg-faint)]">
                                –
                              </span>
                            ) : (
                              <>
                                {direct}
                                {secondary > 0 && (
                                  <span className="text-[var(--color-fg-faint)]">
                                    {' '}
                                    +{secondary}
                                  </span>
                                )}
                              </>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="text-[11px] text-[var(--color-fg-faint)] px-1">
            Working sets only — warm-ups are preparation, not training credit.
            Whole sets, counted once each: the first number is direct work where
            the muscle was the primary mover, the &ldquo;+n&rdquo; is sets where
            it was a listed secondary. The two are reported separately rather
            than blended into one weighted figure. A muscle being involved in a
            lift is not the same as that lift growing it.
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
