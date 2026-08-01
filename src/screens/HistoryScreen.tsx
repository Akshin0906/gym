import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { Link, useNavigate } from 'react-router-dom'
import { Trash2 } from 'lucide-react'
import { Header, SettingsLink } from '../components/Header'
import { HistoryListSkeleton } from '../components/Skeleton'
import { deleteSession, listSessionsDesc } from '../db/repositories/sessions'
import type { WorkoutSession } from '../db/types'
import { relativeOrAbsolute, shortDate } from '../lib/dates'
import { useActiveWorkout } from '../store/activeWorkout'

type View = 'list' | 'calendar'

export function HistoryScreen() {
  const [sessions, setSessions] = useState<WorkoutSession[] | null>(null)
  const [view, setView] = useState<View>('list')
  const { sessionId: activeSessionId, setActiveSession } = useActiveWorkout()

  useEffect(() => {
    void listSessionsDesc().then(setSessions)
  }, [])

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteSession(id)
      if (activeSessionId === id) setActiveSession(null)
      setSessions((prev) => (prev ? prev.filter((s) => s.id !== id) : prev))
    },
    [activeSessionId, setActiveSession],
  )

  return (
    <>
      <Header
        title="History"
        right={
          <div className="flex items-center gap-1">
            <div className="flex bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setView('list')}
                className={`text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${
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
                className={`text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${
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
    <ul className="px-4 py-4 space-y-2">
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
  const navigate = useNavigate()
  const [dragX, setDragX] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const startX = useRef<number | null>(null)
  const moved = useRef(false)
  const REVEAL_THRESHOLD = 80
  const MAX_REVEAL = 96

  const onPointerDown = (e: React.PointerEvent) => {
    startX.current = e.clientX
    moved.current = false
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (startX.current === null) return
    const dx = e.clientX - startX.current
    if (Math.abs(dx) > 4) moved.current = true
    const base = revealed ? -MAX_REVEAL : 0
    const next = Math.min(0, Math.max(-MAX_REVEAL, base + dx))
    setDragX(next)
  }
  const onPointerUp = () => {
    if (startX.current === null) return
    startX.current = null
    setRevealed(dragX <= -REVEAL_THRESHOLD)
    setDragX((d) => (d <= -REVEAL_THRESHOLD ? -MAX_REVEAL : 0))
  }
  const collapse = () => {
    setRevealed(false)
    setDragX(0)
  }

  async function handleDeleteClick() {
    if (!confirm('Delete this workout?')) {
      collapse()
      return
    }
    await onDelete(session.id)
  }

  return (
    <li className="relative overflow-hidden rounded-xl">
      <button
        type="button"
        aria-label="Delete workout"
        aria-hidden={!revealed}
        tabIndex={revealed ? 0 : -1}
        onClick={() => void handleDeleteClick()}
        className="absolute inset-y-0 right-0 flex items-center justify-center gap-1.5 px-4 font-semibold text-sm"
        style={{
          width: 96,
          background: 'oklch(0.45 0.18 25)',
          color: 'oklch(0.98 0.04 25)',
        }}
      >
        <Trash2 size={16} />
        Delete
      </button>
      <div
        className="card-tight px-3 py-3 hover:bg-[var(--color-surface-2)] relative"
        style={{
          transform: `translateX(${dragX}px)`,
          transition:
            startX.current === null
              ? 'transform 220ms cubic-bezier(0.3, 0.9, 0.4, 1.1)'
              : 'none',
          touchAction: 'pan-y',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={(e) => {
          if (revealed) {
            e.preventDefault()
            e.stopPropagation()
            collapse()
            return
          }
          if (moved.current) {
            e.preventDefault()
            e.stopPropagation()
            return
          }
          navigate(`/history/${session.id}`)
        }}
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
      </div>
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
    <div className="px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={() => setMonth(subMonths(month, 1))}
          className="btn-ghost p-1.5"
          aria-label="Previous month"
        >
          ‹
        </button>
        <h2 className="text-base font-bold">{format(month, 'MMMM yyyy')}</h2>
        <button
          type="button"
          onClick={() => setMonth(addMonths(month, 1))}
          className="btn-ghost p-1.5"
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
              className={`aspect-square flex flex-col items-center justify-center text-sm rounded-lg nums ${
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
