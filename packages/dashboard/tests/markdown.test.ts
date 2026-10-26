import { describe, expect, it } from 'vitest'
import { renderSegments } from '../src/components/agent/markdown'

const fence = '```'

describe('Agent reply rendering', () => {
  it('renders Markdown and keeps dashboard links in the app', () => {
    const [segment] = renderSegments('**Bold** and a [page](/bots) and [docs](https://example.com)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(segment.kind).toBe('html')
    const html = (segment as { html: string }).html
    expect(html).toContain('<strong>Bold</strong>')
    expect(html).toContain('<a href="/bots">page</a>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('<table>')
  })

  it('does not pass raw HTML through', () => {
    const [segment] = renderSegments('<img src=x onerror=alert(1)>')
    expect((segment as { html: string }).html).not.toContain('<img')
  })

  it('splits code, cards, steps and diagrams into their own blocks', () => {
    const text = [
      'Here you go:',
      `${fence}json\n{ "a": 1 }\n${fence}`,
      `${fence}mushin-card\n{ "title": "Bot", "status": "ok", "fields": [{ "label": "QQ", "value": 1 }], "actions": [{ "label": "Open", "path": "/bots" }, { "label": "Bad", "path": "https://evil" }] }\n${fence}`,
      `${fence}mushin-steps\n[{ "text": "one", "done": true }, "two"]\n${fence}`,
      `${fence}mermaid\nflowchart LR\n  A --> B\n${fence}`,
      'Done.',
    ].join('\n\n')
    const segments = renderSegments(text)
    expect(segments.map((segment) => segment.kind)).toEqual(['html', 'code', 'card', 'steps', 'mermaid', 'html'])
    expect(segments[1]).toMatchObject({ lang: 'json', code: '{ "a": 1 }' })
    expect((segments[1] as { html: string }).html).toContain('hljs-')
    expect(segments[2]).toEqual({ kind: 'card', card: { title: 'Bot', status: 'ok', fields: [{ label: 'QQ', value: 1 }], actions: [{ label: 'Open', path: '/bots' }] } })
    expect(segments[3]).toEqual({ kind: 'steps', steps: [{ text: 'one', done: true }, { text: 'two' }] })
    expect(segments[4]).toEqual({ kind: 'mermaid', code: 'flowchart LR\n  A --> B' })
  })

  it('shows a structured block that is still streaming as plain text', () => {
    const segments = renderSegments(`${fence}mushin-card\n{ "title": "Bo`)
    expect(segments).toEqual([{ kind: 'raw', lang: 'mushin-card', code: '{ "title": "Bo' }])
  })
})
