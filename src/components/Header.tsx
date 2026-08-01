import { type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronLeft, MessageCircle, Settings } from 'lucide-react'

interface HeaderProps {
  title: string
  subtitle?: string
  back?: string | boolean
  right?: ReactNode
}

export function Header({ title, subtitle, back, right }: HeaderProps) {
  const navigate = useNavigate()
  const showBack = back !== undefined && back !== false
  return (
    <header
      className="sticky top-0 z-30 flex items-center gap-2 px-3 py-3 backdrop-blur"
      style={{
        background: 'oklch(0.16 0 0 / 0.85)',
        borderBottom: '1px solid var(--color-border)',
        paddingTop: 'max(0.75rem, env(safe-area-inset-top, 0px))',
      }}
    >
      {showBack && (
        <button
          type="button"
          aria-label="Back"
          onClick={() =>
            typeof back === 'string' ? navigate(back) : navigate(-1)
          }
          className="-ml-1 p-1 text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
        >
          <ChevronLeft size={24} strokeWidth={2} />
        </button>
      )}
      <div className="flex-1 min-w-0">
        <h1 className="text-lg font-semibold leading-tight truncate">
          {title}
        </h1>
        {subtitle && (
          <p className="text-xs text-[var(--color-fg-dim)] truncate mt-0.5">
            {subtitle}
          </p>
        )}
      </div>
      {right}
    </header>
  )
}

export function SettingsLink() {
  return (
    <Link
      to="/settings"
      aria-label="Settings"
      className="p-2 text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
    >
      <Settings size={20} strokeWidth={1.75} />
    </Link>
  )
}

export function CoachLink({
  sessionId,
  className = '',
}: {
  sessionId?: string
  className?: string
}) {
  const search = sessionId
    ? `?sessionId=${encodeURIComponent(sessionId)}&returnTo=${encodeURIComponent('/workout')}`
    : ''
  return (
    <Link
      to={`/coach${search}`}
      aria-label="Open Coach"
      className={`p-2 text-[var(--color-fg-dim)] hover:text-[var(--color-fg)] ${className}`}
    >
      <MessageCircle size={20} strokeWidth={1.75} />
    </Link>
  )
}
