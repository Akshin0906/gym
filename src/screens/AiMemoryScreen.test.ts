import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const headerSpy = vi.hoisted(() =>
  vi.fn((_props: { title: string; back?: string | boolean }) => null),
)

vi.mock('../components/Header', () => ({
  Header: headerSpy,
}))
vi.mock('../lib/useUnsavedChangesWarning', () => ({
  useUnsavedChangesWarning: vi.fn(),
}))

import { AiMemoryScreen } from './AiMemoryScreen'

describe('AiMemoryScreen navigation', () => {
  beforeEach(() => headerSpy.mockClear())

  it('pops back to the existing Settings entry instead of pushing another one', () => {
    renderToStaticMarkup(createElement(AiMemoryScreen))

    const props = headerSpy.mock.calls[0]?.[0]
    expect(props).toMatchObject({ title: 'AI Memory', back: true })
  })
})
