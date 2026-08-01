import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { getExercisesForPicker } from '../db/repositories/exercises'
import type { Exercise, MuscleGroup } from '../db/types'
import { MUSCLE_LABEL } from '../lib/muscles'

interface Props {
  open: boolean
  onClose: () => void
  onPick: (exerciseId: string) => void
  excludeIds?: string[]
  title?: string
  defaultMuscle?: MuscleGroup
}

type Snap = 'half' | 'full'
const HALF_VH = 0.5
const FULL_VH = 0.88
const DISMISS_THRESHOLD_VH = 0.18

export function ExercisePickerSheet({
  open,
  onClose,
  onPick,
  excludeIds,
  title,
  defaultMuscle,
}: Props) {
  const [exercises, setExercises] = useState<Exercise[] | null>(null)
  const [query, setQuery] = useState('')
  const [snap, setSnap] = useState<Snap>('half')
  const [dragOffset, setDragOffset] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const startY = useRef<number | null>(null)
  const dragging = useRef(false)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSnap('half')
    setDragOffset(0)
    setShowAll(false)
    void getExercisesForPicker().then(setExercises)
  }, [open])

  const filtered = useMemo(() => {
    if (!exercises) return []
    const q = query.trim().toLowerCase()
    const exclude = new Set(excludeIds ?? [])
    const applyMuscle = defaultMuscle && !showAll
    return exercises.filter((e) => {
      if (exclude.has(e.id)) return false
      if (applyMuscle && e.primaryMuscle !== defaultMuscle) return false
      if (q && !e.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [exercises, query, excludeIds, defaultMuscle, showAll])

  const sheetVh = snap === 'full' ? FULL_VH : HALF_VH

  const onHandlePointerDown = (e: React.PointerEvent) => {
    startY.current = e.clientY
    dragging.current = true
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onHandlePointerMove = (e: React.PointerEvent) => {
    if (startY.current === null || !dragging.current) return
    const dy = e.clientY - startY.current
    // Up = toward full (negative dy); down = toward dismiss
    setDragOffset(dy)
  }
  const onHandlePointerUp = () => {
    if (!dragging.current) return
    dragging.current = false
    const vh = window.innerHeight
    const dragVh = dragOffset / vh
    startY.current = null
    setDragOffset(0)
    if (dragVh > DISMISS_THRESHOLD_VH && snap === 'half') {
      onClose()
      return
    }
    if (dragVh < -0.06) {
      setSnap('full')
    } else if (dragVh > 0.06) {
      setSnap('half')
    }
  }

  if (!open) return null

  const baseHeight = `${sheetVh * 100}vh`
  const translateY = Math.max(0, dragOffset) // only follow downward drag

  return (
    <div
      className="fixed inset-0 z-50 flex items-end"
      style={{ background: 'oklch(0 0 0 / 0.62)' }}
      onClick={onClose}
    >
      <div
        className="w-full flex flex-col rounded-t-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-surface)',
          borderTop: '1px solid var(--color-border)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          height: baseHeight,
          transform: `translateY(${translateY}px)`,
          transition: dragging.current
            ? 'none'
            : 'transform 260ms cubic-bezier(0.3, 0.9, 0.4, 1.1), height 260ms cubic-bezier(0.3, 0.9, 0.4, 1.1)',
        }}
      >
        {/* Drag handle area */}
        <div
          className="pt-2 pb-1 flex justify-center cursor-grab active:cursor-grabbing"
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
          style={{ touchAction: 'none' }}
        >
          <span
            aria-hidden
            className="block w-10 h-1.5 rounded-full"
            style={{ background: 'var(--color-border)' }}
          />
        </div>
        <div className="flex items-center gap-3 px-4 pb-2">
          <h2 className="text-base font-bold flex-1">{title ?? 'Add exercise'}</h2>
          {defaultMuscle && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              aria-pressed={!showAll}
              className="text-xs font-medium px-2.5 py-1 rounded-full"
              style={{
                background: showAll
                  ? 'var(--color-surface-2)'
                  : 'oklch(0.32 0.08 250 / 0.4)',
                color: showAll
                  ? 'var(--color-fg-dim)'
                  : 'var(--color-accent)',
                border: '1px solid var(--color-border)',
              }}
            >
              {showAll ? 'All' : MUSCLE_LABEL[defaultMuscle]}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="btn-ghost p-1.5"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-4 pb-3 border-b border-[var(--color-border)]">
          <div className="relative">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-fg-faint)] pointer-events-none"
            />
            <input
              type="search"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setSnap('full')}
              placeholder="Search"
              className="field pl-9 text-sm"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {exercises === null ? (
            <p className="p-6 text-[var(--color-fg-faint)] text-sm text-center">
              Loading…
            </p>
          ) : filtered.length === 0 ? (
            <p className="p-6 text-[var(--color-fg-faint)] text-sm text-center">
              No matches.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {filtered.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => onPick(e.id)}
                    className="w-full text-left px-4 py-3 hover:bg-[var(--color-surface-2)]"
                  >
                    <div className="font-semibold">{e.name}</div>
                    <div className="text-xs text-[var(--color-fg-faint)] mt-0.5">
                      {MUSCLE_LABEL[e.primaryMuscle]}
                      {e.secondaryMuscles.length > 0 &&
                        ` · ${e.secondaryMuscles
                          .map((m) => MUSCLE_LABEL[m])
                          .join(', ')}`}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
