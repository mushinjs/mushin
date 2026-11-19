import { readFileSync } from 'node:fs'
import { type ActionInfo, type Context, field, fromToolName, MushinError, type Risk, toErrorPayload, toToolName, z } from '@mushinjs/core'
import type {} from '@cordisjs/plugin-server'
import type {} from '@mushinjs/plugin-agent'

/** The MCP versions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

/** The tools listed directly; every other allowed action is reached through `search_tools` and `call_tool`. */
export const DEFAULT_TOOLS = [
  'system.info', 'logs.recent', 'plugins.list',
  'bots.list', 'bots.get', 'bots.logs', 'bots.messages', 'bots.sandbox',
  'flows.guide', 'flows.list', 'flows.get', 'flows.create', 'flows.update', 'flows.test', 'flows.runs', 'flows.nodeTypes',
]

export const SEARCH_TOOL = 'search_tools'
export const CALL_TOOL = 'call_tool'

/** Longest tool result, in characters; longer ones are cut with a note. */
const MAX_RESULT_CHARS = 60_000

type ToolPolicy = 'auto' | 'confirm' | 'off'

/** Where the endpoint is served. */
export const MCP_PATH = '/mcp'

/** The console settings for the MCP server; they sit beside the console's own in its config. */
export const mcpConfigFields = {
  mcp: z.boolean().default(true).meta(field('MCP server', 'Serve the actions at /mcp for AI tools such as Claude Code, with the admin token and the Agent\'s tool policy', {
    'zh-CN': { title: 'MCP 服务端', description: '在 /mcp 向 Claude Code 等 AI 工具提供 action，使用管理员令牌并遵守智能体的工具策略' },
  })),
  mcpTools: z.array(z.string()).default(DEFAULT_TOOLS).meta(field('MCP listed tools', 'Actions listed as MCP tools of their own. The others are found with search_tools and run with call_tool, which keeps the list short for the model.', {
    'zh-CN': { title: 'MCP 直接列出的工具', description: '单独列为 MCP 工具的 action。其余的通过 search_tools 查找、call_tool 调用，让模型看到的工具列表保持简短。' },
  })),
  mcpAll: z.boolean().default(false).meta(field('MCP: list every tool', 'List every allowed action as an MCP tool of its own', {
    'zh-CN': { title: 'MCP 列出全部工具', description: '把所有允许的 action 都单独列为 MCP 工具' },
  })),
}

export interface McpConfig {
  /** Actions listed as tools. */
  tools: string[]
  /** List every allowed action. */
  all: boolean
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: any
}

/** A JSON-RPC error with its code. */
class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message)
  }
}

interface ToolInfo {
  action: ActionInfo
  policy: ToolPolicy
}

/**
 * Serves the actions over MCP (Streamable HTTP, JSON responses), so the AI tool a user opens in the app folder
 * can manage the instance. It needs the admin token and follows the Agent's tool policy: tools turned off are not
 * offered, and tools that ask first wait for an answer in the dashboard.
 */
export class McpServer {
  constructor(private home: Context, public config: McpConfig, private authenticate: (token: string) => Promise<boolean>) {}

  /** Adds the routes; they go away with the console. */
  serve() {
    const { server } = this.home
    const path = MCP_PATH

    server.post(path, async (req, res) => {
      if (!this.allowedOrigin(req.headers.get('origin'))) {
        res.status = 403
        res.json(rpcError(null, -32000, 'Requests from web pages on other sites are refused'))
        return
      }
      const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
      if (!token || !(await this.authenticate(token))) {
        res.status = 401
        res.json(rpcError(null, -32001, 'Unauthorized: send the admin token from .env as "Authorization: Bearer <token>"'))
        return
      }
      let message: JsonRpcRequest
      try {
        message = JSON.parse(await req.text())
      } catch {
        res.status = 400
        res.json(rpcError(null, -32700, 'The body must be one JSON-RPC message'))
        return
      }
      if (Array.isArray(message) || !message || typeof message.method !== 'string') {
        // Responses from the client (we never ask it anything) and batches are not used.
        res.status = Array.isArray(message) ? 400 : 202
        if (Array.isArray(message)) res.json(rpcError(null, -32600, 'Batches are not supported'))
        else res.text('')
        return
      }
      if (message.id === undefined || message.id === null) {
        // A notification, such as notifications/initialized: nothing to answer.
        res.status = 202
        res.text('')
        return
      }
      const response = await this.handle(message)
      res.status = 200
      res.headers.set('content-type', 'application/json')
      res.json(response)
    })

    // No server-to-client stream: the tool list changes are picked up on the next tools/list.
    for (const method of ['get', 'delete'] as const) {
      server[method](path, async (_req, res) => {
        res.status = 405
        res.headers.set('allow', 'POST')
        res.text('')
      })
    }
  }

  /** A browser page on another site must not reach the endpoint; tools without an Origin header are fine. */
  private allowedOrigin(origin: string | null) {
    if (!origin) return true
    try {
      const { hostname } = new URL(origin)
      if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) return true
      return new URL(this.home.server.baseUrl).hostname === hostname
    } catch {
      return false
    }
  }

  /** Answers one request. */
  async handle(message: JsonRpcRequest) {
    try {
      return { jsonrpc: '2.0', id: message.id, result: await this.dispatch(message.method, message.params ?? {}) }
    } catch (error) {
      if (error instanceof RpcError) return rpcError(message.id ?? null, error.code, error.message)
      this.home.logger('mcp-server').warn(error)
      return rpcError(message.id ?? null, -32603, error instanceof Error ? error.message : String(error))
    }
  }

  private async dispatch(method: string, params: any) {
    switch (method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined
        return {
          protocolVersion: asked && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mushin', title: 'Mushin.js', version: VERSION },
          instructions: this.instructions(),
        }
      }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: await this.listTools() }
      case 'tools/call':
        return this.callTool(String(params.name ?? ''), params.arguments ?? {})
      default:
        throw new RpcError(-32601, `Unknown method: ${method}`)
    }
  }

  private instructions() {
    return [
      'This server is a running Mushin.js instance: a QQ chatbot framework with bots, conversation flows, plugins and an Agent.',
      'Its tools are Mushin.js actions; a tool name is the action name with "." written as "__" (bots__list is bots.list).',
      `Only some tools are listed. Use ${SEARCH_TOOL} to find the others by what they do, then run them with ${CALL_TOOL}.`,
      'Tools marked dangerous, and any the user set to ask first, wait for the user to approve them in the dashboard.',
      'Secrets are kept in .env and show up only as ${NAME} references: never ask the user to paste a key into a tool call when they can put it in .env.',
    ].join('\n')
  }

  /** Every action this server may run, with its policy. Turned-off and dashboard-only actions are left out. */
  async tools(): Promise<ToolInfo[]> {
    const agent = this.home.get('agent')
    const policies = new Map((await agent?.policies() ?? []).map((item) => [item.name, item.policy as ToolPolicy]))
    return this.home.actions.list()
      .filter((action) => action.agent && !action.client && !action.name.startsWith('agent.'))
      .map((action) => ({ action, policy: policies.get(action.name) ?? defaultPolicy(action.risk) }))
      .filter((tool) => tool.policy !== 'off')
  }

  async listTools() {
    const tools = await this.tools()
    const listed = this.config.all ? tools : tools.filter((tool) => this.config.tools.includes(tool.action.name))
    return [
      ...listed.map(describeTool),
      {
        name: SEARCH_TOOL,
        title: 'Search Mushin.js tools',
        description: `Find Mushin.js tools that are not listed, by words of what they do (e.g. "knowledge base", "permissions", "provider"). Returns each tool's name, description, risk and input schema; run one with ${CALL_TOOL}.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Words to look for in tool names and descriptions; empty lists every tool by name' },
            limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Most results to return (default 10)' },
          },
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: CALL_TOOL,
        title: 'Run a Mushin.js tool',
        description: `Run a Mushin.js tool found with ${SEARCH_TOOL}, by its name (bots__list or bots.list) and its input.`,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Tool name' },
            input: { type: 'object', description: 'The tool\'s input, matching its input schema', additionalProperties: true },
          },
          required: ['name'],
        },
      },
    ]
  }

  async search(query: string, limit = 10) {
    const tools = await this.tools()
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return { tools: tools.map((tool) => ({ name: toToolName(tool.action.name), risk: tool.action.risk })) }
    const scored = tools
      .map((tool) => {
        const name = tool.action.name.toLowerCase()
        const text = `${name} ${tool.action.plugin} ${tool.action.description}`.toLowerCase()
        const score = words.reduce((sum, word) => sum + (name.includes(word) ? 3 : 0) + (text.includes(word) ? 1 : 0), 0)
        return { tool, score }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.action.name.localeCompare(b.tool.action.name))
      .slice(0, Math.min(Math.max(limit, 1), 50))
    return { tools: scored.map(({ tool }) => ({ ...describeTool(tool), risk: tool.action.risk })) }
  }

  async callTool(tool: string, args: Record<string, any>): Promise<ToolResult> {
    try {
      if (tool === SEARCH_TOOL) return textResult(await this.search(String(args.query ?? ''), Number(args.limit) || 10))
      if (tool === CALL_TOOL) {
        if (typeof args.name !== 'string' || !args.name) throw new MushinError('invalid_input', `${CALL_TOOL} needs the name of a tool`)
        if (args.name === SEARCH_TOOL || args.name === CALL_TOOL) return this.callTool(args.name, args.input ?? {})
        return await this.run(args.name, args.input ?? {})
      }
      return await this.run(tool, args)
    } catch (error) {
      const payload = toErrorPayload(error)
      return { content: [{ type: 'text' as const, text: `${payload.code}: ${payload.message}` }], isError: true }
    }
  }

  private async run(tool: string, input: unknown) {
    const action = tool.includes('.') ? tool : fromToolName(tool)
    const found = (await this.tools()).find((item) => item.action.name === action)
    if (!found) throw new MushinError('not_found', `No tool "${tool}" here. Find tools with ${SEARCH_TOOL}; tools the user turned off are not offered.`)
    if (found.policy === 'confirm') await this.approve(found.action, input)
    const result = await this.home.actions.call(action, input, { kind: 'mcp' })
    return textResult(result ?? { ok: true })
  }

  /** Asks the user in the dashboard; nothing runs unless they allow it. */
  private async approve(action: ActionInfo, input: unknown) {
    let answer: any
    try {
      const shown = JSON.stringify(input ?? {})
      answer = await this.home.actions.call('ui.ask', {
        question: truncate(`An AI tool connected over MCP wants to run ${action.name}${action.risk === 'dangerous' ? ' (dangerous)' : ''} with ${shown}. Allow it?`, 300),
        options: [
          { label: 'Allow', description: 'Run it this once' },
          { label: 'Decline', description: 'Do not run it' },
        ],
      }, { kind: 'mcp' })
    } catch {
      throw new MushinError('forbidden', `${action.name} needs the user's approval in the dashboard, and no dashboard is open. Ask the user to open the dashboard, then try again.`)
    }
    if (answer?.choice !== 0) throw new MushinError('forbidden', `The user declined ${action.name}. Do not try it again unless they ask.`)
  }
}

/** The default for a risk level, as the Agent has it: dangerous actions ask first, the rest run. */
function defaultPolicy(risk: Risk): ToolPolicy {
  return risk === 'dangerous' ? 'confirm' : 'auto'
}

function describeTool({ action, policy }: ToolInfo) {
  const notes: string[] = []
  if (policy === 'confirm') notes.push(`${action.risk === 'dangerous' ? 'Dangerous: ' : ''}the user must approve it in the dashboard.`)
  return {
    name: toToolName(action.name),
    description: [action.description, ...notes].join(' '),
    inputSchema: { type: 'object', ...action.inputSchema },
    annotations: {
      readOnlyHint: action.risk === 'read',
      destructiveHint: action.risk === 'dangerous',
    },
  }
}

interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

function textResult(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return { content: [{ type: 'text', text: truncate(text, MAX_RESULT_CHARS, '… [cut; ask for less, e.g. with a filter or limit]') }] }
}

function truncate(text: string, max: number, note = '…') {
  return text.length <= max ? text : text.slice(0, max - note.length) + note
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

