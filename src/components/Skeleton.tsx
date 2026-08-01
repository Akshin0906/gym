import { type CSSProperties } from 'react'

export function Skeleton({
  className = '',
  style,
}: {
  className?: string
  style?: CSSProperties
}) {
  return (
    <span
      aria-hidden
      className={`block rounded-md skeleton-shimmer ${className}`}
      style={style}
    />
  )
}

export function ExerciseRowSkeleton() {
  return (
    <li className="px-3 py-3 border-b border-[var(--color-border)] last:border-b-0">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-3 w-1/3 mt-2" />
    </li>
  )
}

export function ExerciseListSkeleton() {
  return (
    <div className="px-4 py-3 space-y-5">
      {Array.from({ length: 3 }).map((_, gi) => (
        <section key={gi}>
          <Skeleton className="h-3 w-20 mb-2" />
          <ul className="card overflow-hidden">
            {Array.from({ length: 4 }).map((_, ri) => (
              <ExerciseRowSkeleton key={ri} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

export function SessionRowSkeleton() {
  return (
    <li className="card-tight px-3 py-3">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-3 w-2/3 mt-2" />
    </li>
  )
}

export function HistoryListSkeleton() {
  return (
    <ul className="px-4 py-4 space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <SessionRowSkeleton key={i} />
      ))}
    </ul>
  )
}

export function TodaySkeleton() {
  return (
    <div className="px-4 py-5 space-y-5 max-w-md mx-auto">
      <Skeleton className="h-40 rounded-2xl" />
      <Skeleton className="h-32 rounded-2xl" />
    </div>
  )
}

export function StatsCardSkeleton() {
  return (
    <div className="card p-3 space-y-2">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-6 w-20" />
    </div>
  )
}
