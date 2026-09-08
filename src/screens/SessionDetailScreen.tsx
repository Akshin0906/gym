import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Header } from '../components/Header'
import { LoadFailure } from '../components/Feedback'
import { SessionAttainmentCard } from '../components/SessionAttainmentCard'
import { SetLogger } from '../components/SetLogger'
import { getExercisesByIds } from '../db/repositories/exercises'
import {
  deleteSession,
  getSession,
  getSetsForSession,
  setUnfinishedWorkReason,
} from '../db/repositories/sessions'
import type {
  Exercise,
  LoggedSet,
  UnfinishedWorkReason,
  WorkoutSession,
} from '../db/types'
import { relativeOrAbsolute } from '../lib/dates'
import { resolveSnapshotLoadConvention } from '../lib/measurement'
import { buildSessionAttainment } from '../lib/plannedVsPerformed'
import { useActiveWorkout } from '../store/activeWorkout'
import { useTimer } from '../store/timer'

export function SessionDetailScreen() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const { sessionId: activeSessionId, setActiveSession } = useActiveWorkout()
  const stopRest = useTimer((s) => s.stop)
  const [session, setSession] = useState<WorkoutSession | null>(null)
  const [sets, setSets] = useState<LoggedSet[]>([])
  const [exMap, setExMap] = useState<Map<string, Exercise>>(new Map())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!sessionId) return
    setLoadError(null)
    try {
      const s = await getSession(sessionId)
      if (!s) {
        navigate('/history')
        return
      }
      setSession(s)
      const ls = await getSetsForSession(sessionId)
      setSets(ls)
      const exIds = Array.from(
        new Set([
          ...s.exerciseSnapshot.map((x) => x.exerciseId),
          ...ls.map((x) => x.exerciseId),
        ]),
      )
      setExMap(await getExercisesByIds(exIds))
    } catch (err) {
      // A rejected IndexedDB read used to leave a permanent "Loading…".
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [sessionId, navigate])

  useEffect(() => {
    void load()
  }, [load])

  const attainment = useMemo(
    () => (session ? buildSessionAttainment(session, sets, exMap) : null),
    [session, sets, exMap],
  )

  async function handleDelete() {
    if (!session) return
    if (!confirm('Delete this whole session?')) return
    await deleteSession(session.id)
    if (activeSessionId === session.id) {
      stopRest()
      setActiveSession(null)
    }
    navigate('/history')
  }

  async function recordReason(reason: UnfinishedWorkReason | null) {
    if (!session) return
    await setUnfinishedWorkReason(session.id, reason)
    await load()
  }

  if (loadError) {
    return (
      <>
        <Header title="Session" back="/history" />
        <LoadFailure
          message={`Could not load this session: ${loadError}`}
          onRetry={() => {
            setLoading(true)
            void load()
          }}
        />
      </>
    )
  }

  if (loading || !session) {
    return (
      <>
        <Header title="Session" back="/history" />
        <p className="p-6 text-neutral-500 text-center">Loading…</p>
      </>
    )
  }

  // Build display order: snapshot exercises first (in order), then any not in snapshot (freestyle-added) preserving log order.
  const snapshotOrder = [...session.exerciseSnapshot].sort(
    (a, b) => a.order - b.order,
  )
  const snapshotIds = new Set(snapshotOrder.map((s) => s.exerciseId))
  const extraExerciseIds: string[] = []
  for (const s of sets) {
    if (!snapshotIds.has(s.exerciseId) && !extraExerciseIds.includes(s.exerciseId)) {
      extraExerciseIds.push(s.exerciseId)
    }
  }
  const allExerciseIds = [
    ...snapshotOrder.map((s) => s.exerciseId),
    ...extraExerciseIds,
  ]

  const setsByExercise = new Map<string, LoggedSet[]>()
  for (const s of sets) {
    const list = setsByExercise.get(s.exerciseId) ?? []
    list.push(s)
    setsByExercise.set(s.exerciseId, list)
  }

  return (
    <>
      <Header
        title={session.name}
        subtitle={[
          session.programName,
          relativeOrAbsolute(session.startedAt),
        ]
          .filter(Boolean)
          .join(' · ')}
        back="/history"
      />
      <div className="px-4 py-4 space-y-6">
        {attainment && attainment.exercises.length > 0 && (
          <SessionAttainmentCard
            attainment={attainment}
            unfinishedWork={session.unfinishedWork}
            canRecordReason={session.completedAt !== null}
            onSelectReason={recordReason}
          />
        )}

        {allExerciseIds.length === 0 ? (
          <p className="text-neutral-500 text-center py-4">
            No sets logged in this session.
          </p>
        ) : (
          allExerciseIds.map((exId) => {
            const ex = exMap.get(exId)
            if (!ex) return null
            const existing = (setsByExercise.get(exId) ?? []).sort(
              (a, b) => a.setNumber - b.setNumber,
            )
            return (
              <section key={exId} className="space-y-2">
                <h2 className="font-semibold">{ex.name}</h2>
                <SetLogger
                  sessionId={session.id}
                  exerciseId={ex.id}
                  existingSets={existing}
                  previousSets={[]}
                  defaultRestSeconds={ex.defaultRestSeconds}
                  loadConvention={resolveSnapshotLoadConvention(
                    session.exerciseSnapshot.find(
                      (row) => row.exerciseId === ex.id,
                    ),
                  )}
                  onChange={() => void load()}
                />
              </section>
            )
          })
        )}

        <div className="pt-4 border-t border-neutral-800">
          <button
            type="button"
            onClick={() => void handleDelete()}
            className="text-sm text-red-400"
          >
            Delete session
          </button>
        </div>
      </div>
    </>
  )
}
