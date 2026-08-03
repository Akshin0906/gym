import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CoachMessageBody } from './CoachMessageBody'

function render(text: string): string {
  return renderToStaticMarkup(createElement(CoachMessageBody, { text }))
}

describe('CoachMessageBody', () => {
  it('renders the Coach volume response as a responsive semantic table', () => {
    const html = render(`Assuming you complete Upper, Lower, Full Body, and Optional Arms:

| Muscle | Direct sets | Including secondary work |
|---|---:|---:|
| Chest | 5 | 5 |
| Back | 7 | 7 |
| Shoulders | 6 | 11 |`)

    expect(html).toContain('<table')
    expect(html).toContain('<thead>')
    expect(html).toContain('<th')
    expect(html).toContain('<td')
    expect(html).toContain('Muscle')
    expect(html).toContain('Including secondary work')
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="Scrollable table"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('overflow-x-auto')
    expect(html).not.toContain('|---')
    expect(html).not.toContain('| Chest |')
  })

  it('preserves conversational breaks and renders common Markdown', () => {
    const html = render(`First line
Second **important** line

- One
- Two with \`code\``)

    expect(html).toContain('First line<br/>\nSecond <strong>important</strong> line')
    expect(html).toContain('<ul')
    expect(html).toContain('<li')
    expect(html).toContain('<code')
  })

  it('keeps links safe and renders raw HTML as inert text without loading images', () => {
    const html = render(`<script>alert('unsafe')</script>

[Safe](https://example.com) [Unsafe](javascript:alert('unsafe'))

![Tracking pixel](https://tracker.example/pixel.gif)`)

    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;alert(&#x27;unsafe&#x27;)&lt;/script&gt;')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('tracker.example')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('(opens in a new tab)')
    expect(html).toContain('[Image: Tracking pixel]')
  })

  it('treats scheme-relative links as external', () => {
    const html = render('[External](//example.com/path)')

    expect(html).toContain('href="//example.com/path"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('(opens in a new tab)')
  })
})
