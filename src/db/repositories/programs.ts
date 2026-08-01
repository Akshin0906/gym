import Dexie from 'dexie'
import { db } from '../schema'
import type {
  Program,
  ProgramRow,
  SessionTemplate,
  TemplateExercise,
} from '../types'

function fromRow(r: ProgramRow): Program {
  return { ...r, isActive: r.isActive === 1 }
}

// Re-densify `order` from 0..N-1, only writing rows that need changing.
async function compactOrder<T extends { id: string; order: number }>(
  siblings: T[],
  update: (id: string, order: number) => Promise<unknown>,
): Promise<void> {
  const sorted = siblings.slice().sort((a, b) => a.order - b.order)
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].order !== i) await update(sorted[i].id, i)
  }
}

// Swap `order` of `id` with its neighbor in `direction`. No-op at edges.
async function swapOrder<T extends { id: string; order: number }>(
  siblings: T[],
  id: string,
  direction: 'up' | 'down',
  update: (id: string, order: number) => Promise<unknown>,
): Promise<void> {
  const sorted = siblings.slice().sort((a, b) => a.order - b.order)
  const idx = sorted.findIndex((s) => s.id === id)
  if (idx === -1) return
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1
  if (swapIdx < 0 || swapIdx >= sorted.length) return
  const a = sorted[idx]
  const b = sorted[swapIdx]
  await update(a.id, b.order)
  await update(b.id, a.order)
}

export async function listPrograms(): Promise<Program[]> {
  const all = await db.programs.toArray()
  return all
    .map(fromRow)
    .sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
      if (a.archivedAt === null && b.archivedAt !== null) return -1
      if (a.archivedAt !== null && b.archivedAt === null) return 1
      return b.createdAt - a.createdAt
    })
}

export async function getActiveProgram(): Promise<Program | undefined> {
  const row = await db.programs.where('isActive').equals(1).first()
  return row ? fromRow(row) : undefined
}

export async function createProgram(name: string): Promise<string> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Program name is required')
  const id = crypto.randomUUID()
  await db.programs.add({
    id,
    name: trimmed,
    isActive: 0,
    createdAt: Date.now(),
    archivedAt: null,
  })
  return id
}

export async function renameProgram(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Program name is required')
  await db.programs.update(id, { name: trimmed })
}

export async function setProgramActive(id: string): Promise<void> {
  await db.transaction('rw', db.programs, async () => {
    const target = await db.programs.get(id)
    if (!target) throw new Error('Program not found')
    if (target.archivedAt !== null) {
      await db.programs.update(id, { archivedAt: null })
    }
    const allActive = await db.programs.where('isActive').equals(1).toArray()
    for (const p of allActive) {
      if (p.id !== id) await db.programs.update(p.id, { isActive: 0 })
    }
    await db.programs.update(id, { isActive: 1 })
  })
}

export async function archiveProgram(id: string): Promise<void> {
  await db.programs.update(id, { isActive: 0, archivedAt: Date.now() })
}

export async function cloneProgram(sourceId: string): Promise<string> {
  const newId = crypto.randomUUID()
  await db.transaction(
    'rw',
    [db.programs, db.sessionTemplates, db.templateExercises],
    async () => {
      const source = await db.programs.get(sourceId)
      if (!source) throw new Error('Program not found')
      await db.programs.add({
        id: newId,
        name: `${source.name} (copy)`,
        isActive: 0,
        createdAt: Date.now(),
        archivedAt: null,
      })
      const sessions = await db.sessionTemplates
        .where('programId')
        .equals(sourceId)
        .toArray()
      for (const s of sessions) {
        const newSessionId = crypto.randomUUID()
        await db.sessionTemplates.add({
          id: newSessionId,
          programId: newId,
          name: s.name,
          order: s.order,
        })
        const tes = await db.templateExercises
          .where('sessionTemplateId')
          .equals(s.id)
          .toArray()
        for (const te of tes) {
          await db.templateExercises.add({
            ...te,
            id: crypto.randomUUID(),
            sessionTemplateId: newSessionId,
          })
        }
      }
    },
  )
  return newId
}

export async function getProgram(id: string): Promise<Program | undefined> {
  const row = await db.programs.get(id)
  return row ? fromRow(row) : undefined
}

export async function getSessionsForProgram(
  programId: string,
): Promise<SessionTemplate[]> {
  return db.sessionTemplates
    .where('[programId+order]')
    .between([programId, Dexie.minKey], [programId, Dexie.maxKey])
    .toArray()
}

export async function addSessionTemplate(
  programId: string,
  name: string,
): Promise<string> {
  const trimmed = name.trim() || 'Session'
  const id = crypto.randomUUID()
  await db.transaction('rw', db.sessionTemplates, async () => {
    const existing = await getSessionsForProgram(programId)
    const order = existing.length
    await db.sessionTemplates.add({ id, programId, name: trimmed, order })
  })
  return id
}

export async function renameSessionTemplate(
  id: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Session name is required')
  await db.sessionTemplates.update(id, { name: trimmed })
}

export async function deleteSessionTemplate(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.sessionTemplates, db.templateExercises, db.workoutSessions],
    async () => {
      const target = await db.sessionTemplates.get(id)
      if (!target) return
      await db.templateExercises
        .where('sessionTemplateId')
        .equals(id)
        .delete()
      const refs = await db.workoutSessions
        .where('sessionTemplateId')
        .equals(id)
        .toArray()
      for (const w of refs) {
        await db.workoutSessions.update(w.id, { sessionTemplateId: null })
      }
      await db.sessionTemplates.delete(id)
      await compactOrder(
        await getSessionsForProgram(target.programId),
        (rowId, order) => db.sessionTemplates.update(rowId, { order }),
      )
    },
  )
}

export async function moveSessionTemplate(
  id: string,
  direction: 'up' | 'down',
): Promise<void> {
  await db.transaction('rw', db.sessionTemplates, async () => {
    const target = await db.sessionTemplates.get(id)
    if (!target) return
    await swapOrder(
      await getSessionsForProgram(target.programId),
      id,
      direction,
      (rowId, order) => db.sessionTemplates.update(rowId, { order }),
    )
  })
}

export async function getTemplateExercises(
  sessionTemplateId: string,
): Promise<TemplateExercise[]> {
  return db.templateExercises
    .where('[sessionTemplateId+order]')
    .between(
      [sessionTemplateId, Dexie.minKey],
      [sessionTemplateId, Dexie.maxKey],
    )
    .toArray()
}

export async function addTemplateExercise(args: {
  sessionTemplateId: string
  exerciseId: string
  targetSets: number
  targetRepRange: string
}): Promise<string> {
  if (args.targetSets <= 0) throw new Error('Target sets must be > 0')
  const id = crypto.randomUUID()
  await db.transaction('rw', db.templateExercises, async () => {
    const existing = await getTemplateExercises(args.sessionTemplateId)
    await db.templateExercises.add({
      id,
      sessionTemplateId: args.sessionTemplateId,
      exerciseId: args.exerciseId,
      order: existing.length,
      targetSets: args.targetSets,
      targetRepRange: args.targetRepRange,
    })
  })
  return id
}

export async function updateTemplateExercise(
  id: string,
  patch: { targetSets?: number; targetRepRange?: string },
): Promise<void> {
  if (patch.targetSets !== undefined && patch.targetSets <= 0)
    throw new Error('Target sets must be > 0')
  await db.templateExercises.update(id, patch)
}

export async function deleteTemplateExercise(id: string): Promise<void> {
  await db.transaction('rw', db.templateExercises, async () => {
    const target = await db.templateExercises.get(id)
    if (!target) return
    await db.templateExercises.delete(id)
    await compactOrder(
      await getTemplateExercises(target.sessionTemplateId),
      (rowId, order) => db.templateExercises.update(rowId, { order }),
    )
  })
}

export async function moveTemplateExercise(
  id: string,
  direction: 'up' | 'down',
): Promise<void> {
  await db.transaction('rw', db.templateExercises, async () => {
    const target = await db.templateExercises.get(id)
    if (!target) return
    await swapOrder(
      await getTemplateExercises(target.sessionTemplateId),
      id,
      direction,
      (rowId, order) => db.templateExercises.update(rowId, { order }),
    )
  })
}
