import { type ComputedRef, inject, type InjectionKey, type Ref } from 'vue'
import type { FlowGroupDoc, FlowIssue, Intercept, NodeTypeInfo, TraceStep } from '../../types'

/** `skipped`: the node is set to be skipped and the run passed through it. `paused`: a test run waits at its breakpoint. */
export type RunStatus = 'running' | 'ok' | 'error' | 'skipped' | 'paused'

/** A run shown on the canvas: each node's and edge's state, live while it runs. */
export interface FlowHighlight {
  nodes: Map<string, RunStatus>
  edges: Map<string, RunStatus>
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
  /** Nodes that never run because every trigger reaching them is skipped, with that trigger's name. */
  inheritedSkip: ComputedRef<Map<string, string>>
  /** Nodes that never run on some bot because an earlier trigger keeps the message, with why. */
  blocked: ComputedRef<Map<string, { reason: string; trigger: boolean }>>
  groups: Ref<FlowGroupDoc[]>
  /** Collapses or expands a group. */
  toggleGroup(groupId: string): void
  /** Nodes no test case reached, marked while the tests panel asks for it. */
  uncovered: Ref<Set<string>>
  /** The node's step in the run the logs show, for its inputs and outputs on hover. */
  stepOf(nodeId: string): TraceStep | undefined
  /** Nodes test runs pause before. */
  breakpoints: Ref<Set<string>>
  toggleBreakpoint(nodeId: string): void
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
  /** Skipped when the flow runs. */
  skip?: boolean
  /** Triggers: run order among the triggers one message starts on a bot. */
  priority?: number
  /** Triggers: what may no longer handle the same message once this one runs. */
  intercept?: Exclude<Intercept, 'none'>
  /** Set on the box that stands for a collapsed group. */
  groupId?: string
}
