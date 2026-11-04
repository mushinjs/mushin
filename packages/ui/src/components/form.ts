import type { ComputedRef, InjectionKey } from 'vue'
import type { Size } from '../config'

export interface FormContext {
  labelPlacement: ComputedRef<'top' | 'left'>
  labelWidth: ComputedRef<number | string | undefined>
  size: ComputedRef<Size>
}

export const FORM: InjectionKey<FormContext> = Symbol('mushin-form')
