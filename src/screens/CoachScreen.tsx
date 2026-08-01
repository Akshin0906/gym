import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, LoaderCircle, Sparkles, Trash2 } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { CoachActionCard } from '../components/CoachActionCard'
import { CoachComposer } from '../components/CoachComposer'
import { CoachStatus } from '../components/CoachStatus'
import { Header } from '../components/Header'
import {
  applyCoachActionPlan,
  getAppliedCoachActionResult,
} from '../db/repositories/chatActions'
import {
  clearCoachConversation,
  dismissCoachProposal,
  fetchCoachState,
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
  const [searchParams] = useSearchParams()
  const preferredSessionId = searchParams.get('sessionId') ?? undefined
  const returnTo = safeReturnPath(searchParams.get('returnTo'))
  const setActiveSession = useActiveWorkout((state) => state.setActiveSession)
  const [remote, setRemote] = useState<CoachConversationState | null>(null)
  const [messages, setMessages] = useState<CoachMessage[]>([])
  const [proposals, setProposals] = useState<CoachProposal[]>([])
  const [context, setContext] = useState<CoachLiveContext | null>(null)
  const [stateHash, setStateHash] = useState<string | null>(null)
  const [localApplied, setLocalApplied] = useState<Map<string, CoachActionResult>>(
    () => new Map(),
  )
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null)
  const [proposalErrors, setProposalErrors] = useState<Map<string, string>>(
    () => new Map(),
  )
  const [pageError, setPageError] = useState<string | null>(null)
  const refreshInFlight = useRef(false)
  const endRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(
    async (quiet = false) => {
      if (refreshInFlight.current) return
      refreshInFlight.current = true
      const errors: string[] = []
      try {
        try {
          const live = await buildLiveCoachContext(preferredSessionId)
          setContext(live.context)
          setStateHash(live.stateHash)
        } catch (caught) {
          errors.push(caught instanceof Error ? caught.message : String(caught))
        }

        try {
          const [nextRemote, transcript] = await Promise.all([
            fetchCoachState(),
            fetchFullCoachTranscript(),
          ])
          setRemote(nextRemote)
          setMessages(transcript.messages.sort((a, b) => a.sequence - b.sequence))
          setProposals(
            transcript.proposals.sort((a, b) => a.createdAt - b.createdAt),
          )

          const receiptPairs = await Promise.all(
            transcript.proposals.map(async (proposal) => [
              proposal.id,
              await getAppliedCoachActionResult(proposal.id),
            ] as const),
          )
          const receipts = new Map<string, CoachActionResult>()
          for (const [id, result] of receiptPairs) {
            if (result) receipts.set(id, result)
          }
          setLocalApplied(receipts)
          for (const proposal of transcript.proposals) {
            const receipt = receipts.get(proposal.id)
            if (receipt && proposal.status === 'proposed') {
              void reportCoachProposalResult(proposal.id, 'applied', {
                result: receipt,
              }).catch(() => {
                // The receipt will safely retry this reconciliation next refresh.
              })
            }
          }
        } catch (caught) {
          errors.push(caught instanceof Error ? caught.message : String(caught))
        }
        if (errors.length === 0) setPageError(null)
        else if (!quiet) setPageError(errors[0])
      } finally {
        setLoading(false)
        refreshInFlight.current = false
      }
    },
    [preferredSessionId],
  )

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true)
    }, 2500)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [refresh])

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
  const thinking = (remote?.counts.queued ?? 0) + (remote?.counts.processing ?? 0) > 0

  async function send(text: string, reasoningEffort: CoachReasoningEffort) {
    if (sending) return
    setSending(true)
    setPageError(null)
    try {
      const live = await buildLiveCoachContext(preferredSessionId)
      setContext(live.context)
      setStateHash(live.stateHash)
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
      await refresh(true)
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
      const result = await applyCoachActionPlan({
        proposalId: proposal.id,
        rawPlan: proposal.actionPlan,
        currentStateHash: live.stateHash,
      })
      setLocalApplied((current) => new Map(current).set(proposal.id, result))
      if (result.activeSessionId) setActiveSession(result.activeSessionId)

      let syncWarning: string | undefined
      try {
        await uploadCloudSnapshot('chat_action_applied')
      } catch (caught) {
        syncWarning = caught instanceof Error ? caught.message : String(caught)
      }
      await reportCoachProposalResult(proposal.id, 'applied', {
        result: syncWarning ? { ...result, syncWarning } : result,
      })
      await refresh(true)
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
        setProposals((current) => mergeById(current, [updated]))
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

  async function clearConversation() {
    if (!messages.length && !proposals.length) return
    if (!confirm('Clear this Coach conversation? Applied workout changes stay saved.')) {
      return
    }
    try {
      await clearCoachConversation()
      setMessages([])
      setProposals([])
      setProposalErrors(new Map())
      setPageError(null)
      await refresh(true)
    } catch (caught) {
      setPageError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  function proposalCard(proposal: CoachProposal) {
    const locallyApplied = localApplied.has(proposal.id)
    const shown = locallyApplied && proposal.status === 'proposed'
      ? { ...proposal, status: 'applied' as const }
      : proposal
    return (
      <CoachActionCard
        key={proposal.id}
        proposal={shown}
        context={context}
        currentStateHash={stateHash}
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
            className="p-2 text-[var(--color-fg-faint)] hover:text-red-300 disabled:opacity-30"
          >
            <Trash2 size={18} />
          </button>
        }
      />
      <CoachStatus remote={remote} context={context} />

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain">
        <div className="max-w-md mx-auto px-3 py-4 space-y-3">
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
                Talk through today’s training, swap movements, or ask me to build a
                workout. I’ll always show changes before applying them.
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
          {thinking && (
            <div className="flex items-center gap-2 text-sm text-[var(--color-fg-faint)] px-2 py-1">
              <LoaderCircle size={15} className="animate-spin" /> Coach is thinking…
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="max-w-md w-full mx-auto">
        <CoachComposer
          hasActiveWorkout={Boolean(context?.activeWorkout)}
          disabled={sending}
          onSend={send}
        />
      </div>
    </div>
  )
}
