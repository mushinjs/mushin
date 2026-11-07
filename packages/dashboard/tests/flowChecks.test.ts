import { describe, expect, it, vi } from 'vitest'

// The flow helpers load the dashboard's API client, which reads the page address on import.
vi.hoisted(() => {
  ;(globalThis as any).location ??= { pathname: '/', search: '', host: 'localhost', protocol: 'http:' }
})

import { checkNode, type CheckNode, parseTemplateJson, upstreamOf } from '../src/components/flow/editor/checks'
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
      'error params apiParamMissing send_poke,user_id',
      'error params apiParamType send_poke,group_id,id',
      'warning params apiParamUnknown send_poke,usr_id',
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
