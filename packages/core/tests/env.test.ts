import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { envName, envReference, EnvFile, parseEnv, resolveEnvReferences, updateEnvText } from '../src'

const temps: string[] = []

async function envFile(text?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'mushin-env-'))
  temps.push(dir)
  const path = join(dir, '.env')
  if (text !== undefined) await writeFile(path, text)
  return path
}

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
  for (const name of Object.keys(process.env)) if (name.startsWith('MUSHIN_ENV_TEST_')) delete process.env[name]
})

describe('.env files', () => {
  it('parses comments, quotes and export', () => {
    expect(parseEnv([
      '# comment',
      'A=plain',
      'export B = spaced  # note',
      'C="with \\"quotes\\" and\\nnewline"',
      "D='single # kept'",
      'not a line',
      'E=',
    ].join('\n'))).toEqual({ A: 'plain', B: 'spaced', C: 'with "quotes" and\nnewline', D: 'single # kept', E: '' })
  })

  it('changes one line and keeps the rest', () => {
    const text = '# keys\nA=1\nB=2\n'
    expect(updateEnvText(text, 'A', 'x y')).toBe('# keys\nA="x y"\nB=2\n')
    expect(updateEnvText(text, 'C', '3')).toBe('# keys\nA=1\nB=2\nC=3\n')
    expect(updateEnvText(text, 'A', undefined)).toBe('# keys\nB=2\n')
    const value = 'a "quoted" \\ value\nnext'
    expect(parseEnv(updateEnvText('', 'V', value)).V).toBe(value)
  })

  it('names variables after their owner and key', () => {
    expect(envName('DeepSeek', 'apiKey')).toBe('DEEPSEEK_API_KEY')
    expect(envName('bot', 'Old Bot', 'token')).toBe('BOT_OLD_BOT_TOKEN')
    expect(envName('mcp', 'Tools', 'GITHUB_TOKEN')).toBe('MCP_TOOLS_GITHUB_TOKEN')
    expect(envName('2nd', 'key')).toBe('MUSHIN_2ND_KEY')
  })

  it('stores secrets, gives references, and lets the shell win', async () => {
    process.env.MUSHIN_ENV_TEST_SHELL = 'from shell'
    const path = await envFile('MUSHIN_ENV_TEST_SHELL=from file\nMUSHIN_ENV_TEST_FILE=one\n')
    const env = new EnvFile(path).loadSync()
    expect(env.get('MUSHIN_ENV_TEST_SHELL')).toBe('from shell')
    expect(env.fromShell('MUSHIN_ENV_TEST_SHELL')).toBe(true)
    expect(process.env.MUSHIN_ENV_TEST_FILE).toBe('one')

    expect(await env.store('MUSHIN_ENV_TEST_FILE', 'two')).toBe('${MUSHIN_ENV_TEST_FILE_2}')
    expect(await env.store('MUSHIN_ENV_TEST_FILE', 'one')).toBe('${MUSHIN_ENV_TEST_FILE}')
    expect(env.resolve('${MUSHIN_ENV_TEST_FILE_2}')).toBe('two')
    expect(env.resolve('${MUSHIN_ENV_TEST_MISSING}')).toBe('')
    expect(env.resolve('plain')).toBe('plain')
    expect(await readFile(path, 'utf8')).toBe('MUSHIN_ENV_TEST_SHELL=from file\nMUSHIN_ENV_TEST_FILE=one\nMUSHIN_ENV_TEST_FILE_2=two\n')
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('moves plain secrets of a config and reuses the name a value replaces', async () => {
    const env = new EnvFile(await envFile()).loadSync()
    const first = await env.moveIn({ apiKey: 'sk-1', baseURL: 'http://x' }, { keys: ['apiKey'], name: ['MUSHIN_ENV_TEST'] })
    expect(first).toEqual({ config: { apiKey: '${MUSHIN_ENV_TEST_API_KEY}', baseURL: 'http://x' }, moved: ['apiKey'] })
    const unchanged = await env.moveIn({ apiKey: 'sk-…1234' }, { keys: ['apiKey'], name: ['MUSHIN_ENV_TEST'] })
    expect(unchanged.moved).toEqual([])
    const renamed = await env.moveIn({ apiKey: 'sk-2' }, { keys: ['apiKey'], name: ['MUSHIN_ENV_TEST_OTHER'], previous: first.config })
    expect(renamed.config.apiKey).toBe('${MUSHIN_ENV_TEST_API_KEY}')
    expect(env.get('MUSHIN_ENV_TEST_API_KEY')).toBe('sk-2')
    expect(env.resolveAll(renamed.config)).toEqual({ apiKey: 'sk-2' })
  })

  it('picks up changes another process made', async () => {
    const path = await envFile('MUSHIN_ENV_TEST_TOKEN=a\n')
    const env = new EnvFile(path).loadSync()
    await writeFile(path, 'MUSHIN_ENV_TEST_TOKEN=b\n')
    await env.reload()
    expect(env.get('MUSHIN_ENV_TEST_TOKEN')).toBe('b')
  })

  it('resolves whole-value references anywhere in plugin settings', () => {
    const env = { KEY: 'v' }
    expect(resolveEnvReferences({ a: '${KEY}', b: ['${KEY}', 'x ${KEY}'], c: { d: '${NONE}' }, n: 1 }, env)).toEqual({ a: 'v', b: ['v', 'x ${KEY}'], c: { d: '' }, n: 1 })
    expect(envReference('${KEY}')).toBe('KEY')
    expect(envReference('$KEY')).toBeUndefined()
  })
})
