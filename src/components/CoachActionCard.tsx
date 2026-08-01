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
import type {
  CoachAction,
  CoachActionPlan,
  CoachProposal,
  PlannedExercise,
} from '../lib/chatTypes'
import { MUSCLE_LABEL } from '../lib/muscles'

type ContextProgram = CoachLiveContext['programs'][number]
type ContextSavedWorkout = ContextProgram['sessions'][number]

interface LocatedSavedWorkout {
  program: ContextProgram
  workout: ContextSavedWorkout
}

interface CardPresentation {
  title: string
  summary: string
  impact: string | null
  applyLabel: string
  appliedLabel: string
  danger: boolean
}

interface FutureRosterSession {
  name: string
  exercises: PlannedExercise[]
  disposition?: 'Retained' | 'New'
}

function exerciseName(context: CoachLiveContext | null, id: string): string {
  return (
    context?.exerciseCatalog.find((exercise) => exercise.id === id)?.name ??
    'Unknown exercise'
  )
}

function programById(
  context: CoachLiveContext | null,
  id: string,
): ContextProgram | undefined {
  return context?.programs.find((program) => program.id === id)
}

function locateSavedWorkout(
  context: CoachLiveContext | null,
  id: string,
): LocatedSavedWorkout | undefined {
  for (const program of context?.programs ?? []) {
    const workout = program.sessions.find((session) => session.id === id)
    if (workout) return { program, workout }
  }
  return undefined
}

function activeWorkoutIsEmpty(context: CoachLiveContext | null): boolean {
  return Boolean(
    context?.activeWorkout &&
      context.activeWorkout.exercises.every((exercise) => exercise.sets.length === 0),
  )
}

function appliedActionPresentation(
  action: CoachAction,
  context: CoachLiveContext | null,
): CardPresentation {
  switch (action.type) {
    case 'swap_active_exercise':
      return {
        title: 'Workout updated',
        summary: `Replaced ${exerciseName(context, action.fromExerciseId)} with ${exerciseName(context, action.toExerciseId)} · ${action.targetSets} × ${action.repRange}`,
        impact: 'Any completed sets stayed logged.',
        applyLabel: 'Apply change',
        appliedLabel: 'Updated',
        danger: false,
      }
    case 'add_active_exercise':
      return {
        title: 'Workout updated',
        summary: `Added ${exerciseName(context, action.exerciseId)} · ${action.targetSets} × ${action.repRange}`,
        impact: null,
        applyLabel: 'Apply change',
        appliedLabel: 'Updated',
        danger: false,
      }
    case 'update_active_exercise_targets':
      return {
        title: 'Workout updated',
        summary: `Set ${exerciseName(context, action.exerciseId)} to ${action.targetSets} × ${action.repRange}`,
        impact: 'Previously logged sets stayed unchanged.',
        applyLabel: 'Apply change',
        appliedLabel: 'Updated',
        danger: false,
      }
    case 'create_one_time_workout':
      return {
        title: 'One-time workout started',
        summary: `Started “${action.name}” with ${action.exercises.length} exercises`,
        impact: 'This workout is in progress and was not saved to a program.',
        applyLabel: 'Start workout',
        appliedLabel: 'Started',
        danger: false,
      }
    case 'create_session_template':
      return {
        title: 'Saved workout created',
        summary: `Saved “${action.name}” for future starts`,
        impact: 'A workout already in progress and past workouts stayed unchanged.',
        applyLabel: 'Save workout',
        appliedLabel: 'Saved',
        danger: false,
      }
    case 'create_program':
      return {
        title: 'Training program created',
        summary: `Created “${action.name}” with ${action.sessions.length} saved workouts`,
        impact: 'The previously active program stayed unchanged.',
        applyLabel: 'Create program',
        appliedLabel: 'Created',
        danger: false,
      }
    case 'rename_program':
      return {
        title: 'Program renamed',
        summary: `Renamed to “${action.name}”`,
        impact: 'Past workouts kept the program name recorded when they were logged.',
        applyLabel: 'Rename program',
        appliedLabel: 'Renamed',
        danger: false,
      }
    case 'replace_program':
      return {
        title: 'Saved program overwritten',
        summary: `“${action.name}” now contains ${action.sessions.length} saved workouts`,
        impact:
          'Current and past workout snapshots and all logged sets remained intact. Links to any saved workouts omitted by the replacement were detached, which may reset the program’s next-workout rotation.',
        applyLabel: 'Overwrite program',
        appliedLabel: 'Overwritten',
        danger: true,
      }
    case 'archive_program':
      return {
        title: 'Program archived',
        summary: 'The program was moved to Archived',
        impact:
          'Its saved workouts and workout history stayed intact, and the program can be restored later.',
        applyLabel: 'Archive program',
        appliedLabel: 'Archived',
        danger: true,
      }
    case 'replace_session_template':
      return {
        title: 'Saved workout overwritten',
        summary: `“${action.name}” now contains ${action.exercises.length} exercises`,
        impact:
          'Current and past workout snapshots and logged sets stayed unchanged. Their saved-workout link stayed attached, so this edit did not reset the next-workout rotation.',
        applyLabel: 'Overwrite saved workout',
        appliedLabel: 'Overwritten',
        danger: true,
      }
    case 'delete_session_template':
      return {
        title: 'Saved workout removed',
        summary: 'The saved workout was removed from its program',
        impact:
          'Current and past workouts kept their exercise snapshots and logged sets, but their link to the removed saved workout was detached. The program’s next-workout rotation may reset.',
        applyLabel: 'Remove saved workout',
        appliedLabel: 'Removed',
        danger: true,
      }
    case 'create_custom_exercise':
      return {
        title: 'Library exercise created',
        summary: `Added “${action.name}” to your exercise library`,
        impact: 'It was not added to a saved workout or workout in progress.',
        applyLabel: 'Create exercise',
        appliedLabel: 'Created',
        danger: false,
      }
    case 'save_ai_note':
      return {
        title: 'Note saved for future Insights',
        summary: `“${action.body}”`,
        impact: null,
        applyLabel: 'Save to AI Memory',
        appliedLabel: 'Saved',
        danger: false,
      }
  }
}

function singleActionPresentation(
  action: CoachAction,
  context: CoachLiveContext | null,
  applied: boolean,
): CardPresentation {
  if (applied) return appliedActionPresentation(action, context)
  switch (action.type) {
    case 'swap_active_exercise': {
      const from = exerciseName(context, action.fromExerciseId)
      const to = exerciseName(context, action.toExerciseId)
      const completedSourceWork = Boolean(
        context?.activeWorkout?.exercises.find(
          (exercise) => exercise.exerciseId === action.fromExerciseId,
        )?.sets.length,
      )
      return {
        title: 'Update workout in progress',
        summary: completedSourceWork
          ? `Keep your completed ${from} sets, then add ${to} · ${action.targetSets} × ${action.repRange}`
          : `Swap ${from} for ${to} · ${action.targetSets} × ${action.repRange}`,
        impact: completedSourceWork
          ? 'Your completed sets stay logged; the replacement work is inserted next.'
          : null,
        applyLabel: 'Apply change',
        appliedLabel: 'Updated',
        danger: false,
      }
    }
    case 'add_active_exercise':
      return {
        title: 'Update workout in progress',
        summary: `Add ${exerciseName(context, action.exerciseId)} · ${action.targetSets} × ${action.repRange}`,
        impact: null,
        applyLabel: 'Apply change',
        appliedLabel: 'Updated',
        danger: false,
      }
    case 'update_active_exercise_targets':
      return {
        title: 'Update workout in progress',
        summary: `Set ${exerciseName(context, action.exerciseId)} to ${action.targetSets} × ${action.repRange}`,
        impact: 'Sets you have already logged stay unchanged.',
        applyLabel: 'Apply change',
        appliedLabel: 'Updated',
        danger: false,
      }
    case 'create_one_time_workout': {
      const replacing = activeWorkoutIsEmpty(context)
      const activeName = context?.activeWorkout?.name ?? 'your empty workout'
      return {
        title: replacing ? 'Replace empty workout' : 'Start one-time workout',
        summary: replacing
          ? `Discard “${activeName}” and start “${action.name}” with ${action.exercises.length} exercises`
          : `Start “${action.name}” with ${action.exercises.length} exercises`,
        impact: replacing
          ? `Your empty workout “${activeName}” will be discarded. No logged sets will be lost.`
          : 'Starts immediately as a one-time workout; it will not be saved to a program.',
        applyLabel: replacing ? 'Replace & start workout' : 'Start workout',
        appliedLabel: 'Started',
        danger: replacing,
      }
    }
    case 'create_session_template': {
      const program = programById(context, action.programId)
      return {
        title: 'Save workout for future use',
        summary: `Add saved workout “${action.name}” to “${program?.name ?? 'Unknown program'}”`,
        impact:
          'This changes future starts only. A workout already in progress and past workouts remain unchanged.',
        applyLabel: 'Save workout',
        appliedLabel: 'Saved',
        danger: false,
      }
    }
    case 'create_program':
      return {
        title: 'Create training program',
        summary: `Create “${action.name}” with ${action.sessions.length} saved workouts`,
        impact: 'Your currently active program will not change.',
        applyLabel: 'Create program',
        appliedLabel: 'Created',
        danger: false,
      }
    case 'rename_program': {
      const program = programById(context, action.programId)
      return {
        title: 'Rename program',
        summary: `“${program?.name ?? 'Unknown program'}” → “${action.name}”`,
        impact:
          'Future workout screens will use the new program name. Past workouts keep the name recorded when they were logged.',
        applyLabel: 'Rename program',
        appliedLabel: 'Renamed',
        danger: false,
      }
    }
    case 'replace_program': {
      const program = programById(context, action.programId)
      const currentName = program?.name ?? 'Unknown program'
      return {
        title: 'Overwrite saved program',
        summary:
          currentName === action.name
            ? `Replace every saved workout in “${currentName}” with this ${action.sessions.length}-workout plan`
            : `Replace “${currentName}” with “${action.name}” and its ${action.sessions.length} saved workouts`,
        impact:
          'This overwrites the program for future starts. Current and past workout snapshots and all logged sets remain intact. Links to omitted saved workouts will be detached, which may reset the program’s next-workout rotation.',
        applyLabel: 'Overwrite program',
        appliedLabel: 'Overwritten',
        danger: true,
      }
    }
    case 'archive_program': {
      const program = programById(context, action.programId)
      return {
        title: 'Archive program',
        summary: `Archive “${program?.name ?? 'Unknown program'}”`,
        impact:
          'It will not be used for Today’s recommendations. Its saved workouts and your workout history stay intact, and you can restore it later.',
        applyLabel: 'Archive program',
        appliedLabel: 'Archived',
        danger: true,
      }
    }
    case 'replace_session_template': {
      const located = locateSavedWorkout(context, action.sessionTemplateId)
      const oldName = located?.workout.name ?? 'Unknown saved workout'
      return {
        title: 'Overwrite saved workout',
        summary:
          oldName === action.name
            ? `Replace the full future roster for “${oldName}” in “${located?.program.name ?? 'Unknown program'}”`
            : `Replace “${oldName}” with saved workout “${action.name}” in “${located?.program.name ?? 'Unknown program'}”`,
        impact:
          'This changes future starts only. Current and past workout snapshots and logged sets remain unchanged. Their saved-workout link stays attached, so this edit will not reset the next-workout rotation.',
        applyLabel: 'Overwrite saved workout',
        appliedLabel: 'Overwritten',
        danger: true,
      }
    }
    case 'delete_session_template': {
      const located = locateSavedWorkout(context, action.sessionTemplateId)
      return {
        title: 'Remove saved workout',
        summary: `Remove “${located?.workout.name ?? 'Unknown saved workout'}” from “${located?.program.name ?? 'Unknown program'}”`,
        impact:
          'Current and past workouts created from it keep their exercise snapshots and every logged set, but their saved-workout link will be detached. The program’s next-workout rotation may reset.',
        applyLabel: 'Remove saved workout',
        appliedLabel: 'Removed',
        danger: true,
      }
    }
    case 'create_custom_exercise':
      return {
        title: 'Create library exercise',
        summary: `Add “${action.name}” to your exercise library`,
        impact:
          'This adds the exercise to Library only. It will not be added to a saved workout or workout in progress yet.',
        applyLabel: 'Create exercise',
        appliedLabel: 'Created',
        danger: false,
      }
    case 'save_ai_note':
      return {
        title: 'Save note for future Insights',
        summary: `“${action.body}”`,
        impact: null,
        applyLabel: 'Save to AI Memory',
        appliedLabel: 'Saved',
        danger: false,
      }
  }
}

function planPresentation(
  plan: CoachActionPlan,
  context: CoachLiveContext | null,
  applied: boolean,
): CardPresentation {
  if (plan.actions.length === 1) {
    return singleActionPresentation(plan.actions[0], context, applied)
  }
  const danger = plan.actions.some(
    (action) =>
      action.type === 'replace_program' ||
      action.type === 'archive_program' ||
      action.type === 'replace_session_template' ||
      action.type === 'delete_session_template',
  )
  return {
    title:
      plan.scope === 'active_workout'
        ? applied
          ? 'Workout updated'
          : 'Update workout in progress'
        : applied
          ? 'Saved training plan updated'
          : 'Update saved training plan',
    summary: applied
      ? `${plan.actions.length} changes were applied`
      : `${plan.actions.length} exact changes are ready for review`,
    impact:
      plan.scope === 'active_workout'
        ? applied
          ? 'Previously logged sets stayed unchanged.'
          : 'Sets you have already logged stay unchanged.'
        : applied
          ? 'Your workout in progress and past workouts stayed unchanged.'
          : 'Your workout in progress and past workouts remain unchanged.',
    applyLabel: danger ? 'Apply destructive changes' : 'Apply changes',
    appliedLabel: 'Updated',
    danger,
  }
}

function PlannedExercises({
  exercises,
  context,
}: {
  exercises: PlannedExercise[]
  context: CoachLiveContext | null
}) {
  return (
    <ul className="mt-2 space-y-1.5 border-l border-[var(--color-border)] pl-3">
      {exercises.map((exercise) => (
        <li
          key={exercise.exerciseId}
          className="text-xs leading-5 text-[var(--color-fg-dim)]"
        >
          <span className="font-medium text-[var(--color-fg)]">
            {exerciseName(context, exercise.exerciseId)}
          </span>{' '}
          · {exercise.targetSets} × {exercise.repRange}
        </li>
      ))}
    </ul>
  )
}

function FutureRoster({
  label,
  sessions,
  context,
}: {
  label: string
  sessions: FutureRosterSession[]
  context: CoachLiveContext | null
}) {
  return (
    <details className="mt-2 rounded-xl border border-[var(--color-border)] bg-black/10 px-3 py-2">
      <summary className="cursor-pointer text-xs font-semibold text-[var(--color-fg-dim)]">
        {label}
      </summary>
      <div className="mt-3 space-y-3">
        {sessions.map((session) => (
          <section key={session.name}>
            <div className="flex items-center gap-2">
              <h4 className="min-w-0 flex-1 truncate text-xs font-bold text-[var(--color-fg)]">
                {session.name}
              </h4>
              {session.disposition && (
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    session.disposition === 'New'
                      ? 'border-emerald-800/60 bg-emerald-950/35 text-emerald-200'
                      : 'border-[var(--color-border)] bg-white/5 text-[var(--color-fg-faint)]'
                  }`}
                >
                  {session.disposition}
                </span>
              )}
            </div>
            <PlannedExercises exercises={session.exercises} context={context} />
          </section>
        ))}
      </div>
    </details>
  )
}

function ProgramRemovalPreview({
  action,
  context,
}: {
  action: Extract<CoachAction, { type: 'replace_program' }>
  context: CoachLiveContext | null
}) {
  const program = programById(context, action.programId)
  const retainedIds = new Set(
    action.sessions
      .map((session) => session.sessionTemplateId)
      .filter((id): id is string => id !== null),
  )
  const removed = program?.sessions.filter(
    (session) => !retainedIds.has(session.id),
  )

  return (
    <section className="mt-2 rounded-xl border border-red-900/60 bg-red-950/35 px-3 py-2">
      <h4 className="text-[10px] font-bold uppercase tracking-wider text-red-200">
        Saved workouts removed
      </h4>
      {removed === undefined ? (
        <p className="mt-1 text-xs leading-5 text-red-100">
          Current program details are unavailable. Refresh before applying this
          overwrite.
        </p>
      ) : removed.length === 0 ? (
        <p className="mt-1 text-xs leading-5 text-red-100">None</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {removed.map((session) => (
            <li key={session.id} className="flex items-start gap-1.5 text-xs leading-5 text-red-100">
              <X size={12} className="mt-1 shrink-0 text-red-300" />
              <span className="min-w-0 break-words">{session.name}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function CustomExerciseFields({
  action,
}: {
  action: Extract<CoachAction, { type: 'create_custom_exercise' }>
}) {
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl border border-[var(--color-border)] bg-black/10 px-3 py-2 text-xs leading-5">
      <dt className="text-[var(--color-fg-faint)]">Name</dt>
      <dd className="text-right font-medium text-[var(--color-fg)]">{action.name}</dd>
      <dt className="text-[var(--color-fg-faint)]">Primary</dt>
      <dd className="text-right text-[var(--color-fg)]">
        {MUSCLE_LABEL[action.primaryMuscle]}
      </dd>
      <dt className="text-[var(--color-fg-faint)]">Secondary</dt>
      <dd className="text-right text-[var(--color-fg)]">
        {action.secondaryMuscles.length
          ? action.secondaryMuscles.map((muscle) => MUSCLE_LABEL[muscle]).join(', ')
          : 'None'}
      </dd>
      <dt className="text-[var(--color-fg-faint)]">Default rest</dt>
      <dd className="text-right text-[var(--color-fg)]">
        {action.defaultRestSeconds} seconds
      </dd>
      <dt className="col-span-2 mt-1 border-t border-[var(--color-border)] pt-2 text-[var(--color-fg-faint)]">
        Notes
      </dt>
      <dd className="col-span-2 min-w-0 whitespace-pre-wrap break-words text-[var(--color-fg)]">
        {action.notes || 'None'}
      </dd>
    </dl>
  )
}

function ActionDetails({
  action,
  context,
  applied,
}: {
  action: CoachAction
  context: CoachLiveContext | null
  applied: boolean
}) {
  switch (action.type) {
    case 'create_one_time_workout':
      return (
        <FutureRoster
          label={`Exact workout roster · ${action.exercises.length} exercises`}
          sessions={[{ name: action.name, exercises: action.exercises }]}
          context={context}
        />
      )
    case 'create_session_template':
      return (
        <FutureRoster
          label={`Exact future roster · ${action.exercises.length} exercises`}
          sessions={[{ name: action.name, exercises: action.exercises }]}
          context={context}
        />
      )
    case 'create_program':
      return (
        <FutureRoster
          label={`Exact program · ${action.sessions.length} saved workouts`}
          sessions={action.sessions}
          context={context}
        />
      )
    case 'replace_program':
      return (
        <>
          {!applied && <ProgramRemovalPreview action={action} context={context} />}
          <FutureRoster
            label={`Exact future program · ${action.sessions.length} saved workouts`}
            sessions={action.sessions.map((session) => ({
              ...session,
              disposition:
                session.sessionTemplateId === null ? ('New' as const) : ('Retained' as const),
            }))}
            context={context}
          />
        </>
      )
    case 'replace_session_template':
      return (
        <FutureRoster
          label={`Exact future roster · ${action.exercises.length} exercises`}
          sessions={[{ name: action.name, exercises: action.exercises }]}
          context={context}
        />
      )
    case 'create_custom_exercise':
      return <CustomExerciseFields action={action} />
    default:
      return null
  }
}

function ResultBadge({
  status,
  appliedLabel,
}: {
  status: CoachProposal['status']
  appliedLabel: string
}) {
  if (status === 'applied') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-300">
        <CheckCircle2 size={14} /> {appliedLabel}
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
  busy,
  error,
  onApply,
  onDismiss,
}: {
  proposal: CoachProposal
  context: CoachLiveContext | null
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
  const applied = proposal.status === 'applied'
  const presentation = plan ? planPresentation(plan, context, applied) : null
  const currentScopeHash = plan ? context?.actionStateHashes[plan.scope] : null
  const contextUnavailable = Boolean(
    proposal.status === 'proposed' && plan && !currentScopeHash,
  )
  const stale = Boolean(
    proposal.status === 'proposed' &&
      plan &&
      currentScopeHash &&
      plan.sourceActionStateHash !== currentScopeHash.toLowerCase(),
  )
  const remoteError =
    proposal.status === 'failed' &&
    proposal.result !== null &&
    typeof proposal.result === 'object' &&
    'error' in proposal.result &&
    typeof proposal.result.error === 'string'
      ? proposal.result.error
      : null
  const syncWarning =
    proposal.status === 'applied' &&
    proposal.result !== null &&
    typeof proposal.result === 'object' &&
    (('syncPending' in proposal.result &&
      proposal.result.syncPending === true) ||
      ('syncWarning' in proposal.result &&
        typeof proposal.result.syncWarning === 'string'))
  const danger = presentation?.danger ?? false

  return (
    <section
      className="ml-8 rounded-2xl overflow-hidden"
      style={{
        background: danger ? 'oklch(0.20 0.035 25)' : 'oklch(0.22 0.025 50)',
        border: danger
          ? '1px solid oklch(0.48 0.14 25)'
          : '1px solid oklch(0.42 0.1 50)',
      }}
      aria-label={applied ? 'Coach applied action' : 'Coach proposed action'}
    >
      <div className="px-4 py-3">
        <div className="flex items-start gap-2">
          {danger ? (
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-300" />
          ) : (
            <ShieldCheck
              size={18}
              className="mt-0.5 shrink-0 text-[var(--color-accent)]"
            />
          )}
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold leading-tight">
              {presentation?.title ?? 'Action unavailable'}
            </h3>
            {presentation && (
              <p className="mt-1 text-sm leading-5 text-[var(--color-fg-dim)]">
                {presentation.summary}
              </p>
            )}
          </div>
          <ResultBadge
            status={proposal.status}
            appliedLabel={presentation?.appliedLabel ?? 'Applied'}
          />
        </div>

        {plan && (
          <div className="mt-3 space-y-2">
            {plan.actions.length > 1 && (
              <ul className="space-y-2">
                {plan.actions.map((action, index) => {
                  const item = singleActionPresentation(action, context, applied)
                  return (
                    <li
                      key={`${action.type}-${index}`}
                      className="flex items-start gap-2 text-sm text-[var(--color-fg)]"
                    >
                      <ChevronRight
                        size={14}
                        className="mt-0.5 shrink-0 text-[var(--color-accent)]"
                      />
                      <span className="min-w-0 whitespace-pre-wrap break-words">
                        {item.summary}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
            {plan.actions.map((action, index) => (
              <ActionDetails
                key={`${action.type}-details-${index}`}
                action={action}
                context={context}
                applied={applied}
              />
            ))}
          </div>
        )}

        {presentation?.impact && (
          <div
            className={`mt-3 flex gap-2 rounded-xl border px-3 py-2 text-xs leading-5 ${
              danger
                ? 'border-red-900/60 bg-red-950/35 text-red-100'
                : 'border-[var(--color-border)] bg-black/10 text-[var(--color-fg-dim)]'
            }`}
          >
            {danger ? (
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-300" />
            ) : (
              <ShieldCheck
                size={14}
                className="mt-0.5 shrink-0 text-[var(--color-accent)]"
              />
            )}
            <span>{presentation.impact}</span>
          </div>
        )}

        {(invalid || contextUnavailable || stale || error || remoteError) && (
          <div className="mt-3 flex gap-2 rounded-xl px-3 py-2 text-xs leading-5 bg-red-950/35 text-red-200 border border-red-900/50">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              {invalid ??
                (contextUnavailable
                  ? 'Current workout data is still loading. Wait before applying this change.'
                  : null) ??
                error ??
                remoteError ??
                'The data this plan would change has been updated. Ask Coach for an updated plan.'}
            </span>
          </div>
        )}

        {syncWarning && (
          <div className="mt-3 flex gap-2 rounded-xl px-3 py-2 text-xs leading-5 bg-amber-950/35 text-amber-100 border border-amber-800/50">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              Saved on this device, but cloud sync failed. Future AI Insights
              cannot use it yet; retry Sync now in Settings.
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
            disabled={busy || Boolean(invalid) || contextUnavailable || stale}
            className={`py-3 inline-flex items-center justify-center gap-1.5 border-l border-[var(--color-border)] text-sm font-bold disabled:opacity-40 ${
              danger
                ? 'bg-red-950/30 text-red-200 hover:bg-red-950/55'
                : 'text-[var(--color-accent)] hover:bg-white/5'
            }`}
          >
            {busy ? (
              <LoaderCircle size={15} className="animate-spin" />
            ) : danger ? (
              <AlertTriangle size={15} />
            ) : (
              <Check size={15} />
            )}
            {presentation?.applyLabel ?? 'Apply'}
          </button>
        </div>
      )}
    </section>
  )
}
