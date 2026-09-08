import type {
  Exercise,
  LoadConvention,
  LoggedSet,
  RepBounds,
  SessionExerciseSnapshot,
  WorkoutSession,
} from '../db/types'
import { estimated1RMForLoad } from './analytics'
import {
  commonLoadConvention,
  loadConventionsComparable,
  repAttainment,
  resolveRepTarget,
  resolveSetLoadConvention,
  resolveSnapshotLoadConvention,
  setKindOf,
  isClassifiedSet,
  type RepTargetSource,
} from './measurement'

// Why an exercise has no comparable rep target. Distinguishing these is the
// point: "no plan existed" is a very different fact from "a plan existed but
// nobody could read it".
export type PlanKind =
  | 'planned' // came from the session's exercise snapshot
  | 'freestyle' // logged without any planned entry (added mid-session, or an
  // unplanned/freestyle workout)

export interface ExerciseAttainment {
  exerciseId: string
  exerciseName: string
  planKind: PlanKind
  // Planned working sets. Null for freestyle work — never 0, because "no plan"
  // and "planned zero sets" are different claims.
  plannedSets: number | null
  plannedWarmupSets: number | null
  loggedSets: number
  workingSets: number
  warmupSets: number
  unclassifiedSets: number
  // max(0, plannedSets - workingSets). Null when nothing was planned.
  // Deliberately named "unfinished", not "skipped": an unlogged set may have
  // been performed and not recorded, and the app cannot tell the difference.
  unfinishedSets: number | null
  repTarget: RepBounds | null
  repTargetSource: RepTargetSource
  setsBelowMinReps: number
  setsInRepRange: number
  setsAboveMaxReps: number
  setsWithoutRepTarget: number
  loadConvention: LoadConvention
  loadConventionRecorded: boolean
  // True when the logged sets do not all measure the same thing (an imported
  // history where some sets were recorded as total load and others as machine
  // settings). The single-number summaries are withheld in that case.
  mixedLoadConventions: boolean
  bestEstimated1RM: number | null
}

export interface SessionAttainment {
  sessionId: string
  sessionName: string
  completedAt: number | null
  exercises: ExerciseAttainment[]
  plannedSetTotal: number | null
  workingSetTotal: number
  warmupSetTotal: number
  unfinishedSetTotal: number | null
  // Number of planned exercises with no logged set at all.
  unstartedExerciseCount: number
  freestyleExerciseCount: number
}

function exerciseName(
  exercises: Map<string, Exercise>,
  exerciseId: string,
): string {
  return exercises.get(exerciseId)?.name ?? 'Unknown exercise'
}

export function buildSessionAttainment(
  session: WorkoutSession,
  sets: LoggedSet[],
  exercises: Map<string, Exercise>,
): SessionAttainment {
  const plan = new Map<string, SessionExerciseSnapshot>()
  for (const row of session.exerciseSnapshot) plan.set(row.exerciseId, row)

  const setsByExercise = new Map<string, LoggedSet[]>()
  for (const set of sets) {
    if (set.workoutSessionId !== session.id) continue
    const rows = setsByExercise.get(set.exerciseId) ?? []
    rows.push(set)
    setsByExercise.set(set.exerciseId, rows)
  }

  const orderedIds = [
    ...session.exerciseSnapshot
      .slice()
      .sort((a, b) => a.order - b.order || a.exerciseId.localeCompare(b.exerciseId))
      .map((row) => row.exerciseId),
    ...Array.from(setsByExercise.keys()).filter((id) => !plan.has(id)),
  ]

  const rows: ExerciseAttainment[] = []
  for (const exerciseId of orderedIds) {
    const snapshot = plan.get(exerciseId)
    const logged = setsByExercise.get(exerciseId) ?? []
    rows.push(
      buildExerciseAttainment({
        exerciseId,
        exerciseName: exerciseName(exercises, exerciseId),
        snapshot,
        sets: logged,
        exercise: exercises.get(exerciseId),
      }),
    )
  }

  const plannedRows = rows.filter((row) => row.plannedSets !== null)
  const plannedSetTotal =
    plannedRows.length > 0
      ? plannedRows.reduce((sum, row) => sum + (row.plannedSets ?? 0), 0)
      : null
  const unfinishedSetTotal =
    plannedRows.length > 0
      ? plannedRows.reduce((sum, row) => sum + (row.unfinishedSets ?? 0), 0)
      : null

  return {
    sessionId: session.id,
    sessionName: session.name,
    completedAt: session.completedAt,
    exercises: rows,
    plannedSetTotal,
    workingSetTotal: rows.reduce((sum, row) => sum + row.workingSets, 0),
    warmupSetTotal: rows.reduce((sum, row) => sum + row.warmupSets, 0),
    unfinishedSetTotal,
    unstartedExerciseCount: rows.filter(
      (row) => row.planKind === 'planned' && row.loggedSets === 0,
    ).length,
    freestyleExerciseCount: rows.filter((row) => row.planKind === 'freestyle')
      .length,
  }
}

export function buildExerciseAttainment(args: {
  exerciseId: string
  exerciseName: string
  snapshot: SessionExerciseSnapshot | undefined
  sets: LoggedSet[]
  exercise: Exercise | undefined
}): ExerciseAttainment {
  const { snapshot, sets } = args
  const target = resolveRepTarget(snapshot)
  // A snapshot row with targetSets 0 is how the app records "added mid-session,
  // no prescription" — treat that as freestyle rather than a plan of zero.
  const planned =
    snapshot !== undefined && snapshot.targetSets > 0 ? snapshot.targetSets : null
  const planKind: PlanKind = planned === null ? 'freestyle' : 'planned'

  // Every set is read with its own frozen convention. A group whose sets do not
  // agree has no single unit, so `common` is null and the summary says so
  // instead of adopting the first set's units for the whole exercise.
  const common = commonLoadConvention(sets, snapshot)
  const mixedLoadConventions = common === null
  const convention = common ?? resolveSnapshotLoadConvention(snapshot)

  let workingSets = 0
  let warmupSets = 0
  let unclassifiedSets = 0
  let setsBelowMinReps = 0
  let setsInRepRange = 0
  let setsAboveMaxReps = 0
  let setsWithoutRepTarget = 0
  let bestEstimated1RM: number | null = null

  for (const set of sets) {
    if (!isClassifiedSet(set)) unclassifiedSets += 1
    if (setKindOf(set) === 'warmup') {
      warmupSets += 1
      continue
    }
    workingSets += 1
    switch (repAttainment(set.reps, target.bounds)) {
      case 'below_min':
        setsBelowMinReps += 1
        break
      case 'above_max':
        setsAboveMaxReps += 1
        break
      case 'in_range':
        setsInRepRange += 1
        break
      default:
        setsWithoutRepTarget += 1
    }
    const est = estimated1RMForLoad(
      set.weightLbs,
      set.reps,
      resolveSetLoadConvention(set, snapshot),
    )
    if (est !== null && (bestEstimated1RM === null || est > bestEstimated1RM)) {
      bestEstimated1RM = est
    }
  }

  return {
    exerciseId: args.exerciseId,
    exerciseName: args.exerciseName,
    planKind,
    plannedSets: planned,
    plannedWarmupSets:
      typeof snapshot?.warmupSets === 'number' ? snapshot.warmupSets : null,
    loggedSets: sets.length,
    workingSets,
    warmupSets,
    unclassifiedSets,
    unfinishedSets: planned === null ? null : Math.max(0, planned - workingSets),
    repTarget: target.bounds,
    repTargetSource: planKind === 'freestyle' ? 'missing' : target.source,
    setsBelowMinReps,
    setsInRepRange,
    setsAboveMaxReps,
    setsWithoutRepTarget,
    loadConvention: convention,
    loadConventionRecorded: !mixedLoadConventions && convention !== 'unknown',
    mixedLoadConventions,
    // A single "best" across incompatible units would be a mislabelled maximum,
    // so it is withheld rather than reported.
    bestEstimated1RM:
      mixedLoadConventions || bestEstimated1RM === null
        ? null
        : Math.round(bestEstimated1RM),
  }
}

export interface ProgressionPoint {
  sessionId: string
  sessionName: string
  completedAt: number
  workingSets: number
  plannedSets: number | null
  bestEstimated1RM: number | null
  topSetWeightLbs: number | null
  topSetReps: number | null
  totalReps: number
}

export interface ComparableProgression {
  exerciseId: string
  exerciseName: string
  loadConvention: LoadConvention
  repTarget: RepBounds | null
  points: ProgressionPoint[]
  // Sessions dropped because their load convention or rep target did not match
  // the most recent session's. Reported so the chart can say so out loud.
  excludedSessionCount: number
  excludedReasons: {
    loadConvention: number
    repTarget: number
    mixedLoadConventions: number
  }
}

// Sessions are comparable when the same exercise was performed under the same
// load convention and against the same machine-readable rep target. Sessions
// whose target could not be parsed are only comparable with each other when
// the display text matches exactly.
export function buildComparableProgression(args: {
  exerciseId: string
  exercise: Exercise | undefined
  sessions: WorkoutSession[]
  sets: LoggedSet[]
  limit?: number
}): ComparableProgression {
  const sessionsById = new Map(args.sessions.map((s) => [s.id, s]))
  const grouped = new Map<string, LoggedSet[]>()
  for (const set of args.sets) {
    if (set.exerciseId !== args.exerciseId) continue
    const session = sessionsById.get(set.workoutSessionId)
    if (!session || session.completedAt === null) continue
    const rows = grouped.get(set.workoutSessionId) ?? []
    rows.push(set)
    grouped.set(set.workoutSessionId, rows)
  }

  interface Candidate {
    session: WorkoutSession
    snapshot: SessionExerciseSnapshot | undefined
    // Working sets only. A warm-up is not part of a session-to-session
    // performance comparison, and including it moved the top set.
    sets: LoggedSet[]
    // Null when this session's own working sets disagree about units.
    convention: LoadConvention | null
    target: RepBounds | null
    targetText: string
  }

  const candidates: Candidate[] = []
  for (const [sessionId, rows] of grouped) {
    const session = sessionsById.get(sessionId)
    if (!session || session.completedAt === null) continue
    const snapshot = session.exerciseSnapshot.find(
      (row) => row.exerciseId === args.exerciseId,
    )
    const working = rows.filter((set) => setKindOf(set) === 'working')
    if (working.length === 0) continue
    const target = resolveRepTarget(snapshot)
    candidates.push({
      session,
      snapshot,
      sets: working,
      // Derived from every working set, not the first one: a session whose
      // sets were imported under different conventions has no single unit.
      convention: commonLoadConvention(working, snapshot),
      target: target.bounds,
      targetText: (snapshot?.targetRepRange ?? '').trim().toLowerCase(),
    })
  }
  candidates.sort(
    (a, b) => (b.session.completedAt ?? 0) - (a.session.completedAt ?? 0),
  )

  const excludedReasons = {
    loadConvention: 0,
    repTarget: 0,
    mixedLoadConventions: 0,
  }
  // The reference is the newest session that actually has a single unit. A
  // mixed session cannot anchor a comparison.
  const reference = candidates.find(
    (candidate) => candidate.convention !== null,
  )
  const comparable: Candidate[] = []
  if (reference) {
    for (const candidate of candidates) {
      if (candidate.convention === null) {
        excludedReasons.mixedLoadConventions += 1
        continue
      }
      if (
        !loadConventionsComparable(
          candidate.convention,
          reference.convention as LoadConvention,
        )
      ) {
        excludedReasons.loadConvention += 1
        continue
      }
      const sameTarget =
        reference.target !== null && candidate.target !== null
          ? candidate.target.min === reference.target.min &&
            candidate.target.max === reference.target.max
          : reference.target === null &&
            candidate.target === null &&
            candidate.targetText === reference.targetText
      if (!sameTarget) {
        excludedReasons.repTarget += 1
        continue
      }
      comparable.push(candidate)
    }
  }

  const limited = comparable.slice(0, args.limit ?? comparable.length).reverse()
  const points: ProgressionPoint[] = limited.map((candidate) => {
    const working = candidate.sets
    let bestEst: number | null = null
    let topWeight: number | null = null
    let topReps: number | null = null
    let totalReps = 0
    for (const set of working) {
      totalReps += set.reps
      // Per set, not per session: the session-level convention is only used to
      // decide comparability, never to reinterpret an individual row.
      const est = estimated1RMForLoad(
        set.weightLbs,
        set.reps,
        resolveSetLoadConvention(set, candidate.snapshot),
      )
      if (est !== null && (bestEst === null || est > bestEst)) bestEst = est
      if (topWeight === null || set.weightLbs > topWeight) {
        topWeight = set.weightLbs
        topReps = set.reps
      }
    }
    return {
      sessionId: candidate.session.id,
      sessionName: candidate.session.name,
      completedAt: candidate.session.completedAt ?? 0,
      workingSets: working.length,
      plannedSets:
        candidate.snapshot && candidate.snapshot.targetSets > 0
          ? candidate.snapshot.targetSets
          : null,
      bestEstimated1RM: bestEst === null ? null : Math.round(bestEst),
      topSetWeightLbs: topWeight,
      topSetReps: topReps,
      totalReps,
    }
  })

  return {
    exerciseId: args.exerciseId,
    exerciseName: args.exercise?.name ?? 'Unknown exercise',
    loadConvention: reference?.convention ?? 'unknown',
    repTarget: reference?.target ?? null,
    points,
    excludedSessionCount:
      excludedReasons.loadConvention +
      excludedReasons.repTarget +
      excludedReasons.mixedLoadConventions,
    excludedReasons,
  }
}

export function hasUnfinishedWork(attainment: SessionAttainment): boolean {
  return (attainment.unfinishedSetTotal ?? 0) > 0
}
