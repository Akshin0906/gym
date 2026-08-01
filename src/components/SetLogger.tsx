import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Pencil, Sparkles, Timer, Trash2, X } from 'lucide-react'
import {
  deleteSet,
  logSet,
  restoreSet,
  updateSet,
} from '../db/repositories/sessions'
import { vibrate } from '../lib/audio'
import type { LoggedSet } from '../db/types'
import { Toast, type ToastNotice } from './Feedback'

interface Props {
  sessionId: string
  exerciseId: string
  existingSets: LoggedSet[]
  previousSets: LoggedSet[]
  defaultRestSeconds: number
  onChange: () => void
  onStartRest?: (seconds: number) => void
  // Fires only on a newly logged set, with that set's number (== the exercise's
  // set count after the insert). Lets the parent auto-collapse at target.
  onSetLogged?: (loggedSetNumber: number) => void
}

export function SetLogger({
  sessionId,
  exerciseId,
  existingSets,
  previousSets,
  defaultRestSeconds,
  onChange,
  onStartRest,
  onSetLogged,
}: Props) {
  const [recentPrId, setRecentPrId] = useState<string | null>(null)
  // Holds the just-deleted set so the Undo toast can re-insert it.
  const [undo, setUndo] = useState<{ notice: ToastNotice; set: LoggedSet } | null>(
    null,
  )

  // Clear the PR flash after its animation completes.
  useEffect(() => {
    if (!recentPrId) return
    const t = window.setTimeout(() => setRecentPrId(null), 6000)
    return () => window.clearTimeout(t)
  }, [recentPrId])

  const handleDelete = useCallback(
    async (set: LoggedSet) => {
      await deleteSet(set.id)
      onChange()
      setUndo({ notice: { id: set.loggedAt, message: 'Set deleted' }, set })
    },
    [onChange],
  )

  const handleUndo = useCallback(async () => {
    if (!undo) return
    await restoreSet(undo.set)
    setUndo(null)
    onChange()
  }, [undo, onChange])

  return (
    <div className="space-y-3">
      {previousSets.length > 0 && (
        <div className="px-3 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
          <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)]">
            Last session
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm nums text-[var(--color-fg-dim)]">
            {previousSets.map((s) => (
              <span key={s.id}>
                <span className="text-[var(--color-fg)] font-semibold">
                  {s.weightLbs}
                </span>
                <span className="text-[var(--color-fg-faint)]">×</span>
                <span className="text-[var(--color-fg)] font-semibold">
                  {s.reps}
                </span>
                {s.rpe !== null && (
                  <span className="text-[var(--color-fg-faint)]"> @{s.rpe}</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {existingSets.length > 0 && (
        <ul className="space-y-1.5">
          {existingSets.map((s) => (
            <SetRow
              key={s.id}
              set={s}
              prFlash={s.id === recentPrId}
              onChange={onChange}
              onDelete={() => void handleDelete(s)}
            />
          ))}
        </ul>
      )}

      <NewSetRow
        sessionId={sessionId}
        exerciseId={exerciseId}
        nextSetNumber={
          existingSets.length
            ? Math.max(...existingSets.map((s) => s.setNumber)) + 1
            : 1
        }
        previousSet={existingSets.at(-1) ?? previousSets.at(-1) ?? null}
        defaultRestSeconds={defaultRestSeconds}
        onLogged={(setId, isPR, setNumber) => {
          if (isPR) setRecentPrId(setId)
          onChange()
          onSetLogged?.(setNumber)
        }}
        onStartRest={onStartRest}
      />

      <Toast
        notice={undo?.notice ?? null}
        onDismiss={() => setUndo(null)}
        action={undo ? { label: 'Undo', onClick: () => void handleUndo() } : undefined}
        durationMs={5000}
      />
    </div>
  )
}

function SetNumberBadge({ n }: { n: number }) {
  return (
    <div className="shrink-0 w-8 h-8 rounded-full bg-[var(--color-surface-2)] border border-[var(--color-border)] flex items-center justify-center text-sm font-bold nums text-[var(--color-fg-dim)]">
      {n}
    </div>
  )
}

function SetRow({
  set,
  prFlash,
  onChange,
  onDelete,
}: {
  set: LoggedSet
  prFlash: boolean
  onChange: () => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [w, setW] = useState(String(set.weightLbs))
  const [r, setR] = useState(String(set.reps))
  const [rpe, setRpe] = useState(set.rpe === null ? '' : String(set.rpe))
  const [error, setError] = useState<string | null>(null)

  // Swipe-to-delete state
  const [dragX, setDragX] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const startX = useRef<number | null>(null)
  const moved = useRef(false)
  const REVEAL_THRESHOLD = 80
  const MAX_REVEAL = 96

  const onPointerDown = (e: React.PointerEvent) => {
    if (editing) return
    startX.current = e.clientX
    moved.current = false
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (startX.current === null || editing) return
    const dx = e.clientX - startX.current
    if (Math.abs(dx) > 4) moved.current = true
    // Only allow leftward swipe (negative dx), clamp to -MAX_REVEAL.
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
  const onPointerCancel = onPointerUp

  const collapse = useCallback(() => {
    setRevealed(false)
    setDragX(0)
  }, [])

  async function save() {
    try {
      await updateSet(set.id, {
        weightLbs: Number(w),
        reps: Number(r),
        rpe: rpe === '' ? null : Number(rpe),
      })
      setEditing(false)
      setError(null)
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (editing) {
    return (
      <li className="rounded-xl bg-[var(--color-surface)] border border-[var(--color-accent)] p-3 space-y-2">
        <div className="flex items-center gap-2">
          <SetNumberBadge n={set.setNumber} />
          <NumField
            value={w}
            setValue={setW}
            placeholder="lb"
            ariaLabel="Weight in pounds"
          />
          <span className="text-[var(--color-fg-faint)]">×</span>
          <NumField
            value={r}
            setValue={setR}
            placeholder="reps"
            ariaLabel="Reps"
          />
          <NumField
            value={rpe}
            setValue={setRpe}
            placeholder="RPE"
            ariaLabel="RPE"
            optional
          />
        </div>
        {error && <p className="text-xs text-red-400 px-1">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void save()}
            className="btn-primary text-sm flex-1 py-2"
          >
            <Check size={16} /> Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="btn-ghost text-sm"
            aria-label="Cancel"
          >
            <X size={16} />
          </button>
        </div>
      </li>
    )
  }

  return (
    <li className="relative overflow-hidden rounded-xl">
      {/* Delete reveal layer */}
      <button
        type="button"
        aria-label="Delete set"
        aria-hidden={!revealed}
        tabIndex={revealed ? 0 : -1}
        onClick={onDelete}
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
      {/* Set row content (slides) */}
      <div
        className={`flex items-center gap-3 pl-2 pr-3 py-2 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] relative ${
          prFlash ? 'pr-flash' : ''
        }`}
        style={{
          transform: `translateX(${dragX}px)`,
          transition: startX.current === null ? 'transform 220ms cubic-bezier(0.3, 0.9, 0.4, 1.1)' : 'none',
          touchAction: 'pan-y',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
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
          }
        }}
      >
        <SetNumberBadge n={set.setNumber} />
        <div className="flex-1 nums">
          <span className="text-lg font-bold">{set.weightLbs}</span>
          <span className="text-[var(--color-fg-faint)] mx-1.5">×</span>
          <span className="text-lg font-bold">{set.reps}</span>
          {set.rpe !== null && (
            <span className="text-sm text-[var(--color-fg-faint)] ml-2">
              @{set.rpe}
            </span>
          )}
          {prFlash && (
            <span className="pr-pill ml-2">
              <Sparkles size={10} strokeWidth={2.5} /> PR
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setEditing(true)
          }}
          aria-label="Edit set"
          className="p-2 text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]"
        >
          <Pencil size={16} />
        </button>
      </div>
    </li>
  )
}

function NewSetRow({
  sessionId,
  exerciseId,
  nextSetNumber,
  previousSet,
  defaultRestSeconds,
  onLogged,
  onStartRest,
}: {
  sessionId: string
  exerciseId: string
  nextSetNumber: number
  previousSet: LoggedSet | null
  defaultRestSeconds: number
  onLogged: (setId: string, isPR: boolean, setNumber: number) => void
  onStartRest?: (seconds: number) => void
}) {
  const [w, setW] = useState(previousSet ? String(previousSet.weightLbs) : '')
  const [r, setR] = useState(previousSet ? String(previousSet.reps) : '')
  const [rpe, setRpe] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await logSet({
        sessionId,
        exerciseId,
        weightLbs: Number(w),
        reps: Number(r),
        rpe: rpe === '' ? null : Number(rpe),
      })
      // Light tactile confirmation that the set committed — the most frequent
      // in-gym action, otherwise silent.
      vibrate(10)
      setRpe('')
      onLogged(result.id, result.isPR, result.setNumber)
      // Rest timer does NOT auto-start on log — start it manually with the
      // Timer button below. (onStartRest is still wired to that button.)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className="rounded-xl bg-[var(--color-surface)] border border-dashed border-[var(--color-border)] p-3 space-y-3"
    >
      <div className="flex items-center gap-2">
        <SetNumberBadge n={nextSetNumber} />
        <NumField
          value={w}
          setValue={setW}
          placeholder="lb"
          ariaLabel="Weight in pounds"
        />
        <span className="text-[var(--color-fg-faint)]">×</span>
        <NumField
          value={r}
          setValue={setR}
          placeholder="reps"
          ariaLabel="Reps"
        />
        <NumField
          value={rpe}
          setValue={setRpe}
          placeholder="RPE"
          ariaLabel="RPE"
          optional
        />
      </div>
      {error && <p className="text-xs text-red-400 px-1">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="btn-primary flex-1 py-3 text-base"
        >
          <Check size={18} strokeWidth={2.5} /> Log set
        </button>
        {onStartRest && (
          <button
            type="button"
            onClick={() => onStartRest(defaultRestSeconds)}
            aria-label={`Start ${defaultRestSeconds}s rest`}
            className="btn-secondary text-sm px-3"
          >
            <Timer size={16} /> {defaultRestSeconds}s
          </button>
        )}
      </div>
    </form>
  )
}

function NumField({
  value,
  setValue,
  placeholder,
  ariaLabel,
  optional,
}: {
  value: string
  setValue: (s: string) => void
  placeholder: string
  ariaLabel: string
  optional?: boolean
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      required={!optional}
      className="field-inset flex-1 min-w-0 px-2 py-3 text-lg"
    />
  )
}
