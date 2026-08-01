import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, Square, Timer as TimerIcon, X } from 'lucide-react'
import { useTimer } from '../store/timer'
import { vibrate } from '../lib/audio'

const SLIDER_MIN = 60
const SLIDER_MAX = 180
const SLIDER_STEP = 30

function snapToStep(seconds: number): number {
  const clamped = Math.max(SLIDER_MIN, Math.min(SLIDER_MAX, seconds))
  const steps = Math.round((clamped - SLIDER_MIN) / SLIDER_STEP)
  return SLIDER_MIN + steps * SLIDER_STEP
}

export function RestTimerBar({
  tabBarHidden = false,
  coachMode = false,
}: {
  tabBarHidden?: boolean
  coachMode?: boolean
}) {
  const expiresAt = useTimer((s) => s.expiresAt)
  const originalSeconds = useTimer((s) => s.originalSeconds)
  const stop = useTimer((s) => s.stop)
  const fireExpiry = useTimer((s) => s.fireExpiry)
  const [now, setNow] = useState(Date.now)
  const [flashing, setFlashing] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const [coachComposerHeight, setCoachComposerHeight] = useState(0)
  const flashTimeoutRef = useRef<number | undefined>(undefined)
  const wasRunningRef = useRef(false)

  useLayoutEffect(() => {
    if (!coachMode) {
      setCoachComposerHeight(0)
      return
    }
    const composer = document.getElementById('coach-composer')
    if (!composer) return
    const update = () => setCoachComposerHeight(composer.getBoundingClientRect().height)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(composer)
    return () => observer.disconnect()
  }, [coachMode])

  useEffect(() => {
    if (expiresAt === null) return
    setFlashing(false)
    setNow(Date.now())
    let fired = false
    const intervalId = window.setInterval(() => {
      const cur = Date.now()
      setNow(cur)
      if (!fired && cur >= expiresAt) {
        fired = true
        fireExpiry()
        setFlashing(true)
        flashTimeoutRef.current = window.setTimeout(() => {
          setFlashing(false)
          flashTimeoutRef.current = undefined
        }, 1500)
      }
    }, 200)
    return () => {
      window.clearInterval(intervalId)
      if (flashTimeoutRef.current !== undefined) {
        window.clearTimeout(flashTimeoutRef.current)
        flashTimeoutRef.current = undefined
      }
    }
  }, [expiresAt, fireExpiry])

  // Auto-expand on each NEW timer start (transition from idle → running).
  // Slider edits keep `expiresAt` non-null, so they don't trigger this.
  useEffect(() => {
    const isRunning = expiresAt !== null
    if (isRunning && !wasRunningRef.current) setExpanded(true)
    wasRunningRef.current = isRunning
  }, [expiresAt])

  function dismissFlash() {
    if (flashTimeoutRef.current !== undefined) {
      window.clearTimeout(flashTimeoutRef.current)
      flashTimeoutRef.current = undefined
    }
    setFlashing(false)
  }

  function handleSliderChange(seconds: number) {
    if (seconds === originalSeconds) return
    vibrate(15)
    useTimer.setState({
      expiresAt: Date.now() + seconds * 1000,
      originalSeconds: seconds,
    })
  }

  if (expiresAt === null && !flashing) return null

  const remainingMs = expiresAt === null ? 0 : Math.max(0, expiresAt - now)
  const remainingSec = Math.ceil(remainingMs / 1000)
  const pct =
    originalSeconds > 0
      ? Math.min(100, (remainingMs / (originalSeconds * 1000)) * 100)
      : 0

  const sliderValue = snapToStep(originalSeconds || 90)
  const showModal = expanded && expiresAt !== null && !flashing

  if (showModal) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
        <div
          className="absolute inset-0"
          style={{
            background: 'oklch(0.1 0 0 / 0.7)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
          onClick={() => setExpanded(false)}
          aria-hidden
        />
        <div
          className="relative w-full max-w-sm rounded-3xl p-6"
          style={{
            background: 'oklch(0.205 0 0)',
            border: '1px solid var(--color-border)',
            boxShadow: '0 12px 40px oklch(0 0 0 / 0.6)',
          }}
        >
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-label="Minimize"
              className="p-2 -m-2 text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
            >
              <ChevronDown size={22} strokeWidth={2.25} />
            </button>
            <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)]">
              Rest
            </span>
            <button
              type="button"
              onClick={stop}
              aria-label="Stop timer"
              className="p-2 -m-2 text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
            >
              <Square size={16} fill="currentColor" />
            </button>
          </div>
          <div className="text-center pt-6 pb-2">
            <span className="text-7xl font-bold nums tabular-nums leading-none">
              {remainingSec}
              <span className="text-2xl font-medium text-[var(--color-fg-faint)] ml-1.5 align-top">
                s
              </span>
            </span>
          </div>
          <div
            className="h-1.5 rounded mt-6 overflow-hidden"
            style={{ background: 'oklch(0 0 0 / 0.4)' }}
          >
            <div
              className="h-full"
              style={{
                width: `${pct}%`,
                background: 'var(--color-accent)',
                transition: 'width 200ms linear',
              }}
            />
          </div>
          <div className="mt-6 flex items-center gap-3">
            <input
              type="range"
              min={SLIDER_MIN}
              max={SLIDER_MAX}
              step={SLIDER_STEP}
              value={sliderValue}
              onChange={(e) => handleSliderChange(Number(e.target.value))}
              aria-label="Set rest timer duration"
              className="flex-1 h-1.5 accent-[var(--color-accent)] cursor-pointer"
            />
            <span className="text-sm font-mono nums text-[var(--color-fg-dim)] w-10 text-right">
              {sliderValue}s
            </span>
          </div>
        </div>
      </div>
    )
  }

  // Minimized bar (also used for the flash-on-expiry state).
  const barTappable = flashing || expiresAt !== null
  const activateBar = () => {
    if (flashing) dismissFlash()
    else if (expiresAt !== null) setExpanded(true)
  }
  const barLabel = flashing
    ? 'Dismiss rest complete'
    : expiresAt !== null
      ? 'Expand rest timer'
      : undefined

  return (
    <div
      className={`fixed inset-x-0 z-40 px-3 ${flashing ? 'animate-pulse' : ''}`}
      style={{
        // Coach keeps the timer immediately above its measured composer,
        // including the conditional suggestion row and safe-area padding.
        bottom: coachMode
          ? `${coachComposerHeight}px`
          : tabBarHidden
            ? 'var(--app-safe-area-bottom)'
            : 'var(--tab-bar-height)',
      }}
    >
      <div
        className="mx-auto max-w-md rounded-t-xl px-3 py-2.5"
        style={{
          background: flashing ? 'oklch(0.74 0.18 50)' : 'oklch(0.205 0 0)',
          color: flashing ? 'oklch(0.18 0.04 50)' : 'var(--color-fg)',
          border: flashing
            ? '1px solid oklch(0.66 0.21 45)'
            : '1px solid var(--color-border)',
          borderBottom: 'none',
        }}
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={activateBar}
            disabled={!barTappable}
            aria-label={barLabel}
            className="min-w-0 flex-1 flex items-center gap-3 text-left disabled:cursor-default"
          >
            <TimerIcon
              size={18}
              className={`shrink-0 ${flashing ? 'animate-bounce' : ''}`}
              strokeWidth={2.25}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[10px] font-bold uppercase tracking-widest opacity-80">
                  {flashing
                    ? 'Rest complete · tap to dismiss'
                    : 'Rest · tap to expand'}
                </span>
                <span className="shrink-0 font-mono nums text-base font-bold">
                  {flashing ? '0s' : `${remainingSec}s`}
                </span>
              </div>
              <div
                className="h-1 rounded mt-1 overflow-hidden"
                style={{
                  background: flashing
                    ? 'oklch(0.18 0.04 50 / 0.25)'
                    : 'oklch(0 0 0 / 0.4)',
                }}
              >
                <div
                  className="h-full"
                  style={{
                    width: `${pct}%`,
                    background: flashing
                      ? 'oklch(0.18 0.04 50)'
                      : 'var(--color-accent)',
                    transition: 'width 200ms linear',
                  }}
                />
              </div>
            </div>
          </button>
          {flashing ? (
            <button
              type="button"
              onClick={dismissFlash}
              aria-label="Dismiss"
              className="shrink-0 p-1.5"
              style={{ color: 'oklch(0.18 0.04 50)' }}
            >
              <X size={16} strokeWidth={2.5} />
            </button>
          ) : (
            <button
              type="button"
              onClick={stop}
              aria-label="Stop timer"
              className="shrink-0 p-1.5 text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
            >
              <Square size={14} fill="currentColor" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
