import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Archive, CheckCircle2, Copy, Plus, Zap } from 'lucide-react'
import { Header, SettingsLink } from '../components/Header'
import {
  archiveProgram,
  cloneProgram,
  createProgram,
  listPrograms,
  setProgramActive,
} from '../db/repositories/programs'
import type { Program } from '../db/types'

export function ProgramsScreen() {
  const navigate = useNavigate()
  const [programs, setPrograms] = useState<Program[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  async function refresh() {
    setPrograms(await listPrograms())
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function handleCreate() {
    if (!newName.trim()) return
    const id = await createProgram(newName)
    setNewName('')
    setAdding(false)
    navigate(`/programs/${id}`)
  }

  if (programs === null) {
    return (
      <>
        <Header title="Programs" right={<SettingsLink />} />
        <p className="p-6 text-neutral-500 text-center">Loading…</p>
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

      <div className="px-4 py-4 space-y-6">
        {adding && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void handleCreate()
            }}
            className="card p-3 space-y-2"
          >
            <input
              type="text"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Program name"
              className="field"
            />
            <div className="flex gap-2">
              <button type="submit" className="btn-primary text-sm">
                Create
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdding(false)
                  setNewName('')
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
              <ProgramRow key={p.id} program={p} onChange={() => void refresh()} />
            ))}
          </Section>
        )}
        {inactive.length > 0 && (
          <Section title="Available">
            {inactive.map((p) => (
              <ProgramRow key={p.id} program={p} onChange={() => void refresh()} />
            ))}
          </Section>
        )}
        {archived.length > 0 && (
          <Section title="Archived">
            {archived.map((p) => (
              <ProgramRow key={p.id} program={p} onChange={() => void refresh()} />
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
}: {
  program: Program
  onChange: () => void
}) {
  async function makeActive() {
    await setProgramActive(program.id)
    onChange()
  }
  async function archive() {
    if (!confirm(`Archive "${program.name}"?`)) return
    await archiveProgram(program.id)
    onChange()
  }
  async function clone() {
    await cloneProgram(program.id)
    onChange()
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
