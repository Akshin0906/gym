// Case- and whitespace-folded exercise name used as the uniqueness key.
//
// Kept deliberately conservative: it must stay stable forever because it is a
// persisted IndexedDB index. Folding is limited to Unicode case folding,
// canonical composition, and whitespace collapsing — it never strips
// punctuation, so "Row (Left)" and "Row Left" remain different exercises.
export function normalizedExerciseName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}
