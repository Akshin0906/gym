import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, LoaderCircle, Sparkles, Trash2, WifiOff } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { CoachActionCard } from '../components/CoachActionCard'
import { CoachComposer } from '../components/CoachComposer'
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
  clearCoachConversation,
  dismissCoachProposal,
  fetchCoachState,
  fetchCoachTranscriptPage,
  fetchFullCoachTranscript,
  postCoachMessage,
  reportCoachProposalResult,
} from '../lib/chatApi'
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

function MessageBubble({ message }: { message: CoachMessage }) {
  const user = message.role === 'user'
  return (
    <article className={`flex ${user ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[88%] rounded-2xl px-4 py-3 ${
          user
            ? 'rounded-br-md bg-[var(--color-accent)] text-black'
            : 'rounded-bl-md bg-[var(--color-surface)] border border-[var(--color-border)]'
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
        <p className="whitespace-pre-wrap text-sm leading-6">{message.text}</p>
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
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null)
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null)
  const [proposalErrors, setProposalErrors] = useState<Map<string, string>>(
    () => new Map(),
  )
  const [pageError, setPageError] = useState<string | null>(null)
  const remoteRefreshInFlight = useRef(false)
  const transcriptCursor = useRef(0)
  const remoteRef = useRef<CoachConversationState | null>(null)
  const proposalsRef = useRef<CoachProposal[]>([])
  const endRef = useRef<HTMLDivElement>(null)

  const refreshLocalContext = useCallback(async () => {
    const live = await buildLiveCoachContext(preferredSessionId)
    setContext(live.context)
    return live
  }, [preferredSessionId])

  const reconcileReceipts = useCallback(async (incoming: CoachProposal[]) => {
    const [receiptPairs, pendingResults] = await Promise.all([
      Promise.all(
        incoming.map(async (proposal) => [
          proposal.id,
          await getAppliedCoachActionResult(proposal.id),
        ] as const),
      ),
      listPendingCoachActionResults(),
    ])
    const receipts = new Map<string, CoachActionResult>()
    const newlySyncedIds = new Set<string>()
    for (const [id, result] of receiptPairs) {
      if (result) receipts.set(id, result)
    }
    if (pendingResults.length > 0) {
      try {
        await uploadCloudSnapshot('chat_action_applied')
        const synced = await Promise.all(
          pendingResults.map(async (result) => [
            result.proposalId,
            await markCoachActionSynced(result.proposalId),
          ] as const),
        )
        for (const [id, result] of synced) {
          receipts.set(id, result)
          newlySyncedIds.add(id)
          void reportCoachProposalResult(id, 'applied', { result }).catch(() => {
            // A cleared conversation has no remote proposal; the snapshot is
            // still synced and the durable local receipt is now complete.
          })
        }
      } catch {
        // Keep durable pending receipts visible and retry on a later refresh.
      }
    }
    setLocalApplied((current) => {
      const next = new Map(current)
      for (const [id, result] of receipts) next.set(id, result)
      return next
    })
    for (const proposal of incoming) {
      const receipt = receipts.get(proposal.id)
      if (
        receipt &&
        receipt.syncPending !== true &&
        !newlySyncedIds.has(proposal.id) &&
        proposal.status === 'proposed'
      ) {
        void reportCoachProposalResult(proposal.id, 'applied', {
          result: receipt,
        }).catch(() => {
          // The durable local receipt safely retries on a later refresh.
        })
      }
    }
  }, [])

  const ingestTranscript = useCallback(
    async (
      transcript: {
        messages: CoachMessage[]
        proposals: CoachProposal[]
        nextCursor: number
      },
      replace: boolean,
    ) => {
      transcriptCursor.current = transcript.nextCursor
      const sortedMessages = transcript.messages.slice().sort((a, b) => a.sequence - b.sequence)
      const sortedProposals = transcript.proposals.slice().sort((a, b) => a.createdAt - b.createdAt)
      setMessages((current) =>
        replace
          ? sortedMessages
          : mergeById(current, sortedMessages).sort((a, b) => a.sequence - b.sequence),
      )
      const nextProposals = replace
        ? sortedProposals
        : mergeById(proposalsRef.current, sortedProposals).sort(
            (a, b) => a.createdAt - b.createdAt,
          )
      proposalsRef.current = nextProposals
      setProposals(nextProposals)
      await reconcileReceipts(sortedProposals)
    },
    [reconcileReceipts],
  )

  const fetchIncrementalTranscript = useCallback(async (after: number) => {
    const next = {
      messages: [] as CoachMessage[],
      proposals: [] as CoachProposal[],
      nextCursor: after,
    }
    let hasMore = true
    let pages = 0
    while (hasMore && pages < 100) {
      const page = await fetchCoachTranscriptPage(next.nextCursor)
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
    return next
  }, [])

  const refreshRemote = useCallback(
    async (quiet = false) => {
      if (remoteRefreshInFlight.current) return
      remoteRefreshInFlight.current = true
      try {
        const previousRemote = remoteRef.current
        const nextRemote = await fetchCoachState()
        remoteRef.current = nextRemote
        setRemote(nextRemote)
        const proposalStateChanged =
          previousRemote !== null &&
          previousRemote.latestProposalUpdatedAt !==
            nextRemote.latestProposalUpdatedAt
        let transcriptRefreshed = false
        if (
          nextRemote.latestMessageSequence < transcriptCursor.current ||
          proposalStateChanged
        ) {
          await ingestTranscript(await fetchFullCoachTranscript(), true)
          transcriptRefreshed = true
        } else if (nextRemote.latestMessageSequence > transcriptCursor.current) {
          await ingestTranscript(
            await fetchIncrementalTranscript(transcriptCursor.current),
            false,
          )
          transcriptRefreshed = true
        }
        if (!transcriptRefreshed) {
          await reconcileReceipts(proposalsRef.current)
        }
        setPageError(null)
      } catch (caught) {
        if (!quiet) {
          setPageError(caught instanceof Error ? caught.message : String(caught))
        }
      } finally {
        remoteRefreshInFlight.current = false
      }
    },
    [fetchIncrementalTranscript, ingestTranscript, reconcileReceipts],
  )

  const loadInitial = useCallback(async () => {
    try {
      const [live, nextRemote, transcript] = await Promise.all([
        buildLiveCoachContext(preferredSessionId),
        fetchCoachState(),
        fetchFullCoachTranscript(),
      ])
      setContext(live.context)
      remoteRef.current = nextRemote
      setRemote(nextRemote)
      await ingestTranscript(transcript, true)
      setPageError(null)
    } catch (caught) {
      setPageError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [ingestTranscript, preferredSessionId])

  useEffect(() => {
    void loadInitial()
  }, [loadInitial])

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
    endRef.current?.scrollIntoView({ behavior: loading ? 'auto' : 'smooth' })
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
    if (sending) return
    setSending(true)
    setPageError(null)
    try {
      const live = await buildLiveCoachContext(preferredSessionId)
      setContext(live.context)
      const response = await postCoachMessage({
        clientMessageId: crypto.randomUUID(),
        text,
        reasoningEffort,
        context: live.context,
        stateHash: live.stateHash,
      })
      if (response.message) {
        setMessages((current) =>
          mergeById(current, [response.message as CoachMessage]).sort(
            (a, b) => a.sequence - b.sequence,
          ),
        )
      }
      await refreshRemote(true)
    } catch (caught) {
      setPageError(caught instanceof Error ? caught.message : String(caught))
      throw caught
    } finally {
      setSending(false)
    }
  }

  async function apply(proposal: CoachProposal) {
    if (busyProposalId) return
    setBusyProposalId(proposal.id)
    setProposalErrors((current) => {
      const next = new Map(current)
      next.delete(proposal.id)
      return next
    })
    try {
      const live = await buildLiveCoachContext(preferredSessionId)
      const plan = parseCoachActionPlan(proposal.actionPlan)
      let result = await applyCoachActionPlan({
        proposalId: proposal.id,
        rawPlan: proposal.actionPlan,
        currentStateHash: live.stateHash,
        currentActionStateHashes: live.context.actionStateHashes,
      })
      setLocalApplied((current) => new Map(current).set(proposal.id, result))
      if (result.activeSessionId) setActiveSession(result.activeSessionId)
      if (plan.scope === 'one_time_workout' && result.activeSessionId) {
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
      await refreshRemote(true)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setProposalErrors((current) => new Map(current).set(proposal.id, message))
      const receipt = await getAppliedCoachActionResult(proposal.id)
      if (!receipt) {
        void reportCoachProposalResult(proposal.id, 'failed', { error: message }).catch(
          () => {
            // Keep the local error visible if reporting also fails.
          },
        )
      }
    } finally {
      setBusyProposalId(null)
    }
  }

  async function dismiss(proposal: CoachProposal) {
    if (busyProposalId) return
    setBusyProposalId(proposal.id)
    try {
      const updated = await dismissCoachProposal(proposal.id)
      if (updated) {
        const next = mergeById(proposalsRef.current, [updated])
        proposalsRef.current = next
        setProposals(next)
      }
    } catch (caught) {
      setProposalErrors((current) =>
        new Map(current).set(
          proposal.id,
          caught instanceof Error ? caught.message : String(caught),
        ),
      )
    } finally {
      setBusyProposalId(null)
    }
  }

  async function cancelPendingJob() {
    if (!pendingJob || cancellingJobId) return
    setCancellingJobId(pendingJob.id)
    setPageError(null)
    try {
      await cancelCoachJob(pendingJob.id)
      await refreshRemote(true)
    } catch (caught) {
      setPageError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setCancellingJobId(null)
    }
  }

  async function clearConversation() {
    if (!messages.length && !proposals.length) return
    if (!confirm('Clear this Coach conversation? Applied workout changes stay saved.')) {
      return
    }
    try {
      const pendingResults = await listPendingCoachActionResults()
      if (pendingResults.length > 0) {
        try {
          await uploadCloudSnapshot('chat_action_applied')
          await Promise.all(
            pendingResults.map((result) =>
              markCoachActionSynced(result.proposalId),
            ),
          )
        } catch {
          throw new Error(
            'Coach has changes waiting to sync. The conversation was not cleared; retry when cloud sync is available.',
          )
        }
      }
      await clearCoachConversation()
      setMessages([])
      proposalsRef.current = []
      setProposals([])
      setLocalApplied(new Map())
      setProposalErrors(new Map())
      setPageError(null)
      transcriptCursor.current = 0
      await Promise.all([refreshLocalContext(), refreshRemote(true)])
    } catch (caught) {
      setPageError(caught instanceof Error ? caught.message : String(caught))
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
            disabled={messages.length === 0 && proposals.length === 0}
            aria-label="Clear Coach conversation"
            className="min-h-11 min-w-11 grid place-items-center text-[var(--color-fg-faint)] hover:text-red-300 disabled:opacity-30"
          >
            <Trash2 size={18} />
          </button>
        }
      />
      <CoachStatus remote={remote} context={context} />

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain">
        <div className="max-w-md mx-auto px-3 pt-4 pb-16 space-y-3">
          {pageError && (
            <div className="rounded-xl px-3 py-2 text-sm bg-red-950/35 text-red-200 border border-red-900/50">
              {pageError}
            </div>
          )}

          {loading ? (
            <div className="py-16 flex items-center justify-center gap-2 text-sm text-[var(--color-fg-faint)]">
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
            <div className="flex min-h-11 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-fg-dim)]">
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
                disabled={cancellingJobId === pendingJob.id}
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
          disabled={sending}
          onSend={send}
        />
      </div>
    </div>
  )
}
