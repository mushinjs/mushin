import { type ChildProcess, spawn } from 'node:child_process'

/** The protocol version this client asks for; servers answer with the one they speak. */
export const PROTOCOL_VERSION = '2025-06-18'

export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, any>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string }
}

export interface McpCallResult {
  content?: { type: string; text?: string; [key: string]: unknown }[]
  structuredContent?: unknown
  isError?: boolean
}

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

/** Sends JSON-RPC messages to an MCP server and hands back what it sends. */
interface Transport {
  start(onMessage: (message: JsonRpcMessage) => void, onClose: (error?: Error) => void): Promise<void>
  /** Sends a message; an HTTP transport may answer it directly. */
  send(message: JsonRpcMessage): Promise<void>
  close(): Promise<void>
  /** Lines the server wrote to stderr, for the status page. */
  stderr?: string[]
}

export interface StdioOptions {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

/** Runs the server as a child process and talks over stdin and stdout, one JSON message per line. */
export class StdioTransport implements Transport {
  private child?: ChildProcess
  stderr: string[] = []

  constructor(private options: StdioOptions) {}

  start(onMessage: (message: JsonRpcMessage) => void, onClose: (error?: Error) => void) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args ?? [], {
        cwd: this.options.cwd || undefined,
        env: { ...process.env, ...this.options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true,
      })
      this.child = child
      let buffer = ''
      child.stdout!.setEncoding('utf8')
      child.stdout!.on('data', (chunk: string) => {
        buffer += chunk
        let index: number
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line) continue
          try {
            onMessage(JSON.parse(line))
          } catch {
            this.note(`not JSON on stdout: ${line.slice(0, 200)}`)
          }
        }
      })
      child.stderr!.setEncoding('utf8')
      child.stderr!.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) if (line.trim()) this.note(line)
      })
      child.once('spawn', () => resolve())
      child.once('error', (error) => {
        reject(error)
        onClose(error)
      })
      child.once('exit', (code, signal) => onClose(new Error(`the server exited (${signal ?? `code ${code}`})`)))
    })
  }

  private note(line: string) {
    this.stderr.push(line.slice(0, 500))
    if (this.stderr.length > 50) this.stderr.shift()
  }

  async send(message: JsonRpcMessage) {
    if (!this.child?.stdin?.writable) throw new Error('the server is not running')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  async close() {
    const child = this.child
    this.child = undefined
    if (!child || child.exitCode !== null) return
    child.stdin?.end()
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    const timer = setTimeout(() => child.kill(), 2000)
    await exited
    clearTimeout(timer)
  }
}

export interface HttpOptions {
  url: string
  headers?: Record<string, string>
}

/** Streamable HTTP: every message is a POST; the answer is JSON or a short event stream. */
export class HttpTransport implements Transport {
  private session?: string
  private version?: string
  private onMessage?: (message: JsonRpcMessage) => void
  private aborts = new Set<AbortController>()

  constructor(private options: HttpOptions) {}

  async start(onMessage: (message: JsonRpcMessage) => void) {
    this.onMessage = onMessage
  }

  /** Sets the protocol version header after initialization. */
  setVersion(version: string) {
    this.version = version
  }

  async send(message: JsonRpcMessage) {
    const abort = new AbortController()
    this.aborts.add(abort)
    try {
      const response = await fetch(this.options.url, {
        method: 'POST',
        headers: {
          ...this.options.headers,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.session ? { 'mcp-session-id': this.session } : {}),
          ...(this.version ? { 'mcp-protocol-version': this.version } : {}),
        },
        body: JSON.stringify(message),
        signal: abort.signal,
      })
      const session = response.headers.get('mcp-session-id')
      if (session) this.session = session
      if (response.status === 202 || response.status === 204) return
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
      }
      const type = response.headers.get('content-type') ?? ''
      if (type.includes('text/event-stream')) {
        await this.readEvents(response, message.id)
      } else if (type.includes('application/json')) {
        const body = await response.json()
        for (const item of Array.isArray(body) ? body : [body]) this.onMessage?.(item)
      }
    } finally {
      this.aborts.delete(abort)
    }
  }

  /** Reads server-sent events until the answer to `id` arrives. */
  private async readEvents(response: Response, id: JsonRpcMessage['id']) {
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += value.replace(/\r\n/g, '\n')
        let index: number
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
          if (!data) continue
          const message = JSON.parse(data) as JsonRpcMessage
          this.onMessage?.(message)
          if (id !== undefined && message.id === id && !message.method) return
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }
  }

  async close() {
    for (const abort of this.aborts) abort.abort()
    if (this.session) {
      await fetch(this.options.url, { method: 'DELETE', headers: { ...this.options.headers, 'mcp-session-id': this.session } }).catch(() => {})
    }
  }
}

/** One connection to an MCP server: initialize, list tools, call tools. */
export class McpClient {
  private next = 1
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  server?: { name?: string; version?: string }
  instructions?: string
  closed = false

  constructor(
    private transport: Transport,
    private hooks: { onToolsChanged?: () => void; onClose?: (error?: Error) => void } = {},
    private timeoutMs = 60_000,
  ) {}

  get stderr() {
    return this.transport.stderr ?? []
  }

  async connect() {
    await this.transport.start((message) => this.receive(message), (error) => this.fail(error))
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mushin', title: 'Mushin.js', version: '0.1.0' },
    })
    this.server = result?.serverInfo
    this.instructions = result?.instructions
    if (this.transport instanceof HttpTransport) this.transport.setVersion(result?.protocolVersion ?? PROTOCOL_VERSION)
    await this.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  async listTools() {
    const tools: McpTool[] = []
    let cursor: string | undefined
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : {})
      tools.push(...page?.tools ?? [])
      cursor = page?.nextCursor
    } while (cursor)
    return tools
  }

  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    return this.request('tools/call', { name, arguments: args ?? {} }, signal)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    await this.transport.close().catch(() => {})
    this.rejectAll(new Error('the connection was closed'))
  }

  private request(method: string, params: unknown, signal?: AbortSignal) {
    if (this.closed) return Promise.reject(new Error('the connection is closed'))
    const id = this.next++
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } }).catch(() => {})
        reject(new Error(`${method} timed out after ${Math.round(this.timeoutMs / 1000)}s`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      signal?.addEventListener('abort', () => {
        const entry = this.pending.get(id)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(id)
        this.transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'cancelled' } }).catch(() => {})
        reject(new Error('cancelled'))
      }, { once: true })
      this.transport.send({ jsonrpc: '2.0', id, method, params }).catch((error) => {
        const entry = this.pending.get(id)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private receive(message: JsonRpcMessage) {
    if (message.method) {
      if (message.id !== undefined) {
        // Requests from the server: answer pings, decline the rest (no sampling, roots or elicitation).
        const reply = message.method === 'ping'
          ? { jsonrpc: '2.0' as const, id: message.id, result: {} }
          : { jsonrpc: '2.0' as const, id: message.id, error: { code: -32601, message: `${message.method} is not supported` } }
        this.transport.send(reply).catch(() => {})
      } else if (message.method === 'notifications/tools/list_changed') {
        this.hooks.onToolsChanged?.()
      }
      return
    }
    const entry = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(message.id as number)
    if (message.error) entry.reject(new Error(message.error.message || `error ${message.error.code}`))
    else entry.resolve(message.result)
  }

  private fail(error?: Error) {
    if (this.closed) return
    this.closed = true
    this.rejectAll(error ?? new Error('the connection was closed'))
    this.hooks.onClose?.(error)
  }

  private rejectAll(error: Error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}

/** The text of a tool result, for the Agent: text parts joined, other parts summarized. */
export function resultText(result: McpCallResult) {
  const parts = (result.content ?? []).map((part) => {
    if (part.type === 'text') return part.text ?? ''
    if (part.type === 'resource' && typeof (part as any).resource?.text === 'string') return (part as any).resource.text
    if (part.type === 'resource_link') return `[${(part as any).name ?? 'resource'}](${(part as any).uri})`
    return `[${part.type}${(part as any).mimeType ? ` ${(part as any).mimeType}` : ''}]`
  })
  return parts.join('\n')
}
