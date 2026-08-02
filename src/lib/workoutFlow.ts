export function shouldCompleteExerciseAfterRest(
  targetSets: number,
  committedSetCount: number,
): boolean {
  return targetSets > 0 && committedSetCount >= targetSets
}
