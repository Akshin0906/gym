import { db } from './schema'
import { normalizedExerciseName } from '../lib/exerciseName'
import type { Exercise } from './types'

// Secondary muscles list the muscles a lift meaningfully trains beyond its
// primary mover. Involvement alone does not qualify.
//
// Three entries below are corrected because direct longitudinal measurement
// found little or no hamstring growth from them. Walking Lunge and Sumo
// Deadlift keep their hamstring entry as an unverified editorial default,
// retained conservatively rather than changed on an argument from silence: no
// study read here measured them either way, and absence of contradiction is not
// evidence for the mapping. See automation/evidence_guide.md.
export const SEED_EXERCISES: Omit<Exercise, 'id' | 'createdAt'>[] = [
  // ----- Chest -----
  { name: 'Barbell Bench Press', primaryMuscle: 'chest', secondaryMuscles: ['triceps', 'shoulders'], notes: '', defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  { name: 'Incline Barbell Bench Press', primaryMuscle: 'chest', secondaryMuscles: ['shoulders', 'triceps'], notes: '', defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  { name: 'Dumbbell Bench Press', primaryMuscle: 'chest', secondaryMuscles: ['triceps', 'shoulders'], notes: '', defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: 'Incline Dumbbell Press', primaryMuscle: 'chest', secondaryMuscles: ['shoulders', 'triceps'], notes: '', defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: 'Decline Dumbbell Press', primaryMuscle: 'chest', secondaryMuscles: ['triceps'], notes: '', defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: 'Machine Chest Press', primaryMuscle: 'chest', secondaryMuscles: ['triceps'], notes: '', defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: 'Cable Fly', primaryMuscle: 'chest', secondaryMuscles: [], notes: '', defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: 'Pec Deck', primaryMuscle: 'chest', secondaryMuscles: [], notes: '', defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },

  // ----- Back -----
  { name: 'Lat Pulldown', primaryMuscle: 'back', secondaryMuscles: ['biceps'], notes: '', defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: 'Neutral-Grip Lat Pulldown', primaryMuscle: 'back', secondaryMuscles: ['biceps'], notes: '', defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: 'Barbell Row', primaryMuscle: 'back', secondaryMuscles: ['biceps'], notes: '', defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: 'Pendlay Row', primaryMuscle: 'back', secondaryMuscles: ['biceps'], notes: '', defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: 'T-Bar Row', primaryMuscle: 'back', secondaryMuscles: ['biceps'], notes: '', defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: 'Seated Cable Row', primaryMuscle: 'back', secondaryMuscles: ['biceps'], notes: '', defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: 'Single-Arm Dumbbell Row', primaryMuscle: 'back', secondaryMuscles: ['biceps'], notes: '', defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: 'Chest-Supported Row (Machine)', primaryMuscle: 'back', secondaryMuscles: ['biceps'], notes: '', defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: 'Straight-Arm Pulldown', primaryMuscle: 'back', secondaryMuscles: [], notes: '', defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },

  // ----- Shoulders -----
  { name: 'Overhead Press (Barbell)', primaryMuscle: 'shoulders', secondaryMuscles: ['triceps'], notes: '', defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  { name: 'Seated Dumbbell Press', primaryMuscle: 'shoulders', secondaryMuscles: ['triceps'], notes: '', defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: 'Arnold Press', primaryMuscle: 'shoulders', secondaryMuscles: ['triceps'], notes: '', defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: 'Machine Shoulder Press', primaryMuscle: 'shoulders', secondaryMuscles: ['triceps'], notes: '', defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: 'Dumbbell Lateral Raise', primaryMuscle: 'shoulders', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: 'Cable Lateral Raise', primaryMuscle: 'shoulders', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: 'Machine Lateral Raise', primaryMuscle: 'shoulders', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: 'Reverse Pec Deck', primaryMuscle: 'shoulders', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: 'Dumbbell Rear Delt Fly', primaryMuscle: 'shoulders', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: 'Cable Face Pull', primaryMuscle: 'shoulders', secondaryMuscles: ['traps'], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: 'Front Raise (Dumbbell)', primaryMuscle: 'shoulders', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },

  // ----- Biceps -----
  { name: 'Barbell Curl', primaryMuscle: 'biceps', secondaryMuscles: [], notes: '', defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: 'Dumbbell Curl', primaryMuscle: 'biceps', secondaryMuscles: [], notes: '', defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: 'Hammer Curl', primaryMuscle: 'biceps', secondaryMuscles: ['forearms'], notes: '', defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: 'Preacher Curl', primaryMuscle: 'biceps', secondaryMuscles: [], notes: '', defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: 'Cable Curl', primaryMuscle: 'biceps', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: 'Incline Dumbbell Curl', primaryMuscle: 'biceps', secondaryMuscles: [], notes: '', defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: 'Concentration Curl', primaryMuscle: 'biceps', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },

  // ----- Triceps -----
  { name: 'Cable Tricep Pushdown', primaryMuscle: 'triceps', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: 'Rope Pushdown', primaryMuscle: 'triceps', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: 'Overhead Tricep Extension (Dumbbell)', primaryMuscle: 'triceps', secondaryMuscles: [], notes: '', defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: 'Overhead Tricep Extension (Rope)', primaryMuscle: 'triceps', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: 'Skull Crusher', primaryMuscle: 'triceps', secondaryMuscles: [], notes: '', defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: 'Close-Grip Bench Press', primaryMuscle: 'triceps', secondaryMuscles: ['chest'], notes: '', defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: 'Single-Arm Reverse Pushdown', primaryMuscle: 'triceps', secondaryMuscles: [], notes: '', defaultRestSeconds: 60, isCustom: false, hiddenFromLibrary: false },

  // ----- Forearms -----
  { name: 'Wrist Curl (Barbell)', primaryMuscle: 'forearms', secondaryMuscles: [], notes: '', defaultRestSeconds: 60, isCustom: false, hiddenFromLibrary: false },
  { name: 'Reverse Wrist Curl (Barbell)', primaryMuscle: 'forearms', secondaryMuscles: [], notes: '', defaultRestSeconds: 60, isCustom: false, hiddenFromLibrary: false },

  // ----- Quads -----
  // Hamstring credit removed: longitudinal squat studies measuring muscle size
  // report quadriceps, gluteal and adductor growth without hamstring
  // hypertrophy (Kubo 2019 PMID 31230110; Plotkin 2023 PMID 37877099).
  // Involvement is not the same as a meaningful growth stimulus.
  { name: 'Barbell Back Squat', primaryMuscle: 'quads', secondaryMuscles: ['glutes'], notes: '', defaultRestSeconds: 210, isCustom: false, hiddenFromLibrary: false },
  { name: 'Front Squat', primaryMuscle: 'quads', secondaryMuscles: ['glutes'], notes: '', defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  // Hamstring credit removed: a leg-press trial assessing all seventeen
  // lower-limb muscles reports quadriceps, gluteal and adductor growth
  // (Kinoshita 2026 PMID 41630124). Only that reported result is relied on
  // here; the trial's full per-muscle findings were not read.
  { name: 'Leg Press', primaryMuscle: 'quads', secondaryMuscles: ['glutes'], notes: '', defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  { name: 'Hack Squat (Machine)', primaryMuscle: 'quads', secondaryMuscles: ['glutes'], notes: '', defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  { name: 'Bulgarian Split Squat', primaryMuscle: 'quads', secondaryMuscles: ['glutes'], notes: '', defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: 'Walking Lunge', primaryMuscle: 'quads', secondaryMuscles: ['glutes', 'hamstrings'], notes: '', defaultRestSeconds: 120, isCustom: false, hiddenFromLibrary: false },
  { name: 'Leg Extension', primaryMuscle: 'quads', secondaryMuscles: [], notes: '', defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },

  // ----- Hamstrings -----
  { name: 'Romanian Deadlift', primaryMuscle: 'hamstrings', secondaryMuscles: ['glutes', 'back'], notes: '', defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  { name: 'Stiff-Leg Deadlift', primaryMuscle: 'hamstrings', secondaryMuscles: ['glutes', 'back'], notes: '', defaultRestSeconds: 180, isCustom: false, hiddenFromLibrary: false },
  { name: 'Seated Leg Curl', primaryMuscle: 'hamstrings', secondaryMuscles: [], notes: '', defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: 'Lying Leg Curl', primaryMuscle: 'hamstrings', secondaryMuscles: [], notes: '', defaultRestSeconds: 90, isCustom: false, hiddenFromLibrary: false },
  { name: 'Good Morning', primaryMuscle: 'hamstrings', secondaryMuscles: ['glutes', 'back'], notes: '', defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },

  // ----- Glutes -----
  // Hamstring credit removed: the same 9-week trial found little or no
  // hamstring growth from hip thrusts as well as squats (Plotkin 2023).
  { name: 'Hip Thrust (Barbell)', primaryMuscle: 'glutes', secondaryMuscles: [], notes: '', defaultRestSeconds: 150, isCustom: false, hiddenFromLibrary: false },
  { name: 'Cable Glute Kickback', primaryMuscle: 'glutes', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: 'Sumo Deadlift', primaryMuscle: 'glutes', secondaryMuscles: ['hamstrings', 'back'], notes: '', defaultRestSeconds: 210, isCustom: false, hiddenFromLibrary: false },

  // ----- Calves -----
  { name: 'Standing Calf Raise', primaryMuscle: 'calves', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: 'Seated Calf Raise', primaryMuscle: 'calves', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: 'Leg Press Calf Raise', primaryMuscle: 'calves', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },

  // ----- Abs -----
  { name: 'Cable Crunch', primaryMuscle: 'abs', secondaryMuscles: [], notes: '', defaultRestSeconds: 60, isCustom: false, hiddenFromLibrary: false },
  { name: 'Weighted Decline Sit-Up', primaryMuscle: 'abs', secondaryMuscles: [], notes: '', defaultRestSeconds: 60, isCustom: false, hiddenFromLibrary: false },
  { name: 'Machine Crunch', primaryMuscle: 'abs', secondaryMuscles: [], notes: '', defaultRestSeconds: 60, isCustom: false, hiddenFromLibrary: false },

  // ----- Traps -----
  { name: 'Barbell Shrug', primaryMuscle: 'traps', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
  { name: 'Dumbbell Shrug', primaryMuscle: 'traps', secondaryMuscles: [], notes: '', defaultRestSeconds: 75, isCustom: false, hiddenFromLibrary: false },
]

export async function seedIfEmpty(): Promise<void> {
  await db.transaction('rw', db.exercises, async () => {
    const count = await db.exercises.count()
    if (count > 0) return
    const now = Date.now()
    await db.exercises.bulkAdd(
      SEED_EXERCISES.map((e) => ({
        ...e,
        id: crypto.randomUUID(),
        createdAt: now,
        normalizedName: normalizedExerciseName(e.name),
      })),
    )
  })
}
