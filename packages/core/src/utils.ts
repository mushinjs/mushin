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
  const previous = writeQueues.get(path) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${randomId(4)}.tmp`
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
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
}

/**
 * Metadata for a config field, shown by dashboard forms: an English title and description,
 * plus translations keyed by locale. Use with zod's `.meta()`.
 */
export function field(title: string, description?: string, translations: Record<string, FieldText> = {}) {
  return { title, ...(description ? { description } : {}), 'x-i18n': translations }
}

/** Source category of a log line, for quick filters in the dashboard. */
export const LOG_TAGS = ['plugin', 'bot', 'adapter', 'flow', 'provider', 'agent', 'system', 'other'] as const

export type LogTag = typeof LOG_TAGS[number]

const logTags: Record<string, LogTag> = {
  plugin: 'plugin',
  manager: 'plugin',
  'llm-chat': 'plugin',
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
