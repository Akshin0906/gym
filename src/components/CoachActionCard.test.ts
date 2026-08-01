import 'fake-indexeddb/auto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CoachLiveContext } from '../lib/chatContext'
import type {
  CoachAction,
  CoachActionPlan,
  CoachActionScope,
  CoachProposal,
} from '../lib/chatTypes'
import { CoachActionCard } from './CoachActionCard'

const HASH = 'a'.repeat(64)

function context(
  overrides: Partial<CoachLiveContext> = {},
): CoachLiveContext {
  return {
    generatedAt: 1,
    actionStateHashes: {
      active_workout: HASH,
      one_time_workout: HASH,
      program: HASH,
      exercise_library: HASH,
      ai_memory: HASH,
    },
    activeWorkout: null,
    exerciseCatalog: [
      {
        id: 'press',
        name: 'Chest Press',
        primaryMuscle: 'chest',
        secondaryMuscles: ['triceps'],
        notes: '',
        defaultRestSeconds: 90,
        available: true,
      },
      {
        id: 'row',
        name: 'Cable Row',
        primaryMuscle: 'back',
        secondaryMuscles: ['biceps'],
        notes: '',
        defaultRestSeconds: 90,
        available: true,
      },
    ],
    programs: [],
    recentWorkouts: [],
    latestBriefing: null,
    memory: null,
    ...overrides,
  }
}

function renderAction(args: {
  action: CoachAction
  scope: CoachActionScope
  status: CoachProposal['status']
  liveContext: CoachLiveContext
}): string {
  const plan: CoachActionPlan = {
    title: 'Model-authored title',
    summary: 'Model-authored summary',
    scope: args.scope,
    sourceStateHash: HASH,
    sourceActionStateHash: HASH,
    actions: [args.action],
  }
  const proposal: CoachProposal = {
    id: 'proposal',
    messageId: 'message',
    jobId: 'job',
    status: args.status,
    actionPlan: plan,
    createdAt: 1,
    updatedAt: 1,
    result: null,
  }
  return renderToStaticMarkup(
    createElement(CoachActionCard, {
      proposal,
      context: args.liveContext,
      busy: false,
      error: null,
      onApply: () => undefined,
      onDismiss: () => undefined,
    }),
  )
}

describe('CoachActionCard lifecycle previews', () => {
  it('uses action-only wording for an applied rename', () => {
    const html = renderAction({
      action: {
        type: 'rename_program',
        programId: 'program',
        name: 'New Program',
      },
      scope: 'program',
      status: 'applied',
      liveContext: context({
        programs: [
          {
            id: 'program',
            name: 'New Program',
            active: false,
            archived: false,
            sessions: [],
          },
        ],
      }),
    })

    expect(html).toContain('Program renamed')
    expect(html).toContain('Renamed to “New Program”')
    expect(html).not.toContain('→')
    expect(html).not.toContain('Unknown')
  })

  it('does not describe an applied one-time workout as replacing itself', () => {
    const html = renderAction({
      action: {
        type: 'create_one_time_workout',
        name: 'Hotel Workout',
        exercises: [
          { exerciseId: 'press', targetSets: 3, repRange: '8-12' },
        ],
      },
      scope: 'one_time_workout',
      status: 'applied',
      liveContext: context({
        activeWorkout: {
          id: 'new-session',
          name: 'Hotel Workout',
          programName: null,
          startedAt: 1,
          doneExerciseIds: [],
          exercises: [
            {
              exerciseId: 'press',
              exerciseName: 'Chest Press',
              order: 0,
              targetSets: 3,
              repRange: '8-12',
              done: false,
              sets: [],
            },
          ],
        },
      }),
    })

    expect(html).toContain('One-time workout started')
    expect(html).toContain('Started “Hotel Workout”')
    expect(html).not.toContain('Replace empty workout')
    expect(html).not.toContain('Discard')
  })

  it('keeps an applied saved-workout deletion meaningful after context removal', () => {
    const html = renderAction({
      action: {
        type: 'delete_session_template',
        sessionTemplateId: 'removed-template',
      },
      scope: 'program',
      status: 'applied',
      liveContext: context({
        programs: [
          {
            id: 'program',
            name: 'PPL',
            active: false,
            archived: false,
            sessions: [],
          },
        ],
      }),
    })

    expect(html).toContain('Saved workout removed')
    expect(html).toContain('link to the removed saved workout was detached')
    expect(html).toContain('next-workout rotation may reset')
    expect(html).not.toContain('Unknown')
  })

  it('shows every omitted workout and labels retained versus new targets', () => {
    const html = renderAction({
      action: {
        type: 'replace_program',
        programId: 'program',
        name: 'Upper Lower',
        sessions: [
          {
            sessionTemplateId: 'upper',
            name: 'Upper Retained',
            exercises: [
              { exerciseId: 'press', targetSets: 3, repRange: '8-12' },
            ],
          },
          {
            sessionTemplateId: null,
            name: 'Lower New',
            exercises: [
              { exerciseId: 'row', targetSets: 3, repRange: '8-12' },
            ],
          },
        ],
      },
      scope: 'program',
      status: 'proposed',
      liveContext: context({
        programs: [
          {
            id: 'program',
            name: 'PPL',
            active: false,
            archived: false,
            sessions: [
              { id: 'upper', name: 'Upper', order: 0, exercises: [] },
              { id: 'push', name: 'Push Day', order: 1, exercises: [] },
              { id: 'pull', name: 'Pull Day', order: 2, exercises: [] },
            ],
          },
        ],
      }),
    })

    expect(html).toContain('Saved workouts removed')
    expect(html).toContain('Push Day')
    expect(html).toContain('Pull Day')
    expect(html.indexOf('Saved workouts removed')).toBeLessThan(
      html.indexOf('<details'),
    )
    expect(html).toContain('Retained')
    expect(html).toContain('New')
    expect(html).toContain('Links to omitted saved workouts will be detached')
    expect(html).toContain('next-workout rotation')
  })
})
