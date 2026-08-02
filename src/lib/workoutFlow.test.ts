import { describe, expect, it } from 'vitest'
import { shouldCompleteExerciseAfterRest } from './workoutFlow'

describe('final-set rest flow', () => {
  it('completes only after the committed set count reaches the target', () => {
    expect(shouldCompleteExerciseAfterRest(3, 2)).toBe(false)
    expect(shouldCompleteExerciseAfterRest(3, 3)).toBe(true)
    expect(shouldCompleteExerciseAfterRest(3, 4)).toBe(true)
    expect(shouldCompleteExerciseAfterRest(0, 4)).toBe(false)
  })
})
