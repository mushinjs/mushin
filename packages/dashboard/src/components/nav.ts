/** A page in the sidebar; its key is the route it opens. */
export interface NavItem {
  key: string
  label: string
  /** An icon class, such as `i-lucide-bot`. */
  icon: string
}

/** A group of pages under a title; the first group has none. */
export interface NavGroup {
  key: string
  label?: string
  items: NavItem[]
}
