import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type Context, type MessageRecord, messageType, segmentsToText } from '@mushin/core'
import type {} from '@mushin/plugin-database'
import type {} from '@mushin/plugin-storage'
import { $ } from 'minato'

declare module 'minato' {
  interface Tables {
    bots_message: MessageRow
  }
}

/** A message record as a row: the channel and user flattened so they can be filtered and indexed. */
export interface MessageRow {
  id: string
  bot: string
  messageId: string
  direction: string
  channelType: string
  channelId: string
  channelName: string
  fromGroup: string
  userId: string
  userName: string
  userRole: string
  /** Plain text, for searching. */
  text: string
  segments: any
  type: string
  platforms: any
  source: any
  replyTo: string
  timestamp: number
}

export function toRow(record: MessageRecord): MessageRow {
  return {
    id: record.id,
    bot: record.botId,
    messageId: record.messageId ?? '',
    direction: record.direction,
    channelType: record.channel.type,
    channelId: record.channel.id,
    channelName: record.channel.name ?? '',
    fromGroup: record.channel.fromGroup ?? '',
    userId: record.user.id,
    userName: record.user.name ?? '',
    userRole: record.user.role ?? '',
    text: segmentsToText(record.segments ?? []),
    segments: record.segments ?? [],
    type: record.type ?? messageType(record.segments ?? []),
    platforms: record.platforms ?? [],
    source: record.source ?? { kind: 'user' },
    replyTo: record.replyTo ?? '',
    timestamp: record.timestamp,
  }
}

export function fromRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    botId: row.bot,
    ...(row.messageId ? { messageId: row.messageId } : {}),
    direction: row.direction as MessageRecord['direction'],
    channel: {
      type: row.channelType as 'group' | 'private',
      id: row.channelId,
      ...(row.channelName ? { name: row.channelName } : {}),
      ...(row.fromGroup ? { fromGroup: row.fromGroup } : {}),
    },
    user: {
      id: row.userId,
      ...(row.userName ? { name: row.userName } : {}),
      ...(row.userRole ? { role: row.userRole as 'owner' | 'admin' | 'member' } : {}),
    },
    segments: row.segments ?? [],
    timestamp: row.timestamp,
    ...(row.replyTo ? { replyTo: row.replyTo } : {}),
    type: row.type as MessageRecord['type'],
    platforms: row.platforms ?? [],
    source: row.source ?? { kind: 'user' },
  }
}

const IMPORT_BATCH = 500

export interface MessageQuery {
  limit: number
  channel?: string
  /** Only messages sent before this time (ms). */
  before?: number
}

/**
 * Message records in the `bots_message` table, next to the daily JSONL files that are always
 * written. Created when the database plugin runs; imports the JSONL lines it does not have yet.
 */
export class MessageArchive {
  /** False until the JSONL import is done; until then the JSONL files answer queries. */
  ready = false
  private pending = new Set<Promise<unknown>>()
  /** Records that arrived during the import, saved right after it. */
  private queued: MessageRecord[] = []

  constructor(private ctx: Context, private onError: (error: unknown) => void) {
    ctx.model.extend('bots_message', {
      id: 'string',
      bot: 'string',
      messageId: 'string',
      direction: 'string',
      channelType: 'string',
      channelId: 'string',
      channelName: 'string',
      fromGroup: 'string',
      userId: 'string',
      userName: 'string',
      userRole: 'string',
      text: 'text',
      segments: 'json',
      type: 'string',
      platforms: 'json',
      source: 'json',
      replyTo: 'string',
      timestamp: 'double',
    }, { primary: 'id', indexes: [['bot', 'timestamp'], ['bot', 'channelId', 'timestamp']] })
  }

  /** Imports the JSONL files, then saves what arrived meanwhile. Returns how many lines were imported. */
  async start() {
    const imported = await this.importLogs()
    const queued = this.queued.splice(0)
    if (queued.length) await this.ctx.database.upsert('bots_message', queued.map(toRow))
    this.ready = true
    return imported
  }

  add(record: MessageRecord) {
    if (!this.ready) {
      this.queued.push(record)
      return
    }
    const task = this.ctx.database.create('bots_message', toRow(record)).catch(this.onError)
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
  }

  /** The newest messages of a bot that match, oldest first. */
  async query(bot: string, options: MessageQuery): Promise<MessageRecord[]> {
    await Promise.all(this.pending)
    const rows = await this.ctx.database
      .select('bots_message', {
        bot,
        ...(options.channel ? { channelId: options.channel } : {}),
        ...(options.before ? { timestamp: { $lt: options.before } } : {}),
      })
      .orderBy('timestamp', 'desc')
      .limit(options.limit)
      .execute()
    return rows.reverse().map(fromRow)
  }

  /**
   * Imports the daily JSONL files under `messages/<bot>/` that hold messages newer than the newest
   * stored for that bot: everything the first time, then whatever was written while the database
   * plugin was off. The files stay where they are.
   */
  private async importLogs() {
    const root = join(this.ctx.storage.dir, 'messages')
    let imported = 0
    for (const bot of await readdir(root).catch(() => [] as string[])) {
      const newest = Number(await this.ctx.database.select('bots_message', { bot }).execute((row) => $.max(row.timestamp))) || 0
      const since = newest ? new Date(newest).toISOString().slice(0, 10) : ''
      const days = (await readdir(join(root, bot)).catch(() => [] as string[]))
        .filter((name) => name.endsWith('.jsonl') && name.slice(0, -'.jsonl'.length) >= since)
        .sort()
      for (const day of days) {
        const records = (await this.ctx.storage.tail<MessageRecord>(`messages/${bot}/${day.slice(0, -'.jsonl'.length)}`, Infinity))
          .filter((record) => record?.id && record.timestamp > newest)
        for (let i = 0; i < records.length; i += IMPORT_BATCH) {
          await this.ctx.database.upsert('bots_message', records.slice(i, i + IMPORT_BATCH).map((record) => toRow({ ...record, botId: record.botId ?? bot })))
        }
        imported += records.length
      }
    }
    return imported
  }
}
