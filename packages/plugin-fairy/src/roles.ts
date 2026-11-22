import type { ActionInfo, Risk } from '@mushinjs/core'

/** Where a role comes from: shipped with Fairy or added by a plugin. */
export type RoleSource = 'builtin' | 'plugin'

/**
 * A helper Fairy hands a task to. It runs in a conversation of its own with its own instructions and a
 * subset of the tools, and ends by reporting back to Fairy, which decides what happens next.
 */
export interface FairyRole {
  id: string
  /** Shown to people, e.g. `Debug`. */
  name: string
  /** One line for Fairy: what to hand this role. */
  description: string
  /** How the role works, in Markdown; goes into its system prompt. */
  instructions: string
  /** Which actions it may use: any of these risk levels, plus the included patterns, minus the excluded ones. */
  tools: RoleTools
  source: RoleSource
  /** The plugin that added it. */
  plugin?: string
}

export interface RoleTools {
  /** Every action of these risk levels. */
  risks?: Risk[]
  /** Action names; `bots.*` matches every action under `bots.`. */
  include?: string[]
  exclude?: string[]
}

/** What a plugin passes to `ctx.fairy.defineRole()`. */
export type RoleDefinition = Omit<FairyRole, 'source' | 'plugin'>

function matches(name: string, pattern: string) {
  return pattern.endsWith('.*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern
}

/** Whether a role may use an action. Actions that run in the dashboard are never offered: a role works in the background. */
export function roleAllows(role: Pick<FairyRole, 'tools'>, action: Pick<ActionInfo, 'name' | 'risk' | 'client'>) {
  if (action.client) return false
  const { risks = [], include = [], exclude = [] } = role.tools
  if (exclude.some((pattern) => matches(action.name, pattern))) return false
  return risks.includes(action.risk) || include.some((pattern) => matches(action.name, pattern))
}

/** A role's report, as Fairy reads it. */
export interface TaskReport {
  /** `blocked`: the role needs something only the user can give, named in `next`. */
  status: 'done' | 'blocked' | 'failed'
  summary: string
  findings?: { title: string; detail?: string; where?: string; evidence?: string; fix?: string }[]
  changes?: string[]
  next?: string
}

export const BUILTIN_ROLES: RoleDefinition[] = [
  {
    id: 'debug',
    name: 'Debug',
    description: 'Finds out why something fails (an error the user saw, a bot that does not answer, a failed plugin, a flow that misbehaves) from logs, plugin status, flow runs and settings, and reports the cause. Changes nothing.',
    instructions: [
      'You investigate; you do not fix. Change nothing, even when the fix looks obvious: report it instead, and Fairy hands the fix to another helper.',
      '',
      'How to look:',
      '1. Start from what the task names (an error, a bot, a flow, a plugin, a time). "Just now" means the last few minutes before the time in the task.',
      '2. Read the logs first: logs.recent (filter by tag: plugin, bot, adapter, flow, provider, fairy, system) for Mushin.js itself, and bots.logs for one bot. Quote the exact lines that matter.',
      '3. Check the state around it: plugins.list for failed plugins and their errors, plugins.dependencies for missing ones, bots.get and bots.plugins.list for a bot, flows.history and flows.runs for flow runs, providers.list and providers.test for a model service.',
      '4. When a flow is involved, flows.get shows its issues, flows.route which flow takes a message, and flows.test replays a message without sending anything.',
      '5. Tell the cause apart from its symptoms. If there are several problems, list each one. If you cannot find the cause, say what you ruled out.',
      '',
      'In the report, give each finding a title, where it is (plugin package, bot id, flow id, provider id or file), the evidence (a log line or a value you read), and the fix you suggest (a setting to change, a plugin to enable, or code to change in which plugin).',
    ].join('\n'),
    tools: { risks: ['read'], include: ['providers.test', 'flows.test'] },
  },
  {
    id: 'setup',
    name: 'Setup',
    description: 'Installs and connects things: enables or configures app and bot plugins, creates and connects bots (NapCat over OneBot), adds and tests model providers and MCP servers, and sets permissions and personas.',
    instructions: [
      'You set things up and check that they work.',
      '',
      '1. Look before you change: list what is there, and read the schemas (providers.types, bots.adapters, plugins.dependencies) before creating or configuring anything.',
      '2. Make the change, then check it: providers.test after a provider, bots.get after a bot (its status), plugins.list after a plugin (active, not failed).',
      '3. NapCat: forward mode uses ws://127.0.0.1:3001 with the WebSocket server NapCat runs; reverse mode points a NapCat WebSocket client at ws://<this server>/onebot/<bot id>. Messages must use the "array" format and the tokens must match.',
      '4. If you need something only the user has (an API key, a QQ number, a choice between options), stop and report with status blocked, saying exactly what is needed in next. Never invent keys, ids or addresses.',
      '5. If a change fails, read the error and the logs (logs.recent) before trying once more.',
    ].join('\n'),
    tools: {
      include: ['plugins.*', 'bots.*', 'providers.*', 'mcp.servers.*', 'mcp.tools.*', 'personas.*', 'permissions.*', 'logs.recent', 'system.info', 'commands.list'],
      exclude: ['bots.send', 'bots.forward', 'bots.sandbox', 'bots.commands.run'],
    },
  },
  {
    id: 'builder',
    name: 'Builder',
    description: 'Builds or fixes conversation flows (node graphs that answer messages: keyword replies, commands, branching, LLM calls, variables) and tests them.',
    instructions: [
      'You build and fix conversation flows.',
      '',
      '1. Read flows.guide if you have not, then flows.nodeTypes without arguments for one line per node type, and flows.nodeTypes { types: [...] } for the types you will use. Use only node type ids it lists.',
      '2. Create the flow with flows.create on the bots the task names (bots.list gives their ids), or change one with flows.update after reading it with flows.get.',
      '3. Test with flows.test: a message that should trigger it and one that should not. Fix what fails and test again.',
      '4. If no node does what the task needs, the job needs a code plugin: say so in the report instead of forcing it.',
      '5. Report the flow id, what it does, and how the tests went.',
    ].join('\n'),
    tools: {
      include: ['flows.*', 'bots.list', 'bots.get', 'bots.plugins.list', 'bots.channels', 'bots.messages', 'commands.list', 'personas.list', 'personas.choices', 'kb.list', 'kb.choices', 'kb.flowChoices', 'providers.list', 'providers.choices'],
      exclude: ['flows.delete', 'flows.run'],
    },
  },
]

/** The system prompt of a role's conversation; fixed for that conversation's whole life. */
export function rolePrompt(role: Pick<FairyRole, 'name' | 'instructions'>) {
  return `You are the ${role.name} helper of Fairy, the assistant built into Mushin.js (a chatbot framework where every feature is a plugin; bots connect to QQ through NapCat). Fairy gave you one task. You work on it alone with your tools; nobody reads what you write until you report, so do not ask questions in text and do not wait for an answer.

${role.instructions.trim()}

Rules:
- Use only ids and names that your tools returned; never invent them.
- If a tool fails, read the error, fix the input and try once more; otherwise note the failure in your report.
- Keep within the task. If it needs something you cannot do with your tools, report that instead of working around it.

When you are done, or cannot go on, call fairy__report once. Give status (done; blocked when you need something only the user can give, named in next; failed when it could not be done), a short summary, your findings (each with title, detail, where, evidence and fix as fits), the changes you made, and next: what Fairy should do or ask the user next. Write the report in the language of the task.`
}

/** The first message of a role's conversation. */
export function taskMessage(task: string, context: string | undefined, now: Date) {
  return [`<task time="${now.toISOString()}">`, task.trim(), ...(context?.trim() ? ['', 'Context from Fairy:', context.trim()] : []), '</task>'].join('\n')
}
