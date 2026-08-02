import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../schema'
import type { AiNote } from '../types'
import { deleteAiNote, restoreAiNote } from './aiMemory'

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()))
})

describe('AI note deletion undo', () => {
  it('restores the exact note identity and timestamps', async () => {
    const note: AiNote = {
      id: 'note-1',
      body: 'Keep shoulder volume conservative',
      createdAt: 123,
      updatedAt: 456,
    }
    await db.aiNotes.add(note)

    await deleteAiNote(note.id)
    expect(await db.aiNotes.get(note.id)).toBeUndefined()

    await restoreAiNote(note)
    expect(await db.aiNotes.get(note.id)).toEqual(note)
  })
})
