import { describe, expect, it } from 'vitest'
import { blockedSteps, bypasses, inheritedSkips, reach, successors } from '../src/components/flow/editor/graph'

const exec = (source: string, target: string, exit = 'next') => ({ source, sourceHandle: `exec:${exit}`, target, targetHandle: 'exec' })

describe('reach', () => {
  it('follows run-next exits only, and survives loops', () => {
    const next = successors([exec('a', 'b'), exec('b', 'c'), exec('c', 'a'), { source: 'a', sourceHandle: 'out:text', target: 'd' }])
    expect([...reach(next, ['a'])].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('inheritedSkips', () => {
  it('marks steps that only a skipped trigger leads to', () => {
    const triggers = [{ id: 't1', skip: true }, { id: 't2', skip: false }]
    const edges = [exec('t1', 'a'), exec('a', 'b'), exec('t2', 'b')]
    expect(inheritedSkips(triggers, edges)).toEqual(new Map([['a', 't1']]))
  })
})

describe('blockedSteps', () => {
  it('marks steps behind a blocked trigger, leaving shared and skipped ones', () => {
    const triggers = [{ id: 't1', skip: false }, { id: 't2', skip: false }]
    const edges = [exec('t1', 'a'), exec('a', 'b'), exec('t1', 'c'), exec('t2', 'b')]
    expect(blockedSteps(triggers, edges, new Set(['t1']), new Set(['c']))).toEqual(new Map([['a', 't1']]))
  })
})

describe('bypasses', () => {
  const firstExit = () => 'exec:next'

  it('draws one path round a chain of skipped steps', () => {
    const edges = [exec('a', 's1'), exec('s1', 's2'), exec('s2', 'b')]
    const skipped = (id: string) => id.startsWith('s')
    expect(bypasses({ nodes: ['a', 's1', 's2', 'b'], edges, skipped, firstExit, hidden: () => false }))
      .toEqual([{ source: 'a', sourceHandle: 'exec:next', target: 'b' }])
  })

  it('draws nothing when the path already exists or a node is hidden in a group', () => {
    const edges = [exec('a', 's'), exec('s', 'b'), exec('a', 'b')]
    const skipped = (id: string) => id === 's'
    expect(bypasses({ nodes: ['a', 's', 'b'], edges, skipped, firstExit, hidden: () => false })).toEqual([])
    expect(bypasses({ nodes: ['a', 's', 'b'], edges: edges.slice(0, 2), skipped, firstExit, hidden: (id) => id === 'b' })).toEqual([])
  })

  it('only follows a skipped step\'s first exit', () => {
    const edges = [exec('a', 's'), exec('s', 'b', 'next'), exec('s', 'c', 'other')]
    const skipped = (id: string) => id === 's'
    expect(bypasses({ nodes: ['a', 's', 'b', 'c'], edges, skipped, firstExit, hidden: () => false }))
      .toEqual([{ source: 'a', sourceHandle: 'exec:next', target: 'b' }])
  })
})
