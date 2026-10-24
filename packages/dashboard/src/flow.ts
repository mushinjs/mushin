import type { JsonSchema, NodeCategory, NodeTypeInfo, PortDef, PortType } from './types'
import { humanize } from './utils'

// Handle ids match the server: `exec` is the exec input and `exec:<name>` an exec output.
// Edges only say what runs next; values move by reference, e.g. `{{n1.text}}`.
export const EXEC_IN = 'exec'
export const execOutHandle = (name: string) => `exec:${name}`

export interface NodePorts {
  execIn: boolean
  execOut: string[]
  inputs: PortDef[]
  outputs: PortDef[]
}

/** Same rule as the server: classify-style nodes get one exec output per configured label. */
export function portsOf(type: NodeTypeInfo, config: Record<string, any>): NodePorts {
  let execOut = type.execOut
  if (type.execOutFrom) {
    const list = config?.[type.execOutFrom.key]
    const names = Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string' && !!item.trim()) : []
    execOut = [...new Set([...names.map((name) => name.trim()), ...(type.execOutFrom.extra ?? [])])]
  }
  return { execIn: type.execIn, execOut, inputs: type.inputs, outputs: type.outputs }
}

export function parseHandle(handle: string | null | undefined) {
  if (!handle) return undefined
  if (handle === EXEC_IN) return { kind: 'exec-in' as const, name: '' }
  if (handle.startsWith('exec:')) return { kind: 'exec-out' as const, name: handle.slice(5) }
}

// Same syntax as the server: `{{<node id>.<output>}}`, `{{sys.<name>}}`, `{{chat|user|flow|run.<variable>}}`.
const REF = /\{\{\s*([\w-]+)\.([\w-]+)\s*\}\}/g
const WHOLE_REF = /^\s*\{\{\s*([\w-]+)\.([\w-]+)\s*\}\}\s*$/
export const SCOPES = ['chat', 'user', 'flow', 'run']

export const refOf = (head: string, name: string) => `{{${head}.${name}}}`
export const wholeRef = (text: string) => {
  const match = WHOLE_REF.exec(text)
  return match ? { head: match[1], name: match[2] } : undefined
}
export const refsIn = (text: string) => [...text.matchAll(REF)].map((match) => ({ head: match[1], name: match[2] }))

/** Values of the incoming message, readable anywhere as `{{sys.<name>}}`. */
export const sysPorts: PortDef[] = [
  { name: 'text', type: 'text', title: { en: 'Message', 'zh-CN': '消息' } },
  { name: 'user', type: 'text', title: { en: 'User name', 'zh-CN': '用户名' } },
  { name: 'userId', type: 'text', title: { en: 'User id', 'zh-CN': '用户 ID' } },
  { name: 'groupId', type: 'text', title: { en: 'Group id', 'zh-CN': '群号' } },
  { name: 'isPrivate', type: 'boolean', title: { en: 'Private chat', 'zh-CN': '是私聊' } },
  { name: 'mentioned', type: 'boolean', title: { en: 'Mentions the bot', 'zh-CN': '@ 了机器人' } },
  { name: 'message', type: 'message', title: { en: 'Message content', 'zh-CN': '消息内容' } },
]

/** Shallow defaults from a config JSON Schema, for a freshly added node. */
export function schemaDefaults(schema: JsonSchema | undefined) {
  const config: Record<string, any> = {}
  for (const [key, field] of Object.entries<JsonSchema>(schema?.properties ?? {})) {
    if (field.default !== undefined) config[key] = JSON.parse(JSON.stringify(field.default))
  }
  return config
}

export const categoryColors: Record<NodeCategory, string> = {
  trigger: '#3b4a8c',
  logic: '#d08a00',
  data: '#18a058',
  ai: '#2080f0',
  action: '#d03050',
}

export const portColors: Record<PortType, string> = {
  text: '#2080f0',
  number: '#18a058',
  boolean: '#d08a00',
  message: '#8a4dd1',
  any: '#8c8c8c',
}

export const categories: NodeCategory[] = ['trigger', 'logic', 'data', 'ai', 'action']

export interface FlowTemplate {
  id: string
  nodes: { id: string; type: string; label?: string; config?: Record<string, any>; inputs?: Record<string, string> }[]
  edges: { source: string; sourceHandle: string; target: string; targetHandle: string }[]
}

/** Starting points for a new flow; positions are laid out by the server. */
export const flowTemplates: FlowTemplate[] = [
  { id: 'blank', nodes: [], edges: [] },
  {
    id: 'keyword',
    nodes: [
      { id: 'trigger', type: 'trigger.keyword', config: { keywords: ['hello'], mode: 'contains' } },
      { id: 'reply', type: 'action.reply', config: { text: 'Hi, {user}!' } },
    ],
    edges: [{ source: 'trigger', sourceHandle: 'exec:next', target: 'reply', targetHandle: 'exec' }],
  },
  {
    id: 'llm',
    nodes: [
      { id: 'trigger', type: 'trigger.message', config: { when: 'mention' } },
      { id: 'ask', type: 'ai.chat', label: 'Ask the LLM' },
      { id: 'reply', type: 'action.reply', inputs: { text: '{{ask.reply}}' } },
    ],
    edges: [
      { source: 'trigger', sourceHandle: 'exec:next', target: 'ask', targetHandle: 'exec' },
      { source: 'ask', sourceHandle: 'exec:next', target: 'reply', targetHandle: 'exec' },
    ],
  },
  {
    id: 'intent',
    nodes: [
      { id: 'trigger', type: 'trigger.message', config: { when: 'mention' } },
      { id: 'classify', type: 'ai.classify', config: { labels: ['greeting', 'question'] } },
      { id: 'hello', type: 'action.reply', config: { text: 'Hello, {user}!' } },
      { id: 'answer', type: 'ai.chat' },
      { id: 'reply', type: 'action.reply', inputs: { text: '{{answer.reply}}' } },
    ],
    edges: [
      { source: 'trigger', sourceHandle: 'exec:next', target: 'classify', targetHandle: 'exec' },
      { source: 'classify', sourceHandle: 'exec:greeting', target: 'hello', targetHandle: 'exec' },
      { source: 'classify', sourceHandle: 'exec:question', target: 'answer', targetHandle: 'exec' },
      { source: 'answer', sourceHandle: 'exec:next', target: 'reply', targetHandle: 'exec' },
    ],
  },
]

/** One short line per filled-in setting, for the node card. */
export function configSummary(type: NodeTypeInfo, config: Record<string, any>, locale: string, limit = 2) {
  const lines: { key: string; label: string; value: string }[] = []
  for (const [key, field] of Object.entries<JsonSchema>(type.configSchema?.properties ?? {})) {
    const value = config?.[key]
    if (value === undefined || value === null || value === '' || value === false) continue
    if (Array.isArray(value) ? !value.length : typeof value === 'object') continue
    const label = field['x-i18n']?.[locale]?.title ?? field.title ?? humanize(key)
    lines.push({ key, label, value: Array.isArray(value) ? value.join(', ') : value === true ? '✓' : String(value) })
    if (lines.length >= limit) break
  }
  return lines
}
