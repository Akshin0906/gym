import { CircleAlert, Dumbbell, LoaderCircle, Wifi, WifiOff } from 'lucide-react'
import type { CoachConversationState } from '../lib/chatTypes'
import type { CoachLiveContext } from '../lib/chatContext'

export function CoachStatus({
  remote,
  context,
}: {
  remote: CoachConversationState | null
  context: CoachLiveContext | null
}) {
  const active = context?.activeWorkout ?? null
  const setCount =
    active?.exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0) ?? 0
  const queued = (remote?.counts.queued ?? 0) > 0
  const processing = (remote?.counts.processing ?? 0) > 0
  const working = queued || processing
  const online = remote?.bridge?.online === true
  const workLabel = online ? (processing ? 'Thinking' : 'Queued') : 'Waiting for Mac'

  return (
    <div
      className="shrink-0 px-3 py-2 flex items-center gap-2 overflow-x-auto"
      style={{ borderBottom: '1px solid var(--color-border)' }}
    >
      <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold bg-[var(--color-surface)] border border-[var(--color-border)]">
        {active ? (
          <>
            <Dumbbell size={12} className="text-[var(--color-accent)]" />
            <span className="max-w-32 truncate">{active.name}</span>
            <span className="nums text-[var(--color-fg-faint)]">· {setCount} sets</span>
          </>
        ) : (
          <>
            <CircleAlert size={12} className="text-[var(--color-fg-faint)]" />
            No active workout
          </>
        )}
      </span>
      <span
        className="shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
        style={{
          color: online ? 'oklch(0.82 0.13 145)' : 'var(--color-fg-faint)',
          background: online ? 'oklch(0.25 0.06 145 / 0.45)' : 'var(--color-surface)',
          border: '1px solid var(--color-border)',
        }}
      >
        {online ? <Wifi size={12} /> : <WifiOff size={12} />}
        {online ? 'Coach online' : 'Coach offline'}
      </span>
      {working && (
        <span className="shrink-0 inline-flex items-center gap-1.5 text-[11px] text-[var(--color-fg-dim)]">
          {online ? (
            <LoaderCircle size={12} className="animate-spin" />
          ) : (
            <WifiOff size={12} />
          )}
          {workLabel}
        </span>
      )}
    </div>
  )
}
