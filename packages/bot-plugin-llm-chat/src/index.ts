import type { Context } from '@mushin/core'
import { z } from '@mushin/core'
import type {} from '@mushin/plugin-flows'
import type {} from '@mushin/plugin-storage'
import { chatFlow, LegacyConfig, legacySettings } from './legacy'

export * from './legacy'

export const name = 'llm-chat'
export const inject = ['bot', 'flows', 'storage']

export const PACKAGE = '@mushin/bot-plugin-llm-chat'
const STORAGE_KEY = 'llm-chat/flows'

/**
 * No settings: LLM chat is the flow this plugin makes on each bot ("大模型对话"), edited on the
 * canvas. Settings from older versions are accepted and turned into that flow.
 */
export const Config = z.looseObject({})

/** Bot id → the flow made for it, and the legacy settings it was last made from. */
type State = Record<string, { flow: string; settings: string }>

// Bots start in parallel; changes to the shared state go one at a time.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => {}).then(task)
  queue = next
  return next
}

const exists = (ctx: Context, id: string) => {
  try {
    ctx.flows.get(id)
    return true
  } catch {
    return false
  }
}

/** Makes the bot's chat flow, or rewrites it when legacy settings changed; drops flows of deleted bots. */
async function reconcile(ctx: Context, raw: Record<string, unknown>) {
  const logger = ctx.logger('llm-chat')
  const botId = ctx.bot.id
  const state = (await ctx.storage.get<State>(STORAGE_KEY)) ?? {}
  const known = new Set(ctx.bots.list().map((bot) => bot.id))
  for (const [id, entry] of Object.entries(state)) {
    if (known.has(id)) continue
    if (exists(ctx, entry.flow)) await ctx.flows.remove(entry.flow)
    delete state[id]
  }

  const legacy = legacySettings(raw)
  const parsed = LegacyConfig.safeParse(legacy)
  if (!parsed.success) logger.warn('ignoring old LLM chat settings that are not valid: %s', z.prettifyError(parsed.error))
  const settings = parsed.success ? parsed.data : LegacyConfig.parse({})
  const fingerprint = JSON.stringify(parsed.success ? legacy : {})
  const entry = state[botId]
  if (!entry || !exists(ctx, entry.flow)) {
    const doc = await ctx.flows.create({
      name: `大模型对话 · ${ctx.bot.record.name}`,
      description: '被 @ 或私聊时用大模型回复。由“大模型对话”插件创建；在这个机器人上停用该插件会删除它。',
      adapter: ctx.bot.platform,
      bots: [botId],
      source: { kind: 'plugin', plugin: PACKAGE },
      ...chatFlow(settings),
    })
    state[botId] = { flow: doc.id, settings: fingerprint }
    logger.info(Object.keys(legacy).length ? 'turned the LLM chat settings into the flow "%s"' : 'created the flow "%s"', doc.name)
  } else if (Object.keys(legacy).length && fingerprint !== entry.settings) {
    await ctx.flows.update(entry.flow, chatFlow(settings))
    entry.settings = fingerprint
    logger.info('rewrote the flow "%s" from the LLM chat settings', ctx.flows.get(entry.flow).name)
  }
  await ctx.storage.set(STORAGE_KEY, state)
}

/** Deletes the bot's chat flow once the plugin is turned off on it (not when the bot only restarts). */
async function cleanup(ctx: Context, botId: string) {
  let enabled: boolean | undefined
  try {
    enabled = ctx.bots.get(botId).plugins.find((item) => item.package === PACKAGE)?.enabled
  } catch {}
  if (enabled !== false) return
  const state = (await ctx.storage.get<State>(STORAGE_KEY)) ?? {}
  const entry = state[botId]
  if (!entry) return
  if (exists(ctx, entry.flow)) await ctx.flows.remove(entry.flow)
  delete state[botId]
  await ctx.storage.set(STORAGE_KEY, state)
  ctx.logger('llm-chat').info('removed the LLM chat flow of bot %s', botId)
}

export async function apply(ctx: Context, config: Record<string, unknown>) {
  const botId = ctx.bot.id
  const logger = ctx.logger('llm-chat')
  // Runs while the plugin stops, before its context goes away.
  ctx.effect(() => () => serial(() => cleanup(ctx, botId)).catch((error) => logger.warn('removing the LLM chat flow failed: %s', error)), 'llm-chat flow')
  await serial(() => reconcile(ctx, config ?? {}))
}
