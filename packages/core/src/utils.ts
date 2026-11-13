import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export function randomId(bytes = 6) {
  return randomBytes(bytes).toString('base64url')
}

/** Masks a secret for display: `sk-abcdef123456` becomes `sk-…3456`. */
export function mask(secret: string | undefined | null) {
  if (!secret) return ''
  if (secret.length <= 8) return '••••'
  return `${secret.slice(0, 3)}…${secret.slice(-4)}`
}

export function isMasked(value: unknown) {
  return typeof value === 'string' && (value === '••••' || /^.{0,3}….{4}$/.test(value))
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

const writeQueues = new Map<string, Promise<void>>()

/**
 * Writes JSON through a temp file and a rename, so a crash never leaves a half-written file.
 * Writes to the same path are serialized.
 */
export function writeJsonAtomic(path: string, value: unknown) {
  return writeTextAtomic(path, () => JSON.stringify(value, null, 2) + '\n')
}

/**
 * Writes a text file through a temp file and a rename. Writes to the same path are serialized;
 * a function is called when the write's turn comes, so it can build on what the last write left.
 */
export function writeTextAtomic(path: string, text: string | (() => string | Promise<string>), options: { mode?: number } = {}) {
  const previous = writeQueues.get(path) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(async () => {
    const content = typeof text === 'function' ? await text() : text
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${randomId(4)}.tmp`
    await writeFile(temp, content, { encoding: 'utf8', mode: options.mode })
    await renameWithRetry(temp, path)
  })
  writeQueues.set(path, task)
  task.finally(() => {
    if (writeQueues.get(path) === task) writeQueues.delete(path)
  }).catch(() => {})
  return task
}

// Windows can briefly lock a file (antivirus, indexer); retry the rename a few times.
async function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (error: any) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) {
        await rm(from, { force: true })
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt))
    }
  }
}

export function localize(text: string | Record<string, string> | undefined, locale = 'en') {
  if (!text) return ''
  if (typeof text === 'string') return text
  return text[locale] ?? text.en ?? Object.values(text)[0] ?? ''
}

export interface FieldText {
  title?: string
  description?: string
  /** Labels of an enum's values, by value. */
  options?: Record<string, string>
}

export interface FieldDisplay {
  /** English labels of an enum's values, by value; translations go in `translations[locale].options`. */
  options?: Record<string, string>
  /**
   * How compact forms (the flow editor) show a field: for booleans a checkbox (default) or a
   * switch, for settings that change behavior; otherwise the name of an editor the dashboard
   * provides, such as `commandArgs` (a command's argument list), `people` (users or groups) or
   * `json` (JSON text that may hold references, checked as it is typed).
   */
  widget?: 'checkbox' | 'switch' | 'commandArgs' | 'people' | 'prompt' | 'message' | 'json'
  /** Compact forms fold descriptions into a hint icon; `inline` keeps this one visible. */
  hint?: 'inline'
  /**
   * A read action that lists the values a text field can take, as `{ value, label }[]`, such as
   * `personas.choices`. Forms show a searchable select that still accepts other text.
   */
  choices?: string
}

/**
 * Metadata for a config field, shown by dashboard forms: an English title and description,
 * plus translations keyed by locale. Use with zod's `.meta()`.
 */
export function field(title: string, description?: string, translations: Record<string, FieldText> = {}, display: FieldDisplay = {}) {
  return {
    title,
    ...(description ? { description } : {}),
    'x-i18n': translations,
    ...(display.options ? { 'x-options': display.options } : {}),
    ...(display.widget ? { 'x-widget': display.widget } : {}),
    ...(display.hint ? { 'x-hint': display.hint } : {}),
    ...(display.choices ? { 'x-choices': display.choices } : {}),
  }
}

/** Source category of a log line, for quick filters in the dashboard. */
export const LOG_TAGS = ['message', 'plugin', 'bot', 'adapter', 'flow', 'provider', 'agent', 'system', 'other'] as const

export type LogTag = typeof LOG_TAGS[number]

const logTags: Record<string, LogTag> = {
  plugin: 'plugin',
  manager: 'plugin',
  'llm-chat': 'plugin',
  message: 'message',
  bot: 'bot',
  bots: 'bot',
  onebot: 'adapter',
  flow: 'flow',
  flows: 'flow',
  provider: 'provider',
  providers: 'provider',
  llm: 'provider',
  agent: 'agent',
  app: 'system',
  console: 'system',
  server: 'system',
  storage: 'system',
}

/** The tag of a logger name; `provider:openai` and `provider` share one. */
export function logTag(name: string): LogTag {
  return logTags[name.split(':')[0]] ?? 'other'
}
