import { describe, expect, it } from 'vitest'
import { groupOf, groupPlugins, type ListedPlugin, relationsOf, toggleImpact } from '../src/plugins/groups'

const plugin = (pkg: string, extra: Partial<ListedPlugin> = {}): ListedPlugin => ({
  package: pkg,
  kind: 'app',
  name: pkg,
  enabled: true,
  requires: [],
  ...extra,
})

describe('groupOf', () => {
  it('puts bot plugins together whatever their category', () => {
    expect(groupOf(plugin('echo', { kind: 'bot', category: 'example' }))).toBe('bot')
  })

  it('follows the category, and sorts the rest by what they add', () => {
    expect(groupOf(plugin('a', { category: 'provider' }))).toBe('provider')
    expect(groupOf(plugin('b', { addsAdapters: true }))).toBe('adapter')
    expect(groupOf(plugin('c'))).toBe('other')
    expect(groupOf(plugin('d', { category: 'manage' }))).toBe('other')
  })
})

describe('groupPlugins', () => {
  const list = [
    plugin('openai', { category: 'provider', name: 'OpenAI' }),
    plugin('providers', { category: 'provider', name: 'Providers', essential: true }),
    plugin('gemini', { category: 'provider', name: 'Gemini', enabled: false }),
    plugin('anthropic', { category: 'provider', name: 'Anthropic', problem: true }),
    plugin('storage', { category: 'core', name: 'Storage', essential: true }),
    plugin('demo', { category: 'example', name: 'Demo', enabled: false }),
  ]

  it('orders groups and their members: essential, problems, enabled, disabled, then by name', () => {
    const groups = groupPlugins(list)
    expect(groups.map((group) => group.key)).toEqual(['bot', 'adapter', 'provider', 'ai', 'feature', 'core', 'example'])
    const providers = groups.find((group) => group.key === 'provider')!
    expect(providers.all.map((item) => item.package)).toEqual(['providers', 'anthropic', 'openai', 'gemini'])
    expect(providers.enabled).toBe(3)
    expect(providers.problems).toBe(1)
  })

  it('shows integration packs only when there are some', () => {
    expect(groupPlugins(list).some((group) => group.key === 'bundle')).toBe(false)
    expect(groupPlugins([...list, plugin('pack', { category: 'bundle' })]).some((group) => group.key === 'bundle')).toBe(true)
  })

  it('folds core and examples by default, keeps what the person chose, and opens a group with a problem', () => {
    const open = (collapsed = {}, items = list) => Object.fromEntries(groupPlugins(items, { collapsed }).map((group) => [group.key, group.open]))
    expect(open()).toMatchObject({ provider: true, core: false, example: false })
    expect(open({ core: false, provider: true })).toMatchObject({ provider: true, core: true })
    expect(open({}, [...list, plugin('database', { category: 'core', problem: true })])).toMatchObject({ core: true })
  })

  it('while narrowed, opens groups with matches and hides the others', () => {
    const groups = groupPlugins(list, { narrowed: true, matches: (item) => ['providers', 'openai', 'storage', 'demo'].includes(item.package), collapsed: { core: true } })
    expect(groups.map((group) => [group.key, group.shown.map((item) => item.package), group.open])).toEqual([
      ['provider', ['providers', 'openai'], true],
      ['core', ['storage'], true],
      ['example', ['demo'], true],
    ])
  })
})

describe('dependencies', () => {
  const list = [
    plugin('storage', { essential: true }),
    plugin('bots', { requires: ['storage'], enabled: false }),
    plugin('flows', { requires: ['storage'], enabled: false }),
    plugin('knowledge', { requires: ['bots', 'flows', 'missing'], enabled: false }),
    plugin('fairy', { requires: ['storage'] }),
    plugin('echo', { kind: 'bot', requires: ['bots'], enabled: true }),
  ]

  it('knows both directions', () => {
    const relations = relationsOf(list)
    expect([...relations.get('storage')!.dependents]).toEqual(['bots', 'flows', 'fairy'])
    expect([...relations.get('knowledge')!.requires]).toEqual(['bots', 'flows', 'missing'])
  })

  it('turning on takes along the disabled plugins it needs, and theirs', () => {
    expect(toggleImpact('knowledge', list, true)).toEqual(['bots', 'flows'])
    expect(toggleImpact('fairy', list, true)).toEqual([])
  })

  it('turning off stops the enabled plugins that need it, and theirs', () => {
    const on = list.map((item) => ({ ...item, enabled: true }))
    expect(toggleImpact('bots', on, false)).toEqual(['knowledge', 'echo'])
    expect(toggleImpact('storage', on, false)).toEqual(['bots', 'flows', 'fairy', 'knowledge', 'echo'])
    expect(toggleImpact('bots', list, false)).toEqual(['echo'])
  })
})
