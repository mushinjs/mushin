import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import ini from 'highlight.js/lib/languages/ini'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import MarkdownIt from 'markdown-it'

// The languages the Agent is likely to write: configs, scripts and snippets for plugins.
for (const [name, language] of Object.entries({ bash, css, ini, javascript, json, markdown, python, shell, sql, typescript, xml, yaml })) {
  hljs.registerLanguage(name, language)
}
hljs.registerAliases(['sh', 'zsh'], { languageName: 'bash' })
hljs.registerAliases(['toml'], { languageName: 'ini' })

/** A piece of an Agent reply: Markdown as HTML, or a block the dashboard draws itself. */
export type Segment =
  | { kind: 'html'; html: string }
  | { kind: 'code'; lang: string; code: string; html: string }
  | { kind: 'mermaid'; code: string }
  | { kind: 'card'; card: MushinCard }
  | { kind: 'steps'; steps: MushinStep[] }
  /** A structured block whose JSON is not complete yet (still streaming) or not valid. */
  | { kind: 'raw'; lang: string; code: string }

export interface MushinCard {
  title: string
  subtitle?: string
  status?: 'ok' | 'warning' | 'error' | 'info'
  fields?: { label: string; value: string | number | boolean }[]
  actions?: { label: string; path: string }[]
}

export interface MushinStep {
  text: string
  done?: boolean
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

// Links open in a new tab, except dashboard paths, which the message component routes itself.
const defaultLink = md.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const href = String(tokens[index].attrGet('href') ?? '')
  if (!href.startsWith('/')) {
    tokens[index].attrSet('target', '_blank')
    tokens[index].attrSet('rel', 'noopener noreferrer')
  }
  return defaultLink(tokens, index, options, env, self)
}

export function highlightCode(code: string, lang: string) {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  } catch {}
  return md.utils.escapeHtml(code)
}

md.set({ highlight: (code, lang) => highlightCode(code, lang.toLowerCase()) })

let diagramSeq = 0

/** A document-wide unique id for a Mermaid diagram; its styles are scoped by this id. */
export function nextDiagramId() {
  return `mushin-mermaid-${++diagramSeq}`
}

function parseJson(code: string) {
  try {
    return JSON.parse(code)
  } catch {
    return undefined
  }
}

function asCard(value: any): MushinCard | undefined {
  if (!value || typeof value !== 'object' || typeof value.title !== 'string') return
  return {
    title: value.title,
    subtitle: typeof value.subtitle === 'string' ? value.subtitle : undefined,
    status: ['ok', 'warning', 'error', 'info'].includes(value.status) ? value.status : undefined,
    fields: Array.isArray(value.fields) ? value.fields.filter((field: any) => field && typeof field.label === 'string').map((field: any) => ({ label: field.label, value: typeof field.value === 'object' ? JSON.stringify(field.value) : field.value })) : undefined,
    actions: Array.isArray(value.actions) ? value.actions.filter((action: any) => typeof action?.label === 'string' && typeof action?.path === 'string' && action.path.startsWith('/')) : undefined,
  }
}

function asSteps(value: any): MushinStep[] | undefined {
  const list = Array.isArray(value) ? value : Array.isArray(value?.steps) ? value.steps : undefined
  if (!list) return
  return list.map((step: any) => (typeof step === 'string' ? { text: step } : { text: String(step?.text ?? ''), done: !!step?.done }))
}

/** Splits an Agent reply into Markdown HTML and the blocks the dashboard draws as components. */
export function renderSegments(text: string): Segment[] {
  const tokens = md.parse(text, {})
  const segments: Segment[] = []
  let start = 0
  const flush = (end: number) => {
    if (end > start) {
      const html = md.renderer.render(tokens.slice(start, end), md.options, {})
      if (html.trim()) segments.push({ kind: 'html', html })
    }
  }
  tokens.forEach((token, index) => {
    if (token.type !== 'fence' || token.level !== 0) return
    flush(index)
    start = index + 1
    const lang = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    const code = token.content.replace(/\n$/, '')
    if (lang === 'mermaid') segments.push({ kind: 'mermaid', code })
    else if (lang === 'mushin-card') {
      const card = asCard(parseJson(code))
      segments.push(card ? { kind: 'card', card } : { kind: 'raw', lang, code })
    } else if (lang === 'mushin-steps') {
      const steps = asSteps(parseJson(code))
      segments.push(steps ? { kind: 'steps', steps } : { kind: 'raw', lang, code })
    } else {
      segments.push({ kind: 'code', lang, code, html: highlightCode(code, lang) })
    }
  })
  flush(tokens.length)
  return segments
}
