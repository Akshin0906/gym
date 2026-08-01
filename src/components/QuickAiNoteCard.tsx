import { useCallback, useEffect, useState } from 'react'
import { Brain, Plus, Save, X } from 'lucide-react'
import { addAiNote, ensureAiMemorySettings } from '../db/repositories/aiMemory'
import { ErrorAlert, Toast, type ToastNotice } from './Feedback'

export function QuickAiNoteCard() {
  const [available, setAvailable] = useState(false)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<ToastNotice | null>(null)
  const [error, setError] = useState<string | null>(null)

  const showToast = useCallback((message: string) => {
    setToast((prev) => ({ id: (prev?.id ?? 0) + 1, message }))
  }, [])
  const dismissToast = useCallback(() => setToast(null), [])

  useEffect(() => {
    let cancelled = false
    void ensureAiMemorySettings().then((settings) => {
      if (!cancelled) setAvailable(!settings.paused)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function save() {
    if (busy || !draft.trim()) return
    setBusy(true)
    setError(null)
    try {
      await addAiNote(draft)
      setDraft('')
      setOpen(false)
      showToast('Note added.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function close() {
    setDraft('')
    setError(null)
    setOpen(false)
  }

  if (!available) return null

  return (
    <>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="card-tight w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-[var(--color-surface-2)] transition-colors"
        >
          <Brain size={17} className="shrink-0 text-[var(--color-accent)]" />
          <span className="font-semibold flex-1">Add AI note</span>
          <Plus size={17} className="shrink-0 text-[var(--color-fg-faint)]" />
        </button>
      ) : (
        <section className="card p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Brain
                size={16}
                className="shrink-0 text-[var(--color-accent)]"
              />
              <h2 className="font-semibold text-sm leading-tight">AI note</h2>
            </div>
            <button
              type="button"
              onClick={close}
              disabled={busy}
              className="p-1.5 rounded-md text-[var(--color-fg-faint)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-2)]"
              aria-label="Close AI note"
            >
              <X size={14} />
            </button>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="field min-h-20 resize-y text-sm leading-relaxed"
            placeholder="Add context for this training period."
            autoFocus
          />
          {error && <ErrorAlert message={error} />}
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !draft.trim()}
            className="btn-primary w-full py-2.5 text-sm"
          >
            <Save size={15} /> Save note
          </button>
        </section>
      )}
      <Toast notice={toast} onDismiss={dismissToast} />
    </>
  )
}
