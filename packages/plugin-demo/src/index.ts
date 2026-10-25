import { type Context, field, MushinError, z } from '@mushin/core'
import type {} from '@mushin/plugin-bots'
import type {} from '@mushin/plugin-flows'
import type {} from '@mushin/plugin-providers'
import type {} from '@mushin/plugin-storage'
import { AdapterConfig, sandboxAdapter, simulate } from './adapter'
import { type DemoFlowKey, demoFlows } from './flows'
import { DEMO_MODEL, demoProviderType } from './provider'

export * from './adapter'
export * from './flows'
export * from './provider'

export const name = 'demo'
export const inject = ['llm', 'bots', 'flows', 'storage', 'actions', 'manager']

export const PACKAGE = '@mushin/plugin-demo'
const STORAGE_KEY = 'demo'

const toggle = (title: string, zhTitle: string, description?: string, zhDescription?: string) => z.boolean().default(false)
  .meta(field(title, description, { 'zh-CN': { title: zhTitle, ...(zhDescription ? { description: zhDescription } : {}) } }))

export const Config = z.object({
  provider: toggle(
    'Create the demo provider',
    '创建演示提供商',
    'An offline provider that answers without any API key. Unchecking deletes it.',
    '一个不需要 API 密钥的离线提供商。取消勾选会删除它。',
  ),
  bot: toggle(
    'Create the demo bot',
    '创建演示机器人',
    'A bot on the sandbox adapter: always online, and you play the test user from its live conversation view. Unchecking deletes it.',
    '使用沙盒适配器的机器人：始终在线，在它的实时对话里你就是测试用户。取消勾选会删除它。',
  ),
  flows: z.object({
    command: toggle('Command reply (/ping, /echo)', '命令回复（/ping、/echo）'),
    keyword: toggle('Keyword trigger (good morning)', '关键词触发（早上好）'),
    branch: toggle('Condition branch (/score)', '条件分支（/score）'),
    cooldown: toggle('Cooldown and counter (/checkin)', '冷却与计数（/checkin）'),
    wait: toggle('Wait for a reply with timeout (/quiz)', '等待回复与超时（/quiz）'),
    llm: toggle('LLM reply (/ai)', '大模型回复（/ai）'),
    classify: toggle('Intent classification (/客服)', '意图分类（/客服）'),
  }).prefault({}).meta(field('Sample flows', 'Created on the demo bot when it exists. Unchecking deletes the flow.', {
    'zh-CN': { title: '示例流程', description: '演示机器人存在时绑定到它。取消勾选会删除对应流程。' },
  })),
})

export type Config = z.infer<typeof Config>

/** What this plugin created, so it only ever changes or deletes its own records. */
interface DemoState {
  provider?: string
  bot?: string
  flows: Partial<Record<DemoFlowKey, string>>
}

async function loadState(ctx: Context): Promise<DemoState> {
  const state = await ctx.storage.get<DemoState>(STORAGE_KEY)
  return { ...state, flows: { ...state?.flows } }
}

/** Creates the checked items that are missing and deletes the unchecked ones this plugin created. */
async function reconcile(ctx: Context, config: Config) {
  const state = await loadState(ctx)
  const logger = ctx.logger('demo')

  const providerExists = (id?: string) => !!id && ctx.llm.list().some((item) => item.id === id)
  if (config.provider && !providerExists(state.provider)) {
    const record = await ctx.llm.create({ name: '演示模型', type: 'demo', config: { latency: 300 }, models: [DEMO_MODEL] })
    state.provider = record.id
    logger.info('created the demo provider')
  } else if (!config.provider && state.provider) {
    if (providerExists(state.provider)) await ctx.llm.delete(state.provider)
    state.provider = undefined
  }

  const botExists = (id?: string) => !!id && ctx.bots.list().some((item) => item.id === id)
  const removedBot = !config.bot && botExists(state.bot) ? state.bot : undefined
  if (config.bot && !botExists(state.bot)) {
    const record = await ctx.bots.create({
      name: '演示机器人',
      adapter: { type: 'demo', config: {} },
      provider: state.provider,
      // The built-in /help lists the demo flows' commands.
      commands: { helpTitle: '我是演示机器人，可以试试这些指令：' },
    })
    state.bot = record.id
    logger.info('created the demo bot')
  } else if (config.bot && state.bot) {
    // Point the bot at the demo provider unless someone picked another provider that still exists.
    const current = ctx.bots.get(state.bot).provider
    if (current !== state.provider && !providerExists(current)) await ctx.bots.update(state.bot, { provider: state.provider ?? null })
  } else if (!config.bot && state.bot) {
    if (removedBot) await ctx.bots.remove(removedBot)
    state.bot = undefined
  }

  const flowIds = new Set(ctx.flows.list().map((item) => item.id))
  // Sample flows that no longer exist, such as the old /help menu now that /help is built in.
  const stored = state.flows as Record<string, string | undefined>
  for (const key of Object.keys(stored)) {
    if (key in demoFlows) continue
    const id = stored[key]
    if (id && flowIds.has(id)) await ctx.flows.remove(id)
    delete stored[key]
  }
  for (const key of Object.keys(demoFlows) as DemoFlowKey[]) {
    const id = state.flows[key]
    const exists = !!id && flowIds.has(id)
    if (config.flows[key]) {
      if (!exists) {
        const doc = await ctx.flows.create({ ...demoFlows[key], bots: state.bot ? [state.bot] : [] })
        state.flows[key] = doc.id
      } else {
        const doc = ctx.flows.get(id)
        const bots = doc.bots.filter((bot) => bot !== removedBot)
        if (state.bot && !bots.includes(state.bot)) bots.push(state.bot)
        if (bots.length !== doc.bots.length || bots.some((bot, i) => bot !== doc.bots[i])) await ctx.flows.update(id, { bots })
      }
    } else if (id) {
      if (exists) await ctx.flows.remove(id)
      delete state.flows[key]
    }
  }

  await ctx.storage.set(STORAGE_KEY, state)
  return state
}

/** Deletes everything this plugin created. Runs when the plugin is disabled, not when it restarts. */
async function uninstall(ctx: Context) {
  const state = await loadState(ctx)
  for (const id of Object.values(state.flows)) await ctx.flows.remove(id!).catch(() => {})
  if (state.bot) await ctx.bots.remove(state.bot).catch(() => {})
  if (state.provider) await ctx.llm.delete(state.provider).catch(() => {})
  await ctx.storage.delete(STORAGE_KEY)
}

// Restarts can overlap (a new config arrives while the previous one is applied); apply them in order.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => {}).then(task)
  queue = next
  return next
}

export async function apply(ctx: Context, raw: Config) {
  const config = Config.parse(raw ?? {})
  const logger = ctx.logger('demo')

  ctx.llm.defineType(demoProviderType)
  ctx.bots.defineAdapter(sandboxAdapter)

  ctx.actions.define({
    name: 'demo.say',
    description: 'Make the test user of a demo sandbox bot send a message, as if someone wrote it in a chat. The bot answers through its flows and plugins.',
    risk: 'write',
    input: z.object({
      text: z.string().min(1),
      bot: z.string().optional().describe('Bot id of a bot on the "demo" adapter; the demo bot when omitted'),
      private: z.boolean().optional().describe('Send in a private chat instead of the demo group'),
      userName: z.string().optional(),
      userId: z.string().optional(),
    }),
    handler: async ({ text, bot: botId, ...options }) => {
      const id = botId ?? (await loadState(ctx)).bot
      if (!id) throw new MushinError('not_found', 'There is no demo bot; check "Create the demo bot" in the demo plugin settings, or pass a bot id')
      const record = ctx.bots.get(id)
      if (record.adapter.type !== sandboxAdapter.id) throw new MushinError('invalid_input', `${record.name} is not on the demo sandbox adapter`)
      const bot = ctx.bots.bot(id)
      if (!bot) throw new MushinError('unavailable', `${record.name} is not running`)
      simulate(bot, AdapterConfig.parse(record.adapter.config ?? {}), { text, ...options })
      return { sent: true, bot: id }
    },
  })

  ctx.effect(() => () => {
    const entry = ctx.manager.entries.find((item) => item.package === PACKAGE)
    if (entry?.enabled !== false) return
    return serial(() => uninstall(ctx)).catch((error) => logger.warn('failed to remove demo content: %s', error))
  }, 'demo cleanup')

  await serial(() => reconcile(ctx, config)).catch((error) => logger.warn('failed to set up demo content: %s', error))
}
