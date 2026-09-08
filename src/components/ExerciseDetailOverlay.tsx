import { useEffect, useRef, useState } from 'react'
import { BarChart3, ChevronDown, ChevronLeft } from 'lucide-react'
import { Link } from 'react-router'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { format } from 'date-fns'
import { ExercisePickerSheet } from './ExercisePickerSheet'
import { getExercise } from '../db/repositories/exercises'
import {
  type ExerciseE1RMTrend,
  getLastSessionSetsForExercise,
  getRecentSessionE1RMsForExercise,
  swapExerciseInSession,
} from '../db/repositories/sessions'
import type { Exercise, LoggedSet } from '../db/types'
import {
  estimated1RMForLoad,
  oneRepMaxEstimateNotes,
  setVolumeForLoad,
} from '../lib/analytics'
import {
  LOAD_CONVENTION_SHORT_LABELS,
  commonLoadConvention,
  loadSemantics,
  resolveSetLoadConvention,
  setKindOf,
} from '../lib/measurement'
import { relativeOrAbsolute } from '../lib/dates'
import { MUSCLE_LABEL } from '../lib/muscles'
import { AccessibleDialog } from './AccessibleDialog'

// Why there is no chart. "Need a couple more sessions" is wrong and misleading
// for a measurement that has no one-rep-max estimate at all: more assisted
// pull-up sessions will never produce one, and telling somebody to keep
// training for a number that cannot exist is worse than saying nothing.
export function estimateUnavailableReason(trend: ExerciseE1RMTrend): string {
  if (trend.mixedConventionSessionCount > 0 && trend.points.length === 0) {
    return 'Sets in these sessions were recorded in different units, so there is no single estimate to chart. Record the load the same way to compare them.'
  }
  if (trend.excludedNoEstimateSessionCount > 0 && trend.points.length === 0) {
    return 'This exercise records assistance, a machine setting, or added weight rather than the total weight lifted, so a one-rep-max estimate is not defined for it. Compare reps at the same setting instead — more sessions will not change that.'
  }
  if (trend.excludedOtherConventionSessionCount > 0) {
    return 'Earlier sessions recorded load a different way, so they are not joined to this one. A couple more sessions recorded the current way will chart a trend.'
  }
  return 'Need a couple more sessions to chart progress.'
}

interface Props {
  exerciseId: string
  currentSessionId: string
  sessionExerciseIds: string[]
  onClose: () => void
  onSwapped: () => void
}

interface Data {
  exercise: Exercise
  lastSets: LoggedSet[]
  trend: ExerciseE1RMTrend
}

export function ExerciseDetailOverlay({
  exerciseId,
  currentSessionId,
  sessionExerciseIds,
  onClose,
  onSwapped,
}: Props) {
  const [data, setData] = useState<Data | null>(null)
  const [lastExpanded, setLastExpanded] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      getExercise(exerciseId),
      getLastSessionSetsForExercise(exerciseId, currentSessionId),
      getRecentSessionE1RMsForExercise(exerciseId, currentSessionId, 10),
    ]).then(([exercise, lastSets, trend]) => {
      if (cancelled) return
      if (!exercise) {
        onClose()
        return
      }
      setData({ exercise, lastSets, trend })
    })
    return () => {
      cancelled = true
    }
  }, [exerciseId, currentSessionId, onClose])

  async function handlePick(toExerciseId: string) {
    setError(null)
    try {
      await swapExerciseInSession(currentSessionId, exerciseId, toExerciseId)
      setPickerOpen(false)
      onSwapped()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPickerOpen(false)
    }
  }

  if (!data) {
    return (
      <AccessibleDialog
        open
        onClose={onClose}
        labelledBy="exercise-detail-loading-title"
        closeOnBackdrop={false}
        className="w-full h-full"
        style={{ background: 'var(--color-bg)' }}
      >
        <h1 id="exercise-detail-loading-title" className="sr-only">
          Exercise details
        </h1>
        <p className="p-6 text-center text-[var(--color-fg-faint)]">Loading…</p>
      </AccessibleDialog>
    )
  }

  const { exercise, lastSets, trend } = data
  const points = trend.points
  const lastDate = lastSets[0]?.loggedAt ?? null
  // The heaviest WORKING set, ranked with each set's own frozen convention. The
  // previous version ranked by a raw Epley on every row, so a warm-up single
  // could win and a machine pin number or an assistance weight was scored as
  // if it were pounds on a bar.
  const lastWorkingSets = lastSets.filter((s) => setKindOf(s) === 'working')
  const lastConvention = commonLoadConvention(lastWorkingSets)
  let topSet: LoggedSet | null = null
  let topE1 = 0
  let topByLoad: LoggedSet | null = null
  for (const s of lastWorkingSets) {
    const convention = resolveSetLoadConvention(s)
    const e = estimated1RMForLoad(s.weightLbs, s.reps, convention)
    if (e !== null && e > topE1) {
      topE1 = e
      topSet = s
    }
    // Fallback ordering for loads with no valid estimate: the hardest recorded
    // setting, which for assistance means the LOWEST number.
    if (topByLoad === null) {
      topByLoad = s
    } else if (
      loadSemantics(convention).higherIsHarder
        ? s.weightLbs > topByLoad.weightLbs ||
          (s.weightLbs === topByLoad.weightLbs && s.reps > topByLoad.reps)
        : s.weightLbs < topByLoad.weightLbs ||
          (s.weightLbs === topByLoad.weightLbs && s.reps > topByLoad.reps)
    ) {
      topByLoad = s
    }
  }
  const headlineSet = topSet ?? topByLoad
  // Tonnage only where the recorded number is a real external load, and only
  // when the whole session measured the same thing.
  let totalVol: number | null = 0
  for (const s of lastWorkingSets) {
    if (totalVol === null) break
    const v: number | null = setVolumeForLoad(
      s.weightLbs,
      s.reps,
      resolveSetLoadConvention(s),
    )
    totalVol = v === null ? null : totalVol + v
  }
  if (lastConvention === null || lastWorkingSets.length === 0) totalVol = null
  const estimateNotes = oneRepMaxEstimateNotes(lastSets)
  const unitLabel =
    lastConvention === null ? null : LOAD_CONVENTION_SHORT_LABELS[lastConvention]

  return (
    <>
      <AccessibleDialog
        open
        onClose={onClose}
        labelledBy="exercise-detail-title"
        initialFocusRef={closeButtonRef}
        closeOnBackdrop={false}
        className="w-full h-full flex flex-col"
        style={{ background: 'var(--color-bg)' }}
      >
        <header
          className="flex items-center gap-2 px-3 py-3"
          style={{
            paddingTop: 'max(0.75rem, env(safe-area-inset-top, 0px))',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Back"
            className="-ml-1 p-1 text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          >
            <ChevronLeft size={24} strokeWidth={2} />
          </button>
          <div className="flex-1 min-w-0">
            <h1
              id="exercise-detail-title"
              className="text-lg font-semibold leading-tight truncate"
            >
              {exercise.name}
            </h1>
            <p className="text-xs text-[var(--color-fg-dim)] truncate mt-0.5">
              {MUSCLE_LABEL[exercise.primaryMuscle]}
              {exercise.secondaryMuscles.length > 0 && (
                <span>
                  {' · '}
                  {exercise.secondaryMuscles
                    .map((m) => MUSCLE_LABEL[m])
                    .join(', ')}
                </span>
              )}
            </p>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6 max-w-md mx-auto w-full">
          <section>
            <h3 className="text-xs font-bold uppercase tracking-widest text-[var(--color-fg-faint)] mb-2 px-1">
              Last workout
            </h3>
            {lastSets.length === 0 || !headlineSet ? (
              <p className="text-sm text-[var(--color-fg-dim)] px-1">
                {lastSets.length === 0
                  ? 'No prior sessions yet.'
                  : 'Last session logged warm-ups only.'}
              </p>
            ) : (
              <div className="card overflow-hidden">
                <button
                  type="button"
                  onClick={() => setLastExpanded((v) => !v)}
                  className="w-full px-4 py-3 flex items-center gap-3 text-left"
                  aria-expanded={lastExpanded}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">
                      {lastDate !== null && relativeOrAbsolute(lastDate)}
                    </p>
                    <p className="text-xs text-[var(--color-fg-dim)] nums mt-0.5">
                      top {headlineSet.weightLbs}
                      {unitLabel ? ` ${unitLabel}` : ''}×{headlineSet.reps}
                      {headlineSet.rpe !== null && ` @ RPE ${headlineSet.rpe}`}
                      {' · '}
                      {lastWorkingSets.length}{' '}
                      {lastWorkingSets.length === 1 ? 'working set' : 'working sets'}
                      {totalVol !== null && (
                        <>
                          {' · '}
                          {totalVol.toLocaleString()} lb·reps
                        </>
                      )}
                    </p>
                    {totalVol === null && (
                      <p className="text-[11px] text-[var(--color-fg-faint)] mt-0.5">
                        {lastConvention === null
                          ? 'Sets recorded in different units, so they are not summed.'
                          : 'This load is not a weight lifted, so tonnage is not shown.'}
                      </p>
                    )}
                  </div>
                  <ChevronDown
                    size={16}
                    className={`text-[var(--color-fg-faint)] transition-transform ${lastExpanded ? 'rotate-180' : ''}`}
                  />
                </button>
                {lastExpanded && (
                  <ul className="px-4 pb-3 pt-1 space-y-1.5 text-sm border-t border-[var(--color-border)]">
                    {lastSets.map((s, i) => (
                      <li
                        key={s.id}
                        className="flex items-baseline gap-3 pt-2"
                      >
                        <span className="text-[var(--color-fg-faint)] w-6 text-right tabular-nums text-xs">
                          {i + 1}
                        </span>
                        <span className="nums">
                          <span className="font-semibold">
                            {s.weightLbs}
                          </span>
                          {' × '}
                          <span className="font-semibold">{s.reps}</span>
                          {s.rpe !== null && (
                            <span className="text-[var(--color-fg-dim)]">
                              {' @ RPE '}
                              {s.rpe}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section>
            <h3 className="text-xs font-bold uppercase tracking-widest text-[var(--color-fg-faint)] mb-2 px-1">
              Estimated 1RM
              {points.length > 0 && ` · last ${Math.min(points.length, 10)}`}
            </h3>
            {points.length < 2 ? (
              <p className="text-sm text-[var(--color-fg-dim)] px-1">
                {estimateUnavailableReason(trend)}
              </p>
            ) : (
              <div className="card p-3" style={{ height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={points}
                    margin={{ top: 8, right: 12, bottom: 0, left: -10 }}
                  >
                    <CartesianGrid
                      stroke="var(--color-border)"
                      strokeDasharray="3 3"
                    />
                    <XAxis
                      dataKey="completedAt"
                      tickFormatter={(t) => format(t as number, 'M/d')}
                      stroke="var(--color-fg-faint)"
                      tick={{ fontSize: 11 }}
                      minTickGap={28}
                    />
                    <YAxis
                      stroke="var(--color-fg-faint)"
                      tick={{ fontSize: 11 }}
                      width={40}
                      domain={['auto', 'auto']}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--color-surface)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      labelFormatter={(t) =>
                        format(t as number, 'MMM d, yyyy')
                      }
                      formatter={(v: number) => [`${v} lb`, 'est 1RM']}
                    />
                    <Line
                      type="monotone"
                      dataKey="e1rm"
                      stroke="var(--color-accent)"
                      strokeWidth={2}
                      dot={{
                        r: 3,
                        strokeWidth: 0,
                        fill: 'var(--color-accent)',
                      }}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
                <table className="sr-only">
                  <caption>{exercise.name} estimated one-rep max history</caption>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Estimated one-rep max</th>
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((point) => (
                      <tr key={point.completedAt}>
                        <td>{format(point.completedAt, 'MMM d, yyyy')}</td>
                        <td>{point.e1rm} pounds</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {points.length >= 2 && (
              <p className="text-[11px] text-[var(--color-fg-faint)] mt-2 px-1">
                Estimated from load and reps only — it does not know how hard a
                set felt
                {estimateNotes.manyRepsExtrapolatedFrom &&
                  ', and high-rep sets stretch the estimate furthest'}
                {estimateNotes.noSetEffortRecorded && '; no set RPE was recorded'}
                . It describes recorded work, not recovery or fatigue.
                {trend.excludedOtherConventionSessionCount > 0 && (
                  <>
                    {' '}
                    {trend.excludedOtherConventionSessionCount}{' '}
                    {trend.excludedOtherConventionSessionCount === 1
                      ? 'session was'
                      : 'sessions were'}{' '}
                    left out because they recorded load a different way; there is
                    no conversion between them.
                  </>
                )}
                {trend.includesAssumedUnits &&
                  ' Older sets have no recorded unit and are read as total pounds.'}
              </p>
            )}
          </section>

          <section>
            <Link
              to={`/library/${exercise.id}/history`}
              className="w-full btn-secondary py-3 text-sm font-semibold justify-center mb-2"
            >
              <BarChart3 size={16} /> View complete set history
            </Link>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="w-full btn-primary py-3 text-sm font-semibold justify-center"
            >
              Swap exercise for this session
            </button>
            <p className="text-xs text-[var(--color-fg-faint)] mt-2 px-1">
              Only this workout changes. Targets and position carry over, and
              logged sets remain attached to the original exercise.
            </p>
            {error && (
              <p className="text-sm text-red-400 mt-2" role="alert">
                {error}
              </p>
            )}
          </section>
        </div>
      </AccessibleDialog>

      <ExercisePickerSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(id) => void handlePick(id)}
        excludeIds={sessionExerciseIds}
        title="Swap to"
        defaultMuscle={exercise.primaryMuscle}
      />
    </>
  )
}
