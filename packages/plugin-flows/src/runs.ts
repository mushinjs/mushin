import { type Context, field, type LocalizedText, z } from '@mushin/core'
import type {} from '@mushin/plugin-database'
import { FlowError } from './engine'
import type { NodeType, RunTrace, TriggerSource } from './types'

declare module 'minato' {
  interface Tables {
    flows_run: RunRow
  }
}

/**
 * Where a run is. `running` includes waiting for a reply (`waiting`); `queued` waits for a
 * resource another run holds. Finished runs are `ok`, `error` or `stopped`.
 */
export type RunStatus = 'queued' | 'running' | 'waiting' | 'ok' | 'error' | 'stopped'

/** A real run on a bot, live or finished; test runs are not tracked. */
export interface RunInfo {
  id: string
  flowId: string
  flowName: string
  botId: string
  source: TriggerSource
  /** The message, or `[event]` / `[schedule]`. */
  text: string
  user?: { id: string; name?: string }
  /** `group:123` or `private:456`. */
  channel?: string
  status: RunStatus
  /** The node working now; for finished runs, the last one that ran. */
  node?: { id: string; type: string; label?: string; long?: boolean }
  startedAt: number
  endedAt?: number
  error?: string
  /** Who stopped the run, when it was stopped by hand. */
  stoppedBy?: string
}

/** Plain strings for the state columns: minato's query types do not take literal unions with `$in`. */
export interface RunRow extends Omit<RunInfo, 'user' | 'node' | 'status' | 'source'> {
  status: string
  source: string
  user: any
  node: any
  trace: any
}

/** A run a message started counts as replying, unless it queues or works at a long node such as a command. */
const replying = (run: RunInfo) => run.source === 'message' && run.status !== 'queued' && !run.node?.long

/** What the bot is doing, from its runs. */
export interface BotActivity {
  botId: string
  /** Replying to someone, or running a flow: started by a schedule or an event, or busy with a long node. */
  state: 'idle' | 'replying' | 'running'
  /** The run the state describes: the most recently started one. */
  run?: RunInfo
  /** Runs in progress or queued on the bot. */
  count: number
}

export interface HistoryQuery {
  bot?: string
  flow?: string
  status?: RunStatus[]
  limit?: number
  /** Only runs started before this time, to page back. */
  before?: number
}

const FINISHED: RunStatus[] = ['ok', 'error', 'stopped']
/** Finished runs kept in memory without the database. */
const MEMORY_LIMIT = 200
/** How long the database keeps finished runs. */
export const KEEP_DAYS = 7
const DAY = 86_400_000

interface Live {
  info: RunInfo
  trace: RunTrace
  controller: AbortController
}

/**
 * Real runs on bots: the ones going on now, and the finished ones (in the database when it runs,
 * else the latest in memory). `onChange` hears every change, to send it to the dashboard.
 */
export class RunStore {
  private live = new Map<string, Live>()
  private finished: { info: RunInfo; trace: RunTrace }[] = []
  private database?: Context['database']

  constructor(private onChange: (run: RunInfo) => void, private onError: (error: unknown) => void) {}

  /** Starts tracking a run whose trigger matched. */
  start(info: Omit<RunInfo, 'status' | 'startedAt'>, trace: RunTrace, controller: AbortController) {
    const entry: Live = { info: { ...info, status: 'running', startedAt: trace.at }, trace, controller }
    this.live.set(info.id, entry)
    this.emit(entry.info)
    return entry.info
  }

  update(id: string, patch: Partial<Pick<RunInfo, 'status' | 'node'>>) {
    const entry = this.live.get(id)
    if (!entry) return
    Object.assign(entry.info, patch)
    this.emit(entry.info)
  }

  /** Records how a run ended and stops tracking it. */
  finish(id: string) {
    const entry = this.live.get(id)
    if (!entry) return
    this.live.delete(id)
    const { info, trace } = entry
    info.endedAt = Date.now()
    if (entry.controller.signal.aborted && info.stoppedBy !== undefined) info.status = 'stopped'
    else info.status = trace.error ? 'error' : 'ok'
    if (trace.error) info.error = trace.error
    this.finished.push({ info, trace })
    if (this.finished.length > MEMORY_LIMIT) this.finished.splice(0, this.finished.length - MEMORY_LIMIT)
    this.emit(info)
    this.database?.create('flows_run', { ...info, user: info.user ?? null, node: info.node ?? null, trace }).catch(this.onError)
  }

  /** Stops a live run. Returns it, or undefined when it is not running. */
  stop(id: string, by: string) {
    const entry = this.live.get(id)
    if (!entry) return
    entry.info.stoppedBy = by
    entry.controller.abort(new StopError(by))
    return entry.info
  }

  /** Stops the live runs that match, except `except`. Returns how many were stopped. */
  stopWhere(match: (info: RunInfo) => boolean, by: string, except?: string) {
    let count = 0
    for (const [id, entry] of this.live) {
      if (id === except || !match(entry.info)) continue
      this.stop(id, by)
      count++
    }
    return count
  }

  /** Runs going on now, newest first. */
  active(bot?: string) {
    return [...this.live.values()].map((entry) => entry.info).filter((info) => !bot || info.botId === bot).sort((a, b) => b.startedAt - a.startedAt)
  }

  activity(botIds: string[]): BotActivity[] {
    return botIds.map((botId) => {
      const runs = this.active(botId)
      const run = runs.find((item) => item.status !== 'queued') ?? runs[0]
      const state = !run ? 'idle' : replying(run) ? 'replying' : 'running'
      return { botId, state, ...(run ? { run } : {}), count: runs.length }
    })
  }

  /** Runs newest first: the live ones (unless paging back), then finished ones. */
  async history(query: HistoryQuery) {
    const limit = query.limit ?? 50
    const statuses = query.status?.length ? query.status : undefined
    const matches = (info: RunInfo) => (!query.bot || info.botId === query.bot)
      && (!query.flow || info.flowId === query.flow)
      && (!statuses || statuses.includes(info.status) || (info.status === 'waiting' && statuses.includes('running')))
    const live = query.before === undefined ? this.active().filter(matches) : []
    const wanted = statuses?.filter((status) => FINISHED.includes(status))
    if (statuses && !wanted?.length) return { runs: live.slice(0, limit), more: live.length > limit }
    let done: RunInfo[]
    if (this.database) {
      const where: { botId?: string; flowId?: string; status?: { $in: string[] }; startedAt?: { $lt: number } } = {}
      if (query.bot) where.botId = query.bot
      if (query.flow) where.flowId = query.flow
      if (wanted) where.status = { $in: wanted }
      if (query.before !== undefined) where.startedAt = { $lt: query.before }
      const rows = await this.database.get('flows_run', where, {
        sort: { startedAt: 'desc' },
        limit: limit + 1,
        fields: ['id', 'flowId', 'flowName', 'botId', 'source', 'text', 'user', 'channel', 'status', 'node', 'startedAt', 'endedAt', 'error', 'stoppedBy'],
      })
      done = rows.map(infoOf)
    } else {
      done = this.finished.map((item) => item.info)
        .filter((info) => matches(info) && (query.before === undefined || info.startedAt < query.before))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit + 1)
    }
    const runs = [...live, ...done]
    return { runs: runs.slice(0, limit), more: runs.length > limit }
  }

  /** One run with its trace, live or finished. */
  async get(id: string): Promise<(RunInfo & { trace: RunTrace }) | undefined> {
    const live = this.live.get(id)
    if (live) return { ...live.info, trace: live.trace }
    const kept = this.finished.find((item) => item.info.id === id)
    if (kept) return { ...kept.info, trace: kept.trace }
    const [row] = await this.database?.get('flows_run', { id }) ?? []
    return row ? { ...infoOf(row), trace: row.trace } : undefined
  }

  /** Forgets finished runs of a flow. */
  async removeFlow(flow: string) {
    this.finished = this.finished.filter((item) => item.info.flowId !== flow)
    await this.database?.remove('flows_run', { flowId: flow })
  }

  /** Saves finished runs from now on and drops old ones. Returns the detach function. */
  attach(ctx: Context) {
    ctx.model.extend('flows_run', {
      id: 'string',
      flowId: 'string',
      flowName: 'string',
      botId: 'string',
      source: 'string',
      text: 'text',
      user: 'json',
      channel: 'string',
      status: 'string',
      node: 'json',
      startedAt: 'double',
      endedAt: 'double',
      error: 'text',
      stoppedBy: 'string',
      trace: 'json',
    }, { primary: 'id', indexes: [['botId', 'startedAt'], ['flowId', 'startedAt'], ['startedAt']] })
    const database = ctx.database
    this.database = database
    const prune = () => database.remove('flows_run', { startedAt: { $lt: Date.now() - KEEP_DAYS * DAY } }).catch(this.onError)
    void prune()
    const timer = setInterval(prune, DAY / 24)
    return () => {
      clearInterval(timer)
      if (this.database === database) this.database = undefined
    }
  }

  private emit(info: RunInfo) {
    try {
      this.onChange({ ...info })
    } catch {}
  }
}

/** The reason a run stopped by hand ends with. */
export class StopError extends FlowError {
  constructor(readonly by: string) {
    super(`Stopped by ${by}`)
  }
}

function infoOf(row: Partial<RunRow>): RunInfo {
  const info: RunInfo = {
    id: row.id!,
    flowId: row.flowId!,
    flowName: row.flowName ?? '',
    botId: row.botId!,
    source: row.source as TriggerSource,
    text: row.text ?? '',
    status: row.status as RunStatus,
    startedAt: row.startedAt!,
  }
  if (row.user) info.user = row.user
  if (row.channel) info.channel = row.channel
  if (row.node) info.node = row.node
  if (row.endedAt) info.endedAt = row.endedAt
  if (row.error) info.error = row.error
  if (row.stoppedBy) info.stoppedBy = row.stoppedBy
  return info
}

const text = (en: string, zh: string): LocalizedText => ({ en, 'zh-CN': zh })

/** `logic.stopRuns`: stops other runs on the bot, e.g. for a `/停止` command. */
export function stopRunsNode(store: RunStore): NodeType<{ flow: string; chat: boolean }> {
  return {
    kind: 'action',
    type: 'logic.stopRuns',
    category: 'logic',
    title: text('Stop runs', '停止执行'),
    description: text(
      'Stops other runs going on on this bot: of this flow, of every flow, or of the flow you pick. Continues on "stopped" when it stopped any (count says how many), else on "none". Test runs only show what it would stop.',
      '停止这个机器人上正在进行的其他运行：本流程的、所有流程的，或选定流程的。停止了至少一个时走“stopped”（count 为数量），否则走“none”。测试运行只显示要停止什么，不会真的停止。',
    ),
    config: z.object({
      flow: z.string().default('this').meta(field('Flow', 'Whose runs to stop: this flow, all flows, or a flow you pick', {
        'zh-CN': { title: '流程', description: '停止哪个流程的运行：本流程、所有流程，或选定的流程', options: { this: '本流程', all: '所有流程' } },
      }, { options: { this: 'This flow', all: 'All flows' }, choices: 'flows.choices' })),
      chat: z.boolean().default(true).meta(field('Only this chat', 'Only stop runs started in the same group or private chat', {
        'zh-CN': { title: '只限本会话', description: '只停止在同一个群或私聊里开始的运行' },
      })),
    }),
    inputs: [],
    outputs: [{ name: 'count', type: 'number', title: text('Stopped', '停止数量') }],
    execOut: ['stopped', 'none'],
    async run({ config, session, flow, bot, runId, test }) {
      const target = config.flow === 'this' ? flow.id : config.flow
      const chat = `${session.channel.type}:${session.channel.id}`
      if (test || !bot) {
        await bot?.call('flows.stop', { flow: config.flow === 'all' ? 'all' : target, ...(config.chat ? { channel: chat } : {}) })
        return { exec: 'none', outputs: { count: 0 } }
      }
      const count = store.stopWhere((info) => info.botId === bot.id
        && (config.flow === 'all' || info.flowId === target)
        && (!config.chat || info.channel === chat), `flow:${flow.name}`, runId)
      return { exec: count ? 'stopped' : 'none', outputs: { count } }
    },
  }
}
