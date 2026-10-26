import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { start } from '../../src/start'

export const TOKEN = 'test-admin-token'

export async function waitFor<T>(check: () => T | Promise<T>, timeout = 8000, interval = 50): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value as NonNullable<T>
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`timed out waiting${last ? `: ${last}` : ''}`)
}

/** Boots a real Mushin.js instance on a free port, in a temp directory unless `baseDir` names one to reuse. */
export async function startInstance(options: { baseDir?: string } = {}) {
  const baseDir = options.baseDir ?? await mkdtemp(join(tmpdir(), 'mushin-test-'))
  process.env.MUSHIN_ADMIN_TOKEN = TOKEN
  const instance = await start({ baseDir, port: 0, quiet: true })
  const { ctx } = instance

  // Plugins load asynchronously in dependency order; wait until every entry is active.
  await waitFor(() => ctx.manager.entries.every((entry) => ctx.manager.status(entry.id).status === 'active'), 15_000)
  const port = ctx.get('server')!.port
  const base = `http://127.0.0.1:${port}`

  async function call<T = any>(action: string, input: unknown = {}): Promise<T> {
    const response = await fetch(`${base}/api/actions/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const json = await response.json() as any
    if (!json.ok) throw Object.assign(new Error(json.error.message), json.error, { status: response.status })
    return json.result
  }

  /** A dashboard-like WebSocket client: collects events, runs client actions with `onClientCall`. */
  async function connect(onClientCall: (action: string, input: any) => unknown = () => ({ ok: true })) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`)
    const events: { name: string; data: any }[] = []
    const pending = new Map<string, (message: any) => void>()
    let counter = 0
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => socket.send(JSON.stringify({ type: 'auth', token: TOKEN, page: '/bots' })))
      socket.once('error', reject)
      socket.on('message', async (raw) => {
        const message = JSON.parse(raw.toString())
        if (message.type === 'ready') resolve()
        else if (message.type === 'event') events.push({ name: message.name, data: message.data })
        else if (message.type === 'result') pending.get(message.id)?.(message)
        else if (message.type === 'client-call') {
          const result = await onClientCall(message.action, message.input)
          socket.send(JSON.stringify({ type: 'client-result', id: message.id, ok: true, result }))
        }
      })
    })
    return {
      events,
      agentEvents: (session?: string) => events
        .filter((event) => event.name === 'agent/event' && (!session || event.data.session === session))
        .map((event) => event.data),
      call<T = any>(action: string, input: unknown = {}) {
        const id = String(++counter)
        return new Promise<T>((resolve, reject) => {
          pending.set(id, (message) => {
            pending.delete(id)
            if (message.ok) resolve(message.result)
            else reject(Object.assign(new Error(message.error.message), message.error))
          })
          socket.send(JSON.stringify({ type: 'call', id, action, input }))
        })
      },
      close: () => socket.close(),
    }
  }

  return {
    ctx,
    base,
    port,
    baseDir,
    call,
    connect,
    /** Stops the instance and deletes its directory, unless `keep` is set to start it again. */
    async stop(stopOptions: { keep?: boolean } = {}) {
      await instance.stop()
      if (!stopOptions.keep) await rm(baseDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

export type TestInstance = Awaited<ReturnType<typeof startInstance>>
