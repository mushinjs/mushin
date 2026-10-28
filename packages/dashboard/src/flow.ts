import { choiceLabel } from './choices'
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

// Same as the server's command signatures: `<name>` required, `[name]` optional, `:number` a number, `...` the rest.
const SIGNATURE_ARG = /<([^<>\s:.]+)(?::(\w+))?(\.\.\.)?>|\[([^[\]\s:.]+)(?::(\w+))?(\.\.\.)?\]/g

export function parseSignature(usage: string | undefined) {
  if (!usage) return []
  return [...usage.matchAll(SIGNATURE_ARG)].map((match) => {
    const optional = match[4] !== undefined
    return { name: optional ? match[4] : match[1], type: ((optional ? match[5] : match[2]) === 'number' ? 'number' : 'text') as PortType, optional }
  })
}

/** Same rule as the server: classify-style nodes get one exec output per configured label, command nodes one output per argument. */
export function portsOf(type: NodeTypeInfo, config: Record<string, any>): NodePorts {
  let execOut = type.execOut
  if (type.execOutFrom) {
    const list = config?.[type.execOutFrom.key]
    const names = Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string' && !!item.trim()) : []
    execOut = [...new Set([...names.map((name) => name.trim()), ...(type.execOutFrom.extra ?? [])])]
  }
  let outputs = type.outputs
  if (type.outputsFrom) {
    const taken = new Set(outputs.map((port) => port.name))
    const value = config?.[type.outputsFrom.key]
    const args = type.outputsFrom.format === 'names'
      ? (Array.isArray(value) ? value : []).filter((name): name is string => typeof name === 'string' && !!name.trim()).map((name) => ({ name: name.trim(), type: 'any' as const }))
      : parseSignature(String(value ?? ''))
    const extra = args.filter((arg) => !taken.has(arg.name) && !!taken.add(arg.name))
    outputs = [...outputs, ...extra.map((arg) => ({ name: arg.name, type: arg.type, title: arg.name }))]
  }
  return { execIn: type.execIn, execOut, inputs: type.inputs, outputs }
}

export function parseHandle(handle: string | null | undefined) {
  if (!handle) return undefined
  if (handle === EXEC_IN) return { kind: 'exec-in' as const, name: '' }
  if (handle.startsWith('exec:')) return { kind: 'exec-out' as const, name: handle.slice(5) }
}

// Same syntax as the server: `{{<node id>.<output>}}`, `{{sys.<name>}}`, `{{chat|user|flow|run.<variable>}}`.
const REF = /\{\{\s*([\w-]+)\.([\p{L}\p{N}_-]+)\s*\}\}/gu
const WHOLE_REF = /^\s*\{\{\s*([\w-]+)\.([\p{L}\p{N}_-]+)\s*\}\}\s*$/u
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
  event: '#6a4dbd',
  logic: '#d08a00',
  data: '#18a058',
  ai: '#2080f0',
  action: '#d03050',
  manage: '#c2410c',
  platform: '#0f8a8a',
}

export const portColors: Record<PortType, string> = {
  text: '#2080f0',
  number: '#18a058',
  boolean: '#d08a00',
  message: '#8a4dd1',
  any: '#8c8c8c',
}

/** Whether a node type works on the flow's adapter; with no adapter chosen every node does. */
/** Whether a node can be added: it works with the adapter, and nothing it needs is missing. */
export function supports(type: Pick<NodeTypeInfo, 'platforms' | 'unavailable'>, adapter: string | undefined) {
  if (type.unavailable) return false
  return !adapter || !type.platforms?.length || type.platforms.includes(adapter)
}

export const categories: NodeCategory[] = ['trigger', 'event', 'logic', 'data', 'ai', 'action', 'manage', 'platform']

/**
 * Sample OneBot events for test runs, shaped like NapCat sends them. Picking one fills the event
 * JSON, which the user can then edit.
 */
export const eventSamples: Record<string, Record<string, any>> = {
  group_increase: { post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve', group_id: 123456, user_id: 10000, operator_id: 10001 },
  group_decrease: { post_type: 'notice', notice_type: 'group_decrease', sub_type: 'leave', group_id: 123456, user_id: 10000, operator_id: 10000 },
  'notify.poke': { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 123456, user_id: 10000, target_id: 0 },
  group_recall: { post_type: 'notice', notice_type: 'group_recall', group_id: 123456, user_id: 10000, operator_id: 10000, message_id: 1 },
  friend_recall: { post_type: 'notice', notice_type: 'friend_recall', user_id: 10000, message_id: 1 },
  group_ban: { post_type: 'notice', notice_type: 'group_ban', sub_type: 'ban', group_id: 123456, user_id: 10000, operator_id: 10001, duration: 600 },
  group_admin: { post_type: 'notice', notice_type: 'group_admin', sub_type: 'set', group_id: 123456, user_id: 10000 },
  group_upload: { post_type: 'notice', notice_type: 'group_upload', group_id: 123456, user_id: 10000, file: { id: '/abc', name: 'file.zip', size: 1024, busid: 102 } },
  friend_add: { post_type: 'notice', notice_type: 'friend_add', user_id: 10000 },
  'request.friend': { post_type: 'request', request_type: 'friend', user_id: 10000, comment: 'hello', flag: 'test-flag' },
  'request.group': { post_type: 'request', request_type: 'group', sub_type: 'add', group_id: 123456, user_id: 10000, comment: 'hello', flag: 'test-flag' },
  group_card: { post_type: 'notice', notice_type: 'group_card', group_id: 123456, user_id: 10000, card_new: 'new', card_old: 'old' },
  'notify.group_name': { post_type: 'notice', notice_type: 'notify', sub_type: 'group_name', group_id: 123456, user_id: 10001, name_new: 'new name' },
  'notify.title': { post_type: 'notice', notice_type: 'notify', sub_type: 'title', group_id: 123456, user_id: 10000, title: 'title' },
  essence: { post_type: 'notice', notice_type: 'essence', sub_type: 'add', group_id: 123456, message_id: 1, sender_id: 10000, operator_id: 10001 },
  group_msg_emoji_like: { post_type: 'notice', notice_type: 'group_msg_emoji_like', group_id: 123456, user_id: 10000, message_id: 1, likes: [{ emoji_id: '76', count: 1 }], is_add: true },
  'notify.honor': { post_type: 'notice', notice_type: 'notify', sub_type: 'honor', group_id: 123456, user_id: 10000, honor_type: 'talkative' },
  'notify.lucky_king': { post_type: 'notice', notice_type: 'notify', sub_type: 'lucky_king', group_id: 123456, user_id: 10001, target_id: 10000 },
  'notify.profile_like': { post_type: 'notice', notice_type: 'notify', sub_type: 'profile_like', operator_id: 10000, operator_nick: 'Tester', times: 1 },
}

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

/** One short line per filled-in setting, for the node card: every one, unless a limit is given. */
export function configSummary(type: NodeTypeInfo, config: Record<string, any>, locale: string, limit = Infinity) {
  const lines: { key: string; label: string; value: string }[] = []
  for (const [key, field] of Object.entries<JsonSchema>(type.configSchema?.properties ?? {})) {
    const value = config?.[key]
    if (value === undefined || value === null || value === '' || value === false) continue
    if (Array.isArray(value) ? !value.length : typeof value === 'object') continue
    const label = field['x-i18n']?.[locale]?.title ?? field.title ?? humanize(key)
    const options = { ...(field['x-options'] ?? field.items?.['x-options']), ...field['x-i18n']?.[locale]?.options }
    const show = (item: unknown) => options[String(item)] ?? (field['x-choices'] && choiceLabel(field['x-choices'], String(item))) ?? String(item)
    lines.push({ key, label, value: Array.isArray(value) ? value.map(show).join(', ') : value === true ? '✓' : show(value) })
    if (lines.length >= limit) break
  }
  return lines
}
