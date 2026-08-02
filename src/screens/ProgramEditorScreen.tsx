import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Check,
  ChevronDown,
  ChevronUp,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { Header } from '../components/Header'
import { ErrorAlert } from '../components/Feedback'
import { ExercisePickerSheet } from '../components/ExercisePickerSheet'
import { getExercisesByIds } from '../db/repositories/exercises'
import {
  addSessionTemplate,
  addTemplateExercise,
  deleteSessionTemplate,
  deleteTemplateExercise,
  getProgram,
  getSessionsForProgram,
  getTemplateExercises,
  MAX_TARGET_SETS,
  moveSessionTemplate,
  moveTemplateExercise,
  renameProgram,
  renameSessionTemplate,
  updateTemplateExercise,
} from '../db/repositories/programs'
import type {
  Exercise,
  Program,
  SessionTemplate,
  TemplateExercise,
} from '../db/types'
import { useUnsavedChangesWarning } from '../lib/useUnsavedChangesWarning'

export function ProgramEditorScreen() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [program, setProgram] = useState<Program | null>(null)
  const [sessions, setSessions] = useState<SessionTemplate[]>([])
  const [tesBySession, setTesBySession] = useState<
    Map<string, TemplateExercise[]>
  >(new Map())
  const [exMap, setExMap] = useState<Map<string, Exercise>>(new Map())
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const [addingSession, setAddingSession] = useState(false)
  const [newSessionName, setNewSessionName] = useState('')
  const [newSessionError, setNewSessionError] = useState<string | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [dirtyDrafts, setDirtyDrafts] = useState<Set<string>>(() => new Set())
  const reportDraftState = useCallback<DraftStateReporter>((key, dirty) => {
    setDirtyDrafts((current) => {
      if (current.has(key) === dirty) return current
      const next = new Set(current)
      if (dirty) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  useUnsavedChangesWarning(
    dirtyDrafts.size > 0 ||
      (addingSession && Boolean(newSessionName.trim())),
  )

  const load = useCallback(async () => {
    if (!id) return
    try {
      const p = await getProgram(id)
      if (!p) {
        navigate('/programs')
        return
      }
      setProgram(p)
      const ss = (await getSessionsForProgram(id)).sort(
        (a, b) => a.order - b.order,
      )
      setSessions(ss)
      const tesArr = await Promise.all(
        ss.map((s) =>
          getTemplateExercises(s.id).then((tes) =>
            tes.sort((a, b) => a.order - b.order),
          ),
        ),
      )
      const map = new Map<string, TemplateExercise[]>()
      const exIds = new Set<string>()
      ss.forEach((s, i) => {
        map.set(s.id, tesArr[i])
        for (const te of tesArr[i]) exIds.add(te.exerciseId)
      })
      setTesBySession(map)
      setExMap(await getExercisesByIds(Array.from(exIds)))
      setPageError(null)
    } catch (caught) {
      setPageError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [id, navigate])

  useEffect(() => {
    void load()
  }, [load])

  async function saveProgramName(name: string) {
    if (!program) return
    try {
      await renameProgram(program.id, name)
      setProgram({ ...program, name: name.trim() })
      setPageError(null)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setPageError(message)
      throw caught
    }
  }

  async function handleAddSession() {
    if (!program) return
    if (!newSessionName.trim()) {
      setNewSessionError('Enter a session name.')
      return
    }
    try {
      await addSessionTemplate(program.id, newSessionName)
      setNewSessionName('')
      setNewSessionError(null)
      setAddingSession(false)
      await load()
    } catch (caught) {
      setNewSessionError(
        caught instanceof Error ? caught.message : String(caught),
      )
    }
  }

  async function handlePickExercise(exerciseId: string) {
    if (!pickerFor) return
    try {
      await addTemplateExercise({
        sessionTemplateId: pickerFor,
        exerciseId,
        targetSets: 3,
        targetRepRange: '8-12',
      })
      setPickerFor(null)
      await load()
    } catch (caught) {
      setPageError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  if (!program) {
    return (
      <>
        <Header title="Program" back="/programs" />
        {pageError ? (
          <div className="p-4 max-w-md mx-auto space-y-3">
            <ErrorAlert message={pageError} />
            <button
              type="button"
              onClick={() => void load()}
              className="btn-secondary w-full"
            >
              Retry
            </button>
          </div>
        ) : (
          <p role="status" className="p-6 text-[var(--color-fg-faint)] text-center">
            Loading…
          </p>
        )}
      </>
    )
  }

  return (
    <>
      <Header
        title="Edit program"
        back="/programs"
        right={
          <button
            type="button"
            onClick={() => {
              setNewSessionError(null)
              setAddingSession(true)
            }}
            className="btn-primary text-sm px-3 py-1.5"
            aria-label="Add session"
          >
            <Plus size={16} strokeWidth={2.5} />
            <span className="hidden sm:inline">Session</span>
          </button>
        }
      />

      <div className="px-4 py-4 space-y-6 max-w-md mx-auto">
        {pageError && <ErrorAlert message={pageError} />}
        <NameField
          value={program.name}
          onSave={saveProgramName}
          onDraftChange={reportDraftState}
        />

        <section className="space-y-3">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
            Sessions
          </h2>

          {addingSession && (
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault()
                void handleAddSession()
              }}
              className="card p-3 space-y-2"
            >
              <input
                autoFocus
                type="text"
                value={newSessionName}
                onChange={(e) => {
                  setNewSessionName(e.target.value)
                  if (newSessionError) setNewSessionError(null)
                }}
                placeholder="e.g. Push A"
                aria-label="Session name"
                aria-invalid={Boolean(newSessionError)}
                aria-describedby={
                  newSessionError ? 'new-session-error' : undefined
                }
                className="field"
              />
              {newSessionError && (
                <p
                  id="new-session-error"
                  role="alert"
                  className="text-sm text-red-300"
                >
                  {newSessionError}
                </p>
              )}
              <div className="flex gap-2">
                <button type="submit" className="btn-primary text-sm flex-1">
                  <Check size={16} /> Add
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      newSessionName.trim() &&
                      !confirm('Discard this new session draft?')
                    ) {
                      return
                    }
                    setAddingSession(false)
                    setNewSessionName('')
                    setNewSessionError(null)
                  }}
                  className="btn-ghost text-sm"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {sessions.length === 0 && !addingSession && (
            <p className="text-sm text-[var(--color-fg-faint)] py-4 text-center">
              No sessions yet. Tap + to add one.
            </p>
          )}

          {sessions.map((s, idx) => (
            <SessionBlock
              key={s.id}
              session={s}
              isFirst={idx === 0}
              isLast={idx === sessions.length - 1}
              tes={tesBySession.get(s.id) ?? []}
              exMap={exMap}
              onChange={() => void load()}
              onError={setPageError}
              onAddExercise={() => setPickerFor(s.id)}
              onDraftChange={reportDraftState}
            />
          ))}
        </section>
      </div>

      <ExercisePickerSheet
        open={pickerFor !== null}
        onClose={() => setPickerFor(null)}
        onPick={(exId) => void handlePickExercise(exId)}
        excludeIds={
          pickerFor
            ? (tesBySession.get(pickerFor) ?? []).map((t) => t.exerciseId)
            : []
        }
      />
    </>
  )
}

function NameField({
  value,
  onSave,
  onDraftChange,
}: {
  value: string
  onSave: (s: string) => Promise<void>
  onDraftChange: DraftStateReporter
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  useDraftStateReporter(
    onDraftChange,
    'program-name',
    editing && draft !== value,
  )

  useEffect(() => {
    setDraft(value)
  }, [value])

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Rename program ${value}`}
        className="w-full flex items-center gap-2 text-left group"
      >
        <span className="text-2xl font-bold truncate flex-1">{value}</span>
        <Pencil
          size={16}
          className="shrink-0 text-[var(--color-fg-faint)] group-hover:text-[var(--color-fg-dim)]"
        />
      </button>
    )
  }
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        if (!draft.trim()) {
          setError('Enter a program name.')
          return
        }
        try {
          await onSave(draft)
          setError(null)
          setEditing(false)
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }}
      className="space-y-2"
      noValidate
    >
      <div className="flex gap-2">
        <input
          autoFocus
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(null)
          }}
          aria-label="Program name"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'program-name-error' : undefined}
          className="field w-auto flex-1 min-w-0 font-semibold"
          style={{ width: 'auto' }}
        />
        <button
          type="submit"
          className="btn-primary min-w-11 text-sm"
          aria-label="Save program name"
        >
          <Check size={16} />
        </button>
        <button
          type="button"
          onClick={() => {
            if (draft !== value && !confirm('Discard the program name change?')) {
              return
            }
            setDraft(value)
            setError(null)
            setEditing(false)
          }}
          className="btn-ghost min-w-11 justify-center px-2"
          aria-label="Cancel program name edit"
        >
          <X size={16} />
        </button>
      </div>
      {error && (
        <p id="program-name-error" role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
    </form>
  )
}

function SessionBlock({
  session,
  isFirst,
  isLast,
  tes,
  exMap,
  onChange,
  onError,
  onAddExercise,
  onDraftChange,
}: {
  session: SessionTemplate
  isFirst: boolean
  isLast: boolean
  tes: TemplateExercise[]
  exMap: Map<string, Exercise>
  onChange: () => void
  onError: (message: string | null) => void
  onAddExercise: () => void
  onDraftChange: DraftStateReporter
}) {
  const [editingName, setEditingName] = useState(false)
  const [draftName, setDraftName] = useState(session.name)
  const [nameError, setNameError] = useState<string | null>(null)
  useDraftStateReporter(
    onDraftChange,
    `session-name:${session.id}`,
    editingName && draftName !== session.name,
  )

  async function saveName() {
    if (!draftName.trim()) {
      setNameError('Enter a session name.')
      return
    }
    try {
      await renameSessionTemplate(session.id, draftName)
      setNameError(null)
      setEditingName(false)
      onChange()
    } catch (caught) {
      setNameError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function remove() {
    if (!confirm(`Delete session "${session.name}"?`)) return
    try {
      await deleteSessionTemplate(session.id)
      onChange()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--color-border)]">
        {editingName ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void saveName()
            }}
            className="flex-1 min-w-0 flex flex-wrap gap-2"
            noValidate
          >
            <input
              autoFocus
              type="text"
              value={draftName}
              onChange={(e) => {
                setDraftName(e.target.value)
                if (nameError) setNameError(null)
              }}
              aria-label={`${session.name} session name`}
              aria-invalid={Boolean(nameError)}
              aria-describedby={nameError ? `session-name-error-${session.id}` : undefined}
              className="field w-auto flex-1 min-w-0 text-sm"
              style={{ width: 'auto' }}
            />
            <button
              type="submit"
              className="btn-primary text-xs px-2.5"
              aria-label="Save name"
            >
              <Check size={14} />
            </button>
            <button
              type="button"
              onClick={() => {
                if (
                  draftName !== session.name &&
                  !confirm('Discard the session name change?')
                ) {
                  return
                }
                setDraftName(session.name)
                setNameError(null)
                setEditingName(false)
              }}
              className="btn-ghost min-w-11 justify-center px-2"
              aria-label="Cancel session name edit"
            >
              <X size={14} />
            </button>
            {nameError && (
              <p
                id={`session-name-error-${session.id}`}
                role="alert"
                className="basis-full text-xs text-red-300"
              >
                {nameError}
              </p>
            )}
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraftName(session.name)
              setNameError(null)
              setEditingName(true)
            }}
            aria-label={`Rename session ${session.name}`}
            className="flex-1 text-left font-semibold truncate"
          >
            {session.name}
          </button>
        )}
        <ReorderButtons
          onUp={async () => {
            try {
              await moveSessionTemplate(session.id, 'up')
              onChange()
            } catch (caught) {
              onError(caught instanceof Error ? caught.message : String(caught))
            }
          }}
          onDown={async () => {
            try {
              await moveSessionTemplate(session.id, 'down')
              onChange()
            } catch (caught) {
              onError(caught instanceof Error ? caught.message : String(caught))
            }
          }}
          disableUp={isFirst}
          disableDown={isLast}
        />
        <button
          type="button"
          onClick={() => void remove()}
          aria-label="Delete session"
          className="min-h-11 min-w-11 grid place-items-center text-red-400 hover:text-red-300"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <ul className="divide-y divide-[var(--color-border)]">
        {tes.length === 0 ? (
          <li className="px-3 py-3 text-xs text-[var(--color-fg-faint)]">
            No exercises yet.
          </li>
        ) : (
          tes.map((te, i) => (
            <TemplateExerciseRow
              key={te.id}
              te={te}
              exercise={exMap.get(te.exerciseId)}
              isFirst={i === 0}
              isLast={i === tes.length - 1}
              onChange={onChange}
              onError={onError}
              onDraftChange={onDraftChange}
            />
          ))
        )}
      </ul>

      <div className="px-3 py-2 border-t border-[var(--color-border)]">
        <button
          type="button"
          onClick={onAddExercise}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border border-dashed border-[var(--color-border)] text-xs text-[var(--color-fg-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
        >
          <Plus size={14} /> Add exercise
        </button>
      </div>
    </div>
  )
}

function ReorderButtons({
  onUp,
  onDown,
  disableUp,
  disableDown,
}: {
  onUp: () => void
  onDown: () => void
  disableUp: boolean
  disableDown: boolean
}) {
  return (
    <div className="flex leading-none" role="group" aria-label="Reorder">
      <button
        type="button"
        onClick={onUp}
        disabled={disableUp}
        className="min-h-11 min-w-11 grid place-items-center text-[var(--color-fg-faint)] hover:text-[var(--color-fg-dim)] disabled:opacity-30 disabled:hover:text-[var(--color-fg-faint)]"
        aria-label="Move up"
      >
        <ChevronUp size={16} />
      </button>
      <button
        type="button"
        onClick={onDown}
        disabled={disableDown}
        className="min-h-11 min-w-11 grid place-items-center text-[var(--color-fg-faint)] hover:text-[var(--color-fg-dim)] disabled:opacity-30 disabled:hover:text-[var(--color-fg-faint)]"
        aria-label="Move down"
      >
        <ChevronDown size={16} />
      </button>
    </div>
  )
}

function TemplateExerciseRow({
  te,
  exercise,
  isFirst,
  isLast,
  onChange,
  onError,
  onDraftChange,
}: {
  te: TemplateExercise
  exercise?: Exercise
  isFirst: boolean
  isLast: boolean
  onChange: () => void
  onError: (message: string | null) => void
  onDraftChange: DraftStateReporter
}) {
  const [sets, setSets] = useState(String(te.targetSets))
  const [reps, setReps] = useState(te.targetRepRange)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useDraftStateReporter(onDraftChange, `targets:${te.id}`, dirty)

  async function save() {
    const targetSets = Number(sets)
    if (
      !Number.isSafeInteger(targetSets) ||
      targetSets < 1 ||
      targetSets > MAX_TARGET_SETS
    ) {
      setError(`Sets must be a whole number from 1 to ${MAX_TARGET_SETS}.`)
      return
    }
    if (!reps.trim()) {
      setError('Enter a target rep range.')
      return
    }
    try {
      await updateTemplateExercise(te.id, {
        targetSets,
        targetRepRange: reps,
      })
      setError(null)
      setDirty(false)
      onChange()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function remove() {
    if (!confirm('Remove this exercise from the session?')) return
    try {
      await deleteTemplateExercise(te.id)
      onChange()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  return (
    <li className="px-3 py-2.5 flex flex-wrap sm:flex-nowrap items-center justify-end gap-2">
      <div className="basis-full sm:basis-0 sm:flex-1 min-w-0">
        <div className="font-medium truncate text-sm">
          {exercise?.name ?? '(missing)'}
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_TARGET_SETS}
            value={sets}
            onChange={(e) => {
              setSets(e.target.value)
              setDirty(true)
              setError(null)
            }}
            className="field-inset w-14 px-1 py-1"
            aria-label="Target sets"
          />
          <span className="text-xs text-[var(--color-fg-faint)]">sets ×</span>
          <input
            type="text"
            value={reps}
            onChange={(e) => {
              setReps(e.target.value)
              setDirty(true)
              setError(null)
            }}
            placeholder="8-12"
            className="field-inset w-20 px-1 py-1"
            aria-label="Target rep range"
          />
          {dirty && (
            <button
              type="button"
              onClick={() => void save()}
              className="btn-primary min-h-11 min-w-11 text-xs px-2 py-1"
              aria-label="Save targets"
            >
              <Check size={12} strokeWidth={2.5} />
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-1.5 text-xs text-red-300">
            {error}
          </p>
        )}
      </div>
      <ReorderButtons
        onUp={async () => {
          try {
            await moveTemplateExercise(te.id, 'up')
            onChange()
          } catch (caught) {
            onError(caught instanceof Error ? caught.message : String(caught))
          }
        }}
        onDown={async () => {
          try {
            await moveTemplateExercise(te.id, 'down')
            onChange()
          } catch (caught) {
            onError(caught instanceof Error ? caught.message : String(caught))
          }
        }}
        disableUp={isFirst}
        disableDown={isLast}
      />
      <button
        type="button"
        onClick={() => void remove()}
        aria-label="Remove exercise"
        className="min-h-11 min-w-11 grid place-items-center text-red-400 hover:text-red-300"
      >
        <X size={14} />
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
