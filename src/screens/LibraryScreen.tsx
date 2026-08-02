import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronRight, Eye, EyeOff, Plus, Search } from 'lucide-react'
import { Header, SettingsLink } from '../components/Header'
import { ErrorAlert } from '../components/Feedback'
import { ExerciseListSkeleton } from '../components/Skeleton'
import { listAllExercises } from '../db/repositories/exercises'
import type { Exercise, MuscleGroup } from '../db/types'
import { MUSCLE_LABEL, MUSCLE_ORDER } from '../lib/muscles'

type Filter = 'all' | MuscleGroup

export function LibraryScreen() {
  const navigate = useNavigate()
  const [exercises, setExercises] = useState<Exercise[] | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void listAllExercises()
      .then(setExercises)
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught))
        setExercises([])
      })
  }, [])

  const filtered = useMemo(() => {
    if (!exercises) return []
    const q = query.trim().toLowerCase()
    return exercises.filter((e) => {
      if (filter !== 'all' && e.primaryMuscle !== filter) return false
      if (q && !e.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [exercises, query, filter])

  const visible = filtered.filter((e) => !e.hiddenFromLibrary)
  const hidden = filtered.filter((e) => e.hiddenFromLibrary)

  return (
    <>
      <Header
        title="Library"
        subtitle={exercises ? `${exercises.length} exercises` : undefined}
        right={
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => navigate('/library/new')}
              className="btn-primary text-sm px-3 py-1.5"
              aria-label="Add exercise"
            >
              <Plus size={16} strokeWidth={2.5} />
              <span className="hidden sm:inline">Add</span>
            </button>
            <SettingsLink />
          </div>
        }
      />

      <div className="px-4 pt-3 pb-2 space-y-3 max-w-3xl mx-auto">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-fg-faint)] pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search exercises"
            className="field pl-9 text-sm"
          />
        </div>
        <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 pb-1">
          <Chip active={filter === 'all'} onClick={() => setFilter('all')}>
            All
          </Chip>
          {MUSCLE_ORDER.map((m) => (
            <Chip
              key={m}
              active={filter === m}
              onClick={() => setFilter(m)}
            >
              {MUSCLE_LABEL[m]}
            </Chip>
          ))}
        </div>
      </div>

      <div className="px-4 pb-8 max-w-3xl mx-auto">
        {error && <ErrorAlert message={error} />}
        {exercises === null ? (
          <ExerciseListSkeleton />
        ) : visible.length === 0 && hidden.length === 0 ? (
          <p className="text-[var(--color-fg-faint)] py-8 text-center">
            No matches.
          </p>
        ) : (
          <>
            <ExerciseGroup items={visible} />
            {hidden.length > 0 && (
              <details className="mt-6">
                <summary className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-[var(--color-fg-faint)] cursor-pointer">
                  <EyeOff size={14} /> Hidden ({hidden.length})
                </summary>
                <div className="mt-2 opacity-60">
                  <ExerciseGroup items={hidden} />
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 min-h-11 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
        active
          ? 'bg-[var(--color-fg)] text-[var(--color-bg)] border-[var(--color-fg)]'
          : 'bg-transparent text-[var(--color-fg-dim)] border-[var(--color-border)] hover:text-[var(--color-fg)] hover:border-[var(--color-fg-dim)]'
      }`}
    >
      {children}
    </button>
  )
}

function ExerciseGroup({ items }: { items: Exercise[] }) {
  const byMuscle = new Map<MuscleGroup, Exercise[]>()
  for (const m of MUSCLE_ORDER) byMuscle.set(m, [])
  for (const e of items) byMuscle.get(e.primaryMuscle)?.push(e)

  return (
    <>
      {MUSCLE_ORDER.map((m) => {
        const group = byMuscle.get(m) ?? []
        if (group.length === 0) return null
        return (
          <section key={m} className="mt-5">
            <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] mb-2 px-1">
              {MUSCLE_LABEL[m]}
            </h2>
            <ul className="card divide-y divide-[var(--color-border)] overflow-hidden">
              {group.map((e) => (
                <li key={e.id}>
                  <Link
                    to={`/library/${e.id}`}
                    className="block px-3 py-3 hover:bg-[var(--color-surface-2)]"
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate flex items-center gap-2">
                          {e.hiddenFromLibrary && (
                            <EyeOff
                              size={14}
                              className="text-[var(--color-fg-faint)] shrink-0"
                              aria-label="Hidden"
                            />
                          )}
                          {!e.hiddenFromLibrary && e.isCustom && (
                            <Eye
                              size={14}
                              className="text-[var(--color-accent)] shrink-0"
                              aria-hidden
                            />
                          )}
                          <span className="truncate">{e.name}</span>
                          {e.isCustom && (
                            <span className="text-[10px] uppercase tracking-widest text-[var(--color-fg-faint)] shrink-0">
                              custom
                            </span>
                          )}
                        </div>
                        {e.secondaryMuscles.length > 0 && (
                          <div className="text-xs text-[var(--color-fg-faint)] mt-0.5">
                            {e.secondaryMuscles
                              .map((sm) => MUSCLE_LABEL[sm])
                              .join(' · ')}
                          </div>
                        )}
                      </div>
                      <ChevronRight
                        size={16}
                        className="text-[var(--color-fg-faint)] shrink-0"
                      />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </>
  )
}
