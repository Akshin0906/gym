import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'

export function RouteLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="min-h-48 grid place-items-center px-6 text-[var(--color-fg-dim)]"
    >
      <span className="inline-flex items-center gap-2 text-sm">
        <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />
        Loading page…
      </span>
    </div>
  )
}

interface RouteErrorBoundaryState {
  error: Error | null
}

/** Route-level render failure UI; wire around the routed content in App.tsx. */
export class RouteErrorBoundary extends Component<
  { children: ReactNode },
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Route render failed', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <section
        role="alert"
        className="mx-auto max-w-md px-4 py-12 text-center"
      >
        <AlertTriangle
          size={28}
          className="mx-auto text-red-300"
          aria-hidden="true"
        />
        <h1 className="mt-3 text-xl font-bold">This page could not load</h1>
        <p className="mt-2 text-sm text-[var(--color-fg-dim)]">
          Your saved workout data is still on this device. Reload the page to
          try again.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="btn-primary mt-5"
        >
          Reload app
        </button>
      </section>
    )
  }
}
