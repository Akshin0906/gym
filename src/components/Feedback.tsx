import { useEffect } from 'react'
import { AlertCircle, CheckCircle2, X } from 'lucide-react'

export interface ToastNotice {
  id: number
  message: string
}

export function ErrorAlert({ message }: { message: string }) {
  return (
    <div
      className="rounded-lg flex gap-2 px-3 py-2 text-sm"
      style={{
        background: 'oklch(0.25 0.06 25 / 0.4)',
        border: '1px solid oklch(0.4 0.1 25 / 0.5)',
        color: 'oklch(0.8 0.12 25)',
      }}
    >
      <AlertCircle size={16} className="shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  )
}

export function Toast({
  notice,
  onDismiss,
  action,
  durationMs = 2600,
}: {
  notice: ToastNotice | null
  onDismiss: () => void
  action?: { label: string; onClick: () => void }
  durationMs?: number
}) {
  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(onDismiss, durationMs)
    return () => window.clearTimeout(timeout)
  }, [notice, onDismiss, durationMs])

  if (!notice) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 z-50 mx-auto max-w-md"
      style={{ bottom: 'calc(var(--tab-bar-height) + 0.75rem)' }}
    >
      <div
        className="rounded-xl px-3 py-2.5 flex items-center gap-2 text-sm shadow-lg"
        style={{
          background: 'oklch(0.22 0 0 / 0.96)',
          border: '1px solid var(--color-border)',
          color: 'var(--color-fg)',
        }}
      >
        <CheckCircle2
          size={16}
          className="shrink-0"
          style={{ color: 'var(--color-accent)' }}
        />
        <span className="flex-1 min-w-0">{notice.message}</span>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="shrink-0 px-2 py-1 -my-1 rounded-md font-semibold text-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"
          >
            {action.label}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="p-1 -mr-1 rounded-md text-[var(--color-fg-faint)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-2)]"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
