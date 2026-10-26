import { mkdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Context, field, MushinError, z } from '@mushin/core'
import MemoryDriver from '@minatojs/driver-memory'
import SQLiteDriver from '@minatojs/driver-sqlite'
import { $, Database, type Field, type Model } from 'minato'

export type { Database, Driver, Field, Model, Query, Selection, Tables, Types } from 'minato'

export const name = 'database'
export const inject = ['actions']

export const Config = z.object({
  driver: z.enum(['sqlite', 'memory']).default('sqlite').meta(field('Driver', 'sqlite keeps everything in one file; memory loses the data when Mushin.js stops (for trying things out)', {
    'zh-CN': { title: '驱动', description: 'sqlite 把数据存在一个文件里；memory 在 Mushin.js 停止时丢失数据（用于试用）' },
  })),
  path: z.string().trim().min(1).default('data/mushin.db').meta(field('Database file', 'For SQLite; relative to the instance directory', {
    'zh-CN': { title: '数据库文件', description: 'SQLite 使用；相对于实例目录' },
  })),
})

export type Config = z.infer<typeof Config>

// The drivers inject a `logger` service that Cordis 4 keeps as a built-in property instead, so
// they would wait for it forever. They only call `ctx.logger?.info()` and the like, which the
// built-in logger answers, so only the model is injected here.
class SQLite extends (SQLiteDriver as any) {
  static inject = ['model']
}

class Memory extends (MemoryDriver as any) {
  static inject = ['model']
}

const PAGE_LIMIT = 500
const EXPORT_LIMIT = 100_000

export interface ColumnInfo {
  name: string
  type: string
  primary: boolean
  nullable: boolean
}

export interface TableInfo {
  name: string
  /** The part of the name before the first underscore, which by convention names the plugin. */
  group: string
  primary: string[]
  columns: ColumnInfo[]
  count: number
}

/** Rows as JSON can carry them: dates as ISO text, binary as a note, big integers as text. */
function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return `<binary ${(value as ArrayBuffer).byteLength} bytes>`
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
  return value
}

function csvCell(value: unknown) {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]) {
  return [columns.map(csvCell).join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\r\n') + '\r\n'
}

const numeric = new Set(['integer', 'unsigned', 'float', 'double', 'decimal', 'bigint'])
const textual = new Set(['char', 'string', 'text'])

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const Filter = z.record(z.string(), z.string()).optional().describe('Column → text. Text columns match when they contain the text; numbers and booleans must be equal.')

/**
 * The database service (`ctx.database`, from minato) and the actions behind the Database page.
 * Plugins declare tables with `ctx.model.extend()` in a context that injects both `model` and
 * `database`; by convention a table's name starts with the plugin's name and an underscore.
 */
export function apply(ctx: Context, config: Config) {
  const baseDir = ctx.baseDir ?? process.cwd()
  const file = config.driver === 'sqlite' ? (isAbsolute(config.path) ? config.path : resolve(baseDir, config.path)) : undefined

  ctx.plugin(Database)
  if (file) {
    ctx.inject(['model'], async (ctx) => {
      await mkdir(dirname(file), { recursive: true })
      // The driver resolves the path against `ctx.baseUrl`; a file URL resolves to itself.
      ctx.plugin(SQLite as any, { path: pathToFileURL(file).href })
    })
  } else {
    ctx.plugin(Memory as any, {})
  }

  ctx.inject(['model', 'database'], (ctx) => {
    const tableOf = (name: string): Model => {
      const model = ctx.model.tables[name]
      if (!model) throw new MushinError('not_found', `No table named "${name}"`)
      return model
    }
    const primaryOf = (model: Model) => (Array.isArray(model.primary) ? model.primary : [model.primary]) as string[]
    const columnsOf = (model: Model): ColumnInfo[] => {
      const primary = primaryOf(model)
      return Object.entries(model.fields as Record<string, Field | undefined>)
        .filter(([, item]) => item && !item.deprecated && !item.relation && !item.expr)
        .map(([name, item]) => ({ name, type: String(item!.deftype ?? item!.type?.type ?? ''), primary: primary.includes(name), nullable: !!item!.nullable }))
    }
    const queryOf = (model: Model, filter: Record<string, string> | undefined) => {
      const query: Record<string, unknown> = {}
      const columns = new Map(columnsOf(model).map((column) => [column.name, column]))
      for (const [name, text] of Object.entries(filter ?? {})) {
        if (text === '') continue
        const column = columns.get(name)
        if (!column) throw new MushinError('invalid_input', `Table "${model.name}" has no column "${name}"`)
        if (numeric.has(column.type)) {
          const value = Number(text)
          if (!Number.isFinite(value)) throw new MushinError('invalid_input', `"${text}" is not a number`)
          query[name] = value
        } else if (column.type === 'boolean') {
          query[name] = text === 'true' || text === '1'
        } else if (textual.has(column.type)) {
          query[name] = { $regex: new RegExp(escapeRegExp(text), 'i') }
        } else {
          throw new MushinError('invalid_input', `Column "${name}" (${column.type}) cannot be filtered`)
        }
      }
      return query
    }
    const keyQuery = (model: Model, key: Record<string, unknown>) => {
      const query: Record<string, unknown> = {}
      for (const name of primaryOf(model)) {
        if (!(name in key)) throw new MushinError('invalid_input', `The key needs "${name}"`)
        query[name] = key[name]
      }
      return query
    }

    const status = async () => {
      const size = file ? (await stat(file).catch(() => undefined))?.size ?? 0 : undefined
      return {
        driver: config.driver,
        ...(file ? { path: relative(baseDir, file).split(sep).join('/'), size } : {}),
        tables: Object.keys(ctx.model.tables).length,
      }
    }

    const countRows = async (table: string, model: Model, query: Record<string, unknown>) => {
      const key = primaryOf(model)[0] ?? columnsOf(model)[0]?.name
      return Number(await ctx.database.select(table as any, query as any).execute((row: any) => $.count(row[key]))) || 0
    }

    const tables = async (): Promise<TableInfo[]> => {
      const list: TableInfo[] = []
      for (const [name, model] of Object.entries(ctx.model.tables)) {
        const count = await countRows(name, model, {})
        list.push({ name, group: name.split('_')[0], primary: primaryOf(model), columns: columnsOf(model), count: Number(count) || 0 })
      }
      return list.sort((a, b) => a.name.localeCompare(b.name))
    }

    ctx.actions.define({
      name: 'database.status',
      description: 'Which database driver runs, the SQLite file and its size, and how many tables exist.',
      risk: 'read',
      input: z.object({}),
      handler: status,
    })

    ctx.actions.define({
      name: 'database.tables',
      description: 'Every table in the database with its columns, primary key and row count. Tables are grouped by the plugin name before the first underscore, e.g. flows_var.',
      risk: 'read',
      input: z.object({}),
      handler: tables,
    })

    ctx.actions.define({
      name: 'database.rows',
      description: 'A page of rows from one table, read-only: optional sort and filters. Returns the rows and the total that match.',
      risk: 'read',
      input: z.object({
        table: z.string(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(PAGE_LIMIT).default(50),
        sort: z.object({ column: z.string(), order: z.enum(['asc', 'desc']).default('asc') }).optional(),
        filter: Filter,
      }),
      handler: async ({ table, offset, limit, sort, filter }) => {
        const model = tableOf(table)
        const query = queryOf(model, filter)
        let selection = ctx.database.select(table as any, query as any)
        if (sort) {
          if (!columnsOf(model).some((column) => column.name === sort.column)) throw new MushinError('invalid_input', `Table "${table}" has no column "${sort.column}"`)
          selection = selection.orderBy(sort.column as any, sort.order)
        }
        const [rows, total] = await Promise.all([
          selection.offset(offset).limit(limit).execute(),
          countRows(table, model, query),
        ])
        return { rows: rows.map((row) => plain(row)), total }
      },
    })

    ctx.actions.define({
      name: 'database.update',
      description: 'Changes columns of one row, found by its primary key. Writes to plugin data directly, so the change takes effect without any checks the plugin would make.',
      risk: 'dangerous',
      input: z.object({ table: z.string(), key: z.record(z.string(), z.unknown()), data: z.record(z.string(), z.unknown()) }),
      handler: async ({ table, key, data }) => {
        const model = tableOf(table)
        const columns = new Set(columnsOf(model).map((column) => column.name))
        for (const name of Object.keys(data)) {
          if (!columns.has(name)) throw new MushinError('invalid_input', `Table "${table}" has no column "${name}"`)
          if (primaryOf(model).includes(name)) throw new MushinError('invalid_input', `"${name}" is part of the primary key and cannot be changed`)
        }
        const result = await ctx.database.set(table as any, keyQuery(model, key) as any, data as any)
        if (!result.matched) throw new MushinError('not_found', 'No row has that key')
        return { updated: result.modified ?? result.matched }
      },
    })

    ctx.actions.define({
      name: 'database.remove',
      description: 'Deletes rows from a table by their primary keys. Cannot be undone; make a backup first if unsure.',
      risk: 'dangerous',
      input: z.object({ table: z.string(), keys: z.array(z.record(z.string(), z.unknown())).min(1).max(PAGE_LIMIT) }),
      handler: async ({ table, keys }) => {
        const model = tableOf(table)
        let removed = 0
        for (const key of keys) removed += (await ctx.database.remove(table as any, keyQuery(model, key) as any)).removed ?? 0
        return { removed }
      },
    })

    ctx.actions.define({
      name: 'database.export',
      description: 'The rows of a table (matching optional filters) as CSV or JSON text, for downloading.',
      risk: 'read',
      input: z.object({ table: z.string(), format: z.enum(['csv', 'json']).default('csv'), filter: Filter }),
      handler: async ({ table, format, filter }) => {
        const model = tableOf(table)
        const rows = (await ctx.database.select(table as any, queryOf(model, filter) as any).limit(EXPORT_LIMIT).execute()).map((row) => plain(row) as Record<string, unknown>)
        const columns = columnsOf(model).map((column) => column.name)
        const content = format === 'csv' ? '﻿' + toCsv(columns, rows) : JSON.stringify(rows, null, 2)
        return { filename: `${table}.${format}`, content, rows: rows.length, truncated: rows.length >= EXPORT_LIMIT }
      },
    })

    ctx.actions.define({
      name: 'database.backup',
      description: 'Copies the SQLite database to data/backups/ under a dated name while Mushin.js keeps running. Returns the backup\'s path.',
      risk: 'write',
      input: z.object({}),
      handler: async () => {
        const driver = (ctx.database as any)._driver
        if (!file || !driver?.db) throw new MushinError('unavailable', 'Backups need the SQLite driver')
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
        const target = join(dirname(file), 'backups', `mushin-${stamp}.db`)
        await mkdir(dirname(target), { recursive: true })
        driver.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
        const size = (await stat(target)).size
        return { path: relative(baseDir, target).split(sep).join('/'), size }
      },
    })
  })
}
