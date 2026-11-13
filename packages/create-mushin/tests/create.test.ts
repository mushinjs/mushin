import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appFiles, createApp, dependencyRange, detectPackageManager, packageName } from '../src'

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('create-mushin', () => {
  it('writes the app folder', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'create-mushin-'))
    temps.push(parent)
    const { dir, files } = await createApp(join(parent, 'My Bot'), { version: '0.2.0' })
    expect(files.sort()).toEqual(['.gitignore', 'AGENTS.md', 'package.json', 'plugins/.gitkeep', 'skills/.gitkeep', 'tsconfig.json'])
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(pkg).toMatchObject({
      name: 'my-bot',
      private: true,
      scripts: { start: 'mushin start', upgrade: 'mushin upgrade' },
      dependencies: { '@mushinjs/cli': '^0.2.0', '@mushinjs/core': '^0.2.0' },
    })
    const ignore = await readFile(join(dir, '.gitignore'), 'utf8')
    for (const line of ['.env', 'data/', 'cache/', 'logs/', 'node_modules/']) expect(ignore.split('\n')).toContain(line)
    expect((await readdir(dir)).sort()).toEqual(['.gitignore', 'AGENTS.md', 'package.json', 'plugins', 'skills', 'tsconfig.json'])
  })

  it('tells pnpm which install scripts to run', () => {
    expect(appFiles('x', '0.2.0', 'npm')['pnpm-workspace.yaml']).toBeUndefined()
    expect(appFiles('x', '0.2.0', 'pnpm')['pnpm-workspace.yaml']).toContain('ssh2: false')
  })

  it('refuses a folder that is not empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'create-mushin-'))
    temps.push(dir)
    await writeFile(join(dir, 'keep.txt'), 'mine')
    await expect(createApp(dir)).rejects.toThrow(/not empty/)
    await mkdir(join(dir, 'empty'))
    await expect(createApp(join(dir, 'empty'))).resolves.toBeTruthy()
  })

  it('pins a preview and takes compatible updates of a release', () => {
    expect(dependencyRange('0.2.0-next.20261113103537')).toBe('0.2.0-next.20261113103537')
    expect(dependencyRange('0.2.1')).toBe('^0.2.1')
    expect(JSON.parse(appFiles('x', '0.3.0-next.1')['package.json']!).dependencies['@mushinjs/cli']).toBe('0.3.0-next.1')
  })

  it('names the package after the folder and installs with the package manager that ran it', () => {
    expect(packageName('/tmp/My Cool Bot!')).toBe('my-cool-bot')
    expect(packageName('/tmp/机器人')).toBe('mushin-app')
    expect(detectPackageManager('pnpm/11.23.0 npm/? node/v22.13.0 linux x64')).toBe('pnpm')
    expect(detectPackageManager('npm/10.9.0 node/v22.13.0 linux x64 workspaces/false')).toBe('npm')
    expect(detectPackageManager('')).toBe('npm')
  })
})
