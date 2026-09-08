import { db } from '../schema'
import type { Exercise, ExerciseMeasurement, MuscleGroup } from '../types'
import { normalizedExerciseName } from '../../lib/exerciseName'
import { isLoadConvention } from '../../lib/measurement'
import { normalizeSecondaryMuscles } from '../../lib/muscles'
import { isValidRestSeconds } from '../../lib/restTimer'
import { mutateLocalData } from './syncState'

export interface ExerciseInput {
  name: string
  primaryMuscle: MuscleGroup
  secondaryMuscles: MuscleGroup[]
  notes: string
  defaultRestSeconds: number
  hiddenFromLibrary: boolean
  measurement?: ExerciseMeasurement
}

export class DuplicateExerciseNameError extends Error {
  constructor(existingName: string) {
    super(`An exercise named "${existingName}" already exists`)
    this.name = 'DuplicateExerciseNameError'
  }
}

// Read-only helper for callers that want to warn before submitting. It is NOT
// the uniqueness guarantee — that lives inside the write transaction below,
// because any check performed outside the transaction can be overtaken.
export async function findExerciseByName(
  name: string,
  excludeId?: string,
): Promise<Exercise | undefined> {
  const normalized = normalizedExerciseName(name)
  if (!normalized) return undefined
  const match = await db.exercises
    .where('normalizedName')
    .equals(normalized)
    .first()
  return match && match.id !== excludeId ? match : undefined
}

function validatedInput(input: ExerciseInput): {
  name: string
  normalizedName: string
} {
  const name = input.name.trim()
  if (!name) throw new Error('Name is required')
  if (!isValidRestSeconds(input.defaultRestSeconds)) {
    throw new Error('Rest must be a whole number from 1 to 3600 seconds')
  }
  if (
    input.measurement !== undefined &&
    !isLoadConvention(input.measurement.loadConvention)
  ) {
    throw new Error('Unknown load convention')
  }
  return { name, normalizedName: normalizedExerciseName(name) }
}

function measurementPatch(
  input: ExerciseInput,
): Pick<Exercise, 'measurement'> | Record<string, never> {
  // Omitting the field entirely (rather than writing `undefined`) keeps legacy
  // rows legacy instead of stamping them with a guessed convention.
  if (input.measurement === undefined) return {}
  if (input.measurement.loadConvention === 'unknown') return {}
  return { measurement: { loadConvention: input.measurement.loadConvention } }
}

export async function createCustomExercise(
  input: ExerciseInput,
): Promise<string> {
  const { name, normalizedName } = validatedInput(input)
  const id = crypto.randomUUID()

  await mutateLocalData([db.exercises], async () => {
    // Check and write inside one transaction over the exercises store, so two
    // concurrent creates of the same name are serialized rather than both
    // reading "no duplicate" and both inserting. The unique index on
    // normalizedName is the backstop if a future caller forgets.
    const existing = await db.exercises
      .where('normalizedName')
      .equals(normalizedName)
      .first()
    if (existing) throw new DuplicateExerciseNameError(existing.name)
    await db.exercises.add({
      ...input,
      ...measurementPatch(input),
      name,
      normalizedName,
      secondaryMuscles: normalizeSecondaryMuscles(
        input.primaryMuscle,
        input.secondaryMuscles,
      ),
      id,
      isCustom: true,
      createdAt: Date.now(),
    })
  })
  return id
}

export async function updateExercise(
  id: string,
  input: ExerciseInput,
): Promise<void> {
  const { name, normalizedName } = validatedInput(input)

  await mutateLocalData([db.exercises], async () => {
    const existing = await db.exercises
      .where('normalizedName')
      .equals(normalizedName)
      .first()
    if (existing && existing.id !== id) {
      throw new DuplicateExerciseNameError(existing.name)
    }
    const current = await db.exercises.get(id)
    if (!current) throw new Error('Exercise not found')
    const next: Exercise = {
      ...current,
      ...input,
      name,
      normalizedName,
      secondaryMuscles: normalizeSecondaryMuscles(
        input.primaryMuscle,
        input.secondaryMuscles,
      ),
    }
    // A rename must not resurrect a stale measurement block, and clearing the
    // convention back to "unknown" must actually remove it.
    if (input.measurement === undefined) {
      // Field not supplied by this caller: preserve whatever was stored.
      next.measurement = current.measurement
    } else if (input.measurement.loadConvention === 'unknown') {
      delete next.measurement
    } else {
      next.measurement = { loadConvention: input.measurement.loadConvention }
    }
    await db.exercises.put(next)
  })
}

export async function setHidden(id: string, hidden: boolean): Promise<void> {
  await mutateLocalData([db.exercises], async () => {
    await db.exercises.update(id, { hiddenFromLibrary: hidden })
  })
}

export async function getExercise(id: string): Promise<Exercise | undefined> {
  return db.exercises.get(id)
}

export async function getExercisesByIds(
  ids: string[],
): Promise<Map<string, Exercise>> {
  const rows = await db.exercises.bulkGet(ids)
  const map = new Map<string, Exercise>()
  for (const e of rows) if (e) map.set(e.id, e)
  return map
}

export async function listAllExercises(): Promise<Exercise[]> {
  const all = await db.exercises.toArray()
  return all.sort((a, b) => a.name.localeCompare(b.name))
}

export async function getExercisesForPicker(
  muscleGroup?: MuscleGroup,
): Promise<Exercise[]> {
  let q = db.exercises.filter((e) => !e.hiddenFromLibrary)
  if (muscleGroup) q = q.filter((e) => e.primaryMuscle === muscleGroup)
  return q.sortBy('name')
}
