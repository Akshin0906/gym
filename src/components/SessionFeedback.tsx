import { useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import type {
  PostWorkoutFeedbackV2,
  SessionPainImpact,
  SessionRpe,
  SliderValue,
} from '../db/types'
import { ErrorAlert } from './Feedback'

const PERFORMANCE_OPTIONS: ReadonlyArray<{
  value: SliderValue
  label: string
}> = [
  { value: 1, label: 'Far below' },
  { value: 2, label: 'Below' },
  { value: 3, label: 'As expected' },
  { value: 4, label: 'Above' },
  { value: 5, label: 'Far above' },
]

const SESSION_RPE_OPTIONS: ReadonlyArray<{
  value: SessionRpe
  label?: string
}> = [
  { value: 0, label: 'Rest' },
  { value: 1, label: 'Very, very easy' },
  { value: 2, label: 'Easy' },
  { value: 3, label: 'Moderate' },
  { value: 4, label: 'Somewhat hard' },
  { value: 5, label: 'Hard' },
  { value: 6 },
  { value: 7, label: 'Very hard' },
  { value: 8 },
  { value: 9, label: 'Near maximal' },
  { value: 10, label: 'Maximal' },
]

const PAIN_OPTIONS: ReadonlyArray<{
  value: SessionPainImpact
  label: string
}> = [
  { value: 'none', label: 'No — completed normally' },
  { value: 'present_no_effect', label: 'Yes — completed normally' },
  { value: 'modified', label: 'Yes — reduced or modified it' },
  { value: 'stopped', label: 'Yes — stopped an exercise or workout' },
]

interface Props {
  sessionName: string
  onSave: (answers: PostWorkoutFeedbackV2) => Promise<void>
  onSkip: () => void
}

export function SessionFeedback({ sessionName, onSave, onSkip }: Props) {
  const [performance, setPerformance] = useState<SliderValue | null>(null)
  const [sessionRpe, setSessionRpe] = useState<SessionRpe | null>(null)
  const [painImpact, setPainImpact] = useState<SessionPainImpact | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const complete =
    performance !== null && sessionRpe !== null && painImpact !== null

  async function handleSave() {
    if (!complete || saving) return
    setSaving(true)
    setError(null)
    try {
      await onSave({ version: 2, performance, sessionRpe, painImpact })
    } catch {
      setError(
        'Your workout is saved, but the check-in was not. Try again or skip it.',
      )
      setSaving(false)
    }
  }

  const selectedRpe = SESSION_RPE_OPTIONS.find(
    (option) => option.value === sessionRpe,
  )

  return (
    <div className="px-4 py-6 space-y-5 max-w-md mx-auto">
      <header className="space-y-1">
        <p className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)]">
          Post-workout check-in
        </p>
        <h2 className="text-2xl font-bold leading-tight">{sessionName}</h2>
        <p className="text-sm text-[var(--color-fg-faint)]">
          Three quick ratings help Coach compare performance, effort, and
          recovery needs. Answer all three or skip.
        </p>
      </header>

      <fieldset className="card p-4 space-y-3">
        <legend className="text-sm font-semibold px-1">
          Compared with what you expected today, how did you perform?
        </legend>
        <div className="grid grid-cols-5 gap-1.5">
          {PERFORMANCE_OPTIONS.map((option) => (
            <RadioChoice
              key={option.value}
              name="session-performance"
              value={String(option.value)}
              checked={performance === option.value}
              disabled={saving}
              onChange={() => {
                setPerformance(option.value)
                setError(null)
              }}
              ariaLabel={`${option.value} of 5 — ${option.label}`}
              className="min-h-14 px-1 text-[11px] leading-tight"
            >
              {option.label}
            </RadioChoice>
          ))}
        </div>
      </fieldset>

      <fieldset className="card p-4 space-y-3">
        <legend className="text-sm font-semibold px-1">
          How hard was this workout overall?
        </legend>
        <p className="text-xs text-[var(--color-fg-faint)]">
          Rate the whole session, not just the final set.
        </p>
        <div className="grid grid-cols-6 gap-1.5">
          {SESSION_RPE_OPTIONS.map((option) => (
            <RadioChoice
              key={option.value}
              name="session-rpe"
              value={String(option.value)}
              checked={sessionRpe === option.value}
              disabled={saving}
              onChange={() => {
                setSessionRpe(option.value)
                setError(null)
              }}
              ariaLabel={`${option.value} of 10${
                option.label ? ` — ${option.label}` : ''
              }`}
              className="min-h-11 px-1 text-sm nums"
            >
              {option.value}
            </RadioChoice>
          ))}
        </div>
        <p
          aria-live="polite"
          className="min-h-5 text-center text-sm font-medium text-[var(--color-fg)]"
        >
          {selectedRpe
            ? `${selectedRpe.value} / 10${
                selectedRpe.label ? ` · ${selectedRpe.label}` : ''
              }`
            : 'Choose 0–10'}
        </p>
        <p className="text-[11px] leading-relaxed text-center text-[var(--color-fg-faint)]">
          0 Rest · 3 Moderate · 5 Hard · 7 Very hard · 10 Maximal
        </p>
      </fieldset>

      <fieldset className="card p-4 space-y-3">
        <legend className="text-sm font-semibold px-1">
          Did you have pain or another physical problem during this workout?
        </legend>
        <p className="text-xs text-[var(--color-fg-faint)]">
          Don’t count normal effort or muscle burn.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {PAIN_OPTIONS.map((option) => (
            <RadioChoice
              key={option.value}
              name="pain-impact"
              value={option.value}
              checked={painImpact === option.value}
              disabled={saving}
              onChange={() => {
                setPainImpact(option.value)
                setError(null)
              }}
              ariaLabel={option.label}
              className="min-h-14 px-2 text-xs leading-snug"
            >
              {option.label}
            </RadioChoice>
          ))}
        </div>
      </fieldset>

      {error && <ErrorAlert message={error} />}

      <div className="space-y-3 pt-1">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!complete || saving}
          className="btn-primary w-full"
        >
          <CheckCircle2 size={18} />
          {saving ? 'Saving…' : 'Save check-in'}
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={saving}
          className="btn-ghost w-full justify-center text-sm"
        >
          Skip check-in
        </button>
      </div>
    </div>
  )
}

function RadioChoice({
  name,
  value,
  checked,
  disabled,
  onChange,
  ariaLabel,
  className,
  children,
}: {
  name: string
  value: string
  checked: boolean
  disabled: boolean
  onChange: () => void
  ariaLabel: string
  className: string
  children: string | number
}) {
  return (
    <label className="min-w-0 cursor-pointer">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={ariaLabel}
        className="peer sr-only"
      />
      <span
        className={`flex h-full items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-center text-[var(--color-fg-dim)] transition-colors peer-checked:border-[var(--color-accent)] peer-checked:bg-[var(--color-accent-soft)] peer-checked:text-[var(--color-fg)] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--color-accent)] peer-disabled:cursor-wait peer-disabled:opacity-60 ${className}`}
      >
        {children}
      </span>
    </label>
  )
}
