import { describe, expect, it } from 'vitest'
import { seg } from '@mushin/core'
import { builtinNodes, compile, type FlowDocument, type FlowEdge, type FlowNode, type FlowSession, layout, migrateDataEdges, type NodeType, runFlow, triggerOrder } from '../src'

const types = new Map<string, NodeType>(builtinNodes.map((type) => [type.type, type]))
const logger = { info() {}, warn() {}, debug() {}, error() {} } as any

function flow(nodes: Partial<FlowNode>[], edges: [string, string, string, string][]): FlowDocument {
  return {
    id: 'f1',
    name: 'Test flow',
    bots: [],
    nodes: nodes.map((node, index) => ({ ...node, id: node.id ?? `n${index + 1}`, type: node.type!, position: { x: 0, y: 0 }, config: node.config ?? {} })),
    edges: edges.map(([source, sourceHandle, target, targetHandle], index): FlowEdge => ({ id: `e${index + 1}`, source, sourceHandle, target, targetHandle })),
    createdAt: 0,
    updatedAt: 0,
  }
}

function session(text: string, options: { user?: string; channel?: string; direct?: boolean } = {}) {
  const sent: any[] = []
  const value: FlowSession = {
    text,
    segments: [seg.text(text)],
    user: { id: options.user ?? '42', name: `user${options.user ?? '42'}` },
    channel: options.direct ? { type: 'private', id: options.user ?? '42' } : { type: 'group', id: options.channel ?? '500' },
    isDirect: !!options.direct,
    mentioned: false,
    send: async (content) => void sent.push(content),
    reply: async (content) => void sent.push(content),
  }
  return { value, sent }
}

function memoryVars() {
  const store = new Map<string, unknown>()
  return {
    forChat: (chat: string) => ({
      get: (scope: string, name: string) => store.get(`${scope === 'chat' ? chat : scope}|${name}`),
      set: (scope: string, name: string, value: unknown) => void store.set(`${scope === 'chat' ? chat : scope}|${name}`, value),
    }),
  }
}

async function run(doc: FlowDocument, text: string, extra: Partial<Parameters<typeof runFlow>[1]> = {}, options = {}) {
  const { value, sent } = session(text, options)
  const result = await runFlow(compile(doc, types), { session: value, vars: memoryVars().forChat('c'), logger, ...extra })
  return { ...result, sent }
}

const replyText = (sent: any[]) => sent.map((content) => (typeof content === 'string' ? content : content.text))

describe('compile', () => {
  it('accepts a keyword flow without issues', () => {
    const doc = flow([
      { type: 'trigger.keyword', config: { keywords: ['ping'] } },
      { type: 'action.reply', config: { text: 'pong' } },
    ], [['n1', 'exec:next', 'n2', 'exec']])
    expect(compile(doc, types).issues).toEqual([])
  })

  it('reports broken flows', () => {
    const doc = flow([
      { type: 'trigger.message' },
      { type: 'logic.if', inputs: { condition: '{{n9.result}}' } },
      { type: 'data.text' },
      { type: 'no.such.node' },
      { type: 'action.reply', inputs: { text: 'got {{n1.nothing}}', other: 'x' } },
    ], [
      ['n1', 'exec:next', 'n5', 'in:text'],
      ['n1', 'exec:next', 'nope', 'exec'],
    ])
    const messages = compile(doc, types).issues.map((issue) => `${issue.severity}: ${issue.message}`)
    expect(messages).toEqual(expect.arrayContaining([
      'error: Unknown node type "no.such.node"; is the plugin that provides it enabled?',
      'error: Connections only set what runs next; pass values with variable references such as {{n1.text}}',
      'error: A connection points at a node that does not exist',
      'error: "logic.if" references {{n9.result}}, but there is no node "n9"',
      'error: "action.reply" references {{n1.nothing}}, but "trigger.message" has no output "nothing"',
      'warning: "action.reply" has no input "other"',
      'warning: "logic.if" is not connected to a trigger, so it never runs',
    ]))
    expect(compile(doc, types).runnable).toBe(false)
  })

  it('validates node settings with their schema', () => {
    const doc = flow([{ type: 'trigger.regex', config: { pattern: '(' } }], [])
    expect(compile(doc, types).issues[0].message).toContain('not a valid regular expression')
  })

  it('gives classify nodes one exec output per label', () => {
    const doc = flow([
      { type: 'trigger.message' },
      { type: 'ai.classify', config: { labels: ['weather', 'joke'] } },
      { type: 'action.reply' },
    ], [
      ['n1', 'exec:next', 'n2', 'exec'],
      ['n2', 'exec:joke', 'n3', 'exec'],
      ['n2', 'exec:sports', 'n3', 'exec'],
    ])
    expect(compile(doc, types).issues.map((issue) => issue.message)).toEqual(['"ai.classify" has no "sports" output'])
  })
})

describe('runFlow', () => {
  it('runs a trigger, passes values by reference and replies with flow provenance', async () => {
    const doc = flow([
      { type: 'trigger.keyword', config: { keywords: ['echo'], mode: 'startsWith' } },
      { type: 'data.text', config: { template: '{user} said: {a}' }, inputs: { a: '{{n1.rest}}' } },
      { type: 'action.reply', label: 'Answer', inputs: { text: '{{n2.text}}' } },
    ], [
      ['n1', 'exec:next', 'n2', 'exec'],
      ['n2', 'exec:next', 'n3', 'exec'],
    ])
    const result = await run(doc, 'echo hello there')
    expect(result.matched).toBe(true)
    expect(result.consumed).toBe(true)
    expect(result.sent).toEqual([{ text: 'user42 said: hello there', source: { kind: 'flow', flow: 'Test flow', node: 'Answer' } }])
    expect(result.trace.steps.map((step) => step.nodeId)).toEqual(['n1', 'n2', 'n3'])
    expect(result.trace.edges).toEqual(['e1', 'e2'])
    expect(result.trace.replies).toEqual(['user42 said: hello there'])
    expect((await run(doc, 'something else')).matched).toBe(false)
  })

  it('fills references in text, settings and inputs, keeping the type of a lone reference', async () => {
    const doc = flow([
      { type: 'trigger.keyword', config: { keywords: ['add'], mode: 'startsWith' } },
      { type: 'data.increment', config: { name: 'n', scope: 'chat' } },
      { type: 'data.setVar', config: { name: 'last', scope: 'chat' }, inputs: { value: '{{n2.value}}' } },
      { type: 'action.reply', config: { text: '{{sys.user}} #{{chat.last}} ({{n1.rest}}) {{n9.none}}' } },
    ], [['n1', 'exec:next', 'n2', 'exec'], ['n2', 'exec:next', 'n3', 'exec'], ['n3', 'exec:next', 'n4', 'exec']])
    const result = await run(doc, 'add apples')
    expect(replyText(result.sent)).toEqual(['user42 #1 (apples) '])
    expect(result.trace.steps[2].inputs).toEqual({ value: 1 })
  })

  it('records step values and stops after a chosen node', async () => {
    const doc = flow([
      { type: 'trigger.keyword', config: { keywords: ['echo'], mode: 'startsWith' } },
      { type: 'data.text', config: { template: '{user} said: {a}' }, inputs: { a: '{{n1.rest}}' } },
      { type: 'action.reply', inputs: { text: '{{n2.text}}' } },
    ], [
      ['n1', 'exec:next', 'n2', 'exec'],
      ['n2', 'exec:next', 'n3', 'exec'],
    ])
    const full = await run(doc, 'echo hi')
    expect(full.trace.steps.map(({ nodeId, inputs, outputs }) => ({ nodeId, inputs, outputs }))).toEqual([
      { nodeId: 'n1', inputs: undefined, outputs: expect.objectContaining({ keyword: 'echo', rest: 'hi' }) },
      { nodeId: 'n2', inputs: { a: 'hi' }, outputs: { text: 'user42 said: hi' } },
      { nodeId: 'n3', inputs: { text: 'user42 said: hi' }, outputs: { messageId: '' } },
    ])

    const toText = await run(doc, 'echo hi', { stopAt: 'n2' })
    expect(toText.trace.stopAt).toBe('n2')
    expect(toText.trace.steps.map((step) => step.nodeId)).toEqual(['n1', 'n2'])
    expect(toText.sent).toEqual([])

    const toTrigger = await run(doc, 'echo hi', { stopAt: 'n1' })
    expect(toTrigger.trace.steps.map((step) => step.nodeId)).toEqual(['n1'])
  })

  it('branches on a comparison', async () => {
    const doc = flow([
      { type: 'trigger.message' },
      { type: 'logic.compare', config: { op: 'contains', value: 'yes' }, inputs: { a: '{{sys.text}}' } },
      { type: 'action.reply', config: { text: 'agreed' } },
      { type: 'action.reply', config: { text: 'not agreed' } },
    ], [
      ['n1', 'exec:next', 'n2', 'exec'],
      ['n2', 'exec:true', 'n3', 'exec'],
      ['n2', 'exec:false', 'n4', 'exec'],
    ])
    expect(replyText((await run(doc, 'YES please')).sent)).toEqual(['agreed'])
    expect(replyText((await run(doc, 'no thanks')).sent)).toEqual(['not agreed'])
  })

  it('keeps chat variables between messages and separates chats', async () => {
    const doc = flow([
      { type: 'trigger.keyword', config: { keywords: ['count'] } },
      { type: 'data.increment', config: { name: 'hits', scope: 'chat' } },
      { type: 'action.reply', config: { text: 'count is {{n2.value}}' } },
    ], [
      ['n1', 'exec:next', 'n2', 'exec'],
      ['n2', 'exec:next', 'n3', 'exec'],
    ])
    const compiled = compile(doc, types)
    const vars = memoryVars()
    const say = async (chat: string) => {
      const { value, sent } = session('count')
      await runFlow(compiled, { session: value, vars: vars.forChat(chat), logger })
      return replyText(sent)[0]
    }
    expect(await say('a')).toBe('count is 1')
    expect(await say('a')).toBe('count is 2')
    expect(await say('b')).toBe('count is 1')
  })

  it('cools down between runs', async () => {
    const doc = flow([
      { type: 'trigger.message' },
      { type: 'logic.cooldown', config: { seconds: 60, scope: 'chat' } },
      { type: 'action.reply', config: { text: 'hi' } },
    ], [['n1', 'exec:next', 'n2', 'exec'], ['n2', 'exec:ready', 'n3', 'exec']])
    const compiled = compile(doc, types)
    const vars = memoryVars().forChat('c')
    const first = session('a')
    const second = session('b')
    await runFlow(compiled, { session: first.value, vars, logger })
    const result = await runFlow(compiled, { session: second.value, vars, logger })
    expect(first.sent).toHaveLength(1)
    expect(second.sent).toHaveLength(0)
    expect(result.trace.steps.find((step) => step.nodeId === 'n2')?.exec).toBe('cooling')
  })

  it('routes by the label an LLM picks and records the model on LLM replies', async () => {
    const llm = {
      chat: async ({ messages }: any) => ({
        text: messages[0].content.startsWith('Classify') ? 'Question.' : 'Paris.',
        source: { provider: 'Mock', model: 'mock-model' },
      }),
    }
    const doc = flow([
      { type: 'trigger.message' },
      { type: 'ai.classify', config: { labels: ['greeting', 'question'] } },
      { type: 'ai.chat', label: 'Answer' },
      { type: 'action.reply', label: 'Send answer', inputs: { text: '{{n3.reply}}' } },
      { type: 'action.reply', config: { text: 'hello!' } },
    ], [
      ['n1', 'exec:next', 'n2', 'exec'],
      ['n2', 'exec:question', 'n3', 'exec'],
      ['n3', 'exec:next', 'n4', 'exec'],
      ['n2', 'exec:greeting', 'n5', 'exec'],
    ])
    const result = await run(doc, 'What is the capital of France?', { llm })
    expect(result.sent).toEqual([{ text: 'Paris.', source: { kind: 'flow', flow: 'Test flow', node: 'Send answer', provider: 'Mock', model: 'mock-model' } }])
    expect(result.trace.steps.find((step) => step.nodeId === 'n2')?.exec).toBe('question')
  })

  it('lets the message through when the trigger allows it', async () => {
    const doc = flow([{ type: 'trigger.message', config: { passThrough: true } }], [])
    const result = await run(doc, 'hi')
    expect(result).toMatchObject({ matched: true, consumed: false })
  })

  it('stops runaway loops', async () => {
    const doc = flow([
      { type: 'trigger.message' },
      { type: 'data.setVar', config: { name: 'x', scope: 'run' } },
    ], [['n1', 'exec:next', 'n2', 'exec'], ['n2', 'exec:next', 'n2', 'exec']])
    const result = await run(doc, 'go')
    expect(result.trace.error).toContain('Stopped after 200 steps')
  })

  it('reports a failing node in the trace', async () => {
    const doc = flow([{ type: 'trigger.message' }, { type: 'ai.chat' }], [['n1', 'exec:next', 'n2', 'exec']])
    const result = await run(doc, 'hi')
    expect(result.trace.error).toContain('No LLM provider is available')
    expect(result.trace.steps.at(-1)).toMatchObject({ nodeId: 'n2', error: expect.stringContaining('No LLM provider') })
  })

  it('reports each node as it starts and finishes, with the edge that led to it', async () => {
    const doc = flow([
      { type: 'trigger.keyword', config: { keywords: ['go'] } },
      { type: 'action.reply', config: { text: 'ok' } },
      { type: 'ai.chat' },
    ], [['n1', 'exec:next', 'n2', 'exec'], ['n2', 'exec:next', 'n3', 'exec']])
    const steps: any[] = []
    const result = await run(doc, 'go', { onStep: (step) => steps.push(step) })
    expect(steps.map(({ nodeId, edgeId, status }) => ({ nodeId, edgeId, status }))).toEqual([
      { nodeId: 'n1', edgeId: undefined, status: 'ok' },
      { nodeId: 'n2', edgeId: 'e1', status: 'running' },
      { nodeId: 'n2', edgeId: 'e1', status: 'ok' },
      { nodeId: 'n3', edgeId: 'e2', status: 'running' },
      { nodeId: 'n3', edgeId: 'e2', status: 'error' },
    ])
    expect(steps.every((step) => step.runId === result.trace.id && step.flowId === 'f1')).toBe(true)
  })
})

describe('skipped nodes', () => {
  it('passes through a skipped step to its first exec output without running it', async () => {
    const doc = flow([
      { type: 'trigger.keyword', config: { keywords: ['go'] } },
      { type: 'action.reply', config: { text: 'skipped' } },
      { type: 'action.reply', config: { text: 'after' } },
    ], [['n1', 'exec:next', 'n2', 'exec'], ['n2', 'exec:next', 'n3', 'exec']])
    doc.nodes[1].skip = true
    const steps: any[] = []
    const result = await run(doc, 'go', { onStep: (step) => steps.push(step.status) })
    expect(replyText(result.sent)).toEqual(['after'])
    expect(result.trace.steps.map(({ nodeId, skipped }) => ({ nodeId, skipped }))).toEqual([
      { nodeId: 'n1', skipped: undefined },
      { nodeId: 'n2', skipped: true },
      { nodeId: 'n3', skipped: undefined },
    ])
    expect(steps).toEqual(['ok', 'skipped', 'running', 'ok'])
  })

  it('never fires a skipped trigger', async () => {
    const doc = flow([{ type: 'trigger.message' }, { type: 'action.reply', config: { text: 'hi' } }], [['n1', 'exec:next', 'n2', 'exec']])
    doc.nodes[0].skip = true
    const result = await run(doc, 'hello')
    expect(result.matched).toBe(false)
    expect(result.sent).toEqual([])
  })
})

describe('adapters', () => {
  const onebotOnly: NodeType = { kind: 'action', type: 'x.onebot', category: 'platform', title: 'OneBot only', platforms: ['onebot'], run: () => {} }
  const withOneBot = new Map([...types, [onebotOnly.type, onebotOnly]])
  const doc = (adapter?: string) => ({
    ...flow([{ type: 'trigger.message' }, { type: 'x.onebot' }], [['n1', 'exec:next', 'n2', 'exec']]),
    ...(adapter ? { adapter } : {}),
  })

  it('warns about nodes the flow\'s adapter does not support', () => {
    expect(compile(doc('discord'), withOneBot).issues).toEqual([
      expect.objectContaining({ severity: 'warning', nodeId: 'n2', message: expect.stringContaining('needs a onebot bot') }),
    ])
  })

  it('accepts them on their adapter, or when the flow has none', () => {
    expect(compile(doc('onebot'), withOneBot).issues).toEqual([])
    expect(compile(doc(), withOneBot).issues).toEqual([])
  })
})

describe('migrateDataEdges', () => {
  it('turns data connections into references and puts data-only nodes on the path', () => {
    const doc = flow([
      { id: 'hello', type: 'trigger.keyword' },
      { id: 'count', type: 'data.increment' },
      { id: 'text', type: 'data.text', config: { template: 'visitor #{a}' } },
      { id: 'reply', type: 'action.reply' },
    ], [
      ['hello', 'exec:next', 'count', 'exec'],
      ['count', 'exec:next', 'reply', 'exec'],
      ['count', 'out:value', 'text', 'in:a'],
      ['text', 'out:text', 'reply', 'in:text'],
    ])
    const migrated = migrateDataEdges(doc.nodes, doc.edges, types)
    expect(migrated.changed).toBe(true)
    expect(migrated.nodes.find((node) => node.id === 'text')?.inputs).toEqual({ a: '{{count.value}}' })
    expect(migrated.nodes.find((node) => node.id === 'reply')?.inputs).toEqual({ text: '{{text.text}}' })
    const next = { ...doc, ...migrated }
    expect(compile(next, types).issues).toEqual([])
    const path = migrated.edges.map((edge) => `${edge.source}>${edge.target}`)
    expect(path).toEqual(expect.arrayContaining(['hello>count', 'count>text', 'text>reply']))
    expect(path).not.toContain('count>reply')
  })
})

describe('layout', () => {
  it('places nodes in columns by execution order', () => {
    const doc = flow([
      { type: 'trigger.message' },
      { type: 'data.text' },
      { type: 'action.reply' },
    ], [['n1', 'exec:next', 'n2', 'exec'], ['n2', 'exec:next', 'n3', 'exec']])
    for (const node of doc.nodes) node.position = { x: Number.NaN, y: Number.NaN }
    layout(doc)
    const x = Object.fromEntries(doc.nodes.map((node) => [node.id, node.position.x]))
    expect(x.n1).toBeLessThan(x.n2)
    expect(x.n2).toBeLessThan(x.n3)
  })
})

describe('command trigger', () => {
  const scoreFlow = () => flow([
    { id: 'score', type: 'trigger.command', config: { name: 'score', aliases: ['分数'], usage: '<分数:number> [备注]' } },
    { id: 'say', type: 'action.reply', config: { text: '{{score.分数}} / {{score.备注}} / {{score.command}}' } },
  ], [['score', 'exec:next', 'say', 'exec']])

  it('adds an output per argument, with names in any script', () => {
    const compiled = compile(scoreFlow(), types)
    expect(compiled.issues).toEqual([])
    expect(compiled.nodes.get('score')!.ports!.outputs.map((port) => port.name)).toEqual(expect.arrayContaining(['rest', 'args', '分数', '备注']))
  })

  it('parses arguments by the signature, by name or alias, ignoring case', async () => {
    expect(replyText((await run(scoreFlow(), '/Score 85 很好 加油')).sent)).toEqual(['85 / 很好 加油 / score'])
    expect(replyText((await run(scoreFlow(), '/分数 60')).sent)).toEqual(['60 /  / score'])
    expect((await run(scoreFlow(), '/scores 60')).matched).toBe(false)
    expect((await run(scoreFlow(), 'score 60')).matched).toBe(false)
  })

  it('replies with the usage when the arguments do not fit, and does not run', async () => {
    const result = await run(scoreFlow(), '/score abc')
    expect(result).toMatchObject({ matched: true, consumed: true })
    expect(replyText(result.sent)).toEqual(['用法：/score <分数:number> [备注]'])
    expect(result.trace.steps.map((step) => step.nodeId)).toEqual(['score'])
  })

  it('uses the prefix the bot parsed, and keeps admin-only commands to admins', async () => {
    const doc = flow([
      { id: 'kick', type: 'trigger.command', config: { name: 'kick', permission: 'admin' } },
      { id: 'say', type: 'action.reply', config: { text: 'kicked' } },
    ], [['kick', 'exec:next', 'say', 'exec']])
    const runAs = async (isAdmin: boolean) => {
      const { value, sent } = session('#kick')
      const result = await runFlow(compile(doc, types), {
        session: { ...value, command: { prefix: '#', name: 'kick', rest: '' }, isAdmin },
        vars: memoryVars().forChat('c'),
        logger,
      })
      return { ...result, sent }
    }
    expect((await runAs(false)).matched).toBe(false)
    expect(replyText((await runAs(true)).sent)).toEqual(['kicked'])
  })
})

describe('skipped triggers', () => {
  it('warns about steps only a skipped trigger leads to', () => {
    const doc = flow([
      { id: 'a', type: 'trigger.keyword', config: { keywords: ['a'] } },
      { id: 'b', type: 'trigger.keyword', config: { keywords: ['b'] } },
      { id: 'onlyA', type: 'action.reply', config: { text: 'a' } },
      { id: 'shared', type: 'action.reply', config: { text: 'both' } },
    ], [['a', 'exec:next', 'onlyA', 'exec'], ['onlyA', 'exec:next', 'shared', 'exec'], ['b', 'exec:next', 'shared', 'exec']])
    doc.nodes[0].skip = true
    const messages = compile(doc, types).issues.map((issue) => `${issue.nodeId}: ${issue.message}`)
    expect(messages).toEqual(['onlyA: "action.reply" only follows skipped triggers, so it never runs'])
  })
})

describe('trigger order', () => {
  const two = (first: Partial<FlowNode>, second: Partial<FlowNode>) => flow([
    { id: 'a', type: 'trigger.keyword', config: { keywords: ['hi'], mode: 'exact' }, ...first },
    { id: 'b', type: 'trigger.keyword', config: { keywords: ['hi'], mode: 'exact' }, ...second },
    { id: 'sayA', type: 'action.reply', config: { text: 'A' } },
    { id: 'sayB', type: 'action.reply', config: { text: 'B' } },
  ], [['a', 'exec:next', 'sayA', 'exec'], ['b', 'exec:next', 'sayB', 'exec']])

  it('runs the highest priority first and stops at a trigger that keeps the message', async () => {
    expect(replyText((await run(two({}, {}), 'hi')).sent)).toEqual(['A'])
    expect(replyText((await run(two({}, { priority: 5 }), 'hi')).sent)).toEqual(['B'])
    expect(replyText((await run(two({ config: { keywords: ['hi'], mode: 'exact', passThrough: true } }, {}), 'hi')).sent)).toEqual(['A', 'B'])
  })

  it('finds triggers an earlier one always or sometimes keeps from running', () => {
    const order = triggerOrder([compile(two({}, {}), types)])
    expect(order.map((slot) => [slot.nodeId, slot.certain, slot.blockedBy?.nodeId])).toEqual([['a', undefined, undefined], ['b', true, 'a']])
    const loose = flow([
      { id: 'a', type: 'trigger.keyword', config: { keywords: ['hi'], mode: 'contains' } },
      { id: 'b', type: 'trigger.keyword', config: { keywords: ['hi there'], mode: 'exact' } },
      { id: 'c', type: 'trigger.keyword', config: { keywords: ['bye'], mode: 'exact' } },
    ], [])
    expect(triggerOrder([compile(loose, types)]).map((slot) => slot.certain)).toEqual([undefined, false, undefined])
  })
})
