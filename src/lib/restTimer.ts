export const MIN_REST_SECONDS = 1
export const MAX_REST_SECONDS = 3_600

export function isValidRestSeconds(seconds: number): boolean {
  return (
    Number.isInteger(seconds) &&
    seconds >= MIN_REST_SECONDS &&
    seconds <= MAX_REST_SECONDS
  )
}
