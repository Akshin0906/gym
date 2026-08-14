import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import type { PerceivedRecoveryScore } from '../db/types'
import { ErrorAlert } from './Feedback'

const RECOVERY_OPTIONS: ReadonlyArray<{
  value: PerceivedRecoveryScore
  label?: string
}> = [
  { value: 0, label: 'Very poorly recovered / extremely tired' },
  { value: 1 },
  { value: 2, label: 'Not well recovered / somewhat tired' },
  { value: 3 },
  { value: 4, label: 'Somewhat recovered' },
  { value: 5, label: 'Adequately recovered' },
  { value: 6, label: 'Moderately recovered' },
  { value: 7 },
  { value: 8, label: 'Well recovered / somewhat energetic' },
  { value: 9 },
  { value: 10, label: 'Very well recovered / highly energetic' },
]

interface Props {
  sessionName: string
  onSave: (score: PerceivedRecoveryScore) => Promise<void>
  onSkip: () => Promise<void>
}

export function PreWorkoutCheckIn({ sessionName, onSave, onSkip }: Props) {
  const [score, setScore] = useState<PerceivedRecoveryScore | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = RECOVERY_OPTIONS.find((option) => option.value === score)

  async function persist(action: () => Promise<void>) {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await action()
    } catch {
      setError('The check-in was not saved. Try again.')
      setSaving(false)
    }
  }

  return (
    <div className="px-4 py-6 space-y-5 max-w-md mx-auto">
      <header className="space-y-1">
        <p className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)]">
          Pre-workout check-in
        </p>
        <h2 className="text-2xl font-bold leading-tight">{sessionName}</h2>
        <p className="text-sm text-[var(--color-fg-faint)]">
          Answer after a short warm-up and before your first work set.
        </p>
      </header>

      <fieldset className="card p-4 space-y-3">
        <legend className="text-sm font-semibold px-1">
          How recovered do you feel for today’s workout?
        </legend>
        <div className="grid grid-cols-6 gap-1.5">
          {RECOVERY_OPTIONS.map((option) => (
            <label key={option.value} className="min-w-0 cursor-pointer">
              <input
                type="radio"
                name="perceived-recovery"
                value={option.value}
                checked={score === option.value}
                disabled={saving}
                onChange={() => {
                  setScore(option.value)
                  setError(null)
                }}
                aria-label={`${option.value} of 10${
                  option.label ? ` — ${option.label}` : ''
                }`}
                className="peer sr-only"
              />
              <span className="flex min-h-11 h-full items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 text-center text-sm nums text-[var(--color-fg-dim)] transition-colors peer-checked:border-[var(--color-accent)] peer-checked:bg-[var(--color-accent-soft)] peer-checked:text-[var(--color-fg)] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--color-accent)] peer-disabled:cursor-wait peer-disabled:opacity-60">
                {option.value}
              </span>
            </label>
          ))}
        </div>
        <p
          aria-live="polite"
          className="min-h-10 text-center text-sm font-medium text-[var(--color-fg)]"
        >
          {selected
            ? `${selected.value} / 10${
                selected.label ? ` · ${selected.label}` : ''
              }`
            : 'Choose 0–10'}
        </p>
        <p className="text-[11px] leading-relaxed text-center text-[var(--color-fg-faint)]">
          0 Very poorly recovered · 5 Adequately recovered · 10 Very well
          recovered
        </p>
      </fieldset>

      {error && <ErrorAlert message={error} />}

      <div className="space-y-3 pt-1">
        <button
          type="button"
          onClick={() => {
            if (score !== null) void persist(() => onSave(score))
          }}
          disabled={score === null || saving}
          className="btn-primary w-full"
        >
          {saving ? 'Saving…' : 'Continue to workout'}
          {!saving && <ArrowRight size={18} />}
        </button>
        <button
          type="button"
          onClick={() => void persist(onSkip)}
          disabled={saving}
          className="btn-ghost w-full justify-center text-sm"
        >
          Skip check-in
        </button>
      </div>
    </div>
  )
}
