import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@mushin/core'
import { Storage } from '../src'

const dirs: string[] = []

async function setup() {
  const baseDir = await mkdtemp(join(tmpdir(), 'mushin-storage-'))
  dirs.push(baseDir)
  const ctx = new Context()
  ctx.baseDir = baseDir
  await ctx.plugin(Storage, { dir: 'data' })
  return { ctx, baseDir }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('storage', () => {
  it('stores, lists and deletes JSON documents', async () => {
    const { ctx, baseDir } = await setup()
    await ctx.storage.set('agent/one', { a: 1 })
    await ctx.storage.set('agent/two', { b: 2 })
    expect(await ctx.storage.get('agent/one')).toEqual({ a: 1 })
    expect(await ctx.storage.list('agent')).toEqual(['agent/one', 'agent/two'])
    expect(JSON.parse(await readFile(join(baseDir, 'data', 'agent', 'one.json'), 'utf8'))).toEqual({ a: 1 })
    await ctx.storage.delete('agent/one')
    expect(await ctx.storage.get('agent/one')).toBeUndefined()
  })

  it('keeps the last write when writes overlap', async () => {
    const { ctx } = await setup()
    await Promise.all(Array.from({ length: 20 }, (_, i) => ctx.storage.set('counter', { i })))
    expect(await ctx.storage.get('counter')).toEqual({ i: 19 })
  })

  it('appends JSON lines and reads the tail', async () => {
    const { ctx } = await setup()
    for (let i = 0; i < 5; i++) await ctx.storage.append('messages/bot/2026-10-15', { i })
    expect(await ctx.storage.tail('messages/bot/2026-10-15', 2)).toEqual([{ i: 3 }, { i: 4 }])
    expect(await ctx.storage.tail('messages/bot/missing', 2)).toEqual([])
  })

  it('rejects keys that leave the data directory', async () => {
    const { ctx } = await setup()
    await expect(ctx.storage.set('../escape', {})).rejects.toThrow()
    await expect(ctx.storage.get('agent/../../escape')).rejects.toThrow()
  })
})
