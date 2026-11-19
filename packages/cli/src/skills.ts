import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The official skills, shipped in this package's `skills/` folder, one folder each with a `SKILL.md`. */
export const SKILLS_SOURCE = fileURLToPath(new URL('../skills', import.meta.url))

/** Where an app keeps them: the folder Claude Code reads, and AGENTS.md points other tools to. */
export const SKILLS_TARGET = join('.claude', 'skills')

/**
 * Copies the official skills into an app. With `overwrite`, skills that changed are replaced (for upgrades);
 * without it only missing ones are added, so a start never undoes an edit.
 */
export async function installSkills(baseDir: string, options: { overwrite?: boolean } = {}) {
  const added: string[] = []
  const updated: string[] = []
  for (const name of (await readdir(SKILLS_SOURCE)).sort()) {
    const source = join(SKILLS_SOURCE, name, 'SKILL.md')
    if (!existsSync(source)) continue
    const target = join(baseDir, SKILLS_TARGET, name, 'SKILL.md')
    const content = await readFile(source, 'utf8')
    const current = await readFile(target, 'utf8').catch(() => undefined)
    if (current === content || (current !== undefined && !options.overwrite)) continue
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
    ;(current === undefined ? added : updated).push(name)
  }
  return { added, updated }
}
