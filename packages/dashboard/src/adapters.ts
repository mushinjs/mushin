import type { AdapterType } from './types'

/** The connection mode a config uses: its `mode` field, else the schema default; undefined for adapters with one mode. */
export function adapterMode(adapter: AdapterType | undefined, config: Record<string, any>): string | undefined {
  return config.mode ?? adapter?.configSchema.properties?.mode?.default
}

/** Fields the form leaves out for this mode, from the adapter's `hiddenFields`. */
export function hiddenFields(adapter: AdapterType | undefined, config: Record<string, any>) {
  const map = adapter?.hiddenFields ?? {}
  const mode = adapterMode(adapter, config)
  return [...(map['*'] ?? []), ...(mode !== undefined ? map[mode] ?? [] : [])]
}

/** Modes where the platform reaches Mushin, so the form shows the address to give it. */
const INBOUND_MODES = new Set(['reverse', 'http', 'webhook'])

export const isInbound = (mode: string | undefined) => mode !== undefined && INBOUND_MODES.has(mode)

/** The i18n key of an adapter's setup guide for a mode, e.g. `bots.guide.qq.webhook`. */
export const guideKey = (adapterId: string, mode: string | undefined) => `bots.guide.${adapterId}.${mode ?? 'default'}`
