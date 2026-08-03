import { describe, expect, it, vi } from 'vitest'
import type { CoachActionResult, CoachProposal } from './chatTypes'
import {
  applyReservedCoachProposal,
  clearCoachConversationAndRefresh,
  coachReceiptMatchesActionPlan,
  CoachReceiptAdoptionError,
  CoachMutationGate,
  CoachProposalUnavailableError,
  CoachRemoteRequestGate,
  CoachSendRetryBuffer,
  finalizeFailedCoachProposal,
  resolveCoachClearRecoveryError,
  syncCoachActionReceipts,
} from './coachConversationLifecycle'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function proposal(
  overrides: Partial<CoachProposal> = {},
): CoachProposal {
  return {
    id: 'proposal-1',
    messageId: 'message-1',
    jobId: 'job-1',
    status: 'proposed',
    actionPlan: { title: 'Current plan' },
    createdAt: 10,
    updatedAt: 20,
    result: null,
    reserved: false,
    reservedAt: null,
    ...overrides,
  }
}

describe('Coach conversation request lifecycle', () => {
  it('ignores a late pre-clear response and always starts a fresh post-delete read', async () => {
    const gate = new CoachRemoteRequestGate()
    const oldTicket = gate.begin()
    expect(oldTicket).not.toBeNull()
    if (!oldTicket) throw new Error('missing old request ticket')

    const oldResponse = deferred<string>()
    const committed: string[] = []
    const oldRead = oldResponse.promise.then((value) => {
      if (gate.isCurrent(oldTicket)) committed.push(value)
      gate.finish(oldTicket)
    })
    const events: string[] = []

    await clearCoachConversationAndRefresh({
      gate,
      prepare: async () => {
        events.push('prepare')
        expect(oldTicket.signal.aborted).toBe(true)
        expect(gate.begin()).toBeNull()
        oldResponse.resolve('stale transcript')
        await oldRead
      },
      clearRemote: async () => {
        events.push('delete')
      },
      resetLocal: () => {
        events.push('reset')
      },
      refreshFresh: async () => {
        events.push('refresh')
        const freshTicket = gate.begin()
        expect(freshTicket).not.toBeNull()
        if (!freshTicket) throw new Error('missing fresh request ticket')
        expect(gate.isCurrent(freshTicket)).toBe(true)
        committed.push('fresh transcript')
        gate.finish(freshTicket)
      },
    })

    expect(events).toEqual(['prepare', 'delete', 'reset', 'refresh'])
    expect(committed).toEqual(['fresh transcript'])
  })

  it('unblocks future reads when delete preparation fails', async () => {
    const gate = new CoachRemoteRequestGate()

    await expect(
      clearCoachConversationAndRefresh({
        gate,
        prepare: async () => {
          throw new Error('sync failed')
        },
        clearRemote: vi.fn(),
        resetLocal: vi.fn(),
        refreshFresh: vi.fn(),
      }),
    ).rejects.toThrow('sync failed')

    expect(gate.begin()).not.toBeNull()
  })

  it('keeps clear and proposal mutations mutually exclusive', () => {
    const gate = new CoachMutationGate()
    const proposalTicket = gate.begin('proposal')
    expect(proposalTicket).not.toBeNull()
    expect(gate.busy).toBe(true)
    expect(gate.begin('clear')).toBeNull()

    if (!proposalTicket) throw new Error('missing proposal mutation ticket')
    gate.finish(proposalTicket)
    const clearTicket = gate.begin('clear')
    expect(clearTicket).not.toBeNull()
    expect(gate.begin('proposal')).toBeNull()

    if (!clearTicket) throw new Error('missing clear mutation ticket')
    gate.finish(clearTicket)
    expect(gate.busy).toBe(false)

    const cancelTicket = gate.begin('cancel')
    expect(cancelTicket).not.toBeNull()
    expect(gate.begin('clear')).toBeNull()
    expect(gate.begin('proposal')).toBeNull()
    if (!cancelTicket) throw new Error('missing cancel mutation ticket')
    gate.finish(cancelTicket)
  })

  it('keeps a prepare or delete error visible after transcript recovery', () => {
    expect(
      resolveCoachClearRecoveryError({
        remoteCleared: false,
        recovered: true,
        operationError: 'Cloud sync failed; the conversation was not cleared.',
        recoveryError: null,
      }),
    ).toBe('Cloud sync failed; the conversation was not cleared.')
  })

  it('suppresses only a post-delete refresh error after recovery succeeds', () => {
    expect(
      resolveCoachClearRecoveryError({
        remoteCleared: true,
        recovered: true,
        operationError: 'The fresh conversation could not be loaded.',
        recoveryError: null,
      }),
    ).toBeNull()
  })

  it('preserves a useful recovery error when the forced refresh also fails', () => {
    expect(
      resolveCoachClearRecoveryError({
        remoteCleared: true,
        recovered: false,
        operationError: 'The fresh conversation could not be loaded.',
        recoveryError: 'Network unavailable.',
      }),
    ).toBe('Network unavailable.')
  })

  it('awaits an already-synced local receipt report before conversation delete', async () => {
    const reportDone = deferred<void>()
    const uploadSnapshot = vi.fn(async () => {})
    const markSynced = vi.fn()
    const reportApplied = vi.fn(async () => reportDone.promise)
    const result = {
      proposalId: 'proposal-1',
      appliedAt: 30,
      sourceStateHash: 'a'.repeat(64),
      sourceActionStateHash: 'b'.repeat(64),
      replayed: false,
      syncPending: false,
      changes: [],
    }

    let settled = false
    const preparing = syncCoachActionReceipts({
      pendingResults: [],
      currentProposals: [proposal({ reserved: true, reservedAt: 21 })],
      receiptMatchesProposal: () => true,
      reserve: async (current) => ({
        ...current,
        reserved: true,
        reservedAt: 21,
      }),
      uploadSnapshot,
      markSynced,
      getApplied: async () => result,
      reportApplied,
    }).then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(reportApplied).toHaveBeenCalledWith(result))
    expect(settled).toBe(false)
    expect(uploadSnapshot).not.toHaveBeenCalled()
    expect(markSynced).not.toHaveBeenCalled()

    reportDone.resolve()
    await preparing
    expect(settled).toBe(true)
  })
})

describe('Coach receipt adoption', () => {
  const pendingResult = {
    proposalId: 'proposal-1',
    appliedAt: 30,
    sourceStateHash: 'a'.repeat(64),
    sourceActionStateHash: 'b'.repeat(64),
    replayed: false,
    syncPending: true,
    changes: [],
  }

  it('adopts a legacy receipt without a scoped hash only when its proposal and full-state hash match', () => {
    const plan = {
      proposalId: 'proposal-1',
      sourceStateHash: 'a'.repeat(64),
      sourceActionStateHash: 'b'.repeat(64),
    }
    const legacyResult = {
      ...pendingResult,
      sourceActionStateHash: undefined,
    }

    expect(coachReceiptMatchesActionPlan(legacyResult, plan)).toBe(true)
    expect(
      coachReceiptMatchesActionPlan(
        { ...legacyResult, proposalId: 'proposal-other' },
        plan,
      ),
    ).toBe(false)
    expect(
      coachReceiptMatchesActionPlan(
        { ...legacyResult, sourceStateHash: 'c'.repeat(64) },
        plan,
      ),
    ).toBe(false)
    expect(
      coachReceiptMatchesActionPlan(
        { ...legacyResult, sourceActionStateHash: 'c'.repeat(64) },
        plan,
      ),
    ).toBe(false)
  })

  it('reserves an unreserved legacy receipt before snapshot upload, sync marking, and report', async () => {
    const events: string[] = []
    const syncedResult = { ...pendingResult, syncPending: false }

    const receipts = await syncCoachActionReceipts({
      pendingResults: [pendingResult],
      currentProposals: [proposal()],
      receiptMatchesProposal: () => true,
      reserve: async (current) => {
        events.push('reserve')
        return { ...current, reserved: true, reservedAt: 21, updatedAt: 21 }
      },
      uploadSnapshot: async () => {
        events.push('upload')
      },
      markSynced: async () => {
        events.push('mark')
        return syncedResult
      },
      getApplied: async () => pendingResult,
      reportApplied: async (result) => {
        events.push('report')
        expect(result).toEqual(syncedResult)
      },
    })

    expect(events).toEqual(['reserve', 'upload', 'mark', 'report'])
    expect(receipts?.get('proposal-1')).toEqual(syncedResult)
  })

  it('replays a same-owner reservation before reporting an already-synced receipt', async () => {
    const events: string[] = []
    const syncedResult = { ...pendingResult, syncPending: false }
    const uploadSnapshot = vi.fn(async () => {})
    const markSynced = vi.fn(async () => syncedResult)

    await syncCoachActionReceipts({
      pendingResults: [],
      currentProposals: [proposal({ reserved: true, reservedAt: 21 })],
      receiptMatchesProposal: () => true,
      reserve: async (current) => {
        events.push('reserve-replay')
        return current
      },
      uploadSnapshot,
      markSynced,
      getApplied: async () => syncedResult,
      reportApplied: async () => {
        events.push('report')
      },
    })

    expect(events).toEqual(['reserve-replay', 'report'])
    expect(uploadSnapshot).not.toHaveBeenCalled()
    expect(markSynced).not.toHaveBeenCalled()
  })

  it('uploads a pending receipt discovered after the caller captured its pending snapshot', async () => {
    const events: string[] = []
    const syncedResult = { ...pendingResult, syncPending: false }

    await syncCoachActionReceipts({
      pendingResults: [],
      currentProposals: [proposal()],
      receiptMatchesProposal: () => true,
      reserve: async (current) => {
        events.push('reserve')
        return { ...current, reserved: true, reservedAt: 21 }
      },
      uploadSnapshot: async () => {
        events.push('upload')
      },
      markSynced: async (proposalId) => {
        events.push(`mark:${proposalId}`)
        return syncedResult
      },
      getApplied: async () => pendingResult,
      reportApplied: async (result) => {
        events.push(`report:${result.syncPending}`)
      },
    })

    expect(events).toEqual([
      'reserve',
      'upload',
      'mark:proposal-1',
      'report:false',
    ])
  })

  it('does not upload, mark, or report when another session owns the reservation', async () => {
    const uploadSnapshot = vi.fn(async () => {})
    const markSynced = vi.fn(async () => ({
      ...pendingResult,
      syncPending: false,
    }))
    const reportApplied = vi.fn(async () => {})

    await expect(
      syncCoachActionReceipts({
        pendingResults: [pendingResult],
        currentProposals: [proposal({ reserved: true, reservedAt: 21 })],
        receiptMatchesProposal: () => true,
        reserve: async () => {
          throw new Error('reserved by another paired device')
        },
        uploadSnapshot,
        markSynced,
        getApplied: async () => pendingResult,
        reportApplied,
      }),
    ).rejects.toBeInstanceOf(CoachReceiptAdoptionError)

    expect(uploadSnapshot).not.toHaveBeenCalled()
    expect(markSynced).not.toHaveBeenCalled()
    expect(reportApplied).not.toHaveBeenCalled()
  })

  it('does not surface a mismatched receipt as applied before rejecting it', async () => {
    const onReceiptsChanged = vi.fn()
    const reserve = vi.fn()

    await expect(
      syncCoachActionReceipts({
        pendingResults: [pendingResult],
        currentProposals: [proposal()],
        receiptMatchesProposal: () => false,
        reserve,
        uploadSnapshot: vi.fn(),
        markSynced: vi.fn(),
        getApplied: async () => pendingResult,
        reportApplied: vi.fn(),
        onReceiptsChanged,
      }),
    ).rejects.toBeInstanceOf(CoachReceiptAdoptionError)

    expect(onReceiptsChanged).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
  })

  it('reserves every receipt in the proposal snapshot before publishing any local state', async () => {
    const secondResult = {
      ...pendingResult,
      proposalId: 'proposal-2',
    }
    const events: string[] = []
    const uploadSnapshot = vi.fn(async () => {})
    const markSynced = vi.fn(async (proposalId: string) => ({
      ...(proposalId === 'proposal-1' ? pendingResult : secondResult),
      syncPending: false,
    }))
    const reportApplied = vi.fn(async () => {})

    await expect(
      syncCoachActionReceipts({
        pendingResults: [pendingResult, secondResult],
        currentProposals: [proposal(), proposal({ id: 'proposal-2' })],
        receiptMatchesProposal: (current, result) =>
          current.id === result.proposalId,
        reserve: async (current) => {
          events.push(`reserve:${current.id}`)
          if (current.id === 'proposal-2') {
            throw new Error('reserved by another paired device')
          }
          return { ...current, reserved: true, reservedAt: 21 }
        },
        uploadSnapshot,
        markSynced,
        getApplied: async (proposalId) =>
          proposalId === 'proposal-1' ? pendingResult : secondResult,
        reportApplied,
      }),
    ).rejects.toBeInstanceOf(CoachReceiptAdoptionError)

    expect(events).toEqual(['reserve:proposal-1', 'reserve:proposal-2'])
    expect(uploadSnapshot).not.toHaveBeenCalled()
    expect(markSynced).not.toHaveBeenCalled()
    expect(reportApplied).not.toHaveBeenCalled()
  })

  it('surfaces a pending local receipt before an upload failure', async () => {
    const observed: Array<ReadonlyMap<string, CoachActionResult>> = []
    const markSynced = vi.fn()
    const reportApplied = vi.fn()

    await expect(
      syncCoachActionReceipts({
        pendingResults: [pendingResult],
        currentProposals: [proposal()],
        receiptMatchesProposal: () => true,
        reserve: async (current) => ({
          ...current,
          reserved: true,
          reservedAt: 21,
        }),
        uploadSnapshot: async () => {
          throw new Error('cloud unavailable')
        },
        markSynced,
        getApplied: async () => pendingResult,
        reportApplied,
        onReceiptsChanged: (receipts) => observed.push(receipts),
      }),
    ).rejects.toThrow('cloud unavailable')

    expect(observed).toHaveLength(1)
    expect(observed[0].get('proposal-1')?.syncPending).toBe(true)
    expect(markSynced).not.toHaveBeenCalled()
    expect(reportApplied).not.toHaveBeenCalled()
  })

  it('keeps a discovered applied receipt and identifies a report failure by proposal', async () => {
    const syncedResult = { ...pendingResult, syncPending: false }
    const observed: Array<ReadonlyMap<string, CoachActionResult>> = []
    let caught: unknown

    try {
      await syncCoachActionReceipts({
        pendingResults: [],
        currentProposals: [proposal()],
        receiptMatchesProposal: () => true,
        reserve: async (current) => ({
          ...current,
          reserved: true,
          reservedAt: 21,
        }),
        uploadSnapshot: vi.fn(),
        markSynced: vi.fn(),
        getApplied: async () => syncedResult,
        reportApplied: async () => {
          throw new Error('result endpoint unavailable')
        },
        onReceiptsChanged: (receipts) => observed.push(receipts),
      })
    } catch (error) {
      caught = error
    }

    expect(observed[0].get('proposal-1')).toEqual(syncedResult)
    expect(caught).toBeInstanceOf(CoachReceiptAdoptionError)
    expect((caught as CoachReceiptAdoptionError).proposalId).toBe('proposal-1')
    expect((caught as Error).message).toContain('result endpoint unavailable')
  })
})

describe('Coach message send idempotency', () => {
  it('reuses the exact request after response loss until success is confirmed', async () => {
    const buffer = new CoachSendRetryBuffer<{ id: string; context: object }>()
    const create = vi.fn(async () => ({ id: 'request-1', context: { version: 1 } }))
    const attempts: Array<{ id: string; context: object }> = []

    const first = await buffer.getOrCreate('Hello Coach', 'medium', create)
    attempts.push(first)
    // The server may have committed even though this attempt appeared to fail.
    const retry = await buffer.getOrCreate('Hello Coach', 'medium', create)
    attempts.push(retry)

    expect(create).toHaveBeenCalledOnce()
    expect(attempts[1]).toBe(attempts[0])

    buffer.confirm(retry)
    const afterConfirmation = await buffer.getOrCreate(
      'Hello Coach',
      'medium',
      async () => ({ id: 'request-2', context: { version: 2 } }),
    )
    expect(afterConfirmation.id).toBe('request-2')
  })

  it('abandons an ambiguous request when the submitted draft changes', async () => {
    const buffer = new CoachSendRetryBuffer<{ id: string }>()
    const first = await buffer.getOrCreate('First', 'medium', async () => ({
      id: 'first',
    }))
    const changed = await buffer.getOrCreate('Changed', 'medium', async () => ({
      id: 'changed',
    }))
    const returned = await buffer.getOrCreate('First', 'medium', async () => ({
      id: 'new-first',
    }))

    expect(changed).not.toBe(first)
    expect(returned.id).toBe('new-first')
  })

  it('abandons an ambiguous request after any draft edit, even A to B to A', async () => {
    const buffer = new CoachSendRetryBuffer<{ id: string }>()
    const first = await buffer.getOrCreate('A', 'medium', async () => ({
      id: 'ambiguous-a',
    }))

    // CoachComposer invokes this reset as soon as the draft or effort changes.
    // Returning the visible value to A must not revive the old request payload.
    buffer.reset()
    const returned = await buffer.getOrCreate('A', 'medium', async () => ({
      id: 'new-a',
    }))

    expect(returned).not.toBe(first)
    expect(returned.id).toBe('new-a')
  })
})

describe('Coach failed reservation finalization', () => {
  it('keeps the mutation gate held until the failed result request settles', async () => {
    const gate = new CoachMutationGate()
    const ticket = gate.begin('proposal')
    if (!ticket) throw new Error('missing proposal mutation ticket')
    const reportDone = deferred<CoachProposal | null>()
    const reportFailed = vi.fn(async () => reportDone.promise)

    const finalizing = (async () => {
      try {
        return await finalizeFailedCoachProposal({
          getApplied: async () => null,
          reportFailed,
        })
      } finally {
        gate.finish(ticket)
      }
    })()

    await vi.waitFor(() => expect(reportFailed).toHaveBeenCalledOnce())
    expect(gate.begin('proposal')).toBeNull()
    reportDone.resolve(proposal({ status: 'failed' }))
    await expect(finalizing).resolves.toMatchObject({ status: 'failed' })

    const next = gate.begin('proposal')
    expect(next).not.toBeNull()
    if (next) gate.finish(next)
  })
})

describe('Coach proposal reservation', () => {
  it('does not mutate local state when reservation fails', async () => {
    const apply = vi.fn(async () => 'applied')

    await expect(
      applyReservedCoachProposal({
        visibleProposal: proposal(),
        prepare: async () => 'context',
        reserve: async () => {
          throw new Error('reserved by another device')
        },
        apply,
      }),
    ).rejects.toThrow('reserved by another device')

    expect(apply).not.toHaveBeenCalled()
  })

  it('rejects a changed plan returned after reservation', async () => {
    const apply = vi.fn(async () => 'applied')

    await expect(
      applyReservedCoachProposal({
        visibleProposal: proposal(),
        prepare: async () => 'context',
        reserve: async () =>
          proposal({
            actionPlan: { title: 'Different plan' },
            updatedAt: 21,
            reserved: true,
            reservedAt: 21,
          }),
        apply,
      }),
    ).rejects.toThrow('changed on the server')

    expect(apply).not.toHaveBeenCalled()
  })

  it('reserves before applying the authoritative server plan exactly once', async () => {
    const current = proposal({ updatedAt: 21, reserved: true, reservedAt: 21 })
    const events: string[] = []
    const prepare = vi.fn(async () => {
      events.push('prepare')
      return 'fresh context'
    })
    const reserve = vi.fn(async () => {
      events.push('reserve')
      return current
    })
    const apply = vi.fn(async (value: CoachProposal, context: string) => value.id)
    apply.mockImplementation(async (value, context) => {
      events.push('apply')
      expect(context).toBe('fresh context')
      return value.id
    })

    await expect(
      applyReservedCoachProposal({
        visibleProposal: proposal({ actionPlan: { title: 'Current plan' } }),
        prepare,
        reserve,
        apply,
      }),
    ).resolves.toBe('proposal-1')

    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith(current, 'fresh context')
    expect(events).toEqual(['prepare', 'reserve', 'apply'])
  })

  it('does not reserve when preparing the fresh local context fails', async () => {
    const reserve = vi.fn(async () =>
      proposal({ reserved: true, reservedAt: 21 }),
    )
    const apply = vi.fn(async () => 'applied')

    await expect(
      applyReservedCoachProposal({
        visibleProposal: proposal(),
        prepare: async () => {
          throw new Error('local context unavailable')
        },
        reserve,
        apply,
      }),
    ).rejects.toThrow('local context unavailable')

    expect(reserve).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })
})
