import { describe, expect, it } from 'vitest'
import { seg, z } from '@mushin/core'
import { builtinNodes, compile, type FlowDocument, type FlowSession, type NodeType, ResourceLocks, runFlow, StopError } from '../src'

const logger = { info() {}, warn() {}, debug() {}, error() {} } as any
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A node that works for `ms`, optionally long and using a resource. */
const work: NodeType<{ ms: number; resource: string }> = {
  kind: 'action',
  type: 'test.work',
  category: 'action',
  title: 'Work',
  config: z.object({ ms: z.number().default(10), resource: z.string().default('') }),
  inputs: [],
  outputs: [],
  resource: (config) => config.resource || undefined,
  run: async ({ config, signal }) => {
    await sleep(config.ms)
    if (signal.aborted) throw new Error('aborted')
  },
}
const longWork: NodeType = { ...work, type: 'test.long', long: true }
const types = new Map<string, NodeType>([...builtinNodes, work, longWork].map((type) => [type.type, type]))

function flow(type: string, config: Record<string, unknown>): FlowDocument {
  return {
    id: 'f',
    name: 'Flow',
    bots: [],
    nodes: [
      { id: 'cmd', type: 'trigger.keyword', position: { x: 0, y: 0 }, config: { keywords: ['go'] } },
      { id: 'work', type, position: { x: 0, y: 0 }, config },
    ],
    edges: [{ id: 'e', source: 'cmd', sourceHandle: 'exec:next', target: 'work', targetHandle: 'exec' }],
    createdAt: 0,
    updatedAt: 0,
  }
}

const session = (): FlowSession => ({
  text: 'go', segments: [seg.text('go')], user: { id: '1' }, channel: { type: 'group', id: '2' }, isDirect: false, mentioned: false,
  send: async () => undefined, reply: async () => undefined,
})
const vars = { get: () => undefined, set() {} }

describe('long nodes', () => {
  it('do not use up the run\'s working time', async () => {
    const quick = await runFlow(compile(flow('test.work', { ms: 80 }), types), { session: session(), vars, logger, limit: 30 })
    expect(quick.trace.error).toBe('The run took too long and was stopped')
    const long = await runFlow(compile(flow('test.long', { ms: 80 }), types), { session: session(), vars, logger, limit: 30 })
    expect(long.trace.error).toBeUndefined()
  })
})

describe('resources', () => {
  it('lets one run at a time hold a resource, the others queue in order', async () => {
    const locks = new ResourceLocks()
    const compiled = compile(flow('test.work', { ms: 40, resource: 'game' }), types)
    const order: string[] = []
    const queued: boolean[] = []
    const start = (name: string, extra = {}) => runFlow(compiled, { session: session(), vars, logger, locks, ...extra })
      .then((result) => (order.push(name), result))
    const first = start('first')
    await sleep(5)
    expect(locks.holder('game')).toBeDefined()
    const second = start('second', { onQueue: (waiting: boolean) => queued.push(waiting) })
    await sleep(5)
    expect(locks.waiting('game')).toHaveLength(1)
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
    expect(queued).toEqual([true, false])
    expect(locks.holder('game')).toBeUndefined()
  })

  it('stops waiting when the run is stopped, and refuses a full queue', async () => {
    const locks = new ResourceLocks()
    await locks.acquire('game', 'a')
    const controller = new AbortController()
    const waiting = locks.acquire('game', 'b', { signal: controller.signal })
    controller.abort(new StopError('dashboard'))
    await expect(waiting).rejects.toThrow('Stopped by dashboard')
    expect(locks.waiting('game')).toEqual([])
    for (let index = 0; index < 20; index++) void locks.acquire('game', `w${index}`).catch(() => {})
    await expect(locks.acquire('game', 'late')).rejects.toThrow(/20 runs already wait/)
    await expect(locks.acquire('game', 'x', { wait: 10 })).rejects.toThrow(/20 runs already wait/)
    locks.releaseAll('a')
    expect(locks.holder('game')).toBe('w0')
  })

  it('gives up after waiting too long', async () => {
    const locks = new ResourceLocks()
    await locks.acquire('game', 'a')
    await expect(locks.acquire('game', 'b', { wait: 20 })).rejects.toThrow(/gave up/)
    expect(locks.waiting('game')).toEqual([])
  })
})
