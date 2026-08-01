import { useEffect, useRef, useState } from 'react'

interface Props {
  value: number
  duration?: number
  format?: (n: number) => string
  className?: string
}

export function CountUp({
  value,
  duration = 450,
  format = (n) => n.toString(),
  className,
}: Props) {
  const [display, setDisplay] = useState(value)
  const prevRef = useRef(value)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    const from = prevRef.current
    const to = value
    if (from === to) return

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    startRef.current = null

    const tick = (t: number) => {
      if (startRef.current === null) startRef.current = t
      const elapsed = t - startRef.current
      const p = Math.min(1, elapsed / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      const v = from + (to - from) * eased
      setDisplay(Math.round(v))
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        prevRef.current = to
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [value, duration])

  return <span className={className}>{format(display)}</span>
}
