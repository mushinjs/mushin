/**
 * Checks of a node's settings as they are typed, before saving: required settings, JSON that
 * parses, references to nodes that exist and run earlier, and, for nodes that call a platform API
 * (a field with `x-apis`), the API's params. Saving is still allowed; the server checks again.
 */
import { portsOf, refsIn, SCOPES, splitName, sysPorts } from '../../../flow'
import type { JsonSchema, NodeTypeInfo } from '../../../types'

export interface CheckNode {
  id: string
  typeId: string
  config: Record<string, any>
  inputs?: Record<string, string>
}

export type CheckCode =
  | 'required' | 'notNumber' | 'json' | 'jsonObject'
  | 'refNoNode' | 'refNoOutput' | 'refNotBefore' | 'refSelf'
  | 'apiUnknown' | 'apiParamMissing' | 'apiParamType' | 'apiParamUnknown'
  | 'apiParamSingle' | 'apiParamRange' | 'apiParamOption' | 'apiRefType' | 'apiRefMaybe'

export interface NodeCheck {
  severity: 'error' | 'warning'
  /** The setting it is about, or `in:<port>` for an input. */
  field?: string
  code: CheckCode
  params: Record<string, string>
}

/** One API param as the platform plugin lists it; see the OneBot adapter's `apis.ts`. */
export interface ApiParam {
  name: string
  type: ApiParamType
  required?: boolean
  title: Record<string, string> | string
  default?: string | number | boolean
  options?: string[]
  min?: number
  max?: number
}

/** One API as the platform plugin lists it under `x-apis`. */
export interface ApiInfo {
  action: string
  title: Record<string, string> | string
  source?: string
  note?: Record<string, string> | string
  params: ApiParam[]
}

/** Same as the server: `int` is a whole number (ids, counts, seconds). */
export type ApiParamType = 'int' | 'boolean' | 'string' | 'message' | 'array' | 'object'

/** Params that hold one value, a literal or a reference: whole numbers, yes/no, and ones with options. */
export const singleValued = (param: Pick<ApiParam, 'type' | 'options'>) => param.type === 'int' || param.type === 'boolean' || !!param.options

const typeOfValue = (value: unknown) => (Array.isArray(value) ? 'list' : value === null ? 'any' : typeof value === 'object' ? 'object' : typeof value === 'string' ? 'text' : typeof value)

/**
 * How well a reference's value suits a param: `bad` when its type cannot work (yes/no into a
 * number), `maybe` when only its value can tell (text into a number), else `ok`. `sample` is its
 * latest value, when known, and settles `maybe` either way.
 */
export function paramFit(param: Pick<ApiParam, 'type' | 'options'>, refType: string | undefined, sample?: unknown): 'ok' | 'maybe' | 'bad' {
  const known = sample !== undefined && sample !== null
  const text = typeof sample === 'string' ? sample.trim() : typeof sample === 'number' || typeof sample === 'boolean' ? String(sample) : undefined
  const settle = (fits: (value: string) => boolean): 'ok' | 'maybe' | 'bad' => (known ? (text !== undefined && fits(text) ? 'ok' : 'bad') : 'maybe')
  const structured = refType === 'message' || refType === 'list' || refType === 'object'
  if (param.options) return structured ? 'bad' : settle((value) => param.options!.includes(value))
  switch (param.type) {
    case 'int':
      if (refType === 'boolean' || structured) return 'bad'
      return refType === 'number' && !known ? 'ok' : settle((value) => /^-?\d+$/.test(value))
    case 'boolean':
      if (refType === 'boolean') return 'ok'
      return structured ? 'bad' : settle((value) => value === 'true' || value === 'false')
    case 'array':
      return refType === 'list' || refType === 'any' || refType === 'message' ? 'ok' : refType === 'boolean' || refType === 'number' ? 'bad' : 'maybe'
    case 'object':
      return refType === 'object' || refType === 'any' ? 'ok' : refType === 'boolean' || refType === 'number' || refType === 'list' ? 'bad' : 'maybe'
    default:
      return 'ok'
  }
}

/** What is wrong with a param's value as written, references aside; see the server's `checkParams`. */
function literalProblem(param: ApiParam, value: string): { code: CheckCode; params?: Record<string, string> } | undefined {
  const text = value.trim()
  if (param.type === 'int') {
    if (!/^-?\d+$/.test(text)) return { code: 'apiParamType', params: { type: 'int' } }
    const number = Number(text)
    if ((param.min !== undefined && number < param.min) || (param.max !== undefined && number > param.max)) {
      return { code: 'apiParamRange', params: { min: param.min === undefined ? '-∞' : String(param.min), max: param.max === undefined ? '∞' : String(param.max) } }
    }
  }
  if (param.type === 'boolean' && text !== 'true' && text !== 'false') return { code: 'apiParamType', params: { type: 'boolean' } }
  if (param.type === 'array' || param.type === 'object') {
    const parsed = parseTemplateJson(text)
    if (parsed.error || (param.type === 'array' ? !Array.isArray(parsed.value) : !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value))) {
      return { code: 'apiParamType', params: { type: param.type } }
    }
  }
  if (param.options && !param.options.includes(text)) return { code: 'apiParamOption', params: { options: param.options.join(', ') } }
}

/** Nodes that run before `id`: every node an edge path leads from. */
export function upstreamOf(id: string, edges: readonly { source: string; target: string }[]) {
  const before = new Set<string>()
  const queue = [id]
  while (queue.length) {
    const current = queue.shift()!
    for (const edge of edges) {
      if (edge.target !== current || before.has(edge.source)) continue
      before.add(edge.source)
      queue.push(edge.source)
    }
  }
  return before
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)

/**
 * References stand for values of any type; in JSON text they are replaced by a placeholder before
 * parsing. An invisible separator, which JSON leaves as it is and nobody types.
 */
const REF_MARK = '⁣ref'

/**
 * Parses JSON that may hold references, quoted (`"{{n1.id}}"`) or not (`{{n1.id}}`). Values that
 * were references come back as `REF_MARK` or as text containing `{{`.
 */
export function parseTemplateJson(text: string): { value?: unknown; error?: 'json' } {
  const filled = text.replace(/"(?:[^"\\]|\\.)*"|\{\{[^{}]*\}\}/g, (part) => (part.startsWith('"') ? part : JSON.stringify(REF_MARK)))
  try {
    return { value: JSON.parse(filled || 'null') }
  } catch {
    return { error: 'json' }
  }
}

/** Every string in a value, for references. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsOf)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsOf)
  return []
}

export interface CheckContext {
  nodes: Map<string, CheckNode>
  types: Map<string, NodeTypeInfo>
  /** Nodes that run before this one; see `upstreamOf`. */
  upstream: Set<string>
  /** The latest value a reference gave, if a run gave one. */
  sampleOf?(head: string, name: string): unknown
}

/** The type of what a reference reads: its output's declared type, or for a path into it, its latest value's. */
export function refTypeOf(head: string, name: string, context: Pick<CheckContext, 'nodes' | 'types' | 'sampleOf'>) {
  const { first, path } = splitName(name)
  if (!path.length && head === 'sys') return sysPorts.find((port) => port.name === first)?.type
  if (!path.length && !SCOPES.includes(head)) {
    const source = context.nodes.get(head)
    const info = source && context.types.get(source.typeId)
    const type = info && portsOf(info, source.config).outputs.find((port) => port.name === first)?.type
    if (type && type !== 'any') return type
  }
  const sample = context.sampleOf?.(head, name)
  return sample === undefined ? undefined : typeOfValue(sample)
}

function checkRefs(node: CheckNode, field: string, value: unknown, context: CheckContext, out: NodeCheck[]) {
  const seen = new Set<string>()
  for (const ref of stringsOf(value).flatMap(refsIn)) {
    const key = `${ref.head}.${ref.name}`
    if (seen.has(key)) continue
    seen.add(key)
    const { first } = splitName(ref.name)
    const params = { node: ref.head, output: first, ref: `${ref.head}.${ref.name}` }
    if (SCOPES.includes(ref.head)) continue
    if (ref.head === 'sys') {
      if (!sysPorts.some((port) => port.name === first)) out.push({ severity: 'error', field, code: 'refNoOutput', params })
      continue
    }
    if (ref.head === node.id) {
      out.push({ severity: 'error', field, code: 'refSelf', params })
      continue
    }
    const source = context.nodes.get(ref.head)
    if (!source) {
      out.push({ severity: 'error', field, code: 'refNoNode', params })
      continue
    }
    const info = context.types.get(source.typeId)
    if (info && !portsOf(info, source.config).outputs.some((port) => port.name === first)) {
      out.push({ severity: 'error', field, code: 'refNoOutput', params })
    } else if (!context.upstream.has(ref.head)) {
      out.push({ severity: 'warning', field, code: 'refNotBefore', params })
    }
  }
}

/** The params of an API call written as JSON, against the API's table. */
function checkApi(apis: ApiInfo[], actionField: string, paramsField: string | undefined, config: Record<string, any>, context: CheckContext, out: NodeCheck[]) {
  const action = config[actionField]
  if (typeof action !== 'string' || !action.trim() || refsIn(action).length) return
  const api = apis.find((item) => item.action === action.trim())
  if (!api) {
    out.push({ severity: 'warning', field: actionField, code: 'apiUnknown', params: { api: action.trim() } })
    return
  }
  if (!paramsField) return
  const values = readParams(String(config[paramsField] ?? '{}'))
  if (!values) return
  for (const param of api.params) {
    const field = `${paramsField}.${param.name}`
    const add = (severity: NodeCheck['severity'], code: CheckCode, extra: Record<string, string> = {}) => out.push({ severity, field, code, params: { api: api.action, param: param.name, ...extra } })
    const value = values[param.name] ?? ''
    if (!value.trim()) {
      if (param.required) add('error', 'apiParamMissing')
      continue
    }
    const refs = refsIn(value)
    if (!refs.length) {
      const problem = literalProblem(param, value)
      if (problem) add('error', problem.code, problem.params)
      continue
    }
    if (!singleValued(param)) continue
    // One value only: a lone reference, not two, and not a reference with text around it.
    if (refs.length > 1 || value.replace(/\{\{[^{}]*\}\}/g, '').trim()) {
      add('error', 'apiParamSingle', { type: param.options ? 'options' : param.type })
      continue
    }
    const [ref] = refs
    const refType = refTypeOf(ref.head, ref.name, context)
    const sample = context.sampleOf?.(ref.head, ref.name)
    if (paramFit(param, refType, sample) !== 'bad') continue
    const extra = { type: param.options ? 'options' : param.type, node: ref.head, output: ref.name, refType: refType ?? 'any', value: JSON.stringify(sample) ?? '' }
    // A type that cannot work is an error; a latest value that does not fit may change in the next run.
    if (sample === undefined || refType === 'boolean' || refType === 'message' || refType === 'list' || refType === 'object') add('error', 'apiRefType', extra)
    else add('warning', 'apiRefMaybe', extra)
  }
  for (const name of Object.keys(values)) {
    if (!api.params.some((param) => param.name === name)) out.push({ severity: 'warning', field: `${paramsField}.${name}`, code: 'apiParamUnknown', params: { api: api.action, param: name } })
  }
}

/** What is wrong with a node's settings and inputs right now. */
export function checkNode(node: CheckNode, info: NodeTypeInfo, context: CheckContext): NodeCheck[] {
  const out: NodeCheck[] = []
  const schema = info.configSchema
  const properties = Object.entries<JsonSchema>(schema?.properties ?? {})
  const required = new Set<string>(schema?.required ?? [])
  for (const [key, field] of properties) {
    const value = node.config?.[key]
    const hasRefs = typeof value === 'string' && refsIn(value).length > 0
    if (isEmpty(value) && (required.has(key) || (field.minLength ?? 0) > 0 || (field.minItems ?? 0) > 0)) {
      out.push({ severity: 'error', field: key, code: 'required', params: { field: key } })
      continue
    }
    if ((field.type === 'number' || field.type === 'integer') && !isEmpty(value) && typeof value !== 'number') {
      out.push({ severity: 'error', field: key, code: 'notNumber', params: { field: key } })
    }
    if (field['x-widget'] === 'json' && typeof value === 'string' && value.trim()) {
      const parsed = parseTemplateJson(value)
      if (parsed.error) out.push({ severity: 'error', field: key, code: 'json', params: { field: key } })
      else if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) out.push({ severity: 'error', field: key, code: 'jsonObject', params: { field: key } })
    }
    if (hasRefs || typeof value === 'object') checkRefs(node, key, value, context, out)
  }
  for (const [port, binding] of Object.entries(node.inputs ?? {})) checkRefs(node, `in:${port}`, binding, context, out)

  const apiField = properties.find(([, field]) => Array.isArray(field['x-apis']))
  if (apiField) {
    const paramsField = properties.find(([, field]) => field['x-widget'] === 'json')?.[0]
    if (!out.some((check) => check.field === paramsField && check.severity === 'error')) {
      checkApi(apiField[1]['x-apis'] as ApiInfo[], apiField[0], paramsField, node.config ?? {}, context, out)
    }
  }
  return out
}

// ---- API params as fields ----

/**
 * The params JSON as one text per param, for editing them as fields: text stays as written
 * (references in it too), a reference outside quotes becomes the reference, numbers and booleans
 * their text, objects and lists their JSON. Nothing when the text is not a JSON object.
 */
export function readParams(text: string): Record<string, string> | undefined {
  const refs: string[] = []
  const filled = (text.trim() || '{}').replace(/"(?:[^"\\]|\\.)*"|\{\{[^{}]*\}\}/g, (part) => {
    if (part.startsWith('"')) return part
    refs.push(part)
    return JSON.stringify(`${REF_MARK}${refs.length - 1}`)
  })
  let value: unknown
  try {
    value = JSON.parse(filled)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const restore = (part: string) => part.replace(new RegExp(`"?${REF_MARK}(\\d+)"?`, 'g'), (_, index: string) => refs[Number(index)])
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    typeof item === 'string' ? restore(item) : item !== null && typeof item === 'object' ? restore(JSON.stringify(item)) : String(item),
  ]))
}

const LONE_REF = /^\s*\{\{[^{}]*\}\}\s*$/

/**
 * Params written back as JSON, in the table's order with any others after. Empty ones are left
 * out. Numbers and booleans are written bare; references and text are quoted (the API node
 * escapes and converts them as it runs); lists and objects are written as their JSON.
 */
export function writeParams(values: Record<string, string>, api?: ApiInfo) {
  const order = [...(api?.params.map((param) => param.name) ?? []), ...Object.keys(values)]
  const parts: string[] = []
  for (const name of new Set(order)) {
    const text = values[name]
    if (text === undefined || text === '') continue
    const type = api?.params.find((param) => param.name === name)?.type
    let written = JSON.stringify(text)
    if (type === 'int' && /^-?\d+$/.test(text.trim()) && Number.isSafeInteger(Number(text.trim()))) written = text.trim()
    else if (type === 'boolean' && (text === 'true' || text === 'false')) written = text
    else if ((type === 'array' || type === 'object') && (LONE_REF.test(text) || !parseTemplateJson(text).error)) written = text.trim()
    parts.push(`${JSON.stringify(name)}: ${written}`)
  }
  return `{${parts.join(', ')}}`
}
