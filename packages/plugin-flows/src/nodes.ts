import { field, z } from '@mushin/core'
import { FlowError } from './engine'
import type { FlowSession, LlmLike, NodeType, VariableScope } from './types'

const passThrough = z.boolean().default(false).meta(field(
  'Let other plugins answer too',
  'Off: when this trigger matches, plugins such as LLM chat do not see the message',
  { 'zh-CN': { title: '同时交给其他插件', description: '关闭时：此触发器匹配后，大模型对话等插件不会再处理这条消息' } },
))

const scopeField = z.enum(['chat', 'user', 'flow', 'run']).default('chat').meta(field(
  'Scope',
  'chat: per group or private chat. user: per person. flow: shared by everyone. run: only this message.',
  { 'zh-CN': { title: '作用范围', description: 'chat：每个会话独立。user：每个用户独立。flow：所有人共享。run：仅本条消息。' } },
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
    when: z.enum(['any', 'mention', 'private', 'group']).default('any').meta(field(
      'Which messages',
      'any: every message. mention: @-mentions in groups and all private messages. private / group: only that kind of chat.',
      { 'zh-CN': { title: '哪些消息', description: 'any：所有消息。mention：群里 @ 机器人的消息和所有私聊。private / group：仅私聊或仅群聊。' } },
    )),
    passThrough,
  }),
  outputs: [...sessionOutputs, { name: 'isPrivate', type: 'boolean', title: { en: 'Private chat', 'zh-CN': '是私聊' } }],
  match({ config, session }) {
    const ok = config.when === 'any'
      || (config.when === 'private' && session.isDirect)
      || (config.when === 'group' && !session.isDirect)
      || (config.when === 'mention' && (session.isDirect || session.mentioned))
    if (ok) return { ...sessionValues(session), isPrivate: session.isDirect }
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
    mode: z.enum(['contains', 'startsWith', 'exact']).default('contains').meta(field('Match', undefined, { 'zh-CN': { title: '匹配方式' } })),
    ignoreCase: z.boolean().default(true).meta(field('Ignore case', undefined, { 'zh-CN': { title: '忽略大小写' } })),
    passThrough,
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
    passThrough,
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
  ],
  run: ({ session }) => ({
    outputs: {
      ...sessionValues(session),
      groupId: session.isDirect ? '' : session.channel.id,
      isPrivate: session.isDirect,
      mentioned: session.mentioned,
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

const chatNode: NodeType = {
  kind: 'action',
  type: 'ai.chat',
  category: 'ai',
  title: { en: 'Ask the LLM', 'zh-CN': '询问大模型' },
  description: { en: 'Sends the prompt (or the message) to an LLM and outputs its reply', 'zh-CN': '把提示词（或消息）发给大模型并输出回复' },
  config: z.object({
    systemPrompt: z.string().default('You are a friendly chat bot. Keep replies short.').meta(field('System prompt', undefined, {
      'zh-CN': { title: '系统提示词' },
    })),
    provider: z.string().optional().meta(field('Provider', 'Provider id; empty uses the bot\'s or the global default', {
      'zh-CN': { title: '提供商', description: '提供商 id；留空使用机器人或全局默认' },
    })),
    model: z.string().optional().meta(field('Model', undefined, { 'zh-CN': { title: '模型' } })),
    maxTokens: z.number().int().min(64).max(64000).default(1000).meta(field('Max tokens', undefined, { 'zh-CN': { title: '最大 Token 数' } })),
  }),
  inputs: [{ name: 'prompt', type: 'text', title: { en: 'Prompt', 'zh-CN': '提示词' } }],
  outputs: [{ name: 'reply', type: 'text', title: { en: 'Reply', 'zh-CN': '回复' } }],
  async run(context) {
    const { config, inputs, session, provider, run, signal } = context
    const result = await requireLlm(context).chat({
      provider: config.provider ?? provider,
      model: config.model,
      maxTokens: config.maxTokens,
      signal,
      messages: [
        ...(config.systemPrompt ? [{ role: 'system', content: config.systemPrompt }] : []),
        { role: 'user', content: inputs.prompt || session.text },
      ],
    })
    run.llm = { provider: result.source.provider, model: result.source.model }
    return { outputs: { reply: result.text } }
  },
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
  async run({ config, inputs, session, flow, node, run }) {
    const text = inputs.text !== undefined && inputs.text !== ''
      ? String(inputs.text)
      : fillTemplate(config.text, { user: session.user.name ?? session.user.id, message: session.text })
    if (!text.trim()) return
    const content = { text, source: { kind: 'flow' as const, flow: flow.name, node: node.label, ...(run.llm ?? {}) } }
    await (config.quote ? session.reply(content) : session.send(content))
  },
}

export const builtinNodes: NodeType[] = [
  messageTrigger, keywordTrigger, regexTrigger,
  ifNode, compareNode, randomNode, cooldownNode, delayNode,
  templateNode, messageNode, getVarNode, setVarNode, incrementNode,
  chatNode, classifyNode,
  replyNode,
]
