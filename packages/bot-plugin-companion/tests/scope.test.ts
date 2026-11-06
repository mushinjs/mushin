import { describe, expect, it } from 'vitest'
import { Config, inScope } from '../src'

const config = (patch: Partial<Config> = {}) => ({ ...Config.parse({}), ...patch })

describe('inScope', () => {
  it('takes every group and no private chat by default', () => {
    expect(inScope(config(), { type: 'group', id: '1' })).toBe(true)
    expect(inScope(config(), { type: 'private', id: '1' })).toBe(false)
  })

  it('keeps to the listed groups and leaves excluded ones out', () => {
    expect(inScope(config({ groups: ['1'] }), { type: 'group', id: '2' })).toBe(false)
    expect(inScope(config({ groups: ['1', '2'], excludeGroups: ['2'] }), { type: 'group', id: '2' })).toBe(false)
    expect(inScope(config({ privateChat: true }), { type: 'private', id: '9' })).toBe(true)
  })
})
