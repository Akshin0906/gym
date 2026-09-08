/**
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { db } from '../db/schema'
import { createCustomExercise } from '../db/repositories/exercises'
import { logSet, recordPreWorkoutCheckIn } from '../db/repositories/sessions'
import type { LoadConvention, LoggedSet } from '../db/types'
import { SetLogger } from './SetLogger'

const SESSION_ID = 'set-logger-session'

async function seed(convention?: LoadConvention) {
  const exerciseId = await createCustomExercise({
    name: 'Cable Lateral Raise',
    primaryMuscle: 'shoulders',
    secondaryMuscles: [],
    notes: '',
    defaultRestSeconds: 75,
    hiddenFromLibrary: false,
    ...(convention ? { measurement: { loadConvention: convention } } : {}),
  })
  await db.workoutSessions.add({
    id: SESSION_ID,
    sessionTemplateId: null,
    programId: null,
    name: 'Pull',
    programName: null,
    exerciseSnapshot: [
      {
        exerciseId,
        order: 0,
        targetSets: 3,
        targetRepRange: '12-15',
        loadConvention: convention ?? 'unknown',
      },
    ],
    startedAt: 1_000,
    completedAt: null,
    preWorkoutCheckIn: null,
  })
  await recordPreWorkoutCheckIn(SESSION_ID, 7)
  return exerciseId
}

async function currentSets(exerciseId: string): Promise<LoggedSet[]> {
  const rows = await db.loggedSets
    .where('workoutSessionId')
    .equals(SESSION_ID)
    .toArray()
  return rows
    .filter((row) => row.exerciseId === exerciseId)
    .sort((a, b) => a.setNumber - b.setNumber)
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('SetLogger set classification (browser)', () => {
  it('reclassifies an existing set as a warm-up through the edit form', async () => {
    const exerciseId = await seed()
    const logged = await logSet({
      sessionId: SESSION_ID,
      exerciseId,
      weightLbs: 20,
      reps: 12,
      rpe: 8,
    })
    const onChange = vi.fn()

    const { rerender } = render(
      <SetLogger
        sessionId={SESSION_ID}
        exerciseId={exerciseId}
        existingSets={await currentSets(exerciseId)}
        previousSets={[]}
        defaultRestSeconds={75}
        onChange={onChange}
      />,
    )

    // Not a warm-up yet, so no badge.
    expect(screen.queryByText('Warm-up')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /edit set/i }))
    await userEvent.click(
      screen.getByRole('checkbox', { name: /^warm-up set/i }),
    )
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(async () => {
      expect((await db.loggedSets.get(logged.id))?.setKind).toBe('warmup')
    })
    expect(onChange).toHaveBeenCalled()

    // And the row now says so.
    rerender(
      <SetLogger
        sessionId={SESSION_ID}
        exerciseId={exerciseId}
        existingSets={await currentSets(exerciseId)}
        previousSets={[]}
        defaultRestSeconds={75}
        onChange={onChange}
      />,
    )
    expect(screen.getByText('Warm-up')).toBeTruthy()
  })

  it('reclassifies a warm-up back to a working set', async () => {
    const exerciseId = await seed()
    const logged = await logSet({
      sessionId: SESSION_ID,
      exerciseId,
      weightLbs: 20,
      reps: 12,
      rpe: 8,
      setKind: 'warmup',
    })

    render(
      <SetLogger
        sessionId={SESSION_ID}
        exerciseId={exerciseId}
        existingSets={await currentSets(exerciseId)}
        previousSets={[]}
        defaultRestSeconds={75}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByText('Warm-up')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /edit set/i }))
    const checkbox = screen.getByRole('checkbox', { name: /^warm-up set/i })
    expect((checkbox as HTMLInputElement).checked).toBe(true)
    await userEvent.click(checkbox)
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(async () => {
      expect((await db.loggedSets.get(logged.id))?.setKind).toBe('working')
    })
  })

  it('logs a new set as a warm-up when the box is ticked', async () => {
    const exerciseId = await seed()

    render(
      <SetLogger
        sessionId={SESSION_ID}
        exerciseId={exerciseId}
        existingSets={[]}
        previousSets={[]}
        defaultRestSeconds={75}
        onChange={vi.fn()}
      />,
    )

    await userEvent.type(screen.getByLabelText(/weight in pounds/i), '20')
    await userEvent.type(screen.getByLabelText(/^reps$/i), '12')
    await userEvent.click(
      screen.getByRole('checkbox', { name: /log as warm-up set/i }),
    )
    await userEvent.click(screen.getByRole('button', { name: /log set/i }))

    await waitFor(async () => {
      expect((await currentSets(exerciseId))[0]?.setKind).toBe('warmup')
    })
  })

  it('labels the load field for the session’s measurement', async () => {
    const exerciseId = await seed('assistance')

    render(
      <SetLogger
        sessionId={SESSION_ID}
        exerciseId={exerciseId}
        existingSets={[]}
        previousSets={[]}
        defaultRestSeconds={75}
        loadConvention="assistance"
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByLabelText(/assistance weight in pounds/i)).toBeTruthy()
    // Zero is a real value here, so the input must allow it.
    expect(
      screen.getByLabelText(/assistance weight in pounds/i).getAttribute('min'),
    ).toBe('0')
  })

  it('labels the edit field for the row’s own measurement and saves a zero', async () => {
    // The edit form hardcoded "Weight in pounds" regardless of what the row
    // actually recorded, so an assistance set was labelled as total load and
    // its input refused the zero that is legitimate for it.
    const exerciseId = await seed('assistance')
    const logged = await logSet({
      sessionId: SESSION_ID,
      exerciseId,
      weightLbs: 40,
      reps: 8,
      rpe: null,
    })

    render(
      <SetLogger
        sessionId={SESSION_ID}
        exerciseId={exerciseId}
        existingSets={await currentSets(exerciseId)}
        previousSets={[]}
        defaultRestSeconds={75}
        loadConvention="assistance"
        onChange={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /edit set/i }))
    // Scoped to the edit row: the new-set form below has its own weight field.
    const editRow = within(screen.getByRole('listitem'))
    const field = editRow.getByLabelText(/assistance weight in pounds/i)
    expect(field.getAttribute('min')).toBe('0')
    expect(editRow.queryByLabelText(/^weight in pounds$/i)).toBeNull()

    await userEvent.clear(field)
    await userEvent.type(field, '0')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(async () => {
      expect((await db.loggedSets.get(logged.id))?.weightLbs).toBe(0)
    })
  })

  it('labels the edit field from the row, not the current session plan', async () => {
    // A legacy row keeps its own reading even inside a session whose plan has
    // since been given a convention.
    const exerciseId = await seed('machine_setting')
    await db.loggedSets.add({
      id: 'legacy',
      workoutSessionId: SESSION_ID,
      exerciseId,
      setNumber: 1,
      weightLbs: 100,
      reps: 8,
      rpe: null,
      loggedAt: 1_500,
    })

    render(
      <SetLogger
        sessionId={SESSION_ID}
        exerciseId={exerciseId}
        existingSets={await currentSets(exerciseId)}
        previousSets={[]}
        defaultRestSeconds={75}
        loadConvention="machine_setting"
        onChange={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /edit set/i }))
    // The row froze nothing, so it reads as plain pounds and refuses 0, even
    // though the surrounding session plan is a machine setting.
    const editRow = within(screen.getByRole('listitem'))
    const field = editRow.getByLabelText(/^weight in pounds$/i)
    expect(field.getAttribute('min')).toBeNull()
    expect(editRow.queryByLabelText(/machine setting/i)).toBeNull()
  })

  it('does not prefill from a prior session with an incompatible measurement', async () => {
    const exerciseId = await seed('total')
    const previous: LoggedSet[] = [
      {
        id: 'prev',
        workoutSessionId: 'older-session',
        exerciseId,
        setNumber: 1,
        weightLbs: 60,
        reps: 8,
        rpe: null,
        loggedAt: 1,
        loadConvention: 'assistance',
      },
    ]

    render(
      <SetLogger
        sessionId={SESSION_ID}
        exerciseId={exerciseId}
        existingSets={[]}
        previousSets={previous}
        defaultRestSeconds={75}
        loadConvention="total"
        onChange={vi.fn()}
      />,
    )

    // Carrying 60 lb of assistance into a total-load field would be wrong.
    expect(
      (screen.getByLabelText(/weight in pounds/i) as HTMLInputElement).value,
    ).toBe('')
    expect(screen.getByText(/different measurement/i)).toBeTruthy()
    expect(screen.getByText(/shown for reference only/i)).toBeTruthy()
    // The hint itself is labelled with its units.
    expect(screen.getByText(/lb assist/i)).toBeTruthy()
  })

  it('still prefills from a comparable prior session', async () => {
    const exerciseId = await seed('total')
    const previous: LoggedSet[] = [
      {
        id: 'prev',
        workoutSessionId: 'older-session',
        exerciseId,
        setNumber: 1,
        weightLbs: 95,
        reps: 8,
        rpe: null,
        loggedAt: 1,
        loadConvention: 'total',
      },
    ]

    render(
      <SetLogger
        sessionId={SESSION_ID}
        exerciseId={exerciseId}
        existingSets={[]}
        previousSets={previous}
        defaultRestSeconds={75}
        loadConvention="total"
        onChange={vi.fn()}
      />,
    )

    expect(
      (screen.getByLabelText(/weight in pounds/i) as HTMLInputElement).value,
    ).toBe('95')
    expect(screen.queryByText(/different measurement/i)).toBeNull()
  })
})
