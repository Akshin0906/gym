/**
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { db } from '../db/schema'
import { createProgram, addSessionTemplate, setProgramActive } from '../db/repositories/programs'
import { startSession } from '../db/repositories/sessions'
import { TodayScreen } from './TodayScreen'

const navigate = vi.fn()
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>(
    'react-router',
  )
  return { ...actual, useNavigate: () => navigate }
})

// The briefing card owns its own cloud fetches; this suite is about the screen's
// ordering and entry actions, so the network is stubbed out entirely.
vi.mock('../lib/cloud', async () => {
  const actual = await vi.importActual<typeof import('../lib/cloud')>(
    '../lib/cloud',
  )
  return {
    ...actual,
    fetchLatestCloudBriefing: vi.fn().mockResolvedValue(null),
    isCloudConfigured: () => false,
    syncPendingLocalChanges: vi.fn().mockResolvedValue('not_paired'),
  }
})

function renderToday() {
  return render(
    <MemoryRouter>
      <TodayScreen />
    </MemoryRouter>,
  )
}

// Reads the rendered DOM order of the main cards, which is the actual claim:
// the workout has to come before the briefing, Coach, and note cards.
function cardOrder(): string[] {
  const order: string[] = []
  const root = document.body
  const primary = root.querySelector('#today-primary-heading')
  const coach = screen.queryByRole('button', { name: /ask coach/i })
  const note = screen.queryByText(/note for ai/i)
  const nodes: Array<[string, Element | null]> = [
    ['primary', primary],
    ['coach', coach],
    ['note', note],
  ]
  const present = nodes.filter((entry): entry is [string, Element] =>
    entry[1] !== null,
  )
  present.sort((a, b) =>
    a[1].compareDocumentPosition(b[1]) & Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1,
  )
  for (const [name] of present) order.push(name)
  return order
}

beforeEach(async () => {
  navigate.mockReset()
  await Promise.all(db.tables.map((table) => table.clear()))
  localStorage.clear()
})

describe('Today screen (browser)', () => {
  it('shows a create-program entry action on a fresh install', async () => {
    renderToday()

    const heading = await screen.findByRole('heading', {
      name: 'Create a program',
    })
    expect(heading).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /create a program/i }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /start empty workout/i }),
    ).toBeTruthy()
  })

  it('routes the fresh-install action to the programs screen', async () => {
    renderToday()
    await screen.findByRole('heading', { name: 'Create a program' })

    await userEvent.click(
      screen.getByRole('button', { name: /create a program/i }),
    )

    expect(navigate).toHaveBeenCalledWith('/programs')
  })

  it('offers only one empty-workout action on a fresh install', async () => {
    renderToday()
    await screen.findByRole('heading', { name: 'Create a program' })

    expect(
      screen.getAllByRole('button', { name: /start empty workout/i }),
    ).toHaveLength(1)
  })

  it('puts the next workout above the briefing, Coach, and note cards', async () => {
    const programId = await createProgram('Upper/Lower')
    await addSessionTemplate(programId, 'Upper A')
    await setProgramActive(programId)

    renderToday()
    await screen.findByRole('heading', { name: 'Upper A' })

    expect(cardOrder()[0]).toBe('primary')
    expect(cardOrder()).toContain('coach')
  })

  it('puts an in-progress workout first and resumes it', async () => {
    const programId = await createProgram('Upper/Lower')
    const templateId = await addSessionTemplate(programId, 'Upper A')
    await setProgramActive(programId)
    const template = await db.sessionTemplates.get(templateId)
    const program = await db.programs.get(programId)
    await startSession(template!, { ...program!, isActive: true })

    renderToday()
    const resume = await screen.findByRole('button', { name: /resume/i })

    expect(cardOrder()[0]).toBe('primary')
    await userEvent.click(resume)
    expect(navigate).toHaveBeenCalledWith('/workout')
  })

  it('offers a retry instead of a permanent skeleton when the read fails', async () => {
    const original = db.workoutSessions.filter.bind(db.workoutSessions)
    let calls = 0
    const spy = vi
      .spyOn(db.workoutSessions, 'filter')
      .mockImplementation((...args: Parameters<typeof original>) => {
        calls += 1
        if (calls === 1) {
          return {
            toArray: () => Promise.reject(new Error('IndexedDB unavailable')),
          } as unknown as ReturnType<typeof original>
        }
        return original(...args)
      })

    renderToday()

    const retry = await screen.findByRole('button', { name: /try again/i })
    expect(
      screen.getByRole('alert').textContent,
    ).toContain('IndexedDB unavailable')

    spy.mockRestore()
    await userEvent.click(retry)
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /try again/i }),
      ).toBeNull(),
    )
    expect(
      within(document.body).getByRole('heading', { name: 'Create a program' }),
    ).toBeTruthy()
  })
})
