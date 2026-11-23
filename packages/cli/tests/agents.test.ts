import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_FILES, agentFilesIn, appInfo, BLOCK_END, defaultAgentIds, mergeBlock, parseAgentIds, refreshAgentFiles, writeAgentFiles } from '../src/agents'
import { multiSelect } from '../src/prompt'

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function app(config?: object) {
  const dir = await mkdtemp(join(tmpdir(), 'mushin-agents-'))
  temps.push(dir)
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'my-bot', dependencies: { '@mushinjs/cli': '*' } }))
  if (config) await writeFile(join(dir, 'mushin.config.json'), JSON.stringify(config))
  return dir
}

describe('agent guide', () => {
  it('describes the app and points to every official skill', async () => {
    const dir = await app({
      plugins: [
        { id: 'server', package: '@cordisjs/plugin-server', enabled: true, config: { host: '0.0.0.0', port: 6000 } },
        { id: 'storage', package: '@mushinjs/plugin-storage', enabled: true, config: { dir: 'state' } },
      ],
      pluginDirs: ['../shared'],
    })
    await writeFile(join(dir, 'pnpm-lock.yaml'), '')
    const info = await appInfo(dir)
    expect(info).toMatchObject({ name: 'my-bot', dir, packageManager: 'pnpm', url: 'http://127.0.0.1:6000', dataDir: 'state', pluginDirs: ['plugins', '../shared'] })

    expect(await writeAgentFiles(dir, ['agents'])).toEqual(['AGENTS.md'])
    const text = await readFile(join(dir, 'AGENTS.md'), 'utf8')
    expect(text).toContain(dir)
    expect(text).toContain('pnpm start')
    expect(text).toContain('pnpm exec mushin new plugin')
    expect(text).toContain('`plugins/`, `../shared/`')
    for (const name of ['mushin-plugin-dev', 'mushin-flows', 'mushin-troubleshoot', 'mushin-operations']) {
      expect(text).toContain(`.claude/skills/${name}/SKILL.md`)
    }
    // The main guide stays short; the details are in the skills.
    expect(text.split('\n').length).toBeLessThan(60)
  })

  it('writes the chosen files, with CLAUDE.md importing AGENTS.md', async () => {
    const dir = await app()
    const written = await writeAgentFiles(dir, AGENT_FILES.map((file) => file.id))
    expect(written).toEqual(AGENT_FILES.map((file) => file.path))
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toContain('\n@AGENTS.md\n')
    expect(await readFile(join(dir, '.cursor/rules/mushin.mdc'), 'utf8')).toMatch(/^---\n[\s\S]*alwaysApply: true\n---\n/)
    expect(await readFile(join(dir, '.github/copilot-instructions.md'), 'utf8')).toContain('mushin-plugin-dev')
    expect(await agentFilesIn(dir)).toEqual(AGENT_FILES.map((file) => file.id))
    expect(await writeAgentFiles(dir, AGENT_FILES.map((file) => file.id))).toEqual([])

    // Without AGENTS.md, CLAUDE.md holds the guide itself.
    const alone = await app()
    await writeAgentFiles(alone, ['claude'])
    expect(await readFile(join(alone, 'CLAUDE.md'), 'utf8')).toContain('## Read before the job')
  })

  it('keeps the user\'s own text around the generated block', async () => {
    const mine = '# My notes\n\nAlways answer in Chinese.\n'
    const first = mergeBlock(mine, 'guide v1\n')
    expect(first.startsWith(mine.trimEnd())).toBe(true)
    const edited = first + '\nMore of mine.\n'
    const second = mergeBlock(edited, 'guide v2\n')
    expect(second).toContain('Always answer in Chinese.')
    expect(second).toContain('More of mine.')
    expect(second).toContain('guide v2')
    expect(second).not.toContain('guide v1')
    expect(second.split(BLOCK_END)).toHaveLength(2)
    // A file checked out with CRLF keeps it.
    expect(mergeBlock(first.replace(/\n/g, '\r\n'), 'guide v3\n')).not.toMatch(/[^\r]\n/)
  })

  it('refreshes only generated files, and replaces the AGENTS.md of older apps on upgrade', async () => {
    const dir = await app()
    await writeFile(join(dir, 'GEMINI.md'), 'my own gemini notes\n')
    await writeFile(join(dir, 'AGENTS.md'), '# my-bot\n\nThis folder is a [Mushin.js](https://github.com/mushinjs/mushin) app: a chatbot framework.\n')
    expect(await refreshAgentFiles(dir)).toEqual([])
    expect(await refreshAgentFiles(dir, { legacy: true })).toEqual(['AGENTS.md'])
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).not.toContain('a chatbot framework.')
    expect(await readFile(join(dir, 'GEMINI.md'), 'utf8')).toBe('my own gemini notes\n')
    expect(await refreshAgentFiles(dir)).toEqual([])
    expect(await defaultAgentIds(dir)).toEqual(['agents'])
    expect(await defaultAgentIds(await app())).toEqual(['agents', 'claude'])
  })

  it('reads a list of files', () => {
    expect(parseAgentIds('agents, Claude,agents')).toEqual(['agents', 'claude'])
    expect(parseAgentIds('none')).toEqual([])
    expect(() => parseAgentIds('agents,vim')).toThrow(/Unknown agent file: vim/)
  })
})

describe('multiSelect', () => {
  it('moves, ticks and confirms', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()
    const choices = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }]
    const answer = multiSelect('Pick', choices, ['a'], { input, output })
    for (const key of ['\x1b[B', ' ', '\x1b[B', ' ', '\x1b[A', ' ', '\r']) input.write(key)
    expect(await answer).toEqual(['a', 'c'])
  })

  it('gives undefined on Ctrl+C', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()
    const answer = multiSelect('Pick', [{ value: 'a', label: 'A' }], [], { input, output })
    input.write('\x03')
    expect(await answer).toBeUndefined()
  })
})
