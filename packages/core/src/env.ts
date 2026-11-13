import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isMasked, writeTextAtomic } from './utils'

/**
 * Secrets live in the instance's `.env` file. Configuration refers to them as `${NAME}`: the whole
 * value of a field, so `mushin.config.json`, `data/` and anything shown to the Agent hold only names.
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

/** The variable a value refers to: `${DEEPSEEK_API_KEY}` gives `DEEPSEEK_API_KEY`. */
export function envReference(value: unknown) {
  return typeof value === 'string' ? REFERENCE.exec(value)?.[1] : undefined
}

export function isEnvName(name: string) {
  return NAME.test(name)
}

/** A variable name made from words, such as a provider's name and a key: `DeepSeek`, `apiKey` gives `DEEPSEEK_API_KEY`. */
export function envName(...parts: string[]) {
  const words = parts
    // A camelCase key (`apiKey`) is split into words; a name such as `DeepSeek` stays one word.
    .map((part) => (/^[a-z]/.test(part) ? part.replace(/([a-z0-9])([A-Z])/g, '$1_$2') : part).normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_'))
    .join('_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase()
  return /^[A-Z_]/.test(words) ? words : `MUSHIN_${words}`
}

/** Parses `.env` text: `NAME=value` lines, `#` comments, single or double quotes, an optional `export`. */
export function parseEnv(text: string) {
  const values: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const [, name, rest] = match as unknown as [string, string, string]
    let value: string
    if (rest.startsWith('"')) {
      const end = closingQuote(rest)
      value = rest.slice(1, end).replace(/\\([nr"\\])/g, (_, char: string) => ({ n: '\n', r: '\r' })[char as 'n'] ?? char)
    } else if (rest.startsWith('\'')) {
      const end = rest.indexOf('\'', 1)
      value = rest.slice(1, end < 0 ? undefined : end)
    } else {
      value = rest.replace(/\s+#.*$/, '').trim()
    }
    values[name] = value
  }
  return values
}

function closingQuote(text: string) {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '"') return i
  }
  return text.length
}

function serialize(value: string) {
  if (/^[\w.\-+/=:@~,%]*$/.test(value)) return value
  return `"${value.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
}

/** `.env` text with one variable set (or removed, for `undefined`), keeping every other line as it was. */
export function updateEnvText(text: string, name: string, value: string | undefined) {
  if (!isEnvName(name)) throw new Error(`"${name}" is not a valid environment variable name`)
  const lines = text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : []
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`)
  const at = lines.findIndex((line) => pattern.test(line))
  const next = lines.filter((line, index) => index === at || !pattern.test(line))
  const index = next.findIndex((line) => pattern.test(line))
  if (value === undefined) {
    if (index >= 0) next.splice(index, 1)
  } else if (index >= 0) {
    next[index] = `${name}=${serialize(value)}`
  } else {
    next.push(`${name}=${serialize(value)}`)
  }
  return next.length ? next.join('\n') + '\n' : ''
}

/** Names that some `.env` file put into `process.env`, so a later load may replace them. Everything else came from the shell. */
const loaded = new Set<string>()

/**
 * One instance's `.env` file. Loading it copies its variables into `process.env`, where plugins,
 * MCP servers and terminal commands find them; a variable already set by the shell wins.
 */
export class EnvFile {
  private values: Record<string, string> = {}

  constructor(readonly path: string) {}

  /** Reads the file and copies its variables into `process.env`. A missing file is an empty one. */
  loadSync() {
    let text = ''
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
    this.apply(parseEnv(text))
    return this
  }

  /** Reads the file again, for changes made by another process such as `mushin token reset`. */
  async reload() {
    const text = await readFile(this.path, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return ''
      throw error
    })
    this.apply(parseEnv(text))
  }

  private apply(values: Record<string, string>) {
    this.values = values
    for (const [name, value] of Object.entries(values)) {
      if (process.env[name] === undefined || loaded.has(name)) {
        process.env[name] = value
        loaded.add(name)
      }
    }
  }

  /** True when the shell set the variable, so it overrides the file. */
  fromShell(name: string) {
    return process.env[name] !== undefined && !loaded.has(name)
  }

  /** The value of a variable: the shell's, else this file's. */
  get(name: string): string | undefined {
    return this.fromShell(name) ? process.env[name] : this.values[name]
  }

  /** Names this file defines. */
  names() {
    return Object.keys(this.values)
  }

  /** The value a field means: a `${NAME}` reference is looked up, anything else is itself. A missing variable is ''. */
  resolve<T>(value: T): T | string {
    const name = envReference(value)
    return name === undefined ? value : this.get(name) ?? ''
  }

  /** Sets a variable in the file and in `process.env`, unless the shell set it. */
  async set(name: string, value: string) {
    await this.write(name, value)
  }

  async delete(name: string) {
    await this.write(name, undefined)
  }

  /**
   * Puts a secret into the file under a name derived from `preferred` and returns its `${NAME}` reference.
   * A name already holding another value is not reused: `_2`, `_3` and so on are tried.
   */
  async store(preferred: string, value: string) {
    await this.reload()
    let name = preferred
    for (let n = 2; this.values[name] !== undefined && this.values[name] !== value; n++) name = `${preferred}_${n}`
    if (this.values[name] !== value) await this.set(name, value)
    return `\${${name}}`
  }

  /**
   * Moves the plain values of `keys` in a config into the file and returns the config with `${NAME}`
   * references in their place. A value that replaces a reference in `previous` takes over that name;
   * other names are made from `name` and the key. Empty values, references and masked values
   * (`sk-…1234`, which the caller replaces) are left as they are.
   */
  async moveIn<T extends Record<string, any>>(config: T, options: { keys: Iterable<string>; name: string[]; previous?: Record<string, any> }): Promise<{ config: T; moved: string[] }> {
    const next: Record<string, any> = { ...config }
    const moved: string[] = []
    for (const key of options.keys) {
      const value = next[key]
      if (typeof value !== 'string' || !value || envReference(value) !== undefined || isMasked(value)) continue
      const taken = envReference(options.previous?.[key])
      if (taken !== undefined && !this.fromShell(taken)) {
        await this.set(taken, value)
        next[key] = `\${${taken}}`
      } else {
        next[key] = await this.store(envName(...options.name, key), value)
      }
      moved.push(key)
    }
    return { config: next as T, moved }
  }

  /** A copy of a config with the `${NAME}` references of `keys` (all keys when omitted) replaced by their values. */
  resolveAll<T extends Record<string, any>>(config: T, keys?: Iterable<string>): T {
    const next: Record<string, any> = { ...config }
    for (const key of keys ?? Object.keys(next)) {
      if (key in next) next[key] = this.resolve(next[key])
    }
    return next as T
  }

  private async write(name: string, value: string | undefined) {
    let values: Record<string, string> = {}
    await writeTextAtomic(this.path, async () => {
      const text = await readFile(this.path, 'utf8').catch(() => '')
      const next = updateEnvText(text, name, value)
      values = parseEnv(next)
      return next
    }, { mode: 0o600 })
    this.values = values
    if (!this.fromShell(name)) {
      if (value === undefined) {
        delete process.env[name]
        loaded.delete(name)
      } else {
        process.env[name] = value
        loaded.add(name)
      }
    }
  }
}

/**
 * Replaces `${NAME}` values anywhere in a JSON-like value with the variables' values from `process.env`,
 * for plugin settings in `mushin.config.json`. The input is not changed.
 */
export function resolveEnvReferences<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  const name = envReference(value)
  if (name !== undefined) return (env[name] ?? '') as T
  if (Array.isArray(value)) return value.map((item) => resolveEnvReferences(item, env)) as T
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveEnvReferences(item, env)])) as T
  }
  return value
}
