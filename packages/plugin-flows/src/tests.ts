import { randomId, z } from '@mushin/core'
import { parseSignature } from '@mushin/plugin-bots'
import type { CompiledFlow } from './graph'
import type { LlmLike, RunTrace, Variables, VariableScope } from './types'

/** What a test case checks after its run. */
export const Assertion = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reply'),
    match: z.enum(['equals', 'contains', 'regex']).default('equals'),
    value: z.string(),
    index: z.number().int().min(0).optional().describe('Which reply, from 0; any reply when omitted'),
  }).describe('A reply equals, contains or matches the value'),
  z.object({ kind: z.literal('noReply') }).describe('The flow sends nothing'),
  z.object({ kind: z.literal('matched'), value: z.boolean() }).describe('Whether a trigger of the flow starts at all'),
  z.object({ kind: z.literal('visits'), node: z.string(), not: z.boolean().optional() }).describe('The run passes through a node (or, with not, never does)'),
  z.object({ kind: z.literal('branch'), node: z.string(), exec: z.string() }).describe('A node continues on this exec output, e.g. "true", "deny", "timeout"'),
  z.object({
    kind: z.literal('variable'),
    scope: z.enum(['chat', 'user', 'flow']),
    name: z.string(),
    value: z.string().describe('Expected value as text; objects and arrays as JSON'),
  }).describe('A variable has this value after the run'),
  z.object({ kind: z.literal('call'), action: z.string(), not: z.boolean().optional() }).describe('The flow makes (or, with not, does not make) this platform API call, e.g. set_group_ban'),
  z.object({ kind: z.literal('noError') }).describe('No node fails'),
  z.object({ kind: z.literal('judge'), criterion: z.string().min(1) }).describe('An LLM checks the replies against this sentence, e.g. "politely refuses"; needs a provider'),
])

export type Assertion = z.infer<typeof Assertion>

export const TestCaseInput = z.object({
  name: z.string().min(1).max(120),
  input: z.object({
    text: z.string().optional(),
    userName: z.string().optional(),
    private: z.boolean().optional(),
    mentioned: z.boolean().optional(),
    role: z.enum(['master', 'admin', 'user']).optional(),
    groupRole: z.enum(['owner', 'admin', 'member']).optional(),
    event: z.object({ name: z.string(), data: z.record(z.string(), z.any()).optional() }).optional(),
    schedule: z.string().optional(),
  }).describe('The message (or event, or schedule trigger) that starts the run'),
  replies: z.array(z.string()).default([]).describe('Later messages in the same chat, answering "wait for reply" nodes in order'),
  vars: z.array(z.object({ scope: z.enum(['chat', 'user', 'flow']), name: z.string().min(1), value: z.any() })).default([])
    .describe('Variables set before the run; every case starts from no variables otherwise'),
  llm: z.object({
    mode: z.enum(['mock', 'real']).default('mock'),
    replies: z.array(z.string()).default([]).describe('Mock answers of LLM nodes in order; the last repeats'),
  }).default({ mode: 'mock', replies: [] }),
  expect: z.array(Assertion).default([]),
})

export type TestCaseInput = z.infer<typeof TestCaseInput>

export interface TestCase extends TestCaseInput {
  id: string
  createdAt: number
  updatedAt: number
}

export interface CaseResult {
  id: string
  name: string
  passed: boolean
  /** One line per failed assertion, by its index in `expect`. */
  failures: { index: number; message: string }[]
  ms: number
  trace: RunTrace
}

export interface TestRunSummary {
  flowId: string
  at: number
  /** Who asked: the editor, saving the flow, the Agent, the CLI or a task. */
  source: string
  passed: number
  failed: number
  /** Node ids no case reached. */
  uncovered: string[]
  results: Omit<CaseResult, 'trace'>[]
}

export interface TestsDocument {
  cases: TestCase[]
  /** Run every case after the flow is saved. */
  autoRun?: boolean
  lastRun?: TestRunSummary
}

export const MOCK_REPLY = '（模拟的大模型回复）'

/** An LLM that answers from a list, for test cases; the last answer repeats. */
export function mockLlm(replies: string[]): LlmLike {
  let index = 0
  return {
    chat: async () => {
      const text = replies.length ? replies[Math.min(index++, replies.length - 1)] : MOCK_REPLY
      return { text, source: { provider: 'mock', model: 'mock' } }
    },
  }
}

/** Variables for one case, starting from the case's presets; nothing outside the case sees them. */
export function scratchVars(presets: TestCaseInput['vars']) {
  const values = new Map<string, unknown>()
  const vars: Pick<Variables, 'get' | 'set'> = {
    get: (scope: VariableScope, name: string) => values.get(`${scope}|${name}`),
    set: (scope: VariableScope, name: string, value: unknown) => void values.set(`${scope}|${name}`, value),
  }
  for (const item of presets) vars.set(item.scope, item.name, item.value)
  return vars
}

const asText = (value: unknown) => (value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value))

export interface CheckContext {
  trace: RunTrace
  matched: boolean
  vars: Pick<Variables, 'get'>
  judge?: (criterion: string, replies: string[]) => Promise<{ ok: boolean; reason: string }>
}

/** Why an assertion failed, or nothing when it holds. */
export async function check(assertion: Assertion, context: CheckContext): Promise<string | undefined> {
  const { trace } = context
  const quote = (value: string) => JSON.stringify(value)
  switch (assertion.kind) {
    case 'reply': {
      const candidates = assertion.index === undefined ? trace.replies : [trace.replies[assertion.index]].filter((item) => item !== undefined)
      const fits = (reply: string) => {
        if (assertion.match === 'equals') return reply === assertion.value
        if (assertion.match === 'contains') return reply.includes(assertion.value)
        try {
          return new RegExp(assertion.value).test(reply)
        } catch {
          return false
        }
      }
      if (candidates.some(fits)) return
      const which = assertion.index === undefined ? 'No reply' : `Reply ${assertion.index + 1}`
      const verb = assertion.match === 'equals' ? 'equals' : assertion.match === 'contains' ? 'contains' : 'matches'
      return `${which} ${verb} ${quote(assertion.value)}; got ${trace.replies.length ? trace.replies.map(quote).join(', ') : 'no replies'}`
    }
    case 'noReply':
      return trace.replies.length ? `Expected no reply; got ${trace.replies.map(quote).join(', ')}` : undefined
    case 'matched':
      return context.matched === assertion.value ? undefined : assertion.value ? 'No trigger started' : 'A trigger started'
    case 'visits': {
      const visited = trace.steps.some((step) => step.nodeId === assertion.node && !step.skipped)
      if (visited === !assertion.not) return
      return assertion.not ? `Ran node ${assertion.node}` : `Did not reach node ${assertion.node}`
    }
    case 'branch': {
      const step = trace.steps.find((item) => item.nodeId === assertion.node)
      if (!step) return `Did not reach node ${assertion.node}`
      return step.exec === assertion.exec ? undefined : `Node ${assertion.node} went to "${step.exec ?? '-'}", not "${assertion.exec}"`
    }
    case 'variable': {
      const actual = asText(context.vars.get(assertion.scope, assertion.name))
      return actual === assertion.value ? undefined : `Variable ${assertion.scope}.${assertion.name} is ${quote(actual)}, not ${quote(assertion.value)}`
    }
    case 'call': {
      const made = (trace.calls ?? []).some((call) => call.action === assertion.action)
      if (made === !assertion.not) return
      return assertion.not ? `Called ${assertion.action}` : `Did not call ${assertion.action}`
    }
    case 'noError': {
      const failed = trace.steps.find((step) => step.error)
      if (failed) return `Node ${failed.nodeId} failed: ${failed.error}`
      return trace.error ? `The run failed: ${trace.error}` : undefined
    }
    case 'judge': {
      if (!context.judge) return 'Judging replies needs an LLM provider'
      const verdict = await context.judge(assertion.criterion, trace.replies)
      return verdict.ok ? undefined : `Judge: ${verdict.reason}`
    }
  }
}

/** Asks a model whether the replies meet the criterion. */
export async function judgeWith(llm: LlmLike, criterion: string, replies: string[]) {
  const result = await llm.chat({
    maxTokens: 200,
    messages: [
      { role: 'system', content: 'You review the replies of a chat bot. Decide whether they meet the criterion. Answer "PASS" or "FAIL" on the first line, then one short sentence why.' },
      { role: 'user', content: `Criterion: ${criterion}\n\nBot replies:\n${replies.length ? replies.map((reply, i) => `${i + 1}. ${reply}`).join('\n') : '(no reply)'}` },
    ],
  })
  const [first, ...rest] = result.text.trim().split('\n')
  return { ok: /^\W*pass/i.test(first), reason: rest.join(' ').trim() || first.trim() }
}

// ---- generating cases ----

/** One way to start a run, before it is known which path it takes. */
export interface Candidate {
  input: TestCaseInput['input']
  replies: string[]
  llm: string[]
  /** Short words for the case name, such as "admin" or "private". */
  tags: string[]
}

const MAX_CANDIDATES = 60

/** Values the flow compares against, as strings: numbers give the value and its neighbors. */
function interestingValues(flow: CompiledFlow) {
  const numbers = new Set<string>()
  const words = new Set<string>()
  for (const { node, config } of flow.nodes.values()) {
    if (node.type !== 'logic.compare' && node.type !== 'logic.if') continue
    const value = String(config.value ?? '').trim()
    if (!value || value.includes('{{')) continue
    const number = Number(value)
    if (Number.isFinite(number)) {
      for (const item of config.op === 'equals' || config.op === 'notEquals' ? [number, number + 1] : [number - 1, number, number + 1]) numbers.add(String(item))
    } else {
      words.add(value)
    }
  }
  return { numbers: [...numbers], words: [...words] }
}

/** A text the pattern accepts, built from its literal parts; good enough for simple patterns. */
function sampleForPattern(pattern: string, fill: string) {
  return pattern
    .replace(/^\^|\$$/g, '')
    .replace(/\\d[+*]?|\[0-9\][+*]?/g, fill || '1')
    .replace(/\\s[+*]?/g, ' ')
    .replace(/\\w[+*]?|\.[+*]/g, 'a')
    .replace(/\(\?:|\(|\)|\?|\+|\*/g, '')
    .replace(/\\(.)/g, '$1')
    .split('|')[0]
}

/**
 * Inputs worth trying for each trigger: matching messages with the values the flow compares
 * against, the roles and chats its checks care about, each label of a classify node and both
 * outcomes of waiting for a reply. Running them and keeping one per distinct path gives cases
 * that cover the branches.
 */
export function candidates(flow: CompiledFlow, prefix = '/'): Candidate[] {
  const { numbers, words } = interestingValues(flow)
  const types = new Set([...flow.nodes.values()].map((entry) => entry.node.type))
  const triggerConfigs = flow.triggers.map((id) => flow.nodes.get(id)!).filter((entry) => !entry.node.skip)
  const checksRoles = types.has('logic.permission') || triggerConfigs.some((entry) => entry.node.type === 'trigger.command' && entry.config.permission !== 'all')
  const roles: ('user' | 'admin' | 'master')[] = checksRoles ? ['user', 'admin', 'master'] : ['user']
  const classify = [...flow.nodes.values()].find((entry) => entry.node.type === 'ai.classify')
  const llmChoices: string[][] = classify ? [...(classify.config.labels as string[]).filter(Boolean), 'other'].map((label) => [label]) : [[]]
  const replyChoices: string[][] = types.has('logic.waitReply') ? [['好的'], []] : [[]]

  const starts: Candidate[] = []
  for (const entry of triggerConfigs) {
    const { node, config } = entry
    const add = (input: Candidate['input'], tags: string[] = []) => starts.push({ input, replies: [], llm: [], tags })
    switch (node.type) {
      case 'trigger.keyword': {
        const keyword = (config.keywords as string[]).find(Boolean) ?? ''
        add({ text: keyword })
        for (const value of [...numbers, ...words]) add({ text: `${keyword} ${value}` })
        break
      }
      case 'trigger.command': {
        const name = `${prefix}${String(config.name).replace(/^[/#!！]+/, '')}`
        const args = parseSignature(config.usage)
        const fill = (arg: { type: string }, value?: string) => value ?? (arg.type === 'number' ? '1' : 'test')
        const required = args.filter((arg) => !arg.optional)
        add({ text: [name, ...required.map((arg) => fill(arg))].join(' ') })
        if (required.length) add({ text: name }, ['no arguments'])
        const first = args[0]
        if (first) {
          for (const value of first.type === 'number' ? numbers : [...words, ...numbers]) {
            add({ text: [name, value, ...args.slice(1).filter((arg) => !arg.optional).map((arg) => fill(arg))].join(' ') })
          }
        }
        break
      }
      case 'trigger.regex': {
        const values = numbers.length ? numbers : ['1']
        for (const value of values) add({ text: sampleForPattern(String(config.pattern), value) })
        break
      }
      case 'trigger.message': {
        const when = config.when as string
        add({ text: 'hello', private: when === 'private', mentioned: when === 'mention' || when === 'groupMention' })
        for (const value of words) add({ text: value, private: when === 'private', mentioned: when === 'mention' || when === 'groupMention' })
        if (when === 'any') add({ text: 'hello', private: true }, ['private'])
        break
      }
      case 'trigger.schedule':
        add({ schedule: node.id }, ['schedule'])
        break
      default:
        break
    }
  }

  const result: Candidate[] = []
  const seen = new Set<string>()
  for (const start of starts) {
    for (const role of roles) {
      for (const llm of llmChoices) {
        for (const replies of replyChoices) {
          const input = { ...start.input, ...(role !== 'user' ? { role } : {}) }
          const key = JSON.stringify([input, llm, replies])
          if (seen.has(key)) continue
          seen.add(key)
          result.push({
            input,
            replies,
            llm,
            tags: [...start.tags, ...(role !== 'user' ? [role] : []), ...(llm.length ? [`→ ${llm[0]}`] : []), ...(types.has('logic.waitReply') && !replies.length ? ['no reply'] : [])],
          })
          if (result.length >= MAX_CANDIDATES) return result
        }
      }
    }
  }
  return result
}

/** The steps that decide the path: nodes with more than one exec output, with the one taken. */
export function branchSteps(flow: CompiledFlow, trace: RunTrace) {
  return trace.steps.filter((step) => {
    const entry = flow.nodes.get(step.nodeId)
    return entry?.type?.kind === 'action' && (entry.ports?.execOut.length ?? 0) > 1 && step.exec && !step.skipped
  })
}

/** Assertions that describe what a run did, for a case made from it (a snapshot). */
export function snapshot(flow: CompiledFlow, trace: RunTrace): Assertion[] {
  const expect: Assertion[] = trace.replies.length
    ? trace.replies.map((value, index) => ({ kind: 'reply' as const, match: 'equals' as const, value, index }))
    : [{ kind: 'noReply' as const }]
  for (const step of branchSteps(flow, trace)) expect.push({ kind: 'branch', node: step.nodeId, exec: step.exec! })
  for (const action of new Set((trace.calls ?? []).map((call) => call.action))) expect.push({ kind: 'call', action })
  return expect
}

export function newCase(input: TestCaseInput, now = Date.now()): TestCase {
  return { ...input, id: randomId(6), createdAt: now, updatedAt: now }
}
