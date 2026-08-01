import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns'

export function shortDate(epochMs: number): string {
  return format(epochMs, 'MMM d, yyyy')
}

export function shortTime(epochMs: number): string {
  return format(epochMs, 'h:mm a')
}

export function relativeOrAbsolute(epochMs: number): string {
  if (isToday(epochMs)) return `Today, ${shortTime(epochMs)}`
  if (isYesterday(epochMs)) return `Yesterday, ${shortTime(epochMs)}`
  const days = (Date.now() - epochMs) / 86_400_000
  if (days < 7) return formatDistanceToNow(epochMs, { addSuffix: true })
  return shortDate(epochMs)
}
