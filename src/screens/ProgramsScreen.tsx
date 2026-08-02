import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Archive, CheckCircle2, Copy, Plus, Zap } from 'lucide-react'
import { ErrorAlert } from '../components/Feedback'
import { Header, SettingsLink } from '../components/Header'
import {
  archiveProgram,
  cloneProgram,
  createProgram,
  listPrograms,
  setProgramActive,
} from '../db/repositories/programs'
import type { Program } from '../db/types'
import { useUnsavedChangesWarning } from '../lib/useUnsavedChangesWarning'

export function ProgramsScreen() {
  const navigate = useNavigate()
  const [programs, setPrograms] = useState<Program[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [createdProgramId, setCreatedProgramId] = useState<string | null>(null)
  useUnsavedChangesWarning(adding && Boolean(newName.trim()))

  useEffect(() => {
    if (!createdProgramId) return
    navigate(`/programs/${createdProgramId}`)
  }, [createdProgramId, navigate])

  async function refresh() {
    try {
      setPrograms(await listPrograms())
      setPageError(null)
    } catch (caught) {
      setPageError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function handleCreate() {
    if (!newName.trim()) {
      setCreateError('Enter a program name.')
      return
    }
    try {
      const id = await createProgram(newName)
      setNewName('')
      setCreateError(null)
      setAdding(false)
      // Navigate after the clean render so the route blocker cannot mistake a
      // successfully persisted program for an abandoned draft.
      setCreatedProgramId(id)
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  if (programs === null) {
    return (
      <>
        <Header title="Programs" right={<SettingsLink />} />
        {pageError ? (
          <div className="p-4 max-w-md mx-auto space-y-3">
            <ErrorAlert message={pageError} />
            <button
              type="button"
              onClick={() => void refresh()}
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

  const active = programs.filter((p) => p.isActive)
  const inactive = programs.filter(
    (p) => !p.isActive && p.archivedAt === null,
  )
  const archived = programs.filter((p) => p.archivedAt !== null)

  return (
    <>
      <Header
        title="Programs"
        right={
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="btn-primary text-sm px-3 py-1.5"
              aria-label="New program"
            >
              <Plus size={16} strokeWidth={2.5} />
            </button>
            <SettingsLink />
          </div>
        }
      />

      <div className="px-4 py-4 space-y-6 max-w-2xl mx-auto">
        {pageError && <ErrorAlert message={pageError} />}
        {adding && (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              void handleCreate()
            }}
            className="card p-3 space-y-2"
          >
            <input
              id="new-program-name"
              type="text"
              autoFocus
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value)
                if (createError) setCreateError(null)
              }}
              placeholder="Program name"
              aria-label="Program name"
              aria-invalid={Boolean(createError)}
              aria-describedby={createError ? 'new-program-error' : undefined}
              className="field"
            />
            {createError && (
              <p id="new-program-error" role="alert" className="text-sm text-red-300">
                {createError}
              </p>
            )}
            <div className="flex gap-2">
              <button type="submit" className="btn-primary text-sm">
                Create
              </button>
              <button
                type="button"
                onClick={() => {
                  if (
                    newName.trim() &&
                    !confirm('Discard this new program draft?')
                  ) {
                    return
                  }
                  setAdding(false)
                  setNewName('')
                  setCreateError(null)
                }}
                className="btn-ghost text-sm"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {active.length > 0 && (
          <Section title="Active">
            {active.map((p) => (
              <ProgramRow
                key={p.id}
                program={p}
                onChange={() => void refresh()}
                onError={setPageError}
              />
            ))}
          </Section>
        )}
        {inactive.length > 0 && (
          <Section title="Available">
            {inactive.map((p) => (
              <ProgramRow
                key={p.id}
                program={p}
                onChange={() => void refresh()}
                onError={setPageError}
              />
            ))}
          </Section>
        )}
        {archived.length > 0 && (
          <Section title="Archived">
            {archived.map((p) => (
              <ProgramRow
                key={p.id}
                program={p}
                onChange={() => void refresh()}
                onError={setPageError}
              />
            ))}
          </Section>
        )}
        {programs.length === 0 && !adding && (
          <p className="text-center text-neutral-500 py-6">
            No programs yet. Tap + to create one.
          </p>
        )}
      </div>
    </>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] mb-2 px-1">
        {title}
      </h2>
      <ul className="space-y-2">{children}</ul>
    </section>
  )
}

function ProgramRow({
  program,
  onChange,
  onError,
}: {
  program: Program
  onChange: () => void
  onError: (message: string | null) => void
}) {
  async function run(action: () => Promise<unknown>) {
    onError(null)
    try {
      await action()
      onChange()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function makeActive() {
    await run(() => setProgramActive(program.id))
  }
  async function archive() {
    if (!confirm(`Archive "${program.name}"?`)) return
    await run(() => archiveProgram(program.id))
  }
  async function clone() {
    await run(() => cloneProgram(program.id))
  }

  return (
    <li className="card overflow-hidden">
      <Link
        to={`/programs/${program.id}`}
        className="block px-3 py-3 hover:bg-[var(--color-surface-2)]"
      >
        <div className="flex items-center gap-2">
          {program.isActive ? (
            <Zap
              size={14}
              className="text-[var(--color-accent)] shrink-0"
              fill="currentColor"
            />
          ) : program.archivedAt !== null ? (
            <Archive
              size={14}
              className="text-[var(--color-fg-faint)] shrink-0"
            />
          ) : null}
          <span className="font-semibold truncate flex-1">{program.name}</span>
          {program.isActive && (
            <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-accent)] shrink-0">
              Active
            </span>
          )}
        </div>
      </Link>
      <div className="px-3 py-2 border-t border-[var(--color-border)] flex gap-2 text-xs">
        {!program.isActive && (
          <button
            type="button"
            onClick={() => void makeActive()}
            className="btn-ghost text-xs px-2 py-1 text-[var(--color-accent)]"
          >
            <CheckCircle2 size={14} /> Make active
          </button>
        )}
        <button
          type="button"
          onClick={() => void clone()}
          className="btn-ghost text-xs px-2 py-1"
        >
          <Copy size={14} /> Clone
        </button>
        {program.archivedAt === null && !program.isActive && (
          <button
            type="button"
            onClick={() => void archive()}
            className="btn-ghost text-xs px-2 py-1 ml-auto"
          >
            <Archive size={14} /> Archive
          </button>
        )}
      </div>
    </li>
  )
}
