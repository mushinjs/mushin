import { computed, type ComputedRef, inject, type InjectionKey, type MaybeRefOrGetter, provide, toValue } from 'vue'

/** Words the components show themselves. The host passes its own language through UiProvider. */
export interface UiText {
  on: string
  off: string
  enabled: string
  disabled: string
  clear: string
  close: string
  noOptions: string
  /** For a typed value that is not among the options; `{value}` is the text. */
  useValue: string
  add: string
  remove: string
  ok: string
  cancel: string
  loading: string
  previous: string
  next: string
  /** A page size choice; `{n}` is the number of rows. */
  perPage: string
  /** Opens an image at full size. */
  preview: string
}

export const defaultText: UiText = {
  on: 'On',
  off: 'Off',
  enabled: 'Enabled',
  disabled: 'Disabled',
  clear: 'Clear',
  close: 'Close',
  noOptions: 'No options',
  useValue: 'Use “{value}”',
  add: 'Add',
  remove: 'Remove',
  ok: 'OK',
  cancel: 'Cancel',
  loading: 'Loading',
  previous: 'Previous',
  next: 'Next',
  perPage: '{n} / page',
  preview: 'View full size',
}

const TEXT: InjectionKey<ComputedRef<UiText>> = Symbol('mushin-ui-text')

export function provideText(text: MaybeRefOrGetter<Partial<UiText> | undefined>) {
  provide(TEXT, computed(() => ({ ...defaultText, ...toValue(text) })))
}

export function useText(): ComputedRef<UiText> {
  return inject(TEXT, computed(() => defaultText))
}

/** Control heights, matching the dashboard's previous Naive UI sizes. */
export type Size = 'tiny' | 'small' | 'medium' | 'large'

/** Status colours shared by buttons, tags and alerts. */
export type Tone = 'default' | 'primary' | 'info' | 'success' | 'warning' | 'error'
