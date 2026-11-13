import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { childrenOf, dataFile, layoutVersion, LAYOUT_VERSION, locate, migrateLayout, resolveDirs } from '../src'

const temps: string[] = []

async function instance() {
  const baseDir = await mkdtemp(join(tmpdir(), 'mushin-layout-'))
  temps.push(baseDir)
  return { baseDir, dirs: resolveDirs(baseDir) }
}

async function put(file: string, content: string) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('layout', () => {
  it('places keys by the rule table', () => {
    const at = (key: string) => {
      const { root, path } = locate(key)
      return `${root}:${path.join('/')}`
    }
    expect(at('bots')).toBe('data:core/bots')
    expect(at('auth')).toBe('data:core/auth')
    expect(at('messages/b1/2026-10-01')).toBe('data:bots/b1/messages/2026-10-01')
    expect(at('logs/b1/2026-10-01')).toBe('logs:bots/b1/2026-10-01')
    expect(at('agent/abc')).toBe('data:agents/sessions/abc')
    expect(at('agent/skills/web')).toBe('data:agents/skills/web')
    expect(at('flows/abc')).toBe('data:plugins/flows/documents/abc')
    expect(at('flows-usage')).toBe('data:plugins/flows/usage')
    expect(at('knowledge/base1/a.pdf')).toBe('data:plugins/knowledge/base1/a.pdf')
    expect(at('scheduler')).toBe('data:plugins/scheduler/index')
  })

  it('lists the bots that have a message folder', async () => {
    const { dirs } = await instance()
    await put(join(dirs.data, 'bots', 'b1', 'messages', '2026-10-01.jsonl'), '')
    await mkdir(join(dirs.data, 'bots', 'b2'), { recursive: true })
    expect(await childrenOf(dirs, 'messages')).toEqual(['b1'])
    expect(await childrenOf(dirs, 'messages/b1')).toEqual(['2026-10-01.jsonl'])
  })

  it('names the data file of a key and refuses keys kept elsewhere', () => {
    expect(dataFile('/x/data', 'auth')).toBe(join('/x/data', 'core', 'auth.json'))
    expect(() => dataFile('/x/data', 'logs/b1/day')).toThrow(/not stored in the data directory/)
  })
})

describe('migrateLayout', () => {
  it('marks a new data folder as current without moving anything', async () => {
    const { dirs } = await instance()
    expect(await layoutVersion(dirs.data)).toBeUndefined()
    const result = await migrateLayout(dirs)
    expect(result).toMatchObject({ from: undefined, moves: [] })
    expect(await layoutVersion(dirs.data)).toBe(LAYOUT_VERSION)
  })

  it('moves a flat data folder, keeps a copy, and changes nothing on a second run', async () => {
    const { baseDir, dirs } = await instance()
    const old = (path: string) => join(dirs.data, path)
    await put(old('bots.json'), '[{"id":"b1"}]')
    await put(old('auth.json'), '{"token":"t"}')
    await put(old('flows/f1.json'), '{"id":"f1"}')
    await put(old('flows-usage.json'), '{}')
    await put(old('messages/b1/2026-10-01.jsonl'), '{"id":"m1"}\n')
    await put(old('logs/b1/2026-10-01.jsonl'), '{"level":"info"}\n')
    await put(old('agent/s1.json'), '{}')
    await put(old('agent/skills/web.json'), '{}')
    await put(old('knowledge/base1/notes.md'), '# notes')
    await put(old('mushin.db'), 'db')

    const dry = await migrateLayout(dirs, { dryRun: true })
    expect(dry.from).toBe(1)
    expect(dry.moves).toHaveLength(9)
    expect(await readFile(old('bots.json'), 'utf8')).toBe('[{"id":"b1"}]')
    expect(await layoutVersion(dirs.data)).toBe(1)

    const result = await migrateLayout(dirs, { now: new Date(Date.UTC(2026, 10, 13)) })
    expect(result.moves).toHaveLength(9)
    expect(result.backup).toBe(join(dirs.data, 'backups', '2026-11-13T00-00-00-000Z-layout-1'))
    const read = (path: string) => readFile(join(baseDir, path), 'utf8')
    expect(await read('data/core/bots.json')).toBe('[{"id":"b1"}]')
    expect(await read('data/core/auth.json')).toBe('{"token":"t"}')
    expect(await read('data/plugins/flows/documents/f1.json')).toBe('{"id":"f1"}')
    expect(await read('data/plugins/flows/usage.json')).toBe('{}')
    expect(await read('data/bots/b1/messages/2026-10-01.jsonl')).toBe('{"id":"m1"}\n')
    expect(await read('logs/bots/b1/2026-10-01.jsonl')).toBe('{"level":"info"}\n')
    expect(await read('data/agents/sessions/s1.json')).toBe('{}')
    expect(await read('data/agents/skills/web.json')).toBe('{}')
    expect(await read('data/plugins/knowledge/base1/notes.md')).toBe('# notes')
    expect(await read('data/mushin.db')).toBe('db')
    // The backup holds the old files where they were.
    expect(await readFile(join(result.backup!, 'flows', 'f1.json'), 'utf8')).toBe('{"id":"f1"}')
    // The old folders are gone.
    expect((await readdir(dirs.data)).sort()).toEqual(['agents', 'backups', 'bots', 'core', 'layout.json', 'mushin.db', 'plugins'])

    expect(await migrateLayout(dirs)).toEqual({ from: LAYOUT_VERSION, moves: [] })
    expect((await readdir(join(dirs.data, 'backups')))).toHaveLength(1)
  })

  it('refuses a layout newer than it knows', async () => {
    const { dirs } = await instance()
    await put(join(dirs.data, 'layout.json'), JSON.stringify({ version: LAYOUT_VERSION + 1 }))
    await expect(migrateLayout(dirs)).rejects.toThrow(/newer than this Mushin.js understands/)
  })
})
