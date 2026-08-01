import { db } from '../schema'
import type { Exercise, MuscleGroup } from '../types'

export interface ExerciseInput {
  name: string
  primaryMuscle: MuscleGroup
  secondaryMuscles: MuscleGroup[]
  notes: string
  defaultRestSeconds: number
  hiddenFromLibrary: boolean
}

async function findByNameCI(name: string, excludeId?: string) {
  const lower = name.trim().toLowerCase()
  const matches = await db.exercises
    .filter((e) => e.name.toLowerCase() === lower)
    .toArray()
  return excludeId ? matches.find((e) => e.id !== excludeId) : matches[0]
}

export async function createCustomExercise(input: ExerciseInput): Promise<string> {
  const name = input.name.trim()
  if (!name) throw new Error('Name is required')
  if (input.defaultRestSeconds <= 0) throw new Error('Rest must be > 0')
  const dup = await findByNameCI(name)
  if (dup) throw new Error(`An exercise named "${dup.name}" already exists`)

  const id = crypto.randomUUID()
  await db.exercises.add({
    ...input,
    name,
    id,
    isCustom: true,
    createdAt: Date.now(),
  })
  return id
}

export async function updateExercise(
  id: string,
  input: ExerciseInput,
): Promise<void> {
  const name = input.name.trim()
  if (!name) throw new Error('Name is required')
  if (input.defaultRestSeconds <= 0) throw new Error('Rest must be > 0')
  const dup = await findByNameCI(name, id)
  if (dup) throw new Error(`An exercise named "${dup.name}" already exists`)

  await db.exercises.update(id, { ...input, name })
}

export async function setHidden(id: string, hidden: boolean): Promise<void> {
  await db.exercises.update(id, { hiddenFromLibrary: hidden })
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
