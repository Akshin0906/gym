import Dexie from 'dexie'
import { db } from '../schema'
import { addAiNote } from './aiMemory'
import { createCustomExercise } from './exercises'
import { hashProgramActionState } from '../../lib/chatContext'
import type {
  Exercise,
  MuscleGroup,
  SessionExerciseSnapshot,
  SessionTemplate,
  WorkoutSession,
} from '../types'
import type {
  CoachAction,
  CoachActionPlan,
  CoachActionResult,
  CoachActionScope,
  CoachActionStateHashes,
  PlannedExercise,
  PlannedProgramSession,
} from '../../lib/chatTypes'

const MUSCLE_GROUPS: readonly MuscleGroup[] = [
  'chest',
  'back',
  'shoulders',
  'biceps',
  'triceps',
  'forearms',
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'abs',
  'traps',
]

const ACTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  swap_active_exercise: [
    'type',
    'sessionId',
    'fromExerciseId',
    'toExerciseId',
    'targetSets',
    'repRange',
  ],
  add_active_exercise: [
    'type',
    'sessionId',
    'exerciseId',
    'position',
    'targetSets',
    'repRange',
  ],
  update_active_exercise_targets: [
    'type',
    'sessionId',
    'exerciseId',
    'targetSets',
    'repRange',
  ],
  create_one_time_workout: ['type', 'name', 'exercises'],
  create_session_template: ['type', 'programId', 'name', 'exercises'],
  create_program: ['type', 'name', 'sessions'],
  rename_program: ['type', 'programId', 'name'],
  replace_program: ['type', 'programId', 'name', 'sessions'],
  archive_program: ['type', 'programId'],
  replace_session_template: ['type', 'sessionTemplateId', 'name', 'exercises'],
  delete_session_template: ['type', 'sessionTemplateId'],
  create_custom_exercise: [
    'type',
    'name',
    'primaryMuscle',
    'secondaryMuscles',
    'notes',
    'defaultRestSeconds',
  ],
  save_ai_note: ['type', 'body'],
}

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

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected)
  const actual = Object.keys(value)
  const missing = expected.filter((key) => !(key in value))
  const extra = actual.filter((key) => !expectedSet.has(key))
  if (missing.length === 0 && extra.length === 0) return
  const details = [
    missing.length ? `missing=${missing.join(',')}` : null,
    extra.length ? `extra=${extra.join(',')}` : null,
  ].filter((detail): detail is string => detail !== null)
  throw new CoachActionValidationError(
    `${label} has incorrect fields; ${details.join('; ')}`,
  )
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

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new CoachActionValidationError(
      `${label} must be a whole number from ${minimum} to ${maximum}`,
    )
  }
  return value as number
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new CoachActionValidationError(`${label} must be text`)
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw new CoachActionValidationError(`${label} is too long`)
  }
  return trimmed
}

function nullableId(value: unknown, label: string): string | null {
  if (value === null) return null
  return requiredString(value, label, 200)
}

function muscleGroup(value: unknown, label: string): MuscleGroup {
  if (
    typeof value !== 'string' ||
    !MUSCLE_GROUPS.includes(value as MuscleGroup)
  ) {
    throw new CoachActionValidationError(`${label} is not a supported muscle group`)
  }
  return value as MuscleGroup
}

function secondaryMuscles(
  value: unknown,
  label: string,
  primary: MuscleGroup,
): MuscleGroup[] {
  if (!Array.isArray(value) || value.length > MUSCLE_GROUPS.length - 1) {
    throw new CoachActionValidationError(`${label} must be a list of muscle groups`)
  }
  const parsed = value.map((item, index) =>
    muscleGroup(item, `${label}[${index}]`),
  )
  if (new Set(parsed).size !== parsed.length) {
    throw new CoachActionValidationError(`${label} contains a duplicate muscle group`)
  }
  if (parsed.includes(primary)) {
    throw new CoachActionValidationError(
      `${label} cannot include the primary muscle group`,
    )
  }
  return parsed
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
    exactKeys(
      raw,
      ['exerciseId', 'targetSets', 'repRange'],
      `${label}[${index}]`,
    )
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

function parseReplacementSessions(
  value: unknown,
  label: string,
): PlannedProgramSession[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new CoachActionValidationError(`${label} must contain 1 to 20 sessions`)
  }
  const sessions = value.map((raw, index) => {
    if (!isObject(raw)) {
      throw new CoachActionValidationError(`${label}[${index}] must be an object`)
    }
    exactKeys(
      raw,
      ['sessionTemplateId', 'name', 'exercises'],
      `${label}[${index}]`,
    )
    return {
      sessionTemplateId: nullableId(
        raw.sessionTemplateId,
        `${label}[${index}].sessionTemplateId`,
      ),
      name: requiredString(raw.name, `${label}[${index}].name`),
      exercises: parsePlannedExercises(
        raw.exercises,
        `${label}[${index}].exercises`,
      ),
    }
  })
  const names = sessions.map((session) => session.name.toLocaleLowerCase())
  if (new Set(names).size !== names.length) {
    throw new CoachActionValidationError(`${label} has duplicate names`)
  }
  const retainedIds = sessions
    .map((session) => session.sessionTemplateId)
    .filter((id): id is string => id !== null)
  if (new Set(retainedIds).size !== retainedIds.length) {
    throw new CoachActionValidationError(`${label} has duplicate session template IDs`)
  }
  return sessions
}

function parseAction(raw: unknown, index: number): CoachAction {
  if (!isObject(raw)) {
    throw new CoachActionValidationError(`actions[${index}] must be an object`)
  }
  const type = requiredString(raw.type, `actions[${index}].type`)
  const prefix = `actions[${index}]`
  const expectedFields = ACTION_FIELDS[type]
  if (!expectedFields) {
    throw new CoachActionValidationError(`Unsupported Coach action: ${type}`)
  }
  exactKeys(raw, expectedFields, prefix)
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
        exactKeys(
          session,
          ['name', 'exercises'],
          `${prefix}.sessions[${sessionIndex}]`,
        )
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
    case 'rename_program':
      return {
        type,
        programId: requiredString(raw.programId, `${prefix}.programId`, 200),
        name: requiredString(raw.name, `${prefix}.name`),
      }
    case 'replace_program':
      return {
        type,
        programId: requiredString(raw.programId, `${prefix}.programId`, 200),
        name: requiredString(raw.name, `${prefix}.name`),
        sessions: parseReplacementSessions(raw.sessions, `${prefix}.sessions`),
      }
    case 'archive_program':
      return {
        type,
        programId: requiredString(raw.programId, `${prefix}.programId`, 200),
      }
    case 'replace_session_template':
      return {
        type,
        sessionTemplateId: requiredString(
          raw.sessionTemplateId,
          `${prefix}.sessionTemplateId`,
          200,
        ),
        name: requiredString(raw.name, `${prefix}.name`),
        exercises: parsePlannedExercises(raw.exercises, `${prefix}.exercises`),
      }
    case 'delete_session_template':
      return {
        type,
        sessionTemplateId: requiredString(
          raw.sessionTemplateId,
          `${prefix}.sessionTemplateId`,
          200,
        ),
      }
    case 'create_custom_exercise': {
      const primaryMuscle = muscleGroup(
        raw.primaryMuscle,
        `${prefix}.primaryMuscle`,
      )
      return {
        type,
        name: requiredString(raw.name, `${prefix}.name`),
        primaryMuscle,
        secondaryMuscles: secondaryMuscles(
          raw.secondaryMuscles,
          `${prefix}.secondaryMuscles`,
          primaryMuscle,
        ),
        notes: boundedText(raw.notes, `${prefix}.notes`, 2000),
        defaultRestSeconds: boundedInteger(
          raw.defaultRestSeconds,
          `${prefix}.defaultRestSeconds`,
          1,
          3600,
        ),
      }
    }
    case 'save_ai_note':
      return {
        type,
        body: requiredString(raw.body, `${prefix}.body`, 1000),
      }
    default:
      throw new CoachActionValidationError(`Unsupported Coach action: ${type}`)
  }
}

function isScope(value: unknown): value is CoachActionScope {
  return (
    value === 'active_workout' ||
    value === 'one_time_workout' ||
    value === 'program' ||
    value === 'exercise_library' ||
    value === 'ai_memory'
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
  if (plan.scope === 'ai_memory') {
    if (plan.actions.length !== 1 || plan.actions[0]?.type !== 'save_ai_note') {
      throw new CoachActionValidationError(
        'An AI-memory plan must save exactly one note',
      )
    }
    return
  }
  if (plan.scope === 'exercise_library') {
    if (
      plan.actions.length !== 1 ||
      plan.actions[0]?.type !== 'create_custom_exercise'
    ) {
      throw new CoachActionValidationError(
        'An exercise-library plan must create exactly one custom exercise',
      )
    }
    return
  }
  if (plan.actions.length !== 1) {
    throw new CoachActionValidationError(
      'Workout and program plans must contain exactly one action',
    )
  }
  const only = plan.actions[0]
  if (plan.scope === 'one_time_workout' && only.type !== 'create_one_time_workout') {
    throw new CoachActionValidationError(
      'A one-time workout plan must create one one-time workout',
    )
  }
  const programTypes = new Set<CoachAction['type']>([
    'create_session_template',
    'create_program',
    'rename_program',
    'replace_program',
    'archive_program',
    'replace_session_template',
    'delete_session_template',
  ])
  if (plan.scope === 'program' && !programTypes.has(only.type)) {
    throw new CoachActionValidationError(
      'A program plan may only create, rename, replace, archive, or delete a saved program workout',
    )
  }
}

export function parseCoachActionPlan(raw: unknown): CoachActionPlan {
  if (!isObject(raw)) throw new CoachActionValidationError('Action plan is missing')
  exactKeys(
    raw,
    [
      'title',
      'summary',
      'scope',
      'sourceStateHash',
      'sourceActionStateHash',
      'actions',
    ],
    'Action plan',
  )
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

async function requireEditableProgram(programId: string) {
  const program = await db.programs.get(programId)
  if (!program) throw new CoachActionValidationError('Program no longer exists')
  if (program.archivedAt !== null) {
    throw new CoachActionValidationError('Restore that program before editing it')
  }
  return program
}

async function requireSessionTemplate(
  sessionTemplateId: string,
): Promise<SessionTemplate> {
  const template = await db.sessionTemplates.get(sessionTemplateId)
  if (!template) {
    throw new CoachActionValidationError('Saved workout no longer exists')
  }
  return template
}

async function validateReplacementExerciseIds(
  exercises: PlannedExercise[],
  retainedExerciseIds: ReadonlySet<string>,
): Promise<void> {
  for (const planned of exercises) {
    const exercise = await db.exercises.get(planned.exerciseId)
    if (!exercise) {
      throw new CoachActionValidationError('Exercise no longer exists')
    }
    if (
      exercise.hiddenFromLibrary &&
      !retainedExerciseIds.has(planned.exerciseId)
    ) {
      throw new CoachActionValidationError(
        `${exercise.name} is hidden from the library`,
      )
    }
  }
}

async function replaceTemplateExercises(
  sessionTemplateId: string,
  exercises: PlannedExercise[],
): Promise<void> {
  await db.templateExercises
    .where('sessionTemplateId')
    .equals(sessionTemplateId)
    .delete()
  await db.templateExercises.bulkAdd(
    exercises.map((exercise, order) => ({
      id: crypto.randomUUID(),
      sessionTemplateId,
      exerciseId: exercise.exerciseId,
      order,
      targetSets: exercise.targetSets,
      targetRepRange: exercise.repRange,
    })),
  )
}

async function detachAndDeleteSessionTemplate(
  sessionTemplateId: string,
): Promise<void> {
  await db.templateExercises
    .where('sessionTemplateId')
    .equals(sessionTemplateId)
    .delete()
  const references = await db.workoutSessions
    .where('sessionTemplateId')
    .equals(sessionTemplateId)
    .toArray()
  for (const workout of references) {
    await db.workoutSessions.update(workout.id, { sessionTemplateId: null })
  }
  await db.sessionTemplates.delete(sessionTemplateId)
}

async function compactProgramSessionOrder(programId: string): Promise<void> {
  const siblings = await db.sessionTemplates
    .where('programId')
    .equals(programId)
    .sortBy('order')
  for (let order = 0; order < siblings.length; order++) {
    if (siblings[order].order !== order) {
      await db.sessionTemplates.update(siblings[order].id, { order })
    }
  }
}

async function programActionStateHashInTransaction(): Promise<string> {
  const [exercises, programs, templates, templateExercises] = await Promise.all([
    db.exercises.toArray(),
    db.programs.toArray(),
    db.sessionTemplates.toArray(),
    db.templateExercises.toArray(),
  ])
  return Dexie.waitFor(
    hashProgramActionState({
      exercises,
      programs,
      templates,
      templateExercises,
    }),
  )
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

export async function listPendingCoachActionResults(): Promise<
  CoachActionResult[]
> {
  const receipts = await db.chatActionReceipts.toArray()
  return receipts
    .map((receipt) => parseStoredResult(receipt.resultJson))
    .filter((result) => result.syncPending === true)
}

export async function markCoachActionSynced(
  proposalId: string,
): Promise<CoachActionResult> {
  const id = requiredString(proposalId, 'proposalId')
  return db.transaction('rw', db.chatActionReceipts, async () => {
    const receipt = await db.chatActionReceipts.get(id)
    if (!receipt) {
      throw new CoachActionValidationError('Saved Coach action receipt is missing')
    }
    const result = { ...parseStoredResult(receipt.resultJson), syncPending: false }
    const updated = await db.chatActionReceipts.update(id, {
      resultJson: JSON.stringify(result),
    })
    if (updated !== 1) {
      throw new CoachActionValidationError('Saved Coach action receipt changed')
    }
    return result
  })
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
      db.aiMemorySettings,
      db.aiNotes,
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

      if (plan.scope === 'program') {
        const transactionActionStateHash =
          await programActionStateHashInTransaction()
        if (transactionActionStateHash !== plan.sourceActionStateHash) {
          throw new StaleCoachActionError()
        }
      }

      const now = Date.now()
      const result: CoachActionResult = {
        proposalId,
        appliedAt: now,
        sourceStateHash: plan.sourceStateHash,
        sourceActionStateHash: plan.sourceActionStateHash,
        replayed: false,
        syncPending: true,
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
          case 'rename_program': {
            const program = await requireEditableProgram(action.programId)
            const updated = await db.programs.update(program.id, {
              name: action.name,
            })
            if (updated !== 1) {
              throw new CoachActionValidationError('Program changed')
            }
            result.changes.push({
              type: action.type,
              label: `Renamed ${program.name} to ${action.name}`,
              entityId: program.id,
            })
            result.programId = program.id
            break
          }
          case 'replace_program': {
            const program = await requireEditableProgram(action.programId)
            const existingTemplates = await db.sessionTemplates
              .where('programId')
              .equals(program.id)
              .toArray()
            const existingById = new Map(
              existingTemplates.map((template) => [template.id, template]),
            )

            // Validate the complete target graph before deleting or replacing
            // any rows. A hidden exercise may stay only in the same retained
            // template where the user was already using it.
            for (const replacement of action.sessions) {
              let retainedExerciseIds = new Set<string>()
              if (replacement.sessionTemplateId !== null) {
                const template = await requireSessionTemplate(
                  replacement.sessionTemplateId,
                )
                if (template.programId !== program.id) {
                  throw new CoachActionValidationError(
                    'A saved workout does not belong to that program',
                  )
                }
                const existingExercises = await db.templateExercises
                  .where('sessionTemplateId')
                  .equals(template.id)
                  .toArray()
                retainedExerciseIds = new Set(
                  existingExercises.map((row) => row.exerciseId),
                )
              }
              await validateReplacementExerciseIds(
                replacement.exercises,
                retainedExerciseIds,
              )
            }

            const updated = await db.programs.update(program.id, {
              name: action.name,
            })
            if (updated !== 1) {
              throw new CoachActionValidationError('Program changed')
            }

            const retainedTemplateIds = new Set(
              action.sessions
                .map((session) => session.sessionTemplateId)
                .filter((id): id is string => id !== null),
            )
            for (const template of existingTemplates) {
              if (!retainedTemplateIds.has(template.id)) {
                await detachAndDeleteSessionTemplate(template.id)
              }
            }

            for (let order = 0; order < action.sessions.length; order++) {
              const replacement = action.sessions[order]
              const sessionTemplateId =
                replacement.sessionTemplateId ?? crypto.randomUUID()
              if (replacement.sessionTemplateId === null) {
                await db.sessionTemplates.add({
                  id: sessionTemplateId,
                  programId: program.id,
                  name: replacement.name,
                  order,
                })
              } else {
                const template = existingById.get(sessionTemplateId)
                if (!template) {
                  throw new CoachActionValidationError(
                    'Saved workout changed while replacing the program',
                  )
                }
                const templateUpdated = await db.sessionTemplates.update(
                  sessionTemplateId,
                  { name: replacement.name, order },
                )
                if (templateUpdated !== 1) {
                  throw new CoachActionValidationError('Saved workout changed')
                }
              }
              await replaceTemplateExercises(
                sessionTemplateId,
                replacement.exercises,
              )
            }

            result.changes.push({
              type: action.type,
              label: `Replaced ${program.name} with ${action.name}`,
              entityId: program.id,
            })
            result.programId = program.id
            break
          }
          case 'archive_program': {
            const program = await db.programs.get(action.programId)
            if (!program) {
              throw new CoachActionValidationError('Program no longer exists')
            }
            if (program.archivedAt !== null) {
              throw new CoachActionValidationError('That program is already archived')
            }
            if (program.isActive === 1) {
              throw new CoachActionValidationError(
                'Activate another program before archiving this one',
              )
            }
            const updated = await db.programs.update(program.id, {
              isActive: 0,
              archivedAt: now,
            })
            if (updated !== 1) {
              throw new CoachActionValidationError('Program changed')
            }
            result.changes.push({
              type: action.type,
              label: `Archived ${program.name}`,
              entityId: program.id,
            })
            result.programId = program.id
            break
          }
          case 'replace_session_template': {
            const template = await requireSessionTemplate(
              action.sessionTemplateId,
            )
            const program = await requireEditableProgram(template.programId)
            const existingExercises = await db.templateExercises
              .where('sessionTemplateId')
              .equals(template.id)
              .toArray()
            await validateReplacementExerciseIds(
              action.exercises,
              new Set(existingExercises.map((row) => row.exerciseId)),
            )
            const updated = await db.sessionTemplates.update(template.id, {
              name: action.name,
            })
            if (updated !== 1) {
              throw new CoachActionValidationError('Saved workout changed')
            }
            await replaceTemplateExercises(template.id, action.exercises)
            result.changes.push({
              type: action.type,
              label: `Replaced ${template.name} in ${program.name}`,
              entityId: template.id,
            })
            result.programId = program.id
            result.sessionTemplateId = template.id
            break
          }
          case 'delete_session_template': {
            const template = await requireSessionTemplate(
              action.sessionTemplateId,
            )
            const program = await requireEditableProgram(template.programId)
            const savedWorkoutCount = await db.sessionTemplates
              .where('programId')
              .equals(program.id)
              .count()
            if (savedWorkoutCount <= 1) {
              throw new CoachActionValidationError(
                'Add another saved workout before removing the final one',
              )
            }
            await detachAndDeleteSessionTemplate(template.id)
            await compactProgramSessionOrder(program.id)
            result.changes.push({
              type: action.type,
              label: `Removed saved workout ${template.name} from ${program.name}`,
              entityId: template.id,
            })
            result.programId = program.id
            result.sessionTemplateId = template.id
            break
          }
          case 'create_custom_exercise': {
            const exerciseId = await createCustomExercise({
              name: action.name,
              primaryMuscle: action.primaryMuscle,
              secondaryMuscles: action.secondaryMuscles,
              notes: action.notes,
              defaultRestSeconds: action.defaultRestSeconds,
              hiddenFromLibrary: false,
            })
            result.changes.push({
              type: action.type,
              label: `Created ${action.name}`,
              entityId: exerciseId,
            })
            result.exerciseId = exerciseId
            break
          }
          case 'save_ai_note': {
            const noteId = await addAiNote(action.body)
            result.changes.push({
              type: action.type,
              label: 'Saved a note for AI Insights',
              entityId: noteId,
            })
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
