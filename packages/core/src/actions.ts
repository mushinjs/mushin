import { Context, Service } from 'cordis'
import { z } from 'zod'
import { MushinError } from './errors'

declare module 'cordis' {
  interface Context {
    actions: Actions
    /** The instance directory: config file, data and local plugins live here. */
    baseDir: string
  }

  interface Events {
    'actions/changed'(): void
    'actions/called'(record: ActionCallRecord): void
  }
}

export type Risk = 'read' | 'write' | 'dangerous'

export interface ActionCaller {
  kind: 'api' | 'agent' | 'internal'
  /** Agent session id, when the Agent made the call. */
  session?: string
  /** Dashboard connection id, used to route client actions back to the right tab. */
  client?: string
}

export interface ActionDefinition<S extends z.ZodType = z.ZodType, R = unknown> {
  /** Dotted lowercase name, such as `bots.create`. */
  name: string
  /** Written for the Agent: what the action does and what it returns. */
  description: string
  input: S
  risk: Risk
  /** Client actions run in the dashboard; the server relays them to the caller's tab. */
  client?: boolean
  handler?: (input: z.output<S>, caller: ActionCaller) => R | Promise<R>
}

export interface ActionInfo {
  name: string
  description: string
  risk: Risk
  client: boolean
  plugin: string
  inputSchema: JsonSchema
}

export interface ActionCallRecord {
  name: string
  caller: ActionCaller
  ok: boolean
  durationMs: number
  error?: string
}

export type JsonSchema = Record<string, any>

export type ClientRelay = (name: string, input: unknown, caller: ActionCaller) => Promise<unknown>

interface StoredAction extends ActionDefinition {
  plugin: string
  schema?: JsonSchema
}

/** Converts a zod schema to the JSON Schema shown to LLMs and dashboard forms. */
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema
  return rest
}

const namePattern = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/

/**
 * The registry of typed operations. The HTTP API and the Agent both call actions,
 * so a feature a plugin exposes here is reachable from the dashboard and by conversation.
 */
export class Actions extends Service {
  private store = new Map<string, StoredAction>()
  private relay?: ClientRelay

  constructor(ctx: Context) {
    super(ctx, 'actions')
  }

  /** Registers an action. It is removed when the calling plugin unloads. */
  define<S extends z.ZodType, R>(definition: ActionDefinition<S, R>) {
    if (!namePattern.test(definition.name)) {
      throw new Error(`invalid action name "${definition.name}", expected a dotted name such as "bots.create"`)
    }
    if (!definition.client && !definition.handler) {
      throw new Error(`action "${definition.name}" needs a handler`)
    }
    const ctx = this.ctx
    return ctx.effect(() => {
      if (this.store.has(definition.name)) {
        throw new Error(`action "${definition.name}" is already defined`)
      }
      this.store.set(definition.name, { ...(definition as ActionDefinition), plugin: ctx.fiber.name })
      ctx.emit('actions/changed')
      return () => {
        this.store.delete(definition.name)
        ctx.emit('actions/changed')
      }
    }, `actions.define(${definition.name})`)
  }

  /** Lets the console relay client actions to dashboard tabs. */
  setClientRelay(relay: ClientRelay) {
    return this.ctx.effect(() => {
      this.relay = relay
      return () => {
        if (this.relay === relay) this.relay = undefined
      }
    }, 'actions.setClientRelay()')
  }

  has(name: string) {
    return this.store.has(name)
  }

  get(name: string): ActionInfo | undefined {
    const action = this.store.get(name)
    return action && this.info(action)
  }

  list(): ActionInfo[] {
    return [...this.store.values()].map((action) => this.info(action)).sort((a, b) => a.name.localeCompare(b.name))
  }

  private info(action: StoredAction): ActionInfo {
    action.schema ??= toJsonSchema(action.input)
    return {
      name: action.name,
      description: action.description,
      risk: action.risk,
      client: !!action.client,
      plugin: action.plugin,
      inputSchema: action.schema,
    }
  }

  async call(name: string, input: unknown, caller: ActionCaller = { kind: 'internal' }): Promise<unknown> {
    const action = this.store.get(name)
    if (!action) throw new MushinError('not_found', `Unknown action: ${name}`)
    const parsed = action.input.safeParse(input ?? {})
    if (!parsed.success) {
      throw new MushinError('invalid_input', z.prettifyError(parsed.error), parsed.error.issues)
    }
    const start = Date.now()
    try {
      let result: unknown
      if (action.client) {
        if (!this.relay) throw new MushinError('unavailable', 'No dashboard is connected to run this action')
        result = await this.relay(name, parsed.data, caller)
      } else {
        result = await action.handler!(parsed.data, caller)
      }
      this.ctx.emit('actions/called', { name, caller, ok: true, durationMs: Date.now() - start })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.emit('actions/called', { name, caller, ok: false, durationMs: Date.now() - start, error: message })
      throw error
    }
  }
}

/** OpenAI tool names allow only letters, digits, `_` and `-`, so dots become double underscores. */
export function toToolName(action: string) {
  return action.replaceAll('.', '__')
}

export function fromToolName(tool: string) {
  return tool.replaceAll('__', '.')
}
