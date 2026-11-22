import type { ChannelInfo, Segment } from '@mushinjs/core'
import { mediaSource } from '@mushinjs/plugin-bots'
import type { QQApi } from './api'
import { type ChatKind, chatKind, FILE_TYPES, splitOutgoing } from './message'

/** QQ accepts a passive reply (one that names the message or event it answers) for this long. */
const PASSIVE_WINDOW = 5 * 60_000
const MAX_TRACKED = 2000

interface Recent {
  msgId?: string
  eventId?: string
  at: number
}

/**
 * Sends messages through the OpenAPI. Group and C2C bots may mostly only answer, so each message
 * names the latest message (or event) of its chat from the last five minutes, and numbers its
 * answers to that message with `msg_seq`, which QQ needs to tell them apart.
 */
export class QQSender {
  private recent = new Map<string, Recent>()
  private seq = new Map<string, number>()
  /** Guild members' DM sessions, by user id; sending a DM needs the session's guild. */
  private dms = new Map<string, string>()

  constructor(private api: QQApi) {}

  private remember<K, V>(map: Map<K, V>, key: K, value: V) {
    map.delete(key)
    map.set(key, value)
    if (map.size > MAX_TRACKED) map.delete(map.keys().next().value!)
  }

  /** Notes an incoming message or event, to answer it passively. */
  track(channel: ChannelInfo, ids: { msgId?: string; eventId?: string; dmsGuild?: string }) {
    if (ids.dmsGuild) this.remember(this.dms, channel.id, ids.dmsGuild)
    if (ids.msgId || ids.eventId) this.remember(this.recent, `${channel.type}:${channel.id}`, { msgId: ids.msgId, eventId: ids.eventId, at: Date.now() })
  }

  private passive(channel: ChannelInfo, reply?: string): { msg_id?: string; event_id?: string } {
    if (reply) return { msg_id: reply }
    const recent = this.recent.get(`${channel.type}:${channel.id}`)
    if (!recent || Date.now() - recent.at > PASSIVE_WINDOW) return {}
    return recent.msgId ? { msg_id: recent.msgId } : { event_id: recent.eventId }
  }

  private nextSeq(key: string | undefined) {
    if (!key) return 1
    const next = (this.seq.get(key) ?? 0) + 1
    this.remember(this.seq, key, next)
    return next
  }

  private path(kind: ChatKind, id: string) {
    if (kind === 'group') return `/v2/groups/${id}`
    if (kind === 'c2c') return `/v2/users/${id}`
    if (kind === 'channel') return `/channels/${id}`
    const guild = this.dms.get(id)
    if (!guild) throw new Error(`no DM session with guild member ${id} yet; they need to message the bot first`)
    return `/dms/${guild}`
  }

  async send(channel: ChannelInfo, segments: Segment[]): Promise<{ messageId?: string }> {
    const kind = chatKind(channel)
    const parts = splitOutgoing(segments, kind)
    const base = this.path(kind, channel.id)
    const passive = this.passive(channel, parts.reply)
    const ids: string[] = []
    if (kind === 'group' || kind === 'c2c') {
      const send = async (body: Record<string, any>) => {
        const result = await this.api.request('POST', `${base}/messages`, { ...body, ...passive, msg_seq: this.nextSeq(passive.msg_id ?? passive.event_id) })
        if (result?.id) ids.push(String(result.id))
      }
      if (parts.markdown !== undefined) await send({ msg_type: 2, markdown: { content: parts.markdown } })
      let text = parts.text.trim() ? parts.text : ''
      for (const media of parts.media) {
        const fileInfo = await this.upload(base, media)
        // The text goes with the first picture, as one message.
        await send({ msg_type: 7, media: { file_info: fileInfo }, ...(text ? { content: text } : {}) })
        text = ''
      }
      if (text) await send({ msg_type: 0, content: text })
    } else {
      const reference = parts.reply ? { message_reference: { message_id: parts.reply, ignore_get_message_error: true } } : {}
      const sendGuild = async (body: Record<string, any> | FormData) => {
        const result = await this.api.request('POST', `${base}/messages`, body)
        if (result?.id) ids.push(String(result.id))
      }
      let text = parts.text.trim() ? parts.text : ''
      if (parts.markdown !== undefined) await sendGuild({ markdown: { content: parts.markdown }, ...passive })
      for (const media of parts.media.filter((item) => item.type === 'image')) {
        const source = await mediaSource(media)
        if (source.kind === 'url') {
          await sendGuild({ image: source.url, ...(text ? { content: text } : {}), ...passive, ...reference })
        } else {
          const form = new FormData()
          form.set('file_image', new Blob([new Uint8Array(source.bytes)], { type: source.mime }), source.name)
          if (text) form.set('content', text)
          if (passive.msg_id) form.set('msg_id', passive.msg_id)
          if (passive.event_id) form.set('event_id', passive.event_id)
          await sendGuild(form)
        }
        text = ''
      }
      if (text) await sendGuild({ content: text, ...passive, ...reference })
    }
    return { messageId: ids[0] }
  }

  /** Uploads a picture, voice, video or file to a group or C2C chat; returns its `file_info`. */
  private async upload(base: string, segment: Segment) {
    const source = await mediaSource(segment)
    const body: Record<string, any> = { file_type: FILE_TYPES[segment.type] ?? 4, srv_send_msg: false }
    if (source.kind === 'url') body.url = source.url
    else body.file_data = source.bytes.toString('base64')
    const result = await this.api.request('POST', `${base}/files`, body)
    if (!result?.file_info) throw new Error(`uploading the ${segment.type} returned no file_info`)
    return String(result.file_info)
  }
}
