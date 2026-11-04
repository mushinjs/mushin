import type { ComputedRef, InjectionKey } from 'vue'
import type { Size } from '../config'

export const RADIO_GROUP: InjectionKey<{
  encode: (value: string | number | boolean | null | undefined) => string | number | undefined
  size: ComputedRef<Size>
}> = Symbol('mushin-radio-group')
