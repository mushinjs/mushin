import type { Component, InjectionKey } from 'vue'

/**
 * What a form's surroundings can change in SchemaField: the flow editor edits text settings with
 * its reference editor and shows its checks under each setting.
 */
export interface SchemaFieldHooks {
  /** Edits text settings; takes `modelValue`, `multiline`, `mono`, `placeholder` and `status`. */
  textEditor?: Component
  /** A problem with a setting, shown under it. */
  problemOf?(name: string): { message: string; severity: 'error' | 'warning' } | undefined
}

export const schemaFieldHooks: InjectionKey<SchemaFieldHooks> = Symbol('schema-field-hooks')
