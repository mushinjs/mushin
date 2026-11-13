import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { appPackageManager, appPackages, newPlugin, upgradeCommand, upgradeTag } from '../src/scaffold'
import { startInstance, type TestInstance } from './helpers/instance'

// Inside the repository's node_modules, so a local plugin finds @mushinjs/core the way it does in an app.
const root = fileURLToPath(new URL('../../../node_modules/', import.meta.url))
const temps: string[] = []
let app: TestInstance | undefined

afterEach(async () => {
  await app?.stop({ keep: true })
  app = undefined
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir() {
  const dir = await mkdtemp(join(root, '.mushin-scaffold-'))
  temps.push(dir)
  return dir
}

describe('mushin new plugin', () => {
  it('creates a plugin that runs and turns it on', async () => {
    const baseDir = await tempDir()
    const created = await newPlugin(baseDir, 'hello-world')
    expect(created).toMatchObject({ package: 'mushin-plugin-hello-world', added: true })
    const config = JSON.parse(await readFile(join(baseDir, 'mushin.config.json'), 'utf8'))
    expect(config.plugins.at(-1)).toEqual({ id: 'hello-world', package: 'mushin-plugin-hello-world', enabled: true, config: {} })
    expect(config.plugins.some((entry: any) => entry.package === '@mushinjs/plugin-console')).toBe(true)

    app = await startInstance({ baseDir })
    expect(await app.call('helloWorld.hello', { name: 'Mushin' })).toEqual({ text: 'Hello, Mushin!' })
    await app.call('plugins.configure', { id: 'hello-world', config: { greeting: 'Hi' } })
    expect(await app.call('helloWorld.hello', { name: 'Mushin' })).toEqual({ text: 'Hi, Mushin!' })
  })

  it('refuses a bad name or one that exists', async () => {
    const baseDir = await tempDir()
    await expect(newPlugin(baseDir, 'Bad Name')).rejects.toThrow(/not a plugin name/)
    await newPlugin(baseDir, 'twice')
    await expect(newPlugin(baseDir, 'twice')).rejects.toThrow(/already exists/)
  })
})

describe('mushin upgrade', () => {
  it('updates the app\'s @mushinjs packages with its package manager and dist-tag', async () => {
    const baseDir = await tempDir()
    await writeFile(join(baseDir, 'package.json'), JSON.stringify({ dependencies: { '@mushinjs/core': '1', '@mushinjs/cli': '1', other: '1' }, devDependencies: { typescript: '6' } }))
    expect(await appPackages(baseDir)).toEqual(['@mushinjs/cli', '@mushinjs/core'])
    expect(appPackageManager(baseDir)).toBe('npm')
    await writeFile(join(baseDir, 'pnpm-lock.yaml'), '')
    expect(appPackageManager(baseDir)).toBe('pnpm')
    expect(upgradeTag('0.2.0-next.20261113103537')).toBe('next')
    expect(upgradeTag('0.2.0')).toBe('latest')
    expect(upgradeCommand('pnpm', ['@mushinjs/cli'], 'next')).toEqual(['pnpm', ['add', '@mushinjs/cli@next']])
    expect(upgradeCommand('npm', ['@mushinjs/cli', '@mushinjs/core'], 'latest')).toEqual(['npm', ['install', '@mushinjs/cli@latest', '@mushinjs/core@latest']])
  })
})
