import { useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import type { SliderValue } from '../db/types'

const Q1_LABELS = [
  'Cut it short',
  'Much harder than expected',
  'As planned',
  'Easier than expected',
  'Better than expected',
] as const

const Q2_LABELS = ['Awful', 'Off', 'Neutral', 'Good', 'Great'] as const

interface Props {
  sessionName: string
  onSave: (answers: { planned: SliderValue; feel: SliderValue }) => void
  onSkip: () => void
}

export function SessionFeedback({ sessionName, onSave, onSkip }: Props) {
  const [planned, setPlanned] = useState<SliderValue>(3)
  const [feel, setFeel] = useState<SliderValue>(3)

  function handleSave() {
    onSave({ planned, feel })
  }

  return (
    <div className="px-4 py-6 space-y-6 max-w-md mx-auto">
      <header className="space-y-1">
        <p className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)]">
          Session check-in
        </p>
        <h2 className="text-2xl font-bold leading-tight">{sessionName}</h2>
        <p className="text-sm text-[var(--color-fg-faint)]">
          Optional — skip any time.
        </p>
      </header>

      <FeedbackQuestion
        question="Did the session go as planned?"
        value={planned}
        labels={Q1_LABELS}
        onChange={setPlanned}
      />

      <FeedbackQuestion
        question="How did that feel?"
        value={feel}
        labels={Q2_LABELS}
        onChange={setFeel}
      />

      <div className="space-y-3 pt-2">
        <button
          type="button"
          onClick={handleSave}
          className="btn-primary w-full"
        >
          <CheckCircle2 size={18} />
          Save
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="btn-ghost w-full justify-center text-sm"
        >
          Skip
        </button>
      </div>
    </div>
  )
}

interface FeedbackQuestionProps {
  question: string
  value: SliderValue
  labels: readonly string[]
  onChange: (v: SliderValue) => void
}

function FeedbackQuestion({
  question,
  value,
  labels,
  onChange,
}: FeedbackQuestionProps) {
  return (
    <fieldset className="card p-4 space-y-3">
      <legend className="text-sm font-medium px-1">{question}</legend>
      <input
        type="range"
        min="1"
        max="5"
        step="1"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) as SliderValue)}
        aria-label={question}
        aria-valuetext={labels[value - 1]}
        className="w-full accent-[var(--color-accent)] cursor-pointer touch-pan-x"
      />
      <div className="text-center text-sm text-[var(--color-fg)] font-medium">
        {labels[value - 1]}
      </div>
    </fieldset>
  )
}
