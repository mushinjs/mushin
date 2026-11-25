/**
 * Plugin settings on the Plugins page: a form worked out from a config that has no schema, where a JSON text is
 * wrong, which fields differ from their defaults, and a short masked preview. Pure functions, tested on their own.
 */
import type { JsonSchema } from '../types'

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** A field for one value: text, number, switch, list of words, a group of fields, or else a small JSON box. */
export function inferField(value: unknown): JsonSchema {
  if (typeof value === 'string') return { type: 'string' }
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' }
  if (typeof value === 'boolean') return { type: 'boolean' }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return { type: 'array', items: { type: 'string' } }
  if (isPlainObject(value) && Object.keys(value).length) return inferSchema(value)
  // Anything else (null, mixed lists, lists of objects, an empty object) is edited as JSON.
  return {}
}

/** A form for a config whose plugin has no schema, from the values it has now. */
export function inferSchema(config: Record<string, unknown> | undefined): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  for (const [key, value] of Object.entries(config ?? {})) properties[key] = inferField(value)
  return { type: 'object', properties }
}

export interface JsonProblem {
  message: string
  line?: number
  column?: number
}

/** Line and column (from 1) of a character offset. */
export function positionOf(text: string, offset: number) {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)))
  const lines = before.split('\n')
  return { line: lines.length, column: lines[lines.length - 1].length + 1 }
}

/**
 * The offset where a text stops being JSON, found by walking it, as engines differ in whether their errors say
 * where (V8's no longer do). Only called after JSON.parse failed.
 */
export function jsonErrorOffset(text: string): number {
  let at = 0
  const fail = (): never => {
    throw at
  }
  const space = () => {
    while (at < text.length && ' \t\n\r'.includes(text[at])) at++
  }
  const word = (literal: string) => {
    for (const char of literal) if (text[at++] !== char) { at--; fail() }
  }
  const string = () => {
    at++
    while (at < text.length && text[at] !== '"') {
      if (text[at] < ' ') fail()
      at += text[at] === '\\' ? 2 : 1
    }
    if (at >= text.length) fail()
    at++
  }
  const number = () => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(at))
    if (!match) fail()
    at += match![0].length
  }
  const value = (): void => {
    space()
    const char = text[at]
    if (char === '{') return list('}', () => {
      space()
      if (text[at] !== '"') fail()
      string()
      space()
      if (text[at] !== ':') fail()
      at++
      value()
    })
    if (char === '[') return list(']', value)
    if (char === '"') return string()
    if (char === 't') return word('true')
    if (char === 'f') return word('false')
    if (char === 'n') return word('null')
    number()
  }
  const list = (close: string, item: () => void) => {
    at++
    space()
    if (text[at] === close) { at++; return }
    for (;;) {
      item()
      space()
      if (text[at] === ',') { at++; continue }
      if (text[at] === close) { at++; return }
      fail()
    }
  }
  try {
    value()
    space()
    return at < text.length ? at : text.length
  } catch (offset) {
    return Math.min(offset as number, text.length)
  }
}

/** Why a text is not a JSON object, and where; undefined when it is fine. An empty text is an empty object. */
export function jsonProblem(text: string): JsonProblem | undefined {
  let value: unknown
  try {
    value = JSON.parse(text.trim() ? text : '{}')
  } catch (error) {
    return { message: (error as Error).message, ...positionOf(text, jsonErrorOffset(text)) }
  }
  if (!isPlainObject(value)) return { message: 'not an object' }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Whether a field has a default and a value that is not it. An unset value takes the default. */
export function differsFromDefault(field: JsonSchema | undefined, value: unknown) {
  if (!field || field.default === undefined || value === undefined) return false
  return !same(value, field.default)
}

/** Top-level fields of a config that differ from their defaults in the schema. */
export function changedFields(schema: JsonSchema | undefined, config: Record<string, unknown> | undefined) {
  const properties: Record<string, JsonSchema> = schema?.properties ?? {}
  return Object.keys(properties).filter((key) => differsFromDefault(properties[key], config?.[key]))
}

/** A secret that was not masked yet: everything but an `${NAME}` reference to `.env`. */
const MASK = '••••••'
const isReference = (value: unknown) => typeof value === 'string' && /^\$\{[A-Z0-9_]+\}$/.test(value)

/** Fields to hide in previews: those the schema marks secret, and any whose name says it is one. */
export function isSecretField(key: string, field?: JsonSchema) {
  return field?.['x-secret'] === true || /(token|secret|password|passwd|api[-_]?key|private[-_]?key)$/i.test(key)
}

/** A few `key: value` lines of a config for a hover preview, with secrets masked and long values cut. */
export function configPreview(config: Record<string, unknown> | undefined, schema?: JsonSchema, limit = 8, width = 48) {
  const properties: Record<string, JsonSchema> = schema?.properties ?? {}
  const entries = Object.entries(config ?? {}).filter(([, value]) => value !== undefined)
  const lines = entries.slice(0, limit).map(([key, value]) => {
    let text: string
    if (isSecretField(key, properties[key]) && typeof value === 'string' && value && !isReference(value)) text = MASK
    else text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
    if (text.length > width) text = `${text.slice(0, width - 1)}…`
    return { key, value: text }
  })
  return { lines, more: Math.max(0, entries.length - limit) }
}
