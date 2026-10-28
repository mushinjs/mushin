import { type Context, field, MushinError, z } from '@mushin/core'
import type {} from '@mushin/plugin-database'
import { $ } from 'minato'
import { FlowError } from './engine'
import type { NodeContext, NodeType } from './types'

/** Column types a flow table can have. */
export const FIELD_TYPES = ['text', 'number', 'integer', 'boolean', 'json'] as const
export type FieldType = typeof FIELD_TYPES[number]

export interface FlowTableField {
  name: string
  type: FieldType
}

/** A table flows keep their own data in, stored as `flow_<name>`. */
export interface FlowTable {
  name: string
  fields: FlowTableField[]
  createdAt: number
}

interface TablesDocument {
  tables: FlowTable[]
}

const STORAGE_KEY = 'flows-tables'
export const TABLE_PREFIX = 'flow_'
/** Columns every flow table has besides its own fields. */
export const BUILTIN_COLUMNS = ['id', 'createdAt', 'updatedAt'] as const

/** Letters (any script), digits and underscores, not starting with a digit. */
const NAME = /^[\p{L}_][\p{L}\p{N}_]{0,39}$/u

export const TableName = z.string().trim().regex(NAME, 'Use letters, digits and underscores, up to 40, not starting with a digit')
export const TableField = z.object({ name: TableName, type: z.enum(FIELD_TYPES).default('text') })

const COLUMN_TYPES: Record<FieldType, string> = { text: 'string', number: 'double', integer: 'integer', boolean: 'boolean', json: 'json' }

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Tables flows declare for their own data, such as check-ins or points. The definitions live in
 * the flows storage, so they are known without a database; the tables themselves exist while the
 * database plugin runs.
 */
export class TableStore {
  private doc: TablesDocument = { tables: [] }
  private ctx?: Context

  constructor(private home: Context, private onChange: () => void) {}

  async load() {
    this.doc = { tables: [], ...(await this.home.storage.get<TablesDocument>(STORAGE_KEY)) }
  }

  /** Extends the database with every table; called while the database plugin runs. */
  attach(ctx: Context) {
    this.ctx = ctx
    for (const table of this.doc.tables) this.extend(table)
    this.onChange()
    return () => {
      if (this.ctx === ctx) this.ctx = undefined
      this.onChange()
    }
  }

  get available() {
    return !!this.ctx
  }

  private get database() {
    if (!this.ctx) throw new FlowError('The Database plugin is off; enable it on the plugins page to use database nodes')
    return this.ctx.database as any
  }

  private extend(table: FlowTable) {
    this.ctx?.model.extend(`${TABLE_PREFIX}${table.name}` as any, {
      id: 'unsigned',
      ...Object.fromEntries(table.fields.map((item) => [item.name, COLUMN_TYPES[item.type]])),
      createdAt: 'double',
      updatedAt: 'double',
    } as any, { autoInc: true })
  }

  list() {
    return this.doc.tables.map((table) => ({ ...table, fields: [...table.fields], model: `${TABLE_PREFIX}${table.name}` }))
  }

  get(name: string) {
    const table = this.doc.tables.find((item) => item.name === name)
    if (!table) throw new MushinError('not_found', `No flow table "${name}"; create it first (flows.tables.define)`)
    return table
  }

  /** Creates a table, or adds fields to one. Existing fields keep their type. */
  async define(name: string, fields: FlowTableField[]) {
    const parsed = TableName.parse(name)
    const names = new Set<string>()
    for (const item of fields) {
      if ((BUILTIN_COLUMNS as readonly string[]).includes(item.name)) throw new MushinError('invalid_input', `"${item.name}" is added to every table already`)
      if (names.has(item.name)) throw new MushinError('invalid_input', `The field "${item.name}" is listed twice`)
      names.add(item.name)
    }
    let table = this.doc.tables.find((item) => item.name === parsed)
    if (table) {
      for (const item of fields) {
        const old = table.fields.find((entry) => entry.name === item.name)
        if (old && old.type !== item.type) throw new MushinError('conflict', `The field "${item.name}" is ${old.type} already; a field's type cannot change`)
      }
      table = { ...table, fields: [...table.fields, ...fields.filter((item) => !table!.fields.some((entry) => entry.name === item.name))] }
      this.doc.tables = this.doc.tables.map((item) => (item.name === parsed ? table! : item))
    } else {
      table = { name: parsed, fields, createdAt: Date.now() }
      this.doc.tables = [...this.doc.tables, table]
    }
    await this.home.storage.set(STORAGE_KEY, this.doc)
    this.extend(table)
    this.onChange()
    return table
  }

  /** Deletes a table and its rows. */
  async drop(name: string) {
    this.get(name)
    if (this.ctx) await this.database.drop(`${TABLE_PREFIX}${name}`)
    this.doc.tables = this.doc.tables.filter((item) => item.name !== name)
    await this.home.storage.set(STORAGE_KEY, this.doc)
    this.onChange()
    return { dropped: name }
  }

  /** A value converted to a field's type; text in a number field that is not a number is an error. */
  coerce(table: FlowTable, fieldName: string, value: unknown) {
    const type = this.fieldType(table, fieldName)
    if (type === 'number' || type === 'integer') {
      if (value === '' || value === null || value === undefined) return 0
      const number = typeof value === 'number' ? value : Number(String(value).trim())
      if (!Number.isFinite(number)) throw new FlowError(`"${fieldName}" needs a number; got ${JSON.stringify(value)}`)
      return type === 'integer' ? Math.trunc(number) : number
    }
    if (type === 'boolean') return value === true || ['true', '1', 'yes', '是'].includes(String(value).trim().toLowerCase())
    if (type === 'json') {
      if (typeof value !== 'string') return value ?? null
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    }
    if (value === undefined || value === null) return ''
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }

  private fieldType(table: FlowTable, name: string): FieldType {
    if (name === 'id' || name === 'createdAt' || name === 'updatedAt') return 'number'
    const item = table.fields.find((entry) => entry.name === name)
    if (!item) throw new FlowError(`The table "${table.name}" has no field "${name}"`)
    return item.type
  }

  /** The minato query for a node's conditions. */
  where(table: FlowTable, conditions: Condition[]) {
    const query: Record<string, any> = {}
    for (const item of conditions) {
      if (!item.field) continue
      const type = this.fieldType(table, item.field)
      const value = item.op === 'contains' ? String(item.value ?? '') : this.coerce(table, item.field, item.value)
      const clause = item.op === 'contains'
        ? { $regex: new RegExp(escapeRegExp(value as string), 'i') }
        : { [`$${item.op}`]: value }
      if (item.op === 'contains' && type !== 'text') throw new FlowError(`"contains" only works on text fields; "${item.field}" is ${type}`)
      query[item.field] = { ...query[item.field], ...clause }
    }
    return query
  }

  async query(table: FlowTable, conditions: Condition[], options: { sort?: string; order?: 'asc' | 'desc'; limit?: number } = {}) {
    const sort = options.sort ? { [options.sort]: options.order ?? 'desc' } : undefined
    const rows = await this.database.get(`${TABLE_PREFIX}${table.name}`, this.where(table, conditions), {
      limit: options.limit,
      ...(sort ? { sort } : {}),
    })
    return rows as Record<string, unknown>[]
  }

  async count(table: FlowTable, conditions: Condition[]) {
    return Number(await this.database.eval(`${TABLE_PREFIX}${table.name}`, (row: any) => $.count(row.id), this.where(table, conditions)))
  }

  async insert(table: FlowTable, values: Record<string, unknown>) {
    const now = Date.now()
    const row = await this.database.create(`${TABLE_PREFIX}${table.name}`, { ...values, createdAt: now, updatedAt: now })
    return row as Record<string, unknown>
  }

  /** Sets fields, or adds to number fields, on every row that matches. Returns how many matched. */
  async update(table: FlowTable, conditions: Condition[], changes: Change[]) {
    const query = this.where(table, conditions)
    const matched = await this.count(table, conditions)
    if (!matched) return 0
    await this.database.set(`${TABLE_PREFIX}${table.name}`, query, (row: any) => ({
      ...Object.fromEntries(changes.map((item) => [item.field, item.op === 'add' ? $.add(row[item.field], item.value as number) : item.value])),
      updatedAt: Date.now(),
    }))
    return matched
  }

  async remove(table: FlowTable, conditions: Condition[]) {
    const matched = await this.count(table, conditions)
    if (matched) await this.database.remove(`${TABLE_PREFIX}${table.name}`, this.where(table, conditions))
    return matched
  }

  /** Row counts, for the table list. */
  async counts() {
    if (!this.ctx) return {}
    const entries = await Promise.all(this.doc.tables.map(async (table) => [table.name, await this.count(table, []).catch(() => 0)] as const))
    return Object.fromEntries(entries)
  }
}

export interface Condition {
  field: string
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains'
  value: unknown
}

export interface Change {
  field: string
  op: 'set' | 'add'
  value: unknown
}

// ---- nodes ----

const tableField = z.string().min(1).default('').meta(field('Table', 'A flow table; create tables on the Database page', {
  'zh-CN': { title: '数据表', description: '流程数据表；在“数据库”页新建' },
}, { choices: 'flows.tables.choices' }))

const columnField = (title: string, zh: string) => z.string().default('').meta(field(title, undefined, { 'zh-CN': { title: zh } }, { choices: 'flows.tables.fieldChoices' }))

const whereField = (required: boolean) => z.array(z.object({
  field: columnField('Field', '字段'),
  op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains']).default('eq').meta(field('Is', undefined, {
    'zh-CN': { title: '条件', options: { eq: '等于', ne: '不等于', gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于', contains: '包含' } },
  }, { options: { eq: 'equals', ne: 'is not', gt: 'greater than', gte: 'at least', lt: 'less than', lte: 'at most', contains: 'contains' } })),
  value: z.string().default('').meta(field('Value', 'Text, or a reference such as {{sys.userId}}', {
    'zh-CN': { title: '值', description: '文本，或引用，例如 {{sys.userId}}' },
  })),
})).min(required ? 1 : 0).default([]).meta(field(
  'Where',
  required ? 'Rows matching every condition; at least one, so a mistake cannot change the whole table' : 'Rows matching every condition; none means every row',
  { 'zh-CN': { title: '筛选条件', description: required ? '同时满足所有条件的行；至少一条，以免误改整张表' : '同时满足所有条件的行；不填表示所有行' } },
))

const valuesField = (withOp: boolean) => z.array(z.object({
  field: columnField('Field', '字段'),
  ...(withOp
    ? {
        op: z.enum(['set', 'add']).default('set').meta(field('How', undefined, {
          'zh-CN': { title: '方式', options: { set: '设为', add: '加上' } },
        }, { options: { set: 'set to', add: 'add' } })),
      }
    : {}),
  value: z.string().default('').meta(field('Value', 'Text, or a reference such as {{n1.score}}', {
    'zh-CN': { title: '值', description: '文本，或引用，例如 {{n1.score}}' },
  })),
})).min(1).default([]).meta(field('Values', undefined, { 'zh-CN': { title: '写入的值' } }))

const UNAVAILABLE = {
  en: 'Needs the Database plugin; enable it on the plugins page',
  'zh-CN': '需要数据库插件，请先在插件页启用',
}

/** The run's conditions, with references already filled in. */
const conditionsOf = (config: any): Condition[] => (config.where ?? []).filter((item: Condition) => item.field)

/** In test runs writes are listed with the platform calls instead of made. */
async function recordTest(context: NodeContext<any>, action: string, params: Record<string, unknown>) {
  await context.bot?.call(action, params)
}

/** Database nodes: query, count, insert, update and delete rows of flow tables. */
export function tableNodes(store: TableStore): NodeType[] {
  const unavailable = () => (store.available ? undefined : UNAVAILABLE)
  const tableOf = (config: any) => store.get(String(config.table ?? ''))
  const plain = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.getTime() : value]))

  const query: NodeType = {
    kind: 'action',
    type: 'data.dbQuery',
    category: 'data',
    title: { en: 'Find rows', 'zh-CN': '查询数据' },
    description: {
      en: 'Reads rows of a flow table. Continues on "found" or "none"; list fields under Outputs to read them from the first row, e.g. {{<this node>.points}}.',
      'zh-CN': '读取流程数据表中的行，有结果走 found，没有走 none。在“输出字段”里列出字段，即可读取第一行的值，例如 {{<本节点>.points}}。',
    },
    unavailable,
    config: z.object({
      table: tableField,
      where: whereField(false),
      sort: columnField('Sort by', '排序字段'),
      order: z.enum(['desc', 'asc']).default('desc').meta(field('Order', undefined, {
        'zh-CN': { title: '顺序', options: { desc: '从大到小', asc: '从小到大' } },
      }, { options: { desc: 'Descending', asc: 'Ascending' } })),
      limit: z.number().int().min(1).max(100).default(1).meta(field('At most', 'Rows to read', { 'zh-CN': { title: '最多', description: '读取的行数' } })),
      fields: z.array(z.string()).default([]).meta(field('Outputs', 'Fields of the first row to output', {
        'zh-CN': { title: '输出字段', description: '把第一行的这些字段作为输出' },
      })),
    }),
    outputs: [
      { name: 'id', type: 'number', title: { en: 'Id of the first row', 'zh-CN': '第一行的 id' } },
      { name: 'count', type: 'number', title: { en: 'Rows found', 'zh-CN': '找到的行数' } },
      { name: 'rows', type: 'any', title: { en: 'Rows', 'zh-CN': '所有行' } },
    ],
    outputsFrom: { key: 'fields', format: 'names' },
    execOut: ['found', 'none'],
    async run({ config }) {
      const table = tableOf(config)
      const rows = (await store.query(table, conditionsOf(config), { sort: config.sort || undefined, order: config.order, limit: config.limit })).map(plain)
      const first = rows[0] ?? {}
      return {
        exec: rows.length ? 'found' : 'none',
        outputs: {
          ...Object.fromEntries((config.fields as string[]).map((name) => [name, first[name] ?? ''])),
          id: first.id ?? 0,
          count: rows.length,
          rows,
        },
      }
    },
  }

  const count: NodeType = {
    kind: 'action',
    type: 'data.dbCount',
    category: 'data',
    title: { en: 'Count rows', 'zh-CN': '统计行数' },
    description: { en: 'Counts the rows of a flow table that match', 'zh-CN': '统计流程数据表中符合条件的行数' },
    unavailable,
    config: z.object({ table: tableField, where: whereField(false) }),
    outputs: [{ name: 'count', type: 'number', title: { en: 'Rows', 'zh-CN': '行数' } }],
    async run({ config }) {
      return { outputs: { count: await store.count(tableOf(config), conditionsOf(config)) } }
    },
  }

  const insert: NodeType = {
    kind: 'action',
    type: 'data.dbInsert',
    category: 'data',
    title: { en: 'Add row', 'zh-CN': '写入数据' },
    description: {
      en: 'Adds a row to a flow table. Fields not listed get an empty value. Test runs list the row instead of adding it.',
      'zh-CN': '向流程数据表添加一行，没填的字段为空值。测试运行只列出要写入的行，不真正写入。',
    },
    unavailable,
    config: z.object({ table: tableField, values: valuesField(false) }),
    outputs: [
      { name: 'id', type: 'number', title: { en: 'New row id', 'zh-CN': '新行的 id' } },
      { name: 'row', type: 'any', title: { en: 'New row', 'zh-CN': '新行' } },
    ],
    async run(context) {
      const { config } = context
      const table = tableOf(config)
      const values = Object.fromEntries((config.values as Change[]).filter((item) => item.field).map((item) => [item.field, store.coerce(table, item.field, item.value)]))
      if (context.test) {
        await recordTest(context, 'database.insert', { table: table.name, values })
        return { outputs: { id: 0, row: values } }
      }
      const row = plain(await store.insert(table, values))
      return { outputs: { id: row.id, row } }
    },
  }

  const update: NodeType = {
    kind: 'action',
    type: 'data.dbUpdate',
    category: 'data',
    title: { en: 'Update rows', 'zh-CN': '更新数据' },
    description: {
      en: 'Sets fields of the matching rows, or adds to number fields (such as points). Continues on "updated", or "none" when no row matches; with "Add when missing" a new row is made from the conditions and values instead. Test runs list the change instead of making it.',
      'zh-CN': '修改符合条件的行：把字段设为某值，或给数值字段加上某数（例如积分）。有行被修改走 updated，没有符合的行走 none；开启“没有时新增”则改为用条件和值新增一行。测试运行只列出要做的修改，不真正写入。',
    },
    unavailable,
    config: z.object({
      table: tableField,
      where: whereField(true),
      values: valuesField(true),
      upsert: z.boolean().default(false).meta(field('Add when missing', 'When no row matches, add one with the "equals" conditions and the values', {
        'zh-CN': { title: '没有时新增', description: '没有符合条件的行时，用“等于”条件和写入的值新增一行' },
      })),
    }),
    outputs: [
      { name: 'count', type: 'number', title: { en: 'Rows changed', 'zh-CN': '修改的行数' } },
      { name: 'id', type: 'number', title: { en: 'Id of the added row', 'zh-CN': '新增行的 id' } },
    ],
    execOut: ['updated', 'none'],
    async run(context) {
      const { config } = context
      const table = tableOf(config)
      const conditions = conditionsOf(config)
      if (!conditions.length) throw new FlowError('Add at least one condition, so the whole table is not changed by mistake')
      const changes: Change[] = (config.values as Change[]).filter((item) => item.field).map((item) => ({
        field: item.field,
        op: item.op ?? 'set',
        value: store.coerce(table, item.field, item.value),
      }))
      for (const item of changes) {
        if (item.op === 'add' && typeof item.value !== 'number') throw new FlowError(`"${item.field}" is not a number field, so nothing can be added to it`)
      }
      const matched = await store.count(table, conditions)
      if (!matched && config.upsert) {
        const values = {
          ...Object.fromEntries(conditions.filter((item) => item.op === 'eq').map((item) => [item.field, store.coerce(table, item.field, item.value)])),
          ...Object.fromEntries(changes.map((item) => [item.field, item.value])),
        }
        if (context.test) {
          await recordTest(context, 'database.insert', { table: table.name, values })
          return { exec: 'updated', outputs: { count: 1, id: 0 } }
        }
        const row = await store.insert(table, values)
        return { exec: 'updated', outputs: { count: 1, id: row.id } }
      }
      if (context.test) {
        if (matched) await recordTest(context, 'database.update', { table: table.name, where: conditions, changes })
        return { exec: matched ? 'updated' : 'none', outputs: { count: matched, id: 0 } }
      }
      const changed = await store.update(table, conditions, changes)
      return { exec: changed ? 'updated' : 'none', outputs: { count: changed, id: 0 } }
    },
  }

  const remove: NodeType = {
    kind: 'action',
    type: 'data.dbDelete',
    category: 'data',
    title: { en: 'Delete rows', 'zh-CN': '删除数据' },
    description: {
      en: 'Deletes the matching rows of a flow table. Test runs list what would be deleted instead.',
      'zh-CN': '删除流程数据表中符合条件的行。测试运行只列出要删除的内容，不真正删除。',
    },
    unavailable,
    config: z.object({ table: tableField, where: whereField(true) }),
    outputs: [{ name: 'count', type: 'number', title: { en: 'Rows deleted', 'zh-CN': '删除的行数' } }],
    async run(context) {
      const { config } = context
      const table = tableOf(config)
      const conditions = conditionsOf(config)
      if (!conditions.length) throw new FlowError('Add at least one condition, so the whole table is not deleted by mistake')
      if (context.test) {
        const matched = await store.count(table, conditions)
        if (matched) await recordTest(context, 'database.remove', { table: table.name, where: conditions })
        return { outputs: { count: matched } }
      }
      return { outputs: { count: await store.remove(table, conditions) } }
    },
  }

  return [query, count, insert, update, remove]
}
