import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { BarChart3, Check, Eye, EyeOff } from 'lucide-react'
import { Header } from '../components/Header'
import {
  createCustomExercise,
  getExercise,
  updateExercise,
  type ExerciseInput,
} from '../db/repositories/exercises'
import type { Exercise, MuscleGroup } from '../db/types'
import {
  MUSCLE_LABEL,
  MUSCLE_ORDER,
  normalizeSecondaryMuscles,
} from '../lib/muscles'
import { MAX_REST_SECONDS, MIN_REST_SECONDS } from '../lib/restTimer'

const DEFAULT_INPUT: ExerciseInput = {
  name: '',
  primaryMuscle: 'chest',
  secondaryMuscles: [],
  notes: '',
  defaultRestSeconds: 120,
  hiddenFromLibrary: false,
}

export function ExerciseEditScreen() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const isNew = id === undefined
  const [existing, setExisting] = useState<Exercise | null>(null)
  const [input, setInput] = useState<ExerciseInput>(DEFAULT_INPUT)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setExisting(null)
    setError(null)
    setSaving(false)
    if (isNew) {
      setInput({ ...DEFAULT_INPUT, secondaryMuscles: [] })
      setLoading(false)
      return
    }
    setLoading(true)
    void getExercise(id!).then((e) => {
      if (cancelled) return
      if (!e) {
        setError('Exercise not found')
      } else {
        setExisting(e)
        setInput({
          name: e.name,
          primaryMuscle: e.primaryMuscle,
          secondaryMuscles: e.secondaryMuscles,
          notes: e.notes,
          defaultRestSeconds: e.defaultRestSeconds,
          hiddenFromLibrary: e.hiddenFromLibrary,
        })
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [id, isNew])

  async function handleSave() {
    if (saving) return
    if (!isNew && !existing) {
      setError('Exercise not found')
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (isNew) await createCustomExercise(input)
      else await updateExercise(id!, input)
      navigate('/library')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  function toggleHidden() {
    if (!existing) return
    // Stage the change like every other field; handleSave persists it. Writing
    // immediately here would partially save while discarding unsaved edits.
    setInput((prev) => ({ ...prev, hiddenFromLibrary: !prev.hiddenFromLibrary }))
  }

  function toggleSecondary(m: MuscleGroup) {
    setInput((prev) => ({
      ...prev,
      secondaryMuscles: normalizeSecondaryMuscles(
        prev.primaryMuscle,
        prev.secondaryMuscles.includes(m)
          ? prev.secondaryMuscles.filter((x) => x !== m)
          : [...prev.secondaryMuscles, m],
      ),
    }))
  }

  if (!isNew && !loading && !existing) {
    return (
      <>
        <Header title="Exercise not found" back="/library" />
        <div className="px-4 py-10 text-center max-w-md mx-auto">
          <p className="text-sm text-[var(--color-fg-dim)]">
            This exercise does not exist or is no longer available.
          </p>
          <Link to="/library" className="btn-primary mt-5 inline-flex">
            Back to Library
          </Link>
        </div>
      </>
    )
  }

  return (
    <>
      <Header
        title={isNew ? 'New exercise' : 'Edit exercise'}
        back="/library"
        right={
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading}
            className="btn-primary text-sm px-3 py-1.5"
          >
            <Check size={16} strokeWidth={2.5} />
            {saving ? 'Saving' : 'Save'}
          </button>
        }
      />

      {loading ? (
        <p className="p-6 text-[var(--color-fg-faint)] text-center">Loading…</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleSave()
          }}
          className="px-4 py-4 space-y-5 max-w-md mx-auto"
        >
          <Field label="Name">
            <input
              type="text"
              value={input.name}
              onChange={(e) => setInput({ ...input, name: e.target.value })}
              required
              className="field"
            />
          </Field>

          <Field label="Primary muscle">
            <select
              value={input.primaryMuscle}
              onChange={(e) => {
                const primaryMuscle = e.target.value as MuscleGroup
                setInput((prev) => ({
                  ...prev,
                  primaryMuscle,
                  secondaryMuscles: normalizeSecondaryMuscles(
                    primaryMuscle,
                    prev.secondaryMuscles,
                  ),
                }))
              }}
              className="field"
            >
              {MUSCLE_ORDER.map((m) => (
                <option key={m} value={m}>
                  {MUSCLE_LABEL[m]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Secondary muscles">
            <div className="flex flex-wrap gap-1.5">
              {MUSCLE_ORDER.filter((m) => m !== input.primaryMuscle).map(
                (m) => {
                  const on = input.secondaryMuscles.includes(m)
                  return (
                    <button
                      type="button"
                      key={m}
                      onClick={() => toggleSecondary(m)}
                      aria-pressed={on}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                        on
                          ? 'bg-[var(--color-accent)] text-[oklch(0.18_0.04_50)] border-[var(--color-accent)]'
                          : 'bg-transparent text-[var(--color-fg-dim)] border-[var(--color-border)] hover:text-[var(--color-fg)]'
                      }`}
                    >
                      {MUSCLE_LABEL[m]}
                    </button>
                  )
                },
              )}
            </div>
          </Field>

          <Field label="Notes (machine settings, form cues)">
            <textarea
              value={input.notes}
              onChange={(e) => setInput({ ...input, notes: e.target.value })}
              rows={4}
              className="field"
            />
          </Field>

          <Field label="Default rest (seconds)">
            <input
              type="number"
              min={MIN_REST_SECONDS}
              max={MAX_REST_SECONDS}
              step={1}
              value={input.defaultRestSeconds}
              onChange={(e) =>
                setInput({
                  ...input,
                  defaultRestSeconds: Number(e.target.value) || 0,
                })
              }
              className="field nums"
            />
          </Field>

          {!isNew && existing && (
            <div className="pt-3 border-t border-[var(--color-border)] space-y-3">
              <Link
                to={`/library/${existing.id}/history`}
                className="w-full px-3 py-3 card-tight flex items-center justify-between hover:bg-[var(--color-surface-2)]"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <BarChart3 size={16} className="text-[var(--color-accent)]" />
                  Complete set history
                </span>
                <span className="text-xs text-[var(--color-accent)] font-semibold">
                  View
                </span>
              </Link>
              <button
                type="button"
                onClick={toggleHidden}
                className="w-full px-3 py-3 card-tight flex items-center justify-between hover:bg-[var(--color-surface-2)]"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {input.hiddenFromLibrary ? (
                    <EyeOff size={16} className="text-[var(--color-fg-faint)]" />
                  ) : (
                    <Eye size={16} className="text-[var(--color-accent)]" />
                  )}
                  {input.hiddenFromLibrary
                    ? 'Hidden from pickers'
                    : 'Visible in pickers'}
                </span>
                <span className="text-xs text-[var(--color-accent)] font-semibold">
                  {input.hiddenFromLibrary ? 'Unhide' : 'Hide'}
                </span>
              </button>
              <p className="text-xs text-[var(--color-fg-faint)] mt-2 px-1">
                Hidden exercises don't appear when adding to a program or
                workout. Their history is preserved.
              </p>
            </div>
          )}

          {error && (
            <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </form>
      )}
    </>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="block text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] mb-1.5">
        {label}
      </span>
      {children}
    </label>
  )
}
