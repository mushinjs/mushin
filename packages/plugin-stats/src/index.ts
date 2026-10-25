import { readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { Context, Service, z } from '@mushin/core'
import type {} from '@mushin/plugin-bots'
import type {} from '@mushin/plugin-flows'
import type {} from '@mushin/plugin-providers'
import type {} from '@mushin/plugin-storage'
import {
  bump, compact, type Counters, type DayDoc, dayHour, dayStart, type Dimension, emptyCounters, merge, type Metric, metricValues, sum, top,
} from './counters'

export * from './counters'

declare module '@mushin/core' {
  interface Context {
    stats: StatsService
  }

  interface Events {
    'stats/sample'(sample: PerfSample): void
  }
}

/** Process load at one moment: CPU in percent of one core, memory in bytes, event loop delay in ms. */
export interface PerfSample {
  t: number
  cpu: number
  rss: number
  heapUsed: number
  heapTotal: number
  loopMean: number
  loopMax: number
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** One sample every 5 seconds, an hour of them kept. */
const SAMPLE_EVERY = 5_000
const SAMPLE_LIMIT = 720
const FLUSH_EVERY = 30_000
/** Hourly buckets are kept this many days, then folded into one bucket per day. */
const HOURLY_DAYS = 30
/** Daily totals are kept this many days. */
const DAILY_DAYS = 365
const DATA_SIZE_TTL = 60_000
/** The event loop histogram measures timer ticks of this many ms; the delay is what goes beyond it. */
const LOOP_RESOLUTION = 10
const lag = (ns: number) => Math.max(0, Math.round((ns / 1e6 - LOOP_RESOLUTION) * 100) / 100)

const require = createRequire(import.meta.url)
const versionOf = (name: string) => {
  try {
    return (require(`${name}/package.json`) as { version: string }).version
  } catch {}
}

const METRICS = ['messages', 'received', 'sent', 'commands', 'flows', 'llmCalls', 'llmTokens'] as const satisfies Metric[]
const DIMENSIONS = ['channels', 'users', 'commands', 'flows', 'llm'] as const satisfies Dimension[]

async function directorySize(dir: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await directorySize(path)
    else if (entry.isFile()) total += (await stat(path).catch(() => undefined))?.size ?? 0
  }
  return total
}

/**
 * Counts messages, commands, flow runs and model requests per hour, stored as one document per
 * day under `stats/`, and samples the process's CPU, memory and event loop for the overview page.
 */
export class StatsService extends Service {
  static inject = ['storage', 'actions']

  private home: Context
  private days = new Map<string, DayDoc>()
  private dirty = new Set<string>()
  private samples: PerfSample[] = []
  private dataSize?: { at: number; bytes: number }
  private startedAt = Date.now()

  constructor(ctx: Context) {
    super(ctx, 'stats')
    this.home = ctx
  }

  async *[Service.init]() {
    const [today] = dayHour(Date.now())
    await this.prune(today)
    yield this.home.on('bots/message', (record) => this.count(record.timestamp, (counters, doc) => {
      if (record.direction === 'out') return bump(counters.out, record.botId)
      bump(counters.in, record.botId)
      const channel = `${record.botId}|${record.channel.type}:${record.channel.id}`
      const user = `${record.botId}|${record.user.id}`
      bump(counters.channels, channel)
      bump(counters.users, user)
      if (record.channel.name) doc.names[channel] = record.channel.name
      if (record.user.name) doc.names[user] = record.user.name
    }))
    yield this.home.on('bots/command', (call) => this.count(call.at, (counters) => bump(counters.commands, `${call.botId}|${call.name}`)))
    yield this.home.on('flows/run', (trace) => {
      if (trace.test) return
      this.count(trace.at, (counters, doc) => {
        bump(counters.flows, trace.flowId)
        if (trace.error) bump(counters.flowErrors, trace.flowId)
        const name = this.home.get('flows')?.list().find((flow) => flow.id === trace.flowId)?.name
        if (name) doc.names[`flow:${trace.flowId}`] = name
      })
    })
    yield this.home.on('llm/called', (call) => this.count(Date.now(), (counters) => {
      const usage = counters.llm[`${call.providerName}|${call.model}`] ??= { calls: 0, errors: 0, tokens: 0 }
      usage.calls++
      if (!call.ok) usage.errors++
      usage.tokens += (call.inputTokens ?? 0) + (call.outputTokens ?? 0)
    }))
    yield this.home.effect(() => {
      const timer = setInterval(() => {
        const [day] = dayHour(Date.now())
        this.flush().then(() => this.prune(day)).catch((error) => this.home.logger('stats').warn('saving statistics failed: %s', error))
      }, FLUSH_EVERY)
      return () => {
        clearInterval(timer)
        return this.flush()
      }
    }, 'stats flush')
    yield this.home.effect(() => this.sampler(), 'stats sampler')
    yield* this.defineActions()
  }

  // ---- counting ----

  private async load(day: string) {
    let doc = this.days.get(day)
    if (!doc) {
      const stored = await this.home.storage.get<DayDoc>(`stats/${day}`)
      // Counting may have started on this day while it was being read.
      doc = this.days.get(day) ?? { day, hours: stored?.hours ?? {}, names: stored?.names ?? {} }
      this.days.set(day, doc)
    }
    return doc
  }

  /** Adds to the bucket of the hour `time` falls in. */
  private count(time: number, update: (counters: Counters, doc: DayDoc) => void) {
    const [day, hour] = dayHour(time)
    const apply = (doc: DayDoc) => {
      update(doc.hours[hour] ??= emptyCounters(), doc)
      this.dirty.add(day)
    }
    const cached = this.days.get(day)
    if (cached) apply(cached)
    else this.load(day).then(apply).catch(() => {})
  }

  /** Writes changed days; days other than today leave memory once written. */
  async flush() {
    const [today] = dayHour(Date.now())
    for (const day of [...this.dirty]) {
      this.dirty.delete(day)
      const doc = this.days.get(day)
      if (doc) await this.home.storage.set(`stats/${day}`, doc)
    }
    for (const day of this.days.keys()) if (day !== today && !this.dirty.has(day)) this.days.delete(day)
  }

  /** Folds days past the hourly retention into daily totals and deletes days past the daily one. */
  private async prune(today: string) {
    const now = dayStart(today)
    for (const key of await this.home.storage.list('stats')) {
      const day = key.slice('stats/'.length)
      const age = (now - dayStart(day)) / DAY
      if (!Number.isFinite(age) || age < HOURLY_DAYS) continue
      if (age >= DAILY_DAYS) {
        await this.home.storage.delete(key)
        continue
      }
      const doc = await this.home.storage.get<DayDoc>(key)
      if (doc && !doc.hours['*']) await this.home.storage.set(key, compact(doc))
    }
  }

  /** Days covering the last `hours` hours, oldest first. */
  private async daysFor(from: number, to: number) {
    const docs: DayDoc[] = []
    for (let time = dayStart(dayHour(from)[0]); time <= to; time += DAY) {
      // Daylight saving can make a day 23 or 25 hours long; take the day the time falls in.
      docs.push(await this.load(dayHour(time + 2 * HOUR)[0]))
    }
    return docs
  }

  /** Counters for whole hours in [from, to], one bucket each, plus the doc they came from. */
  private async buckets(from: number, to: number) {
    const result: { time: number; counters: Counters; doc: DayDoc }[] = []
    for (const doc of await this.daysFor(from, to)) {
      const start = dayStart(doc.day)
      for (const [hour, counters] of Object.entries(doc.hours)) {
        const time = hour === '*' ? start : start + Number(hour) * HOUR
        if (time + (hour === '*' ? DAY : HOUR) <= from || time > to) continue
        result.push({ time, counters, doc })
      }
    }
    return result
  }

  // ---- queries ----

  /** Totals since local midnight. */
  async today() {
    const now = Date.now()
    const total = emptyCounters()
    for (const { counters } of await this.buckets(dayStart(dayHour(now)[0]), now)) merge(total, counters)
    const llm = Object.values(total.llm)
    return {
      received: sum(total.in),
      sent: sum(total.out),
      commands: sum(total.commands),
      flowRuns: sum(total.flows),
      flowErrors: sum(total.flowErrors),
      llmCalls: llm.reduce((count, usage) => count + usage.calls, 0),
      llmTokens: llm.reduce((count, usage) => count + usage.tokens, 0),
    }
  }

  /**
   * A metric over the last `hours` hours, one point per hour or per day, split into series (by bot
   * for messages, by provider and model for model usage).
   */
  async series(input: { metric: Metric; hours: number; granularity?: 'hour' | 'day' }) {
    const granularity = input.granularity ?? (input.hours > 72 ? 'day' : 'hour')
    const now = Date.now()
    const step = granularity === 'day' ? DAY : HOUR
    const first = granularity === 'day'
      ? dayStart(dayHour(now - (Math.ceil(input.hours / 24) - 1) * DAY)[0])
      : Math.floor(now / HOUR) * HOUR - (input.hours - 1) * HOUR
    const slotOf = (time: number) => (granularity === 'day' ? dayStart(dayHour(time)[0]) : Math.floor(time / HOUR) * HOUR)
    const points = new Map<number, Record<string, number>>()
    for (let time = first; time <= now; time += step) points.set(slotOf(time + (granularity === 'day' ? 2 * HOUR : 0)), {})
    const keys = new Set<string>()
    for (const { time, counters } of await this.buckets(first, now)) {
      const values = points.get(slotOf(time))
      if (!values) continue
      for (const [key, value] of Object.entries(metricValues(counters, input.metric))) {
        keys.add(key)
        bump(values, key, value)
      }
    }
    const bots = this.home.get('bots')
    const nameOf = (key: string) => {
      if (input.metric === 'messages' || input.metric === 'received' || input.metric === 'sent') {
        return bots?.list().find((bot) => bot.id === key)?.name ?? key
      }
      return key === 'total' ? key : key.replace('|', ' · ')
    }
    return {
      granularity,
      series: [...keys].sort().map((key) => ({ key, name: nameOf(key) })),
      points: [...points].map(([t, values]) => ({ t, values })),
    }
  }

  /** The most active chats, people, commands, flows or models over the last `days` days. */
  async top(input: { dimension: Dimension; days: number; limit?: number }) {
    const now = Date.now()
    const from = dayStart(dayHour(now - (input.days - 1) * DAY)[0])
    const total = emptyCounters()
    const names: Record<string, string> = {}
    for (const { counters, doc } of await this.buckets(from, now)) {
      merge(total, counters)
      Object.assign(names, doc.names)
    }
    const bots = this.home.get('bots')
    const flows = this.home.get('flows')
    const botName = (id: string) => bots?.list().find((bot) => bot.id === id)?.name
    return top(total, input.dimension, input.limit ?? 10).map(([key, count]) => {
      if (input.dimension === 'flows') {
        return { key, name: flows?.list().find((flow) => flow.id === key)?.name ?? names[`flow:${key}`] ?? key, count, errors: total.flowErrors[key] ?? 0 }
      }
      if (input.dimension === 'llm') {
        const [provider, model] = key.split('|')
        return { key, name: `${provider} · ${model}`, count, tokens: total.llm[key].tokens, errors: total.llm[key].errors }
      }
      const [botId, rest] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)]
      const name = input.dimension === 'commands' ? `/${rest}` : names[key] ?? rest.replace(/^(group|private):/, '')
      return { key, name, id: rest, botId, bot: botName(botId), count }
    })
  }

  /** The last hour of process samples, oldest first. */
  performance() {
    return this.samples
  }

  private sampler() {
    const histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION })
    histogram.enable()
    let cpu = process.cpuUsage()
    let at = performance.now()
    const timer = setInterval(() => {
      const nextCpu = process.cpuUsage()
      const nextAt = performance.now()
      const used = (nextCpu.user - cpu.user + nextCpu.system - cpu.system) / 1000
      const memory = process.memoryUsage()
      const sample: PerfSample = {
        t: Date.now(),
        cpu: Math.round((used / Math.max(1, nextAt - at)) * 1000) / 10,
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        loopMean: Number.isFinite(histogram.mean) ? lag(histogram.mean) : 0,
        loopMax: lag(histogram.max),
      }
      cpu = nextCpu
      at = nextAt
      histogram.reset()
      this.samples.push(sample)
      if (this.samples.length > SAMPLE_LIMIT) this.samples.splice(0, this.samples.length - SAMPLE_LIMIT)
      this.home.emit('stats/sample', sample)
    }, SAMPLE_EVERY)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      histogram.disable()
    }
  }

  private async dataDirSize() {
    if (!this.dataSize || Date.now() - this.dataSize.at > DATA_SIZE_TTL) {
      this.dataSize = { at: Date.now(), bytes: await directorySize(this.home.storage.dir) }
    }
    return this.dataSize.bytes
  }

  /** Everything the overview's number cards and version panel show. */
  async overview() {
    const bots = this.home.get('bots')
    const flows = this.home.get('flows')
    const llm = this.home.get('llm')
    const manager = this.home.manager
    const botList = bots?.list() ?? []
    const flowList = flows?.list() ?? []
    const providers = llm?.list() ?? []
    const commands = new Set((bots?.commandList().commands ?? []).map((entry) => `${entry.botId}|${entry.name.toLowerCase()}`))
    const catalog = await manager.catalog().catch(() => [])
    const versions = new Map(catalog.map((entry) => [entry.package, entry.version]))
    return {
      bots: { online: botList.filter((bot) => bot.status === 'online').length, total: botList.length },
      appPlugins: { enabled: manager.entries.filter((entry) => entry.enabled !== false).length, total: manager.entries.length },
      botPlugins: { enabled: botList.reduce((count, bot) => count + bot.plugins.filter((plugin) => plugin.enabled).length, 0) },
      flows: { total: flowList.length, withErrors: flowList.filter((flow) => flow.errors > 0).length },
      commands: commands.size,
      providers: { total: providers.length, passed: providers.filter((provider) => provider.lastTest?.ok).length },
      today: await this.today(),
      versions: {
        mushin: versionOf('@mushin/core'),
        node: process.version,
        cordis: versionOf('cordis'),
        plugins: manager.entries.map((entry) => ({ package: entry.package, enabled: entry.enabled !== false, version: versions.get(entry.package) })),
      },
      platform: `${process.platform} ${process.arch}`,
      startedAt: this.startedAt,
      uptime: Math.round(process.uptime()),
      dataBytes: await this.dataDirSize(),
      sample: this.samples.at(-1),
    }
  }

  // ---- actions ----

  private *defineActions() {
    const actions = this.home.actions

    yield actions.define({
      name: 'stats.overview',
      description: 'Instance at a glance: bots online, plugins, flows (and how many have errors), commands, providers, today\'s messages, commands, flow runs and model tokens, versions, uptime and data directory size.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.overview(),
    })

    yield actions.define({
      name: 'stats.series',
      description: 'A metric over time, one point per hour or day: messages (split by bot), received, sent, commands, flows (runs), llmCalls or llmTokens (split by provider and model).',
      risk: 'read',
      input: z.object({
        metric: z.enum(METRICS),
        hours: z.number().int().min(1).max(24 * 366).default(24).describe('How far back, e.g. 24 or 168 (7 days)'),
        granularity: z.enum(['hour', 'day']).optional().describe('Defaults to hour up to 3 days, day beyond'),
      }),
      handler: (input) => this.series(input),
    })

    yield actions.define({
      name: 'stats.top',
      description: 'The busiest chats, users, commands, flows or models (llm) over the last days, highest first.',
      risk: 'read',
      input: z.object({
        dimension: z.enum(DIMENSIONS),
        days: z.number().int().min(1).max(366).default(7),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      handler: (input) => this.top(input),
    })

    yield actions.define({
      name: 'stats.performance',
      description: 'Process CPU (percent of one core), memory (bytes) and event loop delay (ms), one sample every 5 seconds for the last hour.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.performance(),
    })
  }
}

export default StatsService
