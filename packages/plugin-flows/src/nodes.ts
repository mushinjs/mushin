import { type ChannelInfo, field, segmentsToText, z } from '@mushin/core'
import { commandMatches, parseArgs, parseSignature, roleAtLeast, splitCommand, usageReply } from '@mushin/plugin-bots'
import { FlowError, TriggerReply } from './engine'
import type { FlowSession, LlmLike, NodeContext, NodeType, PersonaLike, VariableScope } from './types'

const scopeField = z.enum(['chat', 'user', 'flow', 'run']).default('chat').meta(field(
  'Scope',
  'Per chat: each group or private chat has its own. Per user: each person has their own. Shared: one for everyone. This message: only during this run.',
  { 'zh-CN': { title: '作用范围', description: '每个会话：每个群或私聊各自一份。每个用户：每人一份。全体共享：所有人共用一份。仅本次：只在这次运行中有效。', options: { chat: '每个会话', user: '每个用户', flow: '全体共享', run: '仅本次' } } },
  { options: { chat: 'Per chat', user: 'Per user', flow: 'Shared', run: 'This message' } },
))

const nameField = z.string().min(1).default('count').meta(field('Variable name', undefined, { 'zh-CN': { title: '变量名' } }))

const sessionOutputs = [
  { name: 'text', type: 'text' as const, title: { en: 'Message', 'zh-CN': '消息' } },
  { name: 'userName', type: 'text' as const, title: { en: 'User name', 'zh-CN': '用户名' } },
  { name: 'userId', type: 'text' as const, title: { en: 'User id', 'zh-CN': '用户 ID' } },
]

function sessionValues(session: FlowSession) {
  return { text: session.text, userName: session.user.name ?? session.user.id, userId: session.user.id }
}

/** Fills `{name}` placeholders; unknown names stay as written. */
export function fillTemplate(template: string, values: Record<string, unknown>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (values[key] === undefined ? match : String(values[key])))
}

const regexCache = new Map<string, RegExp | undefined>()
function compileRegex(pattern: string, flags: string) {
  const key = `${flags}/${pattern}`
  if (!regexCache.has(key)) {
    try {
      regexCache.set(key, new RegExp(pattern, flags))
    } catch {
      regexCache.set(key, undefined)
    }
  }
  return regexCache.get(key)
}

const messageTrigger: NodeType = {
  kind: 'trigger',
  type: 'trigger.message',
  category: 'trigger',
  title: { en: 'On message', 'zh-CN': '收到消息' },
  description: { en: 'Starts when a message arrives', 'zh-CN': '收到消息时开始' },
  config: z.object({
    when: z.enum(['any', 'mention', 'groupMention', 'private', 'group']).default('any').meta(field(
      'Which messages',
      '@ me or private: @-mentions in groups and every private message. @ me in groups: only @-mentions in groups.',
      { 'zh-CN': { title: '哪些消息', description: '@我或私聊：群里 @ 机器人的消息，以及所有私聊。群里@我：只有群里 @ 机器人的消息。', options: { any: '所有消息', mention: '@我或私聊', groupMention: '群里@我', private: '仅私聊', group: '仅群聊' } } },
      { options: { any: 'All', mention: '@ me or private', groupMention: '@ me in groups', private: 'Private only', group: 'Groups only' } },
    )),
    groups: z.array(z.string()).default([]).meta(field('Only these groups', 'Group ids; empty means every group. Private chats are not affected.', {
      'zh-CN': { title: '仅限这些群', description: '群号；留空表示所有群。不影响私聊。' },
    })),
    ignoreUsers: z.array(z.string()).default([]).meta(field('Ignore users', 'User ids that never start it, such as other bots', {
      'zh-CN': { title: '忽略用户', description: '永远不会触发的 QQ 号，例如其他机器人' },
    })),
    skipCommands: z.boolean().default(false).meta(field('Skip commands', 'Messages that run a command the bot knows (such as /help) do not start it', {
      'zh-CN': { title: '跳过指令', description: '运行机器人已知指令（如 /help）的消息不会触发' },
    })),
  }),
  outputs: [...sessionOutputs, { name: 'isPrivate', type: 'boolean', title: { en: 'Private chat', 'zh-CN': '是私聊' } }],
  match({ config, session }) {
    const ok = config.when === 'any'
      || (config.when === 'private' && session.isDirect)
      || (config.when === 'group' && !session.isDirect)
      || (config.when === 'mention' && (session.isDirect || session.mentioned))
      || (config.when === 'groupMention' && !session.isDirect && session.mentioned)
    if (!ok) return
    if (!session.isDirect && config.groups?.length && !config.groups.includes(session.channel.id)) return
    if (config.ignoreUsers?.includes(session.user.id)) return
    if (config.skipCommands && session.command?.entry) return
    return { ...sessionValues(session), isPrivate: session.isDirect }
  },
}

const keywordTrigger: NodeType = {
  kind: 'trigger',
  type: 'trigger.keyword',
  category: 'trigger',
  title: { en: 'Keyword', 'zh-CN': '关键词' },
  description: { en: 'Starts when the message contains, starts with or equals a keyword', 'zh-CN': '消息包含、以之开头或等于某个关键词时开始' },
  config: z.object({
    keywords: z.array(z.string()).default(['hello']).meta(field('Keywords', 'Any one of these matches', {
      'zh-CN': { title: '关键词', description: '匹配其中任意一个' },
    })),
    mode: z.enum(['contains', 'startsWith', 'exact']).default('contains').meta(field('Match', undefined, {
      'zh-CN': { title: '匹配方式', options: { contains: '包含', startsWith: '匹配开头', exact: '匹配全部' } },
    }, { options: { contains: 'Contains', startsWith: 'Starts with', exact: 'Whole message' } })),
    ignoreCase: z.boolean().default(true).meta(field('Ignore case', undefined, { 'zh-CN': { title: '忽略大小写' } })),
  }),
  outputs: [
    ...sessionOutputs,
    { name: 'keyword', type: 'text', title: { en: 'Keyword', 'zh-CN': '关键词' } },
    { name: 'rest', type: 'text', title: { en: 'Text after keyword', 'zh-CN': '关键词后的内容' } },
  ],
  match({ config, session }) {
    const text = session.text
    const fold = (value: string) => (config.ignoreCase ? value.toLowerCase() : value)
    for (const keyword of config.keywords as string[]) {
      if (!keyword) continue
      const haystack = fold(text)
      const needle = fold(keyword)
      const index = haystack.indexOf(needle)
      const ok = config.mode === 'exact' ? haystack.trim() === needle : config.mode === 'startsWith' ? haystack.startsWith(needle) : index >= 0
      if (!ok) continue
      const rest = index >= 0 ? (text.slice(0, index) + text.slice(index + keyword.length)).trim() : ''
      return { ...sessionValues(session), keyword, rest }
    }
  },
}

/** The sender's role on the bot; sessions without `role()` fall back to `isAdmin`. */
export function senderRole(session: FlowSession) {
  return session.role ? session.role() : session.isAdmin ? 'admin' : undefined
}

/** A command name as stored: without a leading prefix or spaces. */
export const commandName = (name: unknown) => String(name ?? '').trim().replace(/^[/#!！]+/, '')

const commandOutputs = [
  ...sessionOutputs,
  { name: 'command', type: 'text' as const, title: { en: 'Command', 'zh-CN': '指令' } },
  { name: 'rest', type: 'text' as const, title: { en: 'Text after command', 'zh-CN': '指令后的内容' } },
  { name: 'args', type: 'any' as const, title: { en: 'All arguments', 'zh-CN': '全部参数' } },
]
const commandOutputNames = new Set(commandOutputs.map((port) => port.name))

export const commandTrigger: NodeType = {
  kind: 'trigger',
  type: 'trigger.command',
  category: 'trigger',
  title: { en: 'Command', 'zh-CN': '指令' },
  description: {
    en: 'Starts on a command such as /checkin. Commands are listed in the bot\'s /help; arguments become outputs.',
    'zh-CN': '收到 /签到 这样的指令时开始。指令会列在机器人的 /help 里，参数会成为输出。',
  },
  config: z.object({
    name: z.string().min(1).default('hello').meta(field('Command', 'Without the prefix, e.g. checkin', {
      'zh-CN': { title: '指令名', description: '不带前缀，例如 签到' },
    })),
    aliases: z.array(z.string()).default([]).meta(field('Aliases', 'Other names that run the same command', {
      'zh-CN': { title: '别名', description: '也能触发这条指令的其他名字' },
    })),
    description: z.string().default('').meta(field('Description', 'Shown in /help', { 'zh-CN': { title: '说明', description: '显示在 /help 里' } })),
    usage: z.string().default('').meta(field(
      'Arguments',
      'e.g. <score:number> [note]: <> required, [] optional, :number a number; the last text argument takes the rest. Each argument becomes an output of the same name.',
      { 'zh-CN': { title: '参数', description: '例如 <分数:number> [备注]：<> 必填，[] 可选，:number 表示数字，最后一个文本参数接收剩余内容。每个参数都会成为同名输出。' } },
      { hint: 'inline' },
    )),
    usageHint: z.boolean().default(true).meta(field('Reply with usage on wrong arguments', undefined, {
      'zh-CN': { title: '参数不对时回复用法' },
    })),
    showInHelp: z.boolean().default(true).meta(field('Show in /help', undefined, { 'zh-CN': { title: '显示在 /help 里' } })),
    permission: z.enum(['all', 'admin', 'master']).default('all').meta(field('Who can use it', 'Masters and admins are set on the bot\'s Permissions tab; others get no answer', {
      'zh-CN': { title: '谁可以使用', description: '主人和管理员在机器人的「权限」页设置；没有权限的人不会收到回应', options: { all: '所有人', admin: '管理员和主人', master: '仅主人' } },
    }, { options: { all: 'Everyone', admin: 'Admins and masters', master: 'Masters only' } })),
  }),
  outputs: commandOutputs,
  outputsFrom: { key: 'usage', format: 'signature' },
  match({ config, session }) {
    const parsed = session.command ?? splitCommand(session.text)
    const name = commandName(config.name)
    if (!parsed || !name || !commandMatches({ name, aliases: (config.aliases as string[]).map(commandName) }, parsed.name)) return
    if ((config.permission === 'admin' || config.permission === 'master') && !roleAtLeast(senderRole(session), config.permission)) return
    const args = parseArgs(parseSignature(config.usage), parsed.rest)
    if (!args.ok) return config.usageHint ? new TriggerReply(usageReply({ name, usage: config.usage }, parsed.prefix)) : undefined
    const named = Object.fromEntries(Object.entries(args.values).filter(([key]) => !commandOutputNames.has(key)))
    return { ...sessionValues(session), command: name, rest: parsed.rest, args: args.values, ...named }
  },
}

const regexTrigger: NodeType = {
  kind: 'trigger',
  type: 'trigger.regex',
  category: 'trigger',
  title: { en: 'Pattern', 'zh-CN': '正则匹配' },
  description: { en: 'Starts when the message matches a regular expression', 'zh-CN': '消息匹配正则表达式时开始' },
  config: z.object({
    pattern: z.string().min(1).default('^/roll (\\d+)$')
      .refine((value) => !!compileRegex(value, ''), 'not a valid regular expression')
      .meta(field('Pattern', 'JavaScript regular expression; capture groups become outputs', {
        'zh-CN': { title: '表达式', description: 'JavaScript 正则表达式；捕获组会成为输出' },
      })),
    flags: z.string().regex(/^[gimsuy]*$/).default('i').meta(field('Flags', undefined, { 'zh-CN': { title: '标志' } })),
  }),
  outputs: [
    ...sessionOutputs,
    { name: 'match', type: 'text', title: { en: 'Whole match', 'zh-CN': '完整匹配' } },
    { name: 'group1', type: 'text', title: { en: 'Group 1', 'zh-CN': '分组 1' } },
    { name: 'group2', type: 'text', title: { en: 'Group 2', 'zh-CN': '分组 2' } },
    { name: 'group3', type: 'text', title: { en: 'Group 3', 'zh-CN': '分组 3' } },
  ],
  match({ config, session }) {
    const regex = compileRegex(config.pattern, String(config.flags).replace('g', ''))
    const found = regex?.exec(session.text)
    if (!found) return
    return { ...sessionValues(session), match: found[0], group1: found[1] ?? '', group2: found[2] ?? '', group3: found[3] ?? '' }
  },
}

const ifNode: NodeType = {
  kind: 'action',
  type: 'logic.if',
  category: 'logic',
  title: { en: 'If', 'zh-CN': '条件分支' },
  description: { en: 'Continues on "true" or "false"', 'zh-CN': '根据条件走 true 或 false 分支' },
  inputs: [{ name: 'condition', type: 'boolean', title: { en: 'Condition', 'zh-CN': '条件' } }],
  execOut: ['true', 'false'],
  run: ({ inputs }) => ({ exec: inputs.condition ? 'true' : 'false' }),
}

const compareNode: NodeType = {
  kind: 'action',
  type: 'logic.compare',
  category: 'logic',
  title: { en: 'Compare', 'zh-CN': '条件判断' },
  description: { en: 'Compares A with B (or with the fixed value when B is not set) and continues on "true" or "false"', 'zh-CN': '比较 A 与 B（未设置 B 时与固定值比较），走 true 或 false 分支' },
  config: z.object({
    op: z.enum(['equals', 'notEquals', 'contains', 'startsWith', 'endsWith', 'greater', 'less', 'matches']).default('equals')
      .meta(field('Operator', undefined, { 'zh-CN': { title: '运算' } })),
    value: z.string().default('').meta(field('Fixed value', 'Used when B is not set', {
      'zh-CN': { title: '固定值', description: '未设置 B 时使用' },
    })),
    ignoreCase: z.boolean().default(true).meta(field('Ignore case', undefined, { 'zh-CN': { title: '忽略大小写' } })),
  }),
  inputs: [
    { name: 'a', type: 'any', title: 'A' },
    { name: 'b', type: 'any', title: 'B' },
  ],
  outputs: [{ name: 'result', type: 'boolean', title: { en: 'Result', 'zh-CN': '结果' } }],
  execOut: ['true', 'false'],
  run({ config, inputs }) {
    const right = inputs.b === undefined ? config.value : inputs.b
    const fold = (value: unknown) => (config.ignoreCase ? String(value ?? '').toLowerCase() : String(value ?? ''))
    const a = fold(inputs.a)
    const b = fold(right)
    const result = (() => {
      switch (config.op) {
        case 'equals': return a === b
        case 'notEquals': return a !== b
        case 'contains': return a.includes(b)
        case 'startsWith': return a.startsWith(b)
        case 'endsWith': return a.endsWith(b)
        case 'greater': return Number(inputs.a) > Number(right)
        case 'less': return Number(inputs.a) < Number(right)
        case 'matches': return !!compileRegex(String(right), config.ignoreCase ? 'i' : '')?.test(String(inputs.a ?? ''))
      }
      return false
    })()
    return { exec: result ? 'true' : 'false', outputs: { result } }
  },
}

const randomNode: NodeType = {
  kind: 'action',
  type: 'logic.random',
  category: 'logic',
  title: { en: 'Random chance', 'zh-CN': '随机' },
  description: { en: 'Continues on "yes" with the given chance', 'zh-CN': '按设定概率走 yes 分支' },
  config: z.object({
    percent: z.number().min(0).max(100).default(50).meta(field('Chance (%)', undefined, { 'zh-CN': { title: '概率（%）' } })),
  }),
  execOut: ['yes', 'no'],
  run: ({ config }) => ({ exec: Math.random() * 100 < config.percent ? 'yes' : 'no' }),
}

const cooldownNode: NodeType = {
  kind: 'action',
  type: 'logic.cooldown',
  category: 'logic',
  title: { en: 'Cooldown', 'zh-CN': '冷却' },
  description: { en: 'Continues on "ready" at most once per period, otherwise on "cooling"', 'zh-CN': '每个周期最多走一次 ready，其余走 cooling' },
  config: z.object({
    seconds: z.number().min(0).default(30).meta(field('Seconds', undefined, { 'zh-CN': { title: '秒数' } })),
    scope: scopeField,
  }),
  execOut: ['ready', 'cooling'],
  run({ config, vars, node }) {
    const key = `__cooldown:${node.id}`
    const last = Number(vars.get(config.scope as VariableScope, key) ?? 0)
    if (Date.now() - last < config.seconds * 1000) return { exec: 'cooling' }
    vars.set(config.scope as VariableScope, key, Date.now())
    return { exec: 'ready' }
  },
}

const perField = (fallback: 'user' | 'chat' | 'flow') => z.enum(['user', 'chat', 'flow']).default(fallback).meta(field(
  'Count',
  'Per user: each person has their own count. Per chat: each group or private chat. Shared: one count for everyone on the bot.',
  { 'zh-CN': { title: '计数方式', description: '每个用户：每人单独计数。每个会话：每个群或私聊单独计数。全体共享：机器人上所有人共用一个计数。', options: { user: '每个用户', chat: '每个会话', flow: '全体共享' } } },
  { options: { user: 'Per user', chat: 'Per chat', flow: 'Shared' } },
))

/** The key a per-user, per-chat or shared counter of a node uses. */
function counterKey(context: NodeContext<any>, per: string) {
  const who = per === 'user' ? `user:${context.session.user.id}` : per === 'chat' ? `${context.session.channel.type}:${context.session.channel.id}` : 'all'
  return `${context.flow.id}|${context.bot?.id ?? ''}|${context.node.id}|${who}`
}

const rateLimitNode: NodeType = {
  kind: 'action',
  type: 'logic.rateLimit',
  category: 'logic',
  title: { en: 'Rate limit', 'zh-CN': '频率限制' },
  description: {
    en: 'Continues on "ok" at most this many times within the window (per user, per chat or shared), otherwise on "limited". "first" is true for the first limited message in the window, to send a notice only once.',
    'zh-CN': '时间窗口内最多走这么多次 ok（按用户、会话或全体计数），超出走 limited。窗口内第一次被限制时 first 为 true，可以只提示一次。',
  },
  config: z.object({
    limit: z.number().int().min(1).default(5).meta(field('Times', undefined, { 'zh-CN': { title: '次数' } })),
    seconds: z.number().min(1).default(60).meta(field('Window (seconds)', undefined, { 'zh-CN': { title: '时间窗口（秒）' } })),
    per: perField('user'),
  }),
  outputs: [
    { name: 'remaining', type: 'number', title: { en: 'Times left', 'zh-CN': '剩余次数' } },
    { name: 'retryAfter', type: 'number', title: { en: 'Seconds until the next is allowed', 'zh-CN': '距下次可用的秒数' } },
    { name: 'first', type: 'boolean', title: { en: 'First time limited in this window', 'zh-CN': '本窗口内第一次被限制' } },
  ],
  execOut: ['ok', 'limited'],
  run(context) {
    const { config, vars } = context
    const key = `__rate:${counterKey(context, config.per)}`
    const now = Date.now()
    const window = config.seconds * 1000
    const state = (vars.get('flow', key) as { hits: number[]; noticed?: number } | undefined) ?? { hits: [] }
    const hits = state.hits.filter((at) => now - at < window)
    if (hits.length >= config.limit) {
      const first = !state.noticed || now - state.noticed >= window
      vars.set('flow', key, { hits, noticed: first ? now : state.noticed })
      return { exec: 'limited', outputs: { remaining: 0, retryAfter: Math.ceil((hits[0] + window - now) / 1000), first } }
    }
    hits.push(now)
    vars.set('flow', key, { hits, ...(state.noticed && now - state.noticed < window ? { noticed: state.noticed } : {}) })
    return { exec: 'ok', outputs: { remaining: config.limit - hits.length, retryAfter: 0, first: false } }
  },
}

const dailyQuotaNode: NodeType = {
  kind: 'action',
  type: 'logic.dailyQuota',
  category: 'logic',
  title: { en: 'Daily quota', 'zh-CN': '每日额度' },
  description: {
    en: 'Continues on "ok" until today\'s count or the tokens of the LLM replies after it reach the limit, then on "exhausted" until local midnight. Each "ok" counts once; LLM nodes later in the run add their tokens. Counts survive restarts.',
    'zh-CN': '今天的次数或之后大模型回复用掉的 Token 达到上限前走 ok，之后到本地零点前都走 exhausted。每走一次 ok 计一次；之后的大模型节点会累加 Token。重启后计数仍保留。',
  },
  config: z.object({
    times: z.number().int().min(0).default(300).meta(field('Times per day', '0 means no limit', { 'zh-CN': { title: '每日次数', description: '0 表示不限制' } })),
    tokens: z.number().int().min(0).default(0).meta(field('Tokens per day', 'As reported by the provider; 0 means no limit', { 'zh-CN': { title: '每日 Token', description: '以提供商报告为准；0 表示不限制' } })),
    per: perField('flow'),
  }),
  outputs: [
    { name: 'used', type: 'number', title: { en: 'Times used today', 'zh-CN': '今日已用次数' } },
    { name: 'tokens', type: 'number', title: { en: 'Tokens used today', 'zh-CN': '今日已用 Token' } },
  ],
  execOut: ['ok', 'exhausted'],
  run(context) {
    const { config, usage, run, logger } = context
    const key = counterKey(context, config.per)
    const today = usage.get(key)
    if ((config.times > 0 && today.count >= config.times) || (config.tokens > 0 && today.tokens >= config.tokens)) {
      return { exec: 'exhausted', outputs: { used: today.count, tokens: today.tokens } }
    }
    const counted = usage.add(key, { count: 1 })
    ;(run.onTokens ??= []).push((tokens) => {
      const after = usage.add(key, { tokens })
      if (config.tokens > 0 && after.tokens >= config.tokens && after.tokens - tokens < config.tokens) {
        logger.warn('daily token quota of "%s" used up; it continues on "exhausted" until midnight', context.node.label)
      }
    })
    if (config.times > 0 && counted.count === config.times) logger.warn('daily quota of "%s" used up; it continues on "exhausted" until midnight', context.node.label)
    return { exec: 'ok', outputs: { used: counted.count, tokens: counted.tokens } }
  },
}

const delayNode: NodeType = {
  kind: 'action',
  type: 'logic.delay',
  category: 'logic',
  title: { en: 'Wait', 'zh-CN': '等待' },
  description: { en: 'Waits before continuing', 'zh-CN': '等待一段时间后继续' },
  config: z.object({
    seconds: z.number().min(0).max(60).default(1).meta(field('Seconds', undefined, { 'zh-CN': { title: '秒数' } })),
  }),
  async run({ config, signal }) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, config.seconds * 1000)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new FlowError('stopped while waiting'))
      }, { once: true })
    })
  },
}

const templateNode: NodeType = {
  kind: 'action',
  type: 'data.text',
  category: 'data',
  title: { en: 'Text', 'zh-CN': '文本' },
  description: { en: 'Builds text from references such as {{sys.user}}; {a} {b} {c} are the inputs, {user} {message} the sender and message', 'zh-CN': '用 {{sys.user}} 这样的变量引用拼接文本；{a} {b} {c} 为输入，{user} {message} 为发送者和消息' },
  config: z.object({
    template: z.string().default('Hello, {user}!').meta(field('Text', undefined, { 'zh-CN': { title: '文本' } })),
  }),
  inputs: [
    { name: 'a', type: 'text', title: 'a' },
    { name: 'b', type: 'text', title: 'b' },
    { name: 'c', type: 'text', title: 'c' },
  ],
  outputs: [{ name: 'text', type: 'text', title: { en: 'Text', 'zh-CN': '文本' } }],
  run: ({ config, inputs, session }) => ({
    outputs: { text: fillTemplate(config.template, { ...inputs, user: session.user.name ?? session.user.id, message: session.text }) },
  }),
}

const messageNode: NodeType = {
  kind: 'action',
  type: 'data.message',
  category: 'data',
  title: { en: 'Message info', 'zh-CN': '消息信息' },
  description: { en: 'The incoming message and who sent it', 'zh-CN': '收到的消息及发送者' },
  outputs: [
    ...sessionOutputs,
    { name: 'groupId', type: 'text', title: { en: 'Group id', 'zh-CN': '群号' } },
    { name: 'isPrivate', type: 'boolean', title: { en: 'Private chat', 'zh-CN': '是私聊' } },
    { name: 'mentioned', type: 'boolean', title: { en: 'Mentions the bot', 'zh-CN': '@ 了机器人' } },
    { name: 'role', type: 'text', title: { en: 'Sender role (owner / admin / member)', 'zh-CN': '发送者身份（owner / admin / member）' } },
    { name: 'messageId', type: 'text', title: { en: 'Message id', 'zh-CN': '消息 ID' } },
  ],
  run: ({ session }) => ({
    outputs: {
      ...sessionValues(session),
      groupId: session.isDirect ? '' : session.channel.id,
      isPrivate: session.isDirect,
      mentioned: session.mentioned,
      role: session.user.role ?? '',
      messageId: session.messageId ?? '',
    },
  }),
}

const getVarNode: NodeType = {
  kind: 'action',
  type: 'data.getVar',
  category: 'data',
  title: { en: 'Get variable', 'zh-CN': '读取变量' },
  config: z.object({
    name: nameField,
    scope: scopeField,
    fallback: z.string().default('').meta(field('When unset', 'Value used before the variable is set', {
      'zh-CN': { title: '未设置时', description: '变量尚未设置时使用的值' },
    })),
  }),
  outputs: [{ name: 'value', type: 'any', title: { en: 'Value', 'zh-CN': '值' } }],
  run: ({ config, vars }) => ({ outputs: { value: vars.get(config.scope as VariableScope, config.name) ?? config.fallback } }),
}

const setVarNode: NodeType = {
  kind: 'action',
  type: 'data.setVar',
  category: 'data',
  title: { en: 'Set variable', 'zh-CN': '设置变量' },
  description: { en: 'Stores the input, or the fixed value when the input is not set', 'zh-CN': '保存输入值；未设置输入时保存固定值' },
  config: z.object({
    name: nameField,
    scope: scopeField,
    value: z.string().default('').meta(field('Fixed value', 'Supports {user} and {message}', {
      'zh-CN': { title: '固定值', description: '支持 {user} 和 {message}' },
    })),
  }),
  inputs: [{ name: 'value', type: 'any', title: { en: 'Value', 'zh-CN': '值' } }],
  run({ config, inputs, vars, session }) {
    const value = inputs.value !== undefined
      ? inputs.value
      : fillTemplate(config.value, { user: session.user.name ?? session.user.id, message: session.text })
    vars.set(config.scope as VariableScope, config.name, value)
  },
}

const incrementNode: NodeType = {
  kind: 'action',
  type: 'data.increment',
  category: 'data',
  title: { en: 'Add to number', 'zh-CN': '数值累加' },
  description: { en: 'Adds to a number variable and outputs the new value', 'zh-CN': '给数值变量加上一个数并输出新值' },
  config: z.object({
    name: nameField,
    scope: scopeField,
    by: z.number().default(1).meta(field('Add', undefined, { 'zh-CN': { title: '加上' } })),
  }),
  outputs: [{ name: 'value', type: 'number', title: { en: 'New value', 'zh-CN': '新值' } }],
  run({ config, vars }) {
    const current = Number(vars.get(config.scope as VariableScope, config.name) ?? 0)
    const value = (Number.isFinite(current) ? current : 0) + config.by
    vars.set(config.scope as VariableScope, config.name, value)
    return { outputs: { value } }
  },
}

function requireLlm(context: { llm?: LlmLike }): LlmLike {
  if (!context.llm) throw new FlowError('No LLM provider is available; add one under Providers')
  return context.llm
}

/** The system prompt ai.chat used to fill in; nodes saved with it now let the persona speak instead. */
const OLD_CHAT_PROMPT = 'You are a friendly chat bot. Keep replies short.'
const DEFAULT_CHAT_PROMPT = 'You are a friendly chat bot. Keep replies short and natural, and answer in the language the user writes in.'

/** The system prompt and example exchanges for a persona, followed by the node's own rules. */
export function personaMessages(persona: PersonaLike | undefined, own: string) {
  if (!persona) return [{ role: 'system', content: own || DEFAULT_CHAT_PROMPT }]
  return [
    { role: 'system', content: own ? `${persona.prompt}\n\n${own}` : persona.prompt },
    ...(persona.examples ?? []).flatMap((example) => [
      { role: 'user', content: example.user },
      { role: 'assistant', content: example.assistant },
    ]),
  ]
}

/** Most messages kept per chat for an ai.chat node's own history. */
const MAX_HISTORY = 50

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Earlier messages for ai.chat: the node's own exchanges in this chat, or the chat as the bot's message log has it. */
async function chatHistory(context: NodeContext<any>, rounds: number, source: string, prefixed: boolean): Promise<ChatMessage[]> {
  if (rounds <= 0) return []
  if (source === 'chat') {
    const { session, bot } = context
    const lines = await bot?.history?.(session.channel, rounds * 2 + 1).catch(() => []) ?? []
    // The message being answered is in the log already; it goes last, after the history.
    const current = lines.findLastIndex((line) => line.direction === 'in' && (session.messageId ? line.messageId === session.messageId : line.user.id === session.user.id))
    return lines
      .filter((line, index) => index !== current && line.text)
      .slice(-rounds * 2)
      .map((line) => line.direction === 'out'
        ? { role: 'assistant', content: line.text }
        : { role: 'user', content: prefixed ? `${line.user.name ?? line.user.id}: ${line.text}` : line.text })
  }
  const saved = context.vars.get('chat', `__history:${context.node.id}`) as ChatMessage[] | undefined
  return (saved ?? []).slice(-rounds * 2)
}

const chatNode: NodeType = {
  kind: 'action',
  type: 'ai.chat',
  category: 'ai',
  title: { en: 'Ask the LLM', 'zh-CN': '询问大模型' },
  description: {
    en: 'Sends the prompt (or the message) to an LLM and outputs its reply, with earlier messages of the chat when history is on. Speaks as the run\'s persona when there is one (a persona node, or the bot\'s persona rules). Continues on "error" when the model fails or times out.',
    'zh-CN': '把提示词（或消息）发给大模型并输出回复；开启历史时带上会话之前的消息。有人格时（人格节点，或机器人的人格规则）以该人格说话。模型出错或超时时走 error。',
  },
  config: z.object({
    usePersona: z.boolean().default(true).meta(field('Speak as the persona', 'Uses the persona chosen by a persona node, or by the bot\'s persona rules', {
      'zh-CN': { title: '使用人格', description: '使用人格节点选择的人格，没有时按机器人的人格规则' },
    }, { widget: 'switch' })),
    systemPrompt: z.string().default('').meta(field('System prompt', 'With a persona, added after its prompt as extra rules; without one, empty uses a short default', {
      'zh-CN': { title: '系统提示词', description: '有人格时作为补充规则接在人格提示之后；没有人格时，留空使用简短的默认提示' },
    })),
    history: z.number().int().min(0).max(MAX_HISTORY).default(0).meta(field('History (rounds)', 'Earlier rounds of the chat sent as context; 0 sends only this message', {
      'zh-CN': { title: '上下文轮数', description: '作为上下文带上的之前几轮对话；0 表示只发这条消息' },
    })),
    historySource: z.enum(['node', 'chat']).default('node').meta(field(
      'History from',
      'This node: only what it was asked and answered. The chat: recent messages of the chat from the bot\'s message log, including ones it did not answer.',
      { 'zh-CN': { title: '历史来源', description: '本节点：只记录问过它、它回答过的消息。整个会话：机器人消息记录里这个会话的最近消息，包括没有回复的。', options: { node: '本节点', chat: '整个会话' } } },
      { options: { node: 'This node', chat: 'The chat' } },
    )),
    provider: z.string().optional().meta(field('Provider', 'Provider id; empty uses the persona\'s, then the bot\'s or the global default', {
      'zh-CN': { title: '提供商', description: '提供商 id；留空依次使用人格、机器人或全局默认' },
    })),
    model: z.string().optional().meta(field('Model', 'Empty uses the persona\'s, then the provider\'s default', { 'zh-CN': { title: '模型', description: '留空依次使用人格、提供商的默认模型' } })),
    maxTokens: z.number().int().min(64).max(64000).default(1000).meta(field('Max tokens', undefined, { 'zh-CN': { title: '最大 Token 数' } })),
    maxInputChars: z.number().int().min(0).default(0).meta(field('Max message length', 'Longer messages are cut to this many characters; 0 means no limit', {
      'zh-CN': { title: '消息长度上限', description: '超过此字数的消息会被截断；0 表示不限制' },
    })),
    timeout: z.number().min(5).max(55).default(45).meta(field('Timeout (seconds)', 'A whole run may work for 60 seconds at most', { 'zh-CN': { title: '超时（秒）', description: '一次运行最多工作 60 秒' } })),
  }),
  inputs: [{ name: 'prompt', type: 'text', title: { en: 'Prompt', 'zh-CN': '提示词' } }],
  outputs: [
    { name: 'reply', type: 'text', title: { en: 'Reply', 'zh-CN': '回复' } },
    { name: 'tokens', type: 'number', title: { en: 'Tokens used', 'zh-CN': '用掉的 Token' } },
    { name: 'model', type: 'text', title: { en: 'Model', 'zh-CN': '模型' } },
    { name: 'error', type: 'text', title: { en: 'Error', 'zh-CN': '错误' } },
  ],
  execOut: ['next', 'error'],
  async run(context) {
    const { config, inputs, session, provider, run, signal, logger } = context
    const llm = requireLlm(context)
    const persona = config.usePersona === false ? undefined : await context.persona()
    const own = config.systemPrompt === OLD_CHAT_PROMPT ? '' : String(config.systemPrompt ?? '')
    const rounds = Number(config.history ?? 0)
    // In groups with history, each message says who wrote it.
    const prefixed = rounds > 0 && !session.isDirect
    let text = String(inputs.prompt || session.text)
    const limit = Number(config.maxInputChars ?? 0)
    if (limit > 0 && text.length > limit) text = `${text.slice(0, limit)}…`
    const asked: ChatMessage = { role: 'user', content: prefixed && !inputs.prompt ? `${session.user.name ?? session.user.id}: ${text}` : text }
    try {
      const result = await llm.chat({
        provider: config.provider || persona?.provider || provider,
        model: config.model || persona?.model,
        maxTokens: config.maxTokens,
        ...(persona?.temperature !== undefined ? { temperature: persona.temperature } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(Number(config.timeout ?? 45) * 1000)]),
        messages: [
          ...personaMessages(persona, own),
          ...await chatHistory(context, rounds, config.historySource, prefixed),
          asked,
        ],
      })
      const tokens = result.source.tokens ?? 0
      run.llm = { provider: result.source.provider, model: result.source.model, ...(persona ? { persona: persona.name } : {}) }
      for (const listener of run.onTokens ?? []) listener(tokens)
      if (rounds > 0 && config.historySource !== 'chat') {
        const key = `__history:${context.node.id}`
        const saved = [...(context.vars.get('chat', key) as ChatMessage[] | undefined ?? []), asked, ...(result.text.trim() ? [{ role: 'assistant' as const, content: result.text }] : [])]
        context.vars.set('chat', key, saved.slice(-MAX_HISTORY * 2))
      }
      return { outputs: { reply: result.text, tokens, model: result.source.model, error: '' } }
    } catch (error) {
      if (signal.aborted) throw error
      const message = (error as Error)?.name === 'TimeoutError' ? `The model did not answer within ${config.timeout} seconds` : String((error as Error)?.message ?? error)
      logger.warn('%s failed: %s', context.node.label, message)
      return { exec: 'error', outputs: { reply: '', tokens: 0, model: '', error: message } }
    }
  },
}

/** Fixed reply text, rewritten in the persona's voice when a persona node asked for it. */
async function inVoice(context: NodeContext<any>, text: string) {
  const persona = context.run.persona
  if (!persona?.rewrite || !context.llm || !text.trim()) return text
  try {
    const result = await context.llm.chat({
      provider: persona.provider || context.provider,
      model: persona.model,
      maxTokens: 1000,
      signal: context.signal,
      messages: [
        ...personaMessages(persona, 'Rewrite the message the user gives you in your own voice. Keep its meaning, facts, numbers, names and links. Answer with the rewritten message only.'),
        { role: 'user', content: text },
      ],
    })
    context.run.llm = { provider: result.source.provider, model: result.source.model, persona: persona.name }
    return result.text.trim() || text
  } catch (error) {
    context.logger.warn('rewriting a reply as %s failed: %s', persona.name, error)
    return text
  }
}

const classifyNode: NodeType = {
  kind: 'action',
  type: 'ai.classify',
  category: 'ai',
  title: { en: 'Classify intent', 'zh-CN': '意图分类' },
  description: { en: 'Asks the LLM which label fits the text and continues on that label, or "other"', 'zh-CN': '让大模型判断文本属于哪个标签，走对应分支，否则走 other' },
  config: z.object({
    labels: z.array(z.string()).default(['greeting', 'question']).meta(field('Labels', 'One branch per label', {
      'zh-CN': { title: '标签', description: '每个标签一个分支' },
    })),
    instructions: z.string().default('').meta(field('Extra instructions', 'Describe what each label means', {
      'zh-CN': { title: '补充说明', description: '说明每个标签的含义' },
    })),
    provider: z.string().optional().meta(field('Provider', undefined, { 'zh-CN': { title: '提供商' } })),
    model: z.string().optional().meta(field('Model', undefined, { 'zh-CN': { title: '模型' } })),
  }),
  inputs: [{ name: 'text', type: 'text', title: { en: 'Text', 'zh-CN': '文本' } }],
  outputs: [{ name: 'label', type: 'text', title: { en: 'Label', 'zh-CN': '标签' } }],
  execOutFrom: { key: 'labels', extra: ['other'] },
  async run(context) {
    const { config, inputs, session, provider, signal } = context
    const labels = (config.labels as string[]).map((label) => label.trim()).filter(Boolean)
    const result = await requireLlm(context).chat({
      provider: config.provider ?? provider,
      model: config.model,
      maxTokens: 256,
      signal,
      messages: [
        {
          role: 'system',
          content: `Classify the user's message into exactly one of these labels: ${labels.join(', ')}. If none fits, answer "other". ${config.instructions} Answer with the label only.`.trim(),
        },
        { role: 'user', content: inputs.text || session.text },
      ],
    })
    const answer = result.text.trim().toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '')
    const label = labels.find((item) => answer === item.toLowerCase())
      ?? labels.find((item) => answer.includes(item.toLowerCase()))
      ?? 'other'
    return { exec: label, outputs: { label } }
  },
}

const replyNode: NodeType = {
  kind: 'action',
  type: 'action.reply',
  category: 'action',
  title: { en: 'Reply', 'zh-CN': '回复' },
  description: { en: 'Replies in the same chat with the input text, or the fixed text when the input is not set', 'zh-CN': '在当前会话回复输入的文本；未设置输入时回复固定文本' },
  config: z.object({
    text: z.string().default('Hi, {user}!').meta(field('Fixed text', 'Supports {user}, {message} and references such as {{n1.rest}}', {
      'zh-CN': { title: '固定文本', description: '支持 {user}、{message} 和 {{n1.rest}} 这样的变量引用' },
    })),
    quote: z.boolean().default(false).meta(field('Quote the message', undefined, { 'zh-CN': { title: '引用原消息' } })),
  }),
  inputs: [{ name: 'text', type: 'text', title: { en: 'Text', 'zh-CN': '文本' } }],
  outputs: [{ name: 'messageId', type: 'text', title: { en: 'Sent message id', 'zh-CN': '发出的消息 ID' } }],
  async run(context) {
    const { config, inputs, session, flow, node, run } = context
    const text = inputs.text !== undefined && inputs.text !== ''
      ? String(inputs.text)
      : await inVoice(context, fillTemplate(config.text, { user: session.user.name ?? session.user.id, message: session.text }))
    if (!text.trim()) return { outputs: { messageId: '' } }
    const content = { text, source: { kind: 'flow' as const, flow: flow.name, node: node.label, ...(run.llm ?? {}) } }
    const sent = await (config.quote ? session.reply(content) : session.send(content))
    return { outputs: { messageId: sent?.messageId ?? '' } }
  },
}

const targetFields = {
  targetType: z.enum(['current', 'group', 'private']).default('current').meta(field(
    'Send to',
    'current: the chat the run is about. group / private: the group or person below.',
    { 'zh-CN': { title: '发送到', description: 'current：本次运行所在的会话。group / private：下面填写的群或个人。' } },
  )),
  targetId: z.string().default('').meta(field('Group or user id', 'Supports references such as {{sys.userId}}', {
    'zh-CN': { title: '群号或 QQ', description: '支持 {{sys.userId}} 这样的变量引用' },
  })),
}

/** The chat a send or schedule node targets; `current` is the session's chat. */
export function resolveTarget(config: { targetType: string; targetId: string }, current?: ChannelInfo): ChannelInfo | undefined {
  const id = String(config.targetId ?? '').trim()
  if (config.targetType === 'group' && id) return { type: 'group', id }
  if (config.targetType === 'private' && id) return { type: 'private', id }
  if (config.targetType === 'current' && current?.id) return current
}

/** The chat a schedule trigger's runs send to. */
export function scheduleTarget(config: Record<string, any>): ChannelInfo | undefined {
  return resolveTarget({ targetType: config.targetType === 'private' ? 'private' : 'group', targetId: config.targetId })
}

const sendNode: NodeType = {
  kind: 'action',
  type: 'action.send',
  category: 'action',
  title: { en: 'Send to chat', 'zh-CN': '发送到会话' },
  description: { en: 'Sends the text to the current chat or to a given group or person', 'zh-CN': '把文本发到当前会话，或指定的群、个人' },
  config: z.object({
    ...targetFields,
    text: z.string().default('').meta(field('Fixed text', 'Used when the input is not set', { 'zh-CN': { title: '固定文本', description: '未设置输入时使用' } })),
  }),
  inputs: [{ name: 'text', type: 'text', title: { en: 'Text', 'zh-CN': '文本' } }],
  outputs: [{ name: 'messageId', type: 'text', title: { en: 'Sent message id', 'zh-CN': '发出的消息 ID' } }],
  execOut: ['next', 'failed'],
  async run(context) {
    const { config, inputs, session, bot, flow, node, run, logger } = context
    const text = inputs.text !== undefined && inputs.text !== '' ? String(inputs.text) : await inVoice(context, String(config.text ?? ''))
    const channel = resolveTarget(config, session.channel)
    if (!channel) throw new FlowError('Set the group or user id to send to')
    if (!text.trim()) return { outputs: { messageId: '' } }
    const content = { text, source: { kind: 'flow' as const, flow: flow.name, node: node.label, ...(run.llm ?? {}) } }
    try {
      const sent = channel === session.channel || !bot ? await session.send(content) : await bot.send(channel, content)
      return { outputs: { messageId: sent?.messageId ?? '' } }
    } catch (error) {
      logger.warn('sending to %s:%s failed: %s', channel.type, channel.id, error)
      return { exec: 'failed', outputs: { messageId: '' } }
    }
  },
}

const waitReplyNode: NodeType = {
  kind: 'action',
  type: 'logic.waitReply',
  category: 'logic',
  title: { en: 'Wait for reply', 'zh-CN': '等待回复' },
  description: {
    en: 'Waits for the next message in this chat; continues on "reply", or on "timeout". The awaited message does not start other flows.',
    'zh-CN': '等待当前会话的下一条消息；收到走 reply，超时走 timeout。等到的这条消息不会再触发其他流程。',
  },
  config: z.object({
    seconds: z.number().int().min(1).max(3600).default(30).meta(field('Timeout (seconds)', 'Up to an hour; waiting does not count toward the 60-second run limit', {
      'zh-CN': { title: '超时（秒）', description: '最长 1 小时；等待时间不计入单次运行 60 秒的上限' },
    })),
    who: z.enum(['sender', 'anyone']).default('sender').meta(field('From whom', 'sender: only the person who started the run. anyone: anyone in this chat.', {
      'zh-CN': { title: '等谁', description: 'sender：只等触发这次运行的人。anyone：这个会话里任何人。' },
    })),
  }),
  outputs: [
    { name: 'text', type: 'text', title: { en: 'Reply', 'zh-CN': '回复内容' } },
    { name: 'userId', type: 'text', title: { en: 'Replied by (id)', 'zh-CN': '回复者 ID' } },
    { name: 'userName', type: 'text', title: { en: 'Replied by', 'zh-CN': '回复者' } },
    { name: 'message', type: 'message', title: { en: 'Reply content', 'zh-CN': '回复消息内容' } },
    { name: 'messageId', type: 'text', title: { en: 'Reply message id', 'zh-CN': '回复的消息 ID' } },
  ],
  execOut: ['reply', 'timeout'],
  async run({ config, waitForMessage }) {
    const reply = await waitForMessage({ who: config.who, seconds: config.seconds })
    if (!reply) return { exec: 'timeout', outputs: { text: '', userId: '', userName: '', message: [], messageId: '' } }
    return {
      exec: 'reply',
      outputs: {
        text: reply.text || segmentsToText(reply.segments, false).trim(),
        userId: reply.user.id,
        userName: reply.user.name ?? reply.user.id,
        message: reply.segments,
        messageId: reply.messageId ?? '',
      },
    }
  },
}

const CRON_FIELDS: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

/** Parses a five-field cron expression (minute hour day month weekday) into the allowed values of each field. */
export function parseCron(expression: string): Set<number>[] | undefined {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return
  const sets: Set<number>[] = []
  for (const [index, part] of parts.entries()) {
    const [min, max] = CRON_FIELDS[index]
    const set = new Set<number>()
    for (const item of part.split(',')) {
      const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item)
      if (!match) return
      const from = match[1] === '*' ? min : Number(match[2])
      const to = match[1] === '*' ? max : match[3] !== undefined ? Number(match[3]) : match[4] ? max : from
      const step = match[4] ? Number(match[4]) : 1
      if (from < min || to > max || from > to || step < 1) return
      for (let value = from; value <= to; value += step) set.add(index === 4 && value === 7 ? 0 : value)
    }
    sets.push(set)
  }
  return sets
}

function cronMatches(sets: Set<number>[], date: Date) {
  const [minute, hour, day, month, weekday] = sets
  const dayRestricted = day.size < 31
  const weekdayRestricted = weekday.size < 7
  const dayOk = day.has(date.getDate())
  const weekdayOk = weekday.has(date.getDay())
  // As in standard cron: when both day fields are restricted, either one matching is enough.
  const dateOk = dayRestricted && weekdayRestricted ? dayOk || weekdayOk : dayOk && weekdayOk
  return minute.has(date.getMinutes()) && hour.has(date.getHours()) && month.has(date.getMonth() + 1) && dateOk
}

const minuteOf = (time: number) => Math.floor(time / 60_000)

const scheduleTrigger: NodeType = {
  kind: 'trigger',
  type: 'trigger.schedule',
  source: 'schedule',
  category: 'trigger',
  title: { en: 'On schedule', 'zh-CN': '定时触发' },
  description: {
    en: 'Starts at set times on every bot the flow runs on, while the bot is online; replies go to the chat set here',
    'zh-CN': '在设定的时间开始，流程绑定的每个在线机器人各运行一次；回复发到这里设置的会话',
  },
  config: z.object({
    mode: z.enum(['daily', 'interval', 'cron']).default('daily').meta(field(
      'When',
      'daily: every day at the time below. interval: every N minutes. cron: a cron expression.',
      { 'zh-CN': { title: '何时', description: 'daily：每天在下面的时间。interval：每隔 N 分钟。cron：cron 表达式。' } },
    )),
    time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'use HH:MM').default('08:00').meta(field('Time (daily)', 'HH:MM, server time', {
      'zh-CN': { title: '时间（daily）', description: 'HH:MM，按服务器时间' },
    })),
    minutes: z.number().int().min(1).max(10080).default(60).meta(field('Every N minutes (interval)', undefined, {
      'zh-CN': { title: '间隔分钟（interval）' },
    })),
    cron: z.string().default('0 8 * * *')
      .refine((value) => !!parseCron(value), 'not a valid five-field cron expression')
      .meta(field('Cron (cron)', 'minute hour day month weekday, e.g. "0 8 * * 1-5" for 8:00 on weekdays', {
        'zh-CN': { title: 'Cron（cron）', description: '分 时 日 月 周，例如 "0 8 * * 1-5" 表示工作日 8:00' },
      })),
    targetType: z.enum(['group', 'private']).default('group').meta(field('Send to', undefined, { 'zh-CN': { title: '发送到' } })),
    targetId: z.string().default('').meta(field('Group or user id', 'Reply nodes in this run send here', {
      'zh-CN': { title: '群号或 QQ', description: '本次运行中的回复节点发到这里' },
    })),
  }),
  outputs: [
    { name: 'time', type: 'text', title: { en: 'Time', 'zh-CN': '时间' } },
    { name: 'date', type: 'text', title: { en: 'Date', 'zh-CN': '日期' } },
    { name: 'weekday', type: 'number', title: { en: 'Weekday (0 = Sunday)', 'zh-CN': '星期（0 为周日）' } },
  ],
  due(config, { now, last, since }) {
    if (config.mode === 'interval') return now.getTime() - (last ?? since) >= config.minutes * 60_000
    if (last !== undefined && minuteOf(last) === minuteOf(now.getTime())) return false
    if (config.mode === 'cron') {
      const sets = parseCron(config.cron)
      return !!sets && cronMatches(sets, now)
    }
    const [hour, minute] = String(config.time).split(':').map(Number)
    return now.getHours() === hour && now.getMinutes() === minute
  },
  match({ now }) {
    const at = now ?? new Date()
    const pad = (value: number) => String(value).padStart(2, '0')
    return {
      time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
      date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
      weekday: at.getDay(),
    }
  },
}

export const builtinNodes: NodeType[] = [
  messageTrigger, keywordTrigger, commandTrigger, regexTrigger, scheduleTrigger,
  ifNode, compareNode, randomNode, cooldownNode, rateLimitNode, dailyQuotaNode, delayNode, waitReplyNode,
  templateNode, messageNode, getVarNode, setVarNode, incrementNode,
  chatNode, classifyNode,
  replyNode, sendNode,
]
