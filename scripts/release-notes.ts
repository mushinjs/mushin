// The notes of a GitHub release: the changes of one version from every package's CHANGELOG.md, each change once
// (all packages share a version, so one changeset shows up in several changelogs). The dashboard's update banner
// shows the start of them.
//
// Usage: tsx scripts/release-notes.ts <version>   (prints Markdown)
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const KINDS = ['Major Changes', 'Minor Changes', 'Patch Changes'] as const

/** The entries of one version in one changelog, by kind, without the "Updated dependencies" lines. */
export function versionSection(changelog: string, version: string) {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `## ${version}`)
  if (start < 0) return {}
  const entries: Partial<Record<typeof KINDS[number], string[]>> = {}
  let kind: typeof KINDS[number] | undefined
  let current: string[] | undefined
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break
    const heading = /^### (.+)$/.exec(line)?.[1]
    if (heading) {
      kind = KINDS.find((item) => item === heading.trim())
      current = undefined
      continue
    }
    if (!kind) continue
    if (/^- /.test(line)) {
      current = [line.replace(/^- (?:[0-9a-f]{7,}: )?/, '- ')]
      if (/^- Updated dependencies/.test(current[0]!)) {
        current = undefined
        continue
      }
      ;(entries[kind] ??= []).push('')
      entries[kind]!.splice(-1, 1, current.join('\n'))
    } else if (current && /^\s+\S/.test(line) && !/^\s+- @/.test(line)) {
      current.push(line)
      entries[kind]!.splice(-1, 1, current.join('\n'))
    }
  }
  return entries
}

export function releaseNotes(root: string, version: string) {
  const merged: Partial<Record<typeof KINDS[number], string[]>> = {}
  const dirs = readdirSync(join(root, 'packages')).sort((a, b) => (a === 'cli' ? -1 : b === 'cli' ? 1 : a.localeCompare(b)))
  for (const dir of dirs) {
    const file = join(root, 'packages', dir, 'CHANGELOG.md')
    if (!existsSync(file)) continue
    for (const [kind, items] of Object.entries(versionSection(readFileSync(file, 'utf8'), version))) {
      const list = (merged[kind as typeof KINDS[number]] ??= [])
      // A change that is minor for one package and a patch for another is listed once, under the bigger kind.
      for (const item of items) if (!KINDS.some((other) => merged[other]?.includes(item))) list.push(item)
    }
  }
  for (const [index, kind] of KINDS.entries()) {
    merged[kind] = merged[kind]?.filter((item) => !KINDS.slice(0, index).some((bigger) => merged[bigger]?.includes(item)))
  }
  const parts = KINDS.filter((kind) => merged[kind]?.length).map((kind) => `### ${kind}\n\n${merged[kind]!.join('\n')}`)
  return parts.length ? parts.join('\n\n') + '\n' : `Mushin.js ${version}\n`
}

if (process.argv[1]?.endsWith('release-notes.ts')) {
  const version = process.argv[2]
  if (!version) {
    console.error('Usage: tsx scripts/release-notes.ts <version>')
    process.exit(1)
  }
  process.stdout.write(releaseNotes(process.cwd(), version))
}
