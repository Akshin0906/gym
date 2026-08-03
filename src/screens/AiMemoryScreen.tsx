import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Brain,
  CalendarDays,
  ChevronDown,
  PauseCircle,
  PlayCircle,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import { ErrorAlert, Toast, type ToastNotice } from '../components/Feedback'
import { Header } from '../components/Header'
import type { AiMemorySettings, AiMemorySummary, AiNote } from '../db/types'
import {
  deleteAiNote,
  ensureAiMemorySettings,
  listAiMemorySummariesDesc,
  listAiNotesDesc,
  nextFourMonthEnd,
  nextTwoWeekEnd,
  pauseAiMemory,
  resumeAiMemory,
  restoreAiNote,
  updateAiCurrentContext,
  updateAiMemorySummaryBullets,
  updateAiNote,
} from '../db/repositories/aiMemory'
import { useUnsavedChangesWarning } from '../lib/useUnsavedChangesWarning'

function formatDay(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatNoteTimestamp(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function periodLabel(startAt: number, exclusiveEndAt: number): string {
  return `${formatDay(startAt)} - ${formatDay(exclusiveEndAt - 1)}`
}

export function AiMemoryScreen() {
  const [settings, setSettings] = useState<AiMemorySettings | null>(null)
  const [notes, setNotes] = useState<AiNote[]>([])
  const [summaries, setSummaries] = useState<AiMemorySummary[]>([])
  const [contextDraft, setContextDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<ToastNotice | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [undoNote, setUndoNote] = useState<AiNote | null>(null)
  const [dirtyDrafts, setDirtyDrafts] = useState<Set<string>>(() => new Set())
  const contextInitializedRef = useRef(false)

  const reportDraftState = useCallback<DraftStateReporter>((key, dirty) => {
    setDirtyDrafts((current) => {
      if (current.has(key) === dirty) return current
      const next = new Set(current)
      if (dirty) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const contextDirty = Boolean(
    settings && contextDraft !== settings.currentContext,
  )
  useUnsavedChangesWarning(contextDirty || dirtyDrafts.size > 0)

  const showToast = useCallback((message: string) => {
    setUndoNote(null)
    setToast((prev) => ({ id: (prev?.id ?? 0) + 1, message }))
  }, [])
  const dismissToast = useCallback(() => setToast(null), [])

  const load = useCallback(async () => {
    const [s, ns, ss] = await Promise.all([
      ensureAiMemorySettings(),
      listAiNotesDesc(),
      listAiMemorySummariesDesc(),
    ])
    setSettings(s)
    if (!contextInitializedRef.current) {
      contextInitializedRef.current = true
      setContextDraft(s.currentContext)
    }
    setNotes(ns)
    setSummaries(ss)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (cancelled) return
      try {
        await load()
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  async function undoDelete() {
    if (!undoNote) return
    setError(null)
    try {
      await restoreAiNote(undoNote)
      await load()
      setUndoNote(null)
      showToast('Note restored.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function handleSaveContext() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await updateAiCurrentContext(contextDraft)
      await load()
      showToast('AI context saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleTogglePaused() {
    if (!settings || busy) return
    setBusy(true)
    setError(null)
    try {
      if (settings.paused) {
        await resumeAiMemory()
        showToast('AI memory resumed. Fresh windows start today.')
      } else {
        await pauseAiMemory()
        showToast('AI memory stopped.')
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Header title="AI Memory" back />
      <div className="px-4 py-5 space-y-6 max-w-md mx-auto">
        {error && <ErrorAlert message={error} />}
        {!settings ? (
          error ? (
            <button
              type="button"
              onClick={() => {
                setError(null)
                void load().catch((caught) =>
                  setError(
                    caught instanceof Error ? caught.message : String(caught),
                  ),
                )
              }}
              className="btn-secondary w-full"
            >
              Retry
            </button>
          ) : (
            <p
              role="status"
              className="text-sm text-[var(--color-fg-faint)] text-center"
            >
              Loading…
            </p>
          )
        ) : (
          <>
            <MemoryStatusCard
              settings={settings}
              busy={busy}
              onToggle={() => void handleTogglePaused()}
            />

            <section className="space-y-2">
              <label
                htmlFor="ai-global-context"
                className="block text-xs font-semibold text-[var(--color-fg-dim)] px-1"
              >
                Current global context
              </label>
              <textarea
                id="ai-global-context"
                value={contextDraft}
                onChange={(e) => setContextDraft(e.target.value)}
                className="field min-h-28 resize-y text-sm leading-relaxed"
                placeholder="Anything the AI should always know."
              />
              <button
                type="button"
                onClick={() => void handleSaveContext()}
                disabled={busy}
                className="btn-secondary w-full py-2.5 text-sm"
              >
                <Save size={16} /> Save context
              </button>
            </section>

            <section className="space-y-2">
              <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
                Notes
              </h2>
              {notes.length === 0 ? (
                <p className="text-sm text-[var(--color-fg-faint)] px-1">
                  No notes yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  {notes.map((note) => (
                    <EditableNoteRow
                      key={note.id}
                      note={note}
                      onSave={async (body) => {
                        await updateAiNote(note.id, body)
                        await load()
                        showToast('Note saved.')
                      }}
                      onDelete={async () => {
                        if (
                          !confirm(
                            'Delete this AI note? You can undo for a few seconds.',
                          )
                        ) {
                          return false
                        }
                        await deleteAiNote(note.id)
                        await load()
                        setUndoNote(note)
                        setToast((prev) => ({
                          id: (prev?.id ?? 0) + 1,
                          message: 'Note deleted.',
                        }))
                        return true
                      }}
                      onDraftChange={reportDraftState}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2">
              <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
                Summaries
              </h2>
              {summaries.length === 0 ? (
                <p className="text-sm text-[var(--color-fg-faint)] px-1">
                  No compacted summaries yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  {summaries.map((summary) => (
                    <EditableSummaryRow
                      key={summary.id}
                      summary={summary}
                      onSave={async (bullets) => {
                        await updateAiMemorySummaryBullets(summary.id, bullets)
                        await load()
                        showToast('Summary saved.')
                      }}
                      onDraftChange={reportDraftState}
                    />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
      <Toast
        notice={toast}
        onDismiss={() => {
          setUndoNote(null)
          dismissToast()
        }}
        action={
          undoNote
            ? { label: 'Undo', onClick: () => void undoDelete() }
            : undefined
        }
        durationMs={undoNote ? 6000 : 2600}
      />
    </>
  )
}

function MemoryStatusCard({
  settings,
  busy,
  onToggle,
}: {
  settings: AiMemorySettings
  busy: boolean
  onToggle: () => void
}) {
  const running = !settings.paused
  return (
    <section className="card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Brain
            size={18}
            className="shrink-0 text-[var(--color-accent)]"
          />
          <div className="min-w-0">
            <h2 className="font-semibold leading-tight">
              {running ? 'Memory running' : 'Memory stopped'}
            </h2>
            <p className="text-xs text-[var(--color-fg-faint)] mt-0.5">
              {running ? 'Codex summaries active' : 'Codex summaries off'}
            </p>
          </div>
        </div>
        <span
          className="shrink-0 text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full"
          style={{
            color: running ? 'oklch(0.2 0.04 50)' : 'var(--color-fg-faint)',
            background: running ? 'var(--color-accent)' : 'var(--color-surface-2)',
          }}
        >
          {running ? 'Running' : 'Stopped'}
        </span>
      </div>

      <div className="border-t border-[var(--color-border)] pt-3 space-y-2">
        <WindowRow
          label={running ? 'Next 14-day summary' : '14-day window'}
          value={periodLabel(
            settings.windowStartedAt,
            nextTwoWeekEnd(settings.windowStartedAt),
          )}
        />
        <WindowRow
          label={running ? 'Next 4-month summary' : '4-month window'}
          value={periodLabel(
            settings.fourMonthStartedAt,
            nextFourMonthEnd(settings.fourMonthStartedAt),
          )}
        />
      </div>

      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        className={running ? 'btn-secondary w-full py-2.5 text-sm' : 'btn-primary w-full py-2.5 text-sm'}
      >
        {running ? (
          <>
            <PauseCircle size={16} /> Stop AI memory
          </>
        ) : (
          <>
            <PlayCircle size={16} /> Resume AI memory
          </>
        )}
      </button>
    </section>
  )
}

function WindowRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <CalendarDays
        size={15}
        className="shrink-0 text-[var(--color-fg-faint)]"
      />
      <span className="text-[var(--color-fg-faint)] flex-1">{label}</span>
      <span className="nums text-xs text-right text-[var(--color-fg-dim)]">
        {value}
      </span>
    </div>
  )
}

function EditableNoteRow({
  note,
  onSave,
  onDelete,
  onDraftChange,
}: {
  note: AiNote
  onSave: (body: string) => Promise<void>
  onDelete: () => Promise<boolean>
  onDraftChange: DraftStateReporter
}) {
  const [draft, setDraft] = useState(note.body)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useDraftStateReporter(
    onDraftChange,
    `note:${note.id}`,
    open && draft !== note.body,
  )

  useEffect(() => {
    setDraft(note.body)
  }, [note.body])

  async function save() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onSave(draft)
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onDelete()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function cancelEdit() {
    if (draft !== note.body && !confirm('Discard changes to this note?')) return
    setDraft(note.body)
    setError(null)
    setOpen(false)
  }

  if (!open) {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={busy}
          className="card-tight w-full px-3 py-2.5 flex items-center justify-between gap-3 text-left hover:bg-[var(--color-surface-2)] transition-colors"
          aria-label={`Open AI note from ${formatNoteTimestamp(note.createdAt)}`}
        >
          <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)]">
            {formatNoteTimestamp(note.createdAt)}
          </span>
          <ChevronDown
            size={16}
            className="shrink-0 text-[var(--color-fg-faint)]"
            aria-hidden
          />
        </button>
        {error && (
          <p role="alert" className="text-xs text-red-300 mt-2">
            {error}
          </p>
        )}
      </li>
    )
  }

  return (
    <li className="card-tight px-3 py-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)]">
          {formatNoteTimestamp(note.createdAt)}
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="min-h-11 min-w-11 grid place-items-center rounded-md text-[var(--color-fg-faint)] hover:text-red-300 hover:bg-[var(--color-surface-2)]"
            aria-label="Delete AI note"
          >
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            onClick={cancelEdit}
            disabled={busy}
            className="min-h-11 min-w-11 grid place-items-center rounded-md text-[var(--color-fg-faint)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-2)]"
            aria-label="Close AI note"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="field min-h-24 resize-y text-sm leading-relaxed"
        aria-label={`AI note from ${formatNoteTimestamp(note.createdAt)}`}
      />
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy || !draft.trim() || draft === note.body}
        className="btn-secondary w-full py-2 text-sm"
      >
        <Save size={14} /> Save note
      </button>
    </li>
  )
}

function EditableSummaryRow({
  summary,
  onSave,
  onDraftChange,
}: {
  summary: AiMemorySummary
  onSave: (bullets: string[]) => Promise<void>
  onDraftChange: DraftStateReporter
}) {
  const [drafts, setDrafts] = useState(summary.bullets)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const savedBulletsKey = summary.bullets.join('\n')
  const lastSavedBulletsKeyRef = useRef(savedBulletsKey)

  useEffect(() => {
    const previousSavedKey = lastSavedBulletsKeyRef.current
    lastSavedBulletsKeyRef.current = savedBulletsKey
    setDrafts((current) =>
      current.join('\n') === previousSavedKey ? summary.bullets : current,
    )
  }, [savedBulletsKey, summary.bullets])

  async function save() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onSave(drafts)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const changed = drafts.join('\n') !== summary.bullets.join('\n')
  useDraftStateReporter(onDraftChange, `summary:${summary.id}`, changed)

  return (
    <li className="card-tight px-3 py-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)]">
          {summary.periodType === 'two_week' ? '14-day' : '4-month'}
        </div>
        <div className="text-[10px] text-[var(--color-fg-faint)] nums">
          {periodLabel(summary.periodStartAt, summary.periodEndAt)}
        </div>
      </div>
      {drafts.map((bullet, i) => (
        <textarea
          key={i}
          value={bullet}
          onChange={(e) => {
            const next = drafts.slice()
            next[i] = e.target.value
            setDrafts(next)
          }}
          className="field min-h-20 resize-y text-sm leading-relaxed"
          aria-label={`Summary bullet ${i + 1}`}
        />
      ))}
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={() => void save()}
        disabled={busy || !changed || drafts.some((b) => !b.trim())}
        className="btn-secondary w-full py-2 text-sm"
      >
        <Save size={14} /> Save summary
      </button>
    </li>
  )
}

type DraftStateReporter = (key: string, dirty: boolean) => void

function useDraftStateReporter(
  report: DraftStateReporter,
  key: string,
  dirty: boolean,
) {
  useEffect(() => {
    report(key, dirty)
  }, [dirty, key, report])

  useEffect(
    () => () => {
      report(key, false)
    },
    [key, report],
  )
}
