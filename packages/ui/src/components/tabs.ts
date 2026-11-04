import type { InjectionKey } from 'vue'

export interface PaneInfo {
  name: string
  tab: () => string | undefined
  icon: () => string | undefined
  disabled: () => boolean
}

export const TABS: InjectionKey<{ register: (pane: PaneInfo) => () => void }> = Symbol('mushin-tabs')
