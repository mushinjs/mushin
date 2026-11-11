import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { startInstance, type TestInstance } from './helpers/instance'

let app: TestInstance | undefined

afterAll(async () => {
  await app?.stop()
})

/** Rewrites a saved file the way an instance from before the scope change wrote it. */
async function toOldScope(file: string) {
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('@mushinjs/', '@mushin/'))
}

describe('the @mushin to @mushinjs rename', () => {
  it('reads plugin and bot plugin names an older instance saved under @mushin', async () => {
    app = await startInstance()
    const { baseDir } = app.ctx
    const bot = await app.call('bots.create', { name: 'Old', adapter: { type: 'onebot', config: {} }, plugins: [{ package: '@mushinjs/bot-plugin-echo' }], enabled: false })
    await app.stop({ keep: true })
    app = undefined

    await toOldScope(join(baseDir, 'mushin.config.json'))
    await toOldScope(join(baseDir, 'data', 'bots.json'))
    expect(await readFile(join(baseDir, 'mushin.config.json'), 'utf8')).toContain('"@mushin/plugin-console"')

    app = await startInstance({ baseDir })
    const packages = (await app.call<{ package: string }[]>('plugins.list')).map((entry) => entry.package)
    expect(packages).toContain('@mushinjs/plugin-console')
    expect(packages.filter((name) => name.startsWith('@mushin/'))).toEqual([])
    // Saved back, so the file matches what runs.
    expect(await readFile(join(baseDir, 'mushin.config.json'), 'utf8')).not.toContain('"@mushin/')
    const plugins = await app.call<{ package: string; enabled: boolean }[]>('bots.plugins.list', { id: bot.id })
    expect(plugins.find((item) => item.package === '@mushinjs/bot-plugin-echo')?.enabled).toBe(true)
  })
})
