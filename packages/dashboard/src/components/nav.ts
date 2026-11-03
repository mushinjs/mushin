import type { Component } from 'vue'

/** A page in the sidebar; its key is the route it opens. */
export interface NavItem {
  key: string
  label: string
  icon: Component
}

/** A group of pages under a title; the first group has none. */
export interface NavGroup {
  key: string
  label?: string
  items: NavItem[]
}
