import type {
  CoachConversationState,
  CoachMessage,
  CoachPendingJob,
  CoachProposal,
  CoachProposalStatus,
  CoachReasoningEffort,
  CoachTranscriptPage,
} from './chatTypes'

export const COACH_TRANSCRIPT_PROTOCOL = 'proposal-reservation-v1'

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function parseMessage(raw: unknown): CoachMessage | null {
  if (!isObject(raw)) return null
  const id = stringValue(raw.id)
  const role = raw.role
  const text = stringValue(raw.text)
  if (!id || (role !== 'user' && role !== 'assistant') || !text) return null
  const effort = raw.reasoningEffort
  return {
    id,
    sequence: numberValue(raw.sequence),
    role,
    text,
    createdAt: numberValue(raw.createdAt),
    reasoningEffort: effort === 'medium' || effort === 'xhigh' ? effort : null,
    model: optionalString(raw.model),
    jobId: optionalString(raw.jobId),
    jobStatus: optionalString(raw.jobStatus),
  }
}

function isProposalStatus(value: unknown): value is CoachProposalStatus {
  return (
    value === 'proposed' ||
    value === 'applied' ||
    value === 'failed' ||
    value === 'dismissed'
  )
}

function parseProposal(raw: unknown): CoachProposal | null {
  if (!isObject(raw)) return null
  const id = stringValue(raw.id)
  const messageId = stringValue(raw.messageId)
  const jobId = stringValue(raw.jobId)
  if (!id || !messageId || !jobId || !isProposalStatus(raw.status)) return null
  return {
    id,
    messageId,
    jobId,
    status: raw.status,
    actionPlan: raw.actionPlan,
    createdAt: numberValue(raw.createdAt),
    updatedAt: numberValue(raw.updatedAt),
    result: raw.result === undefined ? null : raw.result,
    reserved: raw.reserved === true,
    reservedAt:
      typeof raw.reservedAt === 'number' && Number.isSafeInteger(raw.reservedAt)
        ? raw.reservedAt
        : null,
  }
}

export class CoachApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly detail: string,
  ) {
    super(
      `Coach request failed (${status})${detail ? `: ${detail}` : code ? `: ${code}` : ''}`,
    )
    this.name = 'CoachApiError'
  }
}

async function responseError(response: Response): Promise<CoachApiError> {
  let code: string | null = null
  let detail = ''
  try {
    const raw = (await response.text()).trim()
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (isObject(parsed)) {
          code = stringValue(parsed.error) || null
          detail = stringValue(parsed.detail) || code || ''
        }
      } catch {
        detail = raw.slice(0, 240)
      }
    }
  } catch {
    // The HTTP status still gives the caller a useful error.
  }
  return new CoachApiError(response.status, code, detail)
}

async function jsonRequest(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) throw await responseError(response)
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Coach service is unavailable. Try again when the bridge is online.')
  }
  try {
    return (await response.json()) as unknown
  } catch {
    throw new Error('Coach service returned an unreadable response')
  }
}

export async function fetchCoachState(
  signal?: AbortSignal,
): Promise<CoachConversationState> {
  const raw = await jsonRequest('/api/chat/state', { signal })
  if (!isObject(raw)) throw new Error('Malformed Coach state')

  const conversation = isObject(raw.conversation)
    ? {
        id: stringValue(raw.conversation.id, 'primary'),
        createdAt: numberValue(raw.conversation.createdAt),
        updatedAt: numberValue(raw.conversation.updatedAt),
      }
    : null
  const bridgeRaw = isObject(raw.bridge) ? raw.bridge : null
  const bridge = bridgeRaw
    ? {
        online: bridgeRaw.online === true,
        lastSeenAt: numberValue(bridgeRaw.lastSeenAt),
        status: stringValue(bridgeRaw.status, 'unknown'),
        bridgeVersion: stringValue(bridgeRaw.bridgeVersion),
        model: stringValue(bridgeRaw.model),
        activeJobId: optionalString(bridgeRaw.activeJobId),
      }
    : null
  const countsRaw = isObject(raw.counts) ? raw.counts : {}
  const pendingJobs = Array.isArray(raw.pendingJobs)
    ? raw.pendingJobs.flatMap((item) => {
        if (!isObject(item)) return []
        const id = stringValue(item.id)
        const status = item.status
        if (!id || (status !== 'queued' && status !== 'leased')) return []
        return [
          { id, status, createdAt: numberValue(item.createdAt) } satisfies CoachPendingJob,
        ]
      })
    : []

  return {
    conversation,
    bridge,
    counts: {
      queued: numberValue(countsRaw.queued),
      processing: numberValue(countsRaw.processing),
      proposed: numberValue(countsRaw.proposed),
    },
    pendingJobs,
    latestMessageSequence: numberValue(raw.latestMessageSequence),
    latestProposalUpdatedAt: numberValue(raw.latestProposalUpdatedAt),
  }
}

export async function fetchCoachTranscriptPage(
  after = 0,
  limit = 100,
  signal?: AbortSignal,
): Promise<CoachTranscriptPage> {
  const params = new URLSearchParams({ after: String(after), limit: String(limit) })
  const raw = await jsonRequest(`/api/chat/messages?${params}`, {
    signal,
    headers: { 'X-Coach-Protocol': COACH_TRANSCRIPT_PROTOCOL },
  })
  if (!isObject(raw)) throw new Error('Malformed Coach transcript')
  return {
    messages: Array.isArray(raw.messages)
      ? raw.messages.map(parseMessage).filter((x): x is CoachMessage => x !== null)
      : [],
    proposals: Array.isArray(raw.proposals)
      ? raw.proposals
          .map(parseProposal)
          .filter((x): x is CoachProposal => x !== null)
      : [],
    nextCursor: numberValue(raw.nextCursor, after),
    hasMore: raw.hasMore === true,
  }
}

export async function fetchFullCoachTranscript(
  signal?: AbortSignal,
): Promise<CoachTranscriptPage> {
  const messages: CoachMessage[] = []
  const proposals: CoachProposal[] = []
  let cursor = 0
  let hasMore = true
  let pages = 0
  while (hasMore && pages < 100) {
    const page = await fetchCoachTranscriptPage(cursor, 100, signal)
    messages.push(...page.messages)
    proposals.push(...page.proposals)
    if (page.nextCursor <= cursor && page.hasMore) {
      throw new Error('Coach transcript cursor did not advance')
    }
    cursor = page.nextCursor
    hasMore = page.hasMore
    pages += 1
  }
  if (hasMore) {
    throw new Error('Coach transcript is too large to load safely')
  }
  return { messages, proposals, nextCursor: cursor, hasMore }
}

export async function cancelCoachJob(jobId: string): Promise<void> {
  await jsonRequest(`/api/chat/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  })
}

export async function postCoachMessage(args: {
  clientMessageId: string
  text: string
  reasoningEffort: CoachReasoningEffort
  context: unknown
  stateHash: string
}): Promise<{ message: CoachMessage | null; replayed: boolean }> {
  const raw = await jsonRequest('/api/chat/messages', {
    method: 'POST',
    body: JSON.stringify(args),
  })
  if (!isObject(raw)) throw new Error('Malformed Coach send response')
  return {
    message: parseMessage(raw.message),
    replayed: raw.replayed === true,
  }
}

export async function reportCoachProposalResult(
  proposalId: string,
  status: 'applied' | 'failed',
  payload: { result?: unknown; error?: string },
): Promise<CoachProposal | null> {
  const raw = await jsonRequest(
    `/api/chat/proposals/${encodeURIComponent(proposalId)}/result`,
    {
      method: 'POST',
      body: JSON.stringify({ status, ...payload }),
    },
  )
  return isObject(raw) ? parseProposal(raw.proposal) : null
}

export async function reserveCoachProposal(
  proposalId: string,
  expectedUpdatedAt: number,
): Promise<CoachProposal> {
  const raw = await jsonRequest(
    `/api/chat/proposals/${encodeURIComponent(proposalId)}/reserve`,
    {
      method: 'POST',
      body: JSON.stringify({ expectedUpdatedAt }),
    },
  )
  const proposal = isObject(raw) ? parseProposal(raw.proposal) : null
  if (!proposal || proposal.status !== 'proposed' || proposal.reserved !== true) {
    throw new Error('Coach returned an invalid proposal reservation')
  }
  return proposal
}

export async function dismissCoachProposal(
  proposalId: string,
): Promise<CoachProposal | null> {
  const raw = await jsonRequest(
    `/api/chat/proposals/${encodeURIComponent(proposalId)}/dismiss`,
    { method: 'POST' },
  )
  return isObject(raw) ? parseProposal(raw.proposal) : null
}

export async function clearCoachConversation(): Promise<void> {
  await jsonRequest('/api/chat/conversation', { method: 'DELETE' })
}
