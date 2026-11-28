import { describe, expect, it } from 'vitest'
import type { MarketEntry } from '@mushinjs/core'
import { changesInPlace, planInstall } from '../src/market'

const entries: MarketEntry[] = [
  { name: 'mushin-plugin-weather', kind: 'app', version: '2.0.0', versions: [{ version: '2.0.0', mushin: '>=0.5.0' }, { version: '1.4.0', mushin: '>=0.3.0' }], requires: { plugins: { '@mushinjs/plugin-bots': '*', 'mushin-plugin-geo': '^1' } } },
  { name: 'mushin-plugin-geo', kind: 'app', version: '1.1.0', curated: true },
  { name: 'mushin-plugin-future', kind: 'app', version: '1.0.0', requires: { mushin: '>=9.0.0' } },
  { name: 'mushin-plugin-lonely', kind: 'app', version: '1.0.0', requires: { plugins: { 'not-in-market': '*' } } },
  { name: '@mushinjs/plugin-demo', kind: 'app', version: '0.4.0', official: true },
]

const installed = new Set(['@mushinjs/plugin-bots'])
const options = { installed: (name: string) => installed.has(name), mushinVersion: '0.4.0' }

describe('planInstall', () => {
  it('installs the newest version that runs here, with the plugins it needs', () => {
    expect(planInstall(entries, 'mushin-plugin-weather', options)).toEqual(['mushin-plugin-weather@1.4.0', 'mushin-plugin-geo@1.1.0'])
    expect(planInstall(entries, 'mushin-plugin-weather', { ...options, version: '2.0.0' })[0]).toBe('mushin-plugin-weather@2.0.0')
  })

  it('says why it cannot', () => {
    expect(() => planInstall(entries, 'nothing', options)).toThrow('not in the plugin market')
    expect(() => planInstall(entries, 'mushin-plugin-future', options)).toThrow('needs >=9.0.0')
    expect(() => planInstall(entries, 'mushin-plugin-lonely', options)).toThrow('needs not-in-market, which is not in the plugin market')
  })

  it('keeps to picked and official plugins when the setting says so', () => {
    expect(() => planInstall(entries, 'mushin-plugin-weather', { ...options, curatedOnly: true })).toThrow('Only picked plugins')
    expect(planInstall(entries, 'mushin-plugin-geo', { ...options, curatedOnly: true })).toEqual(['mushin-plugin-geo@1.1.0'])
    expect(planInstall(entries, '@mushinjs/plugin-demo', { ...options, curatedOnly: true })).toEqual(['@mushinjs/plugin-demo@0.4.0'])
  })
})

describe('changesInPlace', () => {
  it('installs in place only when nothing loaded changes', () => {
    expect(changesInPlace({ added: ['a', 'b'], changed: [], removed: [] } as any, () => false)).toBe(true)
    expect(changesInPlace({ added: ['a'], changed: ['cordis'], removed: [] } as any, () => true)).toBe(false)
    expect(changesInPlace({ added: [], changed: [], removed: ['old-plugin'] } as any, (name) => name === 'old-plugin')).toBe(true)
    expect(changesInPlace({ added: [], changed: [], removed: ['zod'] } as any, (name) => name === 'old-plugin')).toBe(false)
    expect(changesInPlace(undefined, () => true)).toBe(false)
  })
})
