import { Context, isMasked, mask, MushinError, type Risk, Service, z } from '@mushin/core'
import type {} from '@mushin/plugin-storage'
import { HttpTransport, McpClient, type McpTool, resultText, StdioTransport } from './client'

export * from './client'

declare module '@mushin/core' {
  interface Context {
    mcp: Mcp
  }

  interface Events {
    'mcp/changed'(): void
  }
}

const SERVERS = 'mcp/servers'

export interface McpServerRecord {
  /** Part of each tool's action name, `mcp.<id>.<tool>`. */
  id: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  enabled: boolean
  /** Tools not offered as actions. */
  disabledTools: string[]
  /** Risk per tool, overriding what the server's hints suggest. */
  risk?: Record<string, Risk>
  createdAt: number
}

export type McpStatus = 'stopped' | 'connecting' | 'connected' | 'error'

interface Runtime {
  client?: McpClient
  status: McpStatus
  error?: string
  tools: McpTool[]
  /** Removes the tool actions. */
  unregister: (() => void)[]
}

/** `read_file` → `readFile`, so the name fits an action name segment. */
export function actionSegment(name: string) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean)
  const camel = words.map((word, index) => (index ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase())).join('')
  return /^[a-z]/.test(camel) ? camel : `t${camel}`
}

/** Risk from the tool's hints: read-only tools read, destructive ones are dangerous, the rest write. */
export function toolRisk(tool: McpTool): Risk {
  if (tool.annotations?.readOnlyHint) return 'read'
  if (tool.annotations?.destructiveHint) return 'dangerous'
  return 'write'
}

const record = z.record(z.string(), z.string())

const serverFields = {
  name: z.string().trim().min(1).max(60),
  transport: z.enum(['stdio', 'http']).describe('stdio runs a local command; http connects to a Streamable HTTP endpoint'),
  command: z.string().optional().describe('stdio: the command, e.g. npx'),
  args: z.array(z.string()).optional().describe('stdio: its arguments, e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/data"]'),
  env: record.optional().describe('stdio: extra environment variables, e.g. API keys'),
  cwd: z.string().optional(),
  url: z.string().url().optional().describe('http: the endpoint URL'),
  headers: record.optional().describe('http: extra headers, e.g. Authorization'),
  enabled: z.boolean().optional(),
}

/** Connects to MCP servers and offers each of their tools as an action, so the Agent and flows can use them. */
export class Mcp extends Service {
  static inject = ['actions', 'storage']

  private home: Context
  private servers = new Map<string, McpServerRecord>()
  private runtimes = new Map<string, Runtime>()
  private disposed = false

  constructor(ctx: Context) {
    super(ctx, 'mcp')
    this.home = ctx
  }

  async *[Service.init]() {
    for (const key of await this.home.storage.list(SERVERS)) {
      const server = await this.home.storage.get<McpServerRecord>(key)
      if (server?.id) this.servers.set(server.id, server)
    }
    yield* this.defineActions()
    yield () => {
      this.disposed = true
      for (const id of this.runtimes.keys()) this.stop(id).catch(() => {})
    }
    for (const server of this.servers.values()) {
      if (server.enabled) this.start(server.id).catch(() => {})
    }
  }

  private changed() {
    if (!this.disposed) this.home.emit('mcp/changed')
  }

  get(id: string) {
    const server = this.servers.get(id)
    if (!server) throw new MushinError('not_found', `No MCP server "${id}"`)
    return server
  }

  /** A server as the dashboard and the Agent see it: secrets masked, with status and tools. */
  describe(server: McpServerRecord) {
    const runtime = this.runtimes.get(server.id)
    const masked = (values?: Record<string, string>) => values && Object.fromEntries(Object.entries(values).map(([key, value]) => [key, mask(value)]))
    return {
      ...server,
      env: masked(server.env),
      headers: masked(server.headers),
      status: runtime?.status ?? 'stopped',
      error: runtime?.error,
      serverInfo: runtime?.client?.server,
      stderr: runtime?.client?.stderr.slice(-20) ?? [],
      tools: (runtime?.tools ?? []).map((tool) => ({
        name: tool.name,
        title: tool.title ?? tool.annotations?.title,
        description: tool.description,
        action: `mcp.${server.id}.${actionSegment(tool.name)}`,
        risk: server.risk?.[tool.name] ?? toolRisk(tool),
        enabled: !server.disabledTools.includes(tool.name),
      })),
    }
  }

  list() {
    return [...this.servers.values()].sort((a, b) => a.createdAt - b.createdAt).map((server) => this.describe(server))
  }

  private async save(server: McpServerRecord) {
    this.servers.set(server.id, server)
    await this.home.storage.set(`${SERVERS}/${server.id}`, server)
    this.changed()
  }

  private check(server: Pick<McpServerRecord, 'transport' | 'command' | 'url'>) {
    if (server.transport === 'stdio' && !server.command?.trim()) throw new MushinError('invalid_input', 'A stdio server needs a command')
    if (server.transport === 'http' && !server.url) throw new MushinError('invalid_input', 'An HTTP server needs a URL')
  }

  async create(input: z.infer<z.ZodObject<typeof serverFields>> & { id?: string }) {
    this.check(input)
    let id = input.id ?? actionSegment(input.name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '')) ?? 'server'
    if (id === 't') id = 'server'
    if (this.servers.has(id)) {
      if (input.id) throw new MushinError('conflict', `An MCP server with id "${id}" already exists`)
      let n = 2
      while (this.servers.has(`${id}${n}`)) n++
      id = `${id}${n}`
    }
    const server: McpServerRecord = { ...input, id, enabled: input.enabled !== false, disabledTools: [], createdAt: Date.now() }
    await this.save(server)
    if (server.enabled) await this.start(id).catch(() => {})
    return this.describe(this.get(id))
  }

  async update(id: string, patch: Partial<z.infer<z.ZodObject<typeof serverFields>>>) {
    const current = this.get(id)
    // Masked values come back unchanged from forms: keep the stored secret.
    const merge = (next: Record<string, string> | undefined, old: Record<string, string> | undefined) => next && Object.fromEntries(Object.entries(next).map(([key, value]) => [key, isMasked(value) && old?.[key] ? old[key] : value]))
    const server: McpServerRecord = {
      ...current,
      ...patch,
      env: patch.env ? merge(patch.env, current.env) : current.env,
      headers: patch.headers ? merge(patch.headers, current.headers) : current.headers,
    }
    this.check(server)
    await this.save(server)
    await this.stop(id)
    if (server.enabled) await this.start(id).catch(() => {})
    return this.describe(this.get(id))
  }

  async remove(id: string) {
    this.get(id)
    await this.stop(id)
    this.servers.delete(id)
    this.runtimes.delete(id)
    await this.home.storage.delete(`${SERVERS}/${id}`)
    this.changed()
    return { deleted: id }
  }

  async setTool(id: string, tool: string, patch: { enabled?: boolean; risk?: Risk | null }) {
    const server = this.get(id)
    const next: McpServerRecord = { ...server, disabledTools: [...server.disabledTools], risk: { ...server.risk } }
    if (patch.enabled !== undefined) {
      next.disabledTools = patch.enabled ? next.disabledTools.filter((name) => name !== tool) : [...new Set([...next.disabledTools, tool])]
    }
    if (patch.risk === null) delete next.risk![tool]
    else if (patch.risk) next.risk![tool] = patch.risk
    await this.save(next)
    this.register(id)
    return this.describe(next)
  }

  /** Connects to a server and registers its tools. */
  async start(id: string) {
    const server = this.get(id)
    await this.stop(id)
    const runtime: Runtime = { status: 'connecting', tools: [], unregister: [] }
    this.runtimes.set(id, runtime)
    this.changed()
    const transport = server.transport === 'stdio'
      ? new StdioTransport({ command: server.command!, args: server.args, env: server.env, cwd: server.cwd })
      : new HttpTransport({ url: server.url!, headers: server.headers })
    const client = new McpClient(transport, {
      onToolsChanged: () => this.refreshTools(id, runtime).catch(() => {}),
      onClose: (error) => {
        if (this.runtimes.get(id) !== runtime) return
        this.unregister(runtime)
        runtime.status = 'error'
        runtime.error = error?.message ?? 'the connection was closed'
        this.home.logger('mcp').warn('MCP server %s stopped: %s', server.name, runtime.error)
        this.changed()
      },
    })
    runtime.client = client
    try {
      await client.connect()
      if (this.runtimes.get(id) !== runtime) return
      await this.refreshTools(id, runtime)
      runtime.status = 'connected'
      runtime.error = undefined
      this.home.logger('mcp').info('connected to MCP server %s: %d tool(s)', server.name, runtime.tools.length)
    } catch (error) {
      await client.close()
      if (this.runtimes.get(id) !== runtime) return
      runtime.status = 'error'
      runtime.error = error instanceof Error ? error.message : String(error)
      this.home.logger('mcp').warn('cannot connect to MCP server %s: %s', server.name, runtime.error)
      throw new MushinError('unavailable', `Cannot connect to ${server.name}: ${runtime.error}`)
    } finally {
      this.changed()
    }
  }

  async stop(id: string) {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    this.runtimes.set(id, { ...runtime, client: undefined, status: 'stopped', error: undefined, tools: [], unregister: [] })
    this.unregister(runtime)
    await runtime.client?.close()
    this.changed()
  }

  private async refreshTools(id: string, runtime: Runtime) {
    if (!runtime.client) return
    runtime.tools = await runtime.client.listTools()
    this.register(id)
  }

  private unregister(runtime: Runtime) {
    for (const dispose of runtime.unregister.splice(0)) {
      try {
        dispose()
      } catch {}
    }
  }

  /** (Re)registers the enabled tools of a connected server as actions. */
  private register(id: string) {
    const runtime = this.runtimes.get(id)
    const server = this.servers.get(id)
    if (!runtime?.client || !server || this.disposed) return
    this.unregister(runtime)
    const client = runtime.client
    const used = new Set<string>()
    for (const tool of runtime.tools) {
      if (server.disabledTools.includes(tool.name)) continue
      let segment = actionSegment(tool.name)
      while (used.has(segment)) segment += '2'
      used.add(segment)
      const schema = tool.inputSchema?.type === 'object' ? tool.inputSchema : { type: 'object', properties: {} }
      runtime.unregister.push(this.home.actions.define({
        name: `mcp.${server.id}.${segment}`,
        description: `[MCP ${server.name}] ${tool.description ?? tool.title ?? tool.name}`.slice(0, 1024),
        risk: server.risk?.[tool.name] ?? toolRisk(tool),
        input: z.record(z.string(), z.unknown()),
        inputSchema: schema,
        handler: async (input) => {
          const result = await client.callTool(tool.name, input)
          const text = resultText(result)
          if (result.isError) throw new MushinError('failed', text || `${tool.name} failed`)
          return { text, ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}) }
        },
      }))
    }
    this.changed()
  }

  private *defineActions() {
    const actions = this.home.actions
    const idInput = z.object({ id: z.string().describe('MCP server id from mcp.servers.list') })

    yield actions.define({
      name: 'mcp.servers.list',
      description: 'List MCP servers with their connection status and tools. Each enabled tool of a connected server is an action named mcp.<server id>.<tool>.',
      risk: 'read',
      input: z.object({}),
      handler: () => this.list(),
    })

    yield actions.define({
      name: 'mcp.servers.create',
      description: 'Add an MCP server and connect to it: a local command over stdio (e.g. npx -y @modelcontextprotocol/server-filesystem <dir>) or a Streamable HTTP URL. Its tools become actions for new Agent conversations.',
      risk: 'dangerous',
      input: z.object({ ...serverFields, id: z.string().regex(/^[a-z][a-zA-Z0-9]{0,30}$/).optional().describe('Short id used in action names; made from the name when omitted') }),
      handler: (input) => this.create(input),
    })

    yield actions.define({
      name: 'mcp.servers.update',
      description: 'Change an MCP server and reconnect. Masked secrets sent back unchanged keep their stored value.',
      risk: 'dangerous',
      input: idInput.extend({
        name: serverFields.name.optional(),
        transport: serverFields.transport.optional(),
        command: serverFields.command,
        args: serverFields.args,
        env: serverFields.env,
        cwd: serverFields.cwd,
        url: serverFields.url,
        headers: serverFields.headers,
        enabled: serverFields.enabled,
      }),
      handler: ({ id, ...patch }) => this.update(id, patch),
    })

    yield actions.define({
      name: 'mcp.servers.delete',
      description: 'Remove an MCP server and its tools.',
      risk: 'dangerous',
      input: idInput,
      handler: ({ id }) => this.remove(id),
    })

    yield actions.define({
      name: 'mcp.servers.restart',
      description: 'Reconnect to an MCP server and reload its tools.',
      risk: 'write',
      input: idInput,
      handler: async ({ id }) => {
        await this.start(id)
        return this.describe(this.get(id))
      },
    })

    yield actions.define({
      name: 'mcp.tools.update',
      description: 'Turn one tool of an MCP server on or off, or set its risk (read, write, dangerous; null for the server\'s hint).',
      risk: 'write',
      input: idInput.extend({
        tool: z.string().describe('The tool name as the server gives it'),
        enabled: z.boolean().optional(),
        risk: z.enum(['read', 'write', 'dangerous']).nullable().optional(),
      }),
      handler: ({ id, tool, ...patch }) => this.setTool(id, tool, patch),
    })
  }
}

export default Mcp
