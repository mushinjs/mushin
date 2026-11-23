import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CALL_TOOL, DELEGATE_TOOL, REPORT_TOOL } from '@mushinjs/plugin-fairy'
import { startInstance, type TestInstance, waitFor } from './helpers/instance'
import { createMockOpenAI } from './helpers/mock-openai'

// Inside the repository's node_modules, so a local plugin finds @mushinjs/core under the test runner too.
const root = fileURLToPath(new URL('../../../node_modules/', import.meta.url))
const temps: string[] = []
let app: TestInstance
let llm: Awaited<ReturnType<typeof createMockOpenAI>>
let shared: string

beforeAll(async () => {
  llm = await createMockOpenAI()
  const baseDir = await mkdtemp(join(root, '.mushin-dev-app-'))
  shared = await mkdtemp(join(root, '.mushin-dev-shared-'))
  temps.push(baseDir, shared)
  app = await startInstance({ baseDir })
  await app.call('providers.create', { name: 'Mock', type: 'openai', config: { baseURL: llm.baseURL, apiKey: 'sk-test-1234567890' }, models: ['mock-model'] })
})

afterAll(async () => {
  await app?.stop()
  await llm?.close()
  for (const dir of temps) await rm(dir, { recursive: true, force: true })
})

describe('plugin folders', () => {
  it('adds a folder outside the app, creates a plugin there and reloads it with the new code', async () => {
    const folders = await app.call<any[]>('plugins.folders.set', { dirs: [shared] })
    expect(folders).toEqual([
      expect.objectContaining({ path: join(app.ctx.baseDir!, 'plugins'), extra: false }),
      { path: shared, extra: true, exists: true, plugins: [] },
    ])
    const config = JSON.parse(await readFile(join(app.ctx.baseDir!, 'mushin.config.json'), 'utf8'))
    expect(config.pluginDirs).toEqual([shared])

    const created = await app.call('plugins.new', { name: 'shared-hello', folder: shared })
    expect(created).toMatchObject({ dir: join(shared, 'shared-hello'), package: 'mushin-plugin-shared-hello', entry: { id: 'shared-hello', status: 'active' } })
    expect(await app.call('sharedHello.hello', { name: 'Fairy' })).toEqual({ text: 'Hello, Fairy!' })
    expect((await app.call<any[]>('plugins.folders'))[1].plugins).toEqual(['mushin-plugin-shared-hello'])
    await expect(app.call('plugins.new', { name: 'shared-hello' })).rejects.toMatchObject({ code: 'conflict' })

    // An edit shows up on reload, without restarting Mushin.js.
    const entry = join(shared, 'shared-hello/src/index.ts')
    await writeFile(entry, (await readFile(entry, 'utf8')).replace('${name}!', '${name}?'))
    expect(await app.call('sharedHello.hello', { name: 'Fairy' })).toEqual({ text: 'Hello, Fairy!' })
    await app.call('plugins.reload', { id: 'shared-hello' })
    expect(await app.call('sharedHello.hello', { name: 'Fairy' })).toEqual({ text: 'Hello, Fairy?' })
  })

  it('lets Fairy\'s file tools into the plugin folders without asking', async () => {
    await app.call('plugins.enable', { package: '@mushinjs/plugin-terminal' })
    await waitFor(() => app.ctx.actions.has('files.write'))
    const file = join(shared, 'shared-hello/README.md')
    expect(app.ctx.actions.approval('files.write', { path: file, content: '' })).toBeUndefined()
    expect(app.ctx.actions.approval('files.write', { path: 'notes.md', content: '' })).toBe('confirm')
    await app.call('files.write', { path: file, content: '# Shared hello\n' })
    expect(await app.call('files.read', { path: file })).toMatchObject({ text: '# Shared hello\n' })
    await expect(app.call('files.read', { path: join(tmpdir(), 'elsewhere.txt') })).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('the developer helper', () => {
  it('is offered once the file tools are there, and keeps to its tools', async () => {
    const developer = (await app.call<any[]>('fairy.roles.list')).find((role) => role.id === 'developer')
    expect(developer).toMatchObject({ ready: true })
    expect(developer.toolNames).toEqual(expect.arrayContaining(['files__edit', 'plugins__new', 'plugins__reload', 'terminal__run', 'bots__sandbox', CALL_TOOL]))
    expect(developer.toolNames).not.toContain('plugins__remove')
    expect(developer.toolNames).not.toContain('bots__send')

    const start = llm.requests.length
    llm.enqueue(
      { toolCalls: [{ name: DELEGATE_TOOL, arguments: { role: 'developer', task: 'Check the shared-hello plugin' } }] },
      // A read action of a plugin goes through call_tool; one outside the role does not, by any name.
      { toolCalls: [{ name: CALL_TOOL, arguments: { name: 'sharedHello.hello', input: { name: 'Dev' } } }, { name: 'bots__send', arguments: { id: 'x', channel: { type: 'group', id: '1' }, text: 'hi' } }, { name: CALL_TOOL, arguments: { name: 'flows.delete', input: { id: 'x' } } }] },
      { toolCalls: [{ name: REPORT_TOOL, arguments: { status: 'done', summary: 'It answers.' } }] },
      { text: 'The plugin answers.' },
    )
    await app.call('fairy.send', { text: 'check my plugin' })
    const [main, , afterTools] = llm.requests.slice(start)
    expect(main.tools.find((tool: any) => tool.function.name === DELEGATE_TOOL).function.parameters.properties.role.enum).toContain('developer')
    const results = afterTools.messages.filter((message: any) => message.role === 'tool').map((message: any) => message.content)
    expect(results[0]).toContain('Hello, Dev?')
    expect(results[1]).toContain('not one of your tools')
    expect(results[2]).toContain('not one of your tools')
  })
})

describe('loader hooks', () => {
  it('give a plugin outside the app the app\'s packages and fresh files on reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mushin-hooks-'))
    temps.push(dir)
    const plugin = join(dir, 'outside')
    await mkdir(join(plugin, 'src'), { recursive: true })
    await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'mushin-plugin-outside', type: 'module' }))
    await writeFile(join(plugin, 'src/index.ts'), "import { z } from '@mushinjs/core'\nimport { word } from './word.ts'\nexport { z }\nexport const text = (): string => word\n")
    await writeFile(join(plugin, 'src/word.ts'), "export const word: string = 'one'\n")
    const script = join(dir, 'run.mjs')
    await writeFile(script, `
const [tsx, hooks, core, host, entry, word] = process.argv.slice(2)
const { register } = await import(tsx)
register()
const { registerPluginHooks } = await import(hooks)
registerPluginHooks([host])
const { writeFileSync } = await import('node:fs')
const first = await import(entry + '?mushin-v=0')
writeFileSync(word, "export const word: string = 'two'\\n")
const cached = await import(entry + '?mushin-v=0')
const fresh = await import(entry + '?mushin-v=1')
const { z } = await import(core)
console.log(JSON.stringify({ texts: [first.text(), cached.text(), fresh.text()], sameCore: first.z === z }))
`)
    const require = createRequire(import.meta.url)
    const args = [
      script,
      pathToFileURL(require.resolve('tsx/esm/api')).href,
      new URL('../src/hooks.ts', import.meta.url).href,
      pathToFileURL(require.resolve('@mushinjs/core')).href,
      new URL('../package.json', import.meta.url).href,
      pathToFileURL(join(plugin, 'src/index.ts')).href,
      join(plugin, 'src/word.ts'),
    ]
    const { stdout } = await promisify(execFile)(process.execPath, args, { cwd: dir })
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({ texts: ['one', 'one', 'two'], sameCore: true })
  })
})
