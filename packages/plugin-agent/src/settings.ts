import { type Risk, z } from '@mushin/core'
import type { AgentSkill } from './skills'

/** Whether the Agent runs a tool on its own, asks first, or never sees it. */
export type ToolPolicy = 'auto' | 'confirm' | 'off'

/** The default for a risk level: dangerous actions ask first, the rest run. */
export function defaultPolicy(risk: Risk): ToolPolicy {
  return risk === 'dangerous' ? 'confirm' : 'auto'
}

/** A suggestion the user adds to a page. */
export interface CustomRecommendation {
  text: string
  /** What is sent when it is clicked; the text when empty. */
  prompt?: string
  skill?: string
}

/** What the Agent says and offers on one dashboard page; empty fields keep the dashboard's defaults. */
export interface SceneProfile {
  /** Replaces the page's hint, which goes into the <context> block. */
  hint?: string
  /** Replaces the welcome line of an empty conversation. */
  welcome?: string
  /** Shown before the built-in suggestions. */
  recommendations?: CustomRecommendation[]
  /** Ids of built-in suggestions to hide. */
  hidden?: string[]
  /** Skill ids recommended on this page, besides the skills' own scenes. */
  skills?: string[]
  /** Show urgent suggestions above the input while a conversation is open. On unless false. */
  autoShow?: boolean
}

export interface AgentSettings {
  profiles: Record<string, SceneProfile>
  /** Overrides of the default policy, by action name. */
  toolPolicy: Record<string, ToolPolicy>
  /** Built-in and plugin skills the user turned off. */
  disabledSkills: string[]
}

export const SCENE_KEYS = ['overview', 'setup', 'providers', 'bots', 'botDetail', 'flows', 'flowEditor', 'personas', 'knowledge', 'database', 'plugins', 'logs', 'agent'] as const

export const profileInput = z.object({
  hint: z.string().max(1000).optional(),
  welcome: z.string().max(500).optional(),
  recommendations: z.array(z.object({
    text: z.string().trim().min(1).max(200),
    prompt: z.string().max(2000).optional(),
    skill: z.string().optional(),
  })).max(10).optional(),
  hidden: z.array(z.string()).max(30).optional(),
  skills: z.array(z.string()).max(20).optional(),
  autoShow: z.boolean().optional(),
})

export const policyInput = z.enum(['auto', 'confirm', 'off'])

/** Token use of one day, for the daily budget. */
export interface TokenUsage {
  day: string
  input: number
  output: number
}

export function today() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// ---- SKILL.md ----

function unquote(value: string) {
  const text = value.trim()
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('\'') && text.endsWith('\''))) return text.slice(1, -1)
  return text
}

function listValue(value: string) {
  const text = value.trim()
  if (text.startsWith('[') && text.endsWith(']')) return text.slice(1, -1).split(',').map(unquote).filter(Boolean)
  return text.split(/[,\s]+/).map(unquote).filter(Boolean)
}

/**
 * Reads a skill in the `SKILL.md` format of Claude and Codex skills: YAML frontmatter with `name`
 * and `description`, then the instructions in Markdown. Only flat keys and simple lists are read.
 */
export function parseSkillMarkdown(source: string) {
  const text = source.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  const meta: Record<string, string | string[]> = {}
  let body = text
  if (match) {
    body = match[2]
    let listKey: string | undefined
    let folded: string | undefined
    for (const line of match[1].split('\n')) {
      const item = /^\s+-\s+(.*)$/.exec(line)
      if (item && listKey) {
        ;(meta[listKey] as string[]).push(unquote(item[1]))
        continue
      }
      if (folded && /^\s+\S/.test(line)) {
        meta[folded] = `${meta[folded] ? `${meta[folded]} ` : ''}${line.trim()}`
        continue
      }
      listKey = folded = undefined
      const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
      if (!pair) continue
      const [, key, value] = pair
      if (!value.trim()) {
        meta[key] = []
        listKey = key
      } else if (/^[>|][-+]?$/.test(value.trim())) {
        meta[key] = ''
        folded = key
      } else {
        meta[key] = value
      }
    }
  }
  const str = (key: string) => {
    const value = meta[key]
    return typeof value === 'string' ? unquote(value) : undefined
  }
  const list = (key: string) => {
    const value = meta[key]
    if (value === undefined) return undefined
    return Array.isArray(value) ? value : listValue(value)
  }
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
  const name = str('name') ?? heading
  if (!name) throw new Error('The skill has no name: add "name:" to the frontmatter or start with a "# Title"')
  return {
    ...(str('id') ? { id: str('id') } : {}),
    name,
    description: str('description') ?? '',
    instructions: body.trim(),
    ...(str('when_to_use') ?? str('whenToUse') ? { whenToUse: str('when_to_use') ?? str('whenToUse') } : {}),
    ...(list('tools') ?? list('allowed-tools') ? { tools: list('tools') ?? list('allowed-tools') } : {}),
    ...(list('scenes') ? { scenes: list('scenes') } : {}),
  }
}

const yamlString = (value: string) => (/^[\w\s一-鿿,.()（）、，。-]*$/.test(value) && value.trim() === value ? value : JSON.stringify(value))

/** Writes a skill as a `SKILL.md` file. */
export function formatSkillMarkdown(skill: Pick<AgentSkill, 'id' | 'name' | 'description' | 'instructions' | 'whenToUse' | 'tools' | 'scenes'>) {
  const lines = ['---', `name: ${yamlString(skill.name)}`, `description: ${yamlString(skill.description)}`]
  if (skill.whenToUse) lines.push(`when_to_use: ${yamlString(skill.whenToUse)}`)
  if (skill.tools?.length) lines.push(`tools: [${skill.tools.join(', ')}]`)
  if (skill.scenes?.length) lines.push(`scenes: [${skill.scenes.join(', ')}]`)
  lines.push(`id: ${skill.id}`, '---', '', skill.instructions.trim(), '')
  return lines.join('\n')
}
