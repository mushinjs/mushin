import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance | undefined

afterEach(async () => {
  await app?.stop()
  app = undefined
})

async function put(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** The text of every JSON file under a folder, `backups/` left out. */
async function texts(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'backups') found.push(...await texts(full))
    }
    else if (/\.jsonl?$/.test(entry.name)) found.push(await readFile(full, 'utf8'))
  }
  return found
}

describe('secrets in .env', () => {
  it('moves the keys an older version kept in data/ to .env, and the instance still uses them', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'mushin-secrets-'))
    // An instance from before the new layout: flat data/, keys in plain text.
    await put(join(baseDir, 'data', 'providers.json'), {
      providers: [{ id: 'p1', name: 'DeepSeek', type: 'openai', config: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-old-provider-key' }, models: ['m'], createdAt: 1, isDefault: true }],
      profiles: [],
    })
    await put(join(baseDir, 'data', 'bots.json'), {
      bots: [{ id: 'b1', name: 'Old Bot', enabled: false, adapter: { type: 'onebot', config: { mode: 'forward', url: 'ws://127.0.0.1:9', token: 'old-napcat-token' } }, plugins: [], createdAt: 1 }],
    })
    await put(join(baseDir, 'data', 'mcp', 'servers', 'tools.json'), {
      id: 'tools', name: 'Tools', transport: 'http', url: 'http://127.0.0.1:9/mcp', headers: { authorization: 'Bearer old-mcp-token' }, enabled: false, disabledTools: [], createdAt: 1,
    })
    app = await startInstance({ baseDir })

    // Keys move once their provider type or adapter loads, which can be just after the instance is up.
    const instance = app
    await waitFor(async () => (await instance.call('providers.list')).providers[0].config.apiKey === '${DEEPSEEK_API_KEY}')
    await waitFor(async () => (await instance.call<any[]>('bots.list'))[0].adapter.config.token === '${BOT_OLD_BOT_TOKEN}')
    const [server] = await app.call<any[]>('mcp.servers.list')
    expect(server.headers.authorization).toBe('${MCP_TOOLS_AUTHORIZATION}')

    const env = await readFile(join(baseDir, '.env'), 'utf8')
    expect(env).toContain('DEEPSEEK_API_KEY=sk-old-provider-key')
    expect(env).toContain('BOT_OLD_BOT_TOKEN=old-napcat-token')
    expect(env).toContain('MCP_TOOLS_AUTHORIZATION="Bearer old-mcp-token"')
    // Nothing in data/ holds a key any more, the copy in data/backups/ aside.
    const secrets = ['sk-old-provider-key', 'old-napcat-token', 'old-mcp-token']
    await waitFor(async () => {
      const stored = (await texts(join(baseDir, 'data'))).join('\n')
      return secrets.every((secret) => !stored.includes(secret))
    })
    expect(app.ctx.llm.client(app.ctx.llm.get('p1'))).toBeTruthy()
    expect(app.ctx.storage.secrets.resolve(app.ctx.llm.get('p1').config.apiKey)).toBe('sk-old-provider-key')
  })

  it('resolves ${NAME} in plugin settings from .env', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'mushin-secrets-'))
    await put(join(baseDir, '.env'), '# where the data lives\nMUSHIN_TEST_DATA_DIR=state\n')
    app = await startInstance({ baseDir })
    await app.stop({ keep: true })
    const config = JSON.parse(await readFile(join(baseDir, 'mushin.config.json'), 'utf8'))
    config.plugins.find((entry: any) => entry.id === 'storage').config = { dir: '${MUSHIN_TEST_DATA_DIR}' }
    await writeFile(join(baseDir, 'mushin.config.json'), JSON.stringify(config, null, 2))

    app = await startInstance({ baseDir })
    expect(app.ctx.storage.dir).toBe(join(baseDir, 'state'))
    // The file keeps the reference.
    expect(await readFile(join(baseDir, 'mushin.config.json'), 'utf8')).toContain('${MUSHIN_TEST_DATA_DIR}')
  })
})
