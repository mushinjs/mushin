import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetAdminToken, type SignInInfo } from '@mushin/plugin-console'
import { start } from '../src/start'
import { waitFor } from './helpers/instance'

// These tests cover the stored token, so the environment override must be off.
delete process.env.MUSHIN_ADMIN_TOKEN

let baseDir: string
let stop: (() => Promise<void>) | undefined

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'mushin-auth-'))
})

afterEach(async () => {
  await stop?.()
  stop = undefined
  await rm(baseDir, { recursive: true, force: true }).catch(() => {})
})

async function boot() {
  let info: SignInInfo | undefined
  const instance = await start({ baseDir, port: 0, quiet: true, onSignIn: (value) => (info = value) })
  stop = instance.stop
  const ready = await waitFor(() => info)
  const login = (token: string) => fetch(`${ready.url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }).then((response) => response.status)
  return { ctx: instance.ctx, info: ready, login }
}

describe('admin token', () => {
  it('creates a token, reports it for the sign-in banner and accepts it', async () => {
    const { info, login } = await boot()
    expect(info.fromEnv).toBe(false)
    expect(info.token).toMatch(/^[\w-]{32}$/)
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(await login(info.token)).toBe(200)
    expect(await login(` ${info.token}\n`)).toBe(200)
    expect(await login('wrong-token-wrong-token-wrong-to')).toBe(401)
  })

  it('shows the same token again on the next start', async () => {
    const first = (await boot()).info.token
    await stop!()
    stop = undefined
    const second = await boot()
    expect(second.info.token).toBe(first)
    expect(await second.login(first)).toBe(200)
  })

  it('replaces a hash-only record from an older build with a token it can show', async () => {
    await mkdir(join(baseDir, 'data'), { recursive: true })
    await writeFile(join(baseDir, 'data', 'auth.json'), JSON.stringify({ salt: 'aa', hash: 'bb', createdAt: 1 }))
    const { info, login } = await boot()
    expect(await login(info.token)).toBe(200)
    const stored = JSON.parse(await readFile(join(baseDir, 'data', 'auth.json'), 'utf8'))
    expect(stored.token).toBe(info.token)
  })

  it('accepts a token from "mushin token reset" without a restart, and drops the old one', async () => {
    const { info, login } = await boot()
    const fresh = await resetAdminToken(join(baseDir, 'data'))
    expect(await login(fresh)).toBe(200)
    expect(await login(info.token)).toBe(401)
  })

  it('keeps the token out of the log buffer the dashboard and the Agent can read', async () => {
    const { ctx, info } = await boot()
    const lines = await ctx.actions.call('logs.recent', {}) as { text: string }[]
    expect(lines.some((line) => line.text.includes('dashboard at'))).toBe(true)
    expect(JSON.stringify(lines)).not.toContain(info.token)
  })
})
