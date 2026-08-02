import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react'
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
import { installAppViewportSizing } from '../lib/visualViewport'
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

function routeTitle(pathname: string): string {
  if (pathname === '/') return 'Today'
  if (pathname === '/library/new') return 'New exercise'
  if (pathname.startsWith('/library/') && pathname.endsWith('/history')) {
    return 'Exercise history'
  }
  if (pathname.startsWith('/library/')) return 'Edit exercise'
  if (pathname === '/library') return 'Exercise library'
  if (pathname.startsWith('/programs/')) return 'Edit program'
  if (pathname === '/programs') return 'Programs'
  if (pathname.startsWith('/history/')) return 'Workout details'
  if (pathname === '/history') return 'Workout history'
  if (pathname === '/stats') return 'Stats'
  if (pathname === '/settings/ai-memory') return 'AI Memory'
  if (pathname === '/settings') return 'Settings'
  if (pathname === '/coach') return 'Coach'
  if (pathname === '/workout') return 'Workout in progress'
  if (pathname.startsWith('/preview/')) return 'Workout preview'
  return 'Page not found'
}

export function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const hideTabs = HIDE_TAB_BAR_PREFIXES.some((p) => pathname.startsWith(p))
  const isCoach = pathname.startsWith('/coach')
  const idx = useMemo(() => activeTabIndex(pathname), [pathname])
  const mainRef = useRef<HTMLElement>(null)
  const title = useMemo(() => routeTitle(pathname), [pathname])

  useEffect(() => {
    // Persistent (not once) so the AudioContext is re-resumed on every tap.
    // iOS suspends it on background; a one-shot prime would go silent after that.
    const handler = () => primeAudio()
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [])

  useLayoutEffect(() => installAppViewportSizing(), [])

  useEffect(() => {
    document.title = `${title} · Workout Tracker`
    const frame = window.requestAnimationFrame(() => mainRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [pathname, title])

  return (
    <div
      data-app-shell
      className="absolute inset-x-0 top-0 flex flex-col overflow-hidden"
      style={{
        height: 'var(--app-viewport-height)',
        transform: 'translate3d(0, var(--app-viewport-top), 0)',
      }}
    >
      <a
        href="#main-content"
        className="absolute left-3 top-3 z-[100] -translate-y-24 rounded-lg bg-[var(--color-accent)] px-3 py-2 font-semibold text-black transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>
      <main
        ref={mainRef}
        id="main-content"
        tabIndex={-1}
        aria-label={title}
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
          className="relative flex items-stretch z-40 backdrop-blur shrink-0 w-full max-w-3xl mx-auto"
          style={{
            height: 'var(--tab-bar-height)',
            paddingBottom: 'calc(var(--app-safe-area-bottom) / 2)',
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
