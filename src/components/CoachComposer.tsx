import { ArrowUp, Brain, Sparkles } from 'lucide-react'
import { useRef, useState } from 'react'
import type { CoachReasoningEffort } from '../lib/chatTypes'

const ACTIVE_PROMPTS = [
  'Swap an exercise for me',
  'Adjust today’s workout to how I feel',
  'What should I do for my next set?',
]

const GENERAL_PROMPTS = [
  'Build me a workout for today',
  'Create a new training program',
  'How has my training been trending?',
]

export function CoachComposer({
  hasActiveWorkout,
  disabled,
  onSend,
}: {
  hasActiveWorkout: boolean
  disabled: boolean
  onSend: (text: string, effort: CoachReasoningEffort) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [deepThink, setDeepThink] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prompts = hasActiveWorkout ? ACTIVE_PROMPTS : GENERAL_PROMPTS

  async function submit() {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    try {
      await onSend(trimmed, deepThink ? 'xhigh' : 'medium')
      setText('')
      setDeepThink(false)
    } catch {
      // The parent displays the request error and the draft stays available.
    }
  }

  return (
    <div
      className="shrink-0 px-3 pt-2"
      style={{
        paddingBottom: 'max(0.75rem, var(--app-safe-area-bottom))',
        background: 'linear-gradient(to top, var(--color-bg) 84%, transparent)',
      }}
    >
      {!text && (
        <div className="flex gap-2 overflow-x-auto pb-2" aria-label="Suggestions">
          {prompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => {
                setText(prompt)
                requestAnimationFrame(() => textareaRef.current?.focus())
              }}
              className="shrink-0 rounded-full px-3 py-1.5 text-xs text-[var(--color-fg-dim)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:text-[var(--color-fg)]"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      <div className="rounded-2xl p-2 bg-[var(--color-surface)] border border-[var(--color-border)] shadow-xl">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
          rows={2}
          disabled={disabled}
          placeholder={hasActiveWorkout ? 'Ask about this workout…' : 'Ask your coach…'}
          aria-label="Message Coach"
          className="w-full resize-none bg-transparent px-2 py-1.5 text-base leading-6 outline-none placeholder:text-[var(--color-fg-faint)] disabled:opacity-60"
        />
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            aria-pressed={deepThink}
            onClick={() => setDeepThink((value) => !value)}
            disabled={disabled}
            className="min-h-11 inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold border"
            style={{
              color: deepThink ? 'var(--color-accent)' : 'var(--color-fg-dim)',
              background: deepThink ? 'var(--color-accent-soft)' : 'transparent',
              borderColor: deepThink ? 'var(--color-accent-strong)' : 'var(--color-border)',
            }}
          >
            {deepThink ? <Sparkles size={13} /> : <Brain size={13} />}
            Deep Think
          </button>
          <span className="flex-1 text-[10px] text-[var(--color-fg-faint)]">
            {deepThink ? 'Extra High intelligence' : 'Medium reasoning'}
          </span>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={disabled || !text.trim()}
            aria-label="Send message"
            className="w-11 h-11 rounded-full flex items-center justify-center bg-[var(--color-accent)] text-black disabled:opacity-35"
          >
            <ArrowUp size={18} strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </div>
  )
}
