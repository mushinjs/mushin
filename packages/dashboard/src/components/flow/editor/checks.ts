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

export interface NodeCheck {
  severity: 'error' | 'warning'
  /** The setting it is about, or `in:<port>` for an input. */
  field?: string
  code: CheckCode
  params: Record<string, string>
}

/** One API as the platform plugin lists it under `x-apis`. */
export interface ApiInfo {
  action: string
  title: Record<string, string> | string
  params: { name: string; type: ApiParamType; required?: boolean; title: Record<string, string> | string }[]
}

export type ApiParamType = 'id' | 'number' | 'boolean' | 'string' | 'message' | 'array' | 'object'

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

/** References stand for values of any type; in JSON text they are replaced by a placeholder before parsing. */
const REF_MARK = '\u0000ref'

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

const isRefValue = (value: unknown) => value === REF_MARK || (typeof value === 'string' && value.includes('{{'))

/** Whether a written value suits an API param; references are only known at run time. */
function suits(type: ApiParamType, value: unknown) {
  switch (type) {
    case 'id':
    case 'number':
      return typeof value === 'number' || (typeof value === 'string' && !!value.trim() && Number.isFinite(Number(value)))
    case 'boolean':
      return typeof value === 'boolean' || value === 'true' || value === 'false'
    case 'string':
      return typeof value !== 'object' || value === null
    case 'message':
      return typeof value === 'string' || Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value)
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
function checkApi(apis: ApiInfo[], actionField: string, paramsField: string | undefined, config: Record<string, any>, out: NodeCheck[]) {
  const action = config[actionField]
  if (typeof action !== 'string' || !action.trim() || refsIn(action).length) return
  const api = apis.find((item) => item.action === action.trim())
  if (!api) {
    out.push({ severity: 'warning', field: actionField, code: 'apiUnknown', params: { api: action.trim() } })
    return
  }
  if (!paramsField) return
  const parsed = parseTemplateJson(String(config[paramsField] ?? '{}'))
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return
  const params = parsed.value as Record<string, unknown>
  for (const param of api.params) {
    const value = params[param.name]
    if (isRefValue(value)) continue
    if (isEmpty(value) || (typeof value === 'string' && !value.trim())) {
      if (param.required) out.push({ severity: 'error', field: paramsField, code: 'apiParamMissing', params: { api: api.action, param: param.name } })
    } else if (!suits(param.type, value)) {
      out.push({ severity: 'error', field: paramsField, code: 'apiParamType', params: { api: api.action, param: param.name, type: param.type } })
    }
  }
  for (const name of Object.keys(params)) {
    if (!api.params.some((param) => param.name === name)) out.push({ severity: 'warning', field: paramsField, code: 'apiParamUnknown', params: { api: api.action, param: name } })
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
      checkApi(apiField[1]['x-apis'] as ApiInfo[], apiField[0], paramsField, node.config ?? {}, out)
    }
  }
  return out
}
