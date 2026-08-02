import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { Header } from '../components/Header'
import { getExercise } from '../db/repositories/exercises'
import {
  getAllSetsForExercise,
  getSession,
} from '../db/repositories/sessions'
import type { Exercise, LoggedSet, WorkoutSession } from '../db/types'
import { relativeOrAbsolute } from '../lib/dates'

interface HistoryGroup {
  session: WorkoutSession | null
  occurredAt: number
  sets: LoggedSet[]
}

export function ExerciseHistoryScreen() {
  const { id } = useParams<{ id: string }>()
  const [exercise, setExercise] = useState<Exercise | null>(null)
  const [groups, setGroups] = useState<HistoryGroup[] | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [newestFirst, setNewestFirst] = useState(true)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setExercise(null)
    setGroups(null)
    setNotFound(false)
    setNewestFirst(true)
    void (async () => {
      const [foundExercise, sets] = await Promise.all([
        getExercise(id),
        getAllSetsForExercise(id),
      ])
      if (cancelled) return
      if (!foundExercise) {
        setNotFound(true)
        return
      }

      const sessionIds = Array.from(
        new Set(sets.map((set) => set.workoutSessionId)),
      )
      const sessions = await Promise.all(
        sessionIds.map((sessionId) => getSession(sessionId)),
      )
      if (cancelled) return
      const sessionMap = new Map(
        sessions
          .filter((session): session is WorkoutSession => !!session)
          .map((session) => [session.id, session]),
      )
      const setsBySession = new Map<string, LoggedSet[]>()
      for (const set of sets) {
        const list = setsBySession.get(set.workoutSessionId) ?? []
        list.push(set)
        setsBySession.set(set.workoutSessionId, list)
      }
      const nextGroups = Array.from(setsBySession.entries()).map(
        ([sessionId, sessionSets]) => {
          const session = sessionMap.get(sessionId) ?? null
          const orderedSets = sessionSets.sort(
            (a, b) => a.setNumber - b.setNumber,
          )
          return {
            session,
            occurredAt:
              session?.completedAt ??
              session?.startedAt ??
              Math.max(...orderedSets.map((set) => set.loggedAt)),
            sets: orderedSets,
          }
        },
      )
      setExercise(foundExercise)
      setGroups(nextGroups)
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  const orderedGroups = useMemo(() => {
    if (!groups) return []
    return groups
      .slice()
      .sort((a, b) =>
        newestFirst ? b.occurredAt - a.occurredAt : a.occurredAt - b.occurredAt,
      )
  }, [groups, newestFirst])

  if (notFound) {
    return (
      <>
        <Header title="Exercise not found" back="/library" />
        <p className="p-6 text-center text-[var(--color-fg-dim)]">
          This exercise does not exist.
        </p>
      </>
    )
  }

  if (!exercise || groups === null) {
    return (
      <>
        <Header title="Exercise history" back="/library" />
        <p className="p-6 text-center text-[var(--color-fg-faint)]">Loading…</p>
      </>
    )
  }

  return (
    <>
      <Header
        title={exercise.name}
        subtitle="Complete set history"
        back={`/library/${exercise.id}`}
      />
      <div className="px-4 py-4 pb-8 space-y-4 max-w-2xl mx-auto">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-[var(--color-fg-dim)]">
            {groups.reduce((total, group) => total + group.sets.length, 0)} sets
            across {groups.length} {groups.length === 1 ? 'session' : 'sessions'}
          </p>
          <button
            type="button"
            onClick={() => setNewestFirst((current) => !current)}
            className="btn-secondary text-xs px-3 py-2"
            aria-label={`Sort ${newestFirst ? 'oldest' : 'newest'} first`}
          >
            {newestFirst ? <ArrowDown size={14} /> : <ArrowUp size={14} />}
            {newestFirst ? 'Newest' : 'Oldest'}
          </button>
        </div>

        {orderedGroups.length === 0 ? (
          <p className="card p-6 text-sm text-center text-[var(--color-fg-dim)]">
            No sets logged for this exercise yet.
          </p>
        ) : (
          orderedGroups.map((group, groupIndex) => (
            <section
              key={
                group.session?.id ??
                group.sets[0]?.workoutSessionId ??
                `orphan-${groupIndex}`
              }
              className="card overflow-hidden"
            >
              {group.session ? (
                <Link
                  to={`/history/${group.session.id}`}
                  className="px-4 py-3 flex items-center gap-3 hover:bg-[var(--color-surface-2)] border-b border-[var(--color-border)]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold block truncate">
                      {group.session.name}
                    </span>
                    <span className="text-xs text-[var(--color-fg-faint)]">
                      {relativeOrAbsolute(group.occurredAt)}
                      {group.session.programName && ` · ${group.session.programName}`}
                    </span>
                  </span>
                  <ChevronRight size={16} className="text-[var(--color-fg-faint)]" />
                </Link>
              ) : (
                <div className="px-4 py-3 border-b border-[var(--color-border)]">
                  <p className="font-semibold">Imported session</p>
                  <p className="text-xs text-[var(--color-fg-faint)]">
                    {relativeOrAbsolute(group.occurredAt)}
                  </p>
                </div>
              )}
              <table className="w-full text-sm">
                <thead className="text-[11px] uppercase tracking-wider text-[var(--color-fg-faint)]">
                  <tr>
                    <th className="text-left font-semibold px-4 py-2">Set</th>
                    <th className="text-right font-semibold px-2 py-2">Weight</th>
                    <th className="text-right font-semibold px-2 py-2">Reps</th>
                    <th className="text-right font-semibold px-4 py-2">RPE</th>
                  </tr>
                </thead>
                <tbody>
                  {group.sets.map((set) => (
                    <tr key={set.id} className="border-t border-[var(--color-border)] nums">
                      <td className="px-4 py-2.5">{set.setNumber}</td>
                      <td className="px-2 py-2.5 text-right">{set.weightLbs} lb</td>
                      <td className="px-2 py-2.5 text-right">{set.reps}</td>
                      <td className="px-4 py-2.5 text-right">{set.rpe ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))
        )}
      </div>
    </>
  )
}
