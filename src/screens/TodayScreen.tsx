import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, MessageCircle, Play, Plus, Sparkles, Zap } from 'lucide-react'
import { BackupBanner } from '../components/BackupBanner'
import { ErrorAlert } from '../components/Feedback'
import { CoachLink, Header, SettingsLink } from '../components/Header'
import { QuickAiNoteCard } from '../components/QuickAiNoteCard'
import { RecommendationBanner } from '../components/RecommendationBanner'
import { TodaySkeleton } from '../components/Skeleton'
import {
  getActiveProgram,
  getSessionsForProgram,
} from '../db/repositories/programs'
import {
  getLastCompletedSessionForProgram,
  getResumableSession,
  startSession,
} from '../db/repositories/sessions'
import type {
  Program,
  SessionTemplate,
  WorkoutSession,
} from '../db/types'
import { useActiveWorkout } from '../store/activeWorkout'

export function TodayScreen() {
  const navigate = useNavigate()
  const { setActiveSession } = useActiveWorkout()
  const [state, setState] = useState<{
    resumable: WorkoutSession | null
    program: Program | null
    sessions: SessionTemplate[]
    suggestedIdx: number | null
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const resumable = (await getResumableSession()) ?? null
    const program = (await getActiveProgram()) ?? null
    let sessions: SessionTemplate[] = []
    let suggestedIdx: number | null = null
    if (program) {
      sessions = (await getSessionsForProgram(program.id)).sort(
        (a, b) => a.order - b.order,
      )
      if (sessions.length > 0) {
        const lastCompleted = await getLastCompletedSessionForProgram(
          program.id,
        )
        if (lastCompleted?.sessionTemplateId) {
          const idx = sessions.findIndex(
            (s) => s.id === lastCompleted.sessionTemplateId,
          )
          suggestedIdx = idx === -1 ? 0 : (idx + 1) % sessions.length
        } else {
          suggestedIdx = 0
        }
      }
    }
    setState({ resumable, program, sessions, suggestedIdx })
  }, [])

  useEffect(() => {
    void load()
    const onVis = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [load])

  async function resume() {
    if (!state?.resumable || busy) return
    setBusy(true)
    setActiveSession(state.resumable.id)
    navigate('/workout')
  }

  function openPreview(template: SessionTemplate) {
    navigate(`/preview/${template.id}`)
  }

  async function startFreestyleNow() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const id = await startSession(null, null)
      setActiveSession(id)
      navigate('/workout')
    } catch (err) {
      // A rejected Dexie transaction would otherwise leave the button stuck
      // disabled with an unhandled rejection and no feedback.
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  if (state === null) {
    return (
      <>
        <Header
          title="Today"
          right={
            <div className="flex items-center">
              <CoachLink />
              <SettingsLink />
            </div>
          }
        />
        <TodaySkeleton />
      </>
    )
  }

  return (
    <>
      <Header
        title="Today"
        right={
          <div className="flex items-center">
            <CoachLink />
            <SettingsLink />
          </div>
        }
      />
      <div className="px-4 py-5 space-y-5 max-w-md mx-auto">
        <BackupBanner />
        <RecommendationBanner />
        <button
          type="button"
          onClick={() => navigate('/coach')}
          className="card w-full p-4 flex items-center gap-3 text-left transition-colors hover:bg-[var(--color-surface-2)]"
        >
          <span
            className="h-11 w-11 rounded-xl grid place-items-center shrink-0"
            style={{
              color: 'var(--color-accent)',
              background: 'oklch(0.72 0.18 50 / 0.12)',
              border: '1px solid oklch(0.72 0.18 50 / 0.25)',
            }}
          >
            <MessageCircle size={22} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 font-semibold">
              Ask Coach <Sparkles size={14} className="text-[var(--color-accent)]" />
            </span>
            <span className="block mt-0.5 text-sm text-[var(--color-fg-dim)]">
              Adjust today, swap an exercise, or build a workout
            </span>
          </span>
          <ArrowRight size={18} className="text-[var(--color-fg-faint)]" />
        </button>
        <QuickAiNoteCard />
        {state.resumable ? (
          <section
            className="relative overflow-hidden rounded-2xl p-5"
            style={{
              background:
                'linear-gradient(135deg, oklch(0.74 0.18 50) 0%, oklch(0.62 0.21 35) 100%)',
              color: 'oklch(0.18 0.04 50)',
            }}
          >
            <span
              aria-hidden
              className="resume-pulse-bar absolute right-0 top-0 bottom-0 w-1"
              style={{ background: 'oklch(0.98 0.05 60 / 0.85)' }}
            />
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest opacity-80">
              <Zap size={14} strokeWidth={2.5} fill="currentColor" />
              In progress
            </div>
            <h2 className="mt-2 text-2xl font-bold leading-tight">
              {state.resumable.name}
            </h2>
            {state.resumable.programName && (
              <p className="text-sm opacity-80">
                {state.resumable.programName}
              </p>
            )}
            <button
              type="button"
              onClick={() => void resume()}
              className="mt-4 w-full py-3 rounded-xl font-bold text-base flex items-center justify-center gap-2"
              style={{ background: 'oklch(0.18 0.04 50)', color: 'oklch(0.95 0.05 65)' }}
            >
              <Play size={18} fill="currentColor" /> Resume
            </button>
          </section>
        ) : state.program && state.suggestedIdx !== null ? (
          <section className="card p-5">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
              Next up
            </div>
            <p className="text-xs text-[var(--color-fg-faint)] mt-0.5">
              {state.program.name}
            </p>
            <h2 className="mt-3 text-3xl font-bold leading-tight">
              {state.sessions[state.suggestedIdx].name}
            </h2>
            <button
              type="button"
              onClick={() =>
                openPreview(state.sessions[state.suggestedIdx as number])
              }
              className="btn-primary w-full mt-5 text-base"
            >
              <Play size={18} fill="currentColor" /> View workout
            </button>
          </section>
        ) : (
          <section className="card p-5 text-sm text-[var(--color-fg-dim)]">
            No active program. Create one in{' '}
            <strong className="text-[var(--color-fg)]">Programs</strong> or
            start an empty workout below.
          </section>
        )}

        {state.program && state.sessions.length > 1 && (
          <section className="space-y-2">
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
              Or pick a session
            </h3>
            <ul className="space-y-1.5">
              {state.sessions.map((s, i) => {
                const isNext = i === state.suggestedIdx
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => openPreview(s)}
                      className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-left ${
                        isNext
                          ? 'bg-[var(--color-surface-2)] border border-[var(--color-border)]'
                          : 'card-tight hover:bg-[var(--color-surface-2)]'
                      }`}
                    >
                      <span className="font-medium">{s.name}</span>
                      <ArrowRight
                        size={16}
                        className="text-[var(--color-fg-faint)]"
                      />
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        <button
          type="button"
          onClick={() => void startFreestyleNow()}
          disabled={busy}
          className="btn-ghost w-full justify-center mt-2 text-sm"
        >
          <Plus size={16} /> Start empty workout
        </button>
        {error && <ErrorAlert message={error} />}
      </div>
    </>
  )
}
