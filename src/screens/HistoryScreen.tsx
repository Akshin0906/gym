import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns'
import { Link } from 'react-router-dom'
import { Trash2 } from 'lucide-react'
import { ErrorAlert } from '../components/Feedback'
import { Header, SettingsLink } from '../components/Header'
import { HistoryListSkeleton } from '../components/Skeleton'
import { deleteSession, listSessionsDesc } from '../db/repositories/sessions'
import type { WorkoutSession } from '../db/types'
import { relativeOrAbsolute, shortDate } from '../lib/dates'
import { useActiveWorkout } from '../store/activeWorkout'
import { useTimer } from '../store/timer'

type View = 'list' | 'calendar'

export function HistoryScreen() {
  const [sessions, setSessions] = useState<WorkoutSession[] | null>(null)
  const [view, setView] = useState<View>('list')
  const [error, setError] = useState<string | null>(null)
  const { sessionId: activeSessionId, setActiveSession } = useActiveWorkout()
  const stopRest = useTimer((s) => s.stop)

  useEffect(() => {
    void listSessionsDesc()
      .then(setSessions)
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught))
        setSessions([])
      })
  }, [])

  const handleDelete = useCallback(
    async (id: string) => {
      setError(null)
      try {
        await deleteSession(id)
        if (activeSessionId === id) {
          stopRest()
          setActiveSession(null)
        }
        setSessions((prev) =>
          prev ? prev.filter((s) => s.id !== id) : prev,
        )
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [activeSessionId, setActiveSession, stopRest],
  )

  return (
    <>
      <Header
        title="History"
        right={
          <div className="flex items-center gap-1">
            <div
              className="flex bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-0.5"
              role="group"
              aria-label="History view"
            >
              <button
                type="button"
                onClick={() => setView('list')}
                aria-pressed={view === 'list'}
                className={`min-h-11 text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${
                  view === 'list'
                    ? 'bg-[var(--color-surface-2)] text-[var(--color-fg)]'
                    : 'text-[var(--color-fg-faint)]'
                }`}
              >
                List
              </button>
              <button
                type="button"
                onClick={() => setView('calendar')}
                aria-pressed={view === 'calendar'}
                className={`min-h-11 text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${
                  view === 'calendar'
                    ? 'bg-[var(--color-surface-2)] text-[var(--color-fg)]'
                    : 'text-[var(--color-fg-faint)]'
                }`}
              >
                Cal
              </button>
            </div>
            <SettingsLink />
          </div>
        }
      />

      {error && (
        <div className="px-4 pt-4 max-w-2xl mx-auto">
          <ErrorAlert message={error} />
        </div>
      )}

      {sessions === null ? (
        <HistoryListSkeleton />
      ) : sessions.length === 0 ? (
        <p className="p-6 text-[var(--color-fg-faint)] text-center">
          No workouts logged yet.
        </p>
      ) : view === 'list' ? (
        <ListView sessions={sessions} onDelete={handleDelete} />
      ) : (
        <CalendarView sessions={sessions} />
      )}
    </>
  )
}

function ListView({
  sessions,
  onDelete,
}: {
  sessions: WorkoutSession[]
  onDelete: (id: string) => Promise<void>
}) {
  return (
    <ul className="px-4 py-4 space-y-2 max-w-2xl mx-auto">
      {sessions.map((s) => (
        <SessionRow key={s.id} session={s} onDelete={onDelete} />
      ))}
    </ul>
  )
}

function SessionRow({
  session,
  onDelete,
}: {
  session: WorkoutSession
  onDelete: (id: string) => Promise<void>
}) {
  async function handleDeleteClick() {
    if (!confirm(`Delete workout "${session.name}"?`)) return
    await onDelete(session.id)
  }

  return (
    <li className="card-tight overflow-hidden flex items-stretch">
      <Link
        to={`/history/${session.id}`}
        className="min-h-14 min-w-0 flex-1 px-3 py-3 hover:bg-[var(--color-surface-2)]"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold truncate">{session.name}</span>
          {session.completedAt === null && (
            <span
              className="text-[10px] font-bold uppercase tracking-widest shrink-0 px-1.5 py-0.5 rounded"
              style={{
                color: 'oklch(0.18 0.04 50)',
                background: 'var(--color-accent)',
              }}
            >
              Live
            </span>
          )}
        </div>
        <div className="text-xs text-[var(--color-fg-faint)] mt-0.5">
          {relativeOrAbsolute(session.startedAt)}
          {session.programName && ` · ${session.programName}`}
        </div>
      </Link>
      <button
        type="button"
        aria-label={`Delete ${session.name}`}
        onClick={() => void handleDeleteClick()}
        className="min-h-11 min-w-11 px-3 grid place-items-center border-l border-[var(--color-border)] text-red-300 hover:bg-red-950/35"
      >
        <Trash2 size={17} aria-hidden="true" />
      </button>
    </li>
  )
}

function CalendarView({ sessions }: { sessions: WorkoutSession[] }) {
  const [month, setMonth] = useState(() => startOfMonth(Date.now()))

  const sessionsByDay = useMemo(() => {
    const map = new Map<string, WorkoutSession[]>()
    for (const s of sessions) {
      const key = format(s.startedAt, 'yyyy-MM-dd')
      const list = map.get(key) ?? []
      list.push(s)
      map.set(key, list)
    }
    return map
  }, [sessions])

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 })
    const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 })
    return eachDayOfInterval({ start, end })
  }, [month])

  const [selected, setSelected] = useState<Date | null>(null)
  const selectedKey = selected ? format(selected, 'yyyy-MM-dd') : null
  const selectedSessions = selectedKey
    ? sessionsByDay.get(selectedKey) ?? []
    : []

  return (
    <div className="px-2 sm:px-4 py-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={() => {
            setMonth(subMonths(month, 1))
            setSelected(null)
          }}
          className="btn-ghost min-h-11 min-w-11 p-1.5 justify-center"
          aria-label="Previous month"
        >
          ‹
        </button>
        <h2 className="text-base font-bold">{format(month, 'MMMM yyyy')}</h2>
        <button
          type="button"
          onClick={() => {
            setMonth(addMonths(month, 1))
            setSelected(null)
          }}
          className="btn-ghost min-h-11 min-w-11 p-1.5 justify-center"
          aria-label="Next month"
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold tracking-widest text-[var(--color-fg-faint)] mb-1">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <div key={i}>{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const key = format(d, 'yyyy-MM-dd')
          const hasSession = sessionsByDay.has(key)
          const inMonth = isSameMonth(d, month)
          const isSel = selected && isSameDay(d, selected)
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelected(d)}
              aria-label={`${format(d, 'EEEE, MMMM d')}${hasSession ? `, ${sessionsByDay.get(key)?.length ?? 0} workout${(sessionsByDay.get(key)?.length ?? 0) === 1 ? '' : 's'}` : ', no workouts'}`}
              aria-pressed={Boolean(isSel)}
              className={`min-h-11 flex flex-col items-center justify-center text-sm rounded-lg nums ${
                inMonth
                  ? 'text-[var(--color-fg)]'
                  : 'text-[var(--color-fg-faint)]/40'
              } ${isSel ? 'bg-[var(--color-surface-2)] border border-[var(--color-border)]' : ''} hover:bg-[var(--color-surface)]`}
            >
              <span>{format(d, 'd')}</span>
              {hasSession && (
                <span
                  className="block w-1.5 h-1.5 rounded-full mt-0.5"
                  style={{ background: 'var(--color-accent)' }}
                />
              )}
            </button>
          )
        })}
      </div>

      {selected && (
        <div className="mt-5">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] mb-2 px-1">
            {shortDate(selected.getTime())}
          </h3>
          {selectedSessions.length === 0 ? (
            <p className="text-sm text-[var(--color-fg-faint)]">No workouts.</p>
          ) : (
            <ul className="space-y-2">
              {selectedSessions.map((s) => (
                <li key={s.id}>
                  <Link
                    to={`/history/${s.id}`}
                    className="card-tight block px-3 py-3 hover:bg-[var(--color-surface-2)]"
                  >
                    <div className="font-semibold">{s.name}</div>
                    {s.programName && (
                      <div className="text-xs text-[var(--color-fg-faint)] mt-0.5">
                        {s.programName}
                      </div>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
