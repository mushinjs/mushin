import { type ComputedRef, inject, type InjectionKey, type Ref } from 'vue'
import type { FlowIssue, NodeTypeInfo } from '../../types'

export interface FlowHighlight {
  nodes: Map<string, 'ok' | 'error'>
  edges: Set<string>
}

/** Shared by the editor and its node cards. */
export interface FlowEditorContext {
  types: Ref<Map<string, NodeTypeInfo>>
  issuesByNode: ComputedRef<Map<string, FlowIssue[]>>
  highlight: Ref<FlowHighlight>
  /** Position of each node on the canvas, shown as its number. */
  order: ComputedRef<Map<string, number>>
  /** The node a single-step run is executing right now. */
  executing: Ref<string | undefined>
  /** Runs the flow with the test message up to this node. */
  execute(nodeId: string): void
  /** A node's label, or its type's title. */
  nodeName(nodeId: string): string
}

export const flowEditorKey: InjectionKey<FlowEditorContext> = Symbol('flow-editor')

export function useFlowEditor() {
  const context = inject(flowEditorKey)
  if (!context) throw new Error('flow node rendered outside the flow editor')
  return context
}

/** Data carried by every node on the canvas. */
export interface CanvasNodeData {
  typeId: string
  label?: string
  config: Record<string, any>
  /** Input name → a reference such as `{{n1.text}}`, or text containing references. */
  inputs?: Record<string, string>
}
