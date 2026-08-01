import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, CheckCircle2, ChevronRight, Plus, StickyNote } from 'lucide-react'
import { CountUp } from '../components/CountUp'
import { ExerciseDetailOverlay } from '../components/ExerciseDetailOverlay'
import { CoachLink, Header } from '../components/Header'
import { ExercisePickerSheet } from '../components/ExercisePickerSheet'
import { ProgressRing } from '../components/ProgressRing'
import { SessionFeedback } from '../components/SessionFeedback'
import { SetLogger } from '../components/SetLogger'
import { getExercisesByIds } from '../db/repositories/exercises'
import {
  appendExerciseToSession,
  deleteSession,
  endSession,
  getLastSessionSetsForExercise,
  getResumableSession,
  getSession,
  getSetsForSession,
  setSessionDoneExercises,
  updateSessionFeedback,
} from '../db/repositories/sessions'
import type {
  Exercise,
  LoggedSet,
  SessionExerciseSnapshot,
  SliderValue,
  WorkoutSession,
} from '../db/types'
import { uploadCloudSnapshot } from '../lib/cloud'
import { useActiveWorkout } from '../store/activeWorkout'
import { useTimer } from '../store/timer'

export function ActiveWorkoutScreen() {
  const navigate = useNavigate()
  const { sessionId, setActiveSession } = useActiveWorkout()
  const startRest = useTimer((s) => s.start)

  const [session, setSession] = useState<WorkoutSession | null>(null)
  const [setsBySession, setSetsBySession] = useState<LoggedSet[]>([])
  const [exercises, setExercises] = useState<Map<string, Exercise>>(new Map())
  const [previousByExercise, setPreviousByExercise] = useState<
    Map<string, LoggedSet[]>
  >(new Map())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [feedbackForSessionId, setFeedbackForSessionId] = useState<
    string | null
  >(null)
  const [detailExerciseId, setDetailExerciseId] = useState<string | null>(null)
  // Done exercises reopened in place (ephemeral). Membership in the bottom
  // stack persists via session.doneExerciseIds; this is just which of those
  // are currently expanded. A fresh load/Resume shows them all collapsed.
  const [expandedDoneIds, setExpandedDoneIds] = useState<Set<string>>(
    () => new Set(),
  )

  const loadAll = useCallback(
    async (id: string) => {
      const s = await getSession(id)
      if (!s) {
        setActiveSession(null)
        navigate('/')
        return
      }
      setSession(s)
      const sets = await getSetsForSession(id)
      setSetsBySession(sets)

      const exIds = Array.from(
        new Set([
          ...s.exerciseSnapshot.map((x) => x.exerciseId),
          ...sets.map((x) => x.exerciseId),
        ]),
      )
      const [exMap, prevEntries] = await Promise.all([
        getExercisesByIds(exIds),
        Promise.all(
          exIds.map(
            async (exId) =>
              [exId, await getLastSessionSetsForExercise(exId, id)] as const,
          ),
        ),
      ])
      setExercises(exMap)
      setPreviousByExercise(new Map(prevEntries))
      setLoading(false)
    },
    [navigate, setActiveSession],
  )

  // Cheap refresh after a set log/edit/delete — only the sets change, not the
  // exercise roster or prior-session history.
  const refreshSets = useCallback(async (id: string) => {
    setSetsBySession(await getSetsForSession(id))
  }, [])

  // Track whether we ever had a session. If we did, a later transition to null
  // means the workout was ended/deleted and the caller is navigating away —
  // don't fight that navigation by redirecting to '/'. Only redirect when the
  // screen was opened without an active session (direct nav).
  const hadSessionRef = useRef(false)
  useEffect(() => {
    if (sessionId) {
      hadSessionRef.current = true
      void loadAll(sessionId)
      return
    }
    if (hadSessionRef.current) return

    let cancelled = false
    void getResumableSession().then((resumable) => {
      if (cancelled) return
      if (resumable) setActiveSession(resumable.id)
      else navigate('/')
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, loadAll, navigate, setActiveSession])

  async function handlePick(exerciseId: string) {
    if (!session) return
    await appendExerciseToSession(session.id, exerciseId)
    setPickerOpen(false)
    await loadAll(session.id)
  }

  async function handleEnd() {
    if (!session) return
    const isEmpty = setsBySession.length === 0
    const message = isEmpty
      ? 'Discard this empty workout?'
      : 'End this workout?'
    if (!confirm(message)) return
    if (isEmpty) {
      await deleteSession(session.id)
      setActiveSession(null)
      navigate('/')
      return
    }
    // Commit the session immediately so a tab close mid-feedback doesn't
    // leave it in limbo. Feedback fields are patched after, or stay null
    // if the user skips.
    await endSession(session.id)
    setFeedbackForSessionId(session.id)
  }

  async function handleFeedbackSave(answers: {
    planned: SliderValue
    feel: SliderValue
  }) {
    if (feedbackForSessionId) {
      await updateSessionFeedback(feedbackForSessionId, answers)
      void uploadCloudSnapshot('workout_completed').catch(() => {
        // Settings keeps the last sync error; completion should not block.
      })
    }
    setActiveSession(null)
    navigate('/history')
  }

  function handleFeedbackSkip() {
    void uploadCloudSnapshot('workout_completed').catch(() => {
      // Settings keeps the last sync error; completion should not block.
    })
    setActiveSession(null)
    navigate('/history')
  }

  function updateDone(nextIds: string[]) {
    if (!session) return
    setSession({ ...session, doneExerciseIds: nextIds })
    void setSessionDoneExercises(session.id, nextIds)
  }

  // Collapse an exercise into the bottom "done" stack (append → completion
  // order). Also clears any in-place expansion so it renders collapsed.
  function markDone(exerciseId: string) {
    if (!session) return
    setExpandedDoneIds((prev) => {
      if (!prev.has(exerciseId)) return prev
      const next = new Set(prev)
      next.delete(exerciseId)
      return next
    })
    const ids = session.doneExerciseIds ?? []
    if (ids.includes(exerciseId)) return
    updateDone([...ids, exerciseId])
  }

  // Reopen a done exercise *in place* — it expands where it sits in the bottom
  // stack rather than jumping back to the top. Re-collapse with its Done button.
  function expandDone(exerciseId: string) {
    setExpandedDoneIds((prev) => {
      const next = new Set(prev)
      next.add(exerciseId)
      return next
    })
  }

  // Auto-collapse the first time a logged set reaches the target count. Keyed on
  // the exact count, so logging further sets after reopening won't re-trigger it.
  function maybeAutoCollapse(
    exerciseId: string,
    targetSets: number,
    loggedSetNumber: number,
  ) {
    if (targetSets > 0 && loggedSetNumber === targetSets) markDone(exerciseId)
  }

  if (loading || !session) {
    return (
      <>
        <Header title="Workout" back="/" />
        <p className="p-6 text-[var(--color-fg-faint)] text-center">Starting…</p>
      </>
    )
  }

  if (feedbackForSessionId) {
    return (
      <>
        <Header title={session.name} subtitle="Session check-in" />
        <SessionFeedback
          sessionName={session.name}
          onSave={(answers) => void handleFeedbackSave(answers)}
          onSkip={handleFeedbackSkip}
        />
      </>
    )
  }

  const ordered = [...session.exerciseSnapshot].sort(
    (a, b) => a.order - b.order,
  )
  const doneIds = session.doneExerciseIds ?? []
  const activeSnaps = ordered.filter((s) => !doneIds.includes(s.exerciseId))
  const doneSnaps = doneIds
    .map((id) => ordered.find((s) => s.exerciseId === id))
    .filter((s): s is SessionExerciseSnapshot => s !== undefined)
  const setsByExercise = new Map<string, LoggedSet[]>()
  for (const s of setsBySession) {
    const list = setsByExercise.get(s.exerciseId) ?? []
    list.push(s)
    setsByExercise.set(s.exerciseId, list)
  }

  const totalSetsLogged = setsBySession.length
  const totalVolume = setsBySession.reduce(
    (sum, s) => sum + s.weightLbs * s.reps,
    0,
  )

  // Full expanded exercise card. Shared by the active group (top) and a done
  // exercise that's been reopened in place (bottom). Its Done button collapses
  // it into the bottom stack (or re-collapses it if already there).
  const renderSection = (snap: SessionExerciseSnapshot) => {
    const ex = exercises.get(snap.exerciseId)
    if (!ex) return null
    const existing = (setsByExercise.get(ex.id) ?? []).sort(
      (a, b) => a.setNumber - b.setNumber,
    )
    const prev = previousByExercise.get(ex.id) ?? []
    const targetReached =
      snap.targetSets > 0 && existing.length >= snap.targetSets
    return (
      <section key={ex.id} className="space-y-3">
        <button
          type="button"
          onClick={() => setDetailExerciseId(ex.id)}
          className="w-full flex items-center gap-3 px-1 text-left -mx-1 py-1 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors"
          aria-label={`Open ${ex.name} details`}
        >
          {snap.targetSets > 0 && (
            <ProgressRing
              value={existing.length}
              max={snap.targetSets}
              size={30}
              stroke={3}
            />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold leading-tight truncate">
              {ex.name}
            </h2>
            {snap.targetSets > 0 ? (
              <p className="text-xs text-[var(--color-fg-faint)] nums mt-0.5">
                <span
                  className={
                    targetReached
                      ? 'text-[var(--color-accent)] font-semibold'
                      : ''
                  }
                >
                  {existing.length}/{snap.targetSets}
                </span>{' '}
                sets · {snap.targetRepRange || '—'}
              </p>
            ) : (
              <p className="text-xs text-[var(--color-fg-faint)] nums mt-0.5">
                {existing.length} {existing.length === 1 ? 'set' : 'sets'}
              </p>
            )}
          </div>
          <ChevronRight
            size={18}
            className="text-[var(--color-fg-faint)] flex-shrink-0"
          />
        </button>
        {ex.notes && (
          <div
            className="flex gap-2 text-xs text-[var(--color-fg-dim)] rounded-lg px-3 py-2"
            style={{
              background: 'oklch(0.22 0.02 50 / 0.4)',
              border: '1px solid oklch(0.32 0.04 50 / 0.5)',
            }}
          >
            <StickyNote
              size={14}
              className="shrink-0 mt-0.5 text-[var(--color-accent)]"
            />
            <span className="whitespace-pre-wrap">{ex.notes}</span>
          </div>
        )}
        <SetLogger
          sessionId={session.id}
          exerciseId={ex.id}
          existingSets={existing}
          previousSets={prev}
          defaultRestSeconds={ex.defaultRestSeconds}
          onChange={() => void refreshSets(session.id)}
          onStartRest={(secs) => startRest(secs, ex.id)}
          onSetLogged={(n) => maybeAutoCollapse(ex.id, snap.targetSets, n)}
        />
        <button
          type="button"
          onClick={() => markDone(ex.id)}
          className="btn-secondary w-full py-2.5 text-sm"
        >
          <Check size={16} strokeWidth={2.5} /> Done
        </button>
      </section>
    )
  }

  return (
    <>
      <Header
        title={session.name}
        subtitle={session.programName ?? 'Freestyle session'}
        back="/"
        right={
          <div className="flex items-center gap-1">
            <CoachLink sessionId={session.id} />
            <button
              type="button"
              onClick={() => void handleEnd()}
              className="btn-primary text-sm px-3 py-1.5"
            >
              <CheckCircle2 size={16} /> End
            </button>
          </div>
        }
      />

      {/* Session stats strip */}
      <div className="px-4 pt-3 pb-1 flex items-center gap-4 text-xs nums text-[var(--color-fg-faint)]">
        <span>
          <CountUp
            value={ordered.length}
            className="text-[var(--color-fg)] font-semibold"
          />{' '}
          exercises
        </span>
        <span>
          <CountUp
            value={totalSetsLogged}
            className="text-[var(--color-fg)] font-semibold"
          />{' '}
          sets
        </span>
        <span>
          <CountUp
            value={totalVolume}
            format={(n) => n.toLocaleString()}
            className="text-[var(--color-fg)] font-semibold"
          />{' '}
          lb·reps
        </span>
      </div>

      <div className="px-4 py-3 space-y-5 max-w-md mx-auto">
        {ordered.length === 0 ? (
          <div className="card p-6 text-center">
            <p className="text-[var(--color-fg-dim)] text-sm">
              Add an exercise to start logging.
            </p>
          </div>
        ) : (
          <>
            {activeSnaps.map((snap) => renderSection(snap))}

            {doneSnaps.length > 0 && (
              <div className="space-y-3">
                {doneSnaps.map((snap) => {
                  const ex = exercises.get(snap.exerciseId)
                  if (!ex) return null
                  if (expandedDoneIds.has(ex.id)) return renderSection(snap)
                  return (
                    <button
                      key={ex.id}
                      type="button"
                      onClick={() => expandDone(ex.id)}
                      className="card-tight w-full px-3 py-2.5 flex items-center gap-2.5 text-left hover:bg-[var(--color-surface-2)] transition-colors"
                      aria-label={`Reopen ${ex.name}`}
                    >
                      <CheckCircle2
                        size={18}
                        className="shrink-0"
                        style={{ color: 'var(--color-accent)' }}
                      />
                      <span className="font-semibold truncate flex-1">
                        {ex.name}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}

        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="w-full flex items-center justify-center gap-2 py-4 rounded-xl border border-dashed border-[var(--color-border)] text-[var(--color-fg-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
        >
          <Plus size={18} /> Add exercise
        </button>
      </div>

      <ExercisePickerSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(id) => void handlePick(id)}
        excludeIds={ordered.map((x) => x.exerciseId)}
      />

      {detailExerciseId && (
        <ExerciseDetailOverlay
          exerciseId={detailExerciseId}
          currentSessionId={session.id}
          sessionExerciseIds={ordered.map((x) => x.exerciseId)}
          onClose={() => setDetailExerciseId(null)}
          onSwapped={() => {
            setDetailExerciseId(null)
            void loadAll(session.id)
          }}
        />
      )}
    </>
  )
}
