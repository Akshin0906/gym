/**
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { db } from '../db/schema'
import {
  addSessionTemplate,
  addTemplateExercise,
  createProgram,
  setProgramActive,
} from '../db/repositories/programs'
import { createCustomExercise } from '../db/repositories/exercises'
import {
  endSession,
  getResumableSession,
  getSetsForSession,
  logSet,
  recordPreWorkoutCheckIn,
  startSession,
  updateSet,
} from '../db/repositories/sessions'
import {
  buildExportPayload,
  importPayload,
} from '../db/repositories/exportImport'
import {
  getLocalSyncState,
  hasPendingLocalChanges,
} from '../db/repositories/syncState'
import { SessionDetailScreen } from '../screens/SessionDetailScreen'
import {
  recoverCloudSnapshot,
  syncPendingLocalChanges,
  uploadCloudSnapshot,
} from './cloud'
import type { CoachActionResult } from './chatTypes'

const routeParams: { sessionId?: string } = {}
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>(
    'react-router',
  )
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => routeParams,
  }
})

interface CloudStub {
  updatedAt: number
  puts: number
  offline: boolean
  bodies: unknown[]
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// A local stand-in for the Pages/D1 snapshot endpoint. Never touches a real
// service: it holds one in-memory version counter and echoes it back, which is
// all the compare-and-swap path needs.
function installCloudStub(): CloudStub {
  const state: CloudStub = {
    updatedAt: 0,
    puts: 0,
    offline: false,
    bodies: [],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      if (state.offline) throw new TypeError('Failed to fetch')
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === '/api/cloud/snapshot' && method === 'GET') {
        return state.updatedAt === 0
          ? jsonResponse({ error: 'snapshot_not_found' }, 404)
          : jsonResponse({ snapshot: { updatedAt: state.updatedAt } })
      }
      if (url === '/api/cloud/snapshot' && method === 'PUT') {
        state.puts += 1
        state.updatedAt += 1000
        state.bodies.push(JSON.parse(String(init?.body)))
        return jsonResponse({ snapshot: { updatedAt: state.updatedAt } })
      }
      if (url === '/api/auth/cloud') {
        return jsonResponse({ paired: true, device: null })
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    }),
  )
  return state
}

async function seedProgramWorkout(): Promise<{
  sessionId: string
  exerciseId: string
}> {
  const exerciseId = await createCustomExercise({
    name: 'Cable Lateral Raise',
    primaryMuscle: 'shoulders',
    secondaryMuscles: [],
    notes: '',
    defaultRestSeconds: 75,
    hiddenFromLibrary: false,
  })
  const programId = await createProgram('Upper/Lower')
  const templateId = await addSessionTemplate(programId, 'Upper A')
  await addTemplateExercise({
    sessionTemplateId: templateId,
    exerciseId,
    targetSets: 4,
    targetRepRange: '12-15',
  })
  await setProgramActive(programId)
  const template = await db.sessionTemplates.get(templateId)
  const program = await db.programs.get(programId)
  const sessionId = await startSession(template!, {
    ...program!,
    isActive: true,
  })
  await recordPreWorkoutCheckIn(sessionId, 7)
  return { sessionId, exerciseId }
}

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
  localStorage.clear()
  localStorage.setItem('workout-tracker:cloudAuthPaired', '1')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('workout reload and resume', () => {
  it('resumes the same session and its sets after the database is reopened', async () => {
    const { sessionId, exerciseId } = await seedProgramWorkout()
    await logSet({ sessionId, exerciseId, weightLbs: 20, reps: 13, rpe: 8 })
    await logSet({ sessionId, exerciseId, weightLbs: 20, reps: 12, rpe: 9 })

    // "Reload": drop every in-memory handle and reopen from IndexedDB.
    db.close()
    await db.open()

    const resumable = await getResumableSession()
    expect(resumable?.id).toBe(sessionId)
    const sets = await getSetsForSession(sessionId)
    expect(sets.map((s) => s.setNumber)).toEqual([1, 2])
    expect(sets.map((s) => s.reps)).toEqual([13, 12])
  })
})

describe('offline completion and reconnect', () => {
  it('keeps the completed workout pending offline and uploads it on reconnect', async () => {
    const { sessionId, exerciseId } = await seedProgramWorkout()
    const cloud = installCloudStub()
    await syncPendingLocalChanges()
    expect(cloud.puts).toBe(1)

    cloud.offline = true
    await logSet({ sessionId, exerciseId, weightLbs: 20, reps: 13, rpe: 8 })
    await endSession(sessionId)
    await expect(
      uploadCloudSnapshot('workout_completed'),
    ).rejects.toThrow('Failed to fetch')

    expect(await hasPendingLocalChanges()).toBe(true)
    expect(cloud.puts).toBe(1)

    cloud.offline = false
    await expect(recoverCloudSnapshot()).resolves.toBe(true)
    expect(cloud.puts).toBe(2)
    expect(await hasPendingLocalChanges()).toBe(false)

    const uploaded = cloud.bodies.at(-1) as {
      data: { workoutSessions: Array<{ id: string; completedAt: number | null }> }
    }
    expect(
      uploaded.data.workoutSessions.find((s) => s.id === sessionId)?.completedAt,
    ).toBeTypeOf('number')
  })
})

describe('history corrections', () => {
  it('uploads a corrected historical set that changes no workout timestamp', async () => {
    const { sessionId, exerciseId } = await seedProgramWorkout()
    const logged = await logSet({
      sessionId,
      exerciseId,
      weightLbs: 20,
      reps: 10,
      rpe: 8,
    })
    await endSession(sessionId)
    const cloud = installCloudStub()
    await syncPendingLocalChanges()
    const completedBefore = (await db.workoutSessions.get(sessionId))
      ?.completedAt
    expect(cloud.puts).toBe(1)

    await updateSet(logged.id, { reps: 14 })

    // The completed-workout count and timestamp are untouched — the exact case
    // the old recovery heuristic could not see.
    const completedAfter = (await db.workoutSessions.get(sessionId))?.completedAt
    expect(completedAfter).toBe(completedBefore)
    expect(await db.workoutSessions.count()).toBe(1)

    await expect(recoverCloudSnapshot()).resolves.toBe(true)
    expect(cloud.puts).toBe(2)
    const uploaded = cloud.bodies.at(-1) as {
      data: { loggedSets: Array<{ id: string; reps: number }> }
    }
    expect(
      uploaded.data.loggedSets.find((s) => s.id === logged.id)?.reps,
    ).toBe(14)
  })

  it('renders the corrected value and its attainment on the session screen', async () => {
    const { sessionId, exerciseId } = await seedProgramWorkout()
    const logged = await logSet({
      sessionId,
      exerciseId,
      weightLbs: 20,
      reps: 10,
      rpe: 8,
    })
    await endSession(sessionId)
    await updateSet(logged.id, { reps: 14 })
    routeParams.sessionId = sessionId

    render(
      <MemoryRouter>
        <SessionDetailScreen />
      </MemoryRouter>,
    )

    await screen.findByText('Planned vs performed')
    expect(screen.getByText(/1 of 4 planned/)).toBeTruthy()
    expect(screen.getByText(/3 planned sets not logged/)).toBeTruthy()
    expect(screen.getByText('12–15 reps')).toBeTruthy()
    expect(screen.getByText(/1 in range/)).toBeTruthy()
  })

  it('records an optional reason for unfinished planned work', async () => {
    const { sessionId, exerciseId } = await seedProgramWorkout()
    await logSet({ sessionId, exerciseId, weightLbs: 20, reps: 13, rpe: 8 })
    await endSession(sessionId)
    routeParams.sessionId = sessionId

    render(
      <MemoryRouter>
        <SessionDetailScreen />
      </MemoryRouter>,
    )

    const button = await screen.findByRole('button', {
      name: /ran out of time/i,
    })
    await userEvent.click(button)

    await waitFor(async () => {
      expect(
        (await db.workoutSessions.get(sessionId))?.unfinishedWork,
      ).toMatchObject({ version: 1, reason: 'time' })
    })
    // The logged history is untouched by recording context.
    expect(await db.loggedSets.count()).toBe(1)
  })
})

describe('backup restore', () => {
  it('restores a backup and leaves the mirror pending until it uploads', async () => {
    const { sessionId, exerciseId } = await seedProgramWorkout()
    await logSet({ sessionId, exerciseId, weightLbs: 20, reps: 13, rpe: 8 })
    await endSession(sessionId)
    const backup = await buildExportPayload()

    const cloud = installCloudStub()
    await syncPendingLocalChanges()
    expect(await hasPendingLocalChanges()).toBe(false)

    // Wipe and restore, the way Settings does.
    await Promise.all(db.tables.map((table) => table.clear()))
    const result = await importPayload(JSON.stringify(backup))

    expect(result.imported.loggedSets).toBe(1)
    expect(result.renamedExerciseCount).toBe(0)
    expect((await db.workoutSessions.get(sessionId))?.completedAt).toBeTypeOf(
      'number',
    )
    const state = await getLocalSyncState()
    expect(state.localRevision).toBeGreaterThan(state.syncedRevision)

    await expect(syncPendingLocalChanges()).resolves.toBe('uploaded')
    expect(cloud.puts).toBe(2)
  })
})

describe('Coach confirmation retry', () => {
  it('does not let a generic sync publish while a Coach receipt is pending', async () => {
    const { sessionId, exerciseId } = await seedProgramWorkout()
    await logSet({ sessionId, exerciseId, weightLbs: 20, reps: 13, rpe: 8 })
    const cloud = installCloudStub()
    await syncPendingLocalChanges()

    const result: CoachActionResult = {
      proposalId: 'proposal-1',
      appliedAt: 5,
      sourceStateHash: 'a'.repeat(64),
      replayed: false,
      syncPending: true,
      changes: [{ type: 'save_ai_note', label: 'Saved a note' }],
    }
    await db.chatActionReceipts.add({
      proposalId: result.proposalId,
      appliedAt: result.appliedAt,
      sourceStateHash: result.sourceStateHash,
      resultJson: JSON.stringify(result),
    })
    await logSet({ sessionId, exerciseId, weightLbs: 20, reps: 12, rpe: 9 })

    await expect(syncPendingLocalChanges()).resolves.toBe(
      'deferred_coach_reservation',
    )
    expect(cloud.puts).toBe(1)

    // The Coach's own reservation-aware upload still goes through, and a retry
    // of it is idempotent against the same receipt.
    await uploadCloudSnapshot('chat_action_applied')
    await uploadCloudSnapshot('chat_action_applied')
    expect(cloud.puts).toBe(3)
    expect(await db.chatActionReceipts.count()).toBe(1)
  })

  it('sends the Coach reservation protocol headers on a Coach upload', async () => {
    await seedProgramWorkout()
    installCloudStub()
    await uploadCloudSnapshot('chat_action_applied')

    const fetchMock = vi.mocked(fetch)
    const put = fetchMock.mock.calls.find(
      ([, init]) => (init?.method ?? '').toUpperCase() === 'PUT',
    )
    const headers = new Headers(put?.[1]?.headers)
    expect(headers.get('X-Coach-Protocol')).toBe('proposal-reservation-v1')
    expect(headers.get('X-Snapshot-Trigger')).toBe('chat_action_applied')
  })
})
