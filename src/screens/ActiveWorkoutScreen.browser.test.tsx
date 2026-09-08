/**
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { db } from '../db/schema'
import { createCustomExercise } from '../db/repositories/exercises'
import {
  addSessionTemplate,
  addTemplateExercise,
  createProgram,
  setProgramActive,
} from '../db/repositories/programs'
import {
  logSet,
  recordPreWorkoutCheckIn,
  startSession,
} from '../db/repositories/sessions'
import { useActiveWorkout } from '../store/activeWorkout'
import { ActiveWorkoutScreen } from './ActiveWorkoutScreen'

vi.mock('../lib/cloud', async () => {
  const actual = await vi.importActual<typeof import('../lib/cloud')>(
    '../lib/cloud',
  )
  return {
    ...actual,
    isCloudConfigured: () => false,
    syncPendingLocalChanges: vi.fn().mockResolvedValue('not_paired'),
  }
})

async function seedSession(): Promise<{ sessionId: string; exerciseId: string }> {
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
    targetSets: 3,
    targetRepRange: '12-15',
  })
  await setProgramActive(programId)
  const template = await db.sessionTemplates.get(templateId)
  const program = await db.programs.get(programId)
  const sessionId = await startSession(template!, { ...program!, isActive: true })
  await recordPreWorkoutCheckIn(sessionId, 7)
  return { sessionId, exerciseId }
}

// ActiveWorkoutScreen uses useBlocker for its unsaved-changes guard, which
// requires a data router rather than the plain MemoryRouter.
function renderScreen() {
  const router = createMemoryRouter(
    [{ path: '/', element: <ActiveWorkoutScreen /> }],
    { initialEntries: ['/'] },
  )
  return render(<RouterProvider router={router} />)
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
  localStorage.clear()
  useActiveWorkout.setState({ sessionId: null })
})

describe('Active workout planned progress (browser)', () => {
  it('does not count a warm-up towards the planned working sets', async () => {
    // The reported regression: logging one warm-up immediately showed
    // "1/3 sets", claiming a work-set target was partly met.
    const { sessionId, exerciseId } = await seedSession()
    await logSet({
      sessionId,
      exerciseId,
      weightLbs: 20,
      reps: 10,
      rpe: null,
      setKind: 'warmup',
    })
    useActiveWorkout.setState({ sessionId })

    renderScreen()

    const progress = await screen.findByText(/0\/3/)
    expect(progress).toBeTruthy()
    expect(progress.parentElement?.textContent).toContain('1 warm-up')

    // The ring's accessible name is the same claim in words.
    expect(screen.getByRole('img', { name: '0 of 3' })).toBeTruthy()
  })

  it('counts a working set towards the planned target', async () => {
    const { sessionId, exerciseId } = await seedSession()
    await logSet({
      sessionId,
      exerciseId,
      weightLbs: 20,
      reps: 13,
      rpe: null,
      setKind: 'working',
    })
    useActiveWorkout.setState({ sessionId })

    renderScreen()

    expect(await screen.findByText(/1\/3/)).toBeTruthy()
    expect(screen.getByRole('img', { name: '1 of 3' })).toBeTruthy()
  })

  it('treats an unclassified legacy set as working, as every chart already did', async () => {
    const { sessionId, exerciseId } = await seedSession()
    await logSet({ sessionId, exerciseId, weightLbs: 20, reps: 13, rpe: null })
    useActiveWorkout.setState({ sessionId })

    renderScreen()

    expect(await screen.findByText(/1\/3/)).toBeTruthy()
  })
})
