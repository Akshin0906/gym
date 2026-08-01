import { type ReactNode, useEffect, useMemo } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  BarChart3,
  CalendarDays,
  ClipboardList,
  Dumbbell,
  Home,
  type LucideIcon,
} from 'lucide-react'
import { primeAudio } from '../lib/audio'
import { RestTimerBar } from './RestTimerBar'

const TABS: { to: string; label: string; icon: LucideIcon; exact?: boolean }[] = [
  { to: '/', label: 'Today', icon: Home, exact: true },
  { to: '/library', label: 'Library', icon: Dumbbell },
  { to: '/programs', label: 'Programs', icon: ClipboardList },
  { to: '/history', label: 'History', icon: CalendarDays },
  { to: '/stats', label: 'Stats', icon: BarChart3 },
]

const HIDE_TAB_BAR_PREFIXES = ['/workout', '/coach']

function activeTabIndex(pathname: string): number {
  if (pathname.startsWith('/library')) return 1
  if (pathname.startsWith('/programs')) return 2
  if (pathname.startsWith('/history')) return 3
  if (pathname.startsWith('/stats')) return 4
  if (pathname === '/' || pathname === '') return 0
  return -1
}

export function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const hideTabs = HIDE_TAB_BAR_PREFIXES.some((p) => pathname.startsWith(p))
  const isCoach = pathname.startsWith('/coach')
  const idx = useMemo(() => activeTabIndex(pathname), [pathname])

  useEffect(() => {
    // Persistent (not once) so the AudioContext is re-resumed on every tap.
    // iOS suspends it on background; a one-shot prime would go silent after that.
    const handler = () => primeAudio()
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [])

  return (
    <div className="h-dvh flex flex-col">
      <main
        className={`flex-1 min-h-0 ${
          isCoach
            ? 'overflow-hidden'
            : 'overflow-y-auto overscroll-y-contain'
        }`}
      >
        {children}
      </main>
      <RestTimerBar tabBarHidden={hideTabs} coachMode={isCoach} />
      {!hideTabs && (
        <nav
          aria-label="Primary"
          className="relative flex items-stretch z-40 backdrop-blur shrink-0"
          style={{
            height: 'var(--tab-bar-height)',
            paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) / 2)',
            background: 'oklch(0.16 0 0 / 0.92)',
            borderTop: '1px solid var(--color-border)',
          }}
        >
          {idx >= 0 && (
            <span
              className="tab-indicator"
              style={{
                width: `${100 / TABS.length}%`,
                transform: `translateX(${idx * 100}%)`,
              }}
            />
          )}
          {TABS.map((tab) => {
            const Icon = tab.icon
            return (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.exact}
                className={({ isActive }) =>
                  `flex-1 flex flex-col items-center justify-center gap-1 transition-colors ${
                    isActive
                      ? 'text-[var(--color-accent)]'
                      : 'text-[var(--color-fg-faint)] hover:text-[var(--color-fg-dim)]'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon
                      size={22}
                      strokeWidth={isActive ? 2.25 : 1.75}
                      aria-hidden
                    />
                    <span className="text-[11px] font-medium">{tab.label}</span>
                  </>
                )}
              </NavLink>
            )
          })}
        </nav>
      )}
    </div>
  )
}
