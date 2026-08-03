import { afterEach, describe, expect, it, vi } from 'vitest'
import { CoachApiError, reserveCoachProposal } from './chatApi'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Coach API errors', () => {
  it('preserves a reservation conflict status and code for forced refresh handling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: 'proposal_reserved',
            detail: 'Reserved by another paired device.',
          }),
          {
            status: 409,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    )

    let caught: unknown
    try {
      await reserveCoachProposal('proposal-1', 20)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CoachApiError)
    expect(caught).toMatchObject({
      status: 409,
      code: 'proposal_reserved',
      detail: 'Reserved by another paired device.',
    })
  })
})
