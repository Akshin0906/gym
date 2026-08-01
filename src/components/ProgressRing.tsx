interface Props {
  value: number
  max: number
  size?: number
  stroke?: number
  className?: string
}

export function ProgressRing({
  value,
  max,
  size = 28,
  stroke = 3,
  className = '',
}: Props) {
  const safeMax = Math.max(1, max)
  const pct = Math.min(1, Math.max(0, value / safeMax))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const dash = c * pct
  const done = pct >= 1
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      aria-label={`${value} of ${max}`}
      role="img"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--color-border)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray 280ms ease' }}
      />
      {done && (
        <path
          d={`M ${size * 0.32} ${size * 0.52} L ${size * 0.46} ${
            size * 0.66
          } L ${size * 0.7} ${size * 0.4}`}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}
