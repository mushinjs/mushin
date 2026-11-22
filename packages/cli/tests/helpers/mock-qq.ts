import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type WebSocket, WebSocketServer } from 'ws'

/**
 * A stand-in for QQ's token service, OpenAPI and WebSocket gateway, enough for the adapter: it
 * hands out tokens, records API calls, and lets a test push events down the gateway.
 */
export async function startMockQQ() {
  const calls: { method: string; path: string; body: any; auth?: string }[] = []
  const identifies: any[] = []
  const sockets = new Set<WebSocket>()
  let counter = 0

  const read = (req: IncomingMessage) => new Promise<string>((resolve) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => resolve(body))
  })

  const server: Server = createServer(async (req, res) => {
    const body = await read(req)
    const path = req.url ?? '/'
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (path === '/app/getAppAccessToken') {
      const { appId, clientSecret } = JSON.parse(body)
      if (appId !== 'app1' || clientSecret !== 'secret-secret') return json(400, { code: 100016, message: 'invalid appid or secret' })
      return json(200, { access_token: `tok${++counter}`, expires_in: '7200' })
    }
    calls.push({ method: req.method!, path, body: body ? JSON.parse(body) : undefined, auth: req.headers.authorization })
    if (path === '/gateway') return json(200, { url: `ws://127.0.0.1:${port}/websocket` })
    if (path === '/users/@me') return json(200, { id: '9001', username: 'Mock QQ Bot' })
    if (path.endsWith('/files')) return json(200, { file_uuid: 'u1', file_info: 'info-1', ttl: 0 })
    if (path.endsWith('/messages')) return json(200, { id: `sent-${calls.length}`, timestamp: 1 })
    json(404, { code: 11241, message: 'not found' })
  })

  const wss = new WebSocketServer({ server, path: '/websocket' })
  wss.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }))
    socket.on('message', (raw) => {
      const payload = JSON.parse(raw.toString())
      if (payload.op === 2) {
        identifies.push(payload.d)
        socket.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { version: 1, session_id: 's1', user: { id: '9001', username: 'Mock QQ Bot', bot: true }, shard: [0, 1] } }))
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  let seq = 1

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    identifies,
    /** Sends a dispatch event to every connected gateway client. */
    dispatch(t: string, d: unknown, id?: string) {
      for (const socket of sockets) socket.send(JSON.stringify({ op: 0, s: ++seq, t, d, ...(id ? { id } : {}) }))
    },
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.terminate()
      wss.close()
      server.close(() => resolve())
    }),
  }
}
