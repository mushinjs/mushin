import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testCommand } from '../src/test'
import { startInstance, type TestInstance } from './helpers/instance'

let app: TestInstance

beforeAll(async () => {
  app = await startInstance()
})

afterAll(async () => {
  await app?.stop()
})

const exec = (source: string, target: string, output = 'next') => ({ source, sourceHandle: `exec:${output}`, target, targetHandle: 'exec' })

async function scoreFlow() {
  return app.call('flows.create', {
    name: 'Score',
    nodes: [
      { id: 'cmd', type: 'trigger.command', config: { name: 'score', usage: '<n:number>' } },
      { id: 'cmp', type: 'logic.compare', config: { op: 'greater', value: '59' }, inputs: { a: '{{cmd.n}}' } },
      { id: 'pass', type: 'action.reply', config: { text: 'passed with {{cmd.n}}' } },
      { id: 'fail', type: 'action.reply', config: { text: 'try again' } },
      { id: 'count', type: 'data.increment', config: { name: 'tries', scope: 'user' } },
    ],
    edges: [exec('cmd', 'count'), exec('count', 'cmp'), exec('cmp', 'pass', 'true'), exec('cmp', 'fail', 'false')],
  })
}

describe('flow test cases', () => {
  it('runs saved cases with assertions and reports failures and uncovered nodes', async () => {
    const flow = await scoreFlow()
    const pass = await app.call('flows.tests.create', {
      id: flow.id,
      case: {
        name: 'pass',
        input: { text: '/score 80' },
        vars: [{ scope: 'user', name: 'tries', value: 2 }],
        expect: [
          { kind: 'reply', value: 'passed with 80' },
          { kind: 'branch', node: 'cmp', exec: 'true' },
          { kind: 'variable', scope: 'user', name: 'tries', value: '3' },
          { kind: 'visits', node: 'fail', not: true },
        ],
      },
    })
    expect(pass.id).toBeTruthy()
    await app.call('flows.tests.create', {
      id: flow.id,
      case: { name: 'wrong', input: { text: '/score 10' }, expect: [{ kind: 'reply', match: 'contains', value: 'passed' }, { kind: 'matched', value: true }] },
    })
    const run = await app.call('flows.tests.run', { id: flow.id })
    expect(run).toMatchObject({ passed: 1, failed: 1, uncovered: [] })
    expect(run.results[1].failures).toEqual([{ index: 0, message: 'No reply contains "passed"; got "try again"' }])
    expect(run.results[0].trace.replies).toEqual(['passed with 80'])

    // Cases do not touch the flow's real variables or its recent runs.
    expect(await app.call('flows.runs', { id: flow.id })).toEqual([])
    const saved = await app.call('flows.tests.list', { id: flow.id })
    expect(saved.lastRun).toMatchObject({ passed: 1, failed: 1, source: 'editor' })
    expect(saved.lastRun.results[0]).not.toHaveProperty('trace')

    // Only the failing case, after fixing it; the other result is kept.
    const failing = saved.cases[1].id
    await app.call('flows.tests.update', { id: flow.id, case: failing, patch: { expect: [{ kind: 'reply', value: 'try again' }] } })
    const again = await app.call('flows.tests.run', { id: flow.id, cases: [failing] })
    expect(again).toMatchObject({ passed: 2, failed: 0 })
    expect(again.results).toHaveLength(1)
    expect((await app.call('database.rows', { table: 'flows_testrun', filter: { flow: flow.id } })).total).toBe(2)
  })

  it('runs the cases after each save when asked to', async () => {
    const flow = await scoreFlow()
    await app.call('flows.tests.create', { id: flow.id, case: { name: 'pass', input: { text: '/score 60' }, expect: [{ kind: 'reply', value: 'passed with 60' }] } })
    await app.call('flows.tests.autoRun', { id: flow.id, autoRun: true })
    const current = await app.call('flows.get', { id: flow.id })
    const nodes = current.nodes.map((node: any) => (node.id === 'pass' ? { ...node, config: { text: 'well done' } } : node))
    await app.call('flows.update', { id: flow.id, nodes })
    let last: any
    for (let i = 0; i < 40 && !last?.failed; i++) {
      last = (await app.call('flows.tests.list', { id: flow.id })).lastRun
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(last).toMatchObject({ source: 'save', failed: 1 })
  })

  it('proposes one case per path, with the boundary values of comparisons', async () => {
    const flow = await scoreFlow()
    const { drafts, uncovered } = await app.call('flows.tests.generate', { id: flow.id })
    expect(uncovered).toEqual([])
    const texts = drafts.map((draft: any) => draft.input.text)
    expect(texts).toContain('/score 1')
    expect(texts).toContain('/score 60')
    const high = drafts.find((draft: any) => draft.input.text === '/score 60')
    expect(high.name).toBe('/score 60 → cmp: true')
    expect(high.expect).toEqual([{ kind: 'reply', match: 'equals', value: 'passed with 60', index: 0 }, { kind: 'branch', node: 'cmp', exec: 'true' }])
    // Paths that differ only in the reply text are separate cases; without arguments the usage hint answers.
    expect(drafts.find((draft: any) => draft.input.text === '/score').expect).toEqual([{ kind: 'reply', match: 'equals', value: expect.stringContaining('/score'), index: 0 }])

    for (const draft of drafts) await app.call('flows.tests.create', { id: flow.id, case: draft })
    expect(await app.call('flows.tests.run', { id: flow.id })).toMatchObject({ failed: 0, passed: drafts.length })
    // Saved inputs are not proposed again.
    expect((await app.call('flows.tests.generate', { id: flow.id })).drafts).toEqual([])
  })

  it('covers classify labels with mock answers and both outcomes of a wait', async () => {
    const flow = await app.call('flows.create', {
      name: 'Support',
      nodes: [
        { id: 'kw', type: 'trigger.keyword', config: { keywords: ['help'] } },
        { id: 'cls', type: 'ai.classify', config: { labels: ['refund', 'bug'] } },
        { id: 'ask', type: 'action.reply', config: { text: 'order number?' } },
        { id: 'wait', type: 'logic.waitReply', config: { seconds: 5 } },
        { id: 'thanks', type: 'action.reply', config: { text: 'got {{wait.text}}' } },
        { id: 'late', type: 'action.reply', config: { text: 'bye' } },
        { id: 'chat', type: 'ai.chat', config: {} },
        { id: 'say', type: 'action.reply', config: { text: '{{chat.reply}}' } },
      ],
      edges: [
        exec('kw', 'cls'), exec('cls', 'ask', 'refund'), exec('ask', 'wait'), exec('wait', 'thanks', 'reply'), exec('wait', 'late', 'timeout'),
        exec('cls', 'chat', 'bug'), exec('cls', 'chat', 'other'), exec('chat', 'say'),
      ],
    })
    const { drafts, uncovered } = await app.call('flows.tests.generate', { id: flow.id })
    expect(uncovered).toEqual([])
    const replies = drafts.map((draft: any) => draft.expect.filter((item: any) => item.kind === 'reply').map((item: any) => item.value).join(' / ')).sort()
    // bug and other are separate paths through the classify node.
    expect(replies).toEqual(['order number? / bye', 'order number? / got 好的', '（模拟的大模型回复）', '（模拟的大模型回复）'].sort())
    expect(drafts.map((draft: any) => draft.llm.replies[0]).sort()).toEqual(['bug', 'other', 'refund', 'refund'])
  })

  it('judges replies with the real model and fails without one', async () => {
    const flow = await scoreFlow()
    await app.call('flows.tests.create', { id: flow.id, case: { name: 'judge', input: { text: '/score 5' }, expect: [{ kind: 'judge', criterion: 'encourages the user' }] } })
    const run = await app.call('flows.tests.run', { id: flow.id })
    expect(run.results[0].failures[0].message).toMatch(/provider|LLM/i)
  })

  it('runs every flow\'s cases offline from the command line', async () => {
    const baseDir = app.baseDir
    await app.call('plugins.enable', { package: '@mushin/plugin-demo' })
    await app.call('plugins.configure', { id: 'demo', config: { bot: true } })
    const configBefore = await readFile(join(baseDir, 'mushin.config.json'), 'utf8')
    await app.stop({ keep: true })

    const lines: string[] = []
    const code = await testCommand({ baseDir, print: (line) => lines.push(line) })
    expect(code).toBe(1)
    expect(lines.some((line) => line.startsWith('✗ Score') && line.includes('passed'))).toBe(true)
    expect(lines.some((line) => line.includes('No reply equals "passed with 60"; got "well done"'))).toBe(true)
    expect(lines.at(-1)).toMatch(/^\n\d+ passed, \d+ failed in \d+ flow\(s\)$/)
    expect(await readFile(join(baseDir, 'mushin.config.json'), 'utf8')).toBe(configBefore)

    const support = await testCommand({ baseDir, flow: 'Support', print: (line) => lines.push(line) })
    expect(support).toBe(0)
    const json: string[] = []
    expect(await testCommand({ baseDir, flow: 'nope', json: true, print: (line) => json.push(line) })).toBe(1)
    expect(json).toEqual(['No flow with id or name "nope".'])

    app = await startInstance({ baseDir })
    // The offline run left the demo bot alone, and recorded where the runs came from.
    const flows = await app.call<any[]>('flows.list')
    const score = flows.find((flow) => flow.name === 'Score')
    expect((await app.call('flows.tests.list', { id: score.id })).lastRun.source).toBe('cli')
  })
})
