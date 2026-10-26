import { z } from '@mushin/core'
import type { FlowEdge, FlowNode } from '@mushin/plugin-flows'

/**
 * The settings this plugin had before LLM chat became a flow. Bots that still carry them (or API
 * callers that send them) get an equivalent flow; the settings themselves are no longer used.
 */
export const LegacyConfig = z.object({
  trigger: z.enum(['mention', 'always']).default('mention'),
  systemPrompt: z.string().default(''),
  provider: z.string().optional(),
  model: z.string().optional(),
  historySize: z.number().int().min(0).max(50).default(10),
  maxTokens: z.number().int().min(64).max(64000).default(2000),
  privateChat: z.boolean().default(true),
  groups: z.array(z.string()).default([]),
  ignoreUsers: z.array(z.string()).default([]),
  cooldown: z.number().min(0).default(3),
  userLimit: z.number().int().min(0).default(5),
  userWindow: z.number().min(1).default(60),
  limitNotice: z.string().default(''),
  dailyReplies: z.number().int().min(0).default(300),
  dailyTokens: z.number().int().min(0).default(0),
  maxInputChars: z.number().int().min(50).default(1000),
})

export type LegacyConfig = z.infer<typeof LegacyConfig>

export const LEGACY_KEYS = Object.keys(LegacyConfig.shape)

/** The system prompt the plugin used to fill in; the flow leaves it out so a persona can speak. */
const OLD_DEFAULT_PROMPT = 'You are a friendly chat bot in a QQ chat. Keep replies short and natural, and answer in the language the user writes in.'

/** Only the legacy settings of a plugin config. */
export function legacySettings(config: Record<string, unknown> | undefined) {
  return Object.fromEntries(Object.entries(config ?? {}).filter(([key]) => LEGACY_KEYS.includes(key)))
}

type NodeSpec = Omit<FlowNode, 'position'>
type EdgeSpec = Omit<FlowEdge, 'id'>

/**
 * The flow equivalent to a set of settings: on message → cooldown → rate limit → daily quota →
 * ask the LLM (with chat history) → reply. Steps whose limit is off are left out.
 */
export function chatFlow(settings: LegacyConfig): { nodes: NodeSpec[]; edges: EdgeSpec[] } {
  const nodes: NodeSpec[] = []
  const edges: EdgeSpec[] = []
  let from: { node: string; exit: string } | undefined
  const step = (node: NodeSpec, exit = 'next') => {
    nodes.push(node)
    if (from) edges.push({ source: from.node, sourceHandle: `exec:${from.exit}`, target: node.id, targetHandle: 'exec' })
    from = { node: node.id, exit }
  }

  const when = settings.trigger === 'always'
    ? (settings.privateChat ? 'any' : 'group')
    : (settings.privateChat ? 'mention' : 'groupMention')
  // Below other flows, so commands and keyword flows answer first.
  step({ id: 'message', type: 'trigger.message', label: '收到消息', priority: -100, config: { when, groups: settings.groups, ignoreUsers: settings.ignoreUsers, skipCommands: true } })
  if (settings.cooldown > 0) step({ id: 'cooldown', type: 'logic.cooldown', label: '会话冷却', config: { seconds: settings.cooldown, scope: 'chat' } }, 'ready')
  if (settings.userLimit > 0) {
    step({ id: 'rate', type: 'logic.rateLimit', label: '每人限额', config: { limit: settings.userLimit, seconds: settings.userWindow, per: 'user' } }, 'ok')
    if (settings.limitNotice) {
      nodes.push(
        { id: 'firstLimited', type: 'logic.if', label: '第一次超限', config: {}, inputs: { condition: '{{rate.first}}' } },
        { id: 'notice', type: 'action.reply', label: '限流提示', config: { text: settings.limitNotice, quote: false } },
      )
      edges.push(
        { source: 'rate', sourceHandle: 'exec:limited', target: 'firstLimited', targetHandle: 'exec' },
        { source: 'firstLimited', sourceHandle: 'exec:true', target: 'notice', targetHandle: 'exec' },
      )
    }
  }
  if (settings.dailyReplies > 0 || settings.dailyTokens > 0) {
    step({ id: 'quota', type: 'logic.dailyQuota', label: '每日额度', config: { times: settings.dailyReplies, tokens: settings.dailyTokens, per: 'flow' } }, 'ok')
  }
  step({
    id: 'ask',
    type: 'ai.chat',
    label: '询问大模型',
    config: {
      usePersona: true,
      systemPrompt: settings.systemPrompt === OLD_DEFAULT_PROMPT ? '' : settings.systemPrompt,
      history: settings.historySize,
      historySource: 'chat',
      maxTokens: settings.maxTokens,
      maxInputChars: settings.maxInputChars,
      timeout: 45,
      ...(settings.provider ? { provider: settings.provider } : {}),
      ...(settings.model ? { model: settings.model } : {}),
    },
  })
  step({ id: 'reply', type: 'action.reply', label: '回复', config: { text: '', quote: false }, inputs: { text: '{{ask.reply}}' } })
  return { nodes, edges }
}
