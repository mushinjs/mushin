import { describe, expect, it } from 'vitest'
import { check, judgeWith, mockLlm, scratchVars } from '../src/tests'
import type { RunTrace } from '../src/types'

const trace = (patch: Partial<RunTrace> = {}): RunTrace => ({
  id: 'r', flowId: 'f', test: true, at: 0, text: '', edges: [], replies: [], steps: [], ...patch,
})

describe('test case assertions', () => {
  const vars = scratchVars([{ scope: 'user', name: 'points', value: { total: 3 } }])
  const run = trace({
    replies: ['hello Alice', 'bye'],
    steps: [{ nodeId: 't', ms: 1, exec: 'next' }, { nodeId: 'cmp', ms: 1, exec: 'false' }, { nodeId: 'x', ms: 1, error: 'boom' }],
    calls: [{ action: 'set_group_ban', params: {} }],
  })
  const ctx = { trace: run, matched: true, vars }

  it('checks replies by equality, containment, pattern and position', async () => {
    expect(await check({ kind: 'reply', match: 'equals', value: 'bye' }, ctx)).toBeUndefined()
    expect(await check({ kind: 'reply', match: 'contains', value: 'Alice', index: 0 }, ctx)).toBeUndefined()
    expect(await check({ kind: 'reply', match: 'regex', value: '^hello \\w+$' }, ctx)).toBeUndefined()
    expect(await check({ kind: 'reply', match: 'equals', value: 'bye', index: 0 }, ctx)).toBe('Reply 1 equals "bye"; got "hello Alice", "bye"')
    expect(await check({ kind: 'reply', match: 'regex', value: '(' }, ctx)).toMatch(/^No reply matches/)
    expect(await check({ kind: 'noReply' }, ctx)).toMatch(/^Expected no reply/)
  })

  it('checks the path, variables, calls and errors', async () => {
    expect(await check({ kind: 'branch', node: 'cmp', exec: 'true' }, ctx)).toBe('Node cmp went to "false", not "true"')
    expect(await check({ kind: 'visits', node: 'y' }, ctx)).toBe('Did not reach node y')
    expect(await check({ kind: 'visits', node: 'cmp', not: true }, ctx)).toBe('Ran node cmp')
    expect(await check({ kind: 'variable', scope: 'user', name: 'points', value: '{"total":3}' }, ctx)).toBeUndefined()
    expect(await check({ kind: 'variable', scope: 'chat', name: 'points', value: '1' }, ctx)).toBe('Variable chat.points is "", not "1"')
    expect(await check({ kind: 'call', action: 'set_group_ban' }, ctx)).toBeUndefined()
    expect(await check({ kind: 'call', action: 'set_group_ban', not: true }, ctx)).toBe('Called set_group_ban')
    expect(await check({ kind: 'noError' }, ctx)).toBe('Node x failed: boom')
    expect(await check({ kind: 'matched', value: false }, ctx)).toBe('A trigger started')
    expect(await check({ kind: 'judge', criterion: 'polite' }, ctx)).toBe('Judging replies needs an LLM provider')
  })

  it('answers LLM nodes from the mock list, repeating the last, and reads a judge verdict', async () => {
    const llm = mockLlm(['a', 'b'])
    expect([(await llm.chat({})).text, (await llm.chat({})).text, (await llm.chat({})).text]).toEqual(['a', 'b', 'b'])
    expect(await judgeWith(mockLlm(['FAIL\nIt is rude.']), 'polite', ['go away'])).toEqual({ ok: false, reason: 'It is rude.' })
    expect((await judgeWith(mockLlm(['PASS']), 'polite', ['hi'])).ok).toBe(true)
  })
})
