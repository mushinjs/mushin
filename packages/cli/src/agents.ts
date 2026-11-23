import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { type InstanceConfig, readJson } from '@mushinjs/core'
import { appPackageManager, CLI_VERSION } from './scaffold'
import { SKILLS_SOURCE, SKILLS_TARGET } from './skills'
import { defaultConfig } from './start'

/** An instruction file that a coding agent reads when it is opened in the app folder. */
export interface AgentFile {
  id: string
  /** Relative to the app folder, with `/`. */
  path: string
  /** The tools that read it, for the prompt. */
  tools: string
  /** Chosen when the user picks nothing else. */
  default?: boolean
  /** Text that comes before the generated part when the file is created, such as frontmatter. */
  head?: string
}

export const AGENT_FILES: AgentFile[] = [
  { id: 'agents', path: 'AGENTS.md', tools: 'Codex, Cursor, Amp, OpenCode, Zed and other agents that read AGENTS.md', default: true },
  { id: 'claude', path: 'CLAUDE.md', tools: 'Claude Code', default: true },
  { id: 'gemini', path: 'GEMINI.md', tools: 'Gemini CLI' },
  { id: 'copilot', path: '.github/copilot-instructions.md', tools: 'GitHub Copilot' },
  {
    id: 'cursor',
    path: '.cursor/rules/mushin.mdc',
    tools: 'Cursor rules',
    head: '---\ndescription: What this Mushin.js app is, where things are, and which skill to read for a job\nalwaysApply: true\n---\n\n',
  },
  { id: 'jetbrains', path: '.aiassistant/rules/mushin.md', tools: 'JetBrains AI Assistant' },
]

/** The generated part of a file sits between these lines; text outside them is the user's and is kept. */
export const BLOCK_START = '<!-- mushin:start: written by "mushin agents"; edit outside this block, it is replaced on upgrade -->'
export const BLOCK_END = '<!-- mushin:end -->'
const BLOCK_PREFIX = '<!-- mushin:start'

/** The first line of the AGENTS.md that create-mushin wrote before these files existed. */
const LEGACY_AGENTS = /^# [^\n]*\n\nThis folder is a \[Mushin\.js\]\(https:\/\/github\.com\/mushinjs\/mushin\) app/

/** Ids from a list such as `agents,claude`; `none` gives an empty list. Throws on an unknown id. */
export function parseAgentIds(list: string) {
  const ids = list.split(/[\s,]+/).map((id) => id.trim().toLowerCase()).filter(Boolean)
  if (ids.length === 1 && ids[0] === 'none') return []
  const known = new Set(AGENT_FILES.map((file) => file.id))
  const unknown = ids.filter((id) => !known.has(id))
  if (unknown.length) throw new Error(`Unknown agent file: ${unknown.join(', ')}. Choose from ${[...known].join(', ')}, or none.`)
  return [...new Set(ids)]
}

/** What the guide says about this app. */
export interface AppInfo {
  name: string
  dir: string
  version: string
  packageManager: 'npm' | 'pnpm'
  url: string
  dataDir: string
  pluginDirs: string[]
  /** Official skills: folder name and when to read it. */
  skills: { name: string; when: string }[]
}

/** When to read each official skill, shorter than its description. */
const SKILL_WHEN: Record<string, string> = {
  'mushin-plugin-dev': 'Writing or changing a plugin: a command, a scheduled job, an outside API, a flow node',
  'mushin-flows': 'Building, changing or testing a conversation flow (replies, branches, LLM answers, schedules)',
  'mushin-troubleshoot': 'Something does not work: a silent bot, a flow or command that does not fire, a failed plugin',
  'mushin-operations': 'Upgrading, backing up, restoring, moving to another machine, resetting the admin token',
}

/** The official skills this CLI ships, in a stable order. */
async function officialSkills() {
  const skills: AppInfo['skills'] = []
  // The ones with a short line first, in that order (the most asked-for job leads), then any newer ones.
  const known = Object.keys(SKILL_WHEN)
  const rank = (name: string) => (known.includes(name) ? known.indexOf(name) : known.length)
  for (const name of (await readdir(SKILLS_SOURCE)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    const text = await readFile(join(SKILLS_SOURCE, name, 'SKILL.md'), 'utf8').catch(() => undefined)
    if (text === undefined) continue
    const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
    skills.push({ name, when: SKILL_WHEN[name] ?? description.split(/(?<=\.)\s/)[0]! })
  }
  return skills
}

/** Reads what the guide needs from the app folder. A new app without mushin.config.json gets the defaults. */
export async function appInfo(baseDir: string): Promise<AppInfo> {
  const dir = resolve(baseDir)
  const pkg = await readJson<{ name?: string }>(join(dir, 'package.json'))
  const config = await readJson<InstanceConfig>(join(dir, 'mushin.config.json')) ?? defaultConfig()
  const server = config.plugins.find((entry) => entry.package === '@cordisjs/plugin-server')?.config ?? {}
  const host = !server.host || server.host === '0.0.0.0' ? '127.0.0.1' : String(server.host)
  const storage = config.plugins.find((entry) => entry.package === '@mushinjs/plugin-storage')?.config ?? {}
  // A `${NAME}` reference is only known once .env is read; the guide then names the setting instead.
  const data = typeof storage.dir === 'string' ? storage.dir : 'data'
  return {
    name: pkg?.name ?? 'mushin-app',
    dir,
    version: CLI_VERSION,
    packageManager: appPackageManager(dir),
    url: `http://${host}:${server.port ?? 5160}`,
    dataDir: data.includes('${') ? `${data} (set in .env)` : relativePath(dir, resolve(dir, data)),
    pluginDirs: ['plugins', ...(config.pluginDirs ?? [])],
    skills: await officialSkills(),
  }
}

/** A path for the guide: relative inside the app folder, absolute outside it, always with `/`. */
function relativePath(base: string, path: string) {
  const rel = relative(base, path)
  return (rel && !rel.startsWith('..') && !rel.includes(':') ? rel : path).split(sep).join('/')
}

/**
 * The guide: short on purpose. It says what Mushin.js is, where this app and its packages are, how the
 * parts fit, and which skill to read for a job, so an agent does not have to search for any of it.
 */
export function agentGuide(info: AppInfo) {
  const pm = info.packageManager
  const runScript = (script: string) => (pm === 'npm' && script !== 'start' ? `npm run ${script}` : `${pm} ${script}`)
  const npx = pm === 'pnpm' ? 'pnpm exec' : 'npx'
  const skills = info.skills.map((skill) => `| ${skill.when} | \`${SKILLS_TARGET.split(sep).join('/')}/${skill.name}/SKILL.md\` |`)
  return `# ${info.name}: a Mushin.js app

[Mushin.js](https://github.com/mushinjs/mushin) is an AI-native chatbot framework for QQ (OneBot v11 through NapCat), built on [Cordis](https://github.com/cordiverse/cordis). Every feature is a plugin; a dashboard and its built-in assistant, Fairy, configure the rest.

## This app

- Folder: \`${info.dir}\`
- Mushin.js ${info.version}, installed with ${pm} in \`node_modules/@mushinjs/\`. The plugin API and its types are in \`node_modules/@mushinjs/core\`: read them there instead of searching the web, which may describe another version.
- Dashboard: ${info.url} (\`${runScript('start')}\` prints the sign-in link).
- Data: \`${info.dataDir}/\`. Secrets: \`.env\`. Settings: \`mushin.config.json\`.
- Local plugins: ${info.pluginDirs.map((dir) => `\`${dir}/\``).join(', ')}. Your own skills: \`skills/\`.

## How it fits together

- **App plugins** extend Mushin.js itself; **bot plugins** run once per bot, each bot in its own context. Both are Cordis plugins exporting \`name\`, \`inject\`, \`Config\` (zod) and \`apply(ctx, config)\`.
- **Actions** (\`ctx.actions.define\`) are the one API: the dashboard, Fairy, flows, the HTTP API and the mushin MCP server all call them.
- **Flows** are graphs of nodes that bots run on messages, events and schedules. They are data, changed through actions, not files.
- \`.mcp.json\` connects you to the running Mushin.js through \`mushin mcp\`. Start Mushin.js first; dangerous tools wait for approval in the dashboard.

## Read before the job

| Job | Read |
| --- | --- |
${skills.join('\n')}

## Commands

- \`${runScript('start')}\` starts Mushin.js. \`${runScript('upgrade')}\` updates it; stop it first.
- \`${npx} mushin new plugin <name>\` creates a TypeScript plugin in \`plugins/<name>/\`; \`${runScript('typecheck')}\` checks it.
- \`${npx} mushin agents\` rewrites this guide; \`${npx} mushin skills\` refreshes the skills.

## Rules

- Never print, copy or commit \`.env\`. A setting refers to a secret as \`\${NAME}\`.
- Do not edit files under \`${info.dataDir}/\` while Mushin.js runs; use the dashboard or its actions.
- After changing a plugin, reload it from the Plugins page (or \`plugins.reload\`), or restart Mushin.js.
`
}

/** The text of one file: the guide for AGENTS.md and the like, a pointer to AGENTS.md where the tool can import it. */
export function agentFileBody(file: AgentFile, guide: string, ids: readonly string[]) {
  // Claude Code reads CLAUDE.md, not AGENTS.md, and loads a file named after `@`.
  if (file.id === 'claude' && ids.includes('agents')) return '@AGENTS.md\n'
  return guide
}

function block(body: string) {
  return `${BLOCK_START}\n${body.trimEnd()}\n${BLOCK_END}\n`
}

/** Puts the generated block into a file's text: in place of the old block, else after the user's text. */
export function mergeBlock(current: string | undefined, body: string, head = '') {
  if (current === undefined || !current.trim()) return head + block(body)
  if (LEGACY_AGENTS.test(current)) return block(body)
  const start = current.indexOf(BLOCK_PREFIX)
  const end = current.indexOf(BLOCK_END, start)
  if (start >= 0 && end >= 0) {
    // CRLF files stay CRLF.
    const eol = current.includes('\r\n') ? '\r\n' : '\n'
    const after = current.slice(end + BLOCK_END.length).replace(/^\r?\n/, '')
    return current.slice(0, start) + block(body).replace(/\n/g, eol) + after
  }
  return `${current.trimEnd()}\n\n${block(body)}`
}

/** The ids of the files in this app that hold a generated block. */
export async function agentFilesIn(baseDir: string) {
  const ids: string[] = []
  for (const file of AGENT_FILES) {
    const text = await readFile(join(baseDir, file.path), 'utf8').catch(() => '')
    if (text.includes(BLOCK_END)) ids.push(file.id)
  }
  return ids
}

/**
 * Writes the chosen files. Each keeps the user's text outside the generated block.
 * With `refresh`, only files that already have a block are rewritten, and only when they changed (for starts and upgrades).
 */
export async function writeAgentFiles(baseDir: string, ids: readonly string[], options: { refresh?: boolean } = {}) {
  const info = await appInfo(baseDir)
  const guide = agentGuide(info)
  const written: string[] = []
  for (const file of AGENT_FILES.filter((item) => ids.includes(item.id))) {
    const target = join(baseDir, file.path)
    const current = await readFile(target, 'utf8').catch(() => undefined)
    if (options.refresh && !current?.includes(BLOCK_END)) continue
    const next = mergeBlock(current, agentFileBody(file, guide, ids), file.head)
    if (next === current) continue
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, next)
    written.push(file.path)
  }
  return written
}

/** Brings the generated files up to date with this version and folder, and turns an old create-mushin AGENTS.md into one. */
export async function refreshAgentFiles(baseDir: string, options: { legacy?: boolean } = {}) {
  const ids = await agentFilesIn(baseDir)
  if (options.legacy && !ids.includes('agents')) {
    const text = await readFile(join(baseDir, 'AGENTS.md'), 'utf8').catch(() => '')
    // Replaced in full: it was generated, and the new guide covers what it said.
    if (LEGACY_AGENTS.test(text)) return writeAgentFiles(baseDir, [...ids, 'agents'])
  }
  if (!ids.length) return []
  return writeAgentFiles(baseDir, ids, { refresh: true })
}

/** The files chosen when there is nobody to ask: the ones the app has, else the defaults. */
export async function defaultAgentIds(baseDir: string) {
  const existing = await agentFilesIn(baseDir)
  if (existing.length) return existing
  return AGENT_FILES.filter((file) => file.default || (file.id === 'agents' && existsSync(join(baseDir, 'AGENTS.md')))).map((file) => file.id)
}
