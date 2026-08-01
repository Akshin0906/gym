import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Play } from 'lucide-react'
import { Header } from '../components/Header'
import { db } from '../db/schema'
import { getExercisesByIds } from '../db/repositories/exercises'
import {
  getProgram,
  getTemplateExercises,
} from '../db/repositories/programs'
import { startSession } from '../db/repositories/sessions'
import type {
  Exercise,
  Program,
  SessionTemplate,
  TemplateExercise,
} from '../db/types'
import { useActiveWorkout } from '../store/activeWorkout'

interface Data {
  template: SessionTemplate
  program: Program | null
  rows: { te: TemplateExercise; exercise: Exercise | undefined }[]
}

export function SessionPreviewScreen() {
  const { templateId } = useParams<{ templateId: string }>()
  const navigate = useNavigate()
  const { setActiveSession } = useActiveWorkout()
  const [data, setData] = useState<Data | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!templateId) return
    let cancelled = false
    void (async () => {
      const template = await db.sessionTemplates.get(templateId)
      if (!template) {
        if (!cancelled) setNotFound(true)
        return
      }
      const [program, tes] = await Promise.all([
        getProgram(template.programId),
        getTemplateExercises(template.id),
      ])
      const exMap = await getExercisesByIds(tes.map((t) => t.exerciseId))
      const rows = tes
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((te) => ({ te, exercise: exMap.get(te.exerciseId) }))
      if (!cancelled) {
        setData({ template, program: program ?? null, rows })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [templateId])

  async function handleStart() {
    if (!data || starting) return
    setStarting(true)
    const id = await startSession(data.template, data.program)
    setActiveSession(id)
    navigate('/workout')
  }

  if (notFound) {
    return (
      <>
        <Header title="Workout" back="/" />
        <p className="p-6 text-[var(--color-fg-faint)] text-center">
          This workout doesn't exist anymore.
        </p>
      </>
    )
  }

  if (!data) {
    return (
      <>
        <Header title="Workout" back="/" />
        <p className="p-6 text-[var(--color-fg-faint)] text-center">Loading…</p>
      </>
    )
  }

  return (
    <>
      <Header
        title={data.template.name}
        subtitle={data.program?.name ?? undefined}
        back="/"
      />
      <div className="px-4 py-4 pb-32 space-y-4 max-w-md mx-auto">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-fg-faint)] px-1">
          {data.rows.length} {data.rows.length === 1 ? 'exercise' : 'exercises'}
        </h3>
        {data.rows.length === 0 ? (
          <div className="card p-6 text-center text-sm text-[var(--color-fg-dim)]">
            No exercises planned for this session yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {data.rows.map(({ te, exercise }) => (
              <li key={te.id} className="card px-4 py-3 flex items-baseline gap-3">
                <span className="text-xs text-[var(--color-fg-faint)] nums w-5 text-right tabular-nums">
                  {te.order + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold leading-tight truncate">
                    {exercise?.name ?? 'Unknown exercise'}
                  </p>
                  <p className="text-xs text-[var(--color-fg-faint)] nums mt-0.5">
                    {te.targetSets} {te.targetSets === 1 ? 'set' : 'sets'}
                    {te.targetRepRange && ` · ${te.targetRepRange}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div
        className="fixed inset-x-0 px-4 pt-3 pb-4"
        style={{
          bottom: 'var(--tab-bar-height)',
          background:
            'linear-gradient(to top, var(--color-bg) 60%, transparent)',
        }}
      >
        <div className="max-w-md mx-auto">
          <button
            type="button"
            onClick={() => void handleStart()}
            disabled={starting}
            className="btn-primary w-full justify-center text-base py-3"
          >
            <Play size={18} fill="currentColor" />
            {starting ? 'Starting…' : 'Start workout'}
          </button>
        </div>
      </div>
    </>
  )
}
