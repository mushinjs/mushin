import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { type InstanceConfig, readJson } from '@mushinjs/core'
import { MCP_PATH, readAdminToken } from '@mushinjs/plugin-console'
import { DEFAULT_PORT } from './start'

/**
 * `mushin mcp`: an MCP server over stdio for AI tools started in the app folder. It forwards every message to
 * the running instance's `/mcp` endpoint with the admin token from `.env`, so the tool's own config holds no
 * secret. While Mushin.js is not running it still answers, says so, and tells the tool when the tools are back.
 */

/** The `/mcp` URL of an instance, from its config file. */
export async function mcpEndpoint(baseDir: string, port?: number) {
  const config = await readJson<InstanceConfig>(join(baseDir, 'mushin.config.json'))
  const server = config?.plugins.find((entry) => entry.package === '@cordisjs/plugin-server')?.config ?? {}
  const host = !server.host || server.host === '0.0.0.0' || server.host === '::' ? '127.0.0.1' : server.host
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${port ?? server.port ?? DEFAULT_PORT}`
  return { base, url: `${base}${MCP_PATH}` }
}

interface Message {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  params?: any
}

export interface BridgeOptions {
  baseDir: string
  /** The port Mushin.js runs on, when it was started with --port. */
  port?: number
  input?: NodeJS.ReadableStream
  write?: (line: string) => void
  /** How often to look for a stopped instance, in ms. */
  pollInterval?: number
}

export async function runBridge(options: BridgeOptions) {
  const { baseDir } = options
  const write = options.write ?? ((line: string) => process.stdout.write(line + '\n'))
  const send = (message: unknown) => write(JSON.stringify(message))
  const { base, url } = await mcpEndpoint(baseDir, options.port)
  let token = process.env.MUSHIN_ADMIN_TOKEN || readAdminToken(baseDir)
  let initialized = false
  let watching: NodeJS.Timeout | undefined

  const down = `Mushin.js is not running at ${base}. Ask the user to start it with "npm start" (or "pnpm start") in ${baseDir}; its tools appear here once it runs.`

  /** After a failed request, waits for the instance and tells the tool to list the tools again. */
  const watch = () => {
    if (watching || !initialized) return
    watching = setInterval(async () => {
      const up = await fetch(`${base}/api/health`).then((response) => response.ok, () => false)
      if (!up) return
      clearInterval(watching)
      watching = undefined
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    }, options.pollInterval ?? 3000)
    watching.unref?.()
  }

  const post = (message: Message) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token ?? ''}` },
    body: JSON.stringify(message),
  })

  /** What to answer while the instance is down. */
  const offline = (message: Message) => {
    switch (message.method) {
      case 'initialize':
        return {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'mushin', title: 'Mushin.js', version: '0' },
          instructions: down,
        }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: [] }
      case 'tools/call':
        return { content: [{ type: 'text', text: down }], isError: true }
      default:
        return undefined
    }
  }

  const handle = async (message: Message) => {
    const isRequest = message.id !== undefined && message.id !== null && typeof message.method === 'string'
    if (message.method === 'initialize') initialized = true
    let response: Response
    try {
      response = await post(message)
      if (response.status === 401) {
        // The token may have been reset since this bridge started.
        token = process.env.MUSHIN_ADMIN_TOKEN || readAdminToken(baseDir)
        response = await post(message)
      }
    } catch {
      watch()
      if (!isRequest) return
      const result = offline(message)
      send(result ? { jsonrpc: '2.0', id: message.id, result } : { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: down } })
      return
    }
    if (!isRequest) return
    const text = await response.text()
    let reply: any
    try {
      reply = JSON.parse(text)
    } catch {
      reply = { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `Mushin.js answered ${response.status}: ${text.slice(0, 200)}` } }
    }
    reply.id = message.id
    // The bridge tells the tool when the instance comes back, so the tools can change.
    if (message.method === 'initialize' && reply.result?.capabilities) reply.result.capabilities.tools = { listChanged: true }
    send(reply)
  }

  const lines = createInterface({ input: options.input ?? process.stdin, crlfDelay: Infinity })
  const pending = new Set<Promise<void>>()
  for await (const line of lines) {
    if (!line.trim()) continue
    let message: Message
    try {
      message = JSON.parse(line)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Each line must be one JSON-RPC message' } })
      continue
    }
    const task = handle(message).finally(() => pending.delete(task))
    pending.add(task)
  }
  await Promise.all(pending)
  if (watching) clearInterval(watching)
}

/** The `.mcp.json` of an app: the tool starts the bridge from the app folder, and no token is written down. */
export function mcpConfig() {
  return {
    mcpServers: {
      mushin: {
        type: 'stdio',
        command: 'node',
        args: ['node_modules/@mushinjs/cli/bin/mushin.js', 'mcp'],
      },
    },
  }
}
