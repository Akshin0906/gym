import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  LoaderCircle,
  ShieldCheck,
  X,
} from 'lucide-react'
import { parseCoachActionPlan } from '../db/repositories/chatActions'
import type { CoachLiveContext } from '../lib/chatContext'
import type { CoachAction, CoachActionPlan, CoachProposal } from '../lib/chatTypes'

function describeAction(
  action: CoachAction,
  exerciseNames: Map<string, string>,
  programNames: Map<string, string>,
): string {
  const exercise = (id: string) => exerciseNames.get(id) ?? 'Unknown exercise'
  switch (action.type) {
    case 'swap_active_exercise':
      return `Swap ${exercise(action.fromExerciseId)} for ${exercise(action.toExerciseId)} · ${action.targetSets} × ${action.repRange}`
    case 'add_active_exercise':
      return `Add ${exercise(action.exerciseId)} · ${action.targetSets} × ${action.repRange}`
    case 'update_active_exercise_targets':
      return `Set ${exercise(action.exerciseId)} to ${action.targetSets} × ${action.repRange}`
    case 'create_one_time_workout':
      return `Create “${action.name}” with ${action.exercises.length} exercises`
    case 'create_session_template':
      return `Add “${action.name}” to ${programNames.get(action.programId) ?? 'the program'}`
    case 'create_program':
      return `Create “${action.name}” with ${action.sessions.length} sessions`
  }
}

function ResultBadge({ status }: { status: CoachProposal['status'] }) {
  if (status === 'applied') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-300">
        <CheckCircle2 size={14} /> Applied
      </span>
    )
  }
  if (status === 'dismissed') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-[var(--color-fg-faint)]">
        <X size={14} /> Dismissed
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-300">
        <AlertTriangle size={14} /> Couldn’t apply
      </span>
    )
  }
  return null
}

export function CoachActionCard({
  proposal,
  context,
  currentStateHash,
  busy,
  error,
  onApply,
  onDismiss,
}: {
  proposal: CoachProposal
  context: CoachLiveContext | null
  currentStateHash: string | null
  busy: boolean
  error: string | null
  onApply: () => void
  onDismiss: () => void
}) {
  let plan: CoachActionPlan | null = null
  let invalid: string | null = null
  try {
    plan = parseCoachActionPlan(proposal.actionPlan)
  } catch (caught) {
    invalid = caught instanceof Error ? caught.message : String(caught)
  }
  const stale = Boolean(
    proposal.status === 'proposed' &&
      plan &&
      currentStateHash &&
      plan.sourceStateHash !== currentStateHash.toLowerCase(),
  )
  const remoteError =
    proposal.status === 'failed' &&
    proposal.result !== null &&
    typeof proposal.result === 'object' &&
    'error' in proposal.result &&
    typeof proposal.result.error === 'string'
      ? proposal.result.error
      : null
  const exerciseNames = new Map(
    (context?.exerciseCatalog ?? []).map((exercise) => [exercise.id, exercise.name]),
  )
  const programNames = new Map(
    (context?.programs ?? []).map((program) => [program.id, program.name]),
  )
  const applyLabel = !plan
    ? 'Apply'
    : plan.scope === 'active_workout'
      ? 'Apply change'
      : plan.scope === 'one_time_workout'
        ? 'Start workout'
        : plan.actions[0]?.type === 'create_session_template'
          ? 'Save workout'
          : 'Create program'

  return (
    <section
      className="ml-8 rounded-2xl overflow-hidden"
      style={{
        background: 'oklch(0.22 0.025 50)',
        border: '1px solid oklch(0.42 0.1 50)',
      }}
      aria-label="Coach proposed action"
    >
      <div className="px-4 py-3">
        <div className="flex items-start gap-2">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold leading-tight">
              {plan?.title ?? 'Action unavailable'}
            </h3>
            {plan && (
              <p className="mt-1 text-sm leading-5 text-[var(--color-fg-dim)]">
                {plan.summary}
              </p>
            )}
          </div>
          <ResultBadge status={proposal.status} />
        </div>

        {plan && (
          <ul className="mt-3 space-y-2">
            {plan.actions.map((action, index) => (
              <li
                key={`${action.type}-${index}`}
                className="flex items-start gap-2 text-sm text-[var(--color-fg)]"
              >
                <ChevronRight
                  size={14}
                  className="mt-0.5 shrink-0 text-[var(--color-accent)]"
                />
                {describeAction(action, exerciseNames, programNames)}
              </li>
            ))}
          </ul>
        )}

        {(invalid || stale || error || remoteError) && (
          <div className="mt-3 flex gap-2 rounded-xl px-3 py-2 text-xs leading-5 bg-red-950/35 text-red-200 border border-red-900/50">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              {invalid ??
                error ??
                remoteError ??
                'Your workout changed since this was suggested. Ask Coach for an updated plan.'}
            </span>
          </div>
        )}
      </div>

      {proposal.status === 'proposed' && (
        <div className="grid grid-cols-2 border-t border-[var(--color-border)]">
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="py-3 text-sm font-semibold text-[var(--color-fg-dim)] hover:bg-white/5 disabled:opacity-50"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={busy || Boolean(invalid) || stale}
            className="py-3 inline-flex items-center justify-center gap-1.5 text-sm font-bold text-[var(--color-accent)] border-l border-[var(--color-border)] hover:bg-white/5 disabled:opacity-40"
          >
            {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}
            {applyLabel}
          </button>
        </div>
      )}
    </section>
  )
}
