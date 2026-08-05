import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, LoaderCircle, Sparkles, Trash2, WifiOff } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router'
import { CoachActionCard } from '../components/CoachActionCard'
import { CoachComposer } from '../components/CoachComposer'
import { CoachMessageBody } from '../components/CoachMessageBody'
import { CoachStatus } from '../components/CoachStatus'
import { Header } from '../components/Header'
import {
  applyCoachActionPlan,
  getAppliedCoachActionResult,
  listPendingCoachActionResults,
  markCoachActionSynced,
  parseCoachActionPlan,
} from '../db/repositories/chatActions'
import {
  cancelCoachJob,
  CoachApiError,
  clearCoachConversation,
  dismissCoachProposal,
  fetchCoachState,
  fetchCoachTranscriptPage,
  fetchFullCoachTranscript,
  postCoachMessage,
  reportCoachProposalResult,
  reserveCoachProposal,
} from '../lib/chatApi'
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
  type CoachRemoteRequestTicket,
} from '../lib/coachConversationLifecycle'
import { buildLiveCoachContext, type CoachLiveContext } from '../lib/chatContext'
import type {
  CoachActionResult,
  CoachConversationState,
  CoachMessage,
  CoachProposal,
  CoachReasoningEffort,
} from '../lib/chatTypes'
import { uploadCloudSnapshot } from '../lib/cloud'
import { useActiveWorkout } from '../store/activeWorkout'

function safeReturnPath(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/'
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) merged.set(item.id, item)
  return Array.from(merged.values())
}

function receiptMatchesProposal(
  proposal: CoachProposal,
  result: CoachActionResult,
): boolean {
  try {
    const plan = parseCoachActionPlan(proposal.actionPlan)
    return coachReceiptMatchesActionPlan(result, {
      proposalId: proposal.id,
      sourceStateHash: plan.sourceStateHash,
      sourceActionStateHash: plan.sourceActionStateHash,
    })
  } catch {
    return false
  }
}

interface RefreshRemoteOptions {
  force?: boolean
  fullTranscript?: boolean
}

type CoachSendRequest = Parameters<typeof postCoachMessage>[0]

function MessageBubble({ message }: { message: CoachMessage }) {
  const user = message.role === 'user'
  return (
    <article
      aria-label={user ? 'You' : 'Coach'}
      className={`flex ${user ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`min-w-0 rounded-2xl px-4 py-3 ${
          user
            ? 'max-w-[88%] rounded-br-md bg-[var(--color-accent)] text-black'
            : 'w-full rounded-bl-md bg-[var(--color-surface)] border border-[var(--color-border)]'
        }`}
      >
        {!user && (
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--color-accent)]">
            <Bot size={13} /> Coach
            {message.reasoningEffort === 'xhigh' && (
              <span className="inline-flex items-center gap-1 normal-case tracking-normal font-medium text-[var(--color-fg-faint)]">
                <Sparkles size={11} /> Deep Think
              </span>
            )}
          </div>
        )}
        {user ? (
          <p className="whitespace-pre-wrap text-sm leading-6">{message.text}</p>
        ) : (
          <CoachMessageBody text={message.text} />
        )}
        <div
          className={`mt-1.5 text-[10px] nums ${
            user ? 'text-black/55 text-right' : 'text-[var(--color-fg-faint)]'
          }`}
        >
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}
        </div>
      </div>
    </article>
  )
}

export function CoachScreen() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const preferredSessionId = searchParams.get('sessionId') ?? undefined
  const returnTo = safeReturnPath(searchParams.get('returnTo'))
  const setActiveSession = useActiveWorkout((state) => state.setActiveSession)
  const [remote, setRemote] = useState<CoachConversationState | null>(null)
  const [messages, setMessages] = useState<CoachMessage[]>([])
  const [proposals, setProposals] = useState<CoachProposal[]>([])
  const [context, setContext] = useState<CoachLiveContext | null>(null)
  const [localApplied, setLocalApplied] = useState<Map<string, CoachActionResult>>(
    () => new Map(),
  )
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null)
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null)
  const [proposalErrors, setProposalErrors] = useState<Map<string, string>>(
    () => new Map(),
  )
  const [pageError, setPageError] = useState<string | null>(null)
  const transcriptCursor = useRef(0)
  const remoteRef = useRef<CoachConversationState | null>(null)
  const proposalsRef = useRef<CoachProposal[]>([])
  const requestGateRef = useRef<CoachRemoteRequestGate | null>(null)
  const mutationGateRef = useRef<CoachMutationGate | null>(null)
  const sendRetryBufferRef = useRef<CoachSendRetryBuffer<CoachSendRequest> | null>(
    null,
  )
  const clearingRef = useRef(false)
  const sendingRef = useRef(false)
  const endRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldAutoScroll = useRef(true)

  if (!requestGateRef.current) {
    requestGateRef.current = new CoachRemoteRequestGate()
  }
  if (!mutationGateRef.current) {
    mutationGateRef.current = new CoachMutationGate()
  }
  if (!sendRetryBufferRef.current) {
    sendRetryBufferRef.current = new CoachSendRetryBuffer()
  }
  const requestGate = requestGateRef.current
  const mutationGate = mutationGateRef.current
  const sendRetryBuffer = sendRetryBufferRef.current

  const refreshLocalContext = useCallback(async () => {
    const live = await buildLiveCoachContext(preferredSessionId)
    setContext(live.context)
    return live
  }, [preferredSessionId])

  const reconcileReceipts = useCallback(
    async (
      incoming: CoachProposal[],
      isCurrent: () => boolean = () => true,
    ) => {
      const pendingResults = await listPendingCoachActionResults()
      if (!isCurrent()) return
      try {
        const receipts = await syncCoachActionReceipts({
          pendingResults,
          currentProposals: incoming,
          isCurrent,
          receiptMatchesProposal,
          reserve: (proposal) =>
            reserveCoachProposal(proposal.id, proposal.updatedAt),
          uploadSnapshot: async () => {
            await uploadCloudSnapshot('chat_action_applied')
          },
          markSynced: markCoachActionSynced,
          getApplied: getAppliedCoachActionResult,
          reportApplied: (result) =>
            reportCoachProposalResult(result.proposalId, 'applied', { result }),
          onReceiptsChanged: (discovered) => {
            if (!isCurrent()) return
            setLocalApplied((current) => {
              const next = new Map(current)
              for (const [id, result] of discovered) next.set(id, result)
              return next
            })
          },
        })
        if (!receipts || !isCurrent()) return
        setLocalApplied((current) => {
          const next = new Map(current)
          for (const [id, result] of receipts) next.set(id, result)
          return next
        })
        setProposalErrors((current) => {
          const next = new Map(current)
          for (const id of receipts.keys()) next.delete(id)
          return next
        })
      } catch (error) {
        if (error instanceof CoachReceiptAdoptionError && isCurrent()) {
          setProposalErrors((current) =>
            new Map(current).set(error.proposalId, error.message),
          )
        }
        // Durable receipts remain pending and retry on a later refresh.
      }
    },
    [],
  )

  const ingestTranscript = useCallback(
    async (
      transcript: {
        messages: CoachMessage[]
        proposals: CoachProposal[]
        nextCursor: number
      },
      replace: boolean,
      ticket?: CoachRemoteRequestTicket,
    ) => {
      const isCurrent = () => !ticket || requestGate.isCurrent(ticket)
      if (!isCurrent()) return
      transcriptCursor.current = transcript.nextCursor
      const sortedMessages = transcript.messages
        .slice()
        .sort((a, b) => a.sequence - b.sequence)
      const sortedProposals = transcript.proposals
        .slice()
        .sort((a, b) => a.createdAt - b.createdAt)
      setMessages((current) =>
        replace
          ? sortedMessages
          : mergeById(current, sortedMessages).sort(
              (a, b) => a.sequence - b.sequence,
            ),
      )
      const nextProposals = replace
        ? sortedProposals
        : mergeById(proposalsRef.current, sortedProposals).sort(
            (a, b) => a.createdAt - b.createdAt,
          )
      proposalsRef.current = nextProposals
      setProposals(nextProposals)
      await reconcileReceipts(nextProposals, isCurrent)
    },
    [reconcileReceipts, requestGate],
  )

  const fetchIncrementalTranscript = useCallback(async (
    after: number,
    signal?: AbortSignal,
  ) => {
    const next = {
      messages: [] as CoachMessage[],
      proposals: [] as CoachProposal[],
      nextCursor: after,
    }
    let hasMore = true
    let pages = 0
    while (hasMore && pages < 100) {
      const page = await fetchCoachTranscriptPage(next.nextCursor, 100, signal)
      next.messages.push(...page.messages)
      next.proposals.push(...page.proposals)
      if (page.hasMore && page.nextCursor <= next.nextCursor) {
        throw new Error('Coach transcript cursor did not advance')
      }
      next.nextCursor = page.nextCursor
      hasMore = page.hasMore
      pages += 1
    }
    if (hasMore) throw new Error('Coach transcript is too large to update safely')
    return { ...next, hasMore: false }
  }, [])

  const refreshRemote = useCallback(
    async (
      quiet = false,
      options: RefreshRemoteOptions = {},
    ): Promise<boolean> => {
      const ticket = requestGate.begin({ replace: options.force })
      if (!ticket) return false
      const isCurrent = () => requestGate.isCurrent(ticket)
      try {
        const previousRemote = remoteRef.current
        const nextRemote = await fetchCoachState(ticket.signal)
        if (!isCurrent()) return false
        const proposalStateChanged =
          previousRemote !== null &&
          previousRemote.latestProposalUpdatedAt !==
            nextRemote.latestProposalUpdatedAt
        let transcript: Awaited<
          ReturnType<typeof fetchFullCoachTranscript>
        > | null = null
        let replaceTranscript = false
        if (
          options.fullTranscript ||
          nextRemote.latestMessageSequence < transcriptCursor.current ||
          proposalStateChanged
        ) {
          transcript = await fetchFullCoachTranscript(ticket.signal)
          replaceTranscript = true
        } else if (nextRemote.latestMessageSequence > transcriptCursor.current) {
          transcript = await fetchIncrementalTranscript(
            transcriptCursor.current,
            ticket.signal,
          )
        }
        if (!isCurrent()) return false
        remoteRef.current = nextRemote
        setRemote(nextRemote)
        if (transcript) {
          await ingestTranscript(transcript, replaceTranscript, ticket)
        } else {
          await reconcileReceipts(proposalsRef.current, isCurrent)
        }
        if (!isCurrent()) return false
        setPageError(null)
        return true
      } catch (caught) {
        if (isCurrent() && !quiet) {
          setPageError(caught instanceof Error ? caught.message : String(caught))
        }
        return false
      } finally {
        requestGate.finish(ticket)
      }
    },
    [
      fetchIncrementalTranscript,
      ingestTranscript,
      reconcileReceipts,
      requestGate,
    ],
  )

  const loadInitial = useCallback(async () => {
    const ticket = requestGate.begin({ replace: true })
    if (!ticket) return
    const isCurrent = () => requestGate.isCurrent(ticket)
    try {
      const [live, nextRemote, transcript] = await Promise.allSettled([
        buildLiveCoachContext(preferredSessionId),
        fetchCoachState(ticket.signal),
        fetchFullCoachTranscript(ticket.signal),
      ])
      if (!isCurrent()) return
      if (live.status === 'rejected') throw live.reason

      // Local workout context remains useful when cloud auth or the coach bridge
      // is unavailable, so publish it before handling either remote result.
      setContext(live.value.context)
      if (nextRemote.status === 'rejected') throw nextRemote.reason
      if (transcript.status === 'rejected') throw transcript.reason

      remoteRef.current = nextRemote.value
      setRemote(nextRemote.value)
      await ingestTranscript(transcript.value, true, ticket)
      if (isCurrent()) setPageError(null)
    } catch (caught) {
      if (isCurrent()) {
        setPageError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      const completedCurrentRequest = isCurrent()
      requestGate.finish(ticket)
      if (completedCurrentRequest) setLoading(false)
    }
  }, [ingestTranscript, preferredSessionId, requestGate])

  useEffect(() => {
    void loadInitial()
    return () => requestGate.invalidate()
  }, [loadInitial, requestGate])

  const pollDelay =
    (remote?.counts.queued ?? 0) + (remote?.counts.processing ?? 0) > 0
      ? 2500
      : 10_000

  useEffect(() => {
    let stopped = false
    let timeoutId: number | undefined
    const schedule = () => {
      timeoutId = window.setTimeout(
        async () => {
          if (!stopped && document.visibilityState === 'visible') {
            await refreshRemote(true)
          }
          if (!stopped) schedule()
        },
        pollDelay,
      )
    }
    schedule()
    return () => {
      stopped = true
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
  }, [pollDelay, refreshRemote])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      void refreshLocalContext().catch((caught) => {
        setPageError(caught instanceof Error ? caught.message : String(caught))
      })
      void refreshRemote(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [refreshLocalContext, refreshRemote])

  useEffect(() => {
    if (!shouldAutoScroll.current) return
    const reduceMotion = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches
    endRef.current?.scrollIntoView({
      behavior: loading || reduceMotion ? 'auto' : 'smooth',
    })
  }, [messages.length, proposals.length, loading])

  const proposalsByMessage = useMemo(() => {
    const result = new Map<string, CoachProposal[]>()
    for (const proposal of proposals) {
      const list = result.get(proposal.messageId) ?? []
      list.push(proposal)
      result.set(proposal.messageId, list)
    }
    return result
  }, [proposals])
  const knownMessageIds = useMemo(() => new Set(messages.map((message) => message.id)), [messages])
  const orphanProposals = proposals.filter(
    (proposal) => !knownMessageIds.has(proposal.messageId),
  )
  const pendingJob = remote?.pendingJobs[0] ?? null
  const waitingForMac = Boolean(pendingJob && remote?.bridge?.online !== true)

  async function send(text: string, reasoningEffort: CoachReasoningEffort) {
    if (loading || sendingRef.current || clearingRef.current) return
    sendingRef.current = true
    shouldAutoScroll.current = true
    setSending(true)
    setPageError(null)
    try {
      const request = await sendRetryBuffer.getOrCreate(
        text,
        reasoningEffort,
        async () => {
          const live = await buildLiveCoachContext(preferredSessionId)
          setContext(live.context)
          return {
            clientMessageId: crypto.randomUUID(),
            text,
            reasoningEffort,
            context: live.context,
            stateHash: live.stateHash,
          }
        },
      )
      const response = await postCoachMessage(request)
      sendRetryBuffer.confirm(request)
      if (response.message) {
        setMessages((current) =>
          mergeById(current, [response.message as CoachMessage]).sort(
            (a, b) => a.sequence - b.sequence,
          ),
        )
      }
      await refreshRemote(true, { force: true })
    } catch (caught) {
      if (
        caught instanceof CoachApiError &&
        caught.status >= 400 &&
        caught.status < 500 &&
        caught.status !== 408 &&
        caught.status !== 429
      ) {
        sendRetryBuffer.reset()
      }
      setPageError(caught instanceof Error ? caught.message : String(caught))
      throw caught
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  async function apply(proposal: CoachProposal) {
    if (clearingRef.current) return
    const mutationTicket = mutationGate.begin('proposal')
    if (!mutationTicket) return
    setBusyProposalId(proposal.id)
    setProposalErrors((current) => {
      const next = new Map(current)
      next.delete(proposal.id)
      return next
    })
    let reservationAcquired = false
    const mergeProposal = (updated: CoachProposal | null) => {
      if (!updated) return
      const next = mergeById(proposalsRef.current, [updated])
      proposalsRef.current = next
      setProposals(next)
    }
    const finalizeFailure = async (message: string) => {
      try {
        const failed = await finalizeFailedCoachProposal({
          getApplied: () => getAppliedCoachActionResult(proposal.id),
          reportFailed: () =>
            reportCoachProposalResult(proposal.id, 'failed', { error: message }),
        })
        mergeProposal(failed)
        return failed
      } catch {
        // The same-device reservation remains durable and can be retried.
        return null
      }
    }
    try {
      const applied = await applyReservedCoachProposal({
        visibleProposal: proposal,
        prepare: async (visibleProposal) => {
          const plan = parseCoachActionPlan(visibleProposal.actionPlan)
          const live = await buildLiveCoachContext(preferredSessionId)
          if (clearingRef.current) {
            throw new Error('Coach conversation is being cleared.')
          }
          return { live, scope: plan.scope }
        },
        reserve: async (visibleProposal) => {
          const reserved = await reserveCoachProposal(
            visibleProposal.id,
            visibleProposal.updatedAt,
          )
          reservationAcquired = true
          return reserved
        },
        apply: async (currentProposal, prepared) => {
          if (clearingRef.current) {
            throw new Error('Coach conversation is being cleared.')
          }
          return {
            scope: prepared.scope,
            result: await applyCoachActionPlan({
              proposalId: currentProposal.id,
              rawPlan: currentProposal.actionPlan,
              currentStateHash: prepared.live.stateHash,
              currentActionStateHashes:
                prepared.live.context.actionStateHashes,
            }),
          }
        },
      })
      let result = applied.result
      setLocalApplied((current) => new Map(current).set(proposal.id, result))
      if (result.activeSessionId) setActiveSession(result.activeSessionId)
      if (applied.scope === 'one_time_workout' && result.activeSessionId) {
        navigate('/workout')
      }

      try {
        await uploadCloudSnapshot('chat_action_applied')
        result = await markCoachActionSynced(proposal.id)
        setLocalApplied((current) => new Map(current).set(proposal.id, result))
      } catch {
        await refreshLocalContext()
        return
      }
      await reportCoachProposalResult(proposal.id, 'applied', {
        result,
      })
      await refreshLocalContext()
      await refreshRemote(true, { force: true, fullTranscript: true })
    } catch (caught) {
      if (clearingRef.current) return
      if (caught instanceof CoachProposalUnavailableError) {
        let currentProposal = caught.currentProposal
        if (reservationAcquired) {
          currentProposal =
            (await finalizeFailure(caught.message)) ?? currentProposal
        }
        const next = currentProposal
          ? mergeById(proposalsRef.current, [currentProposal])
          : proposalsRef.current.filter((item) => item.id !== proposal.id)
        proposalsRef.current = next
        setProposals(next)
        await refreshRemote(true, { force: true, fullTranscript: true })
        setPageError(caught.message)
        return
      }
      const message = caught instanceof Error ? caught.message : String(caught)
      setProposalErrors((current) => new Map(current).set(proposal.id, message))
      if (reservationAcquired) {
        await finalizeFailure(message)
      }
      if (caught instanceof CoachApiError && caught.status === 409) {
        await refreshRemote(true, { force: true, fullTranscript: true })
      }
    } finally {
      mutationGate.finish(mutationTicket)
      setBusyProposalId(null)
    }
  }

  async function dismiss(proposal: CoachProposal) {
    if (clearingRef.current || proposal.reserved === true) return
    const mutationTicket = mutationGate.begin('proposal')
    if (!mutationTicket) return
    setBusyProposalId(proposal.id)
    try {
      const updated = await dismissCoachProposal(proposal.id)
      if (updated) {
        const next = mergeById(proposalsRef.current, [updated])
        proposalsRef.current = next
        setProposals(next)
      }
      await refreshRemote(true, { force: true, fullTranscript: true })
    } catch (caught) {
      setProposalErrors((current) =>
        new Map(current).set(
          proposal.id,
          caught instanceof Error ? caught.message : String(caught),
        ),
      )
      if (caught instanceof CoachApiError && caught.status === 409) {
        await refreshRemote(true, { force: true, fullTranscript: true })
      }
    } finally {
      mutationGate.finish(mutationTicket)
      setBusyProposalId(null)
    }
  }

  async function cancelPendingJob() {
    if (!pendingJob || cancellingJobId || clearingRef.current) return
    const mutationTicket = mutationGate.begin('cancel')
    if (!mutationTicket) return
    setCancellingJobId(pendingJob.id)
    setPageError(null)
    try {
      await cancelCoachJob(pendingJob.id)
      await refreshRemote(true, { force: true, fullTranscript: true })
    } catch (caught) {
      setPageError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      mutationGate.finish(mutationTicket)
      setCancellingJobId(null)
    }
  }

  async function clearConversation() {
    if (clearingRef.current || mutationGate.busy || sendingRef.current) return
    if (!messages.length && !proposals.length) return
    if (!confirm('Clear this Coach conversation? Applied workout changes stay saved.')) {
      return
    }
    const mutationTicket = mutationGate.begin('clear')
    if (!mutationTicket) return
    clearingRef.current = true
    setClearing(true)
    setLoading(true)
    let remoteCleared = false
    try {
      await clearCoachConversationAndRefresh({
        gate: requestGate,
        prepare: async () => {
          const pendingResults = await listPendingCoachActionResults()
          await syncCoachActionReceipts({
            pendingResults,
            currentProposals: proposalsRef.current,
            receiptMatchesProposal,
            reserve: (proposal) =>
              reserveCoachProposal(proposal.id, proposal.updatedAt),
            uploadSnapshot: async () => {
              await uploadCloudSnapshot('chat_action_applied')
            },
            markSynced: markCoachActionSynced,
            getApplied: getAppliedCoachActionResult,
            reportApplied: (result) =>
              reportCoachProposalResult(result.proposalId, 'applied', {
                result,
              }),
          })
        },
        clearRemote: async () => {
          await clearCoachConversation()
          remoteCleared = true
        },
        resetLocal: () => {
          setMessages([])
          proposalsRef.current = []
          setProposals([])
          setLocalApplied(new Map())
          setProposalErrors(new Map())
          setPageError(null)
          transcriptCursor.current = 0
          remoteRef.current = null
          setRemote(null)
          sendRetryBuffer.reset()
        },
        refreshFresh: async () => {
          const [, refreshed] = await Promise.all([
            refreshLocalContext(),
            refreshRemote(false, { force: true, fullTranscript: true }),
          ])
          if (!refreshed) {
            throw new Error(
              'Coach was cleared, but the fresh conversation could not be loaded.',
            )
          }
        },
      })
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      const recovered = await refreshRemote(false, {
        force: true,
        fullTranscript: true,
      })
      setPageError((recoveryError) =>
        resolveCoachClearRecoveryError({
          remoteCleared,
          recovered,
          operationError: message,
          recoveryError,
        }),
      )
    } finally {
      clearingRef.current = false
      mutationGate.finish(mutationTicket)
      setClearing(false)
      // A pre-clear loadInitial ticket was invalidated and deliberately cannot
      // update loading; the clear lifecycle owns the terminal loading state.
      setLoading(false)
    }
  }

  function proposalCard(proposal: CoachProposal) {
    const localResult = localApplied.get(proposal.id)
    const shown =
      localResult && proposal.status === 'proposed'
        ? {
            ...proposal,
            status: 'applied' as const,
            result: localResult,
          }
        : localResult && proposal.status === 'applied'
          ? { ...proposal, result: localResult }
          : proposal
    return (
      <CoachActionCard
        key={proposal.id}
        proposal={shown}
        context={context}
        busy={busyProposalId === proposal.id}
        interactionLocked={
          clearing || busyProposalId !== null || cancellingJobId !== null
        }
        error={proposalErrors.get(proposal.id) ?? null}
        onApply={() => void apply(proposal)}
        onDismiss={() => void dismiss(proposal)}
      />
    )
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-[var(--color-bg)]">
      <Header
        title="Coach"
        subtitle="Your live training copilot"
        back={returnTo}
        right={
          <button
            type="button"
            onClick={() => void clearConversation()}
            disabled={
              clearing ||
              sending ||
              cancellingJobId !== null ||
              busyProposalId !== null ||
              (messages.length === 0 && proposals.length === 0)
            }
            aria-label="Clear Coach conversation"
            className="min-h-11 min-w-11 grid place-items-center text-[var(--color-fg-faint)] hover:text-red-300 disabled:opacity-30"
          >
            <Trash2 size={18} />
          </button>
        }
      />
      <CoachStatus remote={remote} context={context} />

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain"
        onScroll={() => {
          const element = scrollRef.current
          if (!element) return
          shouldAutoScroll.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            120
        }}
      >
        <div
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-busy={loading || sending || clearing}
          className="max-w-md mx-auto px-3 pt-4 pb-16 space-y-3"
        >
          {pageError && (
            <div
              role="alert"
              className="rounded-xl px-3 py-3 text-sm bg-red-950/35 text-red-200 border border-red-900/50"
            >
              <p>{pageError}</p>
              <button
                type="button"
                onClick={() => {
                  setLoading(true)
                  void loadInitial()
                }}
                className="mt-2 min-h-11 rounded-lg px-3 font-semibold text-white hover:bg-red-900/35"
              >
                Retry
              </button>
            </div>
          )}

          {loading ? (
            <div
              role="status"
              className="py-16 flex items-center justify-center gap-2 text-sm text-[var(--color-fg-faint)]"
            >
              <LoaderCircle size={17} className="animate-spin" /> Loading Coach…
            </div>
          ) : messages.length === 0 && proposals.length === 0 ? (
            <div className="py-12 px-6 text-center">
              <div className="mx-auto w-12 h-12 rounded-2xl flex items-center justify-center bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                <Bot size={25} />
              </div>
              <h2 className="mt-4 text-xl font-bold">What are we working on?</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--color-fg-dim)]">
                Talk through today’s training, edit programs or saved workouts, or
                create a custom exercise. I’ll always show changes before applying
                them.
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <div key={message.id} className="space-y-3">
                <MessageBubble message={message} />
                {(proposalsByMessage.get(message.id) ?? []).map(proposalCard)}
              </div>
            ))
          )}

          {orphanProposals.map(proposalCard)}
          {pendingJob && (
            <div
              role="status"
              className="flex min-h-11 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-fg-dim)]"
            >
              {waitingForMac ? (
                <WifiOff size={15} className="shrink-0" aria-hidden="true" />
              ) : (
                <LoaderCircle
                  size={15}
                  className="shrink-0 animate-spin"
                  aria-hidden="true"
                />
              )}
              <span className="min-w-0 flex-1">
                {waitingForMac ? 'Waiting for your Mac…' : 'Coach is thinking…'}
              </span>
              <button
                type="button"
                onClick={() => void cancelPendingJob()}
                disabled={
                  clearing ||
                  busyProposalId !== null ||
                  cancellingJobId === pendingJob.id
                }
                className="min-h-11 shrink-0 rounded-lg px-3 text-xs font-semibold text-red-300 hover:bg-red-950/35 disabled:opacity-50"
              >
                {cancellingJobId === pendingJob.id ? 'Cancelling…' : 'Cancel'}
              </button>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div id="coach-composer" className="max-w-md w-full mx-auto">
        <CoachComposer
          hasActiveWorkout={Boolean(context?.activeWorkout)}
          disabled={loading || sending || clearing}
          onSend={send}
          onDraftChange={() => sendRetryBuffer.reset()}
        />
      </div>
    </div>
  )
}
