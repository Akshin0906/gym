import type { MuscleGroup } from '../db/types'

export const MUSCLE_ORDER: MuscleGroup[] = [
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

export const MUSCLE_LABEL: Record<MuscleGroup, string> = {
  chest: 'Chest',
  back: 'Back',
  shoulders: 'Shoulders',
  biceps: 'Biceps',
  triceps: 'Triceps',
  forearms: 'Forearms',
  quads: 'Quads',
  hamstrings: 'Hamstrings',
  glutes: 'Glutes',
  calves: 'Calves',
  abs: 'Abs',
  traps: 'Traps',
}

export function normalizeSecondaryMuscles(
  primary: MuscleGroup,
  secondary: MuscleGroup[],
): MuscleGroup[] {
  return Array.from(new Set(secondary)).filter((muscle) => muscle !== primary)
}
