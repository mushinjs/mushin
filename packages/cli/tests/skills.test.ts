import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installSkills, SKILLS_SOURCE, SKILLS_TARGET } from '../src/skills'

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('official skills', () => {
  it('ships four skills, each with a name and a description', async () => {
    const names = (await readdir(SKILLS_SOURCE)).sort()
    expect(names).toEqual(['mushin-flows', 'mushin-operations', 'mushin-plugin-dev', 'mushin-troubleshoot'])
    for (const name of names) {
      // Git on Windows may check the files out with CRLF line ends.
      const text = (await readFile(join(SKILLS_SOURCE, name, 'SKILL.md'), 'utf8')).replace(/\r\n/g, '\n')
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? ''
      expect(front).toContain(`name: ${name}`)
      expect(front).toMatch(/description: .{40,}/)
    }
  })

  it('adds missing skills, keeps edits unless told to replace them', async () => {
    const app = await mkdtemp(join(tmpdir(), 'mushin-skills-'))
    temps.push(app)
    expect((await installSkills(app)).added).toHaveLength(4)
    expect(await installSkills(app)).toEqual({ added: [], updated: [] })

    const file = join(app, SKILLS_TARGET, 'mushin-flows', 'SKILL.md')
    await writeFile(file, 'edited')
    expect(await installSkills(app)).toEqual({ added: [], updated: [] })
    expect(await readFile(file, 'utf8')).toBe('edited')
    expect(await installSkills(app, { overwrite: true })).toEqual({ added: [], updated: ['mushin-flows'] })
    expect(await readFile(file, 'utf8')).toContain('name: mushin-flows')
  })
})
