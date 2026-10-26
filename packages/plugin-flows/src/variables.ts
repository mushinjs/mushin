import type { Context } from '@mushin/core'
import type {} from '@mushin/plugin-database'
import type { VariableScope } from './types'

declare module 'minato' {
  interface Tables {
    flows_var: FlowVariableRow
  }
}

/** One stored variable. `target` is the chat (`group:123`) or user id it belongs to; empty for flow scope. */
export interface FlowVariableRow {
  flow: string
  bot: string
  scope: Exclude<VariableScope, 'run'>
  target: string
  name: string
  /** Any JSON value; typed `any` so minato accepts a json column for it. */
  value: any
  updatedAt: number
}

type Slot = Omit<FlowVariableRow, 'name' | 'value' | 'updatedAt'>

/** Writes are batched this long after a change. */
const FLUSH_DELAY = 1000
/** Variables of test runs are never saved. */
const SCRATCH_BOT = 'test'

const slotKey = (slot: Slot) => `${slot.flow}|${slot.bot}|${slot.scope}|${slot.target}`

/**
 * Chat, user and flow variables. Reads come from memory, so nodes stay synchronous; with the
 * database plugin running, every variable is loaded at startup and changes are saved shortly after.
 */
export class VariableStore {
  private slots = new Map<string, { slot: Slot; values: Map<string, unknown> }>()
  /** `slotKey|name` of changes not saved yet. */
  private dirty = new Map<string, { slot: Slot; name: string }>()
  private database?: Context['database']
  private timer?: ReturnType<typeof setTimeout>
  private flushing = Promise.resolve()

  constructor(private onError: (error: unknown) => void) {}

  get(slot: Slot, name: string) {
    return this.slots.get(slotKey(slot))?.values.get(name)
  }

  set(slot: Slot, name: string, value: unknown) {
    const key = slotKey(slot)
    let entry = this.slots.get(key)
    if (!entry) this.slots.set(key, entry = { slot, values: new Map() })
    entry.values.set(name, value)
    if (slot.bot === SCRATCH_BOT) return
    this.dirty.set(`${key}|${name}`, { slot, name })
    this.schedule()
  }

  /** Forgets every variable of a flow, here and in the database. */
  async removeFlow(flow: string) {
    for (const [key, entry] of this.slots) if (entry.slot.flow === flow) this.slots.delete(key)
    for (const [key, item] of this.dirty) if (item.slot.flow === flow) this.dirty.delete(key)
    await this.database?.remove('flows_var', { flow })
  }

  /** Loads saved variables (keeping values set since startup) and saves from now on. Returns the detach function. */
  async attach(ctx: Context) {
    ctx.model.extend('flows_var', {
      flow: 'string',
      bot: 'string',
      scope: 'string',
      target: 'string',
      name: 'string',
      value: 'json',
      updatedAt: 'double',
    }, { primary: ['flow', 'bot', 'scope', 'target', 'name'] })
    const database = ctx.database
    for (const row of await database.get('flows_var', {})) {
      const key = slotKey(row)
      let entry = this.slots.get(key)
      if (!entry) this.slots.set(key, entry = { slot: { flow: row.flow, bot: row.bot, scope: row.scope, target: row.target }, values: new Map() })
      if (!entry.values.has(row.name)) entry.values.set(row.name, row.value ?? undefined)
    }
    this.database = database
    this.schedule()
    return async () => {
      await this.flush()
      if (this.database === database) this.database = undefined
    }
  }

  private schedule() {
    if (!this.database || this.timer || !this.dirty.size) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, FLUSH_DELAY)
  }

  /** Saves pending changes now. */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.flushing = this.flushing.then(async () => {
      const database = this.database
      if (!database || !this.dirty.size) return
      const items = [...this.dirty.values()]
      this.dirty.clear()
      const now = Date.now()
      const rows = items.map(({ slot, name }) => ({ ...slot, name, value: this.get(slot, name) ?? null, updatedAt: now }))
      try {
        await database.upsert('flows_var', rows)
      } catch (error) {
        for (const item of items) this.dirty.set(`${slotKey(item.slot)}|${item.name}`, item)
        this.onError(error)
      }
    })
    return this.flushing
  }
}
