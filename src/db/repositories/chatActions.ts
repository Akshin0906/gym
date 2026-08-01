import { db } from '../schema'
import type { Exercise, SessionExerciseSnapshot, WorkoutSession } from '../types'
import type {
  CoachAction,
  CoachActionPlan,
  CoachActionResult,
  CoachActionScope,
  CoachActionStateHashes,
  PlannedExercise,
} from '../../lib/chatTypes'

export class CoachActionValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoachActionValidationError'
  }
}

export class StaleCoachActionError extends Error {
  constructor() {
    super('The data this Coach plan would change has been updated. Ask Coach to refresh it.')
    this.name = 'StaleCoachActionError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(
  value: unknown,
  label: string,
  maxLength = 120,
): string {
  if (typeof value !== 'string') {
    throw new CoachActionValidationError(`${label} must be text`)
  }
  const trimmed = value.trim()
  if (!trimmed) throw new CoachActionValidationError(`${label} is required`)
  if (trimmed.length > maxLength) {
    throw new CoachActionValidationError(`${label} is too long`)
  }
  return trimmed
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 20) {
    throw new CoachActionValidationError(`${label} must be a whole number from 1 to 20`)
  }
  return value as number
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1000) {
    throw new CoachActionValidationError(`${label} must be a whole number from 0 to 1000`)
  }
  return value as number
}

function requiredHash(value: unknown, label: string): string {
  const hash = requiredString(value, label, 128).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new CoachActionValidationError(`${label} must be a SHA-256 fingerprint`)
  }
  return hash
}

function parsePlannedExercises(value: unknown, label: string): PlannedExercise[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) {
    throw new CoachActionValidationError(`${label} must contain 1 to 30 exercises`)
  }
  const exercises = value.map((raw, index) => {
    if (!isObject(raw)) {
      throw new CoachActionValidationError(`${label}[${index}] must be an object`)
    }
    return {
      exerciseId: requiredString(
        raw.exerciseId,
        `${label}[${index}].exerciseId`,
        200,
      ),
      targetSets: positiveInteger(raw.targetSets, `${label}[${index}].targetSets`),
      repRange: requiredString(raw.repRange, `${label}[${index}].repRange`, 50),
    }
  })
  const ids = new Set(exercises.map((exercise) => exercise.exerciseId))
  if (ids.size !== exercises.length) {
    throw new CoachActionValidationError(`${label} contains a duplicate exercise`)
  }
  return exercises
}

function parseAction(raw: unknown, index: number): CoachAction {
  if (!isObject(raw)) {
    throw new CoachActionValidationError(`actions[${index}] must be an object`)
  }
  const type = requiredString(raw.type, `actions[${index}].type`)
  const prefix = `actions[${index}]`
  switch (type) {
    case 'swap_active_exercise':
      return {
        type,
        sessionId: requiredString(raw.sessionId, `${prefix}.sessionId`, 200),
        fromExerciseId: requiredString(
          raw.fromExerciseId,
          `${prefix}.fromExerciseId`,
          200,
        ),
        toExerciseId: requiredString(raw.toExerciseId, `${prefix}.toExerciseId`, 200),
        targetSets: positiveInteger(raw.targetSets, `${prefix}.targetSets`),
        repRange: requiredString(raw.repRange, `${prefix}.repRange`, 50),
      }
    case 'add_active_exercise':
      return {
        type,
        sessionId: requiredString(raw.sessionId, `${prefix}.sessionId`, 200),
        exerciseId: requiredString(raw.exerciseId, `${prefix}.exerciseId`, 200),
        position: nonNegativeInteger(raw.position, `${prefix}.position`),
        targetSets: positiveInteger(raw.targetSets, `${prefix}.targetSets`),
        repRange: requiredString(raw.repRange, `${prefix}.repRange`, 50),
      }
    case 'update_active_exercise_targets':
      return {
        type,
        sessionId: requiredString(raw.sessionId, `${prefix}.sessionId`, 200),
        exerciseId: requiredString(raw.exerciseId, `${prefix}.exerciseId`, 200),
        targetSets: positiveInteger(raw.targetSets, `${prefix}.targetSets`),
        repRange: requiredString(raw.repRange, `${prefix}.repRange`, 50),
      }
    case 'create_one_time_workout':
      return {
        type,
        name: requiredString(raw.name, `${prefix}.name`),
        exercises: parsePlannedExercises(raw.exercises, `${prefix}.exercises`),
      }
    case 'create_session_template':
      return {
        type,
        programId: requiredString(raw.programId, `${prefix}.programId`, 200),
        name: requiredString(raw.name, `${prefix}.name`),
        exercises: parsePlannedExercises(raw.exercises, `${prefix}.exercises`),
      }
    case 'create_program': {
      if (!Array.isArray(raw.sessions) || raw.sessions.length === 0 || raw.sessions.length > 20) {
        throw new CoachActionValidationError(
          `${prefix}.sessions must contain 1 to 20 sessions`,
        )
      }
      const sessions = raw.sessions.map((session, sessionIndex) => {
        if (!isObject(session)) {
          throw new CoachActionValidationError(
            `${prefix}.sessions[${sessionIndex}] must be an object`,
          )
        }
        return {
          name: requiredString(
            session.name,
            `${prefix}.sessions[${sessionIndex}].name`,
          ),
          exercises: parsePlannedExercises(
            session.exercises,
            `${prefix}.sessions[${sessionIndex}].exercises`,
          ),
        }
      })
      const names = sessions.map((session) => session.name.toLocaleLowerCase())
      if (new Set(names).size !== names.length) {
        throw new CoachActionValidationError(`${prefix}.sessions has duplicate names`)
      }
      return {
        type,
        name: requiredString(raw.name, `${prefix}.name`),
        sessions,
      }
    }
    default:
      throw new CoachActionValidationError(`Unsupported Coach action: ${type}`)
  }
}

function isScope(value: unknown): value is CoachActionScope {
  return (
    value === 'active_workout' ||
    value === 'one_time_workout' ||
    value === 'program'
  )
}

function validateScope(plan: CoachActionPlan): void {
  const activeTypes = new Set<CoachAction['type']>([
    'swap_active_exercise',
    'add_active_exercise',
    'update_active_exercise_targets',
  ])
  if (plan.scope === 'active_workout') {
    if (!plan.actions.every((action) => activeTypes.has(action.type))) {
      throw new CoachActionValidationError(
        'An active-workout plan may only modify the active workout',
      )
    }
    const sessionIds = new Set(
      plan.actions.map((action) =>
        'sessionId' in action ? action.sessionId : '',
      ),
    )
    if (sessionIds.size !== 1) {
      throw new CoachActionValidationError(
        'All active-workout actions must target the same session',
      )
    }
    return
  }
  if (plan.actions.length !== 1) {
    throw new CoachActionValidationError(
      'Workout and program creation plans must contain exactly one action',
    )
  }
  const only = plan.actions[0]
  if (plan.scope === 'one_time_workout' && only.type !== 'create_one_time_workout') {
    throw new CoachActionValidationError(
      'A one-time workout plan must create one one-time workout',
    )
  }
  if (
    plan.scope === 'program' &&
    only.type !== 'create_session_template' &&
    only.type !== 'create_program'
  ) {
    throw new CoachActionValidationError(
      'A program plan must create a session template or program',
    )
  }
}

export function parseCoachActionPlan(raw: unknown): CoachActionPlan {
  if (!isObject(raw)) throw new CoachActionValidationError('Action plan is missing')
  if (!isScope(raw.scope)) {
    throw new CoachActionValidationError('Action plan has an invalid scope')
  }
  const sourceStateHash = requiredHash(raw.sourceStateHash, 'sourceStateHash')
  const sourceActionStateHash = requiredHash(
    raw.sourceActionStateHash,
    'sourceActionStateHash',
  )
  if (!Array.isArray(raw.actions) || raw.actions.length === 0 || raw.actions.length > 12) {
    throw new CoachActionValidationError('Action plan must contain 1 to 12 actions')
  }
  const plan: CoachActionPlan = {
    title: requiredString(raw.title, 'title'),
    summary: requiredString(raw.summary, 'summary', 1000),
    scope: raw.scope,
    sourceStateHash,
    sourceActionStateHash,
    actions: raw.actions.map(parseAction),
  }
  validateScope(plan)
  return plan
}

async function requireAvailableExercise(exerciseId: string): Promise<Exercise> {
  const exercise = await db.exercises.get(exerciseId)
  if (!exercise) throw new CoachActionValidationError('Exercise no longer exists')
  if (exercise.hiddenFromLibrary) {
    throw new CoachActionValidationError(`${exercise.name} is hidden from the library`)
  }
  return exercise
}

async function requireActiveSession(sessionId: string): Promise<WorkoutSession> {
  const session = await db.workoutSessions.get(sessionId)
  if (!session) throw new CoachActionValidationError('Workout no longer exists')
  if (session.completedAt !== null) {
    throw new CoachActionValidationError('That workout has already ended')
  }
  return session
}

function denseSnapshot(snapshot: SessionExerciseSnapshot[]): SessionExerciseSnapshot[] {
  return snapshot.map((row, order) => ({ ...row, order }))
}

async function validatePlannedExerciseIds(
  exercises: PlannedExercise[],
): Promise<Map<string, Exercise>> {
  const result = new Map<string, Exercise>()
  for (const planned of exercises) {
    result.set(planned.exerciseId, await requireAvailableExercise(planned.exerciseId))
  }
  return result
}

function snapshotFromPlan(exercises: PlannedExercise[]): SessionExerciseSnapshot[] {
  return exercises.map((exercise, order) => ({
    exerciseId: exercise.exerciseId,
    order,
    targetSets: exercise.targetSets,
    targetRepRange: exercise.repRange,
  }))
}

function parseStoredResult(raw: string): CoachActionResult {
  try {
    return JSON.parse(raw) as CoachActionResult
  } catch {
    throw new CoachActionValidationError('Saved Coach action receipt is malformed')
  }
}

export async function getAppliedCoachActionResult(
  proposalId: string,
): Promise<CoachActionResult | null> {
  const receipt = await db.chatActionReceipts.get(proposalId)
  return receipt ? parseStoredResult(receipt.resultJson) : null
}

export async function applyCoachActionPlan(args: {
  proposalId: string
  rawPlan: unknown
  currentStateHash: string
  currentActionStateHashes: CoachActionStateHashes
}): Promise<CoachActionResult> {
  const proposalId = requiredString(args.proposalId, 'proposalId')
  const plan = parseCoachActionPlan(args.rawPlan)
  requiredHash(args.currentStateHash, 'currentStateHash')
  const currentActionStateHash = requiredHash(
    args.currentActionStateHashes[plan.scope],
    `currentActionStateHashes.${plan.scope}`,
  )

  const prior = await db.chatActionReceipts.get(proposalId)
  if (prior) {
    if (prior.sourceStateHash !== plan.sourceStateHash) {
      throw new CoachActionValidationError('Proposal ID conflicts with an applied action')
    }
    const stored = parseStoredResult(prior.resultJson)
    if (
      stored.sourceActionStateHash &&
      stored.sourceActionStateHash !== plan.sourceActionStateHash
    ) {
      throw new CoachActionValidationError('Proposal ID conflicts with an applied action')
    }
    return {
      ...stored,
      sourceActionStateHash:
        stored.sourceActionStateHash ?? plan.sourceActionStateHash,
      replayed: true,
    }
  }
  if (currentActionStateHash !== plan.sourceActionStateHash) {
    throw new StaleCoachActionError()
  }

  return db.transaction(
    'rw',
    [
      db.exercises,
      db.programs,
      db.sessionTemplates,
      db.templateExercises,
      db.workoutSessions,
      db.loggedSets,
      db.chatActionReceipts,
    ],
    async () => {
      const raced = await db.chatActionReceipts.get(proposalId)
      if (raced) {
        if (raced.sourceStateHash !== plan.sourceStateHash) {
          throw new CoachActionValidationError(
            'Proposal ID conflicts with an applied action',
          )
        }
        const stored = parseStoredResult(raced.resultJson)
        if (
          stored.sourceActionStateHash &&
          stored.sourceActionStateHash !== plan.sourceActionStateHash
        ) {
          throw new CoachActionValidationError(
            'Proposal ID conflicts with an applied action',
          )
        }
        return {
          ...stored,
          sourceActionStateHash:
            stored.sourceActionStateHash ?? plan.sourceActionStateHash,
          replayed: true,
        }
      }

      const now = Date.now()
      const result: CoachActionResult = {
        proposalId,
        appliedAt: now,
        sourceStateHash: plan.sourceStateHash,
        sourceActionStateHash: plan.sourceActionStateHash,
        replayed: false,
        changes: [],
      }

      for (const action of plan.actions) {
        switch (action.type) {
          case 'add_active_exercise': {
            const [session, exercise] = await Promise.all([
              requireActiveSession(action.sessionId),
              requireAvailableExercise(action.exerciseId),
            ])
            const snapshot = session.exerciseSnapshot
              .slice()
              .sort((a, b) => a.order - b.order)
            if (snapshot.some((row) => row.exerciseId === action.exerciseId)) {
              throw new CoachActionValidationError(
                `${exercise.name} is already in this workout`,
              )
            }
            if (action.position > snapshot.length) {
              throw new CoachActionValidationError(
                `Exercise position ${action.position} is outside this workout`,
              )
            }
            snapshot.splice(action.position, 0, {
              exerciseId: action.exerciseId,
              order: action.position,
              targetSets: action.targetSets,
              targetRepRange: action.repRange,
            })
            const updated = await db.workoutSessions.update(session.id, {
              exerciseSnapshot: denseSnapshot(snapshot),
              doneExerciseIds: (session.doneExerciseIds ?? []).filter(
                (id) => id !== action.exerciseId,
              ),
            })
            if (updated !== 1) throw new CoachActionValidationError('Workout changed')
            result.changes.push({
              type: action.type,
              label: `Added ${exercise.name}`,
              entityId: exercise.id,
            })
            result.activeSessionId = session.id
            break
          }
          case 'swap_active_exercise': {
            if (action.fromExerciseId === action.toExerciseId) {
              throw new CoachActionValidationError('Choose a different replacement exercise')
            }
            const [session, fromExercise, toExercise] = await Promise.all([
              requireActiveSession(action.sessionId),
              db.exercises.get(action.fromExerciseId),
              requireAvailableExercise(action.toExerciseId),
            ])
            if (!fromExercise) {
              throw new CoachActionValidationError('Original exercise no longer exists')
            }
            const snapshot = session.exerciseSnapshot
              .slice()
              .sort((a, b) => a.order - b.order)
            const sourceIndex = snapshot.findIndex(
              (row) => row.exerciseId === action.fromExerciseId,
            )
            if (sourceIndex === -1) {
              throw new CoachActionValidationError(
                `${fromExercise.name} is no longer in this workout`,
              )
            }
            if (snapshot.some((row) => row.exerciseId === action.toExerciseId)) {
              throw new CoachActionValidationError(
                `${toExercise.name} is already in this workout`,
              )
            }
            const source = snapshot[sourceIndex]
            const loggedCount = await db.loggedSets
              .where('workoutSessionId')
              .equals(session.id)
              .and((set) => set.exerciseId === action.fromExerciseId)
              .count()
            let doneIds = session.doneExerciseIds ?? []
            if (loggedCount === 0) {
              snapshot[sourceIndex] = {
                ...source,
                exerciseId: action.toExerciseId,
                targetSets: action.targetSets,
                targetRepRange: action.repRange,
              }
              doneIds = doneIds.filter(
                (id) => id !== action.fromExerciseId && id !== action.toExerciseId,
              )
            } else {
              snapshot[sourceIndex] = {
                ...source,
                targetSets: loggedCount,
              }
              snapshot.splice(sourceIndex + 1, 0, {
                exerciseId: action.toExerciseId,
                order: source.order + 1,
                targetSets: action.targetSets,
                targetRepRange: action.repRange,
              })
              doneIds = doneIds.filter((id) => id !== action.toExerciseId)
              if (!doneIds.includes(action.fromExerciseId)) {
                doneIds = [...doneIds, action.fromExerciseId]
              }
            }
            const updated = await db.workoutSessions.update(session.id, {
              exerciseSnapshot: denseSnapshot(snapshot),
              doneExerciseIds: doneIds,
            })
            if (updated !== 1) throw new CoachActionValidationError('Workout changed')
            result.changes.push({
              type: action.type,
              label: `Swapped ${fromExercise.name} for ${toExercise.name}`,
              entityId: toExercise.id,
            })
            result.activeSessionId = session.id
            break
          }
          case 'update_active_exercise_targets': {
            const [session, exercise] = await Promise.all([
              requireActiveSession(action.sessionId),
              db.exercises.get(action.exerciseId),
            ])
            if (!exercise) throw new CoachActionValidationError('Exercise no longer exists')
            const index = session.exerciseSnapshot.findIndex(
              (row) => row.exerciseId === action.exerciseId,
            )
            if (index === -1) {
              throw new CoachActionValidationError(
                `${exercise.name} is no longer in this workout`,
              )
            }
            const snapshot = session.exerciseSnapshot.slice()
            const loggedCount = await db.loggedSets
              .where('workoutSessionId')
              .equals(session.id)
              .and((set) => set.exerciseId === action.exerciseId)
              .count()
            if (action.targetSets < loggedCount) {
              throw new CoachActionValidationError(
                `${exercise.name} already has ${loggedCount} logged sets`,
              )
            }
            snapshot[index] = {
              ...snapshot[index],
              targetSets: action.targetSets,
              targetRepRange: action.repRange,
            }
            const updated = await db.workoutSessions.update(session.id, {
              exerciseSnapshot: snapshot,
            })
            if (updated !== 1) throw new CoachActionValidationError('Workout changed')
            result.changes.push({
              type: action.type,
              label: `Set ${exercise.name} to ${action.targetSets} × ${action.repRange}`,
              entityId: exercise.id,
            })
            result.activeSessionId = session.id
            break
          }
          case 'create_one_time_workout': {
            await validatePlannedExerciseIds(action.exercises)
            const existing = await db.workoutSessions
              .filter((session) => session.completedAt === null)
              .toArray()
            if (existing.length > 0) {
              const existingIds = existing.map((session) => session.id)
              const existingSets = await db.loggedSets
                .where('workoutSessionId')
                .anyOf(existingIds)
                .toArray()
              const workedSessionId = existingSets[0]?.workoutSessionId
              if (workedSessionId) {
                const workedSession = existing.find(
                  (session) => session.id === workedSessionId,
                )
                throw new CoachActionValidationError(
                  `Finish or discard ${workedSession?.name ?? 'your active workout'} before starting another workout`,
                )
              }
              await db.workoutSessions.bulkDelete(existingIds)
            }
            const sessionId = crypto.randomUUID()
            await db.workoutSessions.add({
              id: sessionId,
              sessionTemplateId: null,
              programId: null,
              name: action.name,
              programName: null,
              exerciseSnapshot: snapshotFromPlan(action.exercises),
              startedAt: now,
              completedAt: null,
            })
            result.changes.push({
              type: action.type,
              label: `Created ${action.name}`,
              entityId: sessionId,
            })
            result.activeSessionId = sessionId
            break
          }
          case 'create_session_template': {
            const program = await db.programs.get(action.programId)
            if (!program) throw new CoachActionValidationError('Program no longer exists')
            if (program.archivedAt !== null) {
              throw new CoachActionValidationError('Restore that program before editing it')
            }
            await validatePlannedExerciseIds(action.exercises)
            const siblings = await db.sessionTemplates
              .where('programId')
              .equals(program.id)
              .toArray()
            const order = siblings.length
              ? Math.max(...siblings.map((row) => row.order)) + 1
              : 0
            const templateId = crypto.randomUUID()
            await db.sessionTemplates.add({
              id: templateId,
              programId: program.id,
              name: action.name,
              order,
            })
            await db.templateExercises.bulkAdd(
              action.exercises.map((exercise, exerciseOrder) => ({
                id: crypto.randomUUID(),
                sessionTemplateId: templateId,
                exerciseId: exercise.exerciseId,
                order: exerciseOrder,
                targetSets: exercise.targetSets,
                targetRepRange: exercise.repRange,
              })),
            )
            result.changes.push({
              type: action.type,
              label: `Added ${action.name} to ${program.name}`,
              entityId: templateId,
            })
            result.programId = program.id
            result.sessionTemplateId = templateId
            break
          }
          case 'create_program': {
            for (const session of action.sessions) {
              await validatePlannedExerciseIds(session.exercises)
            }
            const programId = crypto.randomUUID()
            await db.programs.add({
              id: programId,
              name: action.name,
              isActive: 0,
              createdAt: now,
              archivedAt: null,
            })
            for (let sessionOrder = 0; sessionOrder < action.sessions.length; sessionOrder++) {
              const session = action.sessions[sessionOrder]
              const templateId = crypto.randomUUID()
              await db.sessionTemplates.add({
                id: templateId,
                programId,
                name: session.name,
                order: sessionOrder,
              })
              await db.templateExercises.bulkAdd(
                session.exercises.map((exercise, exerciseOrder) => ({
                  id: crypto.randomUUID(),
                  sessionTemplateId: templateId,
                  exerciseId: exercise.exerciseId,
                  order: exerciseOrder,
                  targetSets: exercise.targetSets,
                  targetRepRange: exercise.repRange,
                })),
              )
            }
            result.changes.push({
              type: action.type,
              label: `Created ${action.name}`,
              entityId: programId,
            })
            result.programId = programId
            break
          }
        }
      }

      await db.chatActionReceipts.add({
        proposalId,
        appliedAt: result.appliedAt,
        sourceStateHash: plan.sourceStateHash,
        resultJson: JSON.stringify(result),
      })
      return result
    },
  )
}
