import type { LocalizedText, Segment } from './types'

export function localize(text: LocalizedText | undefined, locale: string) {
  if (!text) return ''
  if (typeof text === 'string') return text
  return text[locale] ?? text[locale.split('-')[0]] ?? text.en ?? Object.values(text)[0] ?? ''
}

export function segmentsText(segments: Segment[]) {
  return segments.map((s) => {
    if (s.type === 'text') return s.data.text ?? ''
    if (s.type === 'at') return `@${s.data.name ?? s.data.qq} `
    if (s.type === 'reply') return ''
    return `[${s.type}]`
  }).join('')
}

export function formatTime(ts: number) {
  const date = new Date(ts)
  const now = new Date()
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === now.toDateString()) return time
  return `${date.toLocaleDateString()} ${time}`
}

export function pretty(value: unknown) {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const acronyms = new Set(['url', 'api', 'id', 'llm', 'qq', 'ws', 'http'])

/** Turns a config key into a label: `baseURL` becomes "Base URL", `apiKey` becomes "API key". */
export function humanize(key: string) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => (acronyms.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()))
  if (!words.length) return key
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1)
  return words.join(' ')
}

/** A size such as "12.3 KB". */
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/** Deep copy for editing forms without mutating store data. */
export function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

/** Saves a value as a JSON file through the browser. */
export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
