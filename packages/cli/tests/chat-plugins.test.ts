import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { demoBotReady, startInstance, type TestInstance, waitFor } from './helpers/instance'

let app: TestInstance
let botA: string
let botB: string
const WEATHER = 'mushin-plugin-weather-test'
const ECHO = '@mushinjs/bot-plugin-echo'

const replies = async (id: string) => (await app.call<any[]>('bots.messages', { id, limit: 500 }))
  .filter((record) => record.direction === 'out')
  .map((record) => record.segments.filter((s: any) => s.type === 'text').map((s: any) => s.data.text).join(''))

/** Writes to a bot's sandbox and waits for the next reply. */
async function ask(id: string, text: string) {
  const before = (await replies(id)).length
  await app.call('bots.sandbox', { id, text })
  return waitFor(async () => (await replies(id))[before])
}

/** Writes to a bot's sandbox and waits until the bot has handled it, without expecting a reply. */
async function tell(id: string, text: string) {
  await app.call('bots.sandbox', { id, text })
  const record = await waitFor(async () => (await app.call<any[]>('bots.messages', { id, limit: 500 })).findLast((item) => item.direction === 'in' && item.segments.some((s: any) => s.data?.text === text)))
  await waitFor(async () => (await app.call<any[]>('bots.logs', { id, message: record.id, query: 'processed in' })).length > 0)
}

beforeAll(async () => {
  app = await startInstance()
  await app.call('plugins.enable', { package: '@mushinjs/plugin-demo' })
  botA = (await app.call('bots.create', { name: 'A', adapter: { type: 'demo', config: {} } })).id
  botB = (await app.call('bots.create', { name: 'B', adapter: { type: 'demo', config: {} } })).id
  await demoBotReady(app, botA)
  await demoBotReady(app, botB)

  const created = await app.call('plugins.new', { name: 'weather-test' })
  await writeFile(join(created.dir, 'src/index.ts'), `import type { Context } from '@mushinjs/core'
import type {} from '@mushinjs/plugin-bots'

export const name = 'weather-test'
export const inject = ['bots']

export function apply(ctx: Context) {
  ctx.bots.defineCommand({ name: '天气', description: '查天气', args: [{ name: '地域', type: 'text', rest: true, optional: true }] }, async (session) => {
    const area = session.command?.rest.trim()
    if (area === '爆炸') throw new Error('the weather service is down')
    await session.send(\`\${area}：晴\`)
  })
}
`)
  await app.call('plugins.reload', { id: created.entry.id })
})

afterAll(async () => {
  await app?.stop()
})

describe('an app plugin\'s chat commands', () => {
  it('answer only on the bots it is turned on for', async () => {
    const listed = (await app.call<any[]>('bots.plugins.list', { id: botA })).find((item) => item.package === WEATHER)
    expect(listed).toMatchObject({ kind: 'app', enabled: false, status: 'disabled', commands: ['天气'] })
    expect((await app.call('commands.list', { bot: botA })).commands.map((command: any) => command.name)).not.toContain('天气')

    expect(await app.call('bots.plugins.enable', { id: botA, package: WEATHER })).toMatchObject({ kind: 'app', enabled: true, status: 'active' })
    expect(await ask(botA, '/天气 北京')).toBe('北京：晴')
    expect((await app.call('commands.list', { bot: botA })).commands.map((command: any) => command.name)).toContain('天气')
    expect((await app.call('commands.list', { bot: botB })).commands.map((command: any) => command.name)).not.toContain('天气')
    await tell(botB, '/天气 上海')
    expect(await replies(botB)).not.toContain('上海：晴')

    expect((await app.call('bots.get', { id: botA })).appPlugins).toEqual([WEATHER])
    await expect(app.call('bots.plugins.configure', { id: botA, package: WEATHER, config: {} })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('are off on every bot while the plugin is off for the project, and the bots keep their switch', async () => {
    const entry = (await app.call<any[]>('plugins.list')).find((item) => item.package === WEATHER)
    await app.call('plugins.disable', { id: entry.id })
    expect((await app.call<any[]>('bots.plugins.list', { id: botA })).find((item) => item.package === WEATHER)).toMatchObject({ enabled: true, projectOff: true, status: 'disabled' })
    await app.call('plugins.enable', { package: WEATHER, id: entry.id })
    await waitFor(async () => (await app.call<any[]>('bots.plugins.list', { id: botA })).find((item) => item.package === WEATHER)?.status === 'active')
    expect(await app.call<any[]>('bots.plugins.project')).toEqual(expect.arrayContaining([{ package: WEATHER, kind: 'app', enabled: true, bots: [botA] }]))
  })
})

describe('plugin runs', () => {
  it('record what a plugin did with a message, beside the flow runs', async () => {
    const { runs } = await app.call('bots.runs', { id: botA })
    expect(runs[0]).toMatchObject({ botId: botA, plugin: WEATHER, command: '天气', text: '/天气 北京', status: 'ok', replies: 1, channel: 'private:@sandbox', message: expect.any(String) })
    // The demo bot's first /help came from its test user and was answered by the bots plugin.
    expect(runs.at(-1)).toMatchObject({ plugin: '@mushinjs/plugin-bots', command: 'help', replies: 1 })

    await tell(botA, '/天气 爆炸')
    const failed = await waitFor(async () => (await app.call('bots.runs', { id: botA, status: 'error' })).runs[0])
    expect(failed).toMatchObject({ plugin: WEATHER, status: 'error', error: 'the weather service is down', replies: 0 })
    expect((await app.call('bots.runs', { id: botA, plugin: '@mushinjs/plugin-bots' })).runs.every((run: any) => run.plugin === '@mushinjs/plugin-bots')).toBe(true)
  })
})

describe('a bot plugin\'s project switch', () => {
  it('stops it on every bot and starts it again where it was on', async () => {
    await app.call('bots.plugins.enable', { id: botA, package: ECHO })
    expect(await ask(botA, 'echo hi')).toBe('hi')
    expect((await app.call('bots.runs', { id: botA, plugin: ECHO })).runs[0]).toMatchObject({ text: 'echo hi', replies: 1, kept: false })

    expect(await app.call('bots.plugins.setProject', { package: ECHO, enabled: false })).toEqual({ package: ECHO, kind: 'bot', enabled: false, bots: [botA] })
    expect((await app.call<any[]>('bots.plugins.list', { id: botA })).find((item) => item.package === ECHO)).toMatchObject({ enabled: true, projectOff: true, status: 'disabled' })
    await tell(botA, 'echo quiet')
    expect(await replies(botA)).not.toContain('quiet')

    await app.call('bots.plugins.setProject', { package: ECHO, enabled: true })
    await waitFor(async () => (await app.call<any[]>('bots.plugins.list', { id: botA })).find((item) => item.package === ECHO)?.status === 'active')
    expect(await ask(botA, 'echo back')).toBe('back')
    await expect(app.call('bots.plugins.setProject', { package: '@mushinjs/bot-plugin-flows', enabled: false })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(app.call('bots.plugins.setProject', { package: WEATHER, enabled: false })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('what plugins provide', () => {
  it('counts each running plugin\'s commands, nodes, tools and adapters', async () => {
    const provides = await app.call<Record<string, any>>('plugins.provides')
    expect(provides[WEATHER]).toEqual({ commands: ['天气'], nodes: [], tools: [], adapters: [] })
    expect(provides['@mushinjs/plugin-demo'].adapters).toEqual(['demo'])
    expect(provides['@mushinjs/plugin-demo'].tools).toContain('demo.say')
    expect(provides['@mushinjs/plugin-flows'].nodes).toEqual(expect.arrayContaining(['trigger.command', 'logic.if']))
    expect(provides['@mushinjs/plugin-bots'].tools).toContain('bots.runs')
    expect(provides[ECHO]).toBeUndefined()
    // Fairy's dashboard plumbing is not a tool.
    expect(Object.values(provides).some((item: any) => item.tools.includes('browser.frame'))).toBe(false)
  })
})
