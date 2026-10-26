import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Actions, Context } from '@mushin/core'
import * as database from '../src'

declare module 'minato' {
  interface Tables {
    test_note: { id: number; title: string; score: number; done: boolean; data: { tags: string[] } | null }
  }
}

const dirs: string[] = []
const fibers: { dispose(): unknown }[] = []

async function setup(config: Partial<database.Config> = {}) {
  const baseDir = await mkdtemp(join(tmpdir(), 'mushin-database-'))
  dirs.push(baseDir)
  const ctx = new Context()
  ctx.baseDir = baseDir
  await ctx.plugin(Actions)
  fibers.push(ctx.plugin(database, { driver: 'sqlite', path: 'data/mushin.db', ...config }))
  const ready = new Promise<void>((resolve) => {
    ctx.inject(['model', 'database'], async (ctx) => {
      ctx.model.extend('test_note', { id: 'unsigned', title: 'string', score: 'integer', done: 'boolean', data: 'json' }, { autoInc: true })
      await ctx.database.create('test_note', { title: 'Buy milk', score: 3, done: false, data: { tags: ['home'] } })
      await ctx.database.create('test_note', { title: 'Write tests', score: 8, done: true, data: null })
      await ctx.database.create('test_note', { title: 'Buy bread', score: 5, done: false, data: null })
      resolve()
    })
  })
  await ready
  const call = <T = any>(name: string, input: unknown = {}) => ctx.actions.call(name, input) as Promise<T>
  return { ctx, baseDir, call }
}

afterEach(async () => {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe('database plugin', () => {
  it('stores tables in a SQLite file and lists them with columns and counts', async () => {
    const { baseDir, call } = await setup()
    expect((await stat(join(baseDir, 'data', 'mushin.db'))).size).toBeGreaterThan(0)
    expect(await call('database.status')).toMatchObject({ driver: 'sqlite', path: 'data/mushin.db', tables: 1 })
    const [table] = await call('database.tables')
    expect(table).toMatchObject({ name: 'test_note', group: 'test', primary: ['id'], count: 3 })
    expect(table.columns.map((column: any) => column.name)).toEqual(['id', 'title', 'score', 'done', 'data'])
  })

  it('pages, sorts and filters rows', async () => {
    const { call } = await setup()
    const page = await call('database.rows', { table: 'test_note', sort: { column: 'score', order: 'desc' }, limit: 2 })
    expect(page.total).toBe(3)
    expect(page.rows.map((row: any) => row.title)).toEqual(['Write tests', 'Buy bread'])
    const buy = await call('database.rows', { table: 'test_note', filter: { title: 'buy' } })
    expect(buy.total).toBe(2)
    expect((await call('database.rows', { table: 'test_note', filter: { score: '8', done: 'true' } })).rows).toMatchObject([{ title: 'Write tests' }])
    await expect(call('database.rows', { table: 'test_note', filter: { nope: 'x' } })).rejects.toThrow('no column')
    await expect(call('database.rows', { table: 'missing' })).rejects.toThrow('No table')
  })

  it('updates and removes rows by primary key, refusing key changes', async () => {
    const { call } = await setup()
    expect(await call('database.update', { table: 'test_note', key: { id: 1 }, data: { score: 10, data: { tags: [] } } })).toEqual({ updated: 1 })
    expect((await call('database.rows', { table: 'test_note', filter: { id: '1' } })).rows[0]).toMatchObject({ score: 10, data: { tags: [] } })
    await expect(call('database.update', { table: 'test_note', key: { id: 1 }, data: { id: 5 } })).rejects.toThrow('primary key')
    await expect(call('database.update', { table: 'test_note', key: { id: 99 }, data: { score: 1 } })).rejects.toThrow('No row')
    expect(await call('database.remove', { table: 'test_note', keys: [{ id: 1 }, { id: 2 }] })).toEqual({ removed: 2 })
    expect((await call('database.rows', { table: 'test_note' })).total).toBe(1)
  })

  it('exports CSV and JSON', async () => {
    const { call } = await setup()
    const csv = await call('database.export', { table: 'test_note', filter: { title: 'milk' } })
    expect(csv.filename).toBe('test_note.csv')
    expect(csv.content).toBe('﻿id,title,score,done,data\r\n1,Buy milk,3,false,"{""tags"":[""home""]}"\r\n')
    const json = await call('database.export', { table: 'test_note', format: 'json' })
    expect(JSON.parse(json.content)).toHaveLength(3)
  })

  it('backs up the SQLite file while running', async () => {
    const { baseDir, call } = await setup()
    const backup = await call('database.backup')
    expect(backup.path).toMatch(/^data\/backups\/mushin-\d{8}-\d{6}\.db$/)
    expect((await stat(join(baseDir, backup.path))).size).toBeGreaterThan(0)
  })

  it('runs in memory without a file', async () => {
    const { baseDir, call } = await setup({ driver: 'memory' })
    expect(await call('database.status')).toEqual({ driver: 'memory', tables: 1 })
    expect((await call('database.rows', { table: 'test_note', filter: { title: 'bread' } })).total).toBe(1)
    await expect(stat(join(baseDir, 'data', 'mushin.db'))).rejects.toThrow()
    await expect(call('database.backup')).rejects.toThrow('SQLite')
  })
})
