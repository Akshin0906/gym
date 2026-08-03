import type {
  CoachActionResult,
  CoachProposal,
  CoachReasoningEffort,
} from './chatTypes'

export interface CoachRemoteRequestTicket {
  readonly generation: number
  readonly signal: AbortSignal
}

export type CoachMutationKind = 'proposal' | 'clear' | 'cancel'

export interface CoachMutationTicket {
  readonly kind: CoachMutationKind
}

export function resolveCoachClearRecoveryError(args: {
  remoteCleared: boolean
  recovered: boolean
  operationError: string
  recoveryError: string | null
}): string | null {
  if (!args.remoteCleared) {
    if (
      !args.recovered &&
      args.recoveryError &&
      args.recoveryError !== args.operationError
    ) {
      return `${args.operationError} Recovery refresh failed: ${args.recoveryError}`
    }
    return args.operationError
  }
  return args.recovered ? null : (args.recoveryError ?? args.operationError)
}

/** Keeps conversation deletion mutually exclusive with local proposal writes. */
export class CoachMutationGate {
  private active: CoachMutationTicket | null = null

  begin(kind: CoachMutationKind): CoachMutationTicket | null {
    if (this.active) return null
    const ticket = { kind }
    this.active = ticket
    return ticket
  }

  finish(ticket: CoachMutationTicket): void {
    if (this.active === ticket) this.active = null
  }

  get busy(): boolean {
    return this.active !== null
  }
}

interface ActiveRequest {
  ticket: CoachRemoteRequestTicket
  controller: AbortController
}

/**
 * Serializes remote Coach reads and gives destructive conversation operations
 * a generation boundary. Aborting is best-effort; `isCurrent` is the
 * authoritative guard when a fetch implementation still resolves after abort.
 */
export class CoachRemoteRequestGate {
  private generation = 0
  private blocked = false
  private active: ActiveRequest | null = null

  begin(options: { replace?: boolean } = {}): CoachRemoteRequestTicket | null {
    if (this.blocked) return null
    if (this.active) {
      if (!options.replace) return null
      this.active.controller.abort()
      this.active = null
    }

    const controller = new AbortController()
    const ticket: CoachRemoteRequestTicket = {
      generation: this.generation,
      signal: controller.signal,
    }
    this.active = { ticket, controller }
    return ticket
  }

  isCurrent(ticket: CoachRemoteRequestTicket): boolean {
    return (
      !this.blocked &&
      !ticket.signal.aborted &&
      ticket.generation === this.generation &&
      this.active?.ticket === ticket
    )
  }

  finish(ticket: CoachRemoteRequestTicket): void {
    if (this.active?.ticket === ticket) this.active = null
  }

  invalidate(): void {
    this.generation += 1
    this.active?.controller.abort()
    this.active = null
  }

  invalidateAndBlock(): void {
    this.blocked = true
    this.invalidate()
  }

  unblock(): void {
    this.blocked = false
  }
}

interface PendingCoachSend<TRequest> {
  text: string
  reasoningEffort: CoachReasoningEffort
  request: TRequest
}

/** Retains the exact idempotency payload across an ambiguous send failure. */
export class CoachSendRetryBuffer<TRequest extends object> {
  private pending: PendingCoachSend<TRequest> | null = null

  async getOrCreate(
    text: string,
    reasoningEffort: CoachReasoningEffort,
    create: () => Promise<TRequest> | TRequest,
  ): Promise<TRequest> {
    if (
      this.pending?.text === text &&
      this.pending.reasoningEffort === reasoningEffort
    ) {
      return this.pending.request
    }

    // Submitting a changed draft deliberately abandons the prior ambiguous
    // request. If request construction fails, it must not resurrect that draft.
    this.pending = null
    const request = await create()
    this.pending = { text, reasoningEffort, request }
    return request
  }

  confirm(request: TRequest): void {
    if (this.pending?.request === request) this.pending = null
  }

  reset(): void {
    this.pending = null
  }
}

export class CoachProposalUnavailableError extends Error {
  constructor(
    message: string,
    readonly currentProposal: CoachProposal | null,
  ) {
    super(message)
    this.name = 'CoachProposalUnavailableError'
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function isSameReviewedProposal(
  visible: CoachProposal,
  current: CoachProposal,
): boolean {
  return (
    current.messageId === visible.messageId &&
    current.jobId === visible.jobId &&
    current.createdAt === visible.createdAt &&
    canonicalJson(current.actionPlan) === canonicalJson(visible.actionPlan)
  )
}

/**
 * Acquires the server's non-expiring reservation before invoking any local
 * mutation. The returned proposal is authoritative, while the identity and
 * immutable plan check ensures the user applies exactly what they reviewed.
 */
export async function applyReservedCoachProposal<P, T>(args: {
  visibleProposal: CoachProposal
  prepare: (proposal: CoachProposal) => Promise<P>
  reserve: (proposal: CoachProposal) => Promise<CoachProposal>
  apply: (proposal: CoachProposal, prepared: P) => Promise<T>
}): Promise<T> {
  const prepared = await args.prepare(args.visibleProposal)
  const current = await args.reserve(args.visibleProposal)
  if (current.status !== 'proposed' || current.reserved !== true) {
    throw new CoachProposalUnavailableError(
      'This Coach proposal could not be reserved. The conversation was refreshed.',
      current,
    )
  }
  if (!isSameReviewedProposal(args.visibleProposal, current)) {
    throw new CoachProposalUnavailableError(
      'This Coach proposal changed on the server. Review the refreshed proposal before applying it.',
      current,
    )
  }
  return args.apply(current, prepared)
}

/** Finalizes a failed reservation only when no durable local mutation exists. */
export async function finalizeFailedCoachProposal(args: {
  getApplied: () => Promise<CoachActionResult | null>
  reportFailed: () => Promise<CoachProposal | null>
}): Promise<CoachProposal | null> {
  const receipt = await args.getApplied()
  return receipt ? null : args.reportFailed()
}

export class CoachReceiptAdoptionError extends Error {
  constructor(
    readonly proposalId: string,
    message: string,
  ) {
    super(message)
    this.name = 'CoachReceiptAdoptionError'
  }
}

export function coachReceiptMatchesActionPlan(
  result: CoachActionResult,
  plan: {
    proposalId: string
    sourceStateHash: string
    sourceActionStateHash: string
  },
): boolean {
  return (
    result.proposalId === plan.proposalId &&
    result.sourceStateHash.toLowerCase() === plan.sourceStateHash.toLowerCase() &&
    (result.sourceActionStateHash === undefined ||
      result.sourceActionStateHash.toLowerCase() ===
        plan.sourceActionStateHash.toLowerCase())
  )
}

/**
 * Adopts legacy/local receipts under the server reservation before publishing
 * or finalizing them. A reservation failure stops the whole snapshot upload so
 * another device's fenced action can never be overwritten by this client.
 */
export async function syncCoachActionReceipts(args: {
  pendingResults: CoachActionResult[]
  currentProposals: CoachProposal[]
  isCurrent?: () => boolean
  receiptMatchesProposal: (
    proposal: CoachProposal,
    result: CoachActionResult,
  ) => boolean
  reserve: (proposal: CoachProposal) => Promise<CoachProposal>
  uploadSnapshot: () => Promise<void>
  markSynced: (proposalId: string) => Promise<CoachActionResult>
  getApplied: (proposalId: string) => Promise<CoachActionResult | null>
  reportApplied: (result: CoachActionResult) => Promise<unknown>
  onReceiptsChanged?: (
    receipts: ReadonlyMap<string, CoachActionResult>,
  ) => void
}): Promise<Map<string, CoachActionResult> | null> {
  const isCurrent = args.isCurrent ?? (() => true)
  const receipts = new Map(
    args.pendingResults.map((result) => [result.proposalId, result]),
  )
  const receiptPairs = await Promise.all(
    args.currentProposals.map(
      async (proposal) =>
        [proposal.id, await args.getApplied(proposal.id)] as const,
    ),
  )
  if (!isCurrent()) return null
  for (const [proposalId, result] of receiptPairs) {
    if (result) receipts.set(proposalId, result)
  }
  const proposedWithReceipts = args.currentProposals.flatMap((proposal) => {
    if (proposal.status !== 'proposed') return []
    const receipt = receipts.get(proposal.id)
    return receipt ? [{ proposal, receipt }] : []
  })
  for (const { proposal, receipt } of proposedWithReceipts) {
    if (!args.receiptMatchesProposal(proposal, receipt)) {
      throw new CoachReceiptAdoptionError(
        proposal.id,
        'The saved Coach receipt does not match this proposal. It was not synced or finalized.',
      )
    }
    let reserved: CoachProposal
    try {
      reserved = await args.reserve(proposal)
    } catch (error) {
      throw new CoachReceiptAdoptionError(
        proposal.id,
        error instanceof Error ? error.message : String(error),
      )
    }
    if (!isCurrent()) return null
    if (
      reserved.status !== 'proposed' ||
      reserved.reserved !== true ||
      !args.receiptMatchesProposal(reserved, receipt)
    ) {
      throw new CoachReceiptAdoptionError(
        proposal.id,
        'The reserved Coach proposal no longer matches its saved receipt.',
      )
    }
  }
  // Do not render a receipt as applied until its proposal/hash match and
  // reservation ownership have both been verified.
  args.onReceiptsChanged?.(new Map(receipts))

  // Re-read receipts above because an Apply transaction can commit after the
  // caller captured `pendingResults`. Only receipts whose proposals were
  // successfully reserved in this pass are safe to publish and mark synced.
  const pendingToSync = proposedWithReceipts
    .map(({ receipt }) => receipt)
    .filter((receipt) => receipt.syncPending)
  if (pendingToSync.length > 0) {
    await args.uploadSnapshot()
    if (!isCurrent()) return null
    await Promise.all(
      pendingToSync.map(async (result) => {
        try {
          const synced = await args.markSynced(result.proposalId)
          receipts.set(result.proposalId, synced)
        } catch (error) {
          throw new CoachReceiptAdoptionError(
            result.proposalId,
            error instanceof Error ? error.message : String(error),
          )
        }
      }),
    )
    if (!isCurrent()) return null
    args.onReceiptsChanged?.(new Map(receipts))
  }
  await Promise.all(
    proposedWithReceipts.map(async ({ proposal }) => {
      const result = receipts.get(proposal.id)
      if (!result) {
        throw new CoachReceiptAdoptionError(
          proposal.id,
          'The saved Coach receipt disappeared before finalization.',
        )
      }
      try {
        await args.reportApplied(result)
      } catch (error) {
        throw new CoachReceiptAdoptionError(
          proposal.id,
          error instanceof Error ? error.message : String(error),
        )
      }
    }),
  )
  return receipts
}

export async function clearCoachConversationAndRefresh(args: {
  gate: CoachRemoteRequestGate
  prepare: () => Promise<void>
  clearRemote: () => Promise<void>
  resetLocal: () => void
  refreshFresh: () => Promise<void>
}): Promise<void> {
  args.gate.invalidateAndBlock()
  try {
    await args.prepare()
    await args.clearRemote()
    args.resetLocal()
    args.gate.unblock()
    await args.refreshFresh()
  } finally {
    args.gate.unblock()
  }
}
