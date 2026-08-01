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

  const load = useCallback(async () => {
    if (!id) return
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
  }, [id, navigate])

  useEffect(() => {
    void load()
  }, [load])

  async function saveProgramName(name: string) {
    if (!program) return
    await renameProgram(program.id, name)
    setProgram({ ...program, name: name.trim() })
  }

  async function handleAddSession() {
    if (!program || !newSessionName.trim()) return
    await addSessionTemplate(program.id, newSessionName)
    setNewSessionName('')
    setAddingSession(false)
    await load()
  }

  async function handlePickExercise(exerciseId: string) {
    if (!pickerFor) return
    await addTemplateExercise({
      sessionTemplateId: pickerFor,
      exerciseId,
      targetSets: 3,
      targetRepRange: '8-12',
    })
    setPickerFor(null)
    await load()
  }

  if (!program) {
    return (
      <>
        <Header title="Program" back="/programs" />
        <p className="p-6 text-[var(--color-fg-faint)] text-center">Loading…</p>
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
            onClick={() => setAddingSession(true)}
            className="btn-primary text-sm px-3 py-1.5"
            aria-label="Add session"
          >
            <Plus size={16} strokeWidth={2.5} />
            <span className="hidden sm:inline">Session</span>
          </button>
        }
      />

      <div className="px-4 py-4 space-y-6 max-w-md mx-auto">
        <NameField value={program.name} onSave={saveProgramName} />

        <section className="space-y-3">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
            Sessions
          </h2>

          {addingSession && (
            <form
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
                onChange={(e) => setNewSessionName(e.target.value)}
                placeholder="e.g. Push A"
                className="field"
              />
              <div className="flex gap-2">
                <button type="submit" className="btn-primary text-sm flex-1">
                  <Check size={16} /> Add
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAddingSession(false)
                    setNewSessionName('')
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
              onAddExercise={() => setPickerFor(s.id)}
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
}: {
  value: string
  onSave: (s: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
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
        await onSave(draft)
        setEditing(false)
      }}
      className="flex gap-2"
    >
      <input
        autoFocus
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="field font-semibold"
      />
      <button type="submit" className="btn-primary text-sm" aria-label="Save">
        <Check size={16} />
      </button>
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
  onAddExercise,
}: {
  session: SessionTemplate
  isFirst: boolean
  isLast: boolean
  tes: TemplateExercise[]
  exMap: Map<string, Exercise>
  onChange: () => void
  onAddExercise: () => void
}) {
  const [editingName, setEditingName] = useState(false)
  const [draftName, setDraftName] = useState(session.name)

  async function saveName() {
    await renameSessionTemplate(session.id, draftName)
    setEditingName(false)
    onChange()
  }

  async function remove() {
    if (!confirm(`Delete session "${session.name}"?`)) return
    await deleteSessionTemplate(session.id)
    onChange()
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
            className="flex-1 flex gap-2"
          >
            <input
              autoFocus
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              className="field text-sm"
            />
            <button
              type="submit"
              className="btn-primary text-xs px-2.5"
              aria-label="Save name"
            >
              <Check size={14} />
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraftName(session.name)
              setEditingName(true)
            }}
            className="flex-1 text-left font-semibold truncate"
          >
            {session.name}
          </button>
        )}
        <ReorderButtons
          onUp={async () => {
            await moveSessionTemplate(session.id, 'up')
            onChange()
          }}
          onDown={async () => {
            await moveSessionTemplate(session.id, 'down')
            onChange()
          }}
          disableUp={isFirst}
          disableDown={isLast}
        />
        <button
          type="button"
          onClick={() => void remove()}
          aria-label="Delete session"
          className="p-1.5 text-red-400 hover:text-red-300"
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
    <div className="flex flex-col leading-none">
      <button
        type="button"
        onClick={onUp}
        disabled={disableUp}
        className="px-1 -my-0.5 text-[var(--color-fg-faint)] hover:text-[var(--color-fg-dim)] disabled:opacity-30 disabled:hover:text-[var(--color-fg-faint)]"
        aria-label="Move up"
      >
        <ChevronUp size={16} />
      </button>
      <button
        type="button"
        onClick={onDown}
        disabled={disableDown}
        className="px-1 -my-0.5 text-[var(--color-fg-faint)] hover:text-[var(--color-fg-dim)] disabled:opacity-30 disabled:hover:text-[var(--color-fg-faint)]"
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
}: {
  te: TemplateExercise
  exercise?: Exercise
  isFirst: boolean
  isLast: boolean
  onChange: () => void
}) {
  const [sets, setSets] = useState(String(te.targetSets))
  const [reps, setReps] = useState(te.targetRepRange)
  const [dirty, setDirty] = useState(false)

  async function save() {
    await updateTemplateExercise(te.id, {
      targetSets: Number(sets),
      targetRepRange: reps,
    })
    setDirty(false)
    onChange()
  }

  async function remove() {
    if (!confirm('Remove this exercise from the session?')) return
    await deleteTemplateExercise(te.id)
    onChange()
  }

  return (
    <li className="px-3 py-2.5 flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate text-sm">
          {exercise?.name ?? '(missing)'}
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={sets}
            onChange={(e) => {
              setSets(e.target.value)
              setDirty(true)
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
            }}
            placeholder="8-12"
            className="field-inset w-20 px-1 py-1"
            aria-label="Target rep range"
          />
          {dirty && (
            <button
              type="button"
              onClick={() => void save()}
              className="btn-primary text-xs px-2 py-1"
              aria-label="Save targets"
            >
              <Check size={12} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
      <ReorderButtons
        onUp={async () => {
          await moveTemplateExercise(te.id, 'up')
          onChange()
        }}
        onDown={async () => {
          await moveTemplateExercise(te.id, 'down')
          onChange()
        }}
        disableUp={isFirst}
        disableDown={isLast}
      />
      <button
        type="button"
        onClick={() => void remove()}
        aria-label="Remove exercise"
        className="p-1.5 text-red-400 hover:text-red-300"
      >
        <X size={14} />
      </button>
    </li>
  )
}
