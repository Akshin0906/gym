import { describe, expect, it } from 'vitest'

import {
  isWithinPairAttemptLimit,
  onRequest as authOnRequest,
} from './auth/[[path]]'
import {
  assertBriefingSections,
  assertMemoryItem,
  assertMemoryState,
  isCalendarDate,
  MAX_BODY_BYTES,
  onRequest as cloudOnRequest,
  PayloadTooLargeError,
  readJsonBodyWithLimit,
} from './cloud/[[path]]'
import {
  trustedActionStateHash,
  validateActionPlan,
} from './chat/[[path]]'
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from '../lib/cloudAuth'
import type { CoachAction, CoachActionScope } from '../../src/lib/chatTypes'

class AtomicCounterDb implements D1Database {
  count = 0
  readonly queries: string[] = []

  prepare(query: string): D1PreparedStatement {
    this.queries.push(query)
    const db = this
    const statement: D1PreparedStatement = {
      bind: () => statement,
      async first<T>() {
        await Promise.resolve()
        db.count += 1
        return { attempt_count: db.count } as T
      },
      async all<T>() {
        return { results: [] as T[] }
      },
      async run() {
        return { success: true }
      },
    }
    return statement
  }

  async batch<T>(): Promise<D1Result<T>[]> {
    return []
  }
}

const failDb: D1Database = {
  prepare() {
    throw new Error('validation unexpectedly reached D1')
  },
  async batch() {
    throw new Error('validation unexpectedly reached D1')
  },
}

function automationRequest(path: string, payload: unknown): Request {
  return new Request(`https://gym.test/api/cloud/${path}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'X-Cloud-Automation-Secret': 'test-secret',
    },
    body: JSON.stringify(payload),
  })
}

function validMemoryItem(): Record<string, unknown> {
  return {
    id: 'workout:1',
    memoryType: 'workout',
    periodStartAt: 1,
    periodEndAt: 2,
    sourceWorkoutSessionId: 'session-1',
    bullets: [' Completed three sets. '],
    sourceSessionIds: ['session-1'],
    sourceNoteIds: [],
    sourceSummaryIds: [],
    model: 'gpt-test',
    createdAt: 3,
    updatedAt: 4,
    snapshotUpdatedAt: 5,
  }
}

describe('atomic pairing rate limit', () => {
  it('allows only the first five concurrent attempts', async () => {
    const db = new AtomicCounterDb()
    const request = new Request('https://gym.test/api/auth/cloud', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    })
    const results = await Promise.all(
      Array.from({ length: 12 }, () => isWithinPairAttemptLimit(db, request)),
    )

    expect(results.filter(Boolean)).toHaveLength(5)
    expect(results.filter((allowed) => !allowed)).toHaveLength(7)
    expect(db.queries.every((query) => query.includes('ON CONFLICT'))).toBe(true)
    expect(db.queries.every((query) => query.includes('RETURNING attempt_count'))).toBe(true)
  })

  it('rejects an array pairing body instead of treating it as an object', async () => {
    const db = new AtomicCounterDb()
    const response = await authOnRequest({
      request: new Request('https://gym.test/api/auth/cloud', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '[]',
      }),
      env: { CLOUD_PAIRING_SECRET: 'secret', WORKOUT_DB: db },
      params: { path: 'cloud' },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_pairing_request' })
  })
})

describe('snapshot byte limiting', () => {
  function streamedRequest(body: string): Request {
    const bytes = new TextEncoder().encode(body)
    const midpoint = Math.floor(bytes.byteLength / 2)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, midpoint))
        controller.enqueue(bytes.slice(midpoint))
        controller.close()
      },
    })
    const init: RequestInit & { duplex: 'half' } = {
      method: 'PUT',
      body: stream,
      duplex: 'half',
    }
    return new Request('https://gym.test/api/cloud/snapshot', init)
  }

  it('accepts a chunked JSON body exactly at the byte limit', async () => {
    expect(MAX_BODY_BYTES).toBe(1_900_000)
    await expect(readJsonBodyWithLimit(streamedRequest('"1234"'), 6)).resolves.toBe(
      '1234',
    )
  })

  it('rejects a chunked body that crosses the real byte limit', async () => {
    const request = streamedRequest('"12345"')
    expect(request.headers.get('content-length')).toBeNull()
    await expect(readJsonBodyWithLimit(request, 6)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    )
  })

  it('rejects an oversized declared length without consuming JSON', async () => {
    const request = new Request('https://gym.test/api/cloud/snapshot', {
      method: 'PUT',
      headers: { 'content-length': '7' },
      body: 'not json',
    })
    await expect(readJsonBodyWithLimit(request, 6)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    )
  })
})

describe('briefing validation', () => {
  it('recognizes real Gregorian calendar dates', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true)
    expect(isCalendarDate('2026-02-29')).toBe(false)
    expect(isCalendarDate('2026-13-40')).toBe(false)
    expect(isCalendarDate('2026-04-31')).toBe(false)
  })

  it('trims valid text without filtering invalid entries', () => {
    expect(
      JSON.parse(
        assertBriefingSections({
          todaysCall: ' Train ',
          why: [' Ready '],
          recoveryStatus: 'fresh',
          ouraRecovery: ' Good ',
          trainingTrend: ' Stable ',
          watchOuts: [],
        }),
      ),
    ).toEqual({
      todaysCall: 'Train',
      why: ['Ready'],
      recoveryStatus: 'fresh',
      ouraRecovery: 'Good',
      trainingTrend: 'Stable',
      watchOuts: [],
    })
    expect(() =>
      assertBriefingSections({
        todaysCall: 'Train',
        why: ['   '],
        ouraRecovery: 'Good',
        trainingTrend: 'Stable',
        watchOuts: [],
      }),
    ).toThrow('sections.why[0] must not be empty')
    expect(() =>
      assertBriefingSections({
        todaysCall: 'Train',
        why: ['Ready'],
        ouraRecovery: '   ',
        trainingTrend: 'Stable',
        watchOuts: [],
      }),
    ).toThrow('sections.ouraRecovery must not be empty')
  })

  it('rejects impossible dates and array request objects before D1', async () => {
    const invalidDate = await cloudOnRequest({
      request: automationRequest('briefing/2026-13-40', {}),
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: failDb },
      params: { path: ['briefing', '2026-13-40'] },
    })
    expect(invalidDate.status).toBe(400)
    expect(await invalidDate.json()).toEqual({ error: 'invalid_date' })

    const arrayBody = await cloudOnRequest({
      request: automationRequest('briefing/2026-08-01', []),
      env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: failDb },
      params: { path: ['briefing', '2026-08-01'] },
    })
    expect(arrayBody.status).toBe(400)
    expect(await arrayBody.json()).toEqual({ error: 'invalid_briefing' })
  })
})

describe('memory validation', () => {
  it('accepts and trims a complete valid item and state', () => {
    expect(assertMemoryItem(validMemoryItem())).toMatchObject({
      id: 'workout:1',
      bullets: ['Completed three sets.'],
      createdAt: 3,
      updatedAt: 4,
      snapshotUpdatedAt: 5,
    })
    expect(
      assertMemoryState({
        currentContext: ' Context ',
        paused: false,
        windowStartedAt: 1,
        fourMonthStartedAt: 2,
        sourceSnapshotUpdatedAt: 3,
      }),
    ).toEqual({
      currentContext: 'Context',
      paused: false,
      windowStartedAt: 1,
      fourMonthStartedAt: 2,
      sourceSnapshotUpdatedAt: 3,
    })
  })

  it('rejects malformed present values rather than coercing or filtering', () => {
    expect(() =>
      assertMemoryItem({ ...validMemoryItem(), createdAt: 'now' }),
    ).toThrow('createdAt must be a finite number')
    expect(() =>
      assertMemoryItem({ ...validMemoryItem(), snapshotUpdatedAt: '5' }),
    ).toThrow('snapshotUpdatedAt must be a finite number')
    expect(() =>
      assertMemoryItem({
        ...validMemoryItem(),
        sourceSessionIds: ['session-1', 2],
      }),
    ).toThrow('sourceSessionIds[1] must be a string')
    expect(() =>
      assertMemoryItem({ ...validMemoryItem(), bullets: [''] }),
    ).toThrow('memory item bullets[0] must not be empty')
    expect(() =>
      assertMemoryState({
        currentContext: 7,
        paused: 'false',
        windowStartedAt: 1,
        fourMonthStartedAt: 2,
        sourceSnapshotUpdatedAt: null,
      }),
    ).toThrow('state.currentContext must be a string')
    expect(() =>
      assertMemoryState({
        currentContext: '',
        paused: 'false',
        windowStartedAt: 1,
        fourMonthStartedAt: 2,
        sourceSnapshotUpdatedAt: null,
      }),
    ).toThrow('state.paused must be a boolean')
  })

  it('rejects array and empty envelopes before D1', async () => {
    for (const payload of [[], {}]) {
      const response = await cloudOnRequest({
        request: automationRequest('memory', payload),
        env: { CLOUD_AUTOMATION_SECRET: 'test-secret', WORKOUT_DB: failDb },
        params: { path: 'memory' },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_memory' })
    }
  })
})

describe('chat action-plan validation', () => {
  const plannedExercise = {
    exerciseId: 'exercise-1',
    targetSets: 3,
    repRange: '8-10',
  }
  const validPlan = {
    title: 'Save note',
    summary: 'Remember the constraint.',
    scope: 'ai_memory',
    actions: [{ type: 'save_ai_note', body: 'Avoid overhead pressing.' }],
  }

  const supportedActions: Array<
    [label: string, scope: CoachActionScope, action: CoachAction]
  > = [
    [
      'swap_active_exercise',
      'active_workout',
      {
        type: 'swap_active_exercise',
        sessionId: 'session-1',
        fromExerciseId: 'exercise-1',
        toExerciseId: 'exercise-2',
        targetSets: 3,
        repRange: '8-10',
      },
    ],
    [
      'add_active_exercise',
      'active_workout',
      {
        type: 'add_active_exercise',
        sessionId: 'session-1',
        exerciseId: 'exercise-1',
        position: 0,
        targetSets: 3,
        repRange: '8-10',
      },
    ],
    [
      'update_active_exercise_targets',
      'active_workout',
      {
        type: 'update_active_exercise_targets',
        sessionId: 'session-1',
        exerciseId: 'exercise-1',
        targetSets: 3,
        repRange: '8-10',
      },
    ],
    [
      'create_one_time_workout',
      'one_time_workout',
      {
        type: 'create_one_time_workout',
        name: 'Test workout',
        exercises: [plannedExercise],
      },
    ],
    [
      'create_session_template',
      'program',
      {
        type: 'create_session_template',
        programId: 'program-1',
        name: 'Push',
        exercises: [plannedExercise],
      },
    ],
    [
      'create_program',
      'program',
      {
        type: 'create_program',
        name: 'Test program',
        sessions: [{ name: 'Push', exercises: [plannedExercise] }],
      },
    ],
    [
      'rename_program',
      'program',
      { type: 'rename_program', programId: 'program-1', name: 'Renamed' },
    ],
    [
      'replace_program',
      'program',
      {
        type: 'replace_program',
        programId: 'program-1',
        name: 'Replacement',
        sessions: [
          {
            sessionTemplateId: 'session-template-1',
            name: 'Push',
            exercises: [plannedExercise],
          },
          {
            sessionTemplateId: null,
            name: 'Pull',
            exercises: [{ ...plannedExercise, exerciseId: 'exercise-2' }],
          },
        ],
      },
    ],
    [
      'archive_program',
      'program',
      { type: 'archive_program', programId: 'program-1' },
    ],
    [
      'replace_session_template',
      'program',
      {
        type: 'replace_session_template',
        sessionTemplateId: 'session-template-1',
        name: 'Updated Push',
        exercises: [plannedExercise],
      },
    ],
    [
      'delete_session_template',
      'program',
      {
        type: 'delete_session_template',
        sessionTemplateId: 'session-template-1',
      },
    ],
    [
      'create_custom_exercise',
      'exercise_library',
      {
        type: 'create_custom_exercise',
        name: 'Cable Y Raise',
        primaryMuscle: 'shoulders',
        secondaryMuscles: ['traps'],
        notes: '',
        defaultRestSeconds: 90,
      },
    ],
    [
      'save_ai_note',
      'ai_memory',
      { type: 'save_ai_note', body: 'Avoid overhead pressing.' },
    ],
  ]

  it.each(supportedActions)(
    'accepts and sanitizes the supported %s action',
    (_label, scope, action) => {
      const input = {
        title: 'Safe change',
        summary: 'Preview this exact change.',
        scope,
        sourceStateHash: 'f'.repeat(64),
        sourceActionStateHash: 'e'.repeat(64),
        ignored: true,
        actions: [{ ...action, ignored: true }],
      }
      expect(validateActionPlan(input)).toEqual({
        title: input.title,
        summary: input.summary,
        scope,
        actions: [action],
      })
    },
  )

  it('strips unknown nested fields while preserving the client contract', () => {
    const raw = {
      title: 'Replace program',
      summary: 'Replace the exact program structure.',
      scope: 'program',
      actions: [
        {
          type: 'replace_program',
          programId: 'program-1',
          name: 'Replacement',
          ignored: true,
          sessions: [
            {
              sessionTemplateId: null,
              name: 'Push',
              ignored: true,
              exercises: [{ ...plannedExercise, ignored: true }],
            },
          ],
        },
      ],
    }
    expect(validateActionPlan(raw)).toEqual({
      title: raw.title,
      summary: raw.summary,
      scope: raw.scope,
      actions: [
        {
          type: 'replace_program',
          programId: 'program-1',
          name: 'Replacement',
          sessions: [
            {
              sessionTemplateId: null,
              name: 'Push',
              exercises: [plannedExercise],
            },
          ],
        },
      ],
    })

    const createProgram = {
      title: 'Create program',
      summary: 'Create the exact program structure.',
      scope: 'program',
      actions: [
        {
          type: 'create_program',
          name: 'New program',
          sessions: [
            {
              name: 'Push',
              ignored: true,
              exercises: [{ ...plannedExercise, ignored: true }],
            },
          ],
        },
      ],
    }
    expect(validateActionPlan(createProgram)).toEqual({
      title: createProgram.title,
      summary: createProgram.summary,
      scope: createProgram.scope,
      actions: [
        {
          type: 'create_program',
          name: 'New program',
          sessions: [{ name: 'Push', exercises: [plannedExercise] }],
        },
      ],
    })
  })

  it('accepts exact client maxima and rejects the first values over them', () => {
    const boundaryAction = {
      type: 'update_active_exercise_targets',
      sessionId: 'session-1',
      exerciseId: 'exercise-1',
      targetSets: 20,
      repRange: '8-10',
    }
    const boundaryPlan = {
      title: 't'.repeat(120),
      summary: 's'.repeat(1000),
      scope: 'active_workout',
      actions: Array.from({ length: 12 }, () => ({ ...boundaryAction })),
    }
    expect(validateActionPlan(boundaryPlan)).toEqual(boundaryPlan)
    const validationDetail = (value: unknown): unknown => {
      try {
        validateActionPlan(value)
        return null
      } catch (error) {
        return (error as { detail?: unknown }).detail
      }
    }
    expect(
      validationDetail({ ...boundaryPlan, title: 't'.repeat(121) }),
    ).toBe('actionPlan.title is too long')
    expect(
      validationDetail({ ...boundaryPlan, summary: 's'.repeat(1001) }),
    ).toBe('actionPlan.summary is too long')
    expect(
      validationDetail({
        ...boundaryPlan,
        actions: [...boundaryPlan.actions, boundaryAction],
      }),
    ).toBe('actionPlan must contain 1 to 12 actions')
    expect(
      validationDetail({
        ...boundaryPlan,
        actions: [{ ...boundaryAction, targetSets: 21 }],
      }),
    ).toContain('targetSets must be a whole number from 1 to 20')
  })

  it('uses only the context-derived fingerprint for the selected scope', () => {
    const actionStateHashes = {
      active_workout: 'a'.repeat(64),
      one_time_workout: 'b'.repeat(64),
      program: 'c'.repeat(64),
      exercise_library: 'd'.repeat(64),
      ai_memory: 'e'.repeat(64),
    }
    const contextJson = JSON.stringify({ actionStateHashes })
    for (const [scope, expected] of Object.entries(actionStateHashes)) {
      expect(
        trustedActionStateHash(
          contextJson,
          scope as keyof typeof actionStateHashes,
        ),
      ).toBe(expected)
    }
    expect(() =>
      trustedActionStateHash(
        JSON.stringify({
          actionStateHashes: { ...actionStateHashes, program: 'not-a-hash' },
        }),
        'program',
      ),
    ).toThrow('action_state_hash_unavailable')
  })

  it.each([
    [
      'different active sessions',
      {
        title: 'Update workout',
        summary: 'Update two sessions.',
        scope: 'active_workout',
        actions: [
          {
            type: 'update_active_exercise_targets',
            sessionId: 'session-1',
            exerciseId: 'exercise-1',
            targetSets: 3,
            repRange: '8-10',
          },
          {
            type: 'update_active_exercise_targets',
            sessionId: 'session-2',
            exerciseId: 'exercise-2',
            targetSets: 3,
            repRange: '8-10',
          },
        ],
      },
    ],
    [
      'program action under exercise-library scope',
      {
        title: 'Wrong scope',
        summary: 'This scope does not match.',
        scope: 'exercise_library',
        actions: [{ type: 'archive_program', programId: 'program-1' }],
      },
    ],
    [
      'exercise-library action under program scope',
      {
        title: 'Wrong scope',
        summary: 'This scope does not match.',
        scope: 'program',
        actions: [
          {
            type: 'create_custom_exercise',
            name: 'Cable Y Raise',
            primaryMuscle: 'shoulders',
            secondaryMuscles: [],
            notes: '',
            defaultRestSeconds: 90,
          },
        ],
      },
    ],
    [
      'multiple program actions',
      {
        title: 'Too broad',
        summary: 'This changes two program entities.',
        scope: 'program',
        actions: [
          { type: 'archive_program', programId: 'program-1' },
          { type: 'archive_program', programId: 'program-2' },
        ],
      },
    ],
  ])('rejects invalid scope semantics: %s', (_label, plan) => {
    expect(() => validateActionPlan(plan)).toThrow()
  })

  it.each([
    [
      'duplicate replacement names',
      {
        type: 'replace_program',
        programId: 'program-1',
        name: 'Replacement',
        sessions: [
          {
            sessionTemplateId: 'session-template-1',
            name: 'Push',
            exercises: [plannedExercise],
          },
          {
            sessionTemplateId: 'session-template-2',
            name: 'push',
            exercises: [{ ...plannedExercise, exerciseId: 'exercise-2' }],
          },
        ],
      },
    ],
    [
      'duplicate replacement IDs',
      {
        type: 'replace_program',
        programId: 'program-1',
        name: 'Replacement',
        sessions: [
          {
            sessionTemplateId: 'session-template-1',
            name: 'Push',
            exercises: [plannedExercise],
          },
          {
            sessionTemplateId: 'session-template-1',
            name: 'Pull',
            exercises: [{ ...plannedExercise, exerciseId: 'exercise-2' }],
          },
        ],
      },
    ],
    [
      'missing replacement ID field',
      {
        type: 'replace_program',
        programId: 'program-1',
        name: 'Replacement',
        sessions: [
          { name: 'Push', exercises: [plannedExercise] },
        ],
      },
    ],
    [
      'unsupported muscle',
      {
        type: 'create_custom_exercise',
        name: 'Cable Y Raise',
        primaryMuscle: 'neck',
        secondaryMuscles: [],
        notes: '',
        defaultRestSeconds: 90,
      },
    ],
    [
      'primary repeated as secondary',
      {
        type: 'create_custom_exercise',
        name: 'Cable Y Raise',
        primaryMuscle: 'shoulders',
        secondaryMuscles: ['shoulders'],
        notes: '',
        defaultRestSeconds: 90,
      },
    ],
    [
      'duplicate secondary muscle',
      {
        type: 'create_custom_exercise',
        name: 'Cable Y Raise',
        primaryMuscle: 'shoulders',
        secondaryMuscles: ['traps', 'traps'],
        notes: '',
        defaultRestSeconds: 90,
      },
    ],
    [
      'rest duration below client minimum',
      {
        type: 'create_custom_exercise',
        name: 'Cable Y Raise',
        primaryMuscle: 'shoulders',
        secondaryMuscles: [],
        notes: '',
        defaultRestSeconds: 0,
      },
    ],
    [
      'oversized custom-exercise notes',
      {
        type: 'create_custom_exercise',
        name: 'Cable Y Raise',
        primaryMuscle: 'shoulders',
        secondaryMuscles: [],
        notes: 'x'.repeat(2001),
        defaultRestSeconds: 90,
      },
    ],
  ])('rejects malformed action payloads: %s', (_label, action) => {
    const scope = action.type === 'create_custom_exercise'
      ? 'exercise_library'
      : 'program'
    expect(() =>
      validateActionPlan({
        title: 'Malformed action',
        summary: 'This should not be persisted.',
        scope,
        actions: [action],
      }),
    ).toThrow()
  })

  it.each([
    ['array root', []],
    ['blank title', { ...validPlan, title: '  ' }],
    ['blank summary', { ...validPlan, summary: '' }],
    ['no actions', { ...validPlan, actions: [] }],
    [
      'blank action text',
      { ...validPlan, actions: [{ type: 'save_ai_note', body: '  ' }] },
    ],
    [
      'scope mismatch',
      { ...validPlan, scope: 'program' },
    ],
    [
      'invalid target',
      {
        title: 'Update',
        summary: 'Update target.',
        scope: 'active_workout',
        actions: [
          {
            type: 'update_active_exercise_targets',
            sessionId: 'session-1',
            exerciseId: 'exercise-1',
            targetSets: 0,
            repRange: '8-10',
          },
        ],
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(() => validateActionPlan(value)).toThrow()
  })
})
