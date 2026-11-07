import { describe, expect, it, vi } from 'vitest'

// The flow helpers load the dashboard's API client, which reads the page address on import.
vi.hoisted(() => {
  ;(globalThis as any).location ??= { pathname: '/', search: '', host: 'localhost', protocol: 'http:' }
})

import { type ApiInfo, checkNode, type CheckNode, paramFit, parseTemplateJson, readParams, upstreamOf, writeParams } from '../src/components/flow/editor/checks'
import type { NodeTypeInfo } from '../src/types'

const exec = (source: string, target: string) => ({ source, sourceHandle: 'exec:next', target, targetHandle: 'exec' })

const type = (id: string, extra: Partial<NodeTypeInfo> = {}): NodeTypeInfo => ({
  type: id, kind: 'action', category: 'action', title: id, plugin: 'test', inputs: [], outputs: [], execIn: true, execOut: ['next'], ...extra,
})

const apis = [
  { action: 'send_poke', title: 'Poke', params: [{ name: 'user_id', type: 'int', required: true, title: 'QQ' }, { name: 'group_id', type: 'int', title: 'Group' }] },
  { action: 'send_like', title: 'Like', params: [{ name: 'user_id', type: 'int', required: true, title: 'QQ' }, { name: 'times', type: 'int', title: 'Times', min: 1, max: 10 }] },
  { action: 'honor', title: 'Honor', params: [{ name: 'type', type: 'string', required: true, title: 'Type', options: ['talkative', 'all'] }] },
]

const types = new Map<string, NodeTypeInfo>([
  ['trigger', type('trigger', { kind: 'trigger', outputs: [{ name: 'text', type: 'text' }] })],
  ['read', type('read', { outputs: [{ name: 'data', type: 'any' }, { name: 'group_id', type: 'text' }, { name: 'private', type: 'boolean' }] })],
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

function check(config: Record<string, any>, edges = [exec('t', 'r'), exec('r', 'c')], others: CheckNode[] = [], sampleOf?: (head: string, name: string) => unknown) {
  const nodes = new Map<string, CheckNode>([
    ['t', { id: 't', typeId: 'trigger', config: {} }],
    ['r', { id: 'r', typeId: 'read', config: {} }],
    ['c', { id: 'c', typeId: 'call', config }],
    ...others.map((node) => [node.id, node] as const),
  ])
  return checkNode(nodes.get('c')!, types.get('call')!, { nodes, types, upstream: upstreamOf('c', edges), sampleOf })
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
      'error params.group_id apiParamType send_poke,group_id,int',
      'warning params.usr_id apiParamUnknown send_poke,usr_id',
    ])
    expect(check({ action: 'set_something', params: '{}' })).toEqual(['warning action apiUnknown set_something'])
  })

  it('takes one value in number params: one literal or one reference, never both', () => {
    expect(check({ action: 'send_poke', params: '{"user_id": "{{r.group_id}}{{r.data.id}}"}' })).toEqual(['error params.user_id apiParamSingle send_poke,user_id,int'])
    expect(check({ action: 'send_poke', params: '{"user_id": "QQ {{r.group_id}}"}' })).toEqual(['error params.user_id apiParamSingle send_poke,user_id,int'])
    expect(check({ action: 'send_poke', params: '{"user_id": "10086"}' })).toEqual([])
    expect(check({ action: 'send_poke', params: '{"user_id": 1.5}' })).toEqual(['error params.user_id apiParamType send_poke,user_id,int'])
  })

  it('checks ranges and listed values of literals', () => {
    expect(check({ action: 'send_like', params: '{"user_id": 1, "times": 11}' })).toEqual(['error params.times apiParamRange send_like,times,1,10'])
    expect(check({ action: 'honor', params: '{"type": "weekly"}' })).toEqual(['error params.type apiParamOption honor,type,talkative, all'])
    expect(check({ action: 'honor', params: '{"type": "all"}' })).toEqual([])
  })

  it('checks the type of a referenced output against the param', () => {
    // A yes/no output can never be a QQ number.
    expect(check({ action: 'send_poke', params: '{"user_id": "{{r.private}}"}' })).toEqual(['error params.user_id apiRefType send_poke,user_id,int,r,private,boolean,'])
    // Text may hold a number; its latest value tells.
    expect(check({ action: 'send_poke', params: '{"user_id": "{{r.group_id}}"}' })).toEqual([])
    expect(check({ action: 'send_poke', params: '{"user_id": "{{r.group_id}}"}' }, undefined, [], () => '10086')).toEqual([])
    expect(check({ action: 'send_poke', params: '{"user_id": "{{r.group_id}}"}' }, undefined, [], () => 'Ann')).toEqual(['warning params.user_id apiRefMaybe send_poke,user_id,int,r,group_id,text,"Ann"'])
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

describe('paramFit', () => {
  it('marks outputs that cannot fill a param, and lets latest values settle text', () => {
    const int = { type: 'int' as const }
    expect([paramFit(int, 'number'), paramFit(int, 'boolean'), paramFit(int, 'text'), paramFit(int, 'text', '42'), paramFit(int, 'text', 'x')]).toEqual(['ok', 'bad', 'maybe', 'ok', 'bad'])
    expect(paramFit({ type: 'string', options: ['a'] }, 'text', 'a')).toBe('ok')
    expect(paramFit({ type: 'boolean' }, 'boolean')).toBe('ok')
  })
})

describe('API params as fields', () => {
  const api: ApiInfo = {
    action: 'x',
    title: 'X',
    params: [
      { name: 'group_id', type: 'int', title: 'Group' },
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
