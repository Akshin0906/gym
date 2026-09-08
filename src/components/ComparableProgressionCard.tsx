import { format } from 'date-fns'
import { LOAD_CONVENTION_SHORT_LABELS } from '../lib/measurement'
import type { ComparableProgression } from '../lib/plannedVsPerformed'

function targetText(progression: ComparableProgression): string {
  if (progression.repTarget === null) return 'no machine-readable rep target'
  return progression.repTarget.min === progression.repTarget.max
    ? `${progression.repTarget.min} reps`
    : `${progression.repTarget.min}–${progression.repTarget.max} reps`
}

// Only sessions that are genuinely like-for-like are charted, and the card says
// out loud how many were left out and why. A silently filtered trend reads as
// "no progress" when the real answer is "these are not the same measurement".
export function ComparableProgressionCard({
  progression,
}: {
  progression: ComparableProgression
}) {
  const unit = LOAD_CONVENTION_SHORT_LABELS[progression.loadConvention]

  return (
    <section className="card p-4 space-y-3">
      <div>
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)]">
          Comparable sessions
        </h2>
        <p className="mt-1 text-xs text-[var(--color-fg-dim)]">
          Same exercise, same load measurement ({unit}), {targetText(progression)}.
        </p>
      </div>

      {progression.points.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-dim)]">
          No two sessions of this exercise are directly comparable yet.
        </p>
      ) : (
        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full text-sm border-collapse">
            <caption className="sr-only">
              Progression across comparable sessions for this exercise
            </caption>
            <thead>
              <tr className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-fg-faint)]">
                <th scope="col" className="text-left py-1.5 pr-3 font-bold">
                  Session
                </th>
                <th scope="col" className="text-right py-1.5 px-2 font-bold">
                  Top set
                </th>
                <th scope="col" className="text-right py-1.5 px-2 font-bold">
                  Est 1RM
                </th>
                <th scope="col" className="text-right py-1.5 pl-2 font-bold">
                  Sets
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {progression.points.map((point) => (
                <tr key={point.sessionId} className="nums">
                  <th
                    scope="row"
                    className="text-left py-2 pr-3 font-normal text-[var(--color-fg-dim)] whitespace-nowrap"
                  >
                    {format(point.completedAt, 'MMM d')}
                  </th>
                  <td className="text-right py-2 px-2">
                    {point.topSetWeightLbs === null
                      ? '—'
                      : `${point.topSetWeightLbs} × ${point.topSetReps ?? '—'}`}
                  </td>
                  <td className="text-right py-2 px-2">
                    {point.bestEstimated1RM === null
                      ? 'n/a'
                      : point.bestEstimated1RM}
                  </td>
                  <td className="text-right py-2 pl-2">
                    {point.plannedSets === null
                      ? point.workingSets
                      : `${point.workingSets}/${point.plannedSets}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {progression.excludedSessionCount > 0 && (
        <p className="text-[11px] text-[var(--color-fg-faint)]">
          {progression.excludedSessionCount} other session
          {progression.excludedSessionCount === 1 ? '' : 's'} left out:
          {progression.excludedReasons.repTarget > 0 &&
            ` ${progression.excludedReasons.repTarget} used a different rep target`}
          {progression.excludedReasons.repTarget > 0 &&
            progression.excludedReasons.loadConvention > 0 &&
            ','}
          {progression.excludedReasons.loadConvention > 0 &&
            ` ${progression.excludedReasons.loadConvention} used a different load measurement`}
          .
        </p>
      )}
      {progression.loadConvention === 'unknown' && (
        <p className="text-[11px] text-[var(--color-fg-faint)]">
          No load unit was recorded for these sets, so pounds are assumed.
        </p>
      )}
    </section>
  )
}
