import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowRight, MessageCircle, Play, Plus, Sparkles, Zap } from 'lucide-react'
import { BackupBanner } from '../components/BackupBanner'
import { ErrorAlert, LoadFailure } from '../components/Feedback'
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
  UnfinishedWorkoutError,
} from '../db/repositories/sessions'
import type {
  Program,
  SessionTemplate,
  WorkoutSession,
} from '../db/types'
import { useActiveWorkout } from '../store/activeWorkout'
import { useTimer } from '../store/timer'

export function TodayScreen() {
  const navigate = useNavigate()
  const { setActiveSession } = useActiveWorkout()
  const stopRest = useTimer((s) => s.stop)
  const [state, setState] = useState<{
    resumable: WorkoutSession | null
    program: Program | null
    sessions: SessionTemplate[]
    suggestedIdx: number | null
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
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
    } catch (err) {
      // Without this, a rejected read left the skeleton on screen forever.
      setLoadError(err instanceof Error ? err.message : String(err))
    }
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
      let id: string
      try {
        id = await startSession(null, null)
      } catch (err) {
        if (!(err instanceof UnfinishedWorkoutError)) throw err
        const confirmed = confirm(
          'End the unfinished workout (or discard it if it is empty) and start a new workout?',
        )
        if (!confirmed) {
          setBusy(false)
          return
        }
        stopRest()
        id = await startSession(null, null, { resolveExisting: true })
      }
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
        {loadError ? (
          <LoadFailure
            message={`Could not load today's workout: ${loadError}`}
            onRetry={() => void load()}
          />
        ) : (
          <TodaySkeleton />
        )}
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

        {/* The workout is the reason this screen exists, so it sits above the
            briefing, Coach, and note cards. On a phone those three used to push
            Resume below the fold. */}
        {state.resumable ? (
          <section
            className="relative overflow-hidden rounded-2xl p-5"
            style={{
              background:
                'linear-gradient(135deg, oklch(0.74 0.18 50) 0%, oklch(0.62 0.21 35) 100%)',
              color: 'oklch(0.18 0.04 50)',
            }}
            aria-labelledby="today-primary-heading"
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
            <h2
              id="today-primary-heading"
              className="mt-2 text-2xl font-bold leading-tight"
            >
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
          <section className="card p-5" aria-labelledby="today-primary-heading">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
              Next up
            </div>
            <p className="text-xs text-[var(--color-fg-faint)] mt-0.5">
              {state.program.name}
            </p>
            <h2
              id="today-primary-heading"
              className="mt-3 text-3xl font-bold leading-tight"
            >
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
          <GetStartedCard
            hasEmptyProgram={state.program !== null}
            busy={busy}
            onCreateProgram={() => navigate('/programs')}
            onStartEmpty={() => void startFreestyleNow()}
          />
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

        {/* A fresh install has no program and no history, so the empty-workout
            escape hatch already lives inside GetStartedCard above. Repeating it
            here would give the same action twice in one screen. */}
        {(state.resumable !== null || state.program !== null) && (
          <button
            type="button"
            onClick={() => void startFreestyleNow()}
            disabled={busy}
            className="btn-ghost w-full justify-center text-sm"
          >
            <Plus size={16} /> Start empty workout
          </button>
        )}
        {error && <ErrorAlert message={error} />}

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
      </div>
    </>
  )
}

// First-run entry point. Without an active program the old screen only offered
// a sentence pointing at another tab; this gives the two real next steps.
function GetStartedCard({
  hasEmptyProgram,
  busy,
  onCreateProgram,
  onStartEmpty,
}: {
  hasEmptyProgram: boolean
  busy: boolean
  onCreateProgram: () => void
  onStartEmpty: () => void
}) {
  return (
    <section className="card p-5" aria-labelledby="today-primary-heading">
      <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
        Get started
      </div>
      <h2
        id="today-primary-heading"
        className="mt-3 text-2xl font-bold leading-tight"
      >
        {hasEmptyProgram ? 'Add a session to your program' : 'Create a program'}
      </h2>
      <p className="mt-1.5 text-sm text-[var(--color-fg-dim)]">
        {hasEmptyProgram
          ? 'Your active program has no sessions yet. Add one to get a suggested workout here.'
          : 'Build a reusable training template, or start logging right away and organise it later.'}
      </p>
      <button
        type="button"
        onClick={onCreateProgram}
        className="btn-primary w-full mt-5 text-base"
      >
        <Plus size={18} />
        {hasEmptyProgram ? 'Edit program' : 'Create a program'}
      </button>
      <button
        type="button"
        onClick={onStartEmpty}
        disabled={busy}
        className="btn-ghost w-full justify-center mt-2 text-sm"
      >
        <Play size={16} fill="currentColor" /> Start empty workout
      </button>
    </section>
  )
}
