import { describe, expect, it, vi } from 'vitest'

// The flow helpers load the dashboard's API client, which reads the page address on import.
vi.hoisted(() => {
  ;(globalThis as any).location ??= { pathname: '/', search: '', host: 'localhost', protocol: 'http:' }
})

import { type ApiInfo, checkNode, type CheckNode, parseTemplateJson, readParams, upstreamOf, writeParams } from '../src/components/flow/editor/checks'
import type { NodeTypeInfo } from '../src/types'

const exec = (source: string, target: string) => ({ source, sourceHandle: 'exec:next', target, targetHandle: 'exec' })

const type = (id: string, extra: Partial<NodeTypeInfo> = {}): NodeTypeInfo => ({
  type: id, kind: 'action', category: 'action', title: id, plugin: 'test', inputs: [], outputs: [], execIn: true, execOut: ['next'], ...extra,
})

const apis = [{ action: 'send_poke', title: 'Poke', params: [{ name: 'user_id', type: 'id', required: true, title: 'QQ' }, { name: 'group_id', type: 'id', title: 'Group' }] }]

const types = new Map<string, NodeTypeInfo>([
  ['trigger', type('trigger', { kind: 'trigger', outputs: [{ name: 'text', type: 'text' }] })],
  ['read', type('read', { outputs: [{ name: 'data', type: 'any' }, { name: 'group_id', type: 'text' }] })],
  ['call', type('call', {
    configSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', minLength: 1, 'x-apis': apis },
        params: { type: 'string', 'x-widget': 'json' },
      },
    },
  })],
])

function check(config: Record<string, any>, edges = [exec('t', 'r'), exec('r', 'c')], others: CheckNode[] = []) {
  const nodes = new Map<string, CheckNode>([
    ['t', { id: 't', typeId: 'trigger', config: {} }],
    ['r', { id: 'r', typeId: 'read', config: {} }],
    ['c', { id: 'c', typeId: 'call', config }],
    ...others.map((node) => [node.id, node] as const),
  ])
  return checkNode(nodes.get('c')!, types.get('call')!, { nodes, types, upstream: upstreamOf('c', edges) })
    .map((item) => `${item.severity} ${item.field} ${item.code} ${Object.values(item.params).join(',')}`)
}

describe('upstreamOf', () => {
  it('collects every node a path leads from, and survives loops', () => {
    expect([...upstreamOf('c', [exec('a', 'b'), exec('b', 'c'), exec('c', 'a'), exec('x', 'y')])].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('parseTemplateJson', () => {
  it('parses JSON with references in and out of quotes', () => {
    expect(parseTemplateJson('{"a": {{n1.x}}, "b": "{{n2.y}}", "c": "{{"}').error).toBeUndefined()
    expect(parseTemplateJson('{"a": }').error).toBe('json')
  })
})

describe('checkNode', () => {
  it('accepts a good call with references to earlier nodes, nested ones too', () => {
    expect(check({ action: 'send_poke', params: '{"user_id": {{r.data.user_id}}, "group_id": "{{r.group_id}}"}' })).toEqual([])
  })

  it('reports empty required settings and broken JSON', () => {
    expect(check({ action: '', params: '{}' })).toEqual(['error action required action'])
    expect(check({ action: 'send_poke', params: '{"user_id": ' })).toEqual(['error params json params'])
    expect(check({ action: 'send_poke', params: '[1]' })).toEqual(['error params jsonObject params'])
  })

  it('checks API params: required, types and unknown names', () => {
    expect(check({ action: 'send_poke', params: '{"group_id": "abc", "usr_id": 1}' })).toEqual([
      'error params.user_id apiParamMissing send_poke,user_id',
      'error params.group_id apiParamType send_poke,group_id,id',
      'warning params.usr_id apiParamUnknown send_poke,usr_id',
    ])
    expect(check({ action: 'set_something', params: '{}' })).toEqual(['warning action apiUnknown set_something'])
  })

  it('flags references to missing nodes and outputs, to itself, and to nodes that do not run first', () => {
    const later = { id: 'z', typeId: 'read', config: {} }
    expect(check({ action: 'send_poke', params: '{"user_id": "{{gone.x}}{{r.nope}}{{c.data}}{{z.data}}{{sys.nothing}}{{chat.any}}"}' }, undefined, [later])).toEqual([
      'error params refNoNode gone,x,gone.x',
      'error params refNoOutput r,nope,r.nope',
      'error params refSelf c,data,c.data',
      'warning params refNotBefore z,data,z.data',
      'error params refNoOutput sys,nothing,sys.nothing',
    ])
  })
})

describe('API params as fields', () => {
  const api: ApiInfo = {
    action: 'x',
    title: 'X',
    params: [
      { name: 'group_id', type: 'id', title: 'Group' },
      { name: 'enable', type: 'boolean', title: 'On' },
      { name: 'message', type: 'message', title: 'Text' },
      { name: 'messages', type: 'array', title: 'Nodes' },
    ],
  }

  it('reads each param as text, references in or out of quotes', () => {
    expect(readParams('{"group_id": {{sys.groupId}}, "enable": true, "message": "say \\"{{n1.text}}\\"", "messages": [{"a": {{n2.data}}}]}')).toEqual({
      group_id: '{{sys.groupId}}', enable: 'true', message: 'say "{{n1.text}}"', messages: '[{"a":{{n2.data}}}]',
    })
    expect(readParams('')).toEqual({})
    expect(readParams('[1]')).toBeUndefined()
    expect(readParams('{"a": ')).toBeUndefined()
  })

  it('writes fields back as JSON in the table order, numbers and yes/no bare', () => {
    expect(writeParams({ message: 'say "hi"', group_id: '500', enable: 'false', extra: '{{n1.x}}' }, api)).toBe('{"group_id": 500, "enable": false, "message": "say \\"hi\\"", "extra": "{{n1.x}}"}')
    expect(writeParams({ group_id: '{{sys.groupId}}', messages: '{{n2.data}}', message: '' }, api)).toBe('{"group_id": "{{sys.groupId}}", "messages": {{n2.data}}}')
  })

  it('round-trips what it writes', () => {
    const values = { group_id: '{{sys.groupId}}', enable: 'true', message: 'a "b" {{n1.text}}', messages: '[{"type": "node"}]' }
    expect(readParams(writeParams(values, api))).toEqual({ ...values, messages: '[{"type":"node"}]' })
  })
})
