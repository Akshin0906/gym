import { useState } from 'react'
import { AlertTriangle, Check, HelpCircle } from 'lucide-react'
import type { UnfinishedWorkNoteV1, UnfinishedWorkReason } from '../db/types'
import { UNFINISHED_WORK_REASONS } from '../db/types'
import {
  UNFINISHED_WORK_REASON_LABELS,
} from '../lib/unfinishedWork'
import { LOAD_CONVENTION_SHORT_LABELS } from '../lib/measurement'
import type {
  ExerciseAttainment,
  SessionAttainment,
} from '../lib/plannedVsPerformed'

export function repTargetText(row: ExerciseAttainment): string {
  if (row.planKind === 'freestyle') return 'No plan'
  switch (row.repTargetSource) {
    case 'structured':
    case 'parsed_text':
      return row.repTarget === null
        ? 'No target'
        : row.repTarget.min === row.repTarget.max
          ? `${row.repTarget.min} reps`
          : `${row.repTarget.min}–${row.repTarget.max} reps`
    case 'unparseable_text':
      return 'Target not machine-readable'
    default:
      return 'No target recorded'
  }
}

export function setsText(row: ExerciseAttainment): string {
  const planned = row.plannedSets
  const working = row.workingSets
  const warmup = row.warmupSets > 0 ? ` + ${row.warmupSets} warm-up` : ''
  if (planned === null) return `${working} logged${warmup} (unplanned)`
  return `${working} of ${planned} planned${warmup}`
}

// Deliberately says "not logged", never "skipped": the app cannot tell a set
// that was not performed from one that was performed and never recorded.
export function unfinishedText(row: ExerciseAttainment): string | null {
  if (row.unfinishedSets === null || row.unfinishedSets === 0) return null
  return `${row.unfinishedSets} planned set${row.unfinishedSets === 1 ? '' : 's'} not logged`
}

function repBreakdown(row: ExerciseAttainment): string | null {
  if (row.workingSets === 0) return null
  if (row.repTarget === null) return null
  const parts: string[] = []
  if (row.setsInRepRange > 0) parts.push(`${row.setsInRepRange} in range`)
  if (row.setsBelowMinReps > 0) {
    parts.push(`${row.setsBelowMinReps} below minimum`)
  }
  if (row.setsAboveMaxReps > 0) parts.push(`${row.setsAboveMaxReps} above max`)
  return parts.length > 0 ? parts.join(' · ') : null
}

export function SessionAttainmentCard({
  attainment,
  unfinishedWork,
  canRecordReason,
  onSelectReason,
}: {
  attainment: SessionAttainment
  unfinishedWork: UnfinishedWorkNoteV1 | null | undefined
  canRecordReason: boolean
  onSelectReason: (reason: UnfinishedWorkReason | null) => Promise<void>
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasUnfinished = (attainment.unfinishedSetTotal ?? 0) > 0

  async function choose(reason: UnfinishedWorkReason | null) {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await onSelectReason(reason)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="card p-4 space-y-3">
      <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)]">
        Planned vs performed
      </h2>

      <p className="text-sm text-[var(--color-fg-dim)]">
        {attainment.plannedSetTotal === null ? (
          <>
            {attainment.workingSetTotal} working set
            {attainment.workingSetTotal === 1 ? '' : 's'} logged. This session
            had no planned targets.
          </>
        ) : (
          <>
            <span className="text-[var(--color-fg)] font-semibold nums">
              {attainment.workingSetTotal} of {attainment.plannedSetTotal}
            </span>{' '}
            planned working sets logged
            {attainment.warmupSetTotal > 0 &&
              `, plus ${attainment.warmupSetTotal} warm-up`}
            {attainment.unstartedExerciseCount > 0 &&
              ` · ${attainment.unstartedExerciseCount} planned exercise${
                attainment.unstartedExerciseCount === 1 ? '' : 's'
              } with no logged set`}
            .
          </>
        )}
      </p>

      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full text-sm border-collapse">
          <caption className="sr-only">
            Planned versus performed sets and rep-target attainment for each
            exercise in this session
          </caption>
          <thead>
            <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-[var(--color-fg-faint)]">
              <th scope="col" className="py-1.5 pr-3 font-bold">
                Exercise
              </th>
              <th scope="col" className="py-1.5 pr-3 font-bold">
                Sets
              </th>
              <th scope="col" className="py-1.5 font-bold">
                Rep target
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {attainment.exercises.map((row) => {
              const breakdown = repBreakdown(row)
              const unfinished = unfinishedText(row)
              return (
                <tr key={row.exerciseId} className="align-top">
                  <th
                    scope="row"
                    className="py-2 pr-3 font-medium text-left text-[var(--color-fg)]"
                  >
                    {row.exerciseName}
                    {!row.loadConventionRecorded && row.loggedSets > 0 && (
                      <span className="block text-[10px] font-normal text-[var(--color-fg-faint)]">
                        Load unit not recorded (read as lb)
                      </span>
                    )}
                    {row.loadConventionRecorded && (
                      <span className="block text-[10px] font-normal text-[var(--color-fg-faint)]">
                        {LOAD_CONVENTION_SHORT_LABELS[row.loadConvention]}
                      </span>
                    )}
                  </th>
                  <td className="py-2 pr-3 nums text-[var(--color-fg-dim)]">
                    {setsText(row)}
                    {unfinished && (
                      <span className="block text-[11px] text-[var(--color-fg-faint)]">
                        {unfinished}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-[var(--color-fg-dim)]">
                    {repTargetText(row)}
                    {breakdown && (
                      <span className="block text-[11px] nums text-[var(--color-fg-faint)]">
                        {breakdown}
                      </span>
                    )}
                    {row.setsWithoutRepTarget > 0 && row.repTarget === null && (
                      <span className="block text-[11px] text-[var(--color-fg-faint)]">
                        {row.setsWithoutRepTarget} set
                        {row.setsWithoutRepTarget === 1 ? '' : 's'} with nothing
                        to compare against
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {hasUnfinished && canRecordReason && (
        <fieldset className="pt-1 space-y-2">
          <legend className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] flex items-center gap-1.5">
            <HelpCircle size={12} aria-hidden />
            Anything worth noting? (optional)
          </legend>
          <p className="text-[11px] text-[var(--color-fg-faint)]">
            Context only. Sets that were performed but not logged are common —
            this never changes your logged history.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {UNFINISHED_WORK_REASONS.map((reason) => {
              const selected = unfinishedWork?.reason === reason
              return (
                <button
                  key={reason}
                  type="button"
                  disabled={saving}
                  aria-pressed={selected}
                  onClick={() => void choose(selected ? null : reason)}
                  className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                    selected
                      ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-surface-2)]'
                      : 'border-[var(--color-border)] text-[var(--color-fg-dim)] hover:bg-[var(--color-surface-2)]'
                  }`}
                >
                  {selected && (
                    <Check size={11} className="inline-block mr-1 -mt-0.5" />
                  )}
                  {UNFINISHED_WORK_REASON_LABELS[reason]}
                </button>
              )
            })}
          </div>
          {error && (
            <p role="alert" className="text-xs text-red-400 flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
              {error}
            </p>
          )}
        </fieldset>
      )}
    </section>
  )
}
