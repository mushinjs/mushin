import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'

export interface SentCall {
  action: string
  params: any
}

/**
 * A stand-in for NapCat's OneBot v11 implementation: a WebSocket server for forward mode,
 * and a client for reverse mode. Records every API call it receives.
 */
export async function createMockNapCat(options: { token?: string; selfId?: string; nickname?: string } = {}) {
  const selfId = options.selfId ?? '10001'
  const nickname = options.nickname ?? 'MockBot'
  const sent: SentCall[] = []
  const sockets = new Set<WebSocket>()
  let messageId = 1000
  /** Canned responses by action: data, a function of the params, or a failure. */
  const responses = new Map<string, any>()

  const handle = (socket: WebSocket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('message', (raw) => {
      const { action, params, echo } = JSON.parse(raw.toString())
      sent.push({ action, params })
      let data: any = {}
      if (action === 'get_login_info') data = { user_id: Number(selfId), nickname }
      if (action === 'send_group_msg' || action === 'send_private_msg') data = { message_id: ++messageId }
      if (responses.has(action)) {
        const canned = responses.get(action)
        const value = typeof canned === 'function' ? canned(params) : canned
        if (value?.failed) {
          socket.send(JSON.stringify({ status: 'failed', retcode: value.retcode ?? 1400, data: null, message: value.message ?? 'failed', wording: value.message ?? 'failed', echo }))
          return
        }
        data = value
      }
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }))
    })
    socket.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: Number(selfId), post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' }))
  }

  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (info: { req: { headers: Record<string, string | string[] | undefined> } }) => {
      if (!options.token) return true
      return info.req.headers.authorization === `Bearer ${options.token}`
    },
  })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  wss.on('connection', handle)

  const broadcast = (payload: object) => {
    for (const socket of sockets) socket.send(JSON.stringify(payload))
  }

  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    selfId,
    sent,
    get connections() {
      return sockets.size
    },
    /** Reverse mode: dial Mushin like NapCat's WebSocket client does. */
    connectTo(url: string, token?: string) {
      return new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url, {
          headers: { 'X-Self-ID': selfId, 'X-Client-Role': 'Universal', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        })
        socket.once('open', () => {
          handle(socket)
          resolve(socket)
        })
        socket.once('error', reject)
        socket.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
      })
    },
    pushGroupMessage(groupId: string, userId: string, message: { type: string; data: object }[], sender: { role?: string; card?: string } = {}) {
      const id = ++messageId
      broadcast({
        time: Math.floor(Date.now() / 1000), self_id: Number(selfId), post_type: 'message', message_type: 'group',
        sub_type: 'normal', message_id: id, group_id: Number(groupId), user_id: Number(userId),
        message, raw_message: '', font: 0, sender: { user_id: Number(userId), nickname: `user${userId}`, card: sender.card ?? '', ...(sender.role ? { role: sender.role } : {}) },
      })
      return id
    },
    /** A private message in a temporary chat started from a group (sub_type "group"). */
    pushTempMessage(groupId: string, userId: string, message: { type: string; data: object }[]) {
      broadcast({
        time: Math.floor(Date.now() / 1000), self_id: Number(selfId), post_type: 'message', message_type: 'private',
        sub_type: 'group', temp_source: 0, message_id: ++messageId, group_id: Number(groupId), user_id: Number(userId),
        message, raw_message: '', font: 0, sender: { user_id: Number(userId), nickname: `user${userId}` },
      })
    },
    /** Sends a raw event (notice, request, meta) with time and self_id filled in. */
    push(payload: Record<string, any>) {
      broadcast({ time: Math.floor(Date.now() / 1000), self_id: Number(selfId), ...payload })
    },
    /** Answers an action with fixed data, a function of its params, or `{ failed: true, retcode, message }`. */
    respond(action: string, value: any) {
      responses.set(action, value)
    },
    pushPrivateMessage(userId: string, message: { type: string; data: object }[]) {
      broadcast({
        time: Math.floor(Date.now() / 1000), self_id: Number(selfId), post_type: 'message', message_type: 'private',
        sub_type: 'friend', message_id: ++messageId, user_id: Number(userId),
        message, raw_message: '', font: 0, sender: { user_id: Number(userId), nickname: `user${userId}` },
      })
    },
    close: async () => {
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
