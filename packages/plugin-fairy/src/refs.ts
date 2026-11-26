import { type Context, z } from '@mushinjs/core'

/**
 * Something the user attaches to a message for Fairy to read: picked with `@` or dragged into the input.
 * Fairy gets what it is now, read the way its own tools read it.
 */
const labelField = { label: z.string().max(200).optional().describe('What the dashboard calls it, shown on the message') }

export const refInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bot'), id: z.string().describe('Bot id'), ...labelField }),
  z.object({ kind: z.literal('plugin'), id: z.string().describe('Plugin package name'), ...labelField }),
  z.object({ kind: z.literal('flow'), id: z.string().describe('Flow id'), ...labelField }),
  z.object({
    kind: z.literal('run'),
    id: z.string().describe('A run id from flows.history, or from bots.runs with bot'),
    bot: z.string().optional().describe('Set for a plugin\'s run from bots.runs: the bot it ran on'),
    at: z.number().optional().describe('When a plugin\'s run started (startedAt), to find it among older runs'),
    ...labelField,
  }),
  z.object({
    kind: z.literal('log'),
    lines: z.array(z.string().max(4000)).min(1).max(200).describe('The log lines as the user sees them'),
    source: z.string().max(200).optional().describe('Where they come from, e.g. a bot\'s name'),
    ...labelField,
  }),
  z.object({
    kind: z.literal('chat'),
    bot: z.string(),
    channel: z.string().describe('The chat\'s id'),
    id: z.string().describe('The message\'s record id, from bots.messages'),
    before: z.number().int().min(0).max(30).optional(),
    after: z.number().int().min(0).max(10).optional(),
    ...labelField,
  }),
])

export type FairyRef = z.output<typeof refInput>
export type FairyRefKind = FairyRef['kind']

/** A reference as the conversation keeps it, for showing on the message. */
export interface ShownRef {
  kind: FairyRefKind
  id?: string
  label: string
}

/** Most references one message may carry. */
export const MAX_REFS = 8
/** Most characters of one reference the model reads; a run's full trace can be long. */
const MAX_REF_CHARS = 8000

/** Tags for conversation search, as `resource:<kind>:<id>`, the way tool calls tag what they touch. */
export function refTags(refs: FairyRef[]) {
  return refs.flatMap((ref) => (ref.kind === 'bot' || ref.kind === 'flow' || ref.kind === 'plugin' ? [`resource:${ref.kind}:${ref.id}`] : []))
}

const attr = (value: string) => value.replace(/[\r\n]+/g, ' ').replaceAll('"', '\'').slice(0, 120)

function cut(text: string, more: string) {
  if (text.length <= MAX_REF_CHARS) return text
  return `${text.slice(0, MAX_REF_CHARS)}… [cut ${text.length - MAX_REF_CHARS} characters; ${more}]`
}

/** What one reference is now: the block the model reads, and the label the message shows. */
export async function readRef(home: Context, ref: FairyRef): Promise<{ block: string; shown: ShownRef }> {
  const call = (name: string, input: unknown) => home.actions.call(name, input, { kind: 'internal' }) as Promise<any>
  const json = (value: unknown) => JSON.stringify(value)
  const block = (attrs: Record<string, string>, intro: string, body: string) => [
    `<ref ${Object.entries(attrs).map(([key, value]) => `${key}="${attr(value)}"`).join(' ')}>`,
    intro,
    body,
    '</ref>',
  ].join('\n')
  switch (ref.kind) {
    case 'bot': {
      const bot = await call('bots.get', { id: ref.id })
      const label = ref.label || bot.name || ref.id
      return {
        block: block({ kind: 'bot', id: ref.id, name: label }, 'The user attached this bot. What bots.get returns now:', cut(json(bot), 'read the rest with bots.get')),
        shown: { kind: 'bot', id: ref.id, label },
      }
    }
    case 'flow': {
      const flow = await call('flows.get', { id: ref.id })
      const label = ref.label || flow.name || ref.id
      return {
        block: block({ kind: 'flow', id: ref.id, name: label }, 'The user attached this flow. What flows.get returns now (nodes, edges and issues):', cut(json(flow), 'read the rest with flows.get')),
        shown: { kind: 'flow', id: ref.id, label },
      }
    }
    case 'plugin': {
      const [catalog, entries, provides] = await Promise.all([
        call('plugins.catalog', {}).catch(() => []),
        call('plugins.list', {}).catch(() => []),
        call('plugins.provides', {}).catch(() => ({})),
      ])
      const pkg = (catalog as any[]).find((entry) => entry.package === ref.id)
      const used = (entries as any[]).filter((entry) => entry.package === ref.id).map(({ manifest, ...entry }) => entry)
      if (!pkg && !used.length) throw new Error(`No plugin package "${ref.id}" is installed`)
      const names = pkg?.manifest?.displayName
      const label = ref.label || (typeof names === 'string' ? names : names?.en) || ref.id
      const body = json({
        package: ref.id,
        ...(pkg ? { version: pkg.version, manifest: pkg.manifest } : {}),
        ...(used.length ? { entries: used } : {}),
        ...((provides as Record<string, unknown>)[ref.id] ? { provides: (provides as Record<string, unknown>)[ref.id] } : {}),
      })
      return {
        block: block({ kind: 'plugin', package: ref.id, name: label }, 'The user attached this plugin: its package, its app plugin entries (status and config, secrets masked) and what it adds:', cut(body, 'read the rest with plugins.catalog, plugins.list and plugins.provides')),
        shown: { kind: 'plugin', id: ref.id, label },
      }
    }
    case 'run': {
      if (ref.bot) {
        const { runs } = await call('bots.runs', { id: ref.bot, ...(ref.at ? { before: ref.at + 1, limit: 20 } : { limit: 300 }) })
        const run = (runs as any[]).find((item) => item.id === ref.id)
        if (!run) throw new Error('That run is no longer in the bot\'s recent runs')
        const lines = await call('bots.logs', { id: ref.bot, message: run.message, limit: 100 }).catch(() => [])
        const label = ref.label || `${run.plugin}: ${String(run.text ?? '').slice(0, 40)}`
        const body = json({ run, logs: (lines as any[]).map((line) => `${new Date(line.ts).toISOString()} ${line.type} [${line.name}] ${line.text}`) })
        return {
          block: block({ kind: 'run', id: ref.id, bot: ref.bot }, 'The user attached this run of a plugin on a message (bots.runs), with the log lines written while handling the message:', cut(body, 'read more with bots.logs')),
          shown: { kind: 'run', id: ref.id, label },
        }
      }
      const run = await call('flows.run', { id: ref.id })
      const label = ref.label || `${run.flowName ?? run.flowId}`
      return {
        block: block({ kind: 'run', id: ref.id, flow: run.flowId }, 'The user attached this flow run. What flows.run returns (the steps it went through with inputs and outputs, replies and error):', cut(json(run), 'read the rest with flows.run')),
        shown: { kind: 'run', id: ref.id, label },
      }
    }
    case 'log': {
      const label = ref.label || `${ref.lines.length} log lines`
      const intro = `The user attached ${ref.lines.length === 1 ? 'this log line' : `these ${ref.lines.length} log lines`}${ref.source ? ` from ${ref.source}` : ''}:`
      return {
        block: block({ kind: 'log', ...(ref.source ? { source: ref.source } : {}) }, intro, cut(ref.lines.join('\n'), 'ask the user for the rest, or read logs.recent or bots.logs')),
        shown: { kind: 'log', label },
      }
    }
    case 'chat':
      // Chats are read by Fairy itself, into a quote block; see `Fairy.quoteChat`.
      throw new Error('A chat is read with quoteChat')
  }
}

/** A reference that could not be read, as the model reads it: what it was and why. */
export function missingRef(ref: FairyRef, error: unknown) {
  const what = 'id' in ref ? `${ref.kind} "${ref.id}"` : ref.kind
  return {
    block: `<ref kind="${ref.kind}" missing="true">\nThe user attached the ${what}${ref.label ? ` (${attr(ref.label)})` : ''}, but it could not be read: ${error instanceof Error ? error.message : String(error)}\n</ref>`,
    shown: { kind: ref.kind, ...('id' in ref ? { id: ref.id } : {}), label: ref.label || ('id' in ref ? ref.id : ref.kind) } as ShownRef,
  }
}
