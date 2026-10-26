import { describe, expect, it } from 'vitest'
import { type CatalogEntry, type DependencyGraph, dependencyReport, loadOrder, manifestProblems, planDisable, planEnable, satisfies, undeclaredServices, validRange } from '../src'

function pkg(name: string, manifest: Partial<CatalogEntry['manifest']> = {}, version = '1.0.0'): CatalogEntry {
  return { package: name, version, path: `/x/${name}`, local: false, manifest: { kind: 'app', ...manifest } }
}

describe('semver ranges', () => {
  it('handles the forms plugins use', () => {
    expect(satisfies('0.2.1', '>=0.2.0')).toBe(true)
    expect(satisfies('0.1.9', '>= 0.2.0')).toBe(false)
    expect(satisfies('1.4.0', '^1.2')).toBe(true)
    expect(satisfies('2.0.0', '^1.2')).toBe(false)
    expect(satisfies('0.2.5', '^0.2.1')).toBe(true)
    expect(satisfies('0.3.0', '^0.2.1')).toBe(false)
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true)
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false)
    expect(satisfies('3.1.0', '1.x || >=3')).toBe(true)
    expect(satisfies('2.1.0', '1.x || >=3')).toBe(false)
    expect(satisfies('0.1.0', '*')).toBe(true)
    expect(satisfies('1.0.0-rc.1', '>=1.0.0 <2')).toBe(true)
    expect(validRange('>=1 <2')).toBe(true)
    expect(validRange('latest-ish')).toBe(false)
  })

  it('reports malformed manifest fields', () => {
    expect(manifestProblems({ kind: 'app', requires: { plugins: { a: 'nope!' } } })).toHaveLength(1)
    expect(manifestProblems({ kind: 'app', provides: 'x' as any })).toHaveLength(1)
    expect(manifestProblems({ kind: 'app', requires: { mushin: '>=0.1.0', plugins: { a: '*' } } })).toEqual([])
  })
})

describe('dependency plans', () => {
  const graph: DependencyGraph = {
    catalog: [
      pkg('storage', { provides: ['storage'] }),
      pkg('bots', { provides: ['bots'], requires: { plugins: { storage: '*' } } }),
      pkg('flows', { provides: ['flows'], requires: { plugins: { storage: '*' } }, optional: { plugins: { bots: '*' } } }),
      pkg('perms', { requires: { plugins: { bots: '>=1.0.0' } }, optional: { plugins: { flows: '*', database: '*' } } }),
      pkg('runner', { kind: 'bot', requires: { plugins: { flows: '*' } } }),
      pkg('old', { requires: { plugins: { bots: '>=2' } } }),
      pkg('needsGhost', { requires: { plugins: { ghost: '*' } } }),
    ],
    entries: [
      { id: 'storage', package: 'storage' },
      { id: 'bots', package: 'bots', enabled: false },
      { id: 'flows', package: 'flows' },
    ],
  }

  it('describes a package', () => {
    const report = dependencyReport(graph, 'perms')
    expect(report.requires).toEqual([expect.objectContaining({ package: 'bots', problem: 'disabled', entry: 'bots' })])
    expect(report.optional.map((dep) => [dep.package, dep.problem])).toEqual([['flows', undefined], ['database', 'not-installed']])
    expect(dependencyReport(graph, 'flows').dependents.map((dep) => [dep.package, dep.optional])).toEqual([['perms', true], ['runner', false]])
  })

  it('plans enabling with the disabled plugins it needs', () => {
    expect(planEnable(graph, 'perms')).toEqual({ enable: ['bots'], blocked: [], mushin: [] })
    expect(planEnable(graph, 'old').blocked.map((dep) => dep.problem)).toEqual(['version'])
    expect(planEnable(graph, 'needsGhost').blocked.map((dep) => dep.package)).toEqual(['ghost'])
  })

  it('plans disabling with the plugins that need it', () => {
    const withPerms = { ...graph, entries: [...graph.entries.map((entry) => ({ ...entry, enabled: true })), { id: 'perms', package: 'perms' }] }
    const plan = planDisable(withPerms, 'storage')
    expect(plan.disable.map((item) => item.id)).toEqual(['perms', 'bots', 'flows'])
    expect(plan.botPlugins).toEqual(['runner'])
    expect(planDisable(withPerms, 'flows')).toEqual({ disable: [], botPlugins: ['runner'], degraded: ['perms'] })
  })

  it('orders loading and finds cycles', () => {
    const cyclic: DependencyGraph = {
      catalog: [pkg('a', { requires: { plugins: { b: '*' } } }), pkg('b', { requires: { plugins: { a: '*' } } }), pkg('c'), pkg('d', { requires: { plugins: { c: '*' } } })],
      entries: [],
    }
    const entries = ['d', 'a', 'b', 'c'].map((name) => ({ id: name, package: name }))
    const { order, cycles } = loadOrder(cyclic, entries)
    expect(order.map((entry) => entry.id)).toEqual(['c', 'd'])
    expect(cycles.map((cycle) => cycle.chain)).toEqual([['a', 'b', 'a']])
  })

  it('finds injected services the manifest does not declare', () => {
    expect(undeclaredServices(graph, 'perms', { inject: ['bots', 'storage', 'flows'] })).toEqual([{ service: 'storage', provider: 'storage' }])
    expect(undeclaredServices(graph, 'perms', { inject: { required: ['bots'], optional: ['flows'] } })).toEqual([])
  })
})
