import { describe, expect, it } from 'vitest'
import { changedFields, configPreview, inferSchema, jsonProblem, positionOf } from '../src/plugins/config'

describe('inferSchema', () => {
  it('gives each value a fitting field', () => {
    expect(inferSchema({
      name: 'x',
      port: 80,
      ratio: 0.5,
      on: true,
      words: ['a', 'b'],
      empty: [],
      nested: { host: 'h', retries: 2 },
      mixed: [1, 'a'],
      nothing: null,
      blank: {},
    })).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        port: { type: 'integer' },
        ratio: { type: 'number' },
        on: { type: 'boolean' },
        words: { type: 'array', items: { type: 'string' } },
        empty: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: { host: { type: 'string' }, retries: { type: 'integer' } } },
        mixed: {},
        nothing: {},
        blank: {},
      },
    })
  })

  it('has no fields for an empty config', () => {
    expect(inferSchema(undefined)).toEqual({ type: 'object', properties: {} })
  })
})

describe('jsonProblem', () => {
  it('accepts objects and an empty text', () => {
    expect(jsonProblem('{ "a": 1 }')).toBeUndefined()
    expect(jsonProblem('  ')).toBeUndefined()
  })

  it('says where the text goes wrong', () => {
    const problem = jsonProblem('{\n  "a": 1,\n  "b": }')
    expect(problem).toMatchObject({ line: 3, column: 8 })
    expect(jsonProblem('{"a": 1,}')).toMatchObject({ line: 1, column: 9 })
    expect(jsonProblem('{"a": tru}')).toMatchObject({ line: 1, column: 10 })
    expect(jsonProblem('{"a": "x}')).toMatchObject({ line: 1, column: 10 })
    expect(jsonProblem('{} x')).toMatchObject({ line: 1, column: 4 })
  })

  it('refuses what is not an object', () => {
    expect(jsonProblem('[1]')?.message).toBe('not an object')
  })

  it('counts lines and columns from 1', () => {
    expect(positionOf('ab\ncd', 4)).toEqual({ line: 2, column: 2 })
  })
})

describe('changedFields', () => {
  it('lists the fields set to something other than their default', () => {
    const schema = { properties: { host: { default: '127.0.0.1' }, port: { default: 5160 }, tags: { default: [] }, free: {} } }
    expect(changedFields(schema, { host: '0.0.0.0', port: 5160, tags: ['a'], free: 'x' })).toEqual(['host', 'tags'])
    expect(changedFields(schema, {})).toEqual([])
  })
})

describe('configPreview', () => {
  it('masks secrets, keeps references, and cuts long values', () => {
    const { lines, more } = configPreview(
      { apiKey: 'sk-123', token: '${BOT_TOKEN}', url: 'x'.repeat(80), on: true, a: 1, b: 2 },
      { properties: { apiKey: { 'x-secret': true } } },
      5,
      20,
    )
    expect(lines).toEqual([
      { key: 'apiKey', value: '••••••' },
      { key: 'token', value: '${BOT_TOKEN}' },
      { key: 'url', value: `${'x'.repeat(19)}…` },
      { key: 'on', value: 'true' },
      { key: 'a', value: '1' },
    ])
    expect(more).toBe(1)
  })
})
